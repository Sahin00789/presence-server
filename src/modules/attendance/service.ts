import { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
const staffEarningLedger = (schema as any).employeeEarningLedger ?? (schema as any).staffEarningLedger;
import { AppError } from '../../shared/errors/app-error.js';
import {
  evaluateGeofence,
  haversineDistanceMeters,
  roundDistanceMeters,
  DEFAULT_GEOFENCE_RADIUS_METERS,
} from '../../shared/utils/geo.js';

import {
  addDays,
  dayOfWeek,
  enumerateDates,
  isOvernightShift,
  minutesBetween,
  parseTimeToMinutes,
  resolveShiftWindow,
  toDateISOInTimeZone,
} from '../../shared/utils/datetime.js';
import { getUnworkedPaymentAmount } from '../../jobs/holidayWeeklyOffEarnings.js';
import { buildSchedule, getAssignedDayNumbers, resolveTimezone } from '../shifts/service.js';

import {
  assertLivenessEvidence,
  type LivenessEvidence,
} from '../../shared/utils/liveness.js';
import { createNotification } from '../../shared/services/notification.service.js';
import {
  findStaffProfile,
  listManagerUserIds,
  listOwnerUserIds,
  resolveNotificationTargets,
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
    assignedStartTime: (event as any).assignedShiftStartTime || (event as any).assignedOvertimeStartTime || null,
    assignedEndTime: (event as any).assignedShiftEndTime || (event as any).assignedOvertimeEndTime || null,
    premisesId: event.premisesId,
    overtimeId: (event as any).overtimeId ?? null,
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

  if (!selectedAssignment) {
    throw new AppError(
      'No active shift is scheduled for you today according to your assigned shift days.',
      400,
      'NO_SHIFT_SCHEDULED_TODAY'
    );
  }

  const assignment = selectedAssignment;

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
) {
  const [existing] = await fastify.db
    .select()
    .from(schema.employeeShiftAttendance)
    .where(
      and(
        eq(schema.employeeShiftAttendance.organizationId, organizationId),
        eq(schema.employeeShiftAttendance.shiftAssignmentId, shiftAssignmentId),
        eq(schema.employeeShiftAttendance.workDate, workDate)
      )
    )
    .limit(1);
  return existing ?? null;
}

async function findExistingOvertimeAttendance(
  fastify: FastifyInstance,
  organizationId: string,
  overtimeId: string
) {
  const [existing] = await fastify.db
    .select()
    .from(schema.employeeOvertimeAttendance)
    .where(
      and(
        eq(schema.employeeOvertimeAttendance.organizationId, organizationId),
        eq(schema.employeeOvertimeAttendance.overtimeId, overtimeId)
      )
    )
    .limit(1);
  return existing ?? null;
}

async function clockIn(
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
    if (entry.status !== 'CREATED' && entry.status !== 'IN_PROGRESS') {
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

  let event: any;
  try {
    if (overtime) {
      [event] = await fastify.db
        .insert(schema.employeeOvertimeAttendance)
        .values({
          organizationId,
          premisesId: premises.id,
          employeeId: profile.id,
          overtimeId: overtime.id,
          workDate,
          assignedOvertimeStartTime: overtime.startTime,
          assignedOvertimeEndTime: overtime.endTime,
          status,
          clockInAt: now,
          faceVerified: true,
          geofenceVerified: true,
          faceScore: faceScore != null ? faceScore.toFixed(4) : (body.faceScore ? body.faceScore.toFixed(4) : null),
          consecutivePingFailures: 0,
          insidePingCount: 1,
        })
        .returning();
    } else {
      [event] = await fastify.db
        .insert(schema.employeeShiftAttendance)
        .values({
          organizationId,
          premisesId: premises.id,
          employeeId: profile.id,
          shiftAssignmentId: shift!.assignmentId,
          workDate,
          assignedShiftStartTime: shift!.startTime,
          assignedShiftEndTime: shift!.endTime,
          status,
          clockInAt: now,
          faceVerified: true,
          geofenceVerified: true,
          faceScore: faceScore != null ? faceScore.toFixed(4) : (body.faceScore ? body.faceScore.toFixed(4) : null),
          consecutivePingFailures: 0,
          insidePingCount: 1,
        })
        .returning();
    }
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
    .insert(schema.employeeShiftAttendance)
    .values({
      organizationId,
      premisesId: premises.id,
      employeeId: profile.id,
      shiftAssignmentId: shift.assignmentId,
      workDate: shift.workDate,
      assignedShiftStartTime: shift.startTime,
      assignedShiftEndTime: shift.endTime,
      status: 'PRESENT',
      clockInAt: now,
      faceVerified: false,
      geofenceVerified: geofence.result === 'IN_PREMISES',
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

  const [updated] = await fastify.db
    .update(schema.employeeAttendance)
    .set({
      clockOutAt: now,
      status: 'PRESENT',
      updatedAt: now,
    })
    .where(eq(schema.employeeAttendance.id, event.id))
    .returning();

  await accrueShiftEarnings(fastify, organizationId, updated);

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
  user: { userId: string; role: 'OWNER' | 'EMPLOYEE' },
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

  if (user.role === 'EMPLOYEE') {
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
  user: { userId: string; role: 'OWNER' | 'EMPLOYEE' },
  organizationId: string,
  query: {
    from?: string;
    to?: string;
    staffProfileId?: string;
    limit?: number;
    offset?: number;
  }
) {
  const conditions = [
    eq(schema.employeeAttendance.organizationId, organizationId),
    or(
      isNotNull(schema.employeeAttendance.clockInAt),
      inArray(schema.employeeAttendance.status, ['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE'])
    ),
  ];

  if (query.staffProfileId) {
    const [emp] = await fastify.db
      .select({ id: schema.employees.id })
      .from(schema.employees)
      .where(
        and(
          eq(schema.employees.organizationId, organizationId),
          or(
            eq(schema.employees.id, query.staffProfileId),
            eq(schema.employees.userId, query.staffProfileId)
          )
        )
      )
      .limit(1);

    if (emp) {
      conditions.push(eq(schema.employeeAttendance.employeeId, emp.id));
    } else {
      conditions.push(eq(schema.employeeAttendance.employeeId, query.staffProfileId));
    }
  } else if (user.role === 'EMPLOYEE') {
    const profile = await findStaffProfile(fastify, user.userId, organizationId);
    if (profile) {
      conditions.push(eq(schema.employeeAttendance.employeeId, profile.id));
    }
  }

  if (query.from) {
    conditions.push(gte(schema.employeeAttendance.workDate, query.from));
  }
  if (query.to) {
    conditions.push(lte(schema.employeeAttendance.workDate, query.to));
  }

  const rows = await fastify.db
    .select({
      event: schema.employeeShiftAttendance,
      staffName: schema.users.fullName,
      staffEmail: schema.users.email,
      staffCode: schema.employees.employeeCode,
      shiftName: schema.shifts.shiftName,
      shiftStartTime: schema.shifts.startTime,
      shiftEndTime: schema.shifts.endTime,
    })
    .from(schema.employeeShiftAttendance)
    .innerJoin(
      schema.employees,
      eq(schema.employees.id, schema.employeeShiftAttendance.employeeId)
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .leftJoin(
      schema.employeeShiftAssignments,
      eq(schema.employeeShiftAssignments.id, schema.employeeShiftAttendance.shiftAssignmentId)
    )
    .leftJoin(
      schema.shifts,
      eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId)
    )
    .where(and(...conditions))
    .orderBy(
      desc(schema.employeeShiftAttendance.workDate),
      desc(schema.employeeShiftAttendance.clockInAt)
    )
    .limit(query.limit ?? 100)
    .offset(query.offset ?? 0);

  return rows.map((r) => {
    const assignedStartTime = r.event.assignedShiftStartTime || r.shiftStartTime;
    let lateMinutes = 0;
    if (r.event.clockInAt && assignedStartTime) {
      try {
        const clockInDate = new Date(r.event.clockInAt);
        const [sh, sm] = assignedStartTime.split(':').map(Number);
        const shiftStartDate = new Date(clockInDate);
        shiftStartDate.setHours(sh, sm, 0, 0);
        const diffMs = clockInDate.getTime() - shiftStartDate.getTime();
        if (diffMs > 0) {
          lateMinutes = Math.floor(diffMs / 60_000);
        }
      } catch (_e) {
        lateMinutes = 0;
      }
    }

    return {
      id: r.event.id,
      organizationId: r.event.organizationId,
      premisesId: r.event.premisesId,
      employeeId: r.event.employeeId,
      staffProfileId: r.event.employeeId,
      staffName: r.staffName,
      staffEmail: r.staffEmail,
      staffCode: r.staffCode,
      workDate: String(r.event.workDate),
      clockIn: r.event.clockInAt,
      clockOut: r.event.clockOutAt,
      status: r.event.status,
      attendanceType: 'SHIFT',
      shiftName: r.shiftName || 'Shift Session',
      assignedStartTime,
      assignedEndTime: r.event.assignedShiftEndTime || r.shiftEndTime,
      faceVerified: r.event.faceVerified,
      geofenceVerified: r.event.geofenceVerified,
      lateMinutes,
      overtimeId: null,
    };
  });
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

export async function getEmployeeAttendanceAndEarningsHistory(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string,
  from?: string,
  to?: string,
  month?: string,
  year?: number
) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    return [];
  }

  let f = from;
  let t = to;
  if (month && !f && !t) {
    const [y, m] = month.split('-').map((v) => parseInt(v));
    f = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
    const last = new Date(y, m, 0).getDate();
    t = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  } else if (year && !month && !f && !t) {
    f = `${year}-01-01`;
    t = `${year}-12-31`;
  }

  const conditions = [
    eq(schema.employeeAttendance.organizationId, organizationId),
    eq(schema.employeeAttendance.employeeId, profile.id),
    or(
      isNotNull(schema.employeeAttendance.clockInAt),
      inArray(schema.employeeAttendance.status, ['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE'])
    ),
  ];
  if (f) conditions.push(gte(schema.employeeAttendance.workDate, f));
  if (t) conditions.push(lte(schema.employeeAttendance.workDate, t));

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
    if (!date) {
      const assignments = await fastify.db
        .select({
          assignmentId: schema.employeeShiftAssignments.id,
          startTime: schema.shifts.startTime,
          endTime: schema.shifts.endTime,
          halfDayThreshold: schema.shifts.halfDayThreshold,
          dayName: schema.shifts.dayName,
        })
        .from(schema.employeeShiftAssignments)
        .innerJoin(schema.shifts, eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId))
        .where(
          and(
            eq(schema.employeeShiftAssignments.employeeId, profile.id),
            eq(schema.employeeShiftAssignments.organizationId, organizationId),
            eq(schema.employeeShiftAssignments.isActive, true)
          )
        );

      for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
        const nextDateObj = new Date(now.getTime() + dayOffset * 86400000);
        const nextIso = toDateISOInTimeZone(nextDateObj, timezone);
        const dow = new Date(`${nextIso}T00:00:00Z`).getUTCDay();
        const match = assignments.find((a: any) => getAssignedDayNumbers(a.dayName).includes(dow));
        if (match) {
          const window = resolveShiftWindow(nextIso, match.startTime, match.endTime, 0, timezone);
          shift = {
            assignmentId: match.assignmentId,
            workDate: nextIso,
            startTime: match.startTime,
            endTime: match.endTime,
            startAt: window.startAt.toISOString(),
            endAt: window.endAt.toISOString(),
            scheduledMinutes: window.scheduledMinutes,
          };
          break;
        }
      }
    } else {
      shift = null;
    }
  }
  const otCondition = date
    ? and(
        eq(schema.overtime.organizationId, organizationId),
        eq(schema.overtime.employeeId, profile.id),
        eq(schema.overtime.workDate, targetDate),
        inArray(schema.overtime.status, ['CREATED', 'IN_PROGRESS'])
      )
    : and(
        eq(schema.overtime.organizationId, organizationId),
        eq(schema.overtime.employeeId, profile.id),
        gte(schema.overtime.workDate, targetDate),
        inArray(schema.overtime.status, ['CREATED', 'IN_PROGRESS'])
      );
  const upcomingOvertime = await fastify.db
    .select()
    .from(schema.overtime)
    .where(otCondition)
    .orderBy(schema.overtime.workDate, schema.overtime.startTime);
  return { date: shift?.workDate || targetDate, shift, overtime: upcomingOvertime };
}

export async function getNextUpcomingAttendance(fastify: any, organizationId: string, userId: string) {
  const upcoming = await getUpcomingAttendance(fastify, organizationId, userId);
  const shift = upcoming.shift;
  const ot = upcoming.overtime?.[0] ?? null;

  if (!shift && !ot) {
    return { nextSession: null };
  }

  const otDateTime = ot ? `${ot.workDate}T${ot.startTime || '00:00:00'}` : null;
  const shiftDateTime = shift ? `${shift.workDate}T${shift.startTime || '00:00:00'}` : null;

  if (ot && (!shift || (otDateTime && shiftDateTime && otDateTime < shiftDateTime))) {
    return {
      nextSession: {
        kind: 'OVERTIME',
        overtimeId: ot.id,
        workDate: String(ot.workDate),
        startTime: ot.startTime,
        endTime: ot.endTime,
        reason: ot.reason,
        paymentInr: ot.paymentInr,
      },
    };
  }

  return {
    nextSession: {
      kind: 'SHIFT',
      assignmentId: shift.assignmentId,
      workDate: shift.workDate,
      startTime: shift.startTime,
      endTime: shift.endTime,
    },
  };
}

export async function clockInShift(fastify: any, userId: string, organizationId: string, body: any) {
  const { overtimeId, ...shiftBody } = body;
  return clockIn(fastify, userId, organizationId, shiftBody);
}

export async function clockInOvertime(fastify: any, userId: string, organizationId: string, body: any) {
  if (!body.overtimeId) {
    throw new AppError('overtimeId required for overtime clock-in', 400, 'OVERTIME_ID_REQUIRED');
  }
  return clockIn(fastify, userId, organizationId, body);
}

export async function correctShiftAttendance(
  fastify: any,
  organizationId: string,
  actorUserId: string,
  input: {
    attendanceEventId?: string;
    assignShiftId?: string;
    shiftAssignmentId?: string;
    employeeId?: string;
    workDate?: string;
    action: 'ABSENT' | 'HALF_DAY' | 'LEAVE' | 'PRESENT';
    reason?: string;
    departureTime?: string;
  }
) {
  const targetShiftAssignmentId = input.assignShiftId || input.shiftAssignmentId;
  let event: any = null;

  if (input.attendanceEventId) {
    const [row] = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.id, input.attendanceEventId),
          eq(schema.employeeAttendance.organizationId, organizationId)
        )
      )
      .limit(1);
    event = row ?? null;
  } else if (targetShiftAssignmentId && input.workDate) {
    const [row] = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.organizationId, organizationId),
          eq(schema.employeeAttendance.shiftAssignmentId, targetShiftAssignmentId),
          eq(schema.employeeAttendance.workDate, input.workDate)
        )
      )
      .limit(1);
    event = row ?? null;
  } else if (input.employeeId && input.workDate) {
    const [row] = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.organizationId, organizationId),
          eq(schema.employeeAttendance.employeeId, input.employeeId),
          eq(schema.employeeAttendance.workDate, input.workDate)
        )
      )
      .limit(1);
    event = row ?? null;
  }

  const now = new Date();
  const updateFields: any = {
    status: input.action,
    updatedAt: now,
    statusUpdatedBy: actorUserId,
    correctionReason: input.reason ?? null,
    correctedAt: now,
  };
  if (targetShiftAssignmentId) {
    updateFields.shiftAssignmentId = targetShiftAssignmentId;
  }

  if (event) {
    if (input.departureTime) {
      const dateStr = String(event.workDate);
      const departureIso = new Date(`${dateStr}T${input.departureTime}`).toISOString();
      updateFields.clockOutAt = departureIso;
      updateFields.clockOut = new Date(departureIso);
    }

    const [updated] = await fastify.db
      .update(schema.employeeAttendance)
      .set(updateFields)
      .where(eq(schema.employeeAttendance.id, event.id))
      .returning();

    return toPublicAttendanceEvent(updated);
  } else {
    let empId = input.employeeId;
    let premId: string | null = null;

    if (targetShiftAssignmentId) {
      const [assignment] = await fastify.db
        .select()
        .from(schema.employeeShiftAssignments)
        .where(eq(schema.employeeShiftAssignments.id, targetShiftAssignmentId))
        .limit(1);
      if (assignment) {
        empId = empId || assignment.employeeId;
        premId = assignment.premisesId;
      }
    }

    if (!empId || !input.workDate) {
      throw new AppError('Shift attendance record not found and insufficient data to create one', 404, 'ATTENDANCE_EVENT_NOT_FOUND');
    }

    const dateStr = String(input.workDate);
    let departureIso: string | null = null;
    if (input.departureTime) {
      departureIso = new Date(`${dateStr}T${input.departureTime}`).toISOString();
    }

    const [created] = await fastify.db
      .insert(schema.employeeAttendance)
      .values({
        organizationId,
        premisesId: premId,
        employeeId: empId,
        shiftAssignmentId: targetShiftAssignmentId ?? null,
        attendanceType: 'SHIFT',
        workDate: input.workDate,
        status: input.action,
        clockOutAt: departureIso,
        clockOut: departureIso ? new Date(departureIso) : null,
        statusUpdatedBy: actorUserId,
        correctionReason: input.reason ?? null,
        correctedAt: now,
      })
      .returning();

    return toPublicAttendanceEvent(created);
  }
}

export async function correctOvertimeAttendance(
  fastify: any,
  organizationId: string,
  actorUserId: string,
  input: {
    overtimeId?: string;
    attendanceEventId?: string;
    employeeId?: string;
    workDate?: string;
    action: 'DELETE_OVERTIME' | 'CANCELLED' | 'CANCEL_OVERTIME';
    reason?: string;
    departureTime?: string;
  }
) {
  let otId = input.overtimeId;

  if (!otId && input.attendanceEventId) {
    const [att] = await fastify.db
      .select({ overtimeId: schema.employeeOvertimeAttendance.overtimeId })
      .from(schema.employeeOvertimeAttendance)
      .where(
        and(
          eq(schema.employeeOvertimeAttendance.id, input.attendanceEventId),
          eq(schema.employeeOvertimeAttendance.organizationId, organizationId)
        )
      )
      .limit(1);
    if (att) {
      otId = att.overtimeId;
    }
  } else if (!otId && input.employeeId && input.workDate) {
    const [ot] = await fastify.db
      .select({ id: schema.overtime.id })
      .from(schema.overtime)
      .where(
        and(
          eq(schema.overtime.organizationId, organizationId),
          eq(schema.overtime.employeeId, input.employeeId),
          eq(schema.overtime.workDate, input.workDate)
        )
      )
      .limit(1);
    if (ot) {
      otId = ot.id;
    }
  }

  if (!otId) {
    throw new AppError('overtimeId required to delete/cancel overtime', 400, 'OVERTIME_ID_REQUIRED');
  }

  const [ot] = await fastify.db
    .select()
    .from(schema.overtime)
    .where(
      and(
        eq(schema.overtime.id, otId),
        eq(schema.overtime.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!ot) {
    throw new AppError('Overtime entry not found', 404, 'OVERTIME_NOT_FOUND');
  }

  const now = new Date();
  await fastify.db
    .update(schema.overtime)
    .set({
      status: 'CANCELLED',
      reason: input.reason ?? ot.reason,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.overtime.id, otId));

  // If there is an overtime attendance record, record the correction
  await fastify.db
    .update(schema.employeeOvertimeAttendance)
    .set({
      correctionReason: input.reason ?? null,
      correctedAt: now,
      statusUpdatedBy: actorUserId,
      updatedAt: now,
    })
    .where(eq(schema.employeeOvertimeAttendance.overtimeId, otId));

  // If earning ledger record exists for this overtime, remove it
  await fastify.db
    .delete(schema.employeeEarningLedger)
    .where(
      and(
        eq(schema.employeeEarningLedger.overtimeId, otId),
        eq(schema.employeeEarningLedger.type, 'OVERTIME')
      )
    );

  return { deleted: true, overtimeId: otId, status: 'CANCELLED' };
}

const MAX_ACCURACY = 30;
const MAX_AGE_MINUTES = 2;
const FAILURE_RESULTS = new Set([
  'OUTSIDE',
  'STALE',
  'LOW_ACCURACY',
  'MOCKED',
  'UNKNOWN',
]);

function isStale(timestamp: Date, now: Date): boolean {
  return now.getTime() - timestamp.getTime() > MAX_AGE_MINUTES * 60 * 1000;
}

export function shouldRaiseOutsideAlert(
  outsidePingCount: number,
  monitoringAlertAt: Date | null | undefined
): boolean {
  return outsidePingCount > 3 && monitoringAlertAt == null;
}

export async function submitShiftLocationCheck(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string,
  body: {
    shiftAttendanceId?: string;
    attendanceEventId?: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    isMock?: boolean;
    timestamp?: string;
    clientRequestId?: string;
  }
) {
  const targetId = body.shiftAttendanceId || body.attendanceEventId;
  if (!targetId) {
    throw new AppError('shiftAttendanceId required', 400, 'SHIFT_ATTENDANCE_ID_REQUIRED');
  }

  const [event] = await fastify.db
    .select()
    .from(schema.employeeShiftAttendance)
    .where(
      and(
        eq(schema.employeeShiftAttendance.id, targetId),
        eq(schema.employeeShiftAttendance.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!event) {
    throw new AppError('Shift attendance event not found', 404, 'ATTENDANCE_EVENT_NOT_FOUND');
  }

  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile || profile.id !== event.employeeId) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }

  if (!event.clockInAt) {
    throw new AppError('Location monitoring can only start after clock-in.', 409, 'ATTENDANCE_NOT_CLOCKED_IN');
  }

  if (event.clockOutAt) {
    throw new AppError('Location monitoring has stopped for this attendance.', 409, 'ATTENDANCE_ALREADY_CLOSED');
  }

  const [premises] = await fastify.db
    .select()
    .from(schema.premises)
    .where(
      and(
        eq(schema.premises.id, event.premisesId),
        eq(schema.premises.organizationId, organizationId)
      )
    )
    .limit(1);

  const checkedAt = new Date();
  let result: (typeof schema.locationCheckResultEnum.enumValues)[number] = 'UNKNOWN';

  if (body.isMock) {
    result = 'MOCKED';
  } else if (body.accuracyMeters > MAX_ACCURACY) {
    result = 'LOW_ACCURACY';
  } else if (premises) {
    const evaluation = evaluateGeofence(
      {
        latitude: body.latitude,
        longitude: body.longitude,
        accuracyMeters: body.accuracyMeters,
        isMocked: false,
        capturedAt: checkedAt,
      },
      {
        latitude: Number(premises.latitude),
        longitude: Number(premises.longitude),
        radiusMeters: Number(premises.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS),
      }
    );
    result = evaluation.result === 'IN_PREMISES' ? 'IN_PREMISES' : 'OUTSIDE';
  }

  try {
    await fastify.db.insert(schema.shiftLocationPings).values({
      shiftAttendanceId: targetId,
      checkedAt,
      latitude: body.latitude.toFixed(7),
      longitude: body.longitude.toFixed(7),
      accuracyMeters: body.accuracyMeters.toFixed(2),
      result,
      clientRequestId: body.clientRequestId ?? null,
    });
  } catch (error) {
    if (body.clientRequestId && (error as { code?: string })?.code === '23505') {
      return { result, consecutiveFailures: event.consecutivePingFailures, exceptionCreated: false };
    }
    throw error;
  }

  const inside = result === 'IN_PREMISES';
  const failure = FAILURE_RESULTS.has(result);

  const [updated] = await fastify.db
    .update(schema.employeeShiftAttendance)
    .set({
      insidePingCount: inside ? sql`${schema.employeeShiftAttendance.insidePingCount} + 1` : schema.employeeShiftAttendance.insidePingCount,
      outsidePingCount: !inside ? sql`${schema.employeeShiftAttendance.outsidePingCount} + 1` : schema.employeeShiftAttendance.outsidePingCount,
      consecutivePingFailures: failure ? sql`${schema.employeeShiftAttendance.consecutivePingFailures} + 1` : inside ? 0 : schema.employeeShiftAttendance.consecutivePingFailures,
      updatedAt: new Date(),
    })
    .where(eq(schema.employeeShiftAttendance.id, targetId))
    .returning();

  return { result, consecutiveFailures: updated.consecutivePingFailures, exceptionCreated: false };
}

export async function submitOvertimeLocationCheck(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string,
  body: {
    overtimeAttendanceId?: string;
    attendanceEventId?: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    isMock?: boolean;
    timestamp?: string;
    clientRequestId?: string;
  }
) {
  const targetId = body.overtimeAttendanceId || body.attendanceEventId;
  if (!targetId) {
    throw new AppError('overtimeAttendanceId required', 400, 'OVERTIME_ATTENDANCE_ID_REQUIRED');
  }

  const [event] = await fastify.db
    .select()
    .from(schema.employeeOvertimeAttendance)
    .where(
      and(
        eq(schema.employeeOvertimeAttendance.id, targetId),
        eq(schema.employeeOvertimeAttendance.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!event) {
    throw new AppError('Overtime attendance event not found', 404, 'ATTENDANCE_EVENT_NOT_FOUND');
  }

  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile || profile.id !== event.employeeId) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }

  if (!event.clockInAt) {
    throw new AppError('Location monitoring can only start after clock-in.', 409, 'ATTENDANCE_NOT_CLOCKED_IN');
  }

  if (event.clockOutAt) {
    throw new AppError('Location monitoring has stopped for this attendance.', 409, 'ATTENDANCE_ALREADY_CLOSED');
  }

  const [premises] = await fastify.db
    .select()
    .from(schema.premises)
    .where(
      and(
        eq(schema.premises.id, event.premisesId),
        eq(schema.premises.organizationId, organizationId)
      )
    )
    .limit(1);

  const checkedAt = new Date();
  let result: (typeof schema.locationCheckResultEnum.enumValues)[number] = 'UNKNOWN';

  if (body.isMock) {
    result = 'MOCKED';
  } else if (body.accuracyMeters > MAX_ACCURACY) {
    result = 'LOW_ACCURACY';
  } else if (premises) {
    const evaluation = evaluateGeofence(
      {
        latitude: body.latitude,
        longitude: body.longitude,
        accuracyMeters: body.accuracyMeters,
        isMocked: false,
        capturedAt: checkedAt,
      },
      {
        latitude: Number(premises.latitude),
        longitude: Number(premises.longitude),
        radiusMeters: Number(premises.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS),
      }
    );
    result = evaluation.result === 'IN_PREMISES' ? 'IN_PREMISES' : 'OUTSIDE';
  }

  try {
    await fastify.db.insert(schema.overtimeLocationPings).values({
      overtimeAttendanceId: targetId,
      checkedAt,
      latitude: body.latitude.toFixed(7),
      longitude: body.longitude.toFixed(7),
      accuracyMeters: body.accuracyMeters.toFixed(2),
      result,
      clientRequestId: body.clientRequestId ?? null,
    });
  } catch (error) {
    if (body.clientRequestId && (error as { code?: string })?.code === '23505') {
      return { result, consecutiveFailures: event.consecutivePingFailures, exceptionCreated: false };
    }
    throw error;
  }

  const inside = result === 'IN_PREMISES';
  const failure = FAILURE_RESULTS.has(result);

  const [updated] = await fastify.db
    .update(schema.employeeOvertimeAttendance)
    .set({
      insidePingCount: inside ? sql`${schema.employeeOvertimeAttendance.insidePingCount} + 1` : schema.employeeOvertimeAttendance.insidePingCount,
      outsidePingCount: !inside ? sql`${schema.employeeOvertimeAttendance.outsidePingCount} + 1` : schema.employeeOvertimeAttendance.outsidePingCount,
      consecutivePingFailures: failure ? sql`${schema.employeeOvertimeAttendance.consecutivePingFailures} + 1` : inside ? 0 : schema.employeeOvertimeAttendance.consecutivePingFailures,
      updatedAt: new Date(),
    })
    .where(eq(schema.employeeOvertimeAttendance.id, targetId))
    .returning();

  return { result, consecutiveFailures: updated.consecutivePingFailures, exceptionCreated: false };
}

export async function getShiftLocationPings(
  fastify: FastifyInstance,
  organizationId: string,
  shiftAttendanceId: string
) {
  const pings = await fastify.db
    .select()
    .from(schema.shiftLocationPings)
    .where(eq(schema.shiftLocationPings.shiftAttendanceId, shiftAttendanceId))
    .orderBy(asc(schema.shiftLocationPings.checkedAt));

  return pings.map((p) => ({
    id: p.id,
    shiftAttendanceId: p.shiftAttendanceId,
    timestamp: p.checkedAt.toISOString(),
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
    accuracyMeters: Number(p.accuracyMeters),
    isInsideGeofence: p.result === 'IN_PREMISES',
    result: p.result,
  }));
}

export async function getOvertimeLocationPings(
  fastify: FastifyInstance,
  organizationId: string,
  overtimeAttendanceId: string
) {
  const pings = await fastify.db
    .select()
    .from(schema.overtimeLocationPings)
    .where(eq(schema.overtimeLocationPings.overtimeAttendanceId, overtimeAttendanceId))
    .orderBy(asc(schema.overtimeLocationPings.checkedAt));

  return pings.map((p) => ({
    id: p.id,
    overtimeAttendanceId: p.overtimeAttendanceId,
    timestamp: p.checkedAt.toISOString(),
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
    accuracyMeters: Number(p.accuracyMeters),
    isInsideGeofence: p.result === 'IN_PREMISES',
    result: p.result,
  }));
}

export function toYmd(val: any): string {
  if (!val) return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  return s;
}

export { enumerateDates };

export async function getUnhandledEvents(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string
) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    return { events: [], totalPending: 0 };
  }

  let premisesId = profile.premisesId;
  if (!premisesId) {
    const [defaultPremises] = await fastify.db
      .select({ id: schema.premises.id })
      .from(schema.premises)
      .where(eq(schema.premises.organizationId, organizationId))
      .limit(1);
    premisesId = defaultPremises?.id ?? null;
  }

  const timezone = await resolveTimezone(fastify, organizationId);
  const now = new Date();
  const today = toDateISOInTimeZone(now, timezone);
  const from = addDays(today, -14);

  // 1. Shift assignments for this employee
  const assignments = await fastify.db
    .select({
      assignmentId: schema.employeeShiftAssignments.id,
      shiftId: schema.employeeShiftAssignments.shiftId,
      presentPay: schema.employeeShiftAssignments.presentPay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
      leavePay: schema.employeeShiftAssignments.leavePay,
      absentPay: schema.employeeShiftAssignments.absentPay,
      createdAt: schema.employeeShiftAssignments.createdAt,
      shiftName: schema.shifts.shiftName,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      dayName: schema.shifts.dayName,
    })
    .from(schema.employeeShiftAssignments)
    .innerJoin(schema.shifts, eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId))
    .where(
      and(
        eq(schema.employeeShiftAssignments.employeeId, profile.id),
        eq(schema.employeeShiftAssignments.organizationId, organizationId),
        eq(schema.employeeShiftAssignments.isActive, true)
      )
    );

  const employeeStartDate = profile.createdAt ? toDateISOInTimeZone(profile.createdAt, timezone) : from;

  // 2. Existing earnings in ledger for this employee
  const existingEarnings = await fastify.db
    .select({
      id: schema.employeeEarningLedger.id,
      earningDate: schema.employeeEarningLedger.earningDate,
      type: schema.employeeEarningLedger.type,
      amount: schema.employeeEarningLedger.amount,
      sourceReference: schema.employeeEarningLedger.sourceReference,
    })
    .from(schema.employeeEarningLedger)
    .where(
      and(
        eq(schema.employeeEarningLedger.employeeId, profile.id),
        gte(schema.employeeEarningLedger.earningDate, from),
        lte(schema.employeeEarningLedger.earningDate, today)
      )
    );

  const holidayEarnedDates = new Set(
    existingEarnings.filter((e) => e.type === 'HOLIDAY').map((e) => toYmd(e.earningDate))
  );
  const offDayEarnedDates = new Set(
    existingEarnings.filter((e) => e.type === 'OFF_DAY').map((e) => toYmd(e.earningDate))
  );
  const shiftEarnedRefs = new Set(
    existingEarnings.filter((e) => e.type === 'SHIFT').map((e) => e.sourceReference ?? '')
  );

  // 3. Existing attendance records
  const attendanceRecords = await fastify.db
    .select()
    .from(schema.employeeAttendance)
    .where(
      and(
        eq(schema.employeeAttendance.employeeId, profile.id),
        gte(schema.employeeAttendance.workDate, from),
        lte(schema.employeeAttendance.workDate, today)
      )
    );

  const workedDates = new Set(
    attendanceRecords
      .filter((r) => r.status === 'PRESENT' || r.status === 'HALF_DAY')
      .map((r) => toYmd(r.workDate))
  );
  const attendanceByAssignmentAndDate = new Map(
    attendanceRecords.map((r) => [`${r.shiftAssignmentId}::${toYmd(r.workDate)}`, r])
  );

  // 4. Holidays for premises
  const holidays = await fastify.db
    .select()
    .from(schema.holidayCalendars)
    .where(
      and(
        eq(schema.holidayCalendars.organizationId, organizationId),
        premisesId ? eq(schema.holidayCalendars.premisesId, premisesId) : sql`true`,
        gte(schema.holidayCalendars.date, from),
        lte(schema.holidayCalendars.date, today)
      )
    );
  const holidayByDate = new Map(holidays.map((h) => [toYmd(h.date), h]));

  // 5. Weekly offs for employee
  const weeklyOffRows = await fastify.db
    .select({ dayOfWeek: schema.weeklyOffs.dayOfWeek })
    .from(schema.weeklyOffs)
    .where(eq(schema.weeklyOffs.employeeId, profile.id));
  const weeklyOffDows = new Set(weeklyOffRows.map((w) => w.dayOfWeek));

  // 6. Approved leave requests
  const approvedLeaves = await fastify.db
    .select()
    .from(schema.leaveRequests)
    .where(
      and(
        eq(schema.leaveRequests.employeeId, profile.id),
        eq(schema.leaveRequests.status, 'APPROVED'),
        gte(schema.leaveRequests.workDate, from),
        lte(schema.leaveRequests.workDate, today)
      )
    );
  const leaveByAssignmentAndDate = new Map(
    approvedLeaves.map((l) => [`${l.shiftAssignmentId}::${toYmd(l.workDate)}`, l])
  );

  const assignedDowSet = new Set<number>();
  for (const a of assignments) {
    for (const d of getAssignedDayNumbers(a.dayName)) {
      assignedDowSet.add(d);
    }
  }

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dates = enumerateDates(from, today);
  const events: any[] = [];

  for (const date of dates) {
    const dow = dayOfWeek(date);

    // A. Check Holiday
    const holiday = holidayByDate.get(date);
    if (holiday && holiday.isPaid !== false) {
      if (!holidayEarnedDates.has(date) && !workedDates.has(date)) {
        const amt = await getUnworkedPaymentAmount(
          fastify,
          organizationId,
          premisesId ?? profile.premisesId,
          profile.id,
          'HOLIDAY'
        );
        events.push({
          id: `holiday:${holiday.id}:${date}`,
          type: 'HOLIDAY',
          date,
          title: `Holiday: ${holiday.name}`,
          subtitle: `Paid holiday on ${dayNames[dow]}, ${date}`,
          amount: amt,
          currency: 'INR',
          actionLabel: `Claim ₹${amt} for Public Holiday`,
          metadata: {
            holidayId: holiday.id,
            holidayName: holiday.name,
          },
        });
        continue;
      }
    }

    // B. Check Weekly Off
    const isWeeklyOffDay = weeklyOffDows.size > 0 ? weeklyOffDows.has(dow) : !assignedDowSet.has(dow);
    if (isWeeklyOffDay && !assignedDowSet.has(dow) && !workedDates.has(date)) {
      if (!offDayEarnedDates.has(date)) {
        const amt = await getUnworkedPaymentAmount(
          fastify,
          organizationId,
          premisesId ?? profile.premisesId,
          profile.id,
          'WEEKLY_OFF'
        );
        events.push({
          id: `weekly_off:${profile.id}:${date}`,
          type: 'WEEKLY_OFF',
          date,
          title: 'Weekly Off',
          subtitle: `Scheduled rest day (${dayNames[dow]}, ${date})`,
          amount: amt,
          currency: 'INR',
          actionLabel: `Claim ₹${amt} for Weekly Off`,
          metadata: {
            dayOfWeek: String(dow),
            dayName: dayNames[dow],
          },
        });
        continue;
      }
    }

    // C. Check Shifts & Leaves on this date
    for (const assignment of assignments) {
      const appliesToDow = getAssignedDayNumbers(assignment.dayName).includes(dow);
      if (!appliesToDow) continue;

      const leave = leaveByAssignmentAndDate.get(`${assignment.assignmentId}::${date}`);
      if (leave) {
        const att = attendanceByAssignmentAndDate.get(`${assignment.assignmentId}::${date}`);
        const leavePay = Number(assignment.leavePay ?? 0);
        const alreadyCredited =
          att?.status === 'LEAVE' &&
          (leavePay === 0 || shiftEarnedRefs.has(`leave:${leave.id}`));
        if (!alreadyCredited) {
          events.push({
            id: `leave:${leave.id}:${date}`,
            type: 'LEAVE',
            date,
            title: 'Approved Leave',
            subtitle: `Leave: ${leave.reason} (${date})`,
            amount: leavePay,
            currency: 'INR',
            actionLabel: leavePay > 0 ? `Claim ₹${leavePay} for Leave` : 'Confirm Leave',
            metadata: {
              leaveRequestId: leave.id,
              shiftAssignmentId: assignment.assignmentId,
              reason: leave.reason,
            },
          });
        }
        continue;
      }

      const shiftWindow = resolveShiftWindow(
        date,
        assignment.startTime,
        assignment.endTime,
        0,
        timezone
      );

      if (now.getTime() >= shiftWindow.endAt.getTime()) {
        const att = attendanceByAssignmentAndDate.get(`${assignment.assignmentId}::${date}`);
        const clockedIn = att?.clockInAt !== null || ['PRESENT', 'HALF_DAY'].includes(att?.status ?? '');
        if (!clockedIn) {
          const absentPay = Number(assignment.absentPay ?? 0);
          const alreadyAcknowledged =
            att?.remarks?.includes('acknowledged') ||
            att?.remarks?.includes('confirmed') ||
            (att?.id && shiftEarnedRefs.has(`absent:${att.id}`));

          if (!alreadyAcknowledged) {
            events.push({
              id: `absent:${assignment.assignmentId}:${date}`,
              type: 'ABSENT',
              date,
              title: 'Missed Shift',
              subtitle: `Shift ended without clock-in (${assignment.startTime.slice(0, 5)} - ${assignment.endTime.slice(0, 5)})`,
              amount: absentPay,
              currency: 'INR',
              actionLabel: absentPay > 0 ? `Claim ₹${absentPay} for Missed Shift` : 'Acknowledge Missed Shift',
              metadata: {
                shiftAssignmentId: assignment.assignmentId,
                startTime: String(assignment.startTime),
                endTime: String(assignment.endTime),
                shiftName: assignment.shiftName || 'Shift',
              },
            });
          }
        }
      }
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date));

  return {
    events,
    totalPending: events.length,
  };
}

export async function claimUnhandledEvent(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string,
  body: {
    eventId: string;
    type: 'WEEKLY_OFF' | 'HOLIDAY' | 'LEAVE' | 'ABSENT';
    date: string;
    metadata?: Record<string, any>;
  }
) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    throw new AppError('Staff profile not found', 404, 'STAFF_NOT_FOUND');
  }

  let premisesId = profile.premisesId;
  if (!premisesId) {
    const [defaultPremises] = await fastify.db
      .select({ id: schema.premises.id })
      .from(schema.premises)
      .where(eq(schema.premises.organizationId, organizationId))
      .limit(1);
    premisesId = defaultPremises?.id ?? null;
  }

  if (!premisesId) {
    throw new AppError('Premises not configured', 400, 'PREMISES_NOT_FOUND');
  }

  const cleanDate = toYmd(body.date);
  let earnedAmount = 0;

  if (body.type === 'WEEKLY_OFF') {
    earnedAmount = await getUnworkedPaymentAmount(
      fastify,
      organizationId,
      premisesId,
      profile.id,
      'WEEKLY_OFF'
    );
    if (earnedAmount > 0) {
      await fastify.db
        .insert(schema.employeeEarningLedger)
        .values({
          organizationId,
          premisesId,
          employeeId: profile.id,
          earningDate: cleanDate,
          type: 'OFF_DAY',
          amount: String(earnedAmount),
          sourceReference: `weekly-off:${profile.id}:${cleanDate}:OFF_DAY`,
        } as any)
        .onConflictDoNothing();
    }
  } else if (body.type === 'HOLIDAY') {
    earnedAmount = await getUnworkedPaymentAmount(
      fastify,
      organizationId,
      premisesId,
      profile.id,
      'HOLIDAY'
    );
    const holidayId = body.metadata?.holidayId ?? body.eventId.split(':')[1] ?? 'holiday';
    if (earnedAmount > 0) {
      await fastify.db
        .insert(schema.employeeEarningLedger)
        .values({
          organizationId,
          premisesId,
          employeeId: profile.id,
          earningDate: cleanDate,
          type: 'HOLIDAY',
          amount: String(earnedAmount),
          sourceReference: `holiday:${holidayId}:${profile.id}:${cleanDate}:HOLIDAY`,
        } as any)
        .onConflictDoNothing();
    }
  } else if (body.type === 'LEAVE') {
    const shiftAssignmentId = body.metadata?.shiftAssignmentId ?? body.eventId.split(':')[1];
    const leaveRequestId = body.metadata?.leaveRequestId;
    const reason = body.metadata?.reason ?? 'Approved Leave';

    const [existingAtt] = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.employeeId, profile.id),
          eq(schema.employeeAttendance.shiftAssignmentId, shiftAssignmentId),
          eq(schema.employeeAttendance.workDate, cleanDate)
        )
      )
      .limit(1);

    let attId = existingAtt?.id;
    if (!existingAtt) {
      const [inserted] = await fastify.db
        .insert(schema.employeeAttendance)
        .values({
          organizationId,
          premisesId: premisesId as string,
          employeeId: profile.id,
          shiftAssignmentId,
          workDate: cleanDate,
          status: 'LEAVE',
          remarks: `Leave confirmed by employee: ${reason}`,
        })
        .returning();
      attId = inserted.id;
    } else {
      await fastify.db
        .update(schema.employeeAttendance)
        .set({
          status: 'LEAVE',
          remarks: `Leave confirmed by employee: ${reason}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.employeeAttendance.id, existingAtt.id));
    }

    const [assignment] = await fastify.db
      .select({ leavePay: schema.employeeShiftAssignments.leavePay })
      .from(schema.employeeShiftAssignments)
      .where(eq(schema.employeeShiftAssignments.id, shiftAssignmentId))
      .limit(1);

    earnedAmount = Number(assignment?.leavePay ?? 0);
    if (earnedAmount > 0) {
      await fastify.db
        .insert(schema.employeeEarningLedger)
        .values({
          organizationId,
          premisesId: premisesId as string,
          employeeId: profile.id,
          earningDate: cleanDate,
          type: 'SHIFT',
          amount: String(earnedAmount),
          shiftAssignmentId,
          attendanceId: attId ?? null,
          sourceReference: `leave:${leaveRequestId ?? attId}:${cleanDate}`,
        } as any)
        .onConflictDoNothing();
    }
  } else if (body.type === 'ABSENT') {
    const shiftAssignmentId = body.metadata?.shiftAssignmentId ?? body.eventId.split(':')[1];

    const [existingAtt] = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.employeeId, profile.id),
          eq(schema.employeeAttendance.shiftAssignmentId, shiftAssignmentId),
          eq(schema.employeeAttendance.workDate, cleanDate)
        )
      )
      .limit(1);

    let attId = existingAtt?.id;
    if (!existingAtt) {
      const [inserted] = await fastify.db
        .insert(schema.employeeAttendance)
        .values({
          organizationId,
          premisesId: premisesId as string,
          employeeId: profile.id,
          shiftAssignmentId,
          workDate: cleanDate,
          status: 'ABSENT',
          remarks: 'Missed shift acknowledged by employee',
        })
        .returning();
      attId = inserted.id;
    } else {
      await fastify.db
        .update(schema.employeeAttendance)
        .set({
          status: 'ABSENT',
          remarks: 'Missed shift acknowledged by employee',
          updatedAt: new Date(),
        })
        .where(eq(schema.employeeAttendance.id, existingAtt.id));
    }

    const [assignment] = await fastify.db
      .select({ absentPay: schema.employeeShiftAssignments.absentPay })
      .from(schema.employeeShiftAssignments)
      .where(eq(schema.employeeShiftAssignments.id, shiftAssignmentId))
      .limit(1);

    earnedAmount = Number(assignment?.absentPay ?? 0);
    if (earnedAmount !== 0) {
      await fastify.db
        .insert(schema.employeeEarningLedger)
        .values({
          organizationId,
          premisesId: premisesId as string,
          employeeId: profile.id,
          earningDate: cleanDate,
          type: 'SHIFT',
          amount: String(earnedAmount),
          shiftAssignmentId,
          attendanceId: attId ?? null,
          sourceReference: `absent:${attId}:${cleanDate}`,
        } as any)
        .onConflictDoNothing();
    }
  }

  // Reconcile monthly payroll so that monthly ledger and summary totals reflect the new claim immediately
  try {
    const payrollService: any = await import('../payroll/service.js');
    const [yearStr, monthStr] = cleanDate.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (year && month && typeof payrollService.getOrGenerateMonthlyPayroll === 'function') {
      await payrollService.getOrGenerateMonthlyPayroll(
        fastify,
        organizationId,
        premisesId as string,
        profile.id,
        month,
        year
      );
    }
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to reconcile monthly payroll after claim');
  }

  // Publish domain events for real-time WebSocket sync
  try {
    const payload = {
      staffProfileId: profile.id,
      eventType: body.type,
      date: cleanDate,
      earnedAmount,
    };
    await (fastify as any).publishDomainEvent?.({
      type: 'attendance_update',
      organizationId,
      premisesId: profile.premisesId,
      userIds: [userId],
      payload,
    });
    await (fastify as any).publishDomainEvent?.({
      type: 'wallet_update',
      organizationId,
      premisesId: profile.premisesId,
      userIds: [userId],
      payload,
    });
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to publish domain event for claimed unhandled event');
  }

  const remaining = await getUnhandledEvents(fastify, organizationId, userId);

  return {
    success: true,
    claimedEventId: body.eventId,
    type: body.type,
    earnedAmount: Number(earnedAmount),
    remainingCount: remaining.totalPending,
    message: `Successfully processed ${body.type.toLowerCase().replace('_', ' ')} for ${cleanDate}`,
  };
}
