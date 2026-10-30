import { FastifyInstance } from 'fastify';
import { and, eq, gte, lte } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { addDays, enumerateDates, parseTimeToMinutes, toDateISO } from '../shared/utils/datetime.js';

export async function postLeaveEarnings(
  fastify: FastifyInstance,
  now: Date = new Date()
): Promise<{ approvedLeavesProcessed: number; autoAbsentMarked: number }> {
  const today = toDateISO(now);
  const from = addDays(today, -14);
  const to = today;

  let approvedLeavesProcessed = 0;
  let autoAbsentMarked = 0;

  const assignments = await fastify.db
    .select({
      assignmentId: schema.employeeShiftAssignments.id,
      organizationId: schema.employeeShiftAssignments.organizationId,
      premisesId: schema.employeeShiftAssignments.premisesId,
      employeeId: schema.employeeShiftAssignments.employeeId,
      startTime: schema.shifts.startTime,
      endTime: schema.shifts.endTime,
      leavePay: schema.employeeShiftAssignments.leavePay,
      absentPay: schema.employeeShiftAssignments.absentPay,
    })
    .from(schema.employeeShiftAssignments)
    .innerJoin(schema.shifts, eq(schema.employeeShiftAssignments.shiftId, schema.shifts.id))
    .where(eq(schema.employeeShiftAssignments.isActive, true));

  const dates = enumerateDates(from, to);

  for (const date of dates) {
    for (const assignment of assignments) {
      const shiftStartMins = parseTimeToMinutes(assignment.startTime);
      const shiftEndMins = parseTimeToMinutes(assignment.endTime);
      const isOvernight = shiftEndMins <= shiftStartMins;

      const endDateStr = isOvernight ? addDays(date, 1) : date;
      const shiftEndIso = `${endDateStr}T${assignment.endTime.slice(0, 5)}:00`;
      const shiftEndAt = new Date(shiftEndIso);

      if (now.getTime() < shiftEndAt.getTime()) {
        continue;
      }

      const [existingAttendance] = await fastify.db
        .select()
        .from(schema.employeeAttendance)
        .where(
          and(
            eq(schema.employeeAttendance.employeeId, assignment.employeeId),
            eq(schema.employeeAttendance.shiftAssignmentId, assignment.assignmentId),
            eq(schema.employeeAttendance.workDate, date)
          )
        )
        .limit(1);

      if (
        existingAttendance &&
        (existingAttendance.clockInAt !== null ||
          ['PRESENT', 'LATE', 'HALF_DAY'].includes(existingAttendance.status))
      ) {
        continue;
      }

      const [approvedLeave] = await fastify.db
        .select()
        .from(schema.leaveRequests)
        .where(
          and(
            eq(schema.leaveRequests.employeeId, assignment.employeeId),
            eq(schema.leaveRequests.shiftAssignmentId, assignment.assignmentId),
            eq(schema.leaveRequests.workDate, date),
            eq(schema.leaveRequests.status, 'APPROVED')
          )
        )
        .limit(1);

      const scheduledMinutes = Math.max(
        0,
        isOvernight ? 24 * 60 - shiftStartMins + shiftEndMins : shiftEndMins - shiftStartMins
      );

      if (approvedLeave) {
        let attendanceId = existingAttendance?.id;

        if (!existingAttendance) {
          const [inserted] = await fastify.db
            .insert(schema.employeeAttendance)
            .values({
              organizationId: assignment.organizationId,
              premisesId: assignment.premisesId,
              employeeId: assignment.employeeId,
              shiftAssignmentId: assignment.assignmentId,
              attendanceType: 'SHIFT',
              workDate: date,
              status: 'LEAVE',
              scheduledMinutes,
              workedMinutes: 0,
              remarks: `Leave approved: ${approvedLeave.reason}`,
            })
            .returning();
          attendanceId = inserted.id;
        } else if (existingAttendance.status !== 'LEAVE') {
          await fastify.db
            .update(schema.employeeAttendance)
            .set({
              status: 'LEAVE',
              scheduledMinutes,
              remarks: `Leave approved: ${approvedLeave.reason}`,
              updatedAt: new Date(),
            })
            .where(eq(schema.employeeAttendance.id, existingAttendance.id));
        }

        const leavePay = Number(assignment.leavePay ?? 0);
        const [existingLedger] = await fastify.db
          .select({ id: schema.employeeEarningLedger.id })
          .from(schema.employeeEarningLedger)
          .where(
            and(
              eq(schema.employeeEarningLedger.employeeId, assignment.employeeId),
              eq(schema.employeeEarningLedger.earningDate, date),
              eq(schema.employeeEarningLedger.type, 'SHIFT')
            )
          )
          .limit(1);

        if (!existingLedger && leavePay > 0) {
          await fastify.db.insert(schema.employeeEarningLedger).values({
            organizationId: assignment.organizationId,
            premisesId: assignment.premisesId,
            employeeId: assignment.employeeId,
            earningDate: date,
            type: 'SHIFT',
            amount: String(leavePay),
            shiftAssignmentId: assignment.assignmentId,
            attendanceId: attendanceId ?? null,
            sourceReference: `leave:${approvedLeave.id}`,
          } as any);
          approvedLeavesProcessed += 1;
        }
      } else {
        if (!existingAttendance) {
          const [inserted] = await fastify.db
            .insert(schema.employeeAttendance)
            .values({
              organizationId: assignment.organizationId,
              premisesId: assignment.premisesId,
              employeeId: assignment.employeeId,
              shiftAssignmentId: assignment.assignmentId,
              attendanceType: 'SHIFT',
              workDate: date,
              status: 'ABSENT',
              scheduledMinutes,
              workedMinutes: 0,
              remarks: 'Auto-marked absent: Shift ended with no clock-in',
            })
            .returning();

          const absentPay = Number(assignment.absentPay ?? 0);
          if (absentPay > 0) {
            await fastify.db.insert(schema.employeeEarningLedger).values({
              organizationId: assignment.organizationId,
              premisesId: assignment.premisesId,
              employeeId: assignment.employeeId,
              earningDate: date,
              type: 'SHIFT',
              amount: String(absentPay),
              shiftAssignmentId: assignment.assignmentId,
              attendanceId: inserted.id,
              sourceReference: `absent:${inserted.id}`,
            } as any);
          }
          autoAbsentMarked += 1;
        } else if (existingAttendance.status !== 'ABSENT') {
          await fastify.db
            .update(schema.employeeAttendance)
            .set({
              status: 'ABSENT',
              scheduledMinutes,
              remarks: 'Auto-marked absent: Shift ended with no clock-in',
              updatedAt: new Date(),
            })
            .where(eq(schema.employeeAttendance.id, existingAttendance.id));
          autoAbsentMarked += 1;
        }
      }
    }
  }

  return { approvedLeavesProcessed, autoAbsentMarked };
}

export function startLeaveEarningsJob(fastify: FastifyInstance): void {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await postLeaveEarnings(fastify);
    } catch (error) {
      fastify.log.error({ err: error }, 'Leave earnings job failed');
    } finally {
      running = false;
    }
  };

  fastify.addHook('onListen', async () => {
    setTimeout(run, 4000);
    timer = setInterval(run, 5 * 60 * 1000);
    timer.unref?.();
  });

  fastify.addHook('onClose', async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
