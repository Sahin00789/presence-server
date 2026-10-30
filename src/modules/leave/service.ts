import { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import { createNotification } from '../../shared/services/notification.service.js';
import {
  findStaffProfile,
  listManagerUserIds,
  listOwnerUserIds,
} from '../../shared/services/staff.service.js';
import {
  dayOfWeek,
  isOvernightShift,
  parseTimeToMinutes,
} from '../../shared/utils/datetime.js';

type Role = 'OWNER' | 'MANAGER' | 'STAFF';

const reviewingUsers = alias(schema.users, 'reviewing_users');

function formatShiftHours(startTime?: string | null, endTime?: string | null): string {
  if (!startTime || !endTime) return 'Flexible Hours';
  return `${startTime.slice(0, 5)} - ${endTime.slice(0, 5)}`;
}

export function mapLeave(row: {
  leave: typeof schema.leaveRequests.$inferSelect;
  staffName: string;
  staffCode: string;
  premisesName?: string | null;
  shiftName?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  reviewedByName?: string | null;
}) {
  const shiftHours = formatShiftHours(row.startTime, row.endTime);
  const workDateStr = String(row.leave.workDate);

  return {
    id: row.leave.id,
    organisationId: row.leave.organizationId,
    organizationId: row.leave.organizationId,
    premisesId: row.leave.premisesId,
    premisesName: row.premisesName ?? 'Main Premises',
    staffId: row.leave.employeeId,
    staffProfileId: row.leave.employeeId,
    staffName: row.staffName,
    staffCode: row.staffCode,
    shiftAssignmentId: row.leave.shiftAssignmentId,
    shiftName: row.shiftName ?? 'Assigned Shift',
    shiftHours,
    workDate: workDateStr,
    startDate: workDateStr,
    endDate: workDateStr,
    reason: row.leave.reason,
    status: row.leave.status,
    reviewedBy: row.leave.reviewedBy,
    reviewedByName: row.reviewedByName ?? null,
    reviewedAt: row.leave.reviewedAt ? row.leave.reviewedAt.toISOString() : null,
    reviewRemarks: row.leave.reviewRemarks,
    reviewNote: row.leave.reviewRemarks,
    createdAt: row.leave.createdAt.toISOString(),
    updatedAt: row.leave.updatedAt.toISOString(),
  };
}

export async function createLeaveRequest(
  fastify: FastifyInstance,
  user: { userId: string; role: Role },
  organizationId: string,
  input: {
    shiftAssignmentId: string;
    workDate: string;
    reason: string;
  }
) {
  // 1. Derive staff identity from authenticated session.
  const profile = await findStaffProfile(fastify, user.userId, organizationId);
  if (!profile) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  // 2. Validate selected shift assignment belongs to employee and organization.
  const [assignment] = await fastify.db
    .select({
      id: schema.employeeShiftAssignments.id,
      organizationId: schema.employeeShiftAssignments.organizationId,
      premisesId: schema.employeeShiftAssignments.premisesId,
      staffProfileId: schema.employeeShiftAssignments.employeeId,
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      premisesName: schema.premises.name,
    })
    .from(schema.employeeShiftAssignments)
    .innerJoin(schema.shifts, eq(schema.employeeShiftAssignments.shiftId, schema.shifts.id))
    .innerJoin(schema.premises, eq(schema.employeeShiftAssignments.premisesId, schema.premises.id))
    .where(
      and(
        eq(schema.employeeShiftAssignments.id, input.shiftAssignmentId),
        eq(schema.employeeShiftAssignments.employeeId, profile.id),
        eq(schema.employeeShiftAssignments.organizationId, organizationId),
        eq(schema.employeeShiftAssignments.isActive, true)
      )
    )
    .limit(1);

  if (!assignment) {
    throw new AppError(
      'Selected shift assignment does not belong to employee or is inactive',
      404,
      'SHIFT_ASSIGNMENT_NOT_FOUND'
    );
  }

  // 3. Prevent duplicate active leave request for the same shift assignment & work date.
  const [overlapping] = await fastify.db
    .select({ id: schema.leaveRequests.id })
    .from(schema.leaveRequests)
    .where(
      and(
        eq(schema.leaveRequests.shiftAssignmentId, input.shiftAssignmentId),
        eq(schema.leaveRequests.workDate, input.workDate),
        inArray(schema.leaveRequests.status, ['PENDING', 'APPROVED'])
      )
    )
    .limit(1);

  if (overlapping) {
    throw new AppError(
      'A pending or approved leave request already exists for this shift assignment and work date',
      409,
      'LEAVE_OVERLAP'
    );
  }

  // 4. Check if employee has already clocked in or completed conflicting attendance.
  const [existingAttendance] = await fastify.db
    .select({
      id: schema.employeeAttendance.id,
      clockInAt: schema.employeeAttendance.clockInAt,
      status: schema.employeeAttendance.status,
    })
    .from(schema.employeeAttendance)
    .where(
      and(
        eq(schema.employeeAttendance.shiftAssignmentId, input.shiftAssignmentId),
        eq(schema.employeeAttendance.workDate, input.workDate)
      )
    )
    .limit(1);

  if (
    existingAttendance &&
    (existingAttendance.clockInAt !== null ||
      ['PRESENT', 'LATE', 'HALF_DAY'].includes(existingAttendance.status))
  ) {
    throw new AppError(
      'Cannot request leave: Attendance or clock-in has already been recorded for this date',
      409,
      'ATTENDANCE_CONFLICT'
    );
  }

  // 5. Insert leave request record.
  const [created] = await fastify.db
    .insert(schema.leaveRequests)
    .values({
      organizationId: organizationId,
      premisesId: assignment.premisesId,
      employeeId: profile.id,
      shiftAssignmentId: input.shiftAssignmentId,
      workDate: input.workDate,
      reason: input.reason,
      requestedBy: user.userId,
      status: 'PENDING',
    })
    .returning();

  // 6. Send notifications to reviewers.
  const reviewerIds = Array.from(
    new Set([
      ...(await listManagerUserIds(fastify, organizationId)),
      ...(await listOwnerUserIds(fastify, organizationId)),
    ])
  );

  const [staffUser] = await fastify.db
    .select({ fullName: schema.users.fullName, staffCode: schema.employees.employeeCode })
    .from(schema.employees)
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .where(eq(schema.employees.id, profile.id))
    .limit(1);

  for (const reviewerId of reviewerIds) {
    await createNotification(fastify, {
      organizationId,
      userId: reviewerId,
      type: 'LEAVE_REQUESTED',
      title: 'Leave request awaiting review',
      body: `${staffUser?.fullName ?? 'Staff'} requested leave for ${assignment.shiftName} on ${input.workDate}.`,
      dedupeKey: `leave-requested:${created.id}:${reviewerId}`,
      metadata: { leaveRequestId: created.id, staffProfileId: profile.id, workDate: input.workDate },
    });
  }

  await writeAuditLog(fastify, {
    organizationId,
    actorId: user.userId,
    action: 'LEAVE_REQUESTED',
    resourceType: 'leave_request',
    resourceId: created.id,
    metadata: { staffProfileId: profile.id, shiftAssignmentId: input.shiftAssignmentId, workDate: input.workDate },
  });

  return mapLeave({
    leave: created,
    staffName: staffUser?.fullName ?? '',
    staffCode: staffUser?.staffCode ?? '',
    premisesName: assignment.premisesName,
    shiftName: assignment.shiftName,
    startTime: assignment.startTime,
    endTime: assignment.endTime,
  });
}

export async function listLeaveRequests(
  fastify: FastifyInstance,
  user: { userId: string; role: Role },
  organizationId: string,
  query: {
    status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
    premisesId?: string;
    staffId?: string;
    staffProfileId?: string;
    from?: string;
    to?: string;
  } = {}
) {
  const conditions = [eq(schema.leaveRequests.organizationId, organizationId)];

  if (user.role === 'STAFF') {
    const profile = await findStaffProfile(fastify, user.userId, organizationId);
    if (!profile) {
      return [];
    }
    conditions.push(eq(schema.leaveRequests.employeeId, profile.id));
  } else {
    const targetStaffId = query.staffId ?? query.staffProfileId;
    if (targetStaffId) {
      conditions.push(eq(schema.leaveRequests.employeeId, targetStaffId));
    }
    if (query.premisesId) {
      conditions.push(eq(schema.leaveRequests.premisesId, query.premisesId));
    }
  }

  if (query.status) {
    conditions.push(eq(schema.leaveRequests.status, query.status));
  }
  if (query.from) {
    conditions.push(gte(schema.leaveRequests.workDate, query.from));
  }
  if (query.to) {
    conditions.push(lte(schema.leaveRequests.workDate, query.to));
  }

  const rows = await fastify.db
    .select({
      leave: schema.leaveRequests,
      staffName: schema.users.fullName,
      staffCode: schema.employees.employeeCode,
      premisesName: schema.premises.name,
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      reviewedByName: reviewingUsers.fullName,
    })
    .from(schema.leaveRequests)
    .innerJoin(schema.employees, eq(schema.employees.id, schema.leaveRequests.employeeId))
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .innerJoin(schema.premises, eq(schema.premises.id, schema.leaveRequests.premisesId))
    .innerJoin(
      schema.employeeShiftAssignments,
      eq(schema.employeeShiftAssignments.id, schema.leaveRequests.shiftAssignmentId)
    )
    .innerJoin(schema.shifts, eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId))
    .leftJoin(reviewingUsers, eq(reviewingUsers.id, schema.leaveRequests.reviewedBy))
    .where(and(...conditions))
    .orderBy(desc(schema.leaveRequests.createdAt));

  return rows.map(mapLeave);
}

