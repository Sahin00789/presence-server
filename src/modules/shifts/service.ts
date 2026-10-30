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

export function getAssignedDayNumbers(dayName?: string | null): number[] {
  if (!dayName) return [0, 1, 2, 3, 4, 5, 6];
  const normalized = dayName.trim().toLowerCase();
  if (!normalized || normalized === 'all' || normalized === 'everyday' || normalized === 'daily' || normalized === 'all days' || normalized === 'alldays') {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  if (normalized === 'weekdays') {
    return [1, 2, 3, 4, 5];
  }
  if (normalized === 'weekends') {
    return [0, 6];
  }

  const daysSet = new Set<number>();

  const rangeMatch = normalized.match(/([a-z]+)\s*-\s*([a-z]+)/);
  if (rangeMatch) {
    const startStr = rangeMatch[1];
    const endStr = rangeMatch[2];
    const startNum = DAY_NAME_TO_NUMBER[startStr] ?? DAY_NAME_TO_NUMBER[startStr.slice(0, 3)];
    const endNum = DAY_NAME_TO_NUMBER[endStr] ?? DAY_NAME_TO_NUMBER[endStr.slice(0, 3)];
    if (startNum !== undefined && endNum !== undefined) {
      if (startNum <= endNum) {
        for (let i = startNum; i <= endNum; i++) daysSet.add(i);
      } else {
        for (let i = startNum; i <= 6; i++) daysSet.add(i);
        for (let i = 0; i <= endNum; i++) daysSet.add(i);
      }
      return Array.from(daysSet).sort((a, b) => a - b);
    }
  }

  for (const [key, num] of Object.entries(DAY_NAME_TO_NUMBER)) {
    if (normalized.includes(key)) {
      daysSet.add(num);
    }
  }

  if (daysSet.size > 0) {
    return Array.from(daysSet).sort((a, b) => a - b);
  }

  return [0, 1, 2, 3, 4, 5, 6];
}

export async function listShifts(
  fastify: FastifyInstance,
  organizationId: string,
  premisesId?: string
) {
  const conditions = [eq(schema.shifts.organizationId, organizationId)];
  if (premisesId && premisesId.trim().length > 0) {
    conditions.push(eq(schema.shifts.premisesId, premisesId));
  }

  const rows = await fastify.db
    .select()
    .from(schema.shifts)
    .where(and(...conditions))
    .orderBy(asc(schema.shifts.shiftName));

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    organisationId: r.organizationId,
    premisesId: r.premisesId,
    shiftName: r.shiftName,
    dayName: r.dayName,
    startTime: String(r.startTime),
    endTime: String(r.endTime),
    halfDayThreshold: String(r.halfDayThreshold),
    isActive: r.isActive,
    createdAt: r.createdAt ? r.createdAt.toISOString() : undefined,
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : undefined,
  }));
}

export async function createShift(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  input: any
) {
  let targetPremisesId = input.premisesId?.trim();
  if (!targetPremisesId) {
    const [prem] = await fastify.db
      .select({ id: schema.premises.id })
      .from(schema.premises)
      .where(eq(schema.premises.organizationId, organizationId))
      .limit(1);
    if (!prem) {
      throw new AppError('No premises found for organization', 400, 'PREMISES_REQUIRED');
    }
    targetPremisesId = prem.id;
  }

  const [created] = await fastify.db
    .insert(schema.shifts)
    .values({
      organizationId,
      premisesId: targetPremisesId,
      shiftName: input.shiftName,
      dayName: input.dayName || 'Everyday',
      startTime: input.startTime,
      endTime: input.endTime,
      halfDayThreshold: input.halfDayThreshold || '11:00:00',
      isActive: input.isActive !== undefined ? input.isActive : true,
    })
    .returning();

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'SHIFT_CREATED',
    resourceType: 'shift',
    resourceId: created.id,
    metadata: { shiftName: created.shiftName },
  });

  if (fastify.cache) {
    fastify.cache.invalidateTag(`org:${organizationId}:shifts`);
  }

  return {
    id: created.id,
    organizationId: created.organizationId,
    organisationId: created.organizationId,
    premisesId: created.premisesId,
    shiftName: created.shiftName,
    dayName: created.dayName,
    startTime: String(created.startTime),
    endTime: String(created.endTime),
    halfDayThreshold: String(created.halfDayThreshold),
    isActive: created.isActive,
    createdAt: created.createdAt ? created.createdAt.toISOString() : undefined,
    updatedAt: created.updatedAt ? created.updatedAt.toISOString() : undefined,
  };
}

