import { FastifyInstance } from 'fastify';
import { and, eq, isNull, ne } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { accrueShiftEarnings } from '../modules/attendance/service.js';
import { getAssignedDayNumbers, resolveTimezone } from '../modules/shifts/service.js';
import {
  addDays,
  dayOfWeek,
  resolveShiftWindow,
  toDateISOInTimeZone,
} from '../shared/utils/datetime.js';

export async function processAutoPresentAndOvertimeCompletion(
  fastify: FastifyInstance,
  now: Date = new Date()
): Promise<{ shiftsProcessed: number; overtimesProcessed: number }> {
  let shiftsProcessed = 0;
  let overtimesProcessed = 0;

  try {
    // 1. Process Shift Auto-Present, Auto-Clock-Out & Leave Earnings after Shift Time Ends
    const activeAssignments = await fastify.db
      .select({
        assignmentId: schema.employeeShiftAssignments.id,
        organizationId: schema.employeeShiftAssignments.organizationId,
        premisesId: schema.employeeShiftAssignments.premisesId,
        employeeId: schema.employeeShiftAssignments.employeeId,
        userId: schema.employees.userId,
        shiftId: schema.employeeShiftAssignments.shiftId,
        presentPay: schema.employeeShiftAssignments.presentPay,
        leavePay: schema.employeeShiftAssignments.leavePay,
        startTime: schema.shifts.startTime,
        endTime: schema.shifts.endTime,
        dayName: schema.shifts.dayName,
        createdAt: schema.employeeShiftAssignments.createdAt,
      })
      .from(schema.employeeShiftAssignments)
      .innerJoin(
        schema.shifts,
        eq(schema.employeeShiftAssignments.shiftId, schema.shifts.id)
      )
      .innerJoin(
        schema.employees,
        eq(schema.employeeShiftAssignments.employeeId, schema.employees.id)
      )
      .where(
        and(
          eq(schema.employeeShiftAssignments.isActive, true),
          eq(schema.shifts.isActive, true)
        )
      );

    const orgTimezones = new Map<string, string>();
    const getOrgTz = async (orgId: string): Promise<string> => {
      if (!orgTimezones.has(orgId)) {
        const tz = await resolveTimezone(fastify, orgId);
        orgTimezones.set(orgId, tz);
      }
      return orgTimezones.get(orgId)!;
    };

    for (const assignment of activeAssignments) {
      const tz = await getOrgTz(assignment.organizationId);
      const todayISO = toDateISOInTimeZone(now, tz);
      // Check last 7 days to account for multi-day server outages, restarts & overnight shifts
      const datesToCheck: string[] = [];
      for (let i = 7; i >= 0; i--) {
        datesToCheck.push(addDays(todayISO, -i));
      }

      for (const date of datesToCheck) {
        const dow = dayOfWeek(date);
        const assignedDays = getAssignedDayNumbers(assignment.dayName);
        if (!assignedDays.includes(dow)) {
          continue;
        }

        const window = resolveShiftWindow(
          date,
          assignment.startTime,
          assignment.endTime,
          0,
          tz
        );

        // If shift end time has passed
        if (now.getTime() >= window.endAt.getTime()) {
          const [existingAttendance] = await fastify.db
            .select()
            .from(schema.employeeShiftAttendance)
            .where(
              and(
                eq(schema.employeeShiftAttendance.employeeId, assignment.employeeId),
                eq(schema.employeeShiftAttendance.shiftAssignmentId, assignment.assignmentId),
                eq(schema.employeeShiftAttendance.workDate, date)
              )
            )
            .limit(1);

          // Check if there is an approved leave request for this shift
          const [approvedLeave] = await fastify.db
            .select({
              id: schema.leaveRequests.id,
              reason: schema.leaveRequests.reason,
            })
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

          if (approvedLeave) {
            let attendanceId = existingAttendance?.id;

            if (!existingAttendance) {
              const [inserted] = await fastify.db
                .insert(schema.employeeShiftAttendance)
                .values({
                  organizationId: assignment.organizationId,
                  premisesId: assignment.premisesId,
                  employeeId: assignment.employeeId,
                  shiftAssignmentId: assignment.assignmentId,
                  workDate: date,
                  assignedShiftStartTime: assignment.startTime,
                  assignedShiftEndTime: assignment.endTime,
                  status: 'LEAVE',
                  remarks: `Leave approved: ${approvedLeave.reason}`,
                })
                .returning();
              attendanceId = inserted.id;
            } else if (existingAttendance.status !== 'LEAVE') {
              await fastify.db
                .update(schema.employeeShiftAttendance)
                .set({
                  status: 'LEAVE',
                  remarks: `Leave approved: ${approvedLeave.reason}`,
                  updatedAt: now,
                })
                .where(eq(schema.employeeShiftAttendance.id, existingAttendance.id));
            }

            const leavePay = Number(assignment.leavePay ?? 0);
            if (leavePay > 0 && attendanceId) {
              await fastify.db
                .insert(schema.employeeEarningLedger)
                .values({
                  organizationId: assignment.organizationId,
                  premisesId: assignment.premisesId,
                  employeeId: assignment.employeeId,
                  earningDate: date,
                  type: 'SHIFT',
                  amount: String(leavePay),
                  shiftAssignmentId: assignment.assignmentId,
                  attendanceId: attendanceId,
                  sourceReference: `leave:${approvedLeave.id}`,
                } as any)
                .onConflictDoNothing();
            }

            if (typeof (fastify as any).publishDomainEvent === 'function') {
              await (fastify as any).publishDomainEvent({
                type: 'attendance_update',
                organizationId: assignment.organizationId,
                premisesId: assignment.premisesId,
                userIds: assignment.userId ? [assignment.userId] : [],
                payload: {
                  attendanceEventId: attendanceId,
                  staffProfileId: assignment.employeeId,
                  status: 'LEAVE',
                  action: 'AUTO_LEAVE_EARNING',
                  earningDate: date,
                  amount: leavePay,
                },
              });
            }

            shiftsProcessed += 1;
          } else if (existingAttendance) {
            // If not manually marked as ABSENT, HALF_DAY, or LEAVE by owner,
            // and clockOutAt is missing, auto-complete clock-out and default to PRESENT
            if (
              !['ABSENT', 'HALF_DAY', 'LEAVE'].includes(existingAttendance.status) &&
              existingAttendance.clockOutAt === null
            ) {
              const clockInAt = existingAttendance.clockInAt ?? window.startAt;
              const clockOutAt = window.endAt;

              const [updated] = await fastify.db
                .update(schema.employeeShiftAttendance)
                .set({
                  status: 'PRESENT',
                  clockInAt,
                  clockOutAt,
                  updatedAt: now,
                })
                .where(eq(schema.employeeShiftAttendance.id, existingAttendance.id))
                .returning();

              await accrueShiftEarnings(fastify, assignment.organizationId, updated);

              if (typeof (fastify as any).publishDomainEvent === 'function') {
                await (fastify as any).publishDomainEvent({
                  type: 'attendance_update',
                  organizationId: assignment.organizationId,
                  premisesId: assignment.premisesId,
                  userIds: assignment.userId ? [assignment.userId] : [],
                  payload: {
                    attendanceEventId: updated.id,
                    staffProfileId: assignment.employeeId,
                    status: 'PRESENT',
                    action: 'AUTO_CLOCK_OUT',
                    clockIn: clockInAt.toISOString(),
                    clockOut: clockOutAt.toISOString(),
                  },
                });
              }

              shiftsProcessed += 1;
            }
          } else {
            // No approved leave and no attendance row exists -> apply Default Present Policy immediately
            const [inserted] = await fastify.db
              .insert(schema.employeeShiftAttendance)
              .values({
                organizationId: assignment.organizationId,
                premisesId: assignment.premisesId,
                employeeId: assignment.employeeId,
                shiftAssignmentId: assignment.assignmentId,
                workDate: date,
                assignedShiftStartTime: assignment.startTime,
                assignedShiftEndTime: assignment.endTime,
                status: 'PRESENT',
                clockInAt: window.startAt,
                clockOutAt: window.endAt,
                faceVerified: true,
                geofenceVerified: true,
                remarks: 'Default Present: Shift ended with no manual exception',
              })
              .returning();

            await accrueShiftEarnings(fastify, assignment.organizationId, inserted);

            if (typeof (fastify as any).publishDomainEvent === 'function') {
              await (fastify as any).publishDomainEvent({
                type: 'attendance_update',
                organizationId: assignment.organizationId,
                premisesId: assignment.premisesId,
                userIds: assignment.userId ? [assignment.userId] : [],
                payload: {
                  attendanceEventId: inserted.id,
                  staffProfileId: assignment.employeeId,
                  status: 'PRESENT',
                  action: 'AUTO_CLOCK_OUT',
                  clockIn: window.startAt.toISOString(),
                  clockOut: window.endAt.toISOString(),
                },
              });
            }

            shiftsProcessed += 1;
          }
        }
      }
    }

    // 2. Process Overtime Auto-Completion & Earning Ledger Marking
    const activeOvertimes = await fastify.db
      .select()
      .from(schema.overtime)
      .where(
        and(
          ne(schema.overtime.status, 'COMPLETED'),
          ne(schema.overtime.status, 'CANCELLED')
        )
      );

    for (const ot of activeOvertimes) {
      const tz = await getOrgTz(ot.organizationId);
      const otWindow = resolveShiftWindow(
        String(ot.workDate),
        ot.startTime,
        ot.endTime,
        0,
        tz
      );

      // If overtime end time has passed
      if (now.getTime() >= otWindow.endAt.getTime()) {
        const [existingOtAtt] = await fastify.db
          .select()
          .from(schema.employeeOvertimeAttendance)
          .where(eq(schema.employeeOvertimeAttendance.overtimeId, ot.id))
          .limit(1);

        let otAttId: string;

        if (existingOtAtt) {
          otAttId = existingOtAtt.id;
          const clockInAt = existingOtAtt.clockInAt ?? otWindow.startAt;
          const clockOutAt = existingOtAtt.clockOutAt ?? otWindow.endAt;

          await fastify.db
            .update(schema.employeeOvertimeAttendance)
            .set({
              status: 'PRESENT',
              clockInAt,
              clockOutAt,
              updatedAt: now,
            })
            .where(eq(schema.employeeOvertimeAttendance.id, existingOtAtt.id));
        } else {
          const [insertedOtAtt] = await fastify.db
            .insert(schema.employeeOvertimeAttendance)
            .values({
              organizationId: ot.organizationId,
              premisesId: ot.premisesId,
              employeeId: ot.employeeId,
              overtimeId: ot.id,
              workDate: ot.workDate,
              assignedOvertimeStartTime: ot.startTime,
              assignedOvertimeEndTime: ot.endTime,
              status: 'PRESENT',
              clockInAt: otWindow.startAt,
              clockOutAt: otWindow.endAt,
              faceVerified: true,
              geofenceVerified: true,
              remarks: 'Default Present: Overtime completed with no manual mark',
            })
            .returning();
          otAttId = insertedOtAtt.id;
        }

        // Mark overtime as COMPLETED
        await fastify.db
          .update(schema.overtime)
          .set({
            status: 'COMPLETED',
            workedMinutes: ot.plannedMinutes,
            resolvedAt: now,
            attendanceId: otAttId,
            updatedAt: now,
          })
          .where(eq(schema.overtime.id, ot.id));

        // Accrue overtime earnings into employee_earning_ledger
        const paymentAmount = Number((ot as any).paymentInr ?? 0);
        if (paymentAmount > 0) {
          await fastify.db
            .insert(schema.employeeEarningLedger)
            .values({
              organizationId: ot.organizationId,
              premisesId: ot.premisesId,
              employeeId: ot.employeeId,
              earningDate: String(ot.workDate),
              type: 'OVERTIME',
              amount: String(paymentAmount),
              overtimeId: ot.id,
              attendanceId: otAttId,
              sourceReference: `overtime:${ot.id}:OVERTIME`,
            } as any)
            .onConflictDoNothing();
        }

        if (typeof (fastify as any).publishDomainEvent === 'function') {
          await (fastify as any).publishDomainEvent({
            type: 'attendance_update',
            organizationId: ot.organizationId,
            premisesId: ot.premisesId,
            userIds: [],
            payload: {
              overtimeId: ot.id,
              attendanceEventId: otAttId,
              staffProfileId: ot.employeeId,
              status: 'COMPLETED',
              action: 'AUTO_OVERTIME_COMPLETE',
              workedMinutes: ot.plannedMinutes,
              amount: paymentAmount,
            },
          });
        }

        overtimesProcessed += 1;
      }
    }
  } catch (error) {
    fastify.log.error({ err: error }, 'processAutoPresentAndOvertimeCompletion failed');
  }

  return { shiftsProcessed, overtimesProcessed };
}

export function startAutoShiftOvertimeJob(fastify: FastifyInstance): void {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await processAutoPresentAndOvertimeCompletion(fastify);
    } catch (error) {
      fastify.log.error({ err: error }, 'Auto shift/overtime presenter job failed');
    } finally {
      running = false;
    }
  };

  fastify.addHook('onListen', async () => {
    // Run initial check after 2 seconds, then every 15 seconds
    setTimeout(run, 2000);
    timer = setInterval(run, 15_000);
    timer.unref?.();
  });

  fastify.addHook('onClose', async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
