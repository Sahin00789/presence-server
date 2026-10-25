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
  const conditions = [eq(schema.overtimeRequests.organizationId, organizationId)];

  if (actor.role === 'STAFF') {
    const profile = await findStaffProfile(fastify, actor.userId, organizationId);
    if (!profile) {
      return [];
    }
    conditions.push(eq(schema.overtimeRequests.staffProfileId, profile.id));
  } else if (query.staffProfileId) {
    conditions.push(eq(schema.overtimeRequests.staffProfileId, query.staffProfileId));
  }

  if (query.status) {
    conditions.push(eq(schema.overtimeRequests.status, query.status as never));
  }

  const rows = await fastify.db
    .select({
      overtime: schema.overtimeRequests,
      staffName: schema.users.fullName,
      staffEmail: schema.users.email,
      staffCode: schema.staffProfiles.staffCode,
    })
    .from(schema.overtimeRequests)
    .innerJoin(schema.staffProfiles, eq(schema.staffProfiles.id, schema.overtimeRequests.staffProfileId))
    .innerJoin(schema.users, eq(schema.users.id, schema.staffProfiles.userId))
    .where(and(...conditions))
    .orderBy(desc(schema.overtimeRequests.workDate), desc(schema.overtimeRequests.createdAt));

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
    staffProfileId: row.overtime.staffProfileId,
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
    paymentCents: row.overtime.paymentCents,
    status: row.overtime.status,
    reason: row.overtime.reason,
    attendanceEventId: row.overtime.attendanceEventId,
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

  const targetProfileId = input.staffProfileId
    ? input.staffProfileId
    : (await ensureStaffProfile(fastify, actor.userId, organizationId)).id;

  const [targetProfile] = await fastify.db
    .select({ id: schema.staffProfiles.id })
    .from(schema.staffProfiles)
    .where(
      and(
        eq(schema.staffProfiles.id, targetProfileId),
        eq(schema.staffProfiles.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!targetProfile) {
    throw new AppError('Staff member not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  const plannedMinutes = plannedOvertimeMinutes(input.startTime, input.endTime);
  if (plannedMinutes <= 0) {
    throw new AppError(
      'Overtime window must cover at least one minute',
      400,
      'INVALID_OVERTIME_WINDOW'
    );
  }

  const [created] = await fastify.db
    .insert(schema.overtimeRequests)
    .values({
      organizationId,
      staffProfileId: targetProfileId,
      requestedBy: actor.userId,
      approvedBy: actor.userId,
      workDate: input.workDate,
      startTime: input.startTime,
      endTime: input.endTime,
      plannedMinutes,
      paymentCents: input.paymentCents,
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
      paymentCents: input.paymentCents,
      selfAssigned: !input.staffProfileId,
    },
  });

  const [staff] = await fastify.db
    .select({
      fullName: schema.users.fullName,
      email: schema.users.email,
      staffCode: schema.staffProfiles.staffCode,
    })
    .from(schema.staffProfiles)
    .innerJoin(schema.users, eq(schema.users.id, schema.staffProfiles.userId))
    .where(eq(schema.staffProfiles.id, targetProfileId))
    .limit(1);

  return {
    id: created.id,
    organizationId: created.organizationId,
    staffProfileId: created.staffProfileId,
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
    paymentCents: created.paymentCents,
    status: created.status,
    reason: created.reason,
    attendanceEventId: created.attendanceEventId,
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
    .from(schema.overtimeRequests)
    .where(
      and(
        eq(schema.overtimeRequests.id, overtimeId),
        eq(schema.overtimeRequests.organizationId, organizationId)
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
    .update(schema.overtimeRequests)
    .set({ status: 'CANCELLED', resolvedAt: new Date() })
    .where(eq(schema.overtimeRequests.id, overtimeId))
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
