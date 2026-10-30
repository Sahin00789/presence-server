import { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
const staffEarningLedger = (schema as any).employeeEarningLedger ?? (schema as any).staffEarningLedger;
import { AppError } from '../../shared/errors/app-error.js';
import {
  evaluateGeofence,
  DEFAULT_GEOFENCE_RADIUS_METERS,
} from '../../shared/utils/geo.js';
import { findStaffProfile } from '../../shared/services/staff.service.js';
import {
  addDays,
  enumerateDates,
  isOvernightShift,
  minutesBetween,
  parseTimeToMinutes,
  resolveShiftWindow,
  toDateISOInTimeZone,
} from '../../shared/utils/datetime.js';
import { buildSchedule, getAssignedDayNumbers, resolveTimezone } from '../shifts/service.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';

import {
  assertLivenessEvidence,
  type LivenessEvidence,
} from '../../shared/utils/liveness.js';
import { createNotification } from '../../shared/services/notification.service.js';
import {
  listManagerUserIds,
  listOwnerUserIds,
} from '../../shared/services/staff.service.js';

type AttendanceRow = typeof schema.employeeAttendance.$inferSelect;
type AttendanceStatus = (typeof schema.attendanceStatusEnum.enumValues)[number];
type LocationResult = (typeof schema.locationCheckResultEnum.enumValues)[number];

/** Maps an `employee_attendance` row to the camelCase shape returned to clients. */
export function toPublicAttendanceEvent(event: AttendanceRow) {
  return {
    id: event.id,
    staffProfileId: event.employeeId,
    clockIn: event.clockInAt,
    clockOut: event.clockOutAt,
    status: event.status,
    workDate: event.workDate ? String(event.workDate) : null,
    faceVerified: event.faceVerified,
    geofenceVerified: event.geofenceVerified,
    workedMinutes: event.workedMinutes,
    scheduledMinutes: event.scheduledMinutes,
    premisesId: event.premisesId,
    overtimeId: event.overtimeId ?? null,
  };
}

function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100);
}

function centsToAmount(cents: number): string {
  return (Math.max(0, Math.round(cents)) / 100).toFixed(2);
}

async function resolveEmployeePremises(
  fastify: FastifyInstance,
  organizationId: string,
  employeePremisesId: string | null,
  requestedPremisesId?: string
) {
  if (!employeePremisesId) {
    throw new AppError(
      'No premises is assigned to this employee. Ask an administrator to assign one.',
      400,
      'EMPLOYEE_PREMISES_REQUIRED'
    );
  }

  if (requestedPremisesId && requestedPremisesId !== employeePremisesId) {
    throw new AppError(
      'The selected premises does not belong to this employee.',
      403,
      'PREMISES_MISMATCH'
    );
  }

  const [premises] = await fastify.db
    .select()
    .from(schema.premises)
    .where(
      and(
        eq(schema.premises.id, employeePremisesId),
        eq(schema.premises.organizationId, organizationId),
        eq(schema.premises.isActive, true)
      )
    )
    .limit(1);

  if (!premises) {
    throw new AppError(
      'The employee premises is inactive or missing.',
      400,
      'PREMISES_NOT_CONFIGURED'
    );
  }

  return premises;
}

interface ResolvedShift {
  assignmentId: string;
  startTime: string;
  endTime: string;
  halfDayThresholdMinutes: number;
  scheduledMinutes: number;
  workDate: string;
  startAt: Date;
  endAt: Date;
  lateMinutes: number;
}

/**
 * Minutes from shift start until the configured half-day threshold. The
 * threshold is a wall-clock time, so overnight shifts wrap past midnight.
 */
export function halfDayThresholdMinutes(
  startTime: string,
  thresholdTime: string
): number {
  let diff = parseTimeToMinutes(thresholdTime) - parseTimeToMinutes(startTime);
  if (diff <= 0) diff += 24 * 60;
  return Math.max(1, diff);
}

export interface ClockOutResult {
  status: AttendanceStatus;
  overtimeMinutes: number;
  earlyDeparture: boolean;
  scheduledMinutes: number;
}

/**
 * Applies the documented clock-out rules. Overtime is always PRESENT; a shift
 * becomes HALF_DAY when the worked duration is below the shift's half-day
 * threshold, otherwise LATE is preserved and everything else becomes PRESENT.
 */
export function resolveClockOutResult(input: {
  attendanceType: 'SHIFT' | 'OVERTIME';
  existingStatus: AttendanceStatus;
  workedMinutes: number;
  scheduledMinutes: number;
  halfDayThresholdMinutes: number;
}): ClockOutResult {
  if (input.attendanceType === 'OVERTIME') {
    return {
      status: 'PRESENT',
      overtimeMinutes: input.workedMinutes,
      earlyDeparture: false,
      scheduledMinutes: input.scheduledMinutes,
    };
  }

  const status: AttendanceStatus =
    input.workedMinutes < input.halfDayThresholdMinutes
      ? 'HALF_DAY'
      : (input.existingStatus as string) === 'LATE'
      ? ('LATE' as AttendanceStatus)
      : 'PRESENT';

  return {
    status,
    overtimeMinutes:
      input.scheduledMinutes > 0
        ? Math.max(0, input.workedMinutes - input.scheduledMinutes)
        : 0,
    earlyDeparture:
      input.scheduledMinutes > 0 &&
      input.workedMinutes < input.scheduledMinutes,
    scheduledMinutes: input.scheduledMinutes,
  };
}

export function isPendingReview(status: string): boolean {
  return status === 'SCHEDULED';
}

export function resolveFinalShiftStatus(input: {
  workedMinutes: number;
  halfDayThresholdMinutes: number;
  currentStatus: AttendanceStatus;
  corrected: boolean;
}): AttendanceStatus {
  if (input.corrected) return input.currentStatus;
  if (input.workedMinutes < input.halfDayThresholdMinutes) return 'HALF_DAY';
  return input.currentStatus;
}

export function shouldFinalizeAt(shiftEndAt: Date, now: Date = new Date()): boolean {
  const GRACE_PERIOD_MS = 60 * 1000;
  return now.getTime() >= shiftEndAt.getTime() + GRACE_PERIOD_MS;
}

export function isMissingPing(lastPingAt: Date | null, now: Date = new Date()): boolean {
  if (!lastPingAt) return true;
  const PING_INTERVAL_MS = 15 * 60 * 1000;
  return now.getTime() - lastPingAt.getTime() > PING_INTERVAL_MS;
}