export async function updateShift(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  shiftId: string,
  input: any
) {
  const [existing] = await fastify.db
    .select()
    .from(schema.shifts)
    .where(
      and(
        eq(schema.shifts.id, shiftId),
        eq(schema.shifts.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new AppError('Shift not found', 404, 'SHIFT_NOT_FOUND');
  }

  const updateData: any = { updatedAt: new Date() };
  if (input.shiftName !== undefined) updateData.shiftName = input.shiftName;
  if (input.dayName !== undefined) updateData.dayName = input.dayName;
  if (input.startTime !== undefined) updateData.startTime = input.startTime;
  if (input.endTime !== undefined) updateData.endTime = input.endTime;
  if (input.halfDayThreshold !== undefined) updateData.halfDayThreshold = input.halfDayThreshold;
  if (input.isActive !== undefined) updateData.isActive = input.isActive;

  const [updated] = await fastify.db
    .update(schema.shifts)
    .set(updateData)
    .where(
      and(
        eq(schema.shifts.id, shiftId),
        eq(schema.shifts.organizationId, organizationId)
      )
    )
    .returning();

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'SHIFT_UPDATED',
    resourceType: 'shift',
    resourceId: updated.id,
    metadata: { shiftName: updated.shiftName },
  });

  if (fastify.cache) {
    fastify.cache.invalidateTag(`org:${organizationId}:shifts`);
  }

  return {
    id: updated.id,
    organizationId: updated.organizationId,
    organisationId: updated.organizationId,
    premisesId: updated.premisesId,
    shiftName: updated.shiftName,
    dayName: updated.dayName,
    startTime: String(updated.startTime),
    endTime: String(updated.endTime),
    halfDayThreshold: String(updated.halfDayThreshold),
    isActive: updated.isActive,
    createdAt: updated.createdAt ? updated.createdAt.toISOString() : undefined,
    updatedAt: updated.updatedAt ? updated.updatedAt.toISOString() : undefined,
  };
}

export async function deleteShift(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  shiftId: string
) {
  const [existing] = await fastify.db
    .select({ id: schema.shifts.id })
    .from(schema.shifts)
    .where(
      and(
        eq(schema.shifts.id, shiftId),
        eq(schema.shifts.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new AppError('Shift not found', 404, 'SHIFT_NOT_FOUND');
  }

  await fastify.db
    .delete(schema.shifts)
    .where(
      and(
        eq(schema.shifts.id, shiftId),
        eq(schema.shifts.organizationId, organizationId)
      )
    );

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'SHIFT_DELETED',
    resourceType: 'shift',
    resourceId: shiftId,
  });

  if (fastify.cache) {
    fastify.cache.invalidateTag(`org:${organizationId}:shifts`);
  }

  return { deleted: true };
}

export async function listShiftAssignments(
  fastify: FastifyInstance,
  organizationId: string,
  premisesId?: string,
  staffId?: string
) {
  const conditions = [eq(schema.employeeShiftAssignments.organizationId, organizationId)];

  if (premisesId && premisesId.trim().length > 0) {
    conditions.push(eq(schema.employeeShiftAssignments.premisesId, premisesId));
  }

  if (staffId && staffId.trim().length > 0) {
    conditions.push(eq(schema.employeeShiftAssignments.employeeId, staffId));
  }

  const rows = await fastify.db
    .select({
      assignment: schema.employeeShiftAssignments,
      employeeName: schema.employees.name,
      shiftName: schema.shifts.shiftName,
    })
    .from(schema.employeeShiftAssignments)
    .innerJoin(schema.shifts, eq(schema.employeeShiftAssignments.shiftId, schema.shifts.id))
    .innerJoin(schema.employees, eq(schema.employeeShiftAssignments.employeeId, schema.employees.id))
    .where(and(...conditions));

  return rows.map((r) => ({
    id: r.assignment.id,
    organizationId: r.assignment.organizationId,
    organisationId: r.assignment.organizationId,
    premisesId: r.assignment.premisesId,
    employeeId: r.assignment.employeeId,
    staffId: r.assignment.employeeId,
    shiftId: r.assignment.shiftId,
    absentPay: Number(r.assignment.absentPay),
    presentPay: Number(r.assignment.presentPay),
    leavePay: Number(r.assignment.leavePay),
    halfDayPay: Number(r.assignment.halfDayPay),
    isActive: r.assignment.isActive,
    staffName: r.employeeName,
    shiftName: r.shiftName,
    createdAt: r.assignment.createdAt ? r.assignment.createdAt.toISOString() : undefined,
    updatedAt: r.assignment.updatedAt ? r.assignment.updatedAt.toISOString() : undefined,
  }));
}

