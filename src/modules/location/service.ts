import { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
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
import {
  GpsPingSummary,
  LocationStaffCard,
  LocationTodayPresenceResponse,
} from './schemas.js';

const MAX_ACCURACY = 30;
const MAX_AGE_MINUTES = 2;

function isStale(timestamp: Date | null | undefined): boolean {
  if (!timestamp) {
    return true;
  }
  const diffMs = Date.now() - timestamp.getTime();
  return diffMs > MAX_AGE_MINUTES * 60 * 1000;
}

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
  }
): Promise<{ result: string; consecutiveFailures: number; exceptionCreated: boolean }> {
  const { attendanceEventId, latitude, longitude, accuracyMeters, isMock, timestamp } = body;

  const [event] = await fastify.db
    .select()
    .from(schema.attendanceEvents)
    .where(eq(schema.attendanceEvents.id, attendanceEventId))
    .limit(1);

  if (!event) {
    throw new AppError('Attendance event not found', 404, 'ATTENDANCE_EVENT_NOT_FOUND');
  }

  const [profile] = await fastify.db
    .select()
    .from(schema.staffProfiles)
    .where(eq(schema.staffProfiles.id, event.staffProfileId))
    .limit(1);

  if (!profile || profile.organizationId !== organizationId) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }

  const premisesList = await fastify.db
    .select()
    .from(schema.premises)
    .where(
      and(
        eq(schema.premises.organizationId, organizationId),
        eq(schema.premises.isActive, true)
      )
    );

  let result: (typeof schema.locationCheckResultEnum.enumValues)[number] = 'UNKNOWN';

  if (isMock) {
    result = 'MOCKED';
  } else if (accuracyMeters > MAX_ACCURACY) {
    result = 'LOW_ACCURACY';
  } else if (isStale(timestamp ? new Date(timestamp) : new Date())) {
    result = 'STALE';
  } else if (premisesList.length === 0) {
    result = 'UNKNOWN';
  } else {
    const premises = premisesList.find((p) => p.id === event.premisesId) ?? premisesList[0];
    const evalResult = evaluateGeofence(
      {
        latitude,
        longitude,
        accuracyMeters,
        isMocked: false,
        capturedAt: timestamp ? new Date(timestamp) : new Date(),
      },
      {
        latitude: Number(premises.latitude),
        longitude: Number(premises.longitude),
        radiusMeters: Number(
          (premises as any).radiusMeters ??
            (premises as any).geofenceRadiusMeters ??
            DEFAULT_GEOFENCE_RADIUS_METERS
        ),
      }
    );
    if (evalResult.result === 'IN_PREMISES') {
      result = 'IN_PREMISES';
    } else if (evalResult.result === 'LOW_ACCURACY') {
      result = 'LOW_ACCURACY';
    } else if (evalResult.result === 'OUTSIDE') {
      result = 'OUTSIDE';
    } else if (evalResult.result === 'MOCKED') {
      result = 'MOCKED';
    } else if (evalResult.result === 'STALE') {
      result = 'STALE';
    } else {
      result = 'UNKNOWN';
    }
  }

  let [session] = await fastify.db
    .select()
    .from(schema.locationMonitoringSessions)
    .where(
      and(
        eq(schema.locationMonitoringSessions.attendanceEventId, attendanceEventId),
        eq(schema.locationMonitoringSessions.isActive, true)
      )
    )
    .limit(1);

  if (!session) {
    const [created] = await fastify.db
      .insert(schema.locationMonitoringSessions)
      .values({
        attendanceEventId,
        staffProfileId: event.staffProfileId,
        isActive: true,
        consecutiveFailures: 0,
      })
      .returning();
    session = created;
  }

  await fastify.db.insert(schema.locationCheckEvents).values({
    sessionId: session.id,
    latitude: String(latitude),
    longitude: String(longitude),
    accuracyMeters: String(accuracyMeters),
    result,
  });

  let consecutiveFailures = session.consecutiveFailures ?? 0;
  let exceptionCreated = false;

  if (result === 'IN_PREMISES') {
    consecutiveFailures = 0;
    await fastify.db
      .update(schema.locationMonitoringSessions)
      .set({ consecutiveFailures: 0 })
      .where(eq(schema.locationMonitoringSessions.id, session.id));
  } else if (
    result === 'MOCKED' ||
    result === 'OUTSIDE' ||
    result === 'STALE' ||
    result === 'LOW_ACCURACY'
  ) {
    consecutiveFailures = (session.consecutiveFailures ?? 0) + 1;
    await fastify.db
      .update(schema.locationMonitoringSessions)
      .set({ consecutiveFailures })
      .where(eq(schema.locationMonitoringSessions.id, session.id));

    if (consecutiveFailures >= 3) {
      const existing = await fastify.db
        .select()
        .from(schema.attendanceExceptions)
        .where(
          and(
            eq(schema.attendanceExceptions.attendanceEventId, attendanceEventId),
            eq(schema.attendanceExceptions.reason, 'THREE_GPS_FAILURES'),
            eq(schema.attendanceExceptions.status, 'OPEN')
          )
        )
        .limit(1);

      if (existing.length === 0) {
        await fastify.db.insert(schema.attendanceExceptions).values({
          attendanceEventId,
          reason: 'THREE_GPS_FAILURES',
          status: 'OPEN',
        });
        exceptionCreated = true;

        const targets = await resolveNotificationTargets(
          fastify,
          organizationId,
          event.staffProfileId
        );
        const ownerIds = await listOwnerUserIds(fastify, organizationId);
        const allTargets = Array.from(new Set([...targets, ...ownerIds]));

        for (const targetUserId of allTargets) {
          await createNotification(fastify, {
            organizationId,
            userId: targetUserId,
            type: 'GPS_FAILURE_ALERT',
            title: 'Location monitoring exception',
            body: 'Three consecutive GPS/location check failures detected during an active shift. This requires manager review.',
            dedupeKey: `gps-fail:${attendanceEventId}:${consecutiveFailures}`,
            metadata: { attendanceEventId, staffProfileId: event.staffProfileId, consecutiveFailures },
          });
        }
      }
    }
  }

  if (fastify.publishDomainEvent) {
    await fastify.publishDomainEvent({
      type: 'location_check_updated',
      organizationId,
      userIds: [],
      payload: {
        staffProfileId: event.staffProfileId,
        attendanceEventId,
        result,
        consecutiveFailures,
      },
    });
  }

  return { result: result as string, consecutiveFailures, exceptionCreated };
}

