import { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import {
  evaluateGeofence,
  haversineDistanceMeters,
  roundDistanceMeters,
  DEFAULT_GEOFENCE_RADIUS_METERS,
} from '../../shared/utils/geo.js';
import { AppError } from '../../shared/errors/app-error.js';
import { createNotification } from '../../shared/services/notification.service.js';
import {
  findStaffProfile,
  listOwnerUserIds,
  resolveNotificationTargets,
} from '../../shared/services/staff.service.js';
import { toDateISOInTimeZone } from '../../shared/utils/datetime.js';
import { resolveTimezone } from '../shifts/service.js';
import {
  GpsPingSummary,
  LocationStaffCard,
  LocationTodayPresenceResponse,
} from './schemas.js';

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

/**
 * The GPS exception is advisory and is raised once more than three outside
 * readings have accumulated for the active attendance session.
 */
export function shouldRaiseOutsideAlert(
  outsidePingCount: number,
  monitoringAlertAt: Date | null | undefined
): boolean {
  return outsidePingCount > 3 && monitoringAlertAt == null;
}

function mapPingStatus(
  result: (typeof schema.locationCheckResultEnum.enumValues)[number]
): GpsPingSummary['status'] {
  switch (result) {
    case 'IN_PREMISES':
      return 'Inside';
    case 'OUTSIDE':
      return 'Outside';
    case 'LOW_ACCURACY':
      return 'Uncertain';
    case 'STALE':
      return 'Stale';
    case 'MOCKED':
      return 'Mocked';
    default:
      return 'No location';
  }
}

/**
 * Persists a periodic active-shift GPS ping and atomically updates the
 * denormalised counters on `employee_attendance`.
 *
 * Three consecutive failures only raise an alert/exception; the employee is
 * never automatically marked absent.
 */
export async function submitLocationCheck(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string,
  body: {
    attendanceEventId: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    isMock?: boolean;
    timestamp?: string;
    clientRequestId?: string;
  }
): Promise<{
  result: string;
  consecutiveFailures: number;
  exceptionCreated: boolean;
}> {
  const {
    attendanceEventId,
    latitude,
    longitude,
    accuracyMeters,
    isMock,
    timestamp,
    clientRequestId,
  } = body;

  const [event] = await fastify.db
    .select()
    .from(schema.employeeAttendance)
    .where(
      and(
        eq(schema.employeeAttendance.id, attendanceEventId),
        eq(schema.employeeAttendance.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!event) {
    throw new AppError(
      'Attendance event not found',
      404,
      'ATTENDANCE_EVENT_NOT_FOUND'
    );
  }

  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile || profile.id !== event.employeeId) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }

  if (!event.clockInAt) {
    throw new AppError(
      'Location monitoring can only start after clock-in.',
      409,
      'ATTENDANCE_NOT_CLOCKED_IN'
    );
  }

  if (event.clockOutAt) {
    throw new AppError(
      'Location monitoring has stopped for this attendance.',
      409,
      'ATTENDANCE_ALREADY_CLOSED'
    );
  }

  if (clientRequestId) {
    const [existingPing] = await fastify.db
      .select()
      .from(schema.attendanceLocationPings)
      .where(
        and(
          eq(schema.attendanceLocationPings.attendanceId, attendanceEventId),
          eq(schema.attendanceLocationPings.clientRequestId, clientRequestId)
        )
      )
      .limit(1);

    if (existingPing) {
      return {
        result: existingPing.result,
        consecutiveFailures: event.consecutivePingFailures,
        exceptionCreated: false,
      };
    }
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

  // The server's receive time is authoritative for freshness. A client-provided
  // capture time can only make a ping older (e.g. drained from the offline
  // outbox), never fresher.
  const checkedAt = new Date();
  const capturedAt = timestamp ? new Date(timestamp) : checkedAt;
  const effectiveCapturedAt =
    Number.isNaN(capturedAt.getTime()) || capturedAt > checkedAt
      ? checkedAt
      : capturedAt;
  let result: (typeof schema.locationCheckResultEnum.enumValues)[number] =
    'UNKNOWN';

  if (isMock) {
    result = 'MOCKED';
  } else if (accuracyMeters > MAX_ACCURACY) {
    result = 'LOW_ACCURACY';
  } else if (isStale(effectiveCapturedAt, checkedAt)) {
    result = 'STALE';
  } else if (premises) {
    const evaluation = evaluateGeofence(
      {
        latitude,
        longitude,
        accuracyMeters,
        isMocked: false,
        capturedAt: checkedAt,
      },
      {
        latitude: Number(premises.latitude),
        longitude: Number(premises.longitude),
        radiusMeters: Number(
          premises.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS
        ),
      }
    );
    result =
      evaluation.result === 'IN_PREMISES'
        ? 'IN_PREMISES'
        : evaluation.result === 'OUTSIDE'
          ? 'OUTSIDE'
          : evaluation.result === 'LOW_ACCURACY'
            ? 'LOW_ACCURACY'
            : evaluation.result === 'MOCKED'
              ? 'MOCKED'
              : evaluation.result === 'STALE'
                ? 'STALE'
                : 'UNKNOWN';
  }

  try {
    await fastify.db.insert(schema.attendanceLocationPings).values({
      attendanceId: attendanceEventId,
      checkedAt,
      latitude: latitude.toFixed(7),
      longitude: longitude.toFixed(7),
      accuracyMeters: accuracyMeters.toFixed(2),
      result,
      clientRequestId: clientRequestId ?? null,
    });
  } catch (error) {
    if (clientRequestId && (error as { code?: string })?.code === '23505') {
      // Still enforce retention of only last 3 pings even on duplicate
      const recentPings = await fastify.db
        .select({ id: schema.attendanceLocationPings.id })
        .from(schema.attendanceLocationPings)
        .where(eq(schema.attendanceLocationPings.attendanceId, attendanceEventId))
        .orderBy(desc(schema.attendanceLocationPings.checkedAt), desc(schema.attendanceLocationPings.createdAt))
        .limit(10);

      if (recentPings.length > 3) {
        const idsToDelete = recentPings.slice(3).map((p) => p.id);
        if (idsToDelete.length > 0) {
          await fastify.db
            .delete(schema.attendanceLocationPings)
            .where(inArray(schema.attendanceLocationPings.id, idsToDelete));
        }
      }
      return {
        result,
        consecutiveFailures: event.consecutivePingFailures,
        exceptionCreated: false,
      };
    }
    throw error;
  }

  // Keep only the last 3 location pings per attendance for lightweight storage
  const recentPings = await fastify.db
    .select({ id: schema.attendanceLocationPings.id })
    .from(schema.attendanceLocationPings)
    .where(eq(schema.attendanceLocationPings.attendanceId, attendanceEventId))
    .orderBy(desc(schema.attendanceLocationPings.checkedAt), desc(schema.attendanceLocationPings.createdAt))
    .limit(10);

  if (recentPings.length > 3) {
    const idsToDelete = recentPings.slice(3).map((p) => p.id);
    if (idsToDelete.length > 0) {
      await fastify.db
        .delete(schema.attendanceLocationPings)
        .where(inArray(schema.attendanceLocationPings.id, idsToDelete));
    }
  }

  const inside = result === 'IN_PREMISES';
  const failure = FAILURE_RESULTS.has(result);

  const [updated] = await fastify.db
    .update(schema.employeeAttendance)
    .set({
      insidePingCount: inside
        ? sql`${schema.employeeAttendance.insidePingCount} + 1`
        : schema.employeeAttendance.insidePingCount,
      outsidePingCount: !inside
        ? sql`${schema.employeeAttendance.outsidePingCount} + 1`
        : schema.employeeAttendance.outsidePingCount,
      consecutivePingFailures: failure
        ? sql`${schema.employeeAttendance.consecutivePingFailures} + 1`
        : inside
          ? 0
          : schema.employeeAttendance.consecutivePingFailures,
      lastPingAt: checkedAt,
      lastPingResult: result,
      lastSuccessfulPingAt: inside
        ? checkedAt
        : schema.employeeAttendance.lastSuccessfulPingAt,
      monitoringAlertAt: inside
        ? null
        : schema.employeeAttendance.monitoringAlertAt,
      updatedAt: new Date(),
    })
    .where(eq(schema.employeeAttendance.id, attendanceEventId))
    .returning();

  const consecutiveFailures = updated.consecutivePingFailures;
  const outsidePingCount = updated.outsidePingCount;
  // The monitoring exception is raised once more than three outside readings
  // have accumulated for this shift. It is advisory only: attendance is never
  // automatically marked absent.
  const exceptionCreated =
    shouldRaiseOutsideAlert(outsidePingCount, updated.monitoringAlertAt);

  if (exceptionCreated) {
    await fastify.db
      .update(schema.employeeAttendance)
      .set({ monitoringAlertAt: new Date() })
      .where(eq(schema.employeeAttendance.id, attendanceEventId));

    const targets = await resolveNotificationTargets(
      fastify,
      organizationId,
      event.employeeId,
      true,
      event.premisesId
    );
    const ownerIds = await listOwnerUserIds(fastify, organizationId);
    const allTargets = Array.from(new Set([...ownerIds, ...targets]));

    for (const targetUserId of allTargets) {
      await createNotification(fastify, {
        organizationId,
        userId: targetUserId,
        type: 'GPS_FAILURE_ALERT',
        title: 'Location monitoring exception',
        body: 'More than three outside GPS/location readings have been recorded during this active shift. Owner/Manager review is required; attendance is not automatically marked absent.',
        dedupeKey: `gps-outside:${attendanceEventId}:${outsidePingCount}`,
        metadata: {
          attendanceEventId,
          staffProfileId: event.employeeId,
          consecutiveFailures,
          outsidePingCount,
        },
      });
    }
  }

  if (fastify.publishDomainEvent) {
    await fastify.publishDomainEvent({
      type: 'location_check_updated',
      organizationId,
      userIds: profile.userId ? [profile.userId] : [],
      payload: {
        staffProfileId: event.employeeId,
        attendanceEventId,
        result,
        consecutiveFailures,
      },
    });
  }

  return {
    result,
    consecutiveFailures,
    exceptionCreated,
  };
}

export async function getActiveLocationSession(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string
): Promise<{
  attendanceEventId: string | null;
  isActive: boolean;
  consecutiveFailures: number;
}> {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    return { attendanceEventId: null, isActive: false, consecutiveFailures: 0 };
  }

  const [event] = await fastify.db
    .select({
      id: schema.employeeAttendance.id,
      consecutivePingFailures: schema.employeeAttendance.consecutivePingFailures,
    })
    .from(schema.employeeAttendance)
    .where(
      and(
        eq(schema.employeeAttendance.organizationId, organizationId),
        eq(schema.employeeAttendance.employeeId, profile.id),
        isNull(schema.employeeAttendance.clockOutAt),
        sql`${schema.employeeAttendance.clockInAt} IS NOT NULL`,
        sql`${schema.employeeAttendance.status} NOT IN ('SCHEDULED', 'ABSENT', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF')`
      )
    )
    .orderBy(desc(schema.employeeAttendance.clockInAt))
    .limit(1);

  if (!event) {
    return { attendanceEventId: null, isActive: false, consecutiveFailures: 0 };
  }

  return {
    attendanceEventId: event.id,
    isActive: true,
    consecutiveFailures: event.consecutivePingFailures,
  };
}

export async function getTodayLocationPresence(
  fastify: FastifyInstance,
  user: { userId: string; role: 'OWNER' | 'MANAGER' | 'STAFF' },
  organizationId: string,
  premisesIdParam?: string,
  dateParam?: string
): Promise<LocationTodayPresenceResponse> {
  const timezone = await resolveTimezone(fastify, organizationId);
  const targetDate = dateParam ?? toDateISOInTimeZone(new Date(), timezone);
  const dateObj = new Date(`${targetDate}T00:00:00Z`);
  const dayNames = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const dayOfWeekStr = dayNames[dateObj.getUTCDay()] ?? 'Monday';

  const allPremises = await fastify.db
    .select()
    .from(schema.premises)
    .where(
      and(
        eq(schema.premises.organizationId, organizationId),
        eq(schema.premises.isActive, true)
      )
    );

  if (allPremises.length === 0) {
    return {
      premisesId: null,
      premisesName: null,
      address: null,
      latitude: null,
      longitude: null,
      radiusMeters: null,
      date: targetDate,
      staff: [],
    };
  }

  let targetPremises = allPremises[0];

  if (premisesIdParam) {
    const found = allPremises.find((p) => p.id === premisesIdParam);
    if (found) targetPremises = found;
  } else if (user.role === 'MANAGER') {
    const [managerProfile] = await fastify.db
      .select({ premisesId: schema.employees.premisesId })
      .from(schema.employees)
      .where(
        and(
          eq(schema.employees.organizationId, organizationId),
          eq(schema.employees.userId, user.userId),
          eq(schema.employees.isActive, true)
        )
      )
      .limit(1);

    if (managerProfile?.premisesId) {
      const found = allPremises.find((p) => p.id === managerProfile.premisesId);
      if (found) targetPremises = found;
    }
  }

  const staffRows = await fastify.db
    .select({
      id: schema.employees.id,
      userId: schema.employees.userId,
      role: schema.employees.role,
      staffCode: schema.employees.employeeCode,
      fullName: schema.users.fullName,
      avatarUrl: schema.users.avatarUrl,
      premisesId: schema.employees.premisesId,
    })
    .from(schema.employees)
    .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        eq(schema.employees.isActive, true),
        eq(schema.users.isActive, true)
      )
    );

  const filteredStaff = staffRows.filter(
    (staff) => staff.premisesId === targetPremises.id && staff.userId !== null
  ) as Array<(typeof staffRows)[number] & { userId: string }>;

  const staffCards: LocationStaffCard[] = [];

  for (const staff of filteredStaff) {
    const attendanceRows = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.organizationId, organizationId),
          eq(schema.employeeAttendance.employeeId, staff.id),
          eq(schema.employeeAttendance.workDate, targetDate)
        )
      )
      .orderBy(desc(schema.employeeAttendance.createdAt));

    const shiftEvent =
      attendanceRows.find((row) => row.attendanceType === 'SHIFT') ??
      attendanceRows[0] ??
      null;
    const overtimeEvent =
      attendanceRows.find((row) => row.attendanceType === 'OVERTIME') ?? null;

    let shiftStart: string | null = null;
    let shiftEnd: string | null = null;
    let shiftName = 'No shift assigned';

    const [assignment] = await fastify.db
      .select({
        shiftName: schema.shifts.shiftName,
        startTime: schema.shifts.startTime,
        endTime: schema.shifts.endTime,
      })
      .from(schema.employeeShiftAssignments)
      .innerJoin(
        schema.shifts,
        eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId)
      )
      .where(
        and(
          eq(schema.employeeShiftAssignments.employeeId, staff.id),
          eq(schema.employeeShiftAssignments.organizationId, organizationId),
          eq(schema.employeeShiftAssignments.isActive, true)
        )
      )
      .limit(1);

    if (assignment) {
      shiftName = assignment.shiftName;
      shiftStart = String(assignment.startTime);
      shiftEnd = String(assignment.endTime);
    }

    const [overtimeRecord] = await fastify.db
      .select()
      .from(schema.overtime)
      .where(
        and(
          eq(schema.overtime.organizationId, organizationId),
          eq(schema.overtime.employeeId, staff.id),
          eq(schema.overtime.workDate, targetDate)
        )
      )
      .limit(1);

    const pings = shiftEvent
      ? await fastify.db
          .select()
          .from(schema.attendanceLocationPings)
          .where(
            eq(schema.attendanceLocationPings.attendanceId, shiftEvent.id)
          )
          .orderBy(desc(schema.attendanceLocationPings.checkedAt))
      : [];

    const openExceptionId =
      shiftEvent &&
      shiftEvent.correctedAt == null &&
      (shiftEvent.monitoringAlertAt != null || shiftEvent.outsidePingCount > 3)
        ? shiftEvent.id
        : null;

    let missedCount = 0;
    if (shiftEvent?.clockInAt) {
      const clockInMs = new Date(shiftEvent.clockInAt).getTime();
      const endMs = shiftEvent.clockOutAt
        ? new Date(shiftEvent.clockOutAt).getTime()
        : Date.now();
      const expectedIntervals = Math.floor(
        Math.max(0, endMs - clockInMs) / (10 * 60_000)
      );
      // Missed count = expected intervals not yet submitted (accounting for last 3 stored)
      missedCount = Math.max(0, expectedIntervals - pings.length);
      if (missedCount > 0 && pings.length === 0) {
        missedCount = expectedIntervals;
      }
    }

    let locationStatus:
      | 'Inside'
      | 'Outside'
      | 'GPS Uncertain'
      | 'GPS Unavailable' = 'GPS Unavailable';

    if (shiftEvent?.lastPingResult === 'IN_PREMISES') {
      locationStatus = 'Inside';
    } else if (
      shiftEvent?.lastPingResult === 'OUTSIDE' ||
      shiftEvent?.lastPingResult === 'MOCKED'
    ) {
      locationStatus = 'Outside';
    } else if (shiftEvent?.lastPingResult === 'LOW_ACCURACY') {
      locationStatus = 'GPS Uncertain';
    }

    const latestPings: GpsPingSummary[] = pings.slice(0, 3).map((ping) => {
      const lat = Number(ping.latitude);
      const lng = Number(ping.longitude);
      const distance = haversineDistanceMeters(
        lat,
        lng,
        Number(targetPremises.latitude),
        Number(targetPremises.longitude)
      );

      return {
        id: ping.id,
        checkTime: ping.checkedAt.toISOString(),
        distanceMeters: Number.isFinite(distance)
          ? roundDistanceMeters(distance)
          : null,
        accuracyMeters:
          ping.accuracyMeters == null ? null : Number(ping.accuracyMeters),
        status: mapPingStatus(ping.result),
      };
    });

    const attendanceStatus = shiftEvent
      ? shiftEvent.status
      : assignment
        ? 'SCHEDULED'
        : 'NOT_RECORDED';

    const clockIn = shiftEvent?.clockInAt
      ? new Date(shiftEvent.clockInAt).toISOString()
      : null;
    const clockOut = shiftEvent?.clockOutAt
      ? new Date(shiftEvent.clockOutAt).toISOString()
      : null;

    const overtimeClockIn =
      overtimeEvent?.clockInAt
        ? new Date(overtimeEvent.clockInAt).toISOString()
        : null;
    const overtimeClockOut =
      overtimeEvent?.clockOutAt
        ? new Date(overtimeEvent.clockOutAt).toISOString()
        : null;

    staffCards.push({
      staffProfileId: staff.id,
      userId: staff.userId,
      fullName: staff.fullName,
      role: staff.role ?? 'STAFF',
      staffCode: staff.staffCode,
      avatarUrl: staff.avatarUrl,
      premisesId: staff.premisesId,
      premisesName: targetPremises.name,
      attendanceStatus,
      locationStatus,
      dayOfWeek: dayOfWeekStr,
      shiftName,
      overtimeName:
        overtimeRecord?.reason ||
        (overtimeRecord ? 'Overtime Shift' : null),
      regularShiftStartTime: shiftStart,
      regularShiftEndTime: shiftEnd,
      overtimeStartTime: overtimeRecord?.startTime
        ? String(overtimeRecord.startTime)
        : null,
      overtimeEndTime: overtimeRecord?.endTime
        ? String(overtimeRecord.endTime)
        : null,
      clockInTime: clockIn,
      clockOutTime: clockOut,
      overtimeClockInTime: overtimeClockIn,
      overtimeClockOutTime: overtimeClockOut,
      shiftStatus: shiftEvent
        ? shiftEvent.status
        : assignment
          ? 'SCHEDULED'
          : 'NOT_SCHEDULED',
      hasOvertimeToday: Boolean(overtimeRecord),
      overtimeId: overtimeRecord?.id ?? null,
      consecutiveFailures: shiftEvent?.consecutivePingFailures ?? 0,
      exceptionId: openExceptionId,
      counts: {
        inside: shiftEvent?.insidePingCount ?? 0,
        outside: shiftEvent?.outsidePingCount ?? 0,
        missed: missedCount,
      },
      latestPings,
    });
  }

  return {
    premisesId: targetPremises.id,
    premisesName: targetPremises.name,
    address: targetPremises.address ?? null,
    latitude: String(targetPremises.latitude),
    longitude: String(targetPremises.longitude),
    radiusMeters: targetPremises.radiusMeters,
    date: targetDate,
    staff: staffCards,
  };
}
