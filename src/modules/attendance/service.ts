import { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { evaluateGeofence, DEFAULT_GEOFENCE_RADIUS_METERS } from '../../shared/utils/geo.js';
import { findStaffProfile } from '../../shared/services/staff.service.js';
import { toDateISO, enumerateDates } from '../../shared/utils/datetime.js';
import { buildSchedule, resolveAssignmentForDate, resolveTimezone } from '../shifts/service.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import { compareWithEnrolledFace } from '../face/service.js';
import { assertLivenessEvidence, type LivenessEvidence } from '../../shared/utils/liveness.js';
import { calculateDailyAccrual, getCurrentSalaryStructure, getShiftPaymentRules, getUnworkedPaymentRules } from '../salary/service.js';
import { postLedgerTransaction } from '../wallet/service.js';
import { createNotification } from '../../shared/services/notification.service.js';
import {
  listManagerUserIds,
  listOwnerUserIds,
} from '../../shared/services/staff.service.js';

/**
 * Maps an `attendance_events` row to the camelCase shape returned to clients.
 */
export function toPublicAttendanceEvent(event: typeof schema.attendanceEvents.$inferSelect) {
  return {
    id: event.id,
    staffProfileId: event.staffProfileId,
    clockIn: event.clockIn,
    clockOut: event.clockOut,
    status: event.status,
    workDate: event.workDate ? String(event.workDate) : null,
    faceVerified: event.faceVerified,
    geofenceVerified: event.geofenceVerified,
    workedMinutes: event.workedMinutes,
    scheduledMinutes: event.scheduledMinutes,
    premisesId: event.premisesId,
    overtimeId: (event as { overtimeId?: string | null }).overtimeId ?? null,
  };
}

export async function clockIn(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string,
  body: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    faceVerified?: boolean;
    faceScore?: number;
    embeddingVector?: number[];
    premisesId?: string;
    timestamp?: string;
    isMocked?: boolean;
    liveness?: LivenessEvidence;
    /** When present the check-in belongs to an overtime entry. */
    overtimeId?: string;
  }
) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  // The client-reported `faceVerified` flag is deliberately ignored: the server
  // recomputes cosine similarity against the encrypted enrolled template so a
  // tampered APK cannot bypass biometric verification.
  if (!body.embeddingVector || body.embeddingVector.length === 0) {
    throw new AppError(
      'A face embedding is required to clock in',
      400,
      'FACE_EMBEDDING_REQUIRED'
    );
  }

  if (!body.liveness) {
    throw new AppError(
      'Liveness evidence is required to clock in',
      422,
      'LIVENESS_EVIDENCE_REQUIRED'
    );
  }
  assertLivenessEvidence(body.liveness);

  const faceMatch = await compareWithEnrolledFace(fastify, profile.id, body.embeddingVector);
  if (!faceMatch.enrolled) {
    throw new AppError(
      'Enrol your face before clocking in',
      409,
      'FACE_ENROLLMENT_REQUIRED'
    );
  }
  if (!faceMatch.matched) {
    throw new AppError(
      'Face verification failed',
      401,
      'FACE_VERIFICATION_FAILED',
      { similarity: faceMatch.similarity }
    );
  }

  const reading = {
    latitude: body.latitude,
    longitude: body.longitude,
    accuracyMeters: body.accuracyMeters,
    isMocked: body.isMocked ?? false,
    capturedAt: body.timestamp ? new Date(body.timestamp) : new Date(),
  };

  // Resolve the overtime entry this check-in belongs to (if any).
  let overtime: typeof schema.overtimeRequests.$inferSelect | null = null;
  if (body.overtimeId) {
    const [entry] = await fastify.db
      .select()
      .from(schema.overtimeRequests)
      .where(
        and(
          eq(schema.overtimeRequests.id, body.overtimeId),
          eq(schema.overtimeRequests.organizationId, organizationId)
        )
      )
      .limit(1);

    if (!entry) {
      throw new AppError('Overtime entry not found', 404, 'OVERTIME_NOT_FOUND');
    }

    if (entry.staffProfileId !== profile.id) {
      throw new AppError(
        'This overtime entry belongs to another staff member',
        403,
        'OVERTIME_NOT_ASSIGNED_TO_YOU'
      );
    }

    if (entry.status !== 'APPROVED') {
      throw new AppError(
        'Overtime entry is not open for check-in',
        409,
        'OVERTIME_NOT_OPEN'
      );
    }

    overtime = entry;
  }

  // Find the premises to validate against. When the client does not pin one,
  // pick the nearest active premises of the organization.
  let premises: any = null;
  if (body.premisesId) {
    [premises] = await fastify.db
      .select()
      .from(schema.premises)
      .where(and(eq(schema.premises.id, body.premisesId), eq(schema.premises.organizationId, organizationId)))
      .limit(1);
  } else {
    const candidates = await fastify.db
      .select()
      .from(schema.premises)
      .where(and(eq(schema.premises.organizationId, organizationId), eq(schema.premises.isActive, true)));

    const reading = {
      latitude: body.latitude,
      longitude: body.longitude,
      accuracyMeters: body.accuracyMeters,
      isMocked: body.isMocked ?? false,
      capturedAt: body.timestamp ? new Date(body.timestamp) : new Date(),
    };

    const ranked = candidates
      .map((candidate) => ({
        candidate,
        distance: evaluateGeofence(reading, {
          latitude: Number(candidate.latitude),
          longitude: Number(candidate.longitude),
          radiusMeters: Number(candidate.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS),
        }).distanceMeters,
      }))
      .sort((a, b) => a.distance - b.distance);

    premises = ranked[0]?.candidate ?? null;
  }

  if (!premises) {
    throw new AppError('No active premises configured', 400, 'PREMISES_NOT_CONFIGURED');
  }

  const geofence = evaluateGeofence(
    {
      latitude: body.latitude,
      longitude: body.longitude,
      accuracyMeters: body.accuracyMeters,
      isMocked: body.isMocked ?? false,
      capturedAt: body.timestamp ? new Date(body.timestamp) : new Date(),
    },
    {
      latitude: Number(premises.latitude),
      longitude: Number(premises.longitude),
      radiusMeters: Number(premises.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS),
    }
  );

  if (geofence.result !== 'IN_PREMISES') {
    throw new AppError('Not within premises geofence', 403, 'OUTSIDE_GEOFENCE');
  }

  const now = body.timestamp ? new Date(body.timestamp) : new Date();
  const workDate = overtime ? String(overtime.workDate) : toDateISO(now);

  let shiftAssignmentId: string | null = null;
  let scheduledMinutes = overtime ? overtime.plannedMinutes : 0;
  let status: (typeof schema.attendanceStatusEnum.enumValues)[number] = 'PRESENT';

  if (overtime) {
    // Overtime is checked in exactly like a shift: no regular shift assignment
    // is involved, the planned overtime minutes are the schedule.
    shiftAssignmentId = null;
  } else {
    const timezone = await resolveTimezone(fastify, organizationId);
    const [entry] = await buildSchedule(
      fastify,
      organizationId,
      profile.id,
      workDate,
      workDate,
      timezone
    );

    if (entry?.type === 'SHIFT') {
      shiftAssignmentId =
        (await resolveAssignmentForDate(fastify, profile.id, workDate))?.assignmentId ?? null;
      scheduledMinutes = entry.scheduledMinutes;

      // Late check-in is measured against the shift start plus the configured
      // grace period (`docs/ATTENDANCE_RULES.md` §2).
      const startAt = entry.startAt ? new Date(entry.startAt) : null;
      const graceMinutes = entry.lateGraceMinutes ?? 0;
      if (startAt && now.getTime() > startAt.getTime() + graceMinutes * 60_000) {
        status = 'LATE';
      }
    }
  }

  const [event] = await fastify.db
    .insert(schema.attendanceEvents)
    .values({
      staffProfileId: profile.id,
      shiftAssignmentId,
      clockIn: now,
      workDate,
      status,
      faceVerified: true,
      geofenceVerified: true,
      faceScore: String(faceMatch.similarity),
      premisesId: premises.id,
      overtimeId: overtime ? overtime.id : null,
      scheduledMinutes,
    })
    .returning();

  if (overtime) {
    await fastify.db
      .update(schema.overtimeRequests)
      .set({ status: 'IN_PROGRESS', attendanceEventId: event.id })
      .where(eq(schema.overtimeRequests.id, overtime.id));
  }

  // Start monitoring session
  await fastify.db.insert(schema.locationMonitoringSessions).values({
    attendanceEventId: event.id,
    staffProfileId: profile.id,
    isActive: true,
    consecutiveFailures: 0,
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: userId,
    action: 'ATTENDANCE_CLOCK_IN',
    resourceType: 'attendance_event',
    resourceId: event.id,
    metadata: {
      workDate,
      status,
      faceSimilarity: faceMatch.similarity,
      premisesId: premises.id,
      overtimeId: overtime?.id ?? null,
    },
  });

  if (typeof fastify.publishDomainEvent === 'function') {
    await fastify.publishDomainEvent({
      type: 'attendance_update',
      organizationId,
      userIds: [profile.userId],
      payload: { attendanceEventId: event.id, staffProfileId: profile.id, status, action: 'CLOCK_IN' },
    });
  }

  return event;
}

