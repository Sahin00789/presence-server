import { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  findStaffProfile,
  listOrganizationStaff,
} from '../../shared/services/staff.service.js';
import { buildAttendanceSummary, listAttendanceRecords } from '../attendance/service.js';
import { buildSchedule, resolveTimezone } from '../shifts/service.js';
import { listMonthlyPayrollSummaries } from '../payroll/service.js';
import { toDateISOInTimeZone } from '../../shared/utils/datetime.js';
import { buildPdfReport } from '../../shared/utils/pdf.js';

export interface ReportTable {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}

export interface RenderedReport {
  contentType: string;
  filename: string;
  payload: string | Buffer;
}

/**
 * Serializes a report table into JSON, CSV or PDF.
 */
export function renderReport(
  table: ReportTable,
  format: 'json' | 'csv' | 'pdf',
  filenameBase: string
): RenderedReport {
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    const escape = (value: string | number) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [
      table.columns.map(escape).join(','),
      ...table.rows.map((row) => row.map(escape).join(',')),
    ].join('\n');

    return {
      contentType: 'text/csv; charset=utf-8',
      filename: `${filenameBase}-${stamp}.csv`,
      payload: `\uFEFF${csv}`,
    };
  }

  if (format === 'pdf') {
    return {
      contentType: 'application/pdf',
      filename: `${filenameBase}-${stamp}.pdf`,
      payload: buildPdfReport(table),
    };
  }

  return {
    contentType: 'application/json; charset=utf-8',
    filename: `${filenameBase}-${stamp}.json`,
    payload: JSON.stringify(table),
  };
}

function formatMoney(amountInr: number | string): string {
  const num = Number(amountInr) || 0;
  return `₹${num.toLocaleString('en-IN')}`;
}

export async function getDashboardSummary(
  fastify: FastifyInstance,
  user: { userId: string; role: 'OWNER' | 'EMPLOYEE' },
  organizationId: string
) {
  const timezone = await resolveTimezone(fastify, organizationId);
  const today = toDateISOInTimeZone(new Date(), timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const generatedAt = new Date().toISOString();

  if (user.role === 'EMPLOYEE') {
    const profile = await findStaffProfile(fastify, user.userId, organizationId);
    if (!profile) {
      throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
    }

    const [todayEvent] = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.employeeId, profile.id),
          eq(schema.employeeAttendance.workDate, today)
        )
      )
      .orderBy(desc(schema.employeeAttendance.createdAt))
      .limit(1);

    const [shift] = await buildSchedule(
      fastify,
      organizationId,
      profile.id,
      today,
      today,
      timezone
    );

    const monthSummary = await buildAttendanceSummary(
      fastify,
      organizationId,
      profile.id,
      monthStart,
      today
    );

    return {
      role: user.role,
      generatedAt,
      organization: {},
      me: {
        staffProfileId: profile.id,
        staffCode: profile.employeeCode,
        status: todayEvent?.status ?? null,
        clockIn: todayEvent?.clockInAt ?? null,
        clockOut: todayEvent?.clockOutAt ?? null,
        monthSummary: monthSummary as unknown as Record<string, number>,
        todayShift: shift
          ? {
              type: shift.type,
              startTime: shift.startTime,
              endTime: shift.endTime,
              startAt: shift.startAt,
              endAt: shift.endAt,
            }
          : null,
      },
    };
  }

  const staff = await listOrganizationStaff(fastify, organizationId);

  const attendanceCounts = await fastify.db
    .select({
      status: schema.employeeAttendance.status,
      count: sql<number>`COUNT(DISTINCT ${schema.employeeAttendance.employeeId})`,
    })
    .from(schema.employeeAttendance)
    .innerJoin(
      schema.employees,
      eq(schema.employees.id, schema.employeeAttendance.employeeId)
    )
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        eq(schema.employeeAttendance.workDate, today)
      )
    )
    .groupBy(schema.employeeAttendance.status);

  const countFor = (statuses: string[]) =>
    attendanceCounts
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + Number(row.count ?? 0), 0);

  const [openExceptions] = await fastify.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.employeeAttendance)
    .innerJoin(
      schema.employees,
      eq(schema.employees.id, schema.employeeAttendance.employeeId)
    )
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        sql`${schema.employeeAttendance.consecutivePingFailures} >= 3`,
        sql`${schema.employeeAttendance.correctedAt} IS NULL`
      )
    );

  const [pendingLeave] = await fastify.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.leaveRequests)
    .where(
      and(
        eq(schema.leaveRequests.organizationId, organizationId),
        eq(schema.leaveRequests.status, 'PENDING')
      )
    );

  const [currentYear, currentMonth] = today.split('-').map(Number);
  const summaries = await listMonthlyPayrollSummaries(
    fastify,
    organizationId,
    currentMonth,
    currentYear
  );
  const latest = summaries[0] ?? null;

  return {
    role: user.role,
    generatedAt,
    organization: {
      staffCount: staff.length,
      presentToday: countFor(['PRESENT', 'HALF_DAY']),
      absentToday: countFor(['ABSENT']),
      leaveToday: countFor(['LEAVE']),
      openExceptions: Number(openExceptions?.count ?? 0),
      pendingLeaveRequests: Number(pendingLeave?.count ?? 0),
      latestPayrollPeriod: latest
        ? {
            id: latest.id,
            status: latest.status,
            startDate: `${latest.year}-${String(latest.month).padStart(2, '0')}-01`,
            endDate: `${latest.year}-${String(latest.month).padStart(2, '0')}-${new Date(latest.year, latest.month, 0).getDate()}`,
            netSalaryPaise: Math.round(Number(latest.dueAmount) * 100),
          }
        : null,
    },
    me: undefined,
  };
}