export async function getLeaveRequestDetails(
  fastify: FastifyInstance,
  user: { userId: string; role: Role },
  organizationId: string,
  leaveRequestId: string
) {
  const conditions = [
    eq(schema.leaveRequests.id, leaveRequestId),
    eq(schema.leaveRequests.organizationId, organizationId),
  ];

  if (user.role === 'STAFF') {
    const profile = await findStaffProfile(fastify, user.userId, organizationId);
    if (!profile) {
      throw new AppError('Leave request not found', 404, 'LEAVE_REQUEST_NOT_FOUND');
    }
    conditions.push(eq(schema.leaveRequests.employeeId, profile.id));
  }

  const [row] = await fastify.db
    .select({
      leave: schema.leaveRequests,
      staffName: schema.users.fullName,
      staffCode: schema.employees.employeeCode,
      premisesName: schema.premises.name,
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      reviewedByName: reviewingUsers.fullName,
    })
    .from(schema.leaveRequests)
    .innerJoin(schema.employees, eq(schema.employees.id, schema.leaveRequests.employeeId))
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .innerJoin(schema.premises, eq(schema.premises.id, schema.leaveRequests.premisesId))
    .innerJoin(
      schema.employeeShiftAssignments,
      eq(schema.employeeShiftAssignments.id, schema.leaveRequests.shiftAssignmentId)
    )
    .innerJoin(schema.shifts, eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId))
    .leftJoin(reviewingUsers, eq(reviewingUsers.id, schema.leaveRequests.reviewedBy))
    .where(and(...conditions))
    .limit(1);

  if (!row) {
    throw new AppError('Leave request not found', 404, 'LEAVE_REQUEST_NOT_FOUND');
  }

  return mapLeave(row);
}

