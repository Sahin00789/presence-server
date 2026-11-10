import { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { submitShiftLocationCheck } from '../attendance/service.js';

export async function getTodayLocationPresence(
  fastify: FastifyInstance,
  user: { userId: string; organizationId: string; role: string },
  premisesIdFilter?: string | null,
  dateFilter?: string | null
) {
  const organizationId = user.organizationId;
  const targetDate = dateFilter || new Date().toISOString().slice(0, 10);

  // 1. Resolve Premises
  const orgPremises = await fastify.db
    .select()
    .from(schema.premises)
    .where(
      and(
        eq(schema.premises.organizationId, organizationId),
        eq(schema.premises.isActive, true)
      )
    );

  const selectedPremises = premisesIdFilter
    ? orgPremises.find((p) => p.id === premisesIdFilter) || orgPremises[0]
    : orgPremises[0];

  // 2. Fetch Employees for Organization (filtered by premises if applicable)
  const empConditions = [
    eq(schema.employees.organizationId, organizationId),
    eq(schema.employees.isActive, true),
  ];
  if (selectedPremises) {
    empConditions.push(eq(schema.employees.premisesId, selectedPremises.id));
  }

  const activeEmployees = await fastify.db
    .select()
    .from(schema.employees)
    .where(and(...empConditions));

  const empIds = activeEmployees.map((e) => e.id);

  // 3. Fetch Today's Attendance Records
  const todayAttendance = empIds.length > 0
    ? await fastify.db
        .select()
        .from(schema.employeeAttendance)
        .where(
          and(
            eq(schema.employeeAttendance.organizationId, organizationId),
            eq(schema.employeeAttendance.workDate, targetDate),
            inArray(schema.employeeAttendance.employeeId, empIds)
          )
        )
    : [];

  const attMap = new Map(todayAttendance.map((a) => [a.employeeId, a]));
  const attIds = todayAttendance.map((a) => a.id);

  // 4. Fetch Shift Assignments
  const assignments = empIds.length > 0
    ? await fastify.db
        .select({
          assignment: schema.employeeShiftAssignments,
          shift: schema.shifts,
        })
        .from(schema.employeeShiftAssignments)
        .innerJoin(
          schema.shifts,
          eq(schema.employeeShiftAssignments.shiftId, schema.shifts.id)
        )
        .where(
          and(
            eq(schema.employeeShiftAssignments.organizationId, organizationId),
            eq(schema.employeeShiftAssignments.isActive, true),
            inArray(schema.employeeShiftAssignments.employeeId, empIds)
          )
        )
    : [];

  const assignmentMap = new Map(assignments.map((a) => [a.assignment.employeeId, a.shift]));

  // 5. Fetch Pings for Today's Attendance
  const pings = attIds.length > 0
    ? await fastify.db
        .select()
        .from(schema.attendanceLocationPings)
        .where(inArray(schema.attendanceLocationPings.shiftAttendanceId, attIds))
    : [];

  const pingMap = new Map<string, typeof pings>();
  pings.forEach((p) => {
    if (p.shiftAttendanceId) {
      const list = pingMap.get(p.shiftAttendanceId) || [];
      list.push(p);
      pingMap.set(p.shiftAttendanceId, list);
    }
  });

  // 6. Build Staff Cards
  const staffCards = activeEmployees.map((emp) => {
    const att = attMap.get(emp.id);
    const shift = assignmentMap.get(emp.id);
    const empPings = att ? pingMap.get(att.id) || [] : [];

    const insideCount = empPings.filter((p) => p.result === 'IN_PREMISES').length;
    const outsideCount = empPings.filter((p) => p.result === 'OUTSIDE').length;

    let locationStatus = 'NOT_CLOCKED_IN';
    if (att?.clockInAt) {
      if (outsideCount > 0) {
        locationStatus = 'Outside';
      } else {
        locationStatus = 'Inside';
      }
    }

    return {
      staffProfileId: emp.id,
      fullName: emp.name,
      staffCode: emp.employeeCode ?? null,
      premisesId: selectedPremises?.id ?? emp.premisesId ?? null,
      premisesName: selectedPremises?.name ?? 'Main Workplace',
      shiftName: shift?.shiftName ?? 'Standard Shift',
      assignedStartTime: shift?.startTime ?? '09:00:00',
      assignedEndTime: shift?.endTime ?? '17:00:00',
      attendanceEventId: att?.id ?? null,
      clockInTime: att?.clockInAt ? new Date(att.clockInAt).toISOString() : null,
      clockOutTime: att?.clockOutAt ? new Date(att.clockOutAt).toISOString() : null,
      locationStatus,
      consecutiveFailures: att?.consecutivePingFailures ?? 0,
      earnedAmountPaise: 0,
      counts: {
        inside: insideCount,
        outside: outsideCount,
        missed: 0,
      },
      latestPings: empPings.slice(-5).map((p) => ({
        id: p.id,
        timestamp: new Date(p.checkedAt).toISOString(),
        latitude: Number(p.latitude),
        longitude: Number(p.longitude),
        isInsideGeofence: p.result === 'IN_PREMISES',
      })),
    };
  });

  const totalActiveStaff = activeEmployees.length;
  const totalClockedIn = staffCards.filter((s) => s.clockInTime != null).length;
  const outsideGeofenceCount = staffCards.filter((s) => s.locationStatus === 'Outside').length;

  return {
    premisesId: selectedPremises?.id ?? null,
    premisesName: selectedPremises?.name ?? 'Main Workplace',
    address: selectedPremises?.address ?? null,
    radiusMeters: Number(selectedPremises?.radiusMeters ?? 50),
    latitude: selectedPremises?.latitude ? Number(selectedPremises.latitude) : null,
    longitude: selectedPremises?.longitude ? Number(selectedPremises.longitude) : null,
    summaryDate: targetDate,
    date: targetDate,
    totalActiveStaff,
    totalClockedIn,
    outsideGeofenceCount,
    staffCards,
    staff: staffCards,
  };
}

export async function getActiveLocationSession(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string
) {
  const todayStr = new Date().toISOString().slice(0, 10);

  // Find staff profile for user
  const [employee] = await fastify.db
    .select()
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        eq(schema.employees.userId, userId)
      )
    )
    .limit(1);

  if (!employee) {
    return { attendanceEventId: null, isActive: false, consecutiveFailures: 0 };
  }

  const [att] = await fastify.db
    .select()
    .from(schema.employeeAttendance)
    .where(
      and(
        eq(schema.employeeAttendance.organizationId, organizationId),
        eq(schema.employeeAttendance.employeeId, employee.id),
        eq(schema.employeeAttendance.workDate, todayStr)
      )
    )
    .limit(1);

  const isActive = Boolean(att && att.clockInAt && !att.clockOutAt);
  return {
    attendanceEventId: att?.id ?? null,
    isActive,
    consecutiveFailures: att?.consecutivePingFailures ?? 0,
  };
}

export async function submitLocationCheck(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string,
  body: {
    attendanceEventId?: string;
    shiftAttendanceId?: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    isMock?: boolean;
    timestamp?: string;
    clientRequestId?: string;
  }
) {
  return submitShiftLocationCheck(fastify, userId, organizationId, body);
}