/**
 * Requests a manual attendance correction when on-device face or GPS
 * verification is impossible (for example a broken camera).
 *
 * The check-in is recorded as unverified and an exception is raised so a
 * Manager or Owner must explicitly approve it. Nothing is auto-approved
 * (`docs/ATTENDANCE_RULES.md` §5).
 */
export async function requestManualClockIn(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string,
  body: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    reason: string;
    timestamp?: string;
    premisesId?: string;
  }
) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  const [staffUser] = await fastify.db
    .select({ fullName: schema.users.fullName })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const staffName = staffUser?.fullName ?? 'Staff member';

  const now = body.timestamp ? new Date(body.timestamp) : new Date();
  const workDate = toDateISO(now);

  const [premises] = body.premisesId
    ? await fastify.db
        .select()
        .from(schema.premises)
        .where(
          and(
            eq(schema.premises.id, body.premisesId),
            eq(schema.premises.organizationId, organizationId)
          )
        )
        .limit(1)
    : await fastify.db
        .select()
        .from(schema.premises)
        .where(
          and(
            eq(schema.premises.organizationId, organizationId),
            eq(schema.premises.isActive, true)
          )
        )
        .limit(1);

  const geofence = premises
    ? evaluateGeofence(
        {
          latitude: body.latitude,
          longitude: body.longitude,
          accuracyMeters: body.accuracyMeters,
          capturedAt: now,
        },
        {
          latitude: Number(premises.latitude),
          longitude: Number(premises.longitude),
          radiusMeters: Number(premises.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS),
        }
      )
    : null;

  const timezone = await resolveTimezone(fastify, organizationId);
  const [entry] = await buildSchedule(
    fastify,
    organizationId,
    profile.id,
    workDate,
    workDate,
    timezone
  );

  const [event] = await fastify.db
    .insert(schema.attendanceEvents)
    .values({
      staffProfileId: profile.id,
      shiftAssignmentId:
        (await resolveAssignmentForDate(fastify, profile.id, workDate))?.assignmentId ?? null,
      clockIn: now,
      workDate,
      status: 'SCHEDULED',
      faceVerified: false,
      geofenceVerified: geofence?.result === 'IN_PREMISES',
      premisesId: premises?.id ?? null,
      scheduledMinutes: entry?.type === 'SHIFT' ? entry.scheduledMinutes : 0,
    })
    .returning();

  const [exception] = await fastify.db
    .insert(schema.attendanceExceptions)
    .values({
      attendanceEventId: event.id,
      reason: geofence && geofence.result !== 'IN_PREMISES' ? 'OUTSIDE_GEOFENCE' : 'FACE_MISMATCH',
      status: 'OPEN',
    })
    .returning();

  const recipientIds = Array.from(
    new Set([
      ...(await listManagerUserIds(fastify, organizationId)),
      ...(await listOwnerUserIds(fastify, organizationId)),
    ])
  );

  for (const recipientId of recipientIds) {
    await createNotification(fastify, {
      organizationId,
      userId: recipientId,
      type: 'ATTENDANCE_EXCEPTION',
      title: 'Manual attendance request',
      body: `${staffName} requested a manual clock-in: ${body.reason}`,
      dedupeKey: `manual-clock-in:${event.id}:${recipientId}`,
      metadata: { attendanceEventId: event.id, exceptionId: exception.id },
    });
  }

  if (typeof fastify.publishDomainEvent === 'function') {
    await fastify.publishDomainEvent({
      type: 'exception_raised',
      organizationId,
      userIds: recipientIds,
      payload: {
        attendanceEventId: event.id,
        exceptionId: exception.id,
        staffProfileId: profile.id,
        reason: exception.reason,
      },
    });
  }

  await writeAuditLog(fastify, {
    organizationId,
    actorId: userId,
    action: 'ATTENDANCE_MANUAL_REQUESTED',
    resourceType: 'attendance_event',
    resourceId: event.id,
    metadata: { reason: body.reason, exceptionId: exception.id },
  });

  return {
    event: toPublicAttendanceEvent(event),
    exceptionId: exception.id,
    status: 'PENDING_REVIEW' as const,
  };
}