export async function buildAttendanceReport(
  fastify: FastifyInstance,
  user: { userId: string; role: 'OWNER' | 'EMPLOYEE' },
  organizationId: string,
  query: { from?: string; to?: string; staffProfileId?: string }
): Promise<ReportTable> {
  const records = await listAttendanceRecords(fastify, user, organizationId, {
    ...query,
    limit: 200,
    offset: 0,
  });

  return {
    title: 'Attendance Report',
    subtitle: `${query.from ?? 'beginning'} to ${query.to ?? 'today'}`,
    columns: [
      'Work Date',
      'Staff Code',
      'Staff Name',
      'Clock In',
      'Clock Out',
      'Status',
      'Worked Minutes',
      'Overtime Minutes',
      'Face Verified',
      'Geofence Verified',
    ],
    rows: records.map((record) => [
      record.workDate ?? '',
      record.staffCode ?? '',
      record.staffName ?? '',
      record.clockIn ? new Date(record.clockIn).toISOString() : '',
      record.clockOut ? new Date(record.clockOut).toISOString() : '',
      record.status,
      0,
      0,
      record.faceVerified ? 'YES' : 'NO',
      record.geofenceVerified ? 'YES' : 'NO',
    ]),
  };
}

export async function buildPayrollReport(
  fastify: FastifyInstance,
  organizationId: string,
  periodId: string
): Promise<ReportTable> {
  const [item] = await fastify.db
    .select({
      staffCode: schema.employees.employeeCode,
      staffName: schema.users.fullName,
      earnedAmount: schema.monthlyPayrolls.earnedAmount,
      paidAmount: schema.monthlyPayrolls.paidAmount,
      dueAmount: schema.monthlyPayrolls.dueAmount,
      status: schema.monthlyPayrolls.status,
    })
    .from(schema.monthlyPayrolls)
    .innerJoin(
      schema.employees,
      eq(schema.employees.id, schema.monthlyPayrolls.employeeId)
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .where(
      and(
        eq(schema.monthlyPayrolls.id, periodId),
        eq(schema.monthlyPayrolls.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!item) {
    throw new AppError('Payroll period not found', 404, 'PAYROLL_NOT_FOUND');
  }

  return {
    title: 'Payroll Report',
    subtitle: `Payroll period ${periodId}`,
    columns: [
      'Staff Code',
      'Staff Name',
      'Earned',
      'Paid',
      'Due',
      'Due (INR)',
      'Status',
    ],
    rows: [[
      item.staffCode ?? '',
      item.staffName ?? '',
      item.earnedAmount,
      item.paidAmount,
      item.dueAmount,
      formatMoney(item.dueAmount),
      item.status,
    ]],
  };
}
