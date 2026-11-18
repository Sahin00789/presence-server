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

export async function getMonthlyReportSummary(
  fastify: FastifyInstance,
  organizationId: string,
  month: number,
  year: number,
  premisesId?: string
) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const staff = await listOrganizationStaff(fastify, organizationId);

  const attendanceConditions = [
    eq(schema.employees.organizationId, organizationId),
    gte(schema.employeeAttendance.workDate, startDate),
    lte(schema.employeeAttendance.workDate, endDate),
  ];
  if (premisesId) {
    attendanceConditions.push(eq(schema.employees.premisesId, premisesId));
  }

  const attendanceEvents = await fastify.db
    .select({
      id: schema.employeeAttendance.id,
      employeeId: schema.employeeAttendance.employeeId,
      status: schema.employeeAttendance.status,
      workDate: schema.employeeAttendance.workDate,
      clockInAt: schema.employeeAttendance.clockInAt,
      clockOutAt: schema.employeeAttendance.clockOutAt,
      assignedStartTime: schema.employeeAttendance.assignedShiftStartTime,
    })
    .from(schema.employeeAttendance)
    .innerJoin(schema.employees, eq(schema.employees.id, schema.employeeAttendance.employeeId))
    .where(and(...attendanceConditions));

  let presentCount = 0;
  let absentCount = 0;
  let halfDayCount = 0;
  let leaveCount = 0;
  let lateCount = 0;
  let totalWorkedMinutes = 0;
  let totalLateMinutes = 0;

  for (const ev of attendanceEvents) {
    switch (ev.status) {
      case 'PRESENT':
        presentCount++;
        break;
      case 'ABSENT':
        absentCount++;
        break;
      case 'HALF_DAY':
        halfDayCount++;
        break;
      case 'LEAVE':
        leaveCount++;
        break;
    }

    if (ev.clockInAt && ev.clockOutAt) {
      const worked = Math.max(0, Math.floor((new Date(ev.clockOutAt).getTime() - new Date(ev.clockInAt).getTime()) / 60_000));
      totalWorkedMinutes += worked;
    }

    if (ev.clockInAt && ev.assignedStartTime) {
      try {
        const clockInDate = new Date(ev.clockInAt);
        const [sh, sm] = ev.assignedStartTime.split(':').map(Number);
        const shiftStartDate = new Date(clockInDate);
        shiftStartDate.setHours(sh, sm, 0, 0);
        const diffMs = clockInDate.getTime() - shiftStartDate.getTime();
        if (diffMs > 0) {
          const lateMins = Math.floor(diffMs / 60_000);
          if (lateMins > 0) {
            lateCount++;
            totalLateMinutes += lateMins;
          }
        }
      } catch (_e) {
        // ignore
      }
    }
  }

  const totalRecords = attendanceEvents.length;
  const attendanceRate = totalRecords > 0
    ? Math.round(((presentCount + leaveCount + halfDayCount) / totalRecords) * 100)
    : 100;

  const payrollSummaries = await listMonthlyPayrollSummaries(fastify, organizationId, month, year, premisesId);
  const totalEarnedInr = payrollSummaries.reduce((sum, p) => sum + Number(p.earnedAmount || 0), 0);
  const totalPaidInr = payrollSummaries.reduce((sum, p) => sum + Number(p.paidAmount || 0), 0);
  const totalDueInr = payrollSummaries.reduce((sum, p) => sum + Number(p.dueAmount || 0), 0);

  return {
    month,
    year,
    premisesId: premisesId ?? null,
    totalStaff: staff.length,
    totalRecords,
    presentCount,
    absentCount,
    halfDayCount,
    leaveCount,
    lateCount,
    totalWorkedMinutes,
    totalLateMinutes,
    attendanceRate,
    financials: {
      totalEarnedInr: Math.round(totalEarnedInr),
      totalPaidInr: Math.round(totalPaidInr),
      totalDueInr: Math.round(totalDueInr),
    },
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
    limit: 500,
    offset: 0,
  });

  return {
    title: 'Attendance Report',
    subtitle: `${query.from ?? 'beginning'} to ${query.to ?? 'today'}`,
    columns: [
      'Work Date',
      'Staff Code',
      'Staff Name',
      'Shift Window',
      'Clock In',
      'Clock Out',
      'Status',
      'Worked Minutes',
      'Late Minutes',
      'Face Verified',
      'Geofence Verified',
    ],
    rows: records.map((record) => [
      record.workDate ?? '',
      record.staffCode ?? '',
      record.staffName ?? '',
      `${record.assignedStartTime ?? '—'} - ${record.assignedEndTime ?? '—'}`,
      record.clockIn ? new Date(record.clockIn).toISOString() : '',
      record.clockOut ? new Date(record.clockOut).toISOString() : '',
      record.status,
      (record as any).workedMinutes ?? 0,
      record.lateMinutes ?? 0,
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
  let targetMonth: number | null = null;
  let targetYear: number | null = null;

  const yearMonthMatch = periodId.match(/^(\d{4})-(\d{1,2})$/) || periodId.match(/^(\d{1,2})-(\d{4})$/);
  if (yearMonthMatch) {
    if (yearMonthMatch[1].length === 4) {
      targetYear = Number(yearMonthMatch[1]);
      targetMonth = Number(yearMonthMatch[2]);
    } else {
      targetMonth = Number(yearMonthMatch[1]);
      targetYear = Number(yearMonthMatch[2]);
    }
  } else {
    const [period] = await fastify.db
      .select({ month: schema.monthlyPayrolls.month, year: schema.monthlyPayrolls.year })
      .from(schema.monthlyPayrolls)
      .where(
        and(
          eq(schema.monthlyPayrolls.id, periodId),
          eq(schema.monthlyPayrolls.organizationId, organizationId)
        )
      )
      .limit(1);

    if (period) {
      targetMonth = period.month;
      targetYear = period.year;
    }
  }

  const conditions = [eq(schema.monthlyPayrolls.organizationId, organizationId)];
  if (targetMonth !== null && targetYear !== null) {
    conditions.push(eq(schema.monthlyPayrolls.month, targetMonth));
    conditions.push(eq(schema.monthlyPayrolls.year, targetYear));
  } else {
    conditions.push(eq(schema.monthlyPayrolls.id, periodId));
  }

  const items = await fastify.db
    .select({
      id: schema.monthlyPayrolls.id,
      month: schema.monthlyPayrolls.month,
      year: schema.monthlyPayrolls.year,
      staffCode: schema.employees.employeeCode,
      employeeName: schema.employees.name,
      userFullName: schema.users.fullName,
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
    .leftJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .where(and(...conditions))
    .orderBy(schema.employees.employeeCode);

  if (items.length === 0) {
    throw new AppError('Payroll records not found for period', 404, 'PAYROLL_NOT_FOUND');
  }

  const monthLabel = targetMonth && targetYear ? `${String(targetMonth).padStart(2, '0')}/${targetYear}` : periodId;

  return {
    title: 'Payroll Report',
    subtitle: `Payroll period ${monthLabel}`,
    columns: [
      'Staff Code',
      'Staff Name',
      'Earned',
      'Paid',
      'Due',
      'Status',
    ],
    rows: items.map((item) => {
      const staffName = item.userFullName || item.employeeName || 'Employee';
      return [
        item.staffCode ?? '',
        staffName,
        formatMoney(item.earnedAmount),
        formatMoney(item.paidAmount),
        formatMoney(item.dueAmount),
        item.status,
      ];
    }),
  };
}