export async function clockOut(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string,
  body: { attendanceEventId?: string; timestamp?: string }
) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  let event: any = null;
  if (body.attendanceEventId) {
    [event] = await fastify.db
      .select()
      .from(schema.attendanceEvents)
      .where(eq(schema.attendanceEvents.id, body.attendanceEventId))
      .limit(1);
  } else {
    // Find latest open attendance
    const events = await fastify.db
      .select()
      .from(schema.attendanceEvents)
      .where(and(eq(schema.attendanceEvents.staffProfileId, profile.id)))
      .orderBy(schema.attendanceEvents.createdAt);
    // Find one without clockOut
    for (let i = events.length - 1; i >= 0; i--) {
      if (!events[i].clockOut) {
        event = events[i];
        break;
      }
    }
  }

  if (!event || event.staffProfileId !== profile.id) {
    throw new AppError('Active attendance event not found', 404, 'ATTENDANCE_EVENT_NOT_FOUND');
  }

  if (event.clockOut) {
    throw new AppError('Already clocked out', 409, 'ALREADY_CLOCKED_OUT');
  }

  const now = body.timestamp ? new Date(body.timestamp) : new Date();
  const workedMinutes = event.clockIn
    ? Math.max(0, Math.round((now.getTime() - new Date(event.clockIn).getTime()) / 60000))
    : 0;

  let status: (typeof schema.attendanceStatusEnum.enumValues)[number] = event.status;
  let overtimeMinutes = 0;
  let earlyDeparture = false;
  let halfDayThreshold = 0;

  if (event.overtimeId) {
    // Overtime is paid as the agreed fixed amount, not by shift status.
    status = 'PRESENT';
    overtimeMinutes = workedMinutes;
  } else {
    const timezone = await resolveTimezone(fastify, organizationId);
    const [entry] = await buildSchedule(
      fastify,
      organizationId,
      profile.id,
      String(event.workDate),
      String(event.workDate),
      timezone
    );

    if (entry?.type === 'SHIFT') {
      halfDayThreshold = entry.halfDayThresholdMinutes ?? 0;
      const scheduled = event.scheduledMinutes || entry.scheduledMinutes;

      // Half-day takes precedence over LATE for payroll purposes.
      if (halfDayThreshold > 0 && workedMinutes < halfDayThreshold) {
        status = 'HALF_DAY';
      } else if (event.status === 'LATE') {
        status = 'LATE';
      } else {
        status = 'PRESENT';
      }

      earlyDeparture = scheduled > 0 && workedMinutes < scheduled;
      overtimeMinutes = scheduled > 0 ? Math.max(0, workedMinutes - scheduled) : 0;
    }
  }

  const [updated] = await fastify.db
    .update(schema.attendanceEvents)
    .set({
      clockOut: now,
      workedMinutes,
      status,
      earlyDeparture,
      overtimeMinutes,
    })
    .where(eq(schema.attendanceEvents.id, event.id))
    .returning();

  // End monitoring session
  await fastify.db
    .update(schema.locationMonitoringSessions)
    .set({ endedAt: now, isActive: false })
    .where(
      and(
        eq(schema.locationMonitoringSessions.attendanceEventId, event.id),
        eq(schema.locationMonitoringSessions.isActive, true)
      )
    );

  // Completing an overtime entry settles the agreed payment into the wallet.
  if (event.overtimeId) {
    await completeOvertime(fastify, organizationId, event.overtimeId, workedMinutes);
  } else {
    await accrueAttendanceEarnings(
      fastify,
      organizationId,
      updated,
      profile.id,
      profile.userId
    );
  }

  await writeAuditLog(fastify, {
    organizationId,
    actorId: userId,
    action: 'ATTENDANCE_CLOCK_OUT',
    resourceType: 'attendance_event',
    resourceId: event.id,
    metadata: {
      workDate: event.workDate ? String(event.workDate) : null,
      status,
      workedMinutes,
      overtimeMinutes,
      earlyDeparture,
    },
  });

  if (typeof fastify.publishDomainEvent === 'function') {
    await fastify.publishDomainEvent({
      type: 'attendance_update',
      organizationId,
      userIds: [profile.userId],
      payload: {
        attendanceEventId: event.id,
        staffProfileId: profile.id,
        status,
        action: 'CLOCK_OUT',
      },
    });
  }

  return updated;
}

