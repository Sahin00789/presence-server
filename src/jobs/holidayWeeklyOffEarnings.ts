import { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { addDays, dayOfWeek, enumerateDates, toDateISO } from '../shared/utils/datetime.js';

async function getUnworkedPaymentAmount(
  fastify: FastifyInstance,
  organizationId: string,
  premisesId: string,
  employeeId: string,
  dayType: 'HOLIDAY' | 'WEEKLY_OFF'
): Promise<number> {
  const [rule] = await fastify.db
    .select()
    .from(schema.unworkedPaymentRules)
    .where(
      and(
        eq(schema.unworkedPaymentRules.organizationId, organizationId),
        eq(schema.unworkedPaymentRules.dayType, dayType),
        sql`(${schema.unworkedPaymentRules.employeeId} = ${employeeId} OR ${schema.unworkedPaymentRules.employeeId} IS NULL)`,
        sql`(${schema.unworkedPaymentRules.premisesId} = ${premisesId} OR ${schema.unworkedPaymentRules.premisesId} IS NULL)`
      )
    )
    .orderBy(
      sql`CASE WHEN ${schema.unworkedPaymentRules.employeeId} IS NOT NULL THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${schema.unworkedPaymentRules.premisesId} IS NOT NULL THEN 0 ELSE 1 END`,
      sql`${schema.unworkedPaymentRules.createdAt} DESC`
    )
    .limit(1);

  if (rule) {
    const amt = Number((rule as any).paymentInr ?? (rule as any).paymentPaise ?? 0);
    if (amt > 0) return amt;
  }

  const [assignment] = await fastify.db
    .select({ presentPay: schema.employeeShiftAssignments.presentPay })
    .from(schema.employeeShiftAssignments)
    .where(
      and(
        eq(schema.employeeShiftAssignments.employeeId, employeeId),
        eq(schema.employeeShiftAssignments.isActive, true)
      )
    )
    .limit(1);

  if (assignment && Number(assignment.presentPay) > 0) {
    return Number(assignment.presentPay);
  }

  return 0;
}

export async function postHolidayAndWeeklyOffEarnings(
  fastify: FastifyInstance,
  now: Date = new Date()
): Promise<{ holidays: number; weeklyOffs: number }> {
  const today = toDateISO(now);
  const from = addDays(today, -14);
  const to = today;

  let holidays = 0;
  let weeklyOffs = 0;

  const holidaysList = await fastify.db
    .select()
    .from(schema.holidayCalendars)
    .where(and(gte(schema.holidayCalendars.date, from), lte(schema.holidayCalendars.date, to)));

  const holidayByOrgPremisesDate = new Map<string, typeof holidaysList[0]>();
  for (const h of holidaysList) {
    if (h.premisesId) {
      holidayByOrgPremisesDate.set(`${h.organizationId}::${h.premisesId}::${String(h.date)}`, h);
    }
  }

  const employees = await fastify.db
    .select({
      employeeId: schema.employees.id,
      organizationId: schema.employees.organizationId,
      premisesId: schema.employees.premisesId,
    })
    .from(schema.employees)
    .where(eq(schema.employees.isActive, true));

  const weeklyOffRows = await fastify.db
    .select({ employeeId: schema.weeklyOffs.employeeId, dayOfWeek: schema.weeklyOffs.dayOfWeek })
    .from(schema.weeklyOffs);

  const weeklyOffSet = new Set(weeklyOffRows.map((w) => `${w.employeeId}::${w.dayOfWeek}`));

  const activeAssignments = await fastify.db
    .select({
      employeeId: schema.employeeShiftAssignments.employeeId,
      shiftId: schema.employeeShiftAssignments.shiftId,
      createdAt: schema.employeeShiftAssignments.createdAt,
    })
    .from(schema.employeeShiftAssignments)
    .where(eq(schema.employeeShiftAssignments.isActive, true))
    .orderBy(asc(schema.employeeShiftAssignments.createdAt));

  const empAssignmentStartDateMap = new Map<string, string>();
  for (const a of activeAssignments) {
    if (!empAssignmentStartDateMap.has(a.employeeId)) {
      empAssignmentStartDateMap.set(a.employeeId, toDateISO(a.createdAt));
    }
  }

  // Fetch all active shift templates to check which weekdays have assigned shifts
  const allShifts = await fastify.db
    .select({
      id: schema.shifts.id,
      dayName: schema.shifts.dayName,
    })
    .from(schema.shifts);
  const shiftById = new Map(allShifts.map((s) => [s.id, s]));

  const dayNameMap: Record<string, number> = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6
  };
  const assignedDowSet = new Set<string>();
  for (const a of activeAssignments) {
    const template = shiftById.get(a.shiftId);
    if (!template) continue;
    if (template.dayName && dayNameMap[template.dayName] !== undefined) {
      assignedDowSet.add(`${a.employeeId}::${dayNameMap[template.dayName]}`);
    }
  }

  // Fetch attendance records to avoid granting unworked off-day pay on days the employee worked
  const attendanceRecords = await fastify.db
    .select({
      employeeId: schema.employeeAttendance.employeeId,
      workDate: schema.employeeAttendance.workDate,
      status: schema.employeeAttendance.status,
    })
    .from(schema.employeeAttendance)
    .where(
      and(
        gte(schema.employeeAttendance.workDate, from),
        lte(schema.employeeAttendance.workDate, to)
      )
    );

  const workedSet = new Set(
    attendanceRecords
      .filter((r) => r.status === 'PRESENT' || r.status === 'HALF_DAY')
      .map((r) => `${r.employeeId}::${String(r.workDate)}`)
  );

  const dates = enumerateDates(from, to);
  for (const date of dates) {
    const dow = dayOfWeek(date);
    for (const emp of employees) {
      if (!emp.premisesId) continue;

      const assignmentStartDate = empAssignmentStartDateMap.get(emp.employeeId);
      if (!assignmentStartDate || date < assignmentStartDate) continue;

      const holidayKey = `${emp.organizationId}::${emp.premisesId}::${date}`;
      const holiday = holidayByOrgPremisesDate.get(holidayKey);

      if (holiday) {
        if (holiday.isPaid === false) {
          continue;
        }

        const existing = await fastify.db
          .select({ id: schema.employeeEarningLedger.id })
          .from(schema.employeeEarningLedger)
          .where(
            and(
              eq(schema.employeeEarningLedger.employeeId, emp.employeeId),
              eq(schema.employeeEarningLedger.earningDate, date),
              eq(schema.employeeEarningLedger.type, 'HOLIDAY')
            )
          )
          .limit(1);
        if (existing.length > 0) continue;

        const amt = await getUnworkedPaymentAmount(fastify, emp.organizationId, emp.premisesId, emp.employeeId, 'HOLIDAY');
        if (amt <= 0) continue;

        await fastify.db.insert(schema.employeeEarningLedger).values({
          organizationId: emp.organizationId,
          premisesId: emp.premisesId,
          employeeId: emp.employeeId,
          earningDate: date,
          type: 'HOLIDAY',
          amount: String(amt),
          sourceReference: `holiday:${holiday.id}:HOLIDAY`,
        } as any);
        holidays += 1;
        continue;
      }

      // Check if employee has a shift assigned on this weekday or worked on this date
      if (assignedDowSet.has(`${emp.employeeId}::${dow}`) || workedSet.has(`${emp.employeeId}::${date}`)) {
        continue;
      }

      if (weeklyOffSet.has(`${emp.employeeId}::${dow}`)) {
        const existing = await fastify.db
          .select({ id: schema.employeeEarningLedger.id })
          .from(schema.employeeEarningLedger)
          .where(
            and(
              eq(schema.employeeEarningLedger.employeeId, emp.employeeId),
              eq(schema.employeeEarningLedger.earningDate, date),
              eq(schema.employeeEarningLedger.type, 'OFF_DAY')
            )
          )
          .limit(1);
        if (existing.length > 0) continue;

        const amt = await getUnworkedPaymentAmount(fastify, emp.organizationId, emp.premisesId, emp.employeeId, 'WEEKLY_OFF');
        if (amt <= 0) continue;

        await fastify.db.insert(schema.employeeEarningLedger).values({
          organizationId: emp.organizationId,
          premisesId: emp.premisesId,
          employeeId: emp.employeeId,
          earningDate: date,
          type: 'OFF_DAY',
          amount: String(amt),
          sourceReference: `weekly-off:${emp.employeeId}:${date}:OFF_DAY`,
        } as any);
        weeklyOffs += 1;
      }
    }
  }

  return { holidays, weeklyOffs };
}

export function startHolidayWeeklyOffEarningsJob(fastify: FastifyInstance): void {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await postHolidayAndWeeklyOffEarnings(fastify);
    } catch (error) {
      fastify.log.error({ err: error }, 'Holiday/weekly-off earnings job failed');
    } finally {
      running = false;
    }
  };

  fastify.addHook('onListen', async () => {
    setTimeout(run, 2000);
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