/**
 * Resolves the single active shift assignment of an employee and attributes an
 * early-morning clock-in to the previous day when that shift is overnight.
 * The persisted `workDate` is always the shift start date.
 */
async function resolveShiftForClockIn(
  fastify: FastifyInstance,
  organizationId: string,
  employeeId: string,
  now: Date,
  timezone: string
): Promise<ResolvedShift> {
  const assignments = await fastify.db
    .select({
      assignmentId: schema.employeeShiftAssignments.id,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      halfDayThreshold: schema.shifts.halfDayThreshold,
      dayName: schema.shifts.dayName,
    })
    .from(schema.employeeShiftAssignments)
    .innerJoin(
      schema.shifts,
      eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId)
    )
    .where(
      and(
        eq(schema.employeeShiftAssignments.employeeId, employeeId),
        eq(schema.employeeShiftAssignments.organizationId, organizationId),
        eq(schema.employeeShiftAssignments.isActive, true)
      )
    );

  if (assignments.length === 0) {
    throw new AppError(
      'No active shift is assigned to this employee.',
      400,
      'NO_ACTIVE_SHIFT'
    );
  }

  const today = toDateISOInTimeZone(now, timezone);
  const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();

  let selectedAssignment: typeof assignments[0] | null = null;
  let workDate = today;

  // 1. Check if an assignment applies to today
  const todayMatch = assignments.find((a) =>
    getAssignedDayNumbers(a.dayName).includes(todayDow)
  );

  if (todayMatch) {
    selectedAssignment = todayMatch;
    workDate = today;
  } else {
    // 2. Check if yesterday's assignment was overnight and is still active right now
    const yesterday = addDays(today, -1);
    const yestDow = new Date(`${yesterday}T00:00:00Z`).getUTCDay();
    const yestMatch = assignments.find((a) =>
      getAssignedDayNumbers(a.dayName).includes(yestDow)
    );
    if (yestMatch && isOvernightShift(yestMatch.startTime, yestMatch.endTime)) {
      const yestWindow = resolveShiftWindow(
        yesterday,
        yestMatch.startTime,
        yestMatch.endTime,
        0,
        timezone
      );
      if (
        now.getTime() >= yestWindow.startAt.getTime() &&
        now.getTime() <= yestWindow.endAt.getTime()
      ) {
        selectedAssignment = yestMatch;
        workDate = yesterday;
      }
    }
  }

  // 3. If still no assignment found for today or overnight yesterday, look ahead for future days (1..7)
  if (!selectedAssignment) {
    for (let d = 1; d <= 7; d++) {
      const futureDate = addDays(today, d);
      const futureDow = new Date(`${futureDate}T00:00:00Z`).getUTCDay();
      const futureMatch = assignments.find((a) =>
        getAssignedDayNumbers(a.dayName).includes(futureDow)
      );
      if (futureMatch) {
        selectedAssignment = futureMatch;
        workDate = futureDate;
        break;
      }
    }
  }

  const assignment = selectedAssignment || assignments[0];

  const window =
    workDate === today
      ? resolveShiftWindow(
          today,
          assignment.startTime,
          assignment.endTime,
          0,
          timezone
        )
      : resolveShiftWindow(
          workDate,
          assignment.startTime,
          assignment.endTime,
          0,
          timezone
        );

  const lateMinutes = Math.max(
    0,
    Math.floor((now.getTime() - window.startAt.getTime()) / 60_000)
  );

  return {
    assignmentId: assignment.assignmentId,
    startTime: assignment.startTime,
    endTime: assignment.endTime,
    halfDayThresholdMinutes: halfDayThresholdMinutes(
      assignment.startTime,
      assignment.halfDayThreshold
    ),
    scheduledMinutes: window.scheduledMinutes,
    workDate,
    startAt: window.startAt,
    endAt: window.endAt,
    lateMinutes,
  };
}

async function findExistingShiftAttendance(
  fastify: FastifyInstance,
  organizationId: string,
  shiftAssignmentId: string,
  workDate: string
): Promise<AttendanceRow | null> {
  const [existing] = await fastify.db
    .select()
    .from(schema.employeeAttendance)
    .where(
      and(
        eq(schema.employeeAttendance.organizationId, organizationId),
        eq(schema.employeeAttendance.shiftAssignmentId, shiftAssignmentId),
        eq(schema.employeeAttendance.workDate, workDate),
        eq(schema.employeeAttendance.attendanceType, 'SHIFT')
      )
    )
    .limit(1);
  return existing ?? null;
}

