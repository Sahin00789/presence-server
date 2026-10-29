import * as fs from 'fs';
const p = 'E:/androidprojects/presence/server/src/modules/attendance/service.ts';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('export async function manualMarkAttendance');
const next = s.indexOf('\nexport ', start + 1);
if (start > -1 && next > start) {
  const n = `export async function manualMarkAttendance(fastify: any, organizationId: string, actorUserId: string, input: any) {
  if (input.action === 'DELETE_OVERTIME') {
    if (!input.overtimeId) throw new AppError('overtimeId required', 400, 'OVERTIME_ID_REQUIRED');
    const [ot] = await fastify.db.select().from(schema.overtime).where(and(eq(schema.overtime.id, input.overtimeId), eq(schema.overtime.organizationId, organizationId))).limit(1);
    if (!ot) throw new AppError('Overtime not found', 404, 'OVERTIME_NOT_FOUND');
    const now = new Date();
    const endDt = new Date(String(ot.workDate) + 'T' + ot.endTime);
    if (now.getTime() > endDt.getTime()) throw new AppError('Cannot delete overtime after it has ended', 400, 'OVERTIME_ENDED');
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
  const timezone = await resolveTimezone(fastify, organizationId);
  let endAt: Date | null = null;
  if (event.attendanceType === 'SHIFT' && event.shiftAssignmentId) {
    const [shift] = await fastify.db.select({ startTime: schema.shifts.startTime, endTime: schema.shifts.endTime }).from(schema.employeeAttendance).innerJoin(schema.employeeShiftAssignments, eq(schema.employeeShiftAssignments.id, schema.employeeAttendance.shiftAssignmentId)).innerJoin(schema.shifts, eq(schema.shifts.id, schema.employeeShiftAssignments.shiftId)).where(eq(schema.employeeAttendance.id, event.id)).limit(1);
    if (shift) {
      const window = resolveShiftWindow(String(event.workDate), shift.startTime, shift.endTime, 0, timezone);
      endAt = window.endAt;
    }
  } else if (event.attendanceType === 'OVERTIME' && event.overtimeId) {
    const [ot] = await fastify.db.select().from(schema.overtime).where(eq(schema.overtime.id, event.overtimeId)).limit(1);
    if (ot) {
      const window = resolveShiftWindow(String(ot.workDate), ot.startTime, ot.endTime, 0, timezone);
      endAt = window.endAt;
    }
  }
  if (endAt && new Date() > endAt) throw new AppError('Manual marking not allowed after shift/overtime has ended', 400, 'SHIFT_ENDED');
  const outside = Number(event.outsidePingCount || 0);
  if (outside <= 3) throw new AppError('Manual marking only allowed when outside count > 3', 400, 'MANUAL_MARK_NOT_ALLOWED');
  if (input.action === 'RESUME') {
    const [updated] = await fastify.db.update(schema.employeeAttendance).set({ status: 'PRESENT', updatedAt: new Date(), statusUpdatedBy: actorUserId }).where(eq(schema.employeeAttendance.id, event.id)).returning();
    await accrueShiftEarnings(fastify, organizationId, updated);
    return toPublicAttendanceEvent(updated);
  }
  const targetStatus = input.action;
  const [updated] = await fastify.db.update(schema.employeeAttendance).set({ status: targetStatus, updatedAt: new Date(), statusUpdatedBy: actorUserId, correctionReason: input.reason ?? null, correctedAt: new Date() }).where(eq(schema.employeeAttendance.id, event.id)).returning();
  if (targetStatus === 'PRESENT') {
    await accrueShiftEarnings(fastify, organizationId, updated);
  }
  await writeAuditLog(fastify, { organizationId, actorId: actorUserId, action: 'ATTENDANCE_MANUAL_MARK', resourceType: 'employee_attendance', resourceId: event.id, metadata: { action: input.action, reason: input.reason } });
  return toPublicAttendanceEvent(updated);
}\n\n`;
  s = s.slice(0, start) + n + s.slice(next + 1);
  fs.writeFileSync(p, s);
  console.log('done');
} else {
  console.log('skip');
}
EOF
node --loader ts-node/esm E:\androidprojects\presence\server\upd_manual.ts 2>&1 | tail -3