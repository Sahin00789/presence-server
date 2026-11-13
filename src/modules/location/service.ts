import { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { getAssignedDayNumbers } from '../shifts/service.js';

export async function getTodayLocationPresence(
  fastify: FastifyInstance,
  user: { userId: string; organizationId: string; role: string },
  premisesIdFilter?: string | null,
  dateFilter?: string | null
) {
  const organizationId = user.organizationId;
  const targetDate = dateFilter || new Date().toISOString().slice(0, 10);
  const targetDateObj = new Date(`${targetDate}T00:00:00Z`);
  const targetDow = targetDateObj.getUTCDay();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayDayName = dayNames[targetDow];

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

  // 3. Fetch Today's Shift Attendance Records
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

  // 4. Fetch Today's Overtime & Overtime Attendance Records
  const todayOvertimeList = empIds.length > 0
    ? await fastify.db
        .select()
        .from(schema.overtime)
        .where(
          and(
            eq(schema.overtime.organizationId, organizationId),
            eq(schema.overtime.workDate, targetDate),
            inArray(schema.overtime.employeeId, empIds),
            ne(schema.overtime.status, 'CANCELLED')
          )
        )
    : [];

  const overtimeMap = new Map(todayOvertimeList.map((ot) => [ot.employeeId, ot]));
  const otIds = todayOvertimeList.map((ot) => ot.id);

  const todayOvertimeAttendance = otIds.length > 0
    ? await fastify.db
        .select()
        .from(schema.employeeOvertimeAttendance)
        .where(
          and(
            eq(schema.employeeOvertimeAttendance.organizationId, organizationId),
            eq(schema.employeeOvertimeAttendance.workDate, targetDate),
            inArray(schema.employeeOvertimeAttendance.overtimeId, otIds)
          )
        )
    : [];

  const otAttMap = new Map(todayOvertimeAttendance.map((a) => [a.employeeId, a]));

  // 5. Fetch Shift Assignments
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

  const empAssignmentsMap = new Map<string, typeof assignments>();
  assignments.forEach((a) => {
    const list = empAssignmentsMap.get(a.assignment.employeeId) || [];
    list.push(a);
    empAssignmentsMap.set(a.assignment.employeeId, list);
  });

  // 6. Fetch Pings for Today's Attendance
  const pings = attIds.length > 0
    ? await fastify.db
        .select()
        .from(schema.shiftLocationPings)
        .where(inArray(schema.shiftLocationPings.shiftAttendanceId, attIds))
    : [];

  const pingMap = new Map<string, typeof pings>();
  pings.forEach((p) => {
    if (p.shiftAttendanceId) {
      const list = pingMap.get(p.shiftAttendanceId) || [];
      list.push(p);
      pingMap.set(p.shiftAttendanceId, list);
    }
  });

  const orgPremisesShifts = await fastify.db
    .select()
    .from(schema.shifts)
    .where(
      and(
        eq(schema.shifts.organizationId, organizationId),
        eq(schema.shifts.isActive, true)
      )
    );

  // 7. Build Staff Cards
  const staffCards = activeEmployees.map((emp) => {
    const att = attMap.get(emp.id);
    const ot = overtimeMap.get(emp.id);
    const otAtt = otAttMap.get(emp.id);

    const empAssignments = empAssignmentsMap.get(emp.id) || [];
    const matchingAssignment = empAssignments.find((a) =>
      getAssignedDayNumbers(a.shift.dayName).includes(targetDow)
    );

    const fallbackPremisesShift = !matchingAssignment && empAssignments.length === 0
      ? orgPremisesShifts.find((s) =>
          (!s.premisesId || s.premisesId === (selectedPremises?.id ?? emp.premisesId)) &&
          getAssignedDayNumbers(s.dayName).includes(targetDow)
        ) ?? null
      : null;

    const shift = matchingAssignment?.shift ?? fallbackPremisesShift;
    const assignment = matchingAssignment?.assignment ?? null;
    const empPings = att ? pingMap.get(att.id) || [] : [];

    const insideCount = empPings.filter((p) => p.result === 'IN_PREMISES').length;
    const outsideCount = empPings.filter((p) => p.result === 'OUTSIDE').length;
    const consecutiveFailures = att?.consecutivePingFailures ?? otAtt?.consecutivePingFailures ?? 0;

    let locationStatus = 'NOT_CLOCKED_IN';
    if (att?.clockInAt || otAtt?.clockInAt) {
      if (outsideCount > 0 || consecutiveFailures > 0) {
        locationStatus = 'Outside';
      } else {
        locationStatus = 'Inside';
      }
    }

    const attendanceStatus = att ? att.status : 'NOT_CLOCKED_IN';

    let exceptionId: string | null = null;
    if (att && (att.consecutivePingFailures > 3 || att.outsidePingCount > 3)) {
      exceptionId = att.id;
    } else if (otAtt && (otAtt.consecutivePingFailures > 3 || otAtt.outsidePingCount > 3)) {
      exceptionId = otAtt.id;
    }

    let earnedAmountPaise = 0;
    if (att?.status === 'PRESENT' && assignment) {
      earnedAmountPaise += Math.round(Number(assignment.presentPay || 0));
    } else if (att?.status === 'HALF_DAY' && assignment) {
      earnedAmountPaise += Math.round(Number(assignment.halfDayPay || 0));
    }
    if (ot && (otAtt?.status === 'PRESENT' || ot.status === 'COMPLETED')) {
      earnedAmountPaise += Number(ot.paymentInr || 0);
    }

    return {
      staffProfileId: emp.id,
      userId: emp.userId ?? '',
      fullName: emp.name,
      staffCode: emp.employeeCode ?? null,
      role: emp.role || 'EMPLOYEE',
      premisesId: selectedPremises?.id ?? emp.premisesId ?? null,
      premisesName: selectedPremises?.name ?? 'Main Workplace',
      attendanceStatus,
      locationStatus,
      dayOfWeek: shift?.dayName ?? todayDayName,
      shiftName: shift?.shiftName ?? 'No shift assigned',
      assignedStartTime: shift?.startTime ?? null,
      assignedEndTime: shift?.endTime ?? null,
      regularShiftStartTime: shift?.startTime ?? null,
      regularShiftEndTime: shift?.endTime ?? null,
      hasOvertimeToday: Boolean(ot),
      overtimeId: ot?.id ?? null,
      overtimeName: ot?.reason || 'Overtime',
      overtimeStartTime: ot?.startTime ?? null,
      overtimeEndTime: ot?.endTime ?? null,
      overtimeClockInTime: otAtt?.clockInAt ? new Date(otAtt.clockInAt).toISOString() : null,
      overtimeClockOutTime: otAtt?.clockOutAt ? new Date(otAtt.clockOutAt).toISOString() : null,
      attendanceEventId: att?.id ?? null,
      clockInTime: att?.clockInAt ? new Date(att.clockInAt).toISOString() : null,
      clockOutTime: att?.clockOutAt ? new Date(att.clockOutAt).toISOString() : null,
      consecutiveFailures,
      exceptionId,
      earnedAmountPaise,
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
        isNull(schema.employeeAttendance.clockOutAt),
        isNotNull(schema.employeeAttendance.clockInAt)
      )
    )
    .orderBy(desc(schema.employeeAttendance.clockInAt))
    .limit(1);

  const isActive = Boolean(att && att.clockInAt && !att.clockOutAt);
  return {
    attendanceEventId: att?.id ?? null,
    isActive,
    consecutiveFailures: att?.consecutivePingFailures ?? 0,
  };
}