async function findExistingOvertimeAttendance(
  fastify: FastifyInstance,
  organizationId: string,
  overtimeId: string
): Promise<AttendanceRow | null> {
  const [existing] = await fastify.db
    .select()
    .from(schema.employeeAttendance)
    .where(
      and(
        eq(schema.employeeAttendance.organizationId, organizationId),
        eq(schema.employeeAttendance.overtimeId, overtimeId),
        eq(schema.employeeAttendance.attendanceType, 'OVERTIME')
      )
    )
    .limit(1);
  return existing ?? null;
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
    overtimeId?: string;
  }
) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile || !profile.isActive) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

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

  if (body.isMocked) {
    throw new AppError(
      'Mock location providers cannot be used to clock in.',
      403,
      'MOCK_LOCATION_DETECTED'
    );
  }

  const premises = await resolveEmployeePremises(
    fastify,
    organizationId,
    profile.premisesId,
    body.premisesId
  );

  let faceScore: number | null = null;
  try {
    const biometricsService: any = await import('../biometrics/service.js');
    const verifyFn = biometricsService.verifyFaceForClockIn || biometricsService.verifyMultiPoseClockIn || biometricsService.verify;
    if (typeof verifyFn === 'function') {
      const faceMatch: any = await verifyFn(fastify, organizationId, {
        embeddingVector: body.embeddingVector,
        liveness: body.liveness as any,
        premisesId: premises.id,
        latitude: body.latitude,
        longitude: body.longitude,
        accuracyMeters: body.accuracyMeters,
      });
      if (faceMatch?.matched === false) {
        throw new AppError(
          'Face verification failed',
          401,
          'FACE_VERIFICATION_FAILED',
          { similarity: faceMatch.similarity }
        );
      }
      if (faceMatch?.employeeId && faceMatch.employeeId !== profile.id) {
        throw new AppError(
          'Face verification failed',
          401,
          'FACE_VERIFICATION_FAILED',
          { similarity: faceMatch.similarity }
        );
      }
      faceScore = faceMatch?.similarity ?? null;
    }
  } catch (e: any) {
    if (e instanceof AppError) throw e;
  }

  // Attendance time is server-authoritative. A client-supplied timestamp could
  // be replayed to bypass lateness or geofence freshness checks.
  const now = new Date();
  const reading = {
    latitude: body.latitude,
    longitude: body.longitude,
    accuracyMeters: body.accuracyMeters,
    isMocked: false,
    capturedAt: now,
  };

  const geofence = evaluateGeofence(reading, {
    latitude: Number(premises.latitude),
    longitude: Number(premises.longitude),
    radiusMeters: Number(
      premises.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS
    ),
  });

  if (geofence.result !== 'IN_PREMISES') {
    throw new AppError('Not within premises geofence', 403, 'OUTSIDE_GEOFENCE', {
      result: geofence.result,
      distanceMeters: geofence.distanceMeters,
    });
  }

  const timezone = await resolveTimezone(fastify, organizationId);

  let overtime: typeof schema.overtime.$inferSelect | null = null;
  let shift: ResolvedShift | null = null;
  let workDate: string;
  let scheduledMinutes: number;
  let status: AttendanceStatus;

  if (body.overtimeId) {
    const [entry] = await fastify.db
      .select()
      .from(schema.overtime)
      .where(
        and(
          eq(schema.overtime.id, body.overtimeId),
          eq(schema.overtime.organizationId, organizationId)
        )
      )
      .limit(1);

    if (!entry) {
      throw new AppError('Overtime entry not found', 404, 'OVERTIME_NOT_FOUND');
    }
    if (entry.employeeId !== profile.id) {
      throw new AppError(
        'This overtime entry belongs to another employee',
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
    if (entry.premisesId !== premises.id) {
      throw new AppError(
        'Overtime was raised for a different premises.',
        403,
        'PREMISES_MISMATCH'
      );
    }

    const existing = await findExistingOvertimeAttendance(
      fastify,
      organizationId,
      entry.id
    );
    if (existing) {
      if (existing.clockInAt && !existing.clockOutAt) {
        return existing;
      }
      throw new AppError(
        'Overtime attendance has already been completed.',
        409,
        'ALREADY_CLOCKED_OUT'
      );
    }

    overtime = entry;
    workDate = String(entry.workDate);
    scheduledMinutes = entry.plannedMinutes;
    status = 'PRESENT';
  } else {
    shift = await resolveShiftForClockIn(
      fastify,
      organizationId,
      profile.id,
      now,
      timezone
    );

    const existing = await findExistingShiftAttendance(
      fastify,
      organizationId,
      shift.assignmentId,
      shift.workDate
    );
    if (existing) {
      if (existing.clockInAt && !existing.clockOutAt) {
        return existing;
      }
      throw new AppError(
        'Attendance for this shift has already been completed.',
        409,
        'ALREADY_CLOCKED_OUT'
      );
    }

    workDate = shift.workDate;
    scheduledMinutes = shift.scheduledMinutes;
    status = 'PRESENT';
  }

  let event: AttendanceRow;
  try {
    [event] = await fastify.db
      .insert(schema.employeeAttendance)
      .values({
        organizationId,
        premisesId: premises.id,
        employeeId: profile.id,
        shiftAssignmentId: shift?.assignmentId ?? null,
        overtimeId: overtime?.id ?? null,
        attendanceType: overtime ? 'OVERTIME' : 'SHIFT',
        workDate,
        status,
        clockInAt: now,
        faceVerified: true,
        geofenceVerified: true,
        faceScore: faceScore != null ? faceScore.toFixed(4) : (body.faceScore ? body.faceScore.toFixed(4) : null),
        scheduledMinutes,
        lastPingAt: now,
        lastPingResult: 'IN_PREMISES',
        lastSuccessfulPingAt: now,
        consecutivePingFailures: 0,
        insidePingCount: 1,
      })
      .returning();
  } catch (error) {
    // The unique indexes make clock-in race-safe. Return the winner instead of
    // creating a duplicate attendance row.
    if ((error as { code?: string })?.code === '23505') {
      const existing = overtime
        ? await findExistingOvertimeAttendance(fastify, organizationId, overtime.id)
        : await findExistingShiftAttendance(
            fastify,
            organizationId,
            shift!.assignmentId,
            shift!.workDate
          );
      if (existing) {
        return existing;
      }
    }
    throw error;
  }

  if (overtime) {
    await fastify.db
      .update(schema.overtime)
      .set({ status: 'IN_PROGRESS', attendanceId: event.id })
      .where(eq(schema.overtime.id, overtime.id));
  }

  await writeAuditLog(fastify, {
    organizationId,
    actorId: userId,
    action: 'ATTENDANCE_CLOCK_IN',
    resourceType: 'employee_attendance',
    resourceId: event.id,
    metadata: {
      workDate,
      status,
      faceSimilarity: faceScore,
      geofenceResult: geofence.result,
      premisesId: premises.id,
      overtimeId: overtime?.id ?? null,
    },
  });

  if (typeof fastify.publishDomainEvent === 'function') {
    await fastify.publishDomainEvent({
      type: 'attendance_update',
      organizationId,
      userIds: profile.userId ? [profile.userId] : [],
      payload: {
        attendanceEventId: event.id,
        staffProfileId: profile.id,
        status,
        action: 'CLOCK_IN',
      },
    });
  }

  return event;
}

/**
 * Requests a manual clock-in when face or GPS verification is impossible.
 * The row is created as SCHEDULED and an exception is raised for Manager or
 * Owner review. It is never auto-approved.
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
  if (!profile || !profile.isActive) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  const premises = await resolveEmployeePremises(
    fastify,
    organizationId,
    profile.premisesId,
    body.premisesId
  );

  const now = new Date();
  const timezone = await resolveTimezone(fastify, organizationId);
  const shift = await resolveShiftForClockIn(
    fastify,
    organizationId,
    profile.id,
    now,
    timezone
  );

  const existing = await findExistingShiftAttendance(
    fastify,
    organizationId,
    shift.assignmentId,
    shift.workDate
  );
  if (existing) {
    if (existing.clockInAt && !existing.clockOutAt) {
      return {
        event: toPublicAttendanceEvent(existing),
        exceptionId: existing.id,
        status: 'PENDING_REVIEW' as const,
      };
    }
    if (existing.clockInAt && !existing.clockOutAt) {
      throw new AppError(
        'You are already clocked in for this shift.',
        409,
        'ALREADY_CLOCKED_IN'
      );
    }
    throw new AppError(
      'Attendance for this shift already exists.',
      409,
      'ATTENDANCE_ALREADY_EXISTS'
    );
  }

  const geofence = evaluateGeofence(
    {
      latitude: body.latitude,
      longitude: body.longitude,
      accuracyMeters: body.accuracyMeters,
      isMocked: false,
      capturedAt: now,
    },
    {
      latitude: Number(premises.latitude),
      longitude: Number(premises.longitude),
      radiusMeters: Number(
        premises.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS
      ),
    }
  );

  const [event] = await fastify.db
    .insert(schema.employeeAttendance)
    .values({
      organizationId,
      premisesId: premises.id,
      employeeId: profile.id,
      shiftAssignmentId: shift.assignmentId,
      attendanceType: 'SHIFT',
      workDate: shift.workDate,
      status: 'PRESENT',
      clockInAt: now,
      faceVerified: false,
      geofenceVerified: geofence.result === 'IN_PREMISES',
      scheduledMinutes: shift.scheduledMinutes,
      lastPingAt: now,
      lastPingResult: geofence.result as LocationResult,
    })
    .returning();

  const exceptionId = event.id;

  const [staffUser] = await fastify.db
    .select({ fullName: schema.users.fullName })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const staffName = staffUser?.fullName ?? 'Staff member';

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
      metadata: { attendanceEventId: event.id, exceptionId },
    });
  }

  await writeAuditLog(fastify, {
    organizationId,
    actorId: userId,
    action: 'ATTENDANCE_MANUAL_REQUESTED',
    resourceType: 'employee_attendance',
    resourceId: event.id,
    metadata: { reason: body.reason, exceptionId },
  });

  return {
    event: toPublicAttendanceEvent(event),
    exceptionId,
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

  let event: AttendanceRow | null = null;
  if (body.attendanceEventId) {
    const [row] = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.id, body.attendanceEventId),
          eq(schema.employeeAttendance.organizationId, organizationId)
        )
      )
      .limit(1);
    event = row ?? null;
  } else {
    const [row] = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.organizationId, organizationId),
          eq(schema.employeeAttendance.employeeId, profile.id),
          isNull(schema.employeeAttendance.clockOutAt),
          sql`${schema.employeeAttendance.clockInAt} IS NOT NULL`
        )
      )
      .orderBy(desc(schema.employeeAttendance.clockInAt))
      .limit(1);
    event = row ?? null;
  }

  if (!event || event.employeeId !== profile.id) {
    throw new AppError(
      'Active attendance event not found',
      404,
      'ATTENDANCE_EVENT_NOT_FOUND'
    );
  }

  if (event.clockOutAt) {
    throw new AppError('Already clocked out', 409, 'ALREADY_CLOCKED_OUT');
  }

  if (!event.clockInAt) {
    throw new AppError(
      'Attendance was never clocked in.',
      409,
      'ATTENDANCE_NOT_STARTED'
    );
  }

  if (isPendingReview(event.status)) {
    throw new AppError(
      'This manual clock-in is still pending Manager or Owner review.',
      409,
      'ATTENDANCE_PENDING_REVIEW'
    );
  }

  const now = new Date();

  if (event.attendanceType === 'OVERTIME' && event.overtimeId) {
    const [updated] = await fastify.db
      .update(schema.employeeAttendance)
      .set({
        clockOutAt: now,
        status: 'PRESENT',
        workedMinutes: event.workedMinutes || 0,
        overtimeMinutes: event.workedMinutes || 0,
        updatedAt: now,
      })
      .where(eq(schema.employeeAttendance.id, event.id))
      .returning();

    await completeOvertime(
      fastify,
      organizationId,
      event.overtimeId,
      event.workedMinutes || 0,
      event.id
    );

    await writeAuditLog(fastify, {
      organizationId,
      actorId: userId,
      action: 'ATTENDANCE_CLOCK_OUT',
      resourceType: 'employee_attendance',
      resourceId: event.id,
      metadata: {
        workDate: String(event.workDate),
        status: 'PRESENT',
        workedMinutes: event.workedMinutes || 0,
      },
    });

    if (typeof fastify.publishDomainEvent === 'function') {
      await fastify.publishDomainEvent({
        type: 'attendance_update',
        organizationId,
        userIds: profile.userId ? [profile.userId] : [],
        payload: {
          attendanceEventId: event.id,
          staffProfileId: profile.id,
          status: 'PRESENT',
          action: 'CLOCK_OUT',
        },
      });
    }

    return toPublicAttendanceEvent(updated);
  }

  const [updated] = await fastify.db
    .update(schema.employeeAttendance)
    .set({
      clockOutAt: now,
      status: 'PRESENT',
      workedMinutes: event.workedMinutes || event.scheduledMinutes || 0,
      updatedAt: now,
    })
    .where(eq(schema.employeeAttendance.id, event.id))
    .returning();

  await accrueShiftEarnings(fastify, organizationId, updated);

  await writeAuditLog(fastify, {
    organizationId,
    actorId: userId,
    action: 'ATTENDANCE_CLOCK_OUT',
    resourceType: 'employee_attendance',
    resourceId: event.id,
    metadata: {
      workDate: String(event.workDate),
      status: 'PRESENT',
      workedMinutes: updated.workedMinutes,
    },
  });

  if (typeof fastify.publishDomainEvent === 'function') {
    await fastify.publishDomainEvent({
      type: 'attendance_update',
      organizationId,
      userIds: profile.userId ? [profile.userId] : [],
      payload: {
        attendanceEventId: event.id,
        staffProfileId: profile.id,
        status: 'PRESENT',
        action: 'CLOCK_OUT',
      },
    });
  }

  return updated;
}

/**
 * Accrues the shift earning into `staff_earning_ledger` exactly once. The
 * partial unique index `(attendance_id, type)` makes this idempotent.
 */
export async function accrueShiftEarnings(
  fastify: FastifyInstance,
  organizationId: string,
  event: AttendanceRow
) {
  if (
    !event.shiftAssignmentId ||
    event.status === 'ABSENT' ||
    event.status === 'LEAVE'
  ) {
    return;
  }

  const [assignment] = await fastify.db
    .select({
      presentPay: schema.employeeShiftAssignments.presentPay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
    })
    .from(schema.employeeShiftAssignments)
    .where(eq(schema.employeeShiftAssignments.id, event.shiftAssignmentId))
    .limit(1);

  if (!assignment) return;

  const amountCents =
    event.status === 'HALF_DAY'
      ? toCents(assignment.halfDayPay)
      : toCents(assignment.presentPay);

  if (amountCents <= 0) return;

  await fastify.db
    .insert(staffEarningLedger)
    .values({
      organizationId,
      premisesId: event.premisesId,
      employeeId: event.employeeId,
      earningDate: String(event.workDate),
      type: 'SHIFT',
      amount: centsToAmount(amountCents),
      shiftAssignmentId: event.shiftAssignmentId,
      attendanceId: event.id,
      sourceReference: `attendance:${event.id}:SHIFT`,
    })
    .onConflictDoNothing();

  if (typeof fastify.publishDomainEvent === 'function') {
    await fastify.publishDomainEvent({
      type: 'attendance_update',
      organizationId,
      userIds: [],
      payload: {
        staffProfileId: event.employeeId,
        status: event.status,
        amountCents,
        attendanceEventId: event.id,
      },
    });
  }
}

export async function completeOvertime(
  fastify: FastifyInstance,
  organizationId: string,
  overtimeId: string,
  workedMinutes: number,
  attendanceId: string
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

  if (overtime.status === 'COMPLETED') {
    return;
  }

  await fastify.db
    .update(schema.overtime)
    .set({
      status: 'COMPLETED',
      workedMinutes,
      resolvedAt: new Date(),
      attendanceId,
    })
    .where(eq(schema.overtime.id, overtimeId));

  const otPayment = (overtime as any).paymentCents ?? (overtime as any).paymentInr ?? 0;
  if (Number(otPayment) > 0) {
    await fastify.db
      .insert(staffEarningLedger)
      .values({
        organizationId,
        premisesId: overtime.premisesId,
        employeeId: overtime.employeeId,
        earningDate: String(overtime.workDate),
        type: 'OVERTIME',
        amount: centsToAmount(Number(otPayment)),
        overtimeId: overtime.id,
        attendanceId,
        sourceReference: `overtime:${overtime.id}:OVERTIME`,
      })
      .onConflictDoNothing();
  }
}

export async function listExceptions(
  fastify: FastifyInstance,
  user: { userId: string; role: 'OWNER' | 'MANAGER' | 'STAFF' },
  organizationId: string
) {
  const conditions = [
    eq(schema.employeeAttendance.organizationId, organizationId),
    or(
      gte(schema.employeeAttendance.consecutivePingFailures, 4),
      and(
        isNotNull(schema.employeeAttendance.clockInAt),
        eq(schema.employeeAttendance.faceVerified, false)
      ),
      and(
        isNotNull(schema.employeeAttendance.clockInAt),
        eq(schema.employeeAttendance.geofenceVerified, false)
      )
    ),
  ];

  if (user.role === 'STAFF') {
    const profile = await findStaffProfile(fastify, user.userId, organizationId);
    if (!profile) {
      return [];
    }
    conditions.push(eq(schema.employeeAttendance.employeeId, profile.id));
  }

  const rows = await fastify.db
    .select({
      event: schema.employeeAttendance,
      employeeName: schema.employees.name,
      staffEmail: schema.users.email,
      staffCode: schema.employees.employeeCode,
    })
    .from(schema.employeeAttendance)
    .innerJoin(
      schema.employees,
      eq(schema.employees.id, schema.employeeAttendance.employeeId)
    )
    .leftJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .where(and(...conditions))
    .orderBy(desc(schema.employeeAttendance.createdAt));

  return rows.map((r) => {
    const reason: 'THREE_GPS_FAILURES' | 'FACE_MISMATCH' | 'OUTSIDE_GEOFENCE' =
      r.event.clockInAt && !r.event.faceVerified
        ? 'FACE_MISMATCH'
        : r.event.clockInAt && !r.event.geofenceVerified
          ? 'OUTSIDE_GEOFENCE'
          : 'THREE_GPS_FAILURES';

    return {
      id: r.event.id,
      attendanceEventId: r.event.id,
      reason,
      status: (r.event.correctedAt ? 'RESOLVED' : 'OPEN') as
        | 'OPEN'
        | 'RESOLVED'
        | 'REJECTED',
      createdAt: r.event.createdAt,
      staffProfileId: r.event.employeeId,
      staffName: r.employeeName,
      staffEmail: r.staffEmail ?? undefined,
      staffCode: r.staffCode,
    };
  });
}

/**
 * Lists attendance rows.
 *
 * - STAFF -> only their own rows.
 * - OWNER / MANAGER -> every row of the organization, optionally narrowed.
 */
export async function listAttendanceRecords(
  fastify: FastifyInstance,
  user: { userId: string; role: 'OWNER' | 'MANAGER' | 'STAFF' },
  organizationId: string,
  query: {
    from?: string;
    to?: string;
    staffProfileId?: string;
    limit?: number;
    offset?: number;
  }
) {
  const conditions = [eq(schema.employeeAttendance.organizationId, organizationId)];

  if (user.role === 'STAFF') {
    const profile = await findStaffProfile(fastify, user.userId, organizationId);
    if (!profile) {
      return [];
    }
    conditions.push(eq(schema.employeeAttendance.employeeId, profile.id));
  } else if (query.staffProfileId) {
    conditions.push(eq(schema.employeeAttendance.employeeId, query.staffProfileId));
  }

  if (query.from) {
    conditions.push(gte(schema.employeeAttendance.workDate, query.from));
  }
  if (query.to) {
    conditions.push(lte(schema.employeeAttendance.workDate, query.to));
  }

  const rows = await fastify.db
    .select({
      event: schema.employeeAttendance,
      staffName: schema.users.fullName,
      staffEmail: schema.users.email,
      staffCode: schema.employees.employeeCode,
    })
    .from(schema.employeeAttendance)
    .innerJoin(
      schema.employees,
      eq(schema.employees.id, schema.employeeAttendance.employeeId)
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .where(and(...conditions))
    .orderBy(
      desc(schema.employeeAttendance.workDate),
      desc(schema.employeeAttendance.clockInAt)
    )
    .limit(query.limit ?? 100)
    .offset(query.offset ?? 0);

  return rows.map((r) => ({
    id: r.event.id,
    staffProfileId: r.event.employeeId,
    staffName: r.staffName,
    staffEmail: r.staffEmail,
    staffCode: r.staffCode,
    workDate: String(r.event.workDate),
    clockIn: r.event.clockInAt,
    clockOut: r.event.clockOutAt,
    status: r.event.status,
    faceVerified: r.event.faceVerified,
    geofenceVerified: r.event.geofenceVerified,
    workedMinutes: r.event.workedMinutes,
    overtimeMinutes: r.event.overtimeMinutes,
    scheduledMinutes: r.event.scheduledMinutes,
    premisesId: r.event.premisesId,
    overtimeId: r.event.overtimeId ?? null,
  }));
}

export interface AttendanceSummary {
  totalDays: number;
  presentDays: number;
  lateDays: number;
  halfDays: number;
  absentDays: number;
  leaveDays: number;
  unpaidLeaveDays: number;
  paidLeaveDays: number;
  holidayDays: number;
  weeklyOffDays: number;
  totalWorkedMinutes: number;
  totalOvertimeMinutes: number;
}

/**
 * Builds the attendance summary for a payroll period from the persisted shift
 * schedule, attendance rows, holidays and approved leave requests.
 */
export async function buildAttendanceSummary(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string,
  startDate: string,
  endDate: string
): Promise<AttendanceSummary> {
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
    .from(schema.employeeAttendance)
    .where(
      and(
        eq(schema.employeeAttendance.organizationId, organizationId),
        eq(schema.employeeAttendance.employeeId, staffProfileId),
        gte(schema.employeeAttendance.workDate, startDate),
        lte(schema.employeeAttendance.workDate, endDate)
      )
    );

  const eventByDate = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    eventByDate.set(String(event.workDate), event);
  }

  const leaveRows = await fastify.db
    .select({
      status: schema.leaveRequests.status,
      workDate: schema.leaveRequests.workDate,
    })
    .from(schema.leaveRequests)
    .where(
      and(
        eq(schema.leaveRequests.organizationId, organizationId),
        eq(schema.leaveRequests.employeeId, staffProfileId),
        gte(schema.leaveRequests.workDate, startDate),
        lte(schema.leaveRequests.workDate, endDate)
      )
    );

  const leaveDates = new Set<string>();
  for (const leave of leaveRows) {
    if (leave.status !== 'APPROVED') continue;
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
      } else if (event.status === 'HALF_DAY') {
        halfDays += 1;
      } else if (event.status === 'ABSENT') {
        absentDays += 1;
      }
      continue;
    }

    if (entry.type === 'SHIFT' && !leaveDates.has(entry.date)) {
      absentDays += 1;
    }
  }

  const leaveDayCount = Math.max(
    events.filter((e) => e.status === 'LEAVE').length,
    schedule.filter((entry) => entry.type === 'SHIFT' && leaveDates.has(entry.date)).length
  );

  return {
    totalDays: schedule.length,
    presentDays,
    lateDays: 0,
    halfDays,
    absentDays,
    leaveDays: leaveDayCount,
    unpaidLeaveDays: 0,
    paidLeaveDays: leaveDayCount,
    holidayDays,
    weeklyOffDays,
    totalWorkedMinutes,
    totalOvertimeMinutes,
  };
}