/**
 * Posts the real-time EARNED wallet accrual for a completed regular attendance
 * day. The idempotency key is derived from the attendance event so repeated
 * clock-out callbacks can never double-pay.
 */
async function accrueAttendanceEarnings(
  fastify: FastifyInstance,
  organizationId: string,
  event: typeof schema.attendanceEvents.$inferSelect,
  staffProfileId: string,
  staffUserId: string
) {
  if (!event.workDate || event.status === 'ABSENT' || event.status === 'SCHEDULED') {
    return;
  }

  const [wallet] = await fastify.db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.staffProfileId, staffProfileId))
    .limit(1);

  if (!wallet) {
    return;
  }

  let structure: Awaited<ReturnType<typeof getCurrentSalaryStructure>>;
  try {
    structure = await getCurrentSalaryStructure(
      fastify,
      staffProfileId,
      String(event.workDate)
    );
  } catch {
    // No salary configured yet - nothing to accrue. Payroll configuration is
    // managed separately and may be filled in later (retro payroll true-up).
    return;
  }

  const [shiftRules, unworkedRules] = await Promise.all([
    getShiftPaymentRules(fastify, organizationId, staffProfileId, String(event.workDate)),
    getUnworkedPaymentRules(fastify, organizationId, staffProfileId, String(event.workDate)),
  ]);

  const amountCents = calculateDailyAccrual({
    compensationType: structure.compensationType,
    baseRateCents: structure.baseRateCents,
    overtimeRateCents: structure.overtimeRateCents,
    shiftPaymentRules: shiftRules,
    unworkedPaymentRules: unworkedRules,
    status: event.status as 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT',
    workedMinutes: event.workedMinutes,
    overtimeMinutes: event.overtimeMinutes,
    periodStartDate: String(event.workDate),
  });

  if (amountCents <= 0) {
    return;
  }

  await postLedgerTransaction(fastify, {
    walletId: wallet.id,
    type: 'SALARY_ACCRUAL',
    amountCents,
    balanceBucket: 'EARNED',
    idempotencyKey: `attendance-accrual:${event.id}`,
    referenceId: event.id,
    description: `Daily salary accrual for ${String(event.workDate)}`,
  });

  if (typeof fastify.publishDomainEvent === 'function') {
    await fastify.publishDomainEvent({
      type: 'wallet_update',
      organizationId,
      userIds: [staffUserId],
      payload: { staffProfileId, amountCents, attendanceEventId: event.id },
    });
  }
}