export async function createShiftAssignment(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  input: any
) {
  const targetStaffId = (input.employeeId || input.staffId || '').trim();
  if (!targetStaffId) {
    throw new AppError('Employee ID / staff ID is required', 400, 'EMPLOYEE_REQUIRED');
  }

  const [emp] = await fastify.db
    .select({ id: schema.employees.id, premisesId: schema.employees.premisesId, name: schema.employees.name })
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.id, targetStaffId),
        eq(schema.employees.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!emp) {
    throw new AppError('Employee not found in organization', 404, 'EMPLOYEE_NOT_FOUND');
  }

  const [sh] = await fastify.db
    .select({ id: schema.shifts.id, premisesId: schema.shifts.premisesId, shiftName: schema.shifts.shiftName })
    .from(schema.shifts)
    .where(
      and(
        eq(schema.shifts.id, input.shiftId),
        eq(schema.shifts.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!sh) {
    throw new AppError('Shift template not found', 404, 'SHIFT_NOT_FOUND');
  }

  const targetPremisesId = (input.premisesId?.trim()) || emp.premisesId || sh.premisesId;

  const [created] = await fastify.db
    .insert(schema.employeeShiftAssignments)
    .values({
      organizationId,
      premisesId: targetPremisesId,
      employeeId: targetStaffId,
      shiftId: input.shiftId,
      absentPay: String(input.absentPay ?? 0),
      presentPay: String(input.presentPay ?? 0),
      leavePay: String(input.leavePay ?? 0),
      halfDayPay: String(input.halfDayPay ?? 0),
      isActive: input.isActive !== undefined ? input.isActive : true,
    })
    .onConflictDoUpdate({
      target: [
        schema.employeeShiftAssignments.employeeId,
        schema.employeeShiftAssignments.premisesId,
        schema.employeeShiftAssignments.shiftId,
        schema.employeeShiftAssignments.isActive,
      ],
      set: {
        absentPay: String(input.absentPay ?? 0),
        presentPay: String(input.presentPay ?? 0),
        leavePay: String(input.leavePay ?? 0),
        halfDayPay: String(input.halfDayPay ?? 0),
        updatedAt: new Date(),
      },
    })
    .returning();

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'SHIFT_ASSIGNMENT_CREATED',
    resourceType: 'employee_shift_assignment',
    resourceId: created.id,
    metadata: { employeeId: targetStaffId, shiftId: input.shiftId },
  });

  await autoSetWeeklyOffsFromShiftAssignments(
    fastify,
    organizationId,
    actorUserId,
    targetStaffId,
    input.weeklyOffs
  );

  if (fastify.cache) {
    fastify.cache.invalidateTag(`org:${organizationId}:shifts`);
  }

  return {
    id: created.id,
    organizationId: created.organizationId,
    organisationId: created.organizationId,
    premisesId: created.premisesId,
    employeeId: created.employeeId,
    staffId: created.employeeId,
    shiftId: created.shiftId,
    absentPay: Number(created.absentPay),
    presentPay: Number(created.presentPay),
    leavePay: Number(created.leavePay),
    halfDayPay: Number(created.halfDayPay),
    isActive: created.isActive,
    staffName: emp.name,
    shiftName: sh.shiftName,
    createdAt: created.createdAt ? created.createdAt.toISOString() : undefined,
    updatedAt: created.updatedAt ? created.updatedAt.toISOString() : undefined,
  };
}

