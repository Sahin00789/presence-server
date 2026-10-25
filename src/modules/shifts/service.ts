import { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
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
import {
  CreateHolidayInput,
  CreateShiftAssignmentInput,
  CreateShiftTemplateInput,
  Holiday,
  ScheduleEntry,
  ShiftAssignment,
  ShiftTemplate,
  UpdateShiftTemplateInput,
} from './schemas.js';

export function validateHalfDayThreshold(startTime: string, endTime: string, thresholdTime: string) {
  const startMins = parseTimeToMinutes(startTime);
  const endMins = parseTimeToMinutes(endTime);
  const thresholdMins = parseTimeToMinutes(thresholdTime);

  const overnight = isOvernightShift(startTime, endTime);
  if (!overnight) {
    if (thresholdMins <= startMins || thresholdMins >= endMins) {
      throw new AppError(
        'Half-day threshold time must fall within the scheduled shift start and end times.',
        400,
        'INVALID_HALF_DAY_THRESHOLD'
      );
    }
  } else {
    const inWindow = thresholdMins >= startMins || thresholdMins < endMins;
    if (!inWindow) {
      throw new AppError(
        'Half-day threshold time must fall within the overnight shift start and end times.',
        400,
        'INVALID_HALF_DAY_THRESHOLD'
      );
    }
  }
}

function mapShift(row: typeof schema.shifts.$inferSelect) {
  return {
    id: row.id,
    organisationId: row.organisationId,
    organizationId: row.organisationId,
    premisesId: row.premisesId,
    shiftName: row.shiftName,
    name: row.shiftName,
    dayName: row.dayName,
    startTime: normalizeTime(row.startTime),
    endTime: normalizeTime(row.endTime),
    halfDayThreshold: normalizeTime(row.halfDayThreshold),
    breakMinutes: 0,
    lateGraceMinutes: 15,
    halfDayThresholdMinutes: 240,
    daysOfWeek: null,
    lateClockInAllowed: true,
    overnight: isOvernightShift(row.startTime, row.endTime),
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listShifts(
  fastify: FastifyInstance,
  organisationId: string,
  premisesId?: string
) {
  const conditions = [eq(schema.shifts.organisationId, organisationId)];
  if (premisesId) {
    conditions.push(eq(schema.shifts.premisesId, premisesId));
  }

  const rows = await fastify.db
    .select()
    .from(schema.shifts)
    .where(and(...conditions))
    .orderBy(asc(schema.shifts.startTime));

  return rows.map(mapShift);
}

export const listShiftTemplates = listShifts;

export async function createShift(
  fastify: FastifyInstance,
  organisationId: string,
  actorUserId: string,
  input: {
    premisesId: string;
    shiftName: string;
    dayName?: string;
    startTime: string;
    endTime: string;
    halfDayThreshold: string;
    isActive?: boolean;
  }
) {
  const startTimeStr = input.startTime.length === 5 ? `${input.startTime}:00` : input.startTime;
  const endTimeStr = input.endTime.length === 5 ? `${input.endTime}:00` : input.endTime;
  const thresholdStr =
    input.halfDayThreshold.length === 5 ? `${input.halfDayThreshold}:00` : input.halfDayThreshold;

  validateHalfDayThreshold(startTimeStr, endTimeStr, thresholdStr);

  const [premise] = await fastify.db
    .select()
    .from(schema.premises)
    .where(and(eq(schema.premises.id, input.premisesId), eq(schema.premises.organizationId, organisationId)))
    .limit(1);

  if (!premise) {
    throw new AppError('Premises not found in this organisation', 404, 'PREMISES_NOT_FOUND');
  }

  const [created] = await fastify.db
    .insert(schema.shifts)
    .values({
      organisationId,
      premisesId: input.premisesId,
      shiftName: input.shiftName,
      dayName: input.dayName ?? 'Everyday',
      startTime: startTimeStr,
      endTime: endTimeStr,
      halfDayThreshold: thresholdStr,
      isActive: input.isActive ?? true,
    })
    .returning();

  await writeAuditLog(fastify, {
    organizationId: organisationId,
    actorId: actorUserId,
    action: 'SHIFT_CREATED',
    resourceType: 'shift',
    resourceId: created.id,
    metadata: { shiftName: created.shiftName },
  });

  return mapShift(created);
}

export async function createShiftTemplate(
  fastify: FastifyInstance,
  organisationId: string,
  actorUserId: string,
  input: any
) {
  return createShift(fastify, organisationId, actorUserId, {
    premisesId: input.premisesId,
    shiftName: input.shiftName ?? input.name,
    dayName: input.dayName ?? 'Everyday',
    startTime: input.startTime,
    endTime: input.endTime,
    halfDayThreshold: input.halfDayThreshold ?? '11:00',
    isActive: input.isActive ?? true,
  });
}

export async function updateShift(
  fastify: FastifyInstance,
  organisationId: string,
  actorUserId: string,
  shiftId: string,
  input: {
    shiftName?: string;
    dayName?: string;
    startTime?: string;
    endTime?: string;
    halfDayThreshold?: string;
    isActive?: boolean;
  }
) {
  const [existing] = await fastify.db
    .select()
    .from(schema.shifts)
    .where(and(eq(schema.shifts.id, shiftId), eq(schema.shifts.organisationId, organisationId)))
    .limit(1);

  if (!existing) {
    throw new AppError('Shift not found', 404, 'SHIFT_NOT_FOUND');
  }

  const startTimeStr = input.startTime
    ? input.startTime.length === 5 ? `${input.startTime}:00` : input.startTime
    : existing.startTime;
  const endTimeStr = input.endTime
    ? input.endTime.length === 5 ? `${input.endTime}:00` : input.endTime
    : existing.endTime;
  const thresholdStr = input.halfDayThreshold
    ? input.halfDayThreshold.length === 5 ? `${input.halfDayThreshold}:00` : input.halfDayThreshold
    : existing.halfDayThreshold;

  validateHalfDayThreshold(startTimeStr, endTimeStr, thresholdStr);

  const [updated] = await fastify.db
    .update(schema.shifts)
    .set({
      ...(input.shiftName !== undefined ? { shiftName: input.shiftName } : {}),
      ...(input.dayName !== undefined ? { dayName: input.dayName } : {}),
      startTime: startTimeStr,
      endTime: endTimeStr,
      halfDayThreshold: thresholdStr,
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.shifts.id, shiftId))
    .returning();

  await writeAuditLog(fastify, {
    organizationId: organisationId,
    actorId: actorUserId,
    action: 'SHIFT_UPDATED',
    resourceType: 'shift',
    resourceId: shiftId,
  });

  return mapShift(updated);
}

export async function updateShiftTemplate(
  fastify: FastifyInstance,
  organisationId: string,
  actorUserId: string,
  templateId: string,
  input: any
) {
  return updateShift(fastify, organisationId, actorUserId, templateId, {
    shiftName: input.shiftName ?? input.name,
    dayName: input.dayName,
    startTime: input.startTime,
    endTime: input.endTime,
    halfDayThreshold: input.halfDayThreshold,
    isActive: input.isActive,
  });
}

export async function deleteShiftTemplate(
  fastify: FastifyInstance,
  organisationId: string,
  actorUserId: string,
  templateId: string
) {
  const [used] = await fastify.db
    .select({ id: schema.employeeShiftAssignments.id })
    .from(schema.employeeShiftAssignments)
    .where(eq(schema.employeeShiftAssignments.shiftId, templateId))
    .limit(1);

  if (used) {
    // Soft deactivate instead of hard delete if referenced
    await fastify.db.update(schema.shifts).set({ isActive: false, updatedAt: new Date() }).where(eq(schema.shifts.id, templateId));
    return { deleted: true };
  }

  await fastify.db.delete(schema.shifts).where(eq(schema.shifts.id, templateId));
  return { deleted: true };
}

export async function listEmployeeShiftAssignments(
  fastify: FastifyInstance,
  organisationId: string,
  staffId?: string,
  premisesId?: string
) {
  const conditions = [eq(schema.employeeShiftAssignments.organisationId, organisationId)];
  if (staffId) conditions.push(eq(schema.employeeShiftAssignments.staffId, staffId));
  if (premisesId) conditions.push(eq(schema.employeeShiftAssignments.premisesId, premisesId));

  const rows = await fastify.db
    .select({
      id: schema.employeeShiftAssignments.id,
      organisationId: schema.employeeShiftAssignments.organisationId,
      premisesId: schema.employeeShiftAssignments.premisesId,
      staffId: schema.employeeShiftAssignments.staffId,
      shiftId: schema.employeeShiftAssignments.shiftId,
      absentPay: schema.employeeShiftAssignments.absentPay,
      presentPay: schema.employeeShiftAssignments.presentPay,
      leavePay: schema.employeeShiftAssignments.leavePay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
      isActive: schema.employeeShiftAssignments.isActive,
      createdAt: schema.employeeShiftAssignments.createdAt,
      updatedAt: schema.employeeShiftAssignments.updatedAt,
      staffName: schema.users.fullName,
      shiftName: schema.shifts.shiftName,
    })
    .from(schema.employeeShiftAssignments)
    .innerJoin(schema.shifts, eq(schema.employeeShiftAssignments.shiftId, schema.shifts.id))
    .innerJoin(schema.staffProfiles, eq(schema.employeeShiftAssignments.staffId, schema.staffProfiles.id))
    .innerJoin(schema.users, eq(schema.staffProfiles.userId, schema.users.id))
    .where(and(...conditions))
    .orderBy(asc(schema.employeeShiftAssignments.createdAt));

  return rows.map((row) => ({
    id: row.id,
    organisationId: row.organisationId,
    premisesId: row.premisesId,
    staffId: row.staffId,
    staffProfileId: row.staffId,
    shiftId: row.shiftId,
    shiftTemplateId: row.shiftId,
    staffName: row.staffName,
    shiftName: row.shiftName,
    absentPay: Number(row.absentPay),
    presentPay: Number(row.presentPay),
    leavePay: Number(row.leavePay),
    halfDayPay: Number(row.halfDayPay),
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export const listShiftAssignments = listEmployeeShiftAssignments;

export async function createEmployeeShiftAssignment(
  fastify: FastifyInstance,
  organisationId: string,
  actorUserId: string,
  input: {
    premisesId: string;
    staffId: string;
    shiftId: string;
    absentPay: number;
    presentPay: number;
    leavePay: number;
    halfDayPay: number;
    isActive?: boolean;
  }
) {
  if (input.presentPay < 0 || input.absentPay < 0 || input.leavePay < 0 || input.halfDayPay < 0) {
    throw new AppError('Payment amounts must be non-negative', 400, 'INVALID_PAYMENT_AMOUNT');
  }

  const [shift] = await fastify.db
    .select()
    .from(schema.shifts)
    .where(and(eq(schema.shifts.id, input.shiftId), eq(schema.shifts.organisationId, organisationId)))
    .limit(1);

  if (!shift) {
    throw new AppError('Shift not found in this organisation', 404, 'SHIFT_NOT_FOUND');
  }

  if (shift.premisesId !== input.premisesId) {
    throw new AppError('Shift does not belong to the specified premises', 400, 'SHIFT_PREMISES_MISMATCH');
  }

  const [staff] = await fastify.db
    .select()
    .from(schema.staffProfiles)
    .where(and(eq(schema.staffProfiles.id, input.staffId), eq(schema.staffProfiles.organizationId, organisationId)))
    .limit(1);

  if (!staff) {
    throw new AppError('Staff profile not found in this organisation', 404, 'STAFF_NOT_FOUND');
  }

  const [duplicate] = await fastify.db
    .select({ id: schema.employeeShiftAssignments.id })
    .from(schema.employeeShiftAssignments)
    .where(
      and(
        eq(schema.employeeShiftAssignments.staffId, input.staffId),
        eq(schema.employeeShiftAssignments.premisesId, input.premisesId),
        eq(schema.employeeShiftAssignments.shiftId, input.shiftId),
        eq(schema.employeeShiftAssignments.isActive, true)
      )
    )
    .limit(1);

  if (duplicate) {
    throw new AppError(
      'An active shift assignment already exists for this employee, premises, and shift',
      409,
      'DUPLICATE_SHIFT_ASSIGNMENT'
    );
  }

  const [created] = await fastify.db
    .insert(schema.employeeShiftAssignments)
    .values({
      organisationId,
      premisesId: input.premisesId,
      staffId: input.staffId,
      shiftId: input.shiftId,
      absentPay: String(input.absentPay),
      presentPay: String(input.presentPay),
      leavePay: String(input.leavePay),
      halfDayPay: String(input.halfDayPay),
      isActive: input.isActive ?? true,
    })
    .returning();

  const [staffUser] = await fastify.db
    .select({ fullName: schema.users.fullName })
    .from(schema.staffProfiles)
    .innerJoin(schema.users, eq(schema.staffProfiles.userId, schema.users.id))
    .where(eq(schema.staffProfiles.id, input.staffId))
    .limit(1);

  return {
    id: created.id,
    organisationId: created.organisationId,
    premisesId: created.premisesId,
    staffId: created.staffId,
    staffProfileId: created.staffId,
    shiftId: created.shiftId,
    shiftTemplateId: created.shiftId,
    staffName: staffUser?.fullName ?? '',
    shiftName: shift.shiftName,
    absentPay: Number(created.absentPay),
    presentPay: Number(created.presentPay),
    leavePay: Number(created.leavePay),
    halfDayPay: Number(created.halfDayPay),
    isActive: created.isActive,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  };
}

export async function createShiftAssignment(
  fastify: FastifyInstance,
  organisationId: string,
  actorUserId: string,
  input: any
) {
  return createEmployeeShiftAssignment(fastify, organisationId, actorUserId, {
    premisesId: input.premisesId,
    staffId: input.staffId ?? input.staffProfileId,
    shiftId: input.shiftId ?? input.shiftTemplateId,
    absentPay: input.absentPay ?? 0,
    presentPay: input.presentPay ?? 0,
    leavePay: input.leavePay ?? 0,
    halfDayPay: input.halfDayPay ?? 0,
    isActive: input.isActive ?? true,
  });
}

export async function updateEmployeeShiftAssignment(
  fastify: FastifyInstance,
  organisationId: string,
  actorUserId: string,
  assignmentId: string,
  input: {
    presentPay?: number;
    absentPay?: number;
    leavePay?: number;
    halfDayPay?: number;
    isActive?: boolean;
  }
) {
  const [existing] = await fastify.db
    .select()
    .from(schema.employeeShiftAssignments)
    .where(
      and(
        eq(schema.employeeShiftAssignments.id, assignmentId),
        eq(schema.employeeShiftAssignments.organisationId, organisationId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new AppError('Shift assignment not found', 404, 'SHIFT_ASSIGNMENT_NOT_FOUND');
  }

  const [updated] = await fastify.db
    .update(schema.employeeShiftAssignments)
    .set({
      ...(input.presentPay !== undefined ? { presentPay: String(input.presentPay) } : {}),
      ...(input.absentPay !== undefined ? { absentPay: String(input.absentPay) } : {}),
      ...(input.leavePay !== undefined ? { leavePay: String(input.leavePay) } : {}),
      ...(input.halfDayPay !== undefined ? { halfDayPay: String(input.halfDayPay) } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.employeeShiftAssignments.id, assignmentId))
    .returning();

  return updated;
}

export const updateShiftAssignment = updateEmployeeShiftAssignment;

export async function deleteShiftAssignment(
  fastify: FastifyInstance,
  organisationId: string,
  actorUserId: string,
  assignmentId: string
) {
  await fastify.db
    .update(schema.employeeShiftAssignments)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(schema.employeeShiftAssignments.id, assignmentId),
        eq(schema.employeeShiftAssignments.organisationId, organisationId)
      )
    );

  return { deleted: true, isActive: false };
}

export async function getWeeklyOffs(fastify: FastifyInstance, staffProfileId: string): Promise<number[]> {
  const rows = await fastify.db
    .select({ dayOfWeek: schema.weeklyOffs.dayOfWeek })
    .from(schema.weeklyOffs)
    .where(eq(schema.weeklyOffs.staffProfileId, staffProfileId));

  return rows.map((row) => row.dayOfWeek).sort((a, b) => a - b);
}

export async function setWeeklyOffs(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  staffProfileId: string,
  daysOfWeek: number[]
) {
  return { staffProfileId, daysOfWeek };
}

export async function listHolidays(
  fastify: FastifyInstance,
  organizationId: string,
  from?: string,
  to?: string
): Promise<Holiday[]> {
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
    name: r.name,
    date: String(r.date),
    isPaid: r.isPaid,
  }));
}

export async function createHoliday(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  input: CreateHolidayInput
): Promise<Holiday> {
  const [created] = await fastify.db
    .insert(schema.holidayCalendars)
    .values({
      organizationId,
      name: input.name,
      date: input.date,
      isPaid: input.isPaid,
    })
    .returning();

  return {
    id: created.id,
    organizationId: created.organizationId,
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
  await fastify.db.delete(schema.holidayCalendars).where(eq(schema.holidayCalendars.id, holidayId));
  return { deleted: true };
}

export async function buildSchedule(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string,
  fromDate: string,
  toDate: string,
  timezone: string
): Promise<ScheduleEntry[]> {
  const holidays = await listHolidays(fastify, organizationId, fromDate, toDate);
  const holidayByDate = new Map(holidays.map((holiday) => [holiday.date, holiday]));

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
        eq(schema.employeeShiftAssignments.staffId, staffProfileId),
        eq(schema.employeeShiftAssignments.isActive, true)
      )
    );

  const dates = enumerateDates(fromDate, toDate);

  return dates.map((date) => {
    const dow = dayOfWeek(date);
    const holiday = holidayByDate.get(date);
    const assignment = assignments[0];

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
        halfDayThresholdMinutes: 240,
        scheduledMinutes: window.scheduledMinutes,
        overnight: window.overnight,
        startAt: window.startAt.toISOString(),
        endAt: window.endAt.toISOString(),
        holidayName: null,
        isPaidHoliday: null,
      };
    }

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
        eq(schema.employeeShiftAssignments.staffId, staffProfileId),
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

export function scheduledMinutesFor(startTime: string, endTime: string, breakMinutes: number): number {
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