/**
 * Closes an overtime entry and accrues the agreed payment into the staff
 * member's wallet through the append-only ledger.
 */
async function completeOvertime(
  fastify: FastifyInstance,
  organizationId: string,
  overtimeId: string,
  workedMinutes: number
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

  if (overtime.status === 'COMPLETED') {
    return;
  }

  await fastify.db
    .update(schema.overtimeRequests)
    .set({ status: 'COMPLETED', workedMinutes, resolvedAt: new Date() })
    .where(eq(schema.overtimeRequests.id, overtimeId));

  const [wallet] = await fastify.db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.staffProfileId, overtime.staffProfileId))
    .limit(1);

  if (wallet && overtime.paymentCents > 0) {
    const { postLedgerTransaction } = await import('../wallet/service.js');
    await postLedgerTransaction(fastify, {
      walletId: wallet.id,
      type: 'OVERTIME_ACCRUAL',
      amountCents: overtime.paymentCents,
      balanceBucket: 'EARNED',
      idempotencyKey: `overtime:${overtime.id}`,
      referenceId: overtime.id,
      description: `Overtime payment for ${String(overtime.workDate)}`,
    });
  }
}

export async function listExceptions(
  fastify: FastifyInstance,
  user: { userId: string; role: 'OWNER' | 'MANAGER' | 'STAFF' },
  organizationId: string
) {
  const conditions = [eq(schema.staffProfiles.organizationId, organizationId)];

  // Staff only ever see their own exceptions; Owners and Managers review the
  // whole organization (`docs/ROLE_PERMISSIONS.md` §4).
  if (user.role === 'STAFF') {
    const profile = await findStaffProfile(fastify, user.userId, organizationId);
    if (!profile) {
      return [];
    }
    conditions.push(eq(schema.attendanceEvents.staffProfileId, profile.id));
  }

  const exceptions = await fastify.db
    .select({
      exception: schema.attendanceExceptions,
      event: schema.attendanceEvents,
      staffName: schema.users.fullName,
      staffEmail: schema.users.email,
      staffCode: schema.staffProfiles.staffCode,
    })
    .from(schema.attendanceExceptions)
    .innerJoin(schema.attendanceEvents, eq(schema.attendanceEvents.id, schema.attendanceExceptions.attendanceEventId))
    .innerJoin(schema.staffProfiles, eq(schema.staffProfiles.id, schema.attendanceEvents.staffProfileId))
    .innerJoin(schema.users, eq(schema.users.id, schema.staffProfiles.userId))
    .where(and(...conditions));

  return exceptions.map((r) => ({
    id: r.exception.id,
    attendanceEventId: r.exception.attendanceEventId,
    reason: r.exception.reason,
    status: r.exception.status,
    createdAt: r.exception.createdAt,
    staffProfileId: r.event.staffProfileId,
    staffName: r.staffName,
    staffEmail: r.staffEmail,
    staffCode: r.staffCode,
  }));
}

/**
 * Lists attendance events.
 *
 * - STAFF  -> only their own events.
 * - OWNER / MANAGER -> every event of the organization, optionally narrowed to a
 *   single staff profile.
 */