export async function updateShiftAssignment(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  assignmentId: string,
  input: any
) {
  const [existing] = await fastify.db
    .select()
    .from(schema.employeeShiftAssignments)
    .where(
      and(
        eq(schema.employeeShiftAssignments.id, assignmentId),
        eq(schema.employeeShiftAssignments.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new AppError('Shift assignment not found', 404, 'SHIFT_ASSIGNMENT_NOT_FOUND');
  }

  const updateData: any = { updatedAt: new Date() };
  if (input.absentPay !== undefined) updateData.absentPay = String(input.absentPay);
  if (input.presentPay !== undefined) updateData.presentPay = String(input.presentPay);
  if (input.leavePay !== undefined) updateData.leavePay = String(input.leavePay);
  if (input.halfDayPay !== undefined) updateData.halfDayPay = String(input.halfDayPay);
  if (input.isActive !== undefined) updateData.isActive = input.isActive;

  const [updated] = await fastify.db
    .update(schema.employeeShiftAssignments)
    .set(updateData)
    .where(
      and(
        eq(schema.employeeShiftAssignments.id, assignmentId),
        eq(schema.employeeShiftAssignments.organizationId, organizationId)
      )
    )
    .returning();

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'SHIFT_ASSIGNMENT_UPDATED',
    resourceType: 'employee_shift_assignment',
    resourceId: updated.id,
  });

  await autoSetWeeklyOffsFromShiftAssignments(
    fastify,
    organizationId,
    actorUserId,
    existing.employeeId,
    input.weeklyOffs
  );

  if (fastify.cache) {
    fastify.cache.invalidateTag(`org:${organizationId}:shifts`);
  }

  return {
    id: updated.id,
    organizationId: updated.organizationId,
    organisationId: updated.organizationId,
    premisesId: updated.premisesId,
    employeeId: updated.employeeId,
    staffId: updated.employeeId,
    shiftId: updated.shiftId,
    absentPay: Number(updated.absentPay),
    presentPay: Number(updated.presentPay),
    leavePay: Number(updated.leavePay),
    halfDayPay: Number(updated.halfDayPay),
    isActive: updated.isActive,
    createdAt: updated.createdAt ? updated.createdAt.toISOString() : undefined,
    updatedAt: updated.updatedAt ? updated.updatedAt.toISOString() : undefined,
  };
}

export async function deleteShiftAssignment(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  assignmentId: string
) {
  const [existing] = await fastify.db
    .select({ id: schema.employeeShiftAssignments.id, employeeId: schema.employeeShiftAssignments.employeeId })
    .from(schema.employeeShiftAssignments)
    .where(
      and(
        eq(schema.employeeShiftAssignments.id, assignmentId),
        eq(schema.employeeShiftAssignments.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new AppError('Shift assignment not found', 404, 'SHIFT_ASSIGNMENT_NOT_FOUND');
  }

  await fastify.db
    .delete(schema.employeeShiftAssignments)
    .where(
      and(
        eq(schema.employeeShiftAssignments.id, assignmentId),
        eq(schema.employeeShiftAssignments.organizationId, organizationId)
      )
    );

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'SHIFT_ASSIGNMENT_DELETED',
    resourceType: 'employee_shift_assignment',
    resourceId: assignmentId,
  });

  await autoSetWeeklyOffsFromShiftAssignments(
    fastify,
    organizationId,
    actorUserId,
    existing.employeeId
  );

  if (fastify.cache) {
    fastify.cache.invalidateTag(`org:${organizationId}:shifts`);
  }

  return { deleted: true };
}

export async function autoSetWeeklyOffsFromShiftAssignments(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  employeeId: string,
  explicitWeeklyOffs?: number[]
) {
  if (explicitWeeklyOffs && Array.isArray(explicitWeeklyOffs)) {
    await setWeeklyOffs(fastify, organizationId, actorUserId, employeeId, explicitWeeklyOffs);
    return;
  }

  const activeAssignments = await fastify.db
    .select({
      dayName: schema.shifts.dayName,
    })
    .from(schema.employeeShiftAssignments)
    .innerJoin(schema.shifts, eq(schema.employeeShiftAssignments.shiftId, schema.shifts.id))
    .where(
      and(
        eq(schema.employeeShiftAssignments.employeeId, employeeId),
        eq(schema.employeeShiftAssignments.organizationId, organizationId),
        eq(schema.employeeShiftAssignments.isActive, true)
      )
    );

  if (activeAssignments.length === 0) {
    return;
  }

  const workingDaysSet = new Set<number>();
  for (const assignment of activeAssignments) {
    const days = getAssignedDayNumbers(assignment.dayName);
    days.forEach((d) => workingDaysSet.add(d));
  }

  const weeklyOffDays: number[] = [];
  for (let d = 0; d <= 6; d++) {
    if (!workingDaysSet.has(d)) {
      weeklyOffDays.push(d);
    }
  }

  await setWeeklyOffs(fastify, organizationId, actorUserId, employeeId, weeklyOffDays);
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
      isPaid: input.isPaid ?? true,
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
