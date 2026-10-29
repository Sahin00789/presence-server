import { FastifyInstance } from 'fastify';
import { and, eq, gte, lte } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { addDays, toDateISO } from '../shared/utils/datetime.js';

export async function postLeaveEarnings(
  fastify: FastifyInstance,
  now: Date = new Date()
): Promise<number> {
  const today = toDateISO(now);
  const from = addDays(today, -7);
  const to = addDays(today, 1);

  let count = 0;

  const approvedLeaves = await fastify.db
    .select({
      leave: schema.leaveRequests,
      assignment: schema.employeeShiftAssignments,
    })
    .from(schema.leaveRequests)
    .innerJoin(
      schema.employeeShiftAssignments,
      eq(schema.leaveRequests.shiftAssignmentId, schema.employeeShiftAssignments.id)
    )
    .where(
      and(
        eq(schema.leaveRequests.status, 'APPROVED'),
        gte(schema.leaveRequests.workDate, from),
        lte(schema.leaveRequests.workDate, to)
      )
    );

  for (const row of approvedLeaves) {
    const leave = row.leave;
    const assignment = row.assignment;
    if (!assignment) continue;

    const existingByRef = await fastify.db
      .select({ id: schema.employeeEarningLedger.id })
      .from(schema.employeeEarningLedger)
      .where(eq(schema.employeeEarningLedger.sourceReference, `leave:${leave.id}`))
      .limit(1);
    if (existingByRef.length > 0) continue;

    const existing = await fastify.db
      .select({ id: schema.employeeEarningLedger.id })
      .from(schema.employeeEarningLedger)
      .where(
        and(
          eq(schema.employeeEarningLedger.employeeId, leave.employeeId),
          eq(schema.employeeEarningLedger.earningDate, String(leave.workDate)),
          eq(schema.employeeEarningLedger.type, 'SHIFT')
        )
      )
      .limit(1);
    if (existing.length > 0) continue;

    const leavePay = Number(assignment.leavePay ?? 0);
    if (leavePay <= 0) continue;

    await fastify.db.insert(schema.employeeEarningLedger).values({
      organizationId: leave.organizationId,
      premisesId: leave.premisesId,
      employeeId: leave.employeeId,
      earningDate: String(leave.workDate),
      type: 'SHIFT',
      amount: String(leavePay),
      shiftAssignmentId: leave.shiftAssignmentId,
      sourceReference: `leave:${leave.id}`,
    } as any);
    count += 1;
  }

  return count;
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
    timer = setInterval(run, 12 * 60 * 60 * 1000);
    timer.unref?.();
  });

  fastify.addHook('onClose', async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