export async function listAttendanceRecords(
  fastify: FastifyInstance,
  user: { userId: string; role: 'OWNER' | 'MANAGER' | 'STAFF' },
  organizationId: string,
  query: { from?: string; to?: string; staffProfileId?: string; limit?: number; offset?: number }
) {
  const conditions = [eq(schema.staffProfiles.organizationId, organizationId)];

  if (user.role === 'STAFF') {
    const profile = await findStaffProfile(fastify, user.userId, organizationId);
    if (!profile) {
      return [];
    }
    conditions.push(eq(schema.attendanceEvents.staffProfileId, profile.id));
  } else if (query.staffProfileId) {
    conditions.push(eq(schema.attendanceEvents.staffProfileId, query.staffProfileId));
  }

  if (query.from) {
    conditions.push(gte(schema.attendanceEvents.workDate, query.from));
  }
  if (query.to) {
    conditions.push(lte(schema.attendanceEvents.workDate, query.to));
  }

  const rows = await fastify.db
    .select({
      event: schema.attendanceEvents,
      staffName: schema.users.fullName,
      staffEmail: schema.users.email,
      staffCode: schema.staffProfiles.staffCode,
    })
    .from(schema.attendanceEvents)
    .innerJoin(schema.staffProfiles, eq(schema.staffProfiles.id, schema.attendanceEvents.staffProfileId))
    .innerJoin(schema.users, eq(schema.users.id, schema.staffProfiles.userId))
    .where(and(...conditions))
    .orderBy(desc(schema.attendanceEvents.workDate), desc(schema.attendanceEvents.clockIn))
    .limit(query.limit ?? 100)
    .offset(query.offset ?? 0);

  return rows.map((r) => ({
    id: r.event.id,
    staffProfileId: r.event.staffProfileId,
    staffName: r.staffName,
    staffEmail: r.staffEmail,
    staffCode: r.staffCode,
    workDate: r.event.workDate ? String(r.event.workDate) : null,
    clockIn: r.event.clockIn,
    clockOut: r.event.clockOut,
    status: r.event.status,
    faceVerified: r.event.faceVerified,
    geofenceVerified: r.event.geofenceVerified,
    workedMinutes: r.event.workedMinutes,
    overtimeMinutes: r.event.overtimeMinutes,
    scheduledMinutes: r.event.scheduledMinutes,
    premisesId: r.event.premisesId,
    overtimeId: (r.event as { overtimeId?: string | null }).overtimeId ?? null,
  }));
}

/**
 * Builds the attendance summary of a staff member for a date range.
 *
 * The summary is derived from the persisted shift schedule, the attendance
 * events, the holiday calendar and the approved leave requests - never from
 * placeholder values (`docs/SALARY_RULES.md` §2).
 */
export async function buildAttendanceSummary(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string,
  startDate: string,
  endDate: string
): Promise<schema.AttendanceSummary> {
  const timezone = await resolveTimezone(fastify, organizationId);
  const schedule = await buildSchedule(
    fastify,
    organizationId,
    staffProfileId,
    startDate,
    endDate,
    timezone
  );

  const events = await fastify.db
    .select()
    .from(schema.attendanceEvents)
    .where(
      and(
        eq(schema.attendanceEvents.staffProfileId, staffProfileId),
        gte(schema.attendanceEvents.workDate, startDate),
        lte(schema.attendanceEvents.workDate, endDate)
      )
    );

  const eventByDate = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    if (event.workDate) {
      eventByDate.set(String(event.workDate), event);
    }
  }

  const leaveRows = await fastify.db
    .select({
      status: schema.leaveRequests.status,
      workDate: schema.leaveRequests.workDate,
    })
    .from(schema.leaveRequests)
    .where(
      and(
        eq(schema.leaveRequests.staffId, staffProfileId),
        gte(schema.leaveRequests.workDate, startDate),
        lte(schema.leaveRequests.workDate, endDate)
      )
    );

  const leaveDates = new Set<string>();
  const unpaidLeaveDates = new Set<string>();
  for (const leave of leaveRows) {
    if (leave.status !== 'APPROVED') {
      continue;
    }
    const dateStr = String(leave.workDate);
    leaveDates.add(dateStr);
  }

  let presentDays = 0;
  let lateDays = 0;
  let halfDays = 0;
  let absentDays = 0;
  let holidayDays = 0;
  let weeklyOffDays = 0;
  let totalWorkedMinutes = 0;
  let totalOvertimeMinutes = 0;

  for (const entry of schedule) {
    const event = eventByDate.get(entry.date);

    if (entry.type === 'HOLIDAY' && !event && entry.isPaidHoliday) {
      // Only paid holidays are funded by the employer; unpaid holidays are
      // simply non-working days. A holiday that was worked is counted below as
      // an ordinary present day.
      holidayDays += 1;
    }

    if (entry.type === 'WEEKLY_OFF' && !event) {
      weeklyOffDays += 1;
    }

    if (event) {
      totalWorkedMinutes += event.workedMinutes ?? 0;
      totalOvertimeMinutes += event.overtimeMinutes ?? 0;

      if (event.status === 'PRESENT') {
        presentDays += 1;
      } else if (event.status === 'LATE') {
        lateDays += 1;
        presentDays += 1;
      } else if (event.status === 'HALF_DAY') {
        halfDays += 1;
      }
      continue;
    }

    // No attendance event: the day counts as absent only when the staff member
    // was actually scheduled and did not file an approved leave.
    if (entry.type === 'SHIFT' && !leaveDates.has(entry.date)) {
      absentDays += 1;
    }
  }

  const leaveDayCount = schedule.filter(
    (entry) => entry.type === 'SHIFT' && leaveDates.has(entry.date)
  ).length;
  const unpaidLeaveDayCount = schedule.filter(
    (entry) => entry.type === 'SHIFT' && unpaidLeaveDates.has(entry.date)
  ).length;
  const paidLeaveDayCount = schedule.filter(
    (entry) =>
      entry.type === 'SHIFT' &&
      leaveDates.has(entry.date) &&
      !unpaidLeaveDates.has(entry.date)
  ).length;

  return {
    totalDays: schedule.length,
    presentDays,
    lateDays,
    halfDays,
    absentDays,
    leaveDays: leaveDayCount,
    unpaidLeaveDays: unpaidLeaveDayCount,
    paidLeaveDays: paidLeaveDayCount,
    holidayDays,
    weeklyOffDays,
    totalWorkedMinutes,
    totalOvertimeMinutes,
  };
}

