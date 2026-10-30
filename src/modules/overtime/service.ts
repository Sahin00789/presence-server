import { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import { ensureStaffProfile, findStaffProfile } from '../../shared/services/staff.service.js';
import { isOvernightShift, parseTimeToMinutes } from '../../shared/utils/datetime.js';
import { CreateOvertimeInput } from './schemas.js';

type Actor = { userId: string; role: 'OWNER' | 'MANAGER' | 'STAFF' };

/** Net planned overtime minutes for a time window (overnight shifts included). */
export function plannedOvertimeMinutes(startTime: string, endTime: string): number {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  const gross = isOvernightShift(startTime, endTime) ? 24 * 60 - start + end : end - start;
  return Math.max(0, gross);
}

/**
 * Lists overtime entries.
 *
 * - STAFF -> only their own entries.
 * - OWNER / MANAGER -> every entry of the organization, optionally narrowed.
 */
export async function listOvertime(
  fastify: FastifyInstance,
  actor: Actor,
  organizationId: string,
  query: { from?: string; to?: string; staffProfileId?: string; status?: string }
) {
  const conditions = [eq(schema.overtime.organizationId, organizationId)];

  if (actor.role === 'STAFF') {
    const profile = await findStaffProfile(fastify, actor.userId, organizationId);
    if (!profile) {
      return [];
    }
    conditions.push(eq(schema.overtime.employeeId, profile.id));
  } else if (query.staffProfileId) {
    conditions.push(eq(schema.overtime.employeeId, query.staffProfileId));
  }

  if (query.status) {
    conditions.push(eq(schema.overtime.status, query.status as never));
  }

  const rows = await fastify.db
    .select({
      overtime: schema.overtime,
      staffName: schema.users.fullName,
      staffEmail: schema.users.email,
      staffCode: schema.employees.employeeCode,
    })
    .from(schema.overtime)
    .innerJoin(schema.employees, eq(schema.employees.id, schema.overtime.employeeId))
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .where(and(...conditions))
    .orderBy(desc(schema.overtime.workDate), desc(schema.overtime.createdAt));

  const filtered =
    query.from || query.to
      ? rows.filter((row) => {
          const date = String(row.overtime.workDate);
          if (query.from && date < query.from) return false;
          if (query.to && date > query.to) return false;
          return true;
        })
      : rows;

  return filtered.map((row) => ({
    id: row.overtime.id,
    organizationId: row.overtime.organizationId,
    staffProfileId: row.overtime.employeeId,
    staffName: row.staffName,
    staffEmail: row.staffEmail,
    staffCode: row.staffCode,
    requestedBy: row.overtime.requestedBy,
    approvedBy: row.overtime.approvedBy,
    workDate: String(row.overtime.workDate),
    startTime: row.overtime.startTime,
    endTime: row.overtime.endTime,
    plannedMinutes: row.overtime.plannedMinutes,
    workedMinutes: row.overtime.workedMinutes,
    paymentInr: row.overtime.paymentInr,
    status: row.overtime.status,
    reason: row.overtime.reason,
    attendanceEventId: row.overtime.attendanceId,
    resolvedAt: row.overtime.resolvedAt ? row.overtime.resolvedAt.toISOString() : null,
    createdAt: row.overtime.createdAt.toISOString(),
  }));
}

/**
 * Raises an overtime entry for a staff member.
 *
 * Only Owners and Managers may raise overtime. When no staff member is given
 * the entry is raised for the caller themselves, so a Manager can create and
 * work their own overtime. The entry is created in the `APPROVED` state - the
 * creator is the approver - so the staff member can immediately check in.
 */
export async function createOvertime(
  fastify: FastifyInstance,
  actor: Actor,
  organizationId: string,
  input: CreateOvertimeInput
) {
  if (actor.role === 'STAFF') {
    throw new AppError(
      'Only Owners and Managers can raise overtime',
      403,
      'OVERTIME_FORBIDDEN'
    );
  }

  const targetProfileId = input.staffProfileId;
  if (!targetProfileId) {
    if (actor.role === 'MANAGER') {
      throw new AppError(
        'Managers cannot create their own overtime. Ask the Owner to raise it.',
        403,
        'OVERTIME_FORBIDDEN'
      );
    }
    throw new AppError(
      'Select a Manager or Staff member for this overtime.',
      400,
      'OVERTIME_TARGET_REQUIRED'
    );
  }

  const [targetProfile] = await fastify.db
    .select({
      id: schema.employees.id,
      userId: schema.employees.userId,
      role: schema.employees.role,
      premisesId: schema.employees.premisesId,
    })
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.id, targetProfileId),
        eq(schema.employees.organizationId, organizationId),
        eq(schema.employees.isActive, true)
      )
    )
    .limit(1);

  if (!targetProfile) {
    throw new AppError('Staff member not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  // Owners may raise overtime for Managers and Staff. Managers may only raise
  // overtime for Staff members; a Manager's overtime must be created by the
  // Owner.
  if (targetProfile.role === 'MANAGER' && actor.role !== 'OWNER') {
    throw new AppError(
      'Only the Owner can create overtime for a Manager.',
      403,
      'OVERTIME_FORBIDDEN'
    );
  }

  if (!targetProfile.premisesId) {
    throw new AppError(
      'Assign a premises to this employee before creating overtime.',
      400,
      'EMPLOYEE_PREMISES_REQUIRED'
    );
  }

  const plannedMinutes = plannedOvertimeMinutes(input.startTime, input.endTime);
  if (plannedMinutes <= 0) {
    throw new AppError(
      'Overtime window must cover at least one minute',
      400,
      'INVALID_OVERTIME_WINDOW'
    );
  }

  // Check for overlap with active shift assignments for this target employee
  const activeAssignments = await fastify.db
    .select({
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      dayName: schema.shifts.dayName,
    })
    .from(schema.employeeShiftAssignments)
    .innerJoin(
      schema.shifts,
      eq(schema.employeeShiftAssignments.shiftId, schema.shifts.id)
    )
    .where(
      and(
        eq(schema.employeeShiftAssignments.employeeId, targetProfileId),
        eq(schema.employeeShiftAssignments.organizationId, organizationId),
        eq(schema.employeeShiftAssignments.isActive, true),
        eq(schema.shifts.isActive, true)
      )
    );

  const otStart = parseTimeToMinutes(input.startTime);
  const otEnd = parseTimeToMinutes(input.endTime);
  const otIsOvernight = isOvernightShift(input.startTime, input.endTime);
  const otStartMins = otStart;
  const otEndMins = otIsOvernight ? otEnd + 24 * 60 : otEnd;

  const targetDateObj = new Date(`${input.workDate}T00:00:00Z`);
  const dayIndex = targetDateObj.getUTCDay();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const targetDayName = dayNames[dayIndex];

  for (const assignment of activeAssignments) {
    const shiftDay = assignment.dayName;
    const matchesDay =
      !shiftDay ||
      shiftDay.toUpperCase() === 'ALL' ||
      shiftDay.toUpperCase().includes('EVERYDAY') ||
      (targetDayName && shiftDay.toLowerCase().includes(targetDayName.toLowerCase()));

    if (matchesDay) {
      const shiftStart = parseTimeToMinutes(assignment.startTime);
      const shiftEnd = parseTimeToMinutes(assignment.endTime);
      const shiftIsOvernight = isOvernightShift(assignment.startTime, assignment.endTime);
      const shiftStartMins = shiftStart;
      const shiftEndMins = shiftIsOvernight ? shiftEnd + 24 * 60 : shiftEnd;

      const overlap = Math.max(otStartMins, shiftStartMins) < Math.min(otEndMins, shiftEndMins);
      if (overlap) {
        throw new AppError(
          `Overtime (${input.startTime} – ${input.endTime}) overlaps with assigned shift "${assignment.shiftName}" (${assignment.startTime} – ${assignment.endTime}). Overtime cannot overlap with an assigned shift.`,
          400,
          'OVERTIME_SHIFT_OVERLAP'
        );
      }
    }
  }

  const [created] = await fastify.db
    .insert(schema.overtime)
    .values({
      organizationId,
      premisesId: targetProfile.premisesId,
      employeeId: targetProfileId,
      requestedBy: actor.userId,
      approvedBy: actor.userId,
      workDate: input.workDate,
      startTime: input.startTime,
      endTime: input.endTime,
      plannedMinutes,
      paymentInr: input.paymentInr,
      status: 'APPROVED',
      reason: input.reason,
    })
    .returning();

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actor.userId,
    action: 'OVERTIME_CREATED',
    resourceType: 'overtimeRequest',
    resourceId: created.id,
    metadata: {
      staffProfileId: targetProfileId,
      workDate: input.workDate,
      plannedMinutes,
      paymentInr: input.paymentInr,
      selfAssigned: !input.staffProfileId,
    },
  });

  const [staff] = await fastify.db
    .select({
      fullName: schema.users.fullName,
      email: schema.users.email,
      staffCode: schema.employees.employeeCode,
    })
    .from(schema.employees)
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .where(eq(schema.employees.id, targetProfileId))
    .limit(1);

  return {
    id: created.id,
    organizationId: created.organizationId,
    staffProfileId: created.employeeId,
    staffName: staff?.fullName ?? '',
    staffEmail: staff?.email ?? '',
    staffCode: staff?.staffCode ?? '',
    requestedBy: created.requestedBy,
    approvedBy: created.approvedBy,
    workDate: String(created.workDate),
    startTime: created.startTime,
    endTime: created.endTime,
    plannedMinutes: created.plannedMinutes,
    workedMinutes: created.workedMinutes,
    paymentInr: created.paymentInr,
    status: created.status,
    reason: created.reason,
    attendanceEventId: created.attendanceId,
    resolvedAt: null,
    createdAt: created.createdAt.toISOString(),
  };
}

/**
 * Cancels an overtime entry that has not been worked yet.
 */
export async function cancelOvertime(
  fastify: FastifyInstance,
  actor: Actor,
  organizationId: string,
  overtimeId: string
) {
  const [overtime] = await fastify.db
    .select()
    .from(schema.overtime)
    .where(
      and(
        eq(schema.overtime.id, overtimeId),
        eq(schema.overtime.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!overtime) {
    throw new AppError('Overtime entry not found', 404, 'OVERTIME_NOT_FOUND');
  }

  if (overtime.status === 'IN_PROGRESS' || overtime.status === 'COMPLETED') {
    throw new AppError(
      'Overtime that has already been started cannot be cancelled',
      409,
      'OVERTIME_ALREADY_STARTED'
    );
  }

  const [updated] = await fastify.db
    .update(schema.overtime)
    .set({ status: 'CANCELLED', resolvedAt: new Date() })
    .where(eq(schema.overtime.id, overtimeId))
    .returning();

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actor.userId,
    action: 'OVERTIME_CANCELLED',
    resourceType: 'overtimeRequest',
    resourceId: overtimeId,
  });

  return { id: updated.id, status: updated.status };
}
