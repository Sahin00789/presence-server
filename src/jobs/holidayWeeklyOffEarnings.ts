import { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { resolveTimezone } from '../modules/shifts/service.js';
import { addDays, dayOfWeek, enumerateDates, toDateISO, toDateISOInTimeZone } from '../shared/utils/datetime.js';

export async function getUnworkedPaymentAmount(
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
    return amt;
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
  let holidays = 0;
  let weeklyOffs = 0;

  try {
    const employees = await fastify.db
      .select({
        employeeId: schema.employees.id,
        organizationId: schema.employees.organizationId,
        premisesId: schema.employees.premisesId,
      })
      .from(schema.employees)
      .where(eq(schema.employees.isActive, true));

    const orgTimezones = new Map<string, string>();
    const getOrgTz = async (orgId: string): Promise<string> => {
      if (!orgTimezones.has(orgId)) {
        const tz = await resolveTimezone(fastify, orgId);
        orgTimezones.set(orgId, tz);
      }
      return orgTimezones.get(orgId)!;
    };

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

    for (const emp of employees) {
      if (!emp.premisesId) continue;

      const tz = await getOrgTz(emp.organizationId);
      const today = toDateISOInTimeZone(now, tz);
      const from = addDays(today, -14);
      const to = today;

      const holidaysList = await fastify.db
        .select()
        .from(schema.holidayCalendars)
        .where(
          and(
            eq(schema.holidayCalendars.organizationId, emp.organizationId),
            gte(schema.holidayCalendars.date, from),
            lte(schema.holidayCalendars.date, to)
          )
        );

      const holidayByPremisesDate = new Map<string, typeof holidaysList[0]>();
      for (const h of holidaysList) {
        if (!h.premisesId || h.premisesId === emp.premisesId) {
          holidayByPremisesDate.set(String(h.date), h);
        }
      }

      const attendanceRecords = await fastify.db
        .select({
          workDate: schema.employeeAttendance.workDate,
          status: schema.employeeAttendance.status,
        })
        .from(schema.employeeAttendance)
        .where(
          and(
            eq(schema.employeeAttendance.employeeId, emp.employeeId),
            gte(schema.employeeAttendance.workDate, from),
            lte(schema.employeeAttendance.workDate, to)
          )
        );

      const workedDates = new Set(
        attendanceRecords
          .filter((r) => r.status === 'PRESENT' || r.status === 'HALF_DAY')
          .map((r) => String(r.workDate))
      );

      const dates = enumerateDates(from, to);
      const assignmentStartDate = empAssignmentStartDateMap.get(emp.employeeId);

      for (const date of dates) {
        if (!assignmentStartDate || date < assignmentStartDate) continue;
        const dow = dayOfWeek(date);

        const holiday = holidayByPremisesDate.get(date);
        if (holiday) {
          if (holiday.isPaid === false) continue;

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

          if (typeof (fastify as any).publishDomainEvent === 'function') {
            await (fastify as any).publishDomainEvent({
              type: 'attendance_update',
              organizationId: emp.organizationId,
              premisesId: emp.premisesId,
              userIds: [],
              payload: {
                staffProfileId: emp.employeeId,
                status: 'HOLIDAY',
                action: 'DAY_START_EARNING',
                earningDate: date,
                amount: amt,
                type: 'HOLIDAY',
              },
            });
          }
          continue;
        }

        // Check if employee has a shift assigned on this weekday or worked on this date
        if (assignedDowSet.has(`${emp.employeeId}::${dow}`) || workedDates.has(date)) {
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

          if (typeof (fastify as any).publishDomainEvent === 'function') {
            await (fastify as any).publishDomainEvent({
              type: 'attendance_update',
              organizationId: emp.organizationId,
              premisesId: emp.premisesId,
              userIds: [],
              payload: {
                staffProfileId: emp.employeeId,
                status: 'OFF_DAY',
                action: 'DAY_START_EARNING',
                earningDate: date,
                amount: amt,
                type: 'OFF_DAY',
              },
            });
          }
        }
      }
    }
  } catch (error) {
    fastify.log.error({ err: error }, 'postHolidayAndWeeklyOffEarnings failed');
  }

  return { holidays, weeklyOffs };
}

export function startHolidayWeeklyOffEarningsJob(fastify: FastifyInstance): void {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await postHolidayAndWeeklyOffEarnings(fastify);
    } catch (error) {
      fastify.log.error({ err: error }, 'Holiday/Weekly-off earnings job failed');
    } finally {
      running = false;
    }
  };

  fastify.addHook('onListen', async () => {
    setTimeout(run, 3000);
    timer = setInterval(run, 60_000);
    timer.unref?.();
  });

  fastify.addHook('onClose', async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