/**
 * Resolves an attendance exception by recording an approved correction.
 *
 * The underlying attendance event is never deleted - the correction is stored
 * in `attendance_corrections` so the audit trail stays intact
 * (`docs/ATTENDANCE_RULES.md` §5).
 */
export async function resolveException(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  exceptionId: string,
  input: {
    correctedStatus: 'PRESENT' | 'ABSENT' | 'HALF_DAY' | 'LATE' | 'HOLIDAY' | 'RESUME';
    reason: string;
    note?: string;
  }
) {
  const [exception] = await fastify.db
    .select({
      exception: schema.attendanceExceptions,
      event: schema.attendanceEvents,
    })
    .from(schema.attendanceExceptions)
    .innerJoin(
      schema.attendanceEvents,
      eq(schema.attendanceEvents.id, schema.attendanceExceptions.attendanceEventId)
    )
    .innerJoin(
      schema.staffProfiles,
      eq(schema.staffProfiles.id, schema.attendanceEvents.staffProfileId)
    )
    .where(
      and(
        eq(schema.attendanceExceptions.id, exceptionId),
        eq(schema.staffProfiles.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!exception) {
    throw new AppError('Attendance exception not found', 404, 'ATTENDANCE_EXCEPTION_NOT_FOUND');
  }

  if (exception.exception.status !== 'OPEN') {
    throw new AppError('Exception has already been resolved', 409, 'EXCEPTION_ALREADY_RESOLVED');
  }

  const targetAttendanceStatus: 'PRESENT' | 'ABSENT' | 'HALF_DAY' | 'LATE' | 'HOLIDAY' =
    input.correctedStatus === 'RESUME' ? 'PRESENT' : input.correctedStatus;

  await fastify.db.transaction(async (tx) => {
    await tx.insert(schema.attendanceCorrections).values({
      exceptionId,
      requestedBy: actorUserId,
      approvedBy: actorUserId,
      correctedStatus: targetAttendanceStatus,
      reason: input.reason,
      resolvedAt: new Date(),
    });

    await tx
      .update(schema.attendanceExceptions)
      .set({ status: 'RESOLVED' })
      .where(eq(schema.attendanceExceptions.id, exceptionId));

    await tx
      .update(schema.attendanceEvents)
      .set({ status: targetAttendanceStatus })
      .where(eq(schema.attendanceEvents.id, exception.event.id));

    if (input.correctedStatus === 'ABSENT' || input.correctedStatus === 'HOLIDAY') {
      // Close location monitoring session
      await tx
        .update(schema.locationMonitoringSessions)
        .set({ isActive: false })
        .where(eq(schema.locationMonitoringSessions.attendanceEventId, exception.event.id));
    } else {
      // Reset consecutive failures so location monitoring resumes clean
      await tx
        .update(schema.locationMonitoringSessions)
        .set({ consecutiveFailures: 0, isActive: true })
        .where(eq(schema.locationMonitoringSessions.attendanceEventId, exception.event.id));
    }
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'ATTENDANCE_EXCEPTION_RESOLVED',
    resourceType: 'attendanceException',
    resourceId: exceptionId,
    metadata: { correctedStatus: input.correctedStatus, note: input.note ?? null },
  });

  return { id: exceptionId, status: 'RESOLVED' as const, correctedStatus: input.correctedStatus };
}

export async function getDailyAttendanceByDateAndPremises(
  fastify: FastifyInstance,
  organizationId: string,
  workDate: string,
  premisesId?: string
) {
  const conditions = [
    eq(schema.dailyAttendance.organisationId, organizationId),
    eq(schema.dailyAttendance.workDate, workDate),
  ];
  if (premisesId) {
    conditions.push(eq(schema.dailyAttendance.premisesId, premisesId));
  }

  const rows = await fastify.db
    .select({
      id: schema.dailyAttendance.id,
      organisationId: schema.dailyAttendance.organisationId,
      premisesId: schema.dailyAttendance.premisesId,
      staffId: schema.dailyAttendance.staffId,
      shiftAssignmentId: schema.dailyAttendance.shiftAssignmentId,
      workDate: schema.dailyAttendance.workDate,
      attendanceStatus: schema.dailyAttendance.attendanceStatus,
      clockInAt: schema.dailyAttendance.clockInAt,
      clockOutAt: schema.dailyAttendance.clockOutAt,
      insidePingCount: schema.dailyAttendance.insidePingCount,
      outsidePingCount: schema.dailyAttendance.outsidePingCount,
      paymentAmount: schema.dailyAttendance.paymentAmount,
      statusUpdatedBy: schema.dailyAttendance.statusUpdatedBy,
      remarks: schema.dailyAttendance.remarks,
      staffName: schema.users.fullName,
      staffCode: schema.staffProfiles.staffCode,
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      halfDayThreshold: schema.shifts.halfDayThreshold,
    })
    .from(schema.dailyAttendance)
    .innerJoin(schema.staffProfiles, eq(schema.staffProfiles.id, schema.dailyAttendance.staffId))
    .innerJoin(schema.users, eq(schema.users.id, schema.staffProfiles.userId))
    .innerJoin(
      schema.employeeShiftAssignments,
      eq(schema.employeeShiftAssignments.id, schema.dailyAttendance.shiftAssignmentId)
    )
    .innerJoin(schema.shifts, eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId))
    .where(and(...conditions))
    .orderBy(desc(schema.dailyAttendance.createdAt));

  return rows;
}

export async function correctDailyAttendance(
  fastify: FastifyInstance,
  actorUserId: string,
  organizationId: string,
  dailyAttendanceId: string,
  input: {
    attendanceStatus: 'PRESENT' | 'ABSENT' | 'LEAVE' | 'HALF_DAY';
    remarks?: string;
    overridePaymentAmount?: number;
  }
) {
  const [record] = await fastify.db
    .select()
    .from(schema.dailyAttendance)
    .where(
      and(
        eq(schema.dailyAttendance.id, dailyAttendanceId),
        eq(schema.dailyAttendance.organisationId, organizationId)
      )
    )
    .limit(1);

  if (!record) {
    throw new AppError('Daily attendance record not found', 404, 'ATTENDANCE_NOT_FOUND');
  }

  const [assignment] = await fastify.db
    .select()
    .from(schema.employeeShiftAssignments)
    .where(eq(schema.employeeShiftAssignments.id, record.shiftAssignmentId))
    .limit(1);

  let newPayment = 0;
  if (input.overridePaymentAmount !== undefined) {
    newPayment = input.overridePaymentAmount;
  } else if (assignment) {
    switch (input.attendanceStatus) {
      case 'PRESENT':
        newPayment = Number(assignment.presentPay);
        break;
      case 'ABSENT':
        newPayment = Number(assignment.absentPay);
        break;
      case 'LEAVE':
        newPayment = Number(assignment.leavePay);
        break;
      case 'HALF_DAY':
        newPayment = Number(assignment.halfDayPay);
        break;
    }
  }

  const updated = await fastify.db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.dailyAttendance)
      .set({
        attendanceStatus: input.attendanceStatus,
        paymentAmount: String(newPayment),
        statusUpdatedBy: actorUserId,
        remarks: input.remarks ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.dailyAttendance.id, dailyAttendanceId))
      .returning();

    return row;
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'DAILY_ATTENDANCE_CORRECTED',
    resourceType: 'daily_attendance',
    resourceId: dailyAttendanceId,
    metadata: { status: input.attendanceStatus, paymentAmount: newPayment, remarks: input.remarks },
  });

  return updated;
}