/**
 * Resolves an exception by updating the single attendance row and recording a
 * correction audit row. The attendance row is never deleted.
 */
export async function resolveException(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  exceptionId: string,
  input: {
    correctedStatus:
      | 'PRESENT'
      | 'ABSENT'
      | 'HALF_DAY'
      | 'LATE'
      | 'HOLIDAY'
      | 'LEAVE'
      | 'RESUME';
    reason: string;
    note?: string;
  }
) {
  const [event] = await fastify.db
    .select()
    .from(schema.employeeAttendance)
    .where(
      and(
        eq(schema.employeeAttendance.id, exceptionId),
        eq(schema.employeeAttendance.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!event) {
    throw new AppError(
      'Attendance exception not found',
      404,
      'ATTENDANCE_EXCEPTION_NOT_FOUND'
    );
  }

  const targetStatus = (input.correctedStatus === 'RESUME' ? 'PRESENT' : input.correctedStatus) as AttendanceStatus;

  const now = new Date();

  const [assignment] = event.shiftAssignmentId
    ? await fastify.db
        .select({
          presentPay: schema.employeeShiftAssignments.presentPay,
          halfDayPay: schema.employeeShiftAssignments.halfDayPay,
          absentPay: schema.employeeShiftAssignments.absentPay,
          leavePay: schema.employeeShiftAssignments.leavePay,
        })
        .from(schema.employeeShiftAssignments)
        .where(
          eq(schema.employeeShiftAssignments.id, event.shiftAssignmentId)
        )
        .limit(1)
    : [];

  const cents = (value: string | number | null | undefined) =>
    Math.round(Number(value ?? 0) * 100);
  const payCents =
    targetStatus === 'ABSENT'
      ? cents(assignment?.absentPay)
      : targetStatus === 'HALF_DAY'
        ? cents(assignment?.halfDayPay)
        : targetStatus === 'LEAVE'
          ? cents(assignment?.leavePay)
          : cents(assignment?.presentPay);

  await fastify.db.transaction(async (tx) => {
    await tx
      .update(schema.employeeAttendance)
      .set({
        status: targetStatus,
        statusUpdatedBy: actorUserId,
        remarks: input.note ?? input.reason,
        correctionReason: input.reason,
        correctedAt: now,
        monitoringAlertAt: null,
        consecutivePingFailures:
          input.correctedStatus === 'RESUME'
            ? 0
            : event.consecutivePingFailures,
        updatedAt: now,
      })
      .where(eq(schema.employeeAttendance.id, event.id));

    if (event.shiftAssignmentId) {
      const [existingEarning] = await tx
        .select({ id: staffEarningLedger.id })
        .from(staffEarningLedger)
        .where(
          and(
            eq(staffEarningLedger.attendanceId, event.id),
            eq(staffEarningLedger.type, 'SHIFT')
          )
        )
        .limit(1);

      const amount = (payCents / 100).toFixed(2);
      if (existingEarning) {
        await tx
          .update(staffEarningLedger)
          .set({ amount, updatedAt: now })
          .where(eq(staffEarningLedger.id, existingEarning.id));
      } else if (payCents !== 0) {
        await tx.insert(staffEarningLedger).values({
          organizationId,
          premisesId: event.premisesId,
          employeeId: event.employeeId,
          earningDate: event.workDate,
          type: 'SHIFT',
          amount,
          shiftAssignmentId: event.shiftAssignmentId,
          attendanceId: event.id,
          sourceReference: `attendance:${event.id}:SHIFT`,
        });
      }
    }
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'ATTENDANCE_CORRECTED',
    resourceType: 'employee_attendance',
    resourceId: event.id,
    metadata: {
      previousStatus: event.status,
      correctedStatus: input.correctedStatus,
      reason: input.reason,
      note: input.note ?? null,
    },
  });

  return {
    id: exceptionId,
    status: 'RESOLVED' as const,
    correctedStatus: input.correctedStatus,
  };
}

export async function getDailyAttendanceByDateAndPremises(
  fastify: FastifyInstance,
  organizationId: string,
  workDate: string,
  premisesId?: string
) {
  const conditions = [
    eq(schema.employeeAttendance.organizationId, organizationId),
    eq(schema.employeeAttendance.workDate, workDate),
  ];
  if (premisesId) {
    conditions.push(eq(schema.employeeAttendance.premisesId, premisesId));
  }

  const rows = await fastify.db
    .select({
      id: schema.employeeAttendance.id,
      organisationId: schema.employeeAttendance.organizationId,
      premisesId: schema.employeeAttendance.premisesId,
      staffId: schema.employeeAttendance.employeeId,
      shiftAssignmentId: schema.employeeAttendance.shiftAssignmentId,
      workDate: schema.employeeAttendance.workDate,
      attendanceStatus: schema.employeeAttendance.status,
      clockInAt: schema.employeeAttendance.clockInAt,
      clockOutAt: schema.employeeAttendance.clockOutAt,
      insidePingCount: schema.employeeAttendance.insidePingCount,
      outsidePingCount: schema.employeeAttendance.outsidePingCount,
      statusUpdatedBy: schema.employeeAttendance.statusUpdatedBy,
      remarks: schema.employeeAttendance.remarks,
      paymentAmount: staffEarningLedger.amount,
      staffName: schema.users.fullName,
      staffCode: schema.employees.employeeCode,
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      halfDayThreshold: schema.shifts.halfDayThreshold,
    })
    .from(schema.employeeAttendance)
    .innerJoin(
      schema.employees,
      eq(schema.employees.id, schema.employeeAttendance.employeeId)
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .leftJoin(
      schema.employeeShiftAssignments,
      eq(
        schema.employeeShiftAssignments.id,
        schema.employeeAttendance.shiftAssignmentId
      )
    )
    .leftJoin(
      schema.shifts,
      eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId)
    )
    .leftJoin(
      staffEarningLedger,
      and(
        eq(staffEarningLedger.attendanceId, schema.employeeAttendance.id),
        eq(staffEarningLedger.type, 'SHIFT')
      )
    )
    .where(and(...conditions))
    .orderBy(desc(schema.employeeAttendance.createdAt));

  return rows.map((row) => ({
    ...row,
    attendanceStatus: row.attendanceStatus,
    paymentAmount: row.paymentAmount ?? '0.00',
  }));
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
    .from(schema.employeeAttendance)
    .where(
      and(
        eq(schema.employeeAttendance.id, dailyAttendanceId),
        eq(schema.employeeAttendance.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!record) {
    throw new AppError(
      'Daily attendance record not found',
      404,
      'ATTENDANCE_NOT_FOUND'
    );
  }

  const [assignment] = record.shiftAssignmentId
    ? await fastify.db
        .select({
          presentPay: schema.employeeShiftAssignments.presentPay,
          halfDayPay: schema.employeeShiftAssignments.halfDayPay,
          absentPay: schema.employeeShiftAssignments.absentPay,
          leavePay: schema.employeeShiftAssignments.leavePay,
        })
        .from(schema.employeeShiftAssignments)
        .where(
          eq(schema.employeeShiftAssignments.id, record.shiftAssignmentId)
        )
        .limit(1)
    : [];

  const centsFromMoney = (value: string | number | null | undefined) =>
    Math.round(Number(value ?? 0) * 100);

  const statusPayCents =
    input.attendanceStatus === 'HALF_DAY'
      ? centsFromMoney(assignment?.halfDayPay)
      : input.attendanceStatus === 'ABSENT'
        ? centsFromMoney(assignment?.absentPay)
        : input.attendanceStatus === 'LEAVE'
          ? centsFromMoney(assignment?.leavePay)
          : centsFromMoney(assignment?.presentPay);

  const paymentCents =
    input.overridePaymentAmount !== undefined
      ? Math.round(input.overridePaymentAmount * 100)
      : statusPayCents;

  const now = new Date();

  const [updated] = await fastify.db.transaction(async (tx) => {
    const [attendance] = await tx
      .update(schema.employeeAttendance)
      .set({
        status: input.attendanceStatus,
        statusUpdatedBy: actorUserId,
        remarks: input.remarks ?? null,
        correctionReason: input.remarks ?? 'Manual attendance correction',
        correctedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.employeeAttendance.id, dailyAttendanceId))
      .returning();

    const [existingEarning] = await tx
      .select({ id: staffEarningLedger.id })
      .from(staffEarningLedger)
      .where(
        and(
          eq(staffEarningLedger.attendanceId, dailyAttendanceId),
          eq(staffEarningLedger.type, 'SHIFT')
        )
      )
      .limit(1);

    if (paymentCents > 0) {
      const amount = (paymentCents / 100).toFixed(2);
      if (existingEarning) {
        await tx
          .update(staffEarningLedger)
          .set({ amount, updatedAt: now })
          .where(eq(staffEarningLedger.id, existingEarning.id));
      } else {
        await tx.insert(staffEarningLedger).values({
          organizationId,
          premisesId: record.premisesId,
          employeeId: record.employeeId,
          earningDate: record.workDate,
          type: 'SHIFT',
          amount,
          shiftAssignmentId: record.shiftAssignmentId,
          attendanceId: record.id,
          sourceReference: `attendance:${record.id}:SHIFT`,
        });
      }
    } else if (existingEarning) {
      await tx
        .update(staffEarningLedger)
        .set({ amount: '0.00', updatedAt: now })
        .where(eq(staffEarningLedger.id, existingEarning.id));
    }

    return [attendance];
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'DAILY_ATTENDANCE_CORRECTED',
    resourceType: 'employee_attendance',
    resourceId: dailyAttendanceId,
    metadata: {
      status: input.attendanceStatus,
      overridePaymentAmount: input.overridePaymentAmount ?? null,
      remarks: input.remarks ?? null,
    },
  });

  return {
    id: updated.id,
    attendanceStatus: updated.status,
    paymentAmount:
      input.overridePaymentAmount !== undefined
        ? input.overridePaymentAmount.toFixed(2)
        : (paymentCents / 100).toFixed(2),
  };
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
    eq(schema.employeeAttendance.organizationId, organizationId),
    eq(schema.employeeAttendance.employeeId, profile.id),
  ];
  if (from) conditions.push(gte(schema.employeeAttendance.workDate, from));
  if (to) conditions.push(lte(schema.employeeAttendance.workDate, to));

  const rows = await fastify.db
    .select({
      id: schema.employeeAttendance.id,
      workDate: schema.employeeAttendance.workDate,
      attendanceStatus: schema.employeeAttendance.status,
      clockInAt: schema.employeeAttendance.clockInAt,
      clockOutAt: schema.employeeAttendance.clockOutAt,
      insidePingCount: schema.employeeAttendance.insidePingCount,
      outsidePingCount: schema.employeeAttendance.outsidePingCount,
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      attendanceId: schema.employeeAttendance.id,
      ledgerAmount: staffEarningLedger.amount,
    })
    .from(schema.employeeAttendance)
    .leftJoin(
      schema.employeeShiftAssignments,
      eq(
        schema.employeeShiftAssignments.id,
        schema.employeeAttendance.shiftAssignmentId
      )
    )
    .leftJoin(
      schema.shifts,
      eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId)
    )
    .leftJoin(
      staffEarningLedger,
      eq(staffEarningLedger.attendanceId, schema.employeeAttendance.id)
    )
    .where(and(...conditions))
    .orderBy(desc(schema.employeeAttendance.workDate));

  return rows.map(({ ledgerAmount, ...row }) => ({
    ...row,
    paymentAmount: ledgerAmount ?? '0.00',
  }));
}

export async function getUpcomingAttendance(fastify: any, organizationId: string, userId: string, date?: string) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  const now = new Date();
  const timezone = await resolveTimezone(fastify, organizationId);
  const targetDate = date || toDateISOInTimeZone(now, timezone);
  let shift: any = null;
  try {
    const sShift = await resolveShiftForClockIn(fastify, organizationId, profile.id, now, timezone);
    shift = { assignmentId: sShift.assignmentId, workDate: sShift.workDate, startTime: sShift.startTime, endTime: sShift.endTime, startAt: sShift.startAt.toISOString(), endAt: sShift.endAt.toISOString(), scheduledMinutes: sShift.scheduledMinutes };
  } catch (e) {
    shift = null;
  }
  const upcomingOvertime = await fastify.db.select().from(schema.overtime).where(and(eq(schema.overtime.organizationId, organizationId), eq(schema.overtime.employeeId, profile.id), eq(schema.overtime.workDate, targetDate), eq(schema.overtime.status, 'APPROVED'))).orderBy(schema.overtime.startTime);
  return { date: targetDate, shift, overtime: upcomingOvertime };
}

export async function manualMarkAttendance(fastify: any, organizationId: string, actorUserId: string, input: any) {
  if (input.action === 'DELETE_OVERTIME') {
    if (!input.overtimeId) throw new AppError('overtimeId required', 400, 'OVERTIME_ID_REQUIRED');
    const [ot] = await fastify.db.select().from(schema.overtime).where(and(eq(schema.overtime.id, input.overtimeId), eq(schema.overtime.organizationId, organizationId))).limit(1);
    if (!ot) throw new AppError('Overtime not found', 404, 'OVERTIME_NOT_FOUND');
    const now = new Date();
    if (now.getTime() > new Date(String(ot.workDate) + 'T' + ot.endTime).getTime()) throw new AppError('Cannot delete overtime after it has ended', 400, 'OVERTIME_ENDED');
    await fastify.db.delete(schema.overtime).where(eq(schema.overtime.id, input.overtimeId));
    await writeAuditLog(fastify, { organizationId, actorId: actorUserId, action: 'OVERTIME_DELETED_BY_MANUAL_MARK', resourceType: 'overtime', resourceId: input.overtimeId });
    return { deleted: true, overtimeId: input.overtimeId };
  }
  let event: any = null;
  if (input.attendanceEventId) {
    const [row] = await fastify.db.select().from(schema.employeeAttendance).where(and(eq(schema.employeeAttendance.id, input.attendanceEventId), eq(schema.employeeAttendance.organizationId, organizationId))).limit(1);
    event = row ?? null;
  } else if (input.employeeId && input.workDate) {
    const [row] = await fastify.db.select().from(schema.employeeAttendance).where(and(eq(schema.employeeAttendance.organizationId, organizationId), eq(schema.employeeAttendance.employeeId, input.employeeId), eq(schema.employeeAttendance.workDate, input.workDate))).limit(1);
    event = row ?? null;
  }
  if (!event) throw new AppError('Attendance event not found', 404, 'ATTENDANCE_EVENT_NOT_FOUND');
  if (!event.clockInAt) throw new AppError('Manual marking only allowed after clock-in', 400, 'NOT_CLOCKED_IN');
  if (event.attendanceType === 'SHIFT') {
    if (input.action !== 'ABSENT' && input.action !== 'HALF_DAY') {
      throw new AppError('Only ABSENT or HALF_DAY allowed for shift manual marking', 400, 'INVALID_ACTION');
    }
  } else if (event.attendanceType === 'OVERTIME') {
    throw new AppError('For overtime sessions, action must be DELETE_OVERTIME', 400, 'INVALID_ACTION');
  }
  const timezone = await resolveTimezone(fastify, organizationId);
  let endAt: Date | null = null;
  if (event.attendanceType === 'SHIFT' && event.shiftAssignmentId) {
    const [shift] = await fastify.db.select({ startTime: schema.shifts.startTime, endTime: schema.shifts.endTime }).from(schema.employeeAttendance).innerJoin(schema.employeeShiftAssignments, eq(schema.employeeShiftAssignments.id, schema.employeeAttendance.shiftAssignmentId)).innerJoin(schema.shifts, eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId)).where(eq(schema.employeeAttendance.id, event.id)).limit(1);
    if (shift) {
      const window = resolveShiftWindow(String(event.workDate), shift.startTime, shift.endTime, 0, timezone);
      endAt = window.endAt;
    }
  }
  if (endAt && new Date() > endAt) throw new AppError('Manual marking not allowed after shift has ended', 400, 'SHIFT_ENDED');
  const outside = Number(event.outsidePingCount || 0);
  if (outside <= 3) throw new AppError('Manual marking only allowed when outside count > 3', 400, 'MANUAL_MARK_NOT_ALLOWED');
  const targetStatus = input.action;
  const [updated] = await fastify.db.update(schema.employeeAttendance).set({ status: targetStatus, updatedAt: new Date(), statusUpdatedBy: actorUserId, correctionReason: input.reason ?? null, correctedAt: new Date() }).where(eq(schema.employeeAttendance.id, event.id)).returning();
  await writeAuditLog(fastify, { organizationId, actorId: actorUserId, action: 'ATTENDANCE_MANUAL_MARK', resourceType: 'employee_attendance', resourceId: event.id, metadata: { action: input.action, reason: input.reason } });
  return toPublicAttendanceEvent(updated);
}

export { enumerateDates };