export async function getActiveLocationSession(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string
): Promise<{ attendanceEventId: string | null; isActive: boolean; consecutiveFailures: number }> {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    return { attendanceEventId: null, isActive: false, consecutiveFailures: 0 };
  }

  const [session] = await fastify.db
    .select()
    .from(schema.locationMonitoringSessions)
    .where(
      and(
        eq(schema.locationMonitoringSessions.staffProfileId, profile.id),
        eq(schema.locationMonitoringSessions.isActive, true)
      )
    )
    .limit(1);

  if (!session) {
    return { attendanceEventId: null, isActive: false, consecutiveFailures: 0 };
  }

  return {
    attendanceEventId: session.attendanceEventId ?? null,
    isActive: true,
    consecutiveFailures: session.consecutiveFailures ?? 0,
  };
}

export async function getTodayLocationPresence(
  fastify: FastifyInstance,
  user: { userId: string; role: 'OWNER' | 'MANAGER' | 'STAFF' },
  organizationId: string,
  premisesIdParam?: string,
  dateParam?: string
): Promise<LocationTodayPresenceResponse> {
  const targetDate = dateParam ?? new Date().toISOString().slice(0, 10);
  const dateObj = new Date(targetDate);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOfWeekStr = dayNames[dateObj.getDay()] ?? 'Monday';

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
    if (found) {
      targetPremises = found;
    }
  } else if (user.role === 'MANAGER') {
    const [managerProfile] = await fastify.db
      .select({ premisesId: schema.staffProfiles.premisesId })
      .from(schema.staffProfiles)
      .where(
        and(
          eq(schema.staffProfiles.organizationId, organizationId),
          eq(schema.staffProfiles.userId, user.userId)
        )
      )
      .limit(1);

    if (managerProfile?.premisesId) {
      const found = allPremises.find((p) => p.id === managerProfile.premisesId);
      if (found) {
        targetPremises = found;
      }
    }
  }

  const staffRows = await fastify.db
    .select({
      id: schema.staffProfiles.id,
      userId: schema.staffProfiles.userId,
      role: schema.memberships.role,
      staffCode: schema.staffProfiles.staffCode,
      fullName: schema.users.fullName,
      avatarUrl: schema.users.avatarUrl,
      premisesId: schema.staffProfiles.premisesId,
    })
    .from(schema.staffProfiles)
    .innerJoin(schema.users, eq(schema.users.id, schema.staffProfiles.userId))
    .leftJoin(
      schema.memberships,
      and(
        eq(schema.memberships.userId, schema.staffProfiles.userId),
        eq(schema.memberships.organizationId, organizationId)
      )
    )
    .where(
      and(
        eq(schema.staffProfiles.organizationId, organizationId),
        eq(schema.users.isActive, true)
      )
    );

  const filteredStaff = staffRows.filter(
    (s) => s.premisesId === targetPremises.id || (!s.premisesId && targetPremises.id === allPremises[0].id)
  );

  const staffCards: LocationStaffCard[] = [];

  for (const s of filteredStaff) {
    const [attendanceEvent] = await fastify.db
      .select()
      .from(schema.attendanceEvents)
      .where(
        and(
          eq(schema.attendanceEvents.staffProfileId, s.id),
          eq(schema.attendanceEvents.workDate, targetDate)
        )
      )
      .limit(1);

    let shiftStart: string | null = null;
    let shiftEnd: string | null = null;
    let shiftName = 'Assigned Shift';

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
      .where(eq(schema.employeeShiftAssignments.staffId, s.id))
      .limit(1);

    if (assignment) {
      shiftName = assignment.shiftName;
      shiftStart = String(assignment.startTime);
      shiftEnd = String(assignment.endTime);
    } else {
      const [premTemplate] = await fastify.db
        .select({
          shiftName: schema.shifts.shiftName,
          startTime: schema.shifts.startTime,
          endTime: schema.shifts.endTime,
        })
        .from(schema.shifts)
        .where(
          and(
            eq(schema.shifts.organisationId, organizationId),
            eq(schema.shifts.premisesId, targetPremises.id)
          )
        )
        .limit(1);

      if (premTemplate) {
        shiftName = premTemplate.shiftName;
        shiftStart = String(premTemplate.startTime);
        shiftEnd = String(premTemplate.endTime);
      } else {
        const [orgTemplate] = await fastify.db
          .select({
            shiftName: schema.shifts.shiftName,
            startTime: schema.shifts.startTime,
            endTime: schema.shifts.endTime,
          })
          .from(schema.shifts)
          .where(eq(schema.shifts.organisationId, organizationId))
          .limit(1);

        if (orgTemplate) {
          shiftName = orgTemplate.shiftName;
          shiftStart = String(orgTemplate.startTime);
          shiftEnd = String(orgTemplate.endTime);
        } else {
          shiftName = 'General Shift';
          shiftStart = '09:00:00';
          shiftEnd = '17:00:00';
        }
      }
    }

    const [overtimeRecord] = await fastify.db
      .select()
      .from(schema.overtime)
      .where(
        and(
          eq(schema.overtime.staffProfileId, s.id),
          eq(schema.overtime.workDate, targetDate)
        )
      )
      .limit(1);

    const otName = overtimeRecord?.reason || (overtimeRecord ? 'Overtime Shift' : null);
    const otStart = overtimeRecord?.startTime ? String(overtimeRecord.startTime) : null;
    const otEnd = overtimeRecord?.endTime ? String(overtimeRecord.endTime) : null;

    let sessions: typeof schema.locationMonitoringSessions.$inferSelect[] = [];
    if (attendanceEvent) {
      sessions = await fastify.db
        .select()
        .from(schema.locationMonitoringSessions)
        .where(eq(schema.locationMonitoringSessions.attendanceEventId, attendanceEvent.id));
    }

    const activeSession = sessions.find((sess) => sess.isActive) ?? sessions[0];
    const consecutiveFailures = activeSession?.consecutiveFailures ?? 0;

    let openExceptionId: string | null = null;
    if (attendanceEvent) {
      const [exc] = await fastify.db
        .select({ id: schema.attendanceExceptions.id })
        .from(schema.attendanceExceptions)
        .where(
          and(
            eq(schema.attendanceExceptions.attendanceEventId, attendanceEvent.id),
            eq(schema.attendanceExceptions.status, 'OPEN')
          )
        )
        .limit(1);
      if (exc) {
        openExceptionId = exc.id;
      }
    }

    const sessionIds = sessions.map((sess) => sess.id);

    let checkEvents: typeof schema.locationCheckEvents.$inferSelect[] = [];
    if (sessionIds.length > 0) {
      checkEvents = await fastify.db
        .select()
        .from(schema.locationCheckEvents)
        .where(inArray(schema.locationCheckEvents.sessionId, sessionIds))
        .orderBy(desc(schema.locationCheckEvents.checkTime));
    }

    let insideCount = 0;
    let outsideCount = 0;

    for (const check of checkEvents) {
      if (check.result === 'IN_PREMISES') {
        insideCount++;
      } else if (check.result === 'OUTSIDE' || check.result === 'MOCKED') {
        outsideCount++;
      }
    }

    let missedCount = 0;
    if (attendanceEvent?.clockIn) {
      const clockInMs = new Date(attendanceEvent.clockIn).getTime();
      const endTimeMs = attendanceEvent.clockOut
        ? new Date(attendanceEvent.clockOut).getTime()
        : Date.now();
      const elapsedMinutes = Math.max(0, (endTimeMs - clockInMs) / 60_000);
      const expectedIntervals = Math.floor(elapsedMinutes / 10);
      const totalPings = checkEvents.length;
      missedCount = Math.max(0, expectedIntervals - totalPings);
    }

    let locationStatus: 'Inside' | 'Outside' | 'GPS Uncertain' | 'GPS Unavailable' =
      'GPS Unavailable';
    const latestCheck = checkEvents[0];
    if (latestCheck) {
      if (latestCheck.result === 'IN_PREMISES') {
        locationStatus = 'Inside';
      } else if (latestCheck.result === 'OUTSIDE' || latestCheck.result === 'MOCKED') {
        locationStatus = 'Outside';
      } else if (latestCheck.result === 'LOW_ACCURACY') {
        locationStatus = 'GPS Uncertain';
      } else {
        locationStatus = 'GPS Unavailable';
      }
    }

    const latestPings: GpsPingSummary[] = checkEvents.slice(0, 3).map((chk) => {
      const lat = Number(chk.latitude);
      const lng = Number(chk.longitude);
      const targetLat = Number(targetPremises.latitude);
      const targetLng = Number(targetPremises.longitude);

      const dist = haversineDistanceMeters(lat, lng, targetLat, targetLng);
      const roundedDist = Number.isFinite(dist) ? roundDistanceMeters(dist) : null;

      let pStatus: 'Inside' | 'Outside' | 'Uncertain' | 'Stale' | 'Mocked' | 'No location' =
        'No location';
      if (chk.result === 'IN_PREMISES') pStatus = 'Inside';
      else if (chk.result === 'OUTSIDE') pStatus = 'Outside';
      else if (chk.result === 'LOW_ACCURACY') pStatus = 'Uncertain';
      else if (chk.result === 'STALE') pStatus = 'Stale';
      else if (chk.result === 'MOCKED') pStatus = 'Mocked';

      return {
        id: chk.id,
        checkTime: chk.checkTime.toISOString(),
        distanceMeters: roundedDist,
        accuracyMeters: Number(chk.accuracyMeters),
        status: pStatus,
      };
    });

    const attStatus = attendanceEvent
      ? attendanceEvent.status
      : (assignment || shiftStart ? 'SCHEDULED' : 'NOT_RECORDED');
    const clockInStr = attendanceEvent?.clockIn
      ? new Date(attendanceEvent.clockIn).toISOString()
      : null;
    const clockOutStr = attendanceEvent?.clockOut
      ? new Date(attendanceEvent.clockOut).toISOString()
      : null;

    const otClockIn = (attendanceEvent?.overtimeId && attendanceEvent.overtimeId === overtimeRecord?.id && attendanceEvent.clockIn)
      ? new Date(attendanceEvent.clockIn).toISOString()
      : (overtimeRecord?.resolvedAt ? new Date(overtimeRecord.resolvedAt).toISOString() : null);
    const otClockOut = (attendanceEvent?.overtimeId && attendanceEvent.overtimeId === overtimeRecord?.id && attendanceEvent.clockOut)
      ? new Date(attendanceEvent.clockOut).toISOString()
      : null;

    let shiftStatus = 'NOT_SCHEDULED';
    if (attendanceEvent) {
      shiftStatus = attendanceEvent.status;
    } else if (assignment || shiftStart) {
      shiftStatus = 'SCHEDULED';
    }

    staffCards.push({
      staffProfileId: s.id,
      userId: s.userId,
      fullName: s.fullName,
      role: s.role ?? 'STAFF',
      staffCode: s.staffCode,
      avatarUrl: s.avatarUrl,
      premisesId: s.premisesId,
      premisesName: targetPremises.name,
      attendanceStatus: attStatus,
      locationStatus,
      dayOfWeek: dayOfWeekStr,
      shiftName,
      overtimeName: otName,
      regularShiftStartTime: shiftStart,
      regularShiftEndTime: shiftEnd,
      overtimeStartTime: otStart,
      overtimeEndTime: otEnd,
      clockInTime: clockInStr,
      clockOutTime: clockOutStr,
      overtimeClockInTime: otClockIn,
      overtimeClockOutTime: otClockOut,
      shiftStatus,
      hasOvertimeToday: !!overtimeRecord,
      consecutiveFailures,
      exceptionId: openExceptionId,
      counts: {
        inside: insideCount,
        outside: outsideCount,
        missed: missedCount,
      },
      latestPings,
    });
  }

  return {
    premisesId: targetPremises.id,
    premisesName: targetPremises.name,
    latitude: String(targetPremises.latitude),
    longitude: String(targetPremises.longitude),
    radiusMeters: targetPremises.radiusMeters,
    date: targetDate,
    staff: staffCards,
  };
}