export async function getEmployeeAttendanceAndEarningsHistory(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string,
  from?: string,
  to?: string
) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    return [];
  }

  const conditions = [
    eq(schema.dailyAttendance.organisationId, organizationId),
    eq(schema.dailyAttendance.staffId, profile.id),
  ];
  if (from) conditions.push(gte(schema.dailyAttendance.workDate, from));
  if (to) conditions.push(lte(schema.dailyAttendance.workDate, to));

  const rows = await fastify.db
    .select({
      id: schema.dailyAttendance.id,
      workDate: schema.dailyAttendance.workDate,
      attendanceStatus: schema.dailyAttendance.attendanceStatus,
      clockInAt: schema.dailyAttendance.clockInAt,
      clockOutAt: schema.dailyAttendance.clockOutAt,
      paymentAmount: schema.dailyAttendance.paymentAmount,
      insidePingCount: schema.dailyAttendance.insidePingCount,
      outsidePingCount: schema.dailyAttendance.outsidePingCount,
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
    })
    .from(schema.dailyAttendance)
    .innerJoin(
      schema.employeeShiftAssignments,
      eq(schema.employeeShiftAssignments.id, schema.dailyAttendance.shiftAssignmentId)
    )
    .innerJoin(schema.shifts, eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId))
    .where(and(...conditions))
    .orderBy(desc(schema.dailyAttendance.workDate));

  return rows;
}