export async function reviewLeaveRequest(
  fastify: FastifyInstance,
  actorUserId: string,
  organizationId: string,
  leaveRequestId: string,
  input: { decision: 'APPROVED' | 'REJECTED'; reviewRemarks?: string; note?: string }
) {
  const remarks = input.reviewRemarks ?? input.note ?? null;

  // Retrieve leave request details.
  const [row] = await fastify.db
    .select({
      leave: schema.leaveRequests,
      staffUserId: schema.employees.userId,
      staffName: schema.users.fullName,
      staffCode: schema.employees.employeeCode,
      premisesName: schema.premises.name,
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
    })
    .from(schema.leaveRequests)
    .innerJoin(schema.employees, eq(schema.employees.id, schema.leaveRequests.employeeId))
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .innerJoin(schema.premises, eq(schema.premises.id, schema.leaveRequests.premisesId))
    .innerJoin(
      schema.employeeShiftAssignments,
      eq(schema.employeeShiftAssignments.id, schema.leaveRequests.shiftAssignmentId)
    )
    .innerJoin(schema.shifts, eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId))
    .where(
      and(
        eq(schema.leaveRequests.id, leaveRequestId),
        eq(schema.leaveRequests.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!row) {
    throw new AppError('Leave request not found', 404, 'LEAVE_REQUEST_NOT_FOUND');
  }

  if (row.leave.status !== 'PENDING') {
    throw new AppError('Only pending leave requests can be reviewed', 409, 'LEAVE_ALREADY_REVIEWED');
  }

  let updatedLeave: typeof schema.leaveRequests.$inferSelect;

  if (input.decision === 'APPROVED') {
    // Atomically approve request and update attendance record inside a database transaction.
    updatedLeave = await fastify.db.transaction(async (tx) => {
      // 1. Lock/verify request status.
      const [pendingCheck] = await tx
        .select({ status: schema.leaveRequests.status })
        .from(schema.leaveRequests)
        .where(eq(schema.leaveRequests.id, leaveRequestId))
        .limit(1);

      if (!pendingCheck || pendingCheck.status !== 'PENDING') {
        throw new AppError('Leave request has already been reviewed', 409, 'LEAVE_ALREADY_REVIEWED');
      }

      // 2. Retrieve shift assignment for leavePay.
      const [assignment] = await tx
        .select({
          id: schema.employeeShiftAssignments.id,
          leavePay: schema.employeeShiftAssignments.leavePay,
        })
        .from(schema.employeeShiftAssignments)
        .where(eq(schema.employeeShiftAssignments.id, row.leave.shiftAssignmentId))
        .limit(1);

      if (!assignment) {
        throw new AppError('Associated shift assignment not found', 404, 'SHIFT_ASSIGNMENT_NOT_FOUND');
      }

      // 3. Check for conflicting attendance.
      const [existingAttendance] = await tx
        .select({
          id: schema.employeeAttendance.id,
          clockInAt: schema.employeeAttendance.clockInAt,
          clockOutAt: schema.employeeAttendance.clockOutAt,
          status: schema.employeeAttendance.status,
        })
        .from(schema.employeeAttendance)
        .where(
          and(
            eq(schema.employeeAttendance.shiftAssignmentId, row.leave.shiftAssignmentId),
            eq(schema.employeeAttendance.workDate, row.leave.workDate)
          )
        )
        .limit(1);

      if (
        existingAttendance &&
        (existingAttendance.clockInAt !== null ||
          existingAttendance.clockOutAt !== null ||
          ['PRESENT', 'LATE', 'HALF_DAY'].includes(existingAttendance.status))
      ) {
        throw new AppError(
          'Cannot approve leave: Conflicting attendance or clock-in record exists for this date. A manager must resolve the conflict first.',
          409,
          'ATTENDANCE_CONFLICT'
        );
      }

      const shiftStart = parseTimeToMinutes(row.startTime);
      const shiftEnd = parseTimeToMinutes(row.endTime);
      const scheduledMinutes = Math.max(
        0,
        isOvernightShift(row.startTime, row.endTime)
          ? 24 * 60 - shiftStart + shiftEnd
          : shiftEnd - shiftStart
      );

      let attendanceId: string;
      if (!existingAttendance) {
        const [inserted] = await tx
          .insert(schema.employeeAttendance)
          .values({
            organizationId: row.leave.organizationId,
            premisesId: row.leave.premisesId,
            employeeId: row.leave.employeeId,
            shiftAssignmentId: row.leave.shiftAssignmentId,
            attendanceType: 'SHIFT',
            workDate: row.leave.workDate,
            status: 'LEAVE',
            scheduledMinutes,
            workedMinutes: 0,
            statusUpdatedBy: actorUserId,
            remarks: `Leave approved: ${row.leave.reason}`,
          })
          .returning();
        attendanceId = inserted.id;
      } else {
        await tx
          .update(schema.employeeAttendance)
          .set({
            status: 'LEAVE',
            scheduledMinutes,
            statusUpdatedBy: actorUserId,
            remarks: `Leave approved: ${row.leave.reason}`,
            updatedAt: new Date(),
          })
          .where(eq(schema.employeeAttendance.id, existingAttendance.id));
        attendanceId = existingAttendance.id;
      }

      // If the shift end time has already passed, accrue leave pay earning immediately
      const now = new Date();
      const isOvernight = isOvernightShift(row.startTime, row.endTime);
      const endDateStr = isOvernight
        ? new Date(new Date(`${row.leave.workDate}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)
        : String(row.leave.workDate);
      const shiftEndTimeIso = `${endDateStr}T${(row.endTime ?? '17:00:00').slice(0, 5)}:00`;
      const shiftEndAt = new Date(shiftEndTimeIso);

      if (now.getTime() >= shiftEndAt.getTime()) {
        const leavePay = Number(assignment.leavePay ?? 0);
        if (leavePay > 0) {
          const [existingLedger] = await tx
            .select({ id: schema.employeeEarningLedger.id })
            .from(schema.employeeEarningLedger)
            .where(
              and(
                eq(schema.employeeEarningLedger.employeeId, row.leave.employeeId),
                eq(schema.employeeEarningLedger.earningDate, String(row.leave.workDate)),
                eq(schema.employeeEarningLedger.type, 'SHIFT')
              )
            )
            .limit(1);

          if (!existingLedger) {
            await tx.insert(schema.employeeEarningLedger).values({
              organizationId: row.leave.organizationId,
              premisesId: row.leave.premisesId,
              employeeId: row.leave.employeeId,
              earningDate: String(row.leave.workDate),
              type: 'SHIFT',
              amount: String(leavePay),
              shiftAssignmentId: row.leave.shiftAssignmentId,
              attendanceId: attendanceId,
              sourceReference: `leave:${leaveRequestId}`,
            } as any);
          }
        }
      }

      // 5. Update leave request to APPROVED.
      const [updated] = await tx
        .update(schema.leaveRequests)
        .set({
          status: 'APPROVED',
          reviewedBy: actorUserId,
          reviewedAt: new Date(),
          reviewRemarks: remarks,
          updatedAt: new Date(),
        })
        .where(eq(schema.leaveRequests.id, leaveRequestId))
        .returning();

      return updated;
    });
  } else {
    // Decision is REJECTED. Do NOT touch attendance or payment.
    const [updated] = await fastify.db
      .update(schema.leaveRequests)
      .set({
        status: 'REJECTED',
        reviewedBy: actorUserId,
        reviewedAt: new Date(),
        reviewRemarks: remarks,
        updatedAt: new Date(),
      })
      .where(eq(schema.leaveRequests.id, leaveRequestId))
      .returning();

    updatedLeave = updated;
  }

  // Get reviewer name for response mapping.
  const [reviewer] = await fastify.db
    .select({ fullName: schema.users.fullName })
    .from(schema.users)
    .where(eq(schema.users.id, actorUserId))
    .limit(1);

  if (row.staffUserId) {
    await createNotification(fastify, {
      organizationId,
      userId: row.staffUserId,
      type: input.decision === 'APPROVED' ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED',
      title: input.decision === 'APPROVED' ? 'Leave approved' : 'Leave rejected',
      body:
        input.decision === 'APPROVED'
          ? `Your leave request for ${row.shiftName} on ${row.leave.workDate} was approved.`
          : `Your leave request for ${row.shiftName} on ${row.leave.workDate} was rejected.${
              remarks ? ` Remarks: ${remarks}` : ''
            }`,
      dedupeKey: `leave-review:${leaveRequestId}:${input.decision}`,
      metadata: { leaveRequestId, decision: input.decision, workDate: row.leave.workDate },
    });
  }

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: `LEAVE_${input.decision}`,
    resourceType: 'leave_request',
    resourceId: leaveRequestId,
    metadata: { remarks },
  });

  return mapLeave({
    leave: updatedLeave,
    staffName: row.staffName,
    staffCode: row.staffCode,
    premisesName: row.premisesName,
    shiftName: row.shiftName,
    startTime: row.startTime,
    endTime: row.endTime,
    reviewedByName: reviewer?.fullName,
  });
}

export async function cancelLeaveRequest(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string,
  leaveRequestId: string
) {
  const [row] = await fastify.db
    .select({
      leave: schema.leaveRequests,
      staffUserId: schema.employees.userId,
    })
    .from(schema.leaveRequests)
    .innerJoin(schema.employees, eq(schema.employees.id, schema.leaveRequests.employeeId))
    .where(
      and(
        eq(schema.leaveRequests.id, leaveRequestId),
        eq(schema.leaveRequests.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!row) {
    throw new AppError('Leave request not found', 404, 'LEAVE_REQUEST_NOT_FOUND');
  }

  if (row.staffUserId !== userId) {
    throw new AppError('You can only cancel your own leave request', 403, 'FORBIDDEN');
  }

  if (row.leave.status !== 'PENDING') {
    throw new AppError('Only pending requests can be cancelled', 409, 'LEAVE_NOT_CANCELLABLE');
  }

  await fastify.db
    .update(schema.leaveRequests)
    .set({ status: 'CANCELLED', updatedAt: new Date() })
    .where(eq(schema.leaveRequests.id, leaveRequestId));

  await writeAuditLog(fastify, {
    organizationId,
    actorId: userId,
    action: 'LEAVE_CANCELLED',
    resourceType: 'leave_request',
    resourceId: leaveRequestId,
  });

  return { id: leaveRequestId, status: 'CANCELLED' as const };
}
