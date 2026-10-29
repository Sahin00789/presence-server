import { FastifyInstance } from 'fastify';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { addDays, dayOfWeek, enumerateDates, toDateISO } from '../shared/utils/datetime.js';

async function getUnworkedPaymentAmount(
  fastify: FastifyInstance,
  organizationId: string,
  premisesId: string,
  employeeId: string,
  dayType: 'HOLIDAY' | 'WEEKLY_OFF'
): Promise<number> {
  const todayIso = toDateISO(new Date());
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

  if (!rule) {
    return 0;
  }
  return Number((rule as any).paymentInr ?? (rule as any).paymentCents ?? 0);
}

export async function postHolidayAndWeeklyOffEarnings(
  fastify: FastifyInstance,
  now: Date = new Date()
): Promise<{ holidays: number; weeklyOffs: number }> {
  const today = toDateISO(now);
  const from = addDays(today, -7);
  const to = addDays(today, 1);

  let holidays = 0;
  let weeklyOffs = 0;

  const holidaysList = await fastify.db
    .select()
    .from(schema.holidayCalendars)
    .where(and(gte(schema.holidayCalendars.date, from), lte(schema.holidayCalendars.date, to)));

  const holidayByOrgDate = new Map<string, typeof holidaysList[0]>();
  for (const h of holidaysList) {
    holidayByOrgDate.set(`${h.organizationId}::${String(h.date)}`, h);
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

  const dates = enumerateDates(from, to);
  for (const date of dates) {
    const dow = dayOfWeek(date);
    for (const emp of employees) {
      if (!emp.premisesId) continue;

      const holidayKey = `${emp.organizationId}::${date}`;
      const holiday = holidayByOrgDate.get(holidayKey);
      if (holiday) {
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
          sourceReference: `holiday:${holiday.id}:${emp.employeeId}:${date}`,
        } as any);
        holidays += 1;
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
          sourceReference: `weeklyoff:${emp.employeeId}:${date}`,
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
