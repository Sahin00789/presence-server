import { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import {
  dayOfWeek,
  enumerateDates,
  isOvernightShift,
  normalizeTime,
  parseTimeToMinutes,
  resolveShiftWindow,
} from '../../shared/utils/datetime.js';

const DAY_NAME_TO_NUMBER: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function normalizeDayName(dayName?: string | null): string {
  if (!dayName) return '';
  return dayName.trim().toLowerCase().replace(/[^a-z]/g, '');
}

function getAssignedDayNumbers(dayName?: string | null): number[] {
  const normalized = normalizeDayName(dayName);
  if (!normalized) return [];
  if (normalized === 'everyday' || normalized === 'alldays' || normalized === 'daily') {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  if (normalized === 'weekdays') {
    return [1, 2, 3, 4, 5];
  }
  if (normalized === 'weekends') {
    return [0, 6];
  }
  if (DAY_NAME_TO_NUMBER[normalized] !== undefined) {
    return [DAY_NAME_TO_NUMBER[normalized]];
  }
  // try partial match
  for (const [key, value] of Object.entries(DAY_NAME_TO_NUMBER)) {
    if (normalized.startsWith(key)) {
      return [value];
    }
  }
  return [];
}

export async function getWeeklyOffs(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string
): Promise<number[]> {
  const [employee] = await fastify.db
    .select({ id: schema.employees.id })
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.id, staffProfileId),
        eq(schema.employees.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!employee) {
    throw new AppError(
      'Staff profile not found in this organisation',
      404,
      'STAFF_NOT_FOUND'
    );
  }

  const rows = await fastify.db
    .select({ dayOfWeek: schema.weeklyOffs.dayOfWeek })
    .from(schema.weeklyOffs)
    .where(eq(schema.weeklyOffs.employeeId, staffProfileId));

  return rows.map((row) => row.dayOfWeek).sort((a, b) => a - b);
}

export async function setWeeklyOffs(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  staffProfileId: string,
  daysOfWeek: number[]
) {
  const uniqueDays = Array.from(new Set(daysOfWeek)).sort((a, b) => a - b);
  if (uniqueDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new AppError(
      'Weekly off days must be between 0 (Sunday) and 6 (Saturday)',
      400,
      'INVALID_WEEKLY_OFF_DAY'
    );
  }

  const [employee] = await fastify.db
    .select({ id: schema.employees.id })
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.id, staffProfileId),
        eq(schema.employees.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!employee) {
    throw new AppError(
      'Staff profile not found in this organisation',
      404,
      'STAFF_NOT_FOUND'
    );
  }

  await fastify.db.transaction(async (tx) => {
    await tx
      .delete(schema.weeklyOffs)
      .where(eq(schema.weeklyOffs.employeeId, staffProfileId));

    if (uniqueDays.length > 0) {
      await tx.insert(schema.weeklyOffs).values(
        uniqueDays.map((dayOfWeek) => ({
          employeeId: staffProfileId,
          dayOfWeek,
        }))
      );
    }
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'WEEKLY_OFFS_UPDATED',
    resourceType: 'employee',
    resourceId: staffProfileId,
    metadata: { daysOfWeek: uniqueDays },
  });

  return { staffProfileId, daysOfWeek: uniqueDays };
}

export async function listHolidays(
  fastify: FastifyInstance,
  organizationId: string,
  from?: string,
  to?: string
): Promise<any[]> {
  const conditions = [eq(schema.holidayCalendars.organizationId, organizationId)];
  if (from) conditions.push(gte(schema.holidayCalendars.date, from));
  if (to) conditions.push(lte(schema.holidayCalendars.date, to));

  const rows = await fastify.db
    .select()
    .from(schema.holidayCalendars)
    .where(and(...conditions))
    .orderBy(asc(schema.holidayCalendars.date));

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    premisesId: (r as any).premisesId ?? null,
    name: r.name,
    date: String(r.date),
    isPaid: r.isPaid,
  }));
}

export async function createHoliday(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  input: any
): Promise<any> {
  const [created] = await fastify.db
    .insert(schema.holidayCalendars)
    .values({
      organizationId,
      name: input.name,
      date: input.date,
      isPaid: input.isPaid,
      ...(input.premisesId ? { premisesId: input.premisesId } : {}),
    } as any)
    .returning();

  return {
    id: created.id,
    organizationId: created.organizationId,
    premisesId: (created as any).premisesId ?? null,
    name: created.name,
    date: String(created.date),
    isPaid: created.isPaid,
  };
}

export async function deleteHoliday(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  holidayId: string
) {
  await fastify.db
    .delete(schema.holidayCalendars)
    .where(
      and(
        eq(schema.holidayCalendars.id, holidayId),
        eq(schema.holidayCalendars.organizationId, organizationId)
      )
    );
  return { deleted: true };
}

export async function buildSchedule(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string,
  fromDate: string,
  toDate: string,
  timezone: string
): Promise<any[]> {
  const holidays = await listHolidays(fastify, organizationId, fromDate, toDate);
  const holidayByDate = new Map(holidays.map((holiday) => [holiday.date, holiday]));

  const weeklyOffRows = await fastify.db
    .select({ dayOfWeek: schema.weeklyOffs.dayOfWeek })
    .from(schema.weeklyOffs)
    .where(eq(schema.weeklyOffs.employeeId, staffProfileId));
  const weeklyOffDays = new Set(weeklyOffRows.map((row) => row.dayOfWeek));

  const assignments = await fastify.db
    .select({
      id: schema.employeeShiftAssignments.id,
      shiftId: schema.employeeShiftAssignments.shiftId,
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      halfDayThreshold: schema.shifts.halfDayThreshold,
    })
    .from(schema.employeeShiftAssignments)
    .innerJoin(schema.shifts, eq(schema.employeeShiftAssignments.shiftId, schema.shifts.id))
    .where(
      and(
        eq(schema.employeeShiftAssignments.employeeId, staffProfileId),
        eq(schema.employeeShiftAssignments.isActive, true)
      )
    );

  const dates = enumerateDates(fromDate, toDate);

  return dates.map((date) => {
    const dow = dayOfWeek(date);
    const holiday = holidayByDate.get(date);
    const assignment = assignments[0];

    if (holiday) {
      return {
        date,
        dayOfWeek: dow,
        type: 'HOLIDAY' as const,
        shiftTemplateId: null,
        shiftName: null,
        startTime: null,
        endTime: null,
        breakMinutes: null,
        lateGraceMinutes: null,
        halfDayThresholdMinutes: null,
        scheduledMinutes: 0,
        overnight: false,
        startAt: null,
        endAt: null,
        holidayName: holiday.name,
        isPaidHoliday: holiday.isPaid,
      };
    }

    if (weeklyOffDays.has(dow)) {
      return {
        date,
        dayOfWeek: dow,
        type: 'WEEKLY_OFF' as const,
        shiftTemplateId: null,
        shiftName: null,
        startTime: null,
        endTime: null,
        breakMinutes: null,
        lateGraceMinutes: null,
        halfDayThresholdMinutes: null,
        scheduledMinutes: 0,
        overnight: false,
        startAt: null,
        endAt: null,
        holidayName: null,
        isPaidHoliday: null,
      };
    }

    if (assignment) {
      const window = resolveShiftWindow(date, assignment.startTime, assignment.endTime, 0, timezone);
      return {
        date,
        dayOfWeek: dow,
        type: 'SHIFT' as const,
        shiftTemplateId: assignment.shiftId,
        shiftName: assignment.shiftName,
        startTime: normalizeTime(assignment.startTime),
        endTime: normalizeTime(assignment.endTime),
        breakMinutes: 0,
        lateGraceMinutes: 15,
        halfDayThresholdMinutes: (() => {
          try {
            const startM = parseTimeToMinutes(assignment.startTime);
            const halfM = parseTimeToMinutes(assignment.halfDayThreshold);
            if (halfM >= startM) return halfM - startM;
            return (24 * 60 - startM) + halfM;
          } catch {
            return 240;
          }
        })(),
        scheduledMinutes: window.scheduledMinutes,
        overnight: window.overnight,
        startAt: window.startAt.toISOString(),
        endAt: window.endAt.toISOString(),
        holidayName: null,
        isPaidHoliday: null,
      };
    }

    return {
      date,
      dayOfWeek: dow,
      type: 'UNSCHEDULED' as const,
      shiftTemplateId: null,
      shiftName: null,
      startTime: null,
      endTime: null,
      breakMinutes: null,
      lateGraceMinutes: null,
      halfDayThresholdMinutes: null,
      scheduledMinutes: 0,
      overnight: false,
      startAt: null,
      endAt: null,
      holidayName: null,
      isPaidHoliday: null,
    };
  });
}

export async function resolveAssignmentForDate(
  fastify: FastifyInstance,
  staffProfileId: string,
  date: string
) {
  const rows = await fastify.db
    .select({
      assignmentId: schema.employeeShiftAssignments.id,
      templateId: schema.shifts.id,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      halfDayThreshold: schema.shifts.halfDayThreshold,
    })
    .from(schema.employeeShiftAssignments)
    .innerJoin(schema.shifts, eq(schema.employeeShiftAssignments.shiftId, schema.shifts.id))
    .where(
      and(
        eq(schema.employeeShiftAssignments.employeeId, staffProfileId),
        eq(schema.employeeShiftAssignments.isActive, true)
      )
    );

  if (rows[0]) {
    return {
      assignmentId: rows[0].assignmentId,
      templateId: rows[0].templateId,
      startTime: rows[0].startTime,
      endTime: rows[0].endTime,
      breakMinutes: 0,
      lateGraceMinutes: 15,
      halfDayThresholdMinutes: 240,
    };
  }

  return null;
}

export function scheduledMinutesFor(startTime: string, endTime: string, breakMinutes: number = 0): number {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  const gross = end <= start ? 24 * 60 - start + end : end - start;
  return Math.max(0, gross - breakMinutes);
}

export async function resolveTimezone(fastify: FastifyInstance, organizationId: string): Promise<string> {
  const [organization] = await fastify.db
    .select({ timezone: schema.organizations.timezone })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  return organization?.timezone ?? 'UTC';
}
