import { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { listOrganizationStaff } from '../../shared/services/staff.service.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import { dayOfWeek, enumerateDates } from '../../shared/utils/datetime.js';

function getMonthDateRange(year: number, month: number) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonthStartDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  return { startDate, nextMonthStartDate };
}

/**
 * 1. Get monthly attendance statistics for a staff member, premises, month, and year.
 */
export async function getMonthlyAttendanceStats(
  fastify: FastifyInstance,
  organizationId: string,
  month: number,
  year: number,
  premisesId?: string,
  staffProfileId?: string
) {
  const conditions = [
    eq(schema.monthlyAttendanceStats.organizationId, organizationId),
    eq(schema.monthlyAttendanceStats.month, month),
    eq(schema.monthlyAttendanceStats.year, year),
  ];
  if (premisesId) conditions.push(eq(schema.monthlyAttendanceStats.premisesId, premisesId));
  if (staffProfileId) conditions.push(eq(schema.monthlyAttendanceStats.employeeId, staffProfileId));

  return await fastify.db
    .select()
    .from(schema.monthlyAttendanceStats)
    .where(and(...conditions));
}

/**
 * 10. Refresh or rebuild monthly attendance statistics from authoritative records.
 */
export async function rebuildMonthlyAttendanceStats(
  fastify: FastifyInstance,
  organizationId: string,
  month: number,
  year: number,
  premisesId?: string,
  staffProfileId?: string
) {
  const { startDate, nextMonthStartDate } = getMonthDateRange(year, month);
  const staffList = await listOrganizationStaff(fastify, organizationId);
  const filteredStaff = staffList.filter(
    (s) => (!premisesId || s.premisesId === premisesId) && (!staffProfileId || s.id === staffProfileId)
  );

  for (const staff of filteredStaff) {
    const premId = staff.premisesId;
    if (!premId) continue;

    const attendanceEvents = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.employeeId, staff.id),
          gte(schema.employeeAttendance.workDate, startDate),
          sql`${schema.employeeAttendance.workDate} < ${nextMonthStartDate}`
        )
      );

    let present = 0;
    let absent = 0;
    let halfDay = 0;
    let leave = 0;

    for (const ev of attendanceEvents) {
      if (ev.status === 'PRESENT') present++;
      else if (ev.status === 'HALF_DAY') halfDay++;
      else if (ev.status === 'ABSENT') absent++;
      else if (ev.status === 'LEAVE') leave++;
    }

    const holidays = await fastify.db
      .select()
      .from(schema.holidayCalendars)
      .where(
        and(
          eq(schema.holidayCalendars.organizationId, organizationId),
          gte(schema.holidayCalendars.date, startDate),
          sql`${schema.holidayCalendars.date} < ${nextMonthStartDate}`
        )
      );
    const holidayCount = holidays.length;

    const weeklyOffs = await fastify.db
      .select()
      .from(schema.weeklyOffs)
      .where(eq(schema.weeklyOffs.employeeId, staff.id));

    let offDayCount = 0;
    const [yNum, mNum] = [year, month];
    const daysInMonth = new Date(yNum, mNum, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const dayOfWeek = new Date(yNum, mNum - 1, d).getDay();
      if (weeklyOffs.some((wo) => wo.dayOfWeek === dayOfWeek)) {
        offDayCount++;
      }
    }

    const overtimeRecords = await fastify.db
      .select()
      .from(schema.overtime)
      .where(
        and(
          eq(schema.overtime.organizationId, organizationId),
          eq(schema.overtime.employeeId, staff.id),
          gte(schema.overtime.workDate, startDate),
          sql`${schema.overtime.workDate} < ${nextMonthStartDate}`,
          sql`${schema.overtime.status} IN ('APPROVED', 'COMPLETED', 'PAID', 'CLOSED')`
        )
      );
    const overtimeCount = overtimeRecords.length;

    await fastify.db
      .insert(schema.monthlyAttendanceStats)
      .values({
        organizationId,
        premisesId: premId,
        employeeId: staff.id,
        month,
        year,
        presentShiftsCount: present,
        absentShiftsCount: absent,
        leaveShiftsCount: leave,
        halfDayShiftsCount: halfDay,
        holidayCount,
        offDayCount,
        overtimeCount,
      })
      .onConflictDoUpdate({
        target: [
          schema.monthlyAttendanceStats.organizationId,
          schema.monthlyAttendanceStats.premisesId,
          schema.monthlyAttendanceStats.employeeId,
          schema.monthlyAttendanceStats.month,
          schema.monthlyAttendanceStats.year,
        ],
        set: {
          presentShiftsCount: present,
          absentShiftsCount: absent,
          leaveShiftsCount: leave,
          halfDayShiftsCount: halfDay,
          holidayCount,
          offDayCount,
          overtimeCount,
          updatedAt: new Date(),
        },
      });
  }
}

/**
 * Generates individual earning ledger entries idempotently.
 */
export async function generateDailyEarningLedgerEntries(
  fastify: FastifyInstance,
  organizationId: string,
  premisesId: string,
  staffProfileId: string,
  month: number,
  year: number
) {
  const { startDate, nextMonthStartDate } = getMonthDateRange(year, month);
  const lastDayOfMonth = enumerateDates(startDate, nextMonthStartDate).slice(0, -1).at(-1) ?? startDate;

  const [staff] = await fastify.db
    .select()
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.id, staffProfileId),
        eq(schema.employees.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!staff) return;

  try {
    const salary = await getCurrentSalaryStructure(
      fastify,
      staffProfileId,
      startDate,
      organizationId
    ).catch(() => null);
    const dailyPresentCents = salary?.presentCents ?? 0;
    const fallbackDailyCents = Number(dailyPresentCents) > 0 ? Number(dailyPresentCents) : 0;

    // 1. Attendance events -> SHIFT earnings. Clock-out already writes the
    // authoritative SHIFT row; this pass backfills approved leave and repairs
    // older rows without double-inserting.
    const attendanceEvents = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.organizationId, organizationId),
          eq(schema.employeeAttendance.employeeId, staffProfileId),
          gte(schema.employeeAttendance.workDate, startDate),
          sql`${schema.employeeAttendance.workDate} < ${nextMonthStartDate}`
        )
      );

    const assignmentIds = Array.from(
      new Set(
        attendanceEvents
          .map((event) => event.shiftAssignmentId)
          .filter((id): id is string => Boolean(id))
      )
    );
    const assignmentRows = assignmentIds.length
      ? await fastify.db
          .select({
            id: schema.employeeShiftAssignments.id,
            presentPay: schema.employeeShiftAssignments.presentPay,
            halfDayPay: schema.employeeShiftAssignments.halfDayPay,
            leavePay: schema.employeeShiftAssignments.leavePay,
          })
          .from(schema.employeeShiftAssignments)
          .where(inArray(schema.employeeShiftAssignments.id, assignmentIds))
      : [];
    const assignmentById = new Map(assignmentRows.map((row) => [row.id, row]));
    const cents = (value: string | number | null | undefined) =>
      Math.round(Number(value ?? 0) * 100);

    const insertLedgerIfMissing = async (values: {
      earningDate: string;
      type: 'SHIFT' | 'HOLIDAY' | 'OFF_DAY';
      amountCents: number;
      shiftAssignmentId?: string | null;
      attendanceId?: string | null;
      sourceReference: string;
    }) => {
      const earningLedger = (schema as any).employeeEarningLedger;
      const [existing] = await fastify.db
        .select({ id: earningLedger.id })
        .from(earningLedger)
        .where(
          values.attendanceId
            ? or(
                eq(earningLedger.sourceReference, values.sourceReference),
                and(
                  eq(earningLedger.attendanceId, values.attendanceId),
                  eq(earningLedger.type, values.type)
                )
              )
            : eq(earningLedger.sourceReference, values.sourceReference)
        )
        .limit(1);
      if (existing) return;

      await fastify.db
        .insert(earningLedger)
        .values({
          organizationId,
          premisesId,
          employeeId: staffProfileId,
          earningDate: values.earningDate,
          type: values.type,
          amount: (Math.max(0, values.amountCents) / 100).toFixed(2),
          shiftAssignmentId: values.shiftAssignmentId ?? null,
          attendanceId: values.attendanceId ?? null,
          sourceReference: values.sourceReference,
        })
        .onConflictDoNothing();
    };

    const workedDates = new Set<string>();
    for (const ev of attendanceEvents) {
      const workDate = String(ev.workDate);
      if (ev.status === 'PRESENT' || ev.status === 'HALF_DAY') {
        workedDates.add(workDate);
      }

      if (
        ev.status !== 'PRESENT' &&
        ev.status !== 'HALF_DAY'
      ) {
        continue;
      }

      const assignment = ev.shiftAssignmentId
        ? assignmentById.get(ev.shiftAssignmentId)
        : undefined;
      const amountCents =
        ev.status === 'HALF_DAY'
          ? cents(assignment?.halfDayPay) || Math.round((cents(assignment?.presentPay) || dailyPresentCents) / 2)
          : cents(assignment?.presentPay) || dailyPresentCents || fallbackDailyCents;

      await insertLedgerIfMissing({
        earningDate: workDate,
        type: 'SHIFT',
        amountCents,
        shiftAssignmentId: ev.shiftAssignmentId,
        attendanceId: ev.id,
        sourceReference: `attendance:${ev.id}:SHIFT`,
      });
    }

    // Resolve unworked rules once. Specific employee + premises rows win over
    // organisation-wide defaults; the latest effective row wins within a tier.
    const unworkedRules = await fastify.db
      .select()
      .from(schema.unworkedPaymentRules)
      .where(
        and(
          eq(schema.unworkedPaymentRules.organizationId, organizationId),
          sql`(${schema.unworkedPaymentRules.employeeId} = ${staffProfileId} OR ${schema.unworkedPaymentRules.employeeId} IS NULL)`,
          sql`(${schema.unworkedPaymentRules.premisesId} = ${premisesId} OR ${schema.unworkedPaymentRules.premisesId} IS NULL)`
        )
      );

    const resolveUnworkedCents = (
      dayType: 'HOLIDAY' | 'WEEKLY_OFF' | 'PAID_LEAVE',
      date: string,
      fallbackCents: number
    ) => {
      const candidates = unworkedRules
        .filter(
          (rule) =>
            rule.dayType === dayType &&
            rule.createdAt.toISOString().slice(0, 10) <= date
        )
        .sort((a, b) => {
          const specificityA =
            (a.employeeId === staffProfileId ? 2 : 0) +
            (a.premisesId === premisesId ? 2 : 0);
          const specificityB =
            (b.employeeId === staffProfileId ? 2 : 0) +
            (b.premisesId === premisesId ? 2 : 0);
          if (specificityA !== specificityB) return specificityB - specificityA;
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
      const rule = candidates[0];
      if (!rule) return fallbackCents;
      if (Number(rule.paymentInr) > 0) return Number(rule.paymentInr);
      if (rule.multiplierBasisPoints > 0) {
        return Math.round((fallbackCents * rule.multiplierBasisPoints) / 10000);
      }
      return fallbackCents;
    };

    // 2. Paid holidays. A worked holiday is already paid as a normal SHIFT day.
    const holidays = await fastify.db
      .select()
      .from(schema.holidayCalendars)
      .where(
        and(
          eq(schema.holidayCalendars.organizationId, organizationId),
          gte(schema.holidayCalendars.date, startDate),
          sql`${schema.holidayCalendars.date} < ${nextMonthStartDate}`
        )
      );

    const holidayDates = new Set<string>();
    for (const holiday of holidays) {
      const holidayDate = String(holiday.date);
      holidayDates.add(holidayDate);
      if (!holiday.isPaid || workedDates.has(holidayDate)) continue;

      await insertLedgerIfMissing({
        earningDate: holidayDate,
        type: 'HOLIDAY',
        amountCents: resolveUnworkedCents(
          'HOLIDAY',
          holidayDate,
          dailyPresentCents || fallbackDailyCents
        ),
        sourceReference: `holiday:${holiday.id}:HOLIDAY`,
      });
    }

    // 3. Weekly off days -> OFF_DAY, unless the employee actually worked.
    const weeklyOffRows = await fastify.db
      .select({ dayOfWeek: schema.weeklyOffs.dayOfWeek })
      .from(schema.weeklyOffs)
      .where(eq(schema.weeklyOffs.employeeId, staffProfileId));
    const weeklyOffDays = new Set(weeklyOffRows.map((row) => row.dayOfWeek));

    for (const date of enumerateDates(startDate, lastDayOfMonth)) {
      if (
        !weeklyOffDays.has(dayOfWeek(date)) ||
        holidayDates.has(date) ||
        workedDates.has(date)
      ) {
        continue;
      }

      await insertLedgerIfMissing({
        earningDate: date,
        type: 'OFF_DAY',
        amountCents: resolveUnworkedCents(
          'WEEKLY_OFF',
          date,
          dailyPresentCents || fallbackDailyCents
        ),
        sourceReference: `weekly-off:${staffProfileId}:${date}:OFF_DAY`,
      });
    }

    // 4. Approved paid leave is represented by an attendance row with LEAVE.
    // Only create it when the day was not already paid as worked/holiday/off.
    for (const ev of attendanceEvents) {
      if (ev.status !== 'LEAVE') continue;
      const workDate = String(ev.workDate);
      if (workedDates.has(workDate) || holidayDates.has(workDate)) continue;
      if (weeklyOffDays.has(dayOfWeek(workDate))) continue;

      const assignment = ev.shiftAssignmentId
        ? assignmentById.get(ev.shiftAssignmentId)
        : undefined;
      await insertLedgerIfMissing({
        earningDate: workDate,
        type: 'SHIFT',
        amountCents: resolveUnworkedCents(
          'PAID_LEAVE',
          workDate,
          cents(assignment?.leavePay) || dailyPresentCents || fallbackDailyCents
        ),
        shiftAssignmentId: ev.shiftAssignmentId,
        attendanceId: ev.id,
        sourceReference: `leave:${ev.id}:SHIFT`,
      });
    }

    // 5. Overtime -> OVERTIME earnings.
    const overtimeRecords = await fastify.db
      .select()
      .from(schema.overtime)
      .where(
        and(
          eq(schema.overtime.organizationId, organizationId),
          eq(schema.overtime.employeeId, staffProfileId),
          gte(schema.overtime.workDate, startDate),
          sql`${schema.overtime.workDate} < ${nextMonthStartDate}`,
          sql`${schema.overtime.status} IN ('APPROVED', 'COMPLETED', 'PAID', 'CLOSED')`
        )
      );

    const earningLedger = (schema as any).employeeEarningLedger;
    for (const ot of overtimeRecords) {
      const [existing] = await fastify.db
        .select({ id: earningLedger.id })
        .from(earningLedger)
        .where(
          and(
            eq(earningLedger.overtimeId, ot.id),
            eq(earningLedger.type, 'OVERTIME')
          )
        )
        .limit(1);

      if (existing) continue;

      const otAmountCents = Number((ot as any).paymentCents ?? (ot as any).paymentInr ?? 0);
      await fastify.db.insert(earningLedger).values({
        organizationId,
        premisesId,
        employeeId: staffProfileId,
        earningDate: ot.workDate,
        type: 'OVERTIME',
        amount: (otAmountCents / 100).toFixed(2),
        overtimeId: ot.id,
        sourceReference: `overtime:${ot.id}:OVERTIME`,
      });
    }
  } catch (err) {
    fastify.log.warn({ err, staffProfileId }, 'Failed to generate earning ledger entries');
  }
}

/**
 * 2. Get or generate monthly payroll.
 */
export async function getOrGenerateMonthlyPayroll(
  fastify: FastifyInstance,
  organizationId: string,
  premisesId: string,
  staffProfileId: string,
  month: number,
  year: number
) {
  await rebuildMonthlyAttendanceStats(fastify, organizationId, month, year, premisesId, staffProfileId);
  await generateDailyEarningLedgerEntries(fastify, organizationId, premisesId, staffProfileId, month, year);

  let [payroll] = await fastify.db
    .select()
    .from(schema.monthlyPayrolls)
    .where(
      and(
        eq(schema.monthlyPayrolls.organizationId, organizationId),
        eq(schema.monthlyPayrolls.premisesId, premisesId),
        eq(schema.monthlyPayrolls.employeeId, staffProfileId),
        eq(schema.monthlyPayrolls.month, month),
        eq(schema.monthlyPayrolls.year, year)
      )
    )
    .limit(1);

  if (!payroll) {
    const [inserted] = await fastify.db
      .insert(schema.monthlyPayrolls)
      .values({
        organizationId,
        premisesId,
        employeeId: staffProfileId,
        month,
        year,
        earnedAmount: '0.00',
        deductionAmount: '0.00',
        paidAmount: '0.00',
        dueAmount: '0.00',
        status: 'OPEN',
      })
      .returning();
    payroll = inserted;
  }

  return await reconcileMonthlyPayrollById(fastify, payroll.id);
}

/**
 * 9. Recalculate and reconcile monthly payroll summary.
 */
async function reconcileMonthlyPayrollById(fastify: FastifyInstance, payrollId: string) {
  const [payroll] = await fastify.db
    .select()
    .from(schema.monthlyPayrolls)
    .where(eq(schema.monthlyPayrolls.id, payrollId))
    .limit(1);

  if (!payroll) {
    throw new AppError('Monthly payroll not found', 404, 'PAYROLL_NOT_FOUND');
  }

  const { startDate, nextMonthStartDate } = getMonthDateRange(payroll.year, payroll.month);

  const earningLedger = (schema as any).employeeEarningLedger;
  const [earnedResult] = await fastify.db
    .select({
      total: sql<string>`COALESCE(SUM(${earningLedger.amount}), 0)`,
    })
    .from(earningLedger)
    .where(
      and(
        eq(earningLedger.employeeId, payroll.employeeId),
        eq(earningLedger.premisesId, payroll.premisesId),
        gte(earningLedger.earningDate, startDate),
        sql`${earningLedger.earningDate} < ${nextMonthStartDate}`
      )
    );

  const earnedAmount = Number(earnedResult?.total ?? 0);

  const [deductionResult] = await fastify.db
    .select({
      total: sql<string>`COALESCE(SUM(${schema.payrollDeductions.amount}), 0)`,
    })
    .from(schema.payrollDeductions)
    .where(eq(schema.payrollDeductions.monthlyPayrollId, payrollId));

  const deductionAmount = Number(deductionResult?.total ?? 0);

  const [paidResult] = await fastify.db
    .select({
      total: sql<string>`COALESCE(SUM(${schema.payrollTransactions.amount}), 0)`,
    })
    .from(schema.payrollTransactions)
    .where(eq(schema.payrollTransactions.monthlyPayrollId, payrollId));

  const paidAmount = Number(paidResult?.total ?? 0);

  const dueAmount = Math.max(0, earnedAmount - deductionAmount - paidAmount);
  const status = paidAmount > 0 && dueAmount <= 0 ? 'PAID' : payroll.status;

  const [updated] = await fastify.db
    .update(schema.monthlyPayrolls)
    .set({
      earnedAmount: earnedAmount.toFixed(2),
      deductionAmount: deductionAmount.toFixed(2),
      paidAmount: paidAmount.toFixed(2),
      dueAmount: dueAmount.toFixed(2),
      status,
      updatedAt: new Date(),
    })
    .where(eq(schema.monthlyPayrolls.id, payrollId))
    .returning();

  return updated;
}

/**
 * 3. Get monthly payroll summaries.
 */
export async function listMonthlyPayrollSummaries(
  fastify: FastifyInstance,
  organizationId: string,
  month: number,
  year: number,
  premisesId?: string
) {
  const staffList = await listOrganizationStaff(fastify, organizationId);
  const filteredStaff = staffList.filter((s) => !premisesId || s.premisesId === premisesId);

  const summaries = [];
  for (const staff of filteredStaff) {
    if (!staff.premisesId) continue;
    const payroll = await getOrGenerateMonthlyPayroll(
      fastify,
      organizationId,
      staff.premisesId,
      staff.id,
      month,
      year
    );

    summaries.push({
      ...payroll,
      staffName: staff.fullName,
      staffCode: staff.employeeCode,
      staffEmail: staff.email,
    });
  }

  return summaries;
}

/**
 * 4. Get daily earning ledger entries.
 */
export async function getDailyEarningLedger(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string,
  month: number,
  year: number
) {
  const { startDate, nextMonthStartDate } = getMonthDateRange(year, month);
  const earningLedger = (schema as any).employeeEarningLedger;
  return await fastify.db
    .select()
    .from(earningLedger)
    .where(
      and(
        eq(earningLedger.organizationId, organizationId),
        eq(earningLedger.employeeId, staffProfileId),
        gte(earningLedger.earningDate, startDate),
        sql`${earningLedger.earningDate} < ${nextMonthStartDate}`
      )
    )
    .orderBy(desc(earningLedger.earningDate));
}

/**
 * 5. Get daily earning totals.
 */
export async function getDailyEarningTotals(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string,
  month: number,
  year: number
) {
  const entries = await getDailyEarningLedger(fastify, organizationId, staffProfileId, month, year);
  const grouped = new Map<string, typeof entries>();

  for (const entry of entries) {
    const date = entry.earningDate;
    const list = grouped.get(date) ?? [];
    list.push(entry);
    grouped.set(date, list);
  }

  const totals = [];
  for (const [date, list] of grouped.entries()) {
    const totalAmount = list.reduce((sum, e) => sum + Number(e.amount), 0);
    totals.push({
      earningDate: date,
      totalAmount: totalAmount.toFixed(2),
      entryCount: list.length,
      entries: list,
    });
  }

  return totals.sort((a, b) => b.earningDate.localeCompare(a.earningDate));
}

/**
 * 6. Create / delete monthly deductions.
 */
export async function createPayrollDeduction(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string,
  input: { monthlyPayrollId: string; amount: number; reason: string }
) {
  const [payroll] = await fastify.db
    .select()
    .from(schema.monthlyPayrolls)
    .where(
      and(
        eq(schema.monthlyPayrolls.id, input.monthlyPayrollId),
        eq(schema.monthlyPayrolls.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!payroll) {
    throw new AppError('Monthly payroll not found', 404, 'PAYROLL_NOT_FOUND');
  }

  const [deduction] = await fastify.db
    .insert(schema.payrollDeductions)
    .values({
      monthlyPayrollId: input.monthlyPayrollId,
      amount: input.amount.toFixed(2),
      reason: input.reason,
      createdBy: userId,
    })
    .returning();

  await reconcileMonthlyPayrollById(fastify, input.monthlyPayrollId);
  return deduction;
}

export async function deletePayrollDeduction(fastify: FastifyInstance, organizationId: string, deductionId: string) {
  const [deduction] = await fastify.db
    .select({
      deduction: schema.payrollDeductions,
      payroll: schema.monthlyPayrolls,
    })
    .from(schema.payrollDeductions)
    .innerJoin(schema.monthlyPayrolls, eq(schema.monthlyPayrolls.id, schema.payrollDeductions.monthlyPayrollId))
    .where(
      and(
        eq(schema.payrollDeductions.id, deductionId),
        eq(schema.monthlyPayrolls.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!deduction) {
    throw new AppError('Payroll deduction not found', 404, 'DEDUCTION_NOT_FOUND');
  }

  await fastify.db.delete(schema.payrollDeductions).where(eq(schema.payrollDeductions.id, deductionId));
  await reconcileMonthlyPayrollById(fastify, deduction.payroll.id);
  return { status: 'DELETED' };
}

export async function updatePayrollDeduction(
  fastify: FastifyInstance,
  organizationId: string,
  deductionId: string,
  input: { amount?: number; reason?: string }
) {
  const [deduction] = await fastify.db
    .select({
      deduction: schema.payrollDeductions,
      payroll: schema.monthlyPayrolls,
    })
    .from(schema.payrollDeductions)
    .innerJoin(schema.monthlyPayrolls, eq(schema.monthlyPayrolls.id, schema.payrollDeductions.monthlyPayrollId))
    .where(
      and(
        eq(schema.payrollDeductions.id, deductionId),
        eq(schema.monthlyPayrolls.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!deduction) {
    throw new AppError('Payroll deduction not found', 404, 'DEDUCTION_NOT_FOUND');
  }

  const set: any = {};
  if (input.amount !== undefined) {
    set.amount = input.amount.toFixed(2);
  }
  if (input.reason !== undefined) {
    set.reason = input.reason;
  }

  const [updated] = await fastify.db
    .update(schema.payrollDeductions)
    .set(set)
    .where(eq(schema.payrollDeductions.id, deductionId))
    .returning();

  await reconcileMonthlyPayrollById(fastify, deduction.payroll.id);
  return updated;
}

export async function listPayrollDeductions(fastify: FastifyInstance, monthlyPayrollId: string, organizationId?: string) {
  if (organizationId) {
    const [payroll] = await fastify.db
      .select()
      .from(schema.monthlyPayrolls)
      .where(and(eq(schema.monthlyPayrolls.id, monthlyPayrollId), eq(schema.monthlyPayrolls.organizationId, organizationId)))
      .limit(1);

    if (!payroll) {
      throw new AppError('Monthly payroll not found', 404, 'PAYROLL_NOT_FOUND');
    }
  }

  return await fastify.db
    .select()
    .from(schema.payrollDeductions)
    .where(eq(schema.payrollDeductions.monthlyPayrollId, monthlyPayrollId));
}

/**
 * 7. Record / delete salary payments.
 */
export async function recordPayrollTransaction(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string,
  input: { monthlyPayrollId: string; amount: number; paymentDate: string; paymentMethod: string; reference?: string }
) {
  const [payroll] = await fastify.db
    .select()
    .from(schema.monthlyPayrolls)
    .where(
      and(
        eq(schema.monthlyPayrolls.id, input.monthlyPayrollId),
        eq(schema.monthlyPayrolls.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!payroll) {
    throw new AppError('Monthly payroll not found', 404, 'PAYROLL_NOT_FOUND');
  }

  const dueAmount = Number(payroll.dueAmount);
  if (input.amount > dueAmount) {
    throw new AppError(
      `Payment amount exceeds due balance of ${dueAmount}`,
      400,
      'PAYMENT_EXCEEDS_DUE_BALANCE',
      { dueAmount }
    );
  }

  const [transaction] = await fastify.db
    .insert(schema.payrollTransactions)
    .values({
      monthlyPayrollId: input.monthlyPayrollId,
      amount: input.amount.toFixed(2),
      paymentDate: input.paymentDate,
      paymentMethod: input.paymentMethod,
      reference: input.reference ?? null,
      createdBy: userId,
    })
    .returning();

  await reconcileMonthlyPayrollById(fastify, input.monthlyPayrollId);
  return transaction;
}

export async function deletePayrollTransaction(fastify: FastifyInstance, organizationId: string, transactionId: string) {
  const [txRecord] = await fastify.db
    .select({
      tx: schema.payrollTransactions,
      payroll: schema.monthlyPayrolls,
    })
    .from(schema.payrollTransactions)
    .innerJoin(schema.monthlyPayrolls, eq(schema.monthlyPayrolls.id, schema.payrollTransactions.monthlyPayrollId))
    .where(
      and(
        eq(schema.payrollTransactions.id, transactionId),
        eq(schema.monthlyPayrolls.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!txRecord) {
    throw new AppError('Payment transaction not found', 404, 'TRANSACTION_NOT_FOUND');
  }

  await fastify.db.delete(schema.payrollTransactions).where(eq(schema.payrollTransactions.id, transactionId));
  await reconcileMonthlyPayrollById(fastify, txRecord.payroll.id);
  return { status: 'DELETED' };
}

export async function updatePayrollTransaction(
  fastify: FastifyInstance,
  organizationId: string,
  transactionId: string,
  input: { amount?: number; paymentDate?: string; paymentMethod?: string; referenceNumber?: string | null; notes?: string | null }
) {
  const [txRecord] = await fastify.db
    .select({
      tx: schema.payrollTransactions,
      payroll: schema.monthlyPayrolls,
    })
    .from(schema.payrollTransactions)
    .innerJoin(schema.monthlyPayrolls, eq(schema.monthlyPayrolls.id, schema.payrollTransactions.monthlyPayrollId))
    .where(
      and(
        eq(schema.payrollTransactions.id, transactionId),
        eq(schema.monthlyPayrolls.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!txRecord) {
    throw new AppError('Payment transaction not found', 404, 'TRANSACTION_NOT_FOUND');
  }

  const set: any = {};
  if (input.amount !== undefined) set.amount = input.amount.toFixed(2);
  if (input.paymentDate !== undefined) set.paymentDate = input.paymentDate;
  if (input.paymentMethod !== undefined) set.paymentMethod = input.paymentMethod;
  if (input.referenceNumber !== undefined) set.reference = input.referenceNumber;
  if (input.notes !== undefined) set.notes = input.notes;

  const [updated] = await fastify.db
    .update(schema.payrollTransactions)
    .set(set)
    .where(eq(schema.payrollTransactions.id, transactionId))
    .returning();

  await reconcileMonthlyPayrollById(fastify, txRecord.payroll.id);
  return updated;
}

export async function listPayrollTransactions(fastify: FastifyInstance, monthlyPayrollId: string, organizationId?: string) {
  if (organizationId) {
    const [payroll] = await fastify.db
      .select()
      .from(schema.monthlyPayrolls)
      .where(and(eq(schema.monthlyPayrolls.id, monthlyPayrollId), eq(schema.monthlyPayrolls.organizationId, organizationId)))
      .limit(1);

    if (!payroll) {
      throw new AppError('Monthly payroll not found', 404, 'PAYROLL_NOT_FOUND');
    }
  }

  return await fastify.db
    .select()
    .from(schema.payrollTransactions)
    .where(eq(schema.payrollTransactions.monthlyPayrollId, monthlyPayrollId));
}

const BASIS_POINTS = 10_000;

function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100);
}

function toMoney(cents: number): string {
  return (Math.max(0, Math.round(cents)) / 100).toFixed(2);
}

export function daysInMonth(dateIso: string): number {
  const [year, month] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface AssignmentPay {
  id: string;
  organizationId: string;
  premisesId: string;
  employeeId: string;
  absentPay: string;
  presentPay: string;
  leavePay: string;
  halfDayPay: string;
  createdAt: Date;
  updatedAt: Date;
}

async function loadActiveAssignment(
  fastify: FastifyInstance,
  organizationId: string,
  employeeId: string,
  premisesId?: string | null
): Promise<AssignmentPay | null> {
  const conditions = [
    eq(schema.employeeShiftAssignments.organizationId, organizationId),
    eq(schema.employeeShiftAssignments.employeeId, employeeId),
    eq(schema.employeeShiftAssignments.isActive, true),
  ];

  if (premisesId) {
    conditions.push(eq(schema.employeeShiftAssignments.premisesId, premisesId));
  }

  const [assignment] = await fastify.db
    .select({
      id: schema.employeeShiftAssignments.id,
      organizationId: schema.employeeShiftAssignments.organizationId,
      premisesId: schema.employeeShiftAssignments.premisesId,
      employeeId: schema.employeeShiftAssignments.employeeId,
      absentPay: schema.employeeShiftAssignments.absentPay,
      presentPay: schema.employeeShiftAssignments.presentPay,
      leavePay: schema.employeeShiftAssignments.leavePay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
      createdAt: schema.employeeShiftAssignments.createdAt,
      updatedAt: schema.employeeShiftAssignments.updatedAt,
    })
    .from(schema.employeeShiftAssignments)
    .where(and(...conditions))
    .limit(1);

  return assignment ?? null;
}

export async function getCurrentSalaryStructure(
  fastify: FastifyInstance,
  employeeId: string,
  onDate?: string,
  organizationId?: string
) {
  const effectiveOn = onDate ?? new Date().toISOString().slice(0, 10);

  const conditions = [
    eq(schema.employeeShiftAssignments.employeeId, employeeId),
    eq(schema.employeeShiftAssignments.isActive, true),
  ];
  if (organizationId) {
    conditions.push(
      eq(schema.employeeShiftAssignments.organizationId, organizationId)
    );
  }

  const [assignment] = await fastify.db
    .select({
      id: schema.employeeShiftAssignments.id,
      organizationId: schema.employeeShiftAssignments.organizationId,
      presentPay: schema.employeeShiftAssignments.presentPay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
      absentPay: schema.employeeShiftAssignments.absentPay,
      leavePay: schema.employeeShiftAssignments.leavePay,
      createdAt: schema.employeeShiftAssignments.createdAt,
    })
    .from(schema.employeeShiftAssignments)
    .where(and(...conditions))
    .limit(1);

  if (!assignment) {
    throw new AppError(
      'Shift assignment pay is not configured',
      404,
      'SALARY_NOT_CONFIGURED'
    );
  }

  const presentCents = toCents(assignment.presentPay);

  return {
    id: assignment.id,
    employeeId,
    compensationType: 'SHIFT' as const,
    baseRateCents: presentCents * 30,
    overtimeRateCents: 0,
    effectiveFrom: String(effectiveOn),
    effectiveTo: null as string | null,
    presentCents,
    halfDayCents: toCents(assignment.halfDayPay),
    absentCents: toCents(assignment.absentPay),
    leaveCents: toCents(assignment.leavePay),
    createdAt: assignment.createdAt,
  };
}

export interface PaymentRuleLike {
  employeeId?: string | null;
  attendanceStatus?: string;
  dayType?: string;
  paymentCents?: number;
  penaltyCents?: number;
  multiplierBasisPoints?: number;
}

export interface SalaryCalculationInput {
  compensationType: 'MONTHLY' | 'DAILY' | 'HOURLY' | 'SHIFT' | 'MIXED';
  baseRateCents: number;
  overtimeRateCents: number;
  shiftPaymentRules?: PaymentRuleLike[];
  unworkedPaymentRules?: PaymentRuleLike[];
  attendanceSummary: {
    presentDays: number;
    lateDays: number;
    halfDays: number;
    absentDays: number;
    totalWorkedMinutes: number;
    totalOvertimeMinutes: number;
    holidayDays: number;
    paidLeaveDays?: number;
    weeklyOffDays?: number;
  };
  workingDaysInMonth?: number;
}

function pickRule(
  rules: PaymentRuleLike[] | undefined,
  key: 'attendanceStatus' | 'dayType',
  value: string
): PaymentRuleLike | null {
  if (!rules || rules.length === 0) {
    return null;
  }
  const matching = rules.filter((rule) => rule[key] === value);
  if (matching.length === 0) {
    return null;
  }
  return matching.find((rule) => Boolean(rule.employeeId)) ?? matching[0];
}

function multiplyBasisPoints(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / BASIS_POINTS);
}

export function calculateSalary(params: SalaryCalculationInput) {
  const {
    compensationType,
    baseRateCents,
    overtimeRateCents,
    shiftPaymentRules,
    unworkedPaymentRules,
    attendanceSummary,
    workingDaysInMonth = 30,
  } = params;

  const presentDays = Math.max(0, attendanceSummary.presentDays);
  const lateDays = Math.max(0, attendanceSummary.lateDays);
  const halfDays = Math.max(0, attendanceSummary.halfDays);
  const absentDays = Math.max(0, attendanceSummary.absentDays);
  const paidLeaveDays = Math.max(0, attendanceSummary.paidLeaveDays ?? 0);
  const paidHolidayDays = Math.max(0, attendanceSummary.holidayDays);
  const weeklyOffDays = Math.max(0, attendanceSummary.weeklyOffDays ?? 0);
  const workedDays = presentDays + halfDays * 0.5;

  const rulePresent = pickRule(shiftPaymentRules, 'attendanceStatus', 'PRESENT');
  const ruleLate = pickRule(shiftPaymentRules, 'attendanceStatus', 'LATE');
  const ruleHalfDay = pickRule(shiftPaymentRules, 'attendanceStatus', 'HALF_DAY');
  const ruleAbsent = pickRule(shiftPaymentRules, 'attendanceStatus', 'ABSENT');
  const hasShiftRules = Boolean(rulePresent || ruleLate || ruleHalfDay || ruleAbsent);

  const ruleHoliday = pickRule(unworkedPaymentRules, 'dayType', 'HOLIDAY');
  const ruleWeeklyOff = pickRule(unworkedPaymentRules, 'dayType', 'WEEKLY_OFF');
  const rulePaidLeave = pickRule(unworkedPaymentRules, 'dayType', 'PAID_LEAVE');

  const earnings: Array<{ code: string; label: string; amountCents: number }> = [];
  const deductions: Array<{ code: string; label: string; amountCents: number }> = [];

  const dailyRate = Math.round(baseRateCents / Math.max(1, workingDaysInMonth));

  const push = (code: string, label: string, amountCents: number) => {
    const rounded = Math.max(0, Math.round(amountCents));
    if (rounded > 0) {
      earnings.push({ code, label, amountCents: rounded });
    }
    return rounded;
  };

  const deduct = (code: string, label: string, amountCents: number) => {
    const rounded = Math.max(0, Math.round(amountCents));
    if (rounded > 0) {
      deductions.push({ code, label, amountCents: rounded });
    }
    return rounded;
  };

  let basePay = 0;
  let overtimePay = 0;

  if (hasShiftRules) {
    const regularPresentDays = Math.max(0, presentDays - lateDays);
    basePay =
      regularPresentDays * (rulePresent?.paymentCents ?? baseRateCents) +
      lateDays * (ruleLate?.paymentCents ?? rulePresent?.paymentCents ?? baseRateCents) +
      halfDays * (ruleHalfDay?.paymentCents ?? Math.round(baseRateCents / 2));

    push('BASE_SALARY', 'Shift attendance payments', basePay);
    if (ruleAbsent?.penaltyCents && absentDays > 0) {
      deduct('ABSENT_PENALTY', 'Absent day penalty', ruleAbsent.penaltyCents * absentDays);
    }
  } else if (compensationType === 'MONTHLY') {
    const pricedPaidLeaveDays = rulePaidLeave ? 0 : paidLeaveDays;
    const pricedPaidHolidays = ruleHoliday ? 0 : paidHolidayDays;
    const pricedWeeklyOffDays = ruleWeeklyOff ? 0 : weeklyOffDays;
    basePay = Math.round(dailyRate * (workedDays + pricedPaidLeaveDays + pricedPaidHolidays + pricedWeeklyOffDays));
    push('BASE_SALARY', 'Base salary', basePay);
  } else if (compensationType === 'DAILY') {
    basePay = Math.round(baseRateCents * workedDays);
    push('BASE_SALARY', 'Daily wage', basePay);
  } else if (compensationType === 'HOURLY') {
    basePay = Math.round((baseRateCents * attendanceSummary.totalWorkedMinutes) / 60);
    push('BASE_SALARY', 'Hourly wage', basePay);
  } else if (compensationType === 'SHIFT') {
    basePay = Math.round(baseRateCents * workedDays);
    push('BASE_SALARY', 'Shift wage', basePay);
  } else {
    const pricedPaidLeaveDays = rulePaidLeave ? 0 : paidLeaveDays;
    const pricedPaidHolidays = ruleHoliday ? 0 : paidHolidayDays;
    const pricedWeeklyOffDays = ruleWeeklyOff ? 0 : weeklyOffDays;
    basePay = Math.round(dailyRate * (workedDays + pricedPaidLeaveDays + pricedPaidHolidays + pricedWeeklyOffDays));
    push('BASE_SALARY', 'Fixed monthly base', basePay);

    overtimePay = Math.round(
      (overtimeRateCents * Math.max(0, attendanceSummary.totalOvertimeMinutes)) / 60
    );
    push('OVERTIME', 'Overtime pay', overtimePay);
  }

  const leaveAndHolidayRate = compensationType === 'MONTHLY' || compensationType === 'MIXED'
    ? dailyRate
    : compensationType === 'HOURLY'
      ? Math.round((baseRateCents * 480) / 60)
      : baseRateCents;

  let unworkedHolidayPay = 0;
  if (paidHolidayDays > 0 && ruleHoliday) {
    const perDay = ruleHoliday.paymentCents && ruleHoliday.paymentCents > 0
      ? ruleHoliday.paymentCents
      : Math.round(leaveAndHolidayRate * ((ruleHoliday.multiplierBasisPoints ?? 10_000) / BASIS_POINTS));
    unworkedHolidayPay = perDay * paidHolidayDays;
    push('HOLIDAY_PAY', 'Paid holiday pay', unworkedHolidayPay);
  }

  let paidLeavePay = 0;
  if (paidLeaveDays > 0 && rulePaidLeave) {
    const perDay = rulePaidLeave.paymentCents && rulePaidLeave.paymentCents > 0
      ? rulePaidLeave.paymentCents
      : Math.round(leaveAndHolidayRate * ((rulePaidLeave.multiplierBasisPoints ?? 10_000) / BASIS_POINTS));
    paidLeavePay = perDay * paidLeaveDays;
    push('PAID_LEAVE', 'Paid leave', paidLeavePay);
  }

  let unworkedWeeklyOffPay = 0;
  if (weeklyOffDays > 0 && ruleWeeklyOff) {
    const perDay = ruleWeeklyOff.paymentCents && ruleWeeklyOff.paymentCents > 0
      ? ruleWeeklyOff.paymentCents
      : Math.round(leaveAndHolidayRate * ((ruleWeeklyOff.multiplierBasisPoints ?? 10_000) / BASIS_POINTS));
    unworkedWeeklyOffPay = perDay * weeklyOffDays;
    push('WEEKLY_OFF_PAY', 'Weekly-off pay', unworkedWeeklyOffPay);
  }

  const grossSalaryCents = earnings.reduce((sum, item) => sum + item.amountCents, 0);
  const deductionsCents = deductions.reduce((sum, item) => sum + item.amountCents, 0);
  const netSalaryCents = Math.max(0, grossSalaryCents - deductionsCents);

  return {
    grossSalaryCents,
    additionsCents:
      unworkedHolidayPay +
      paidLeavePay +
      unworkedWeeklyOffPay +
      overtimePay,
    deductionsCents,
    netSalaryCents,
    breakdown: { earnings, deductions },
  };
}

export function calculateDailyAccrual(params: {
  compensationType: 'MONTHLY' | 'DAILY' | 'HOURLY' | 'SHIFT' | 'MIXED';
  baseRateCents: number;
  overtimeRateCents: number;
  shiftPaymentRules?: PaymentRuleLike[];
  unworkedPaymentRules?: PaymentRuleLike[];
  status: 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT';
  workedMinutes: number;
  overtimeMinutes: number;
  periodStartDate: string;
  overtimeRateApplies?: boolean;
}): number {
  const {
    compensationType,
    baseRateCents,
    overtimeRateCents,
    shiftPaymentRules,
    status,
    workedMinutes,
    overtimeMinutes,
    periodStartDate,
  } = params;

  if (status === 'ABSENT') {
    return 0;
  }

  const directShiftRule = pickRule(shiftPaymentRules, 'attendanceStatus', status);

  const fraction = status === 'HALF_DAY' ? 0.5 : 1;
  const dailyRate = Math.round(baseRateCents / Math.max(1, daysInMonth(periodStartDate)));

  let amount = 0;

  if (directShiftRule?.paymentCents != null) {
    amount = directShiftRule.paymentCents * fraction;
    if (compensationType === 'MIXED') {
      amount += Math.round((overtimeRateCents * Math.max(0, overtimeMinutes)) / 60);
    }
  } else if (compensationType === 'MONTHLY') {
    amount = Math.round(dailyRate * fraction);
  } else if (compensationType === 'DAILY' || compensationType === 'SHIFT') {
    amount = Math.round(baseRateCents * fraction);
  } else if (compensationType === 'HOURLY') {
    amount = Math.round((baseRateCents * Math.max(0, workedMinutes)) / 60);
  } else {
    amount = Math.round(dailyRate * fraction);
    amount += Math.round((overtimeRateCents * Math.max(0, overtimeMinutes)) / 60);
  }

  return Math.max(0, amount);
}

export interface ShiftPayRule {
  id: string;
  organizationId: string;
  employeeId: string | null;
  premisesId: string | null;
  attendanceStatus: 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT';
  paymentCents: number;
  penaltyCents: number;
  multiplierBasisPoints: number;
  effectiveFrom: string;
  createdAt: string;
}

function assignmentRule(
  assignment: AssignmentPay,
  attendanceStatus: ShiftPayRule['attendanceStatus'],
  paymentCents: number
): ShiftPayRule {
  return {
    id: assignment.id,
    organizationId: assignment.organizationId,
    employeeId: assignment.employeeId,
    premisesId: assignment.premisesId,
    attendanceStatus,
    paymentCents,
    penaltyCents: 0,
    multiplierBasisPoints: 10_000,
    effectiveFrom: assignment.createdAt.toISOString().slice(0, 10),
    createdAt: assignment.createdAt.toISOString(),
  };
}

export async function getShiftPaymentRules(
  fastify: FastifyInstance,
  organizationId: string,
  employeeId?: string,
  _onDate?: string
): Promise<ShiftPayRule[]> {
  const conditions = [
    eq(schema.employeeShiftAssignments.organizationId, organizationId),
    eq(schema.employeeShiftAssignments.isActive, true),
  ];
  if (employeeId) {
    conditions.push(eq(schema.employeeShiftAssignments.employeeId, employeeId));
  }

  const assignments = await fastify.db
    .select({
      id: schema.employeeShiftAssignments.id,
      organizationId: schema.employeeShiftAssignments.organizationId,
      premisesId: schema.employeeShiftAssignments.premisesId,
      employeeId: schema.employeeShiftAssignments.employeeId,
      absentPay: schema.employeeShiftAssignments.absentPay,
      presentPay: schema.employeeShiftAssignments.presentPay,
      leavePay: schema.employeeShiftAssignments.leavePay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
      createdAt: schema.employeeShiftAssignments.createdAt,
      updatedAt: schema.employeeShiftAssignments.updatedAt,
    })
    .from(schema.employeeShiftAssignments)
    .where(and(...conditions));

  return assignments.flatMap((assignment) => [
    assignmentRule(assignment, 'PRESENT', toCents(assignment.presentPay)),
    assignmentRule(assignment, 'LATE', toCents(assignment.presentPay)),
    assignmentRule(assignment, 'HALF_DAY', toCents(assignment.halfDayPay)),
    assignmentRule(assignment, 'ABSENT', toCents(assignment.absentPay)),
  ]);
}

export async function getUnworkedPaymentRules(
  fastify: FastifyInstance,
  organizationId: string,
  employeeId?: string,
  onDate?: string
) {
  const rows = await fastify.db
    .select()
    .from(schema.unworkedPaymentRules)
    .where(
      and(
        eq(schema.unworkedPaymentRules.organizationId, organizationId),
        employeeId
          ? sql`(${schema.unworkedPaymentRules.employeeId} = ${employeeId} OR ${schema.unworkedPaymentRules.employeeId} IS NULL)`
          : sql`${schema.unworkedPaymentRules.employeeId} IS NULL`
      )
    )
    .orderBy(desc(schema.unworkedPaymentRules.createdAt));

  return rows;
}

export async function createShiftPaymentRule(
  fastify: FastifyInstance,
  organizationId: string,
  input: {
    employeeId?: string | null;
    premisesId?: string | null;
    attendanceStatus: 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT';
    paymentCents: number;
    penaltyCents?: number;
    multiplierBasisPoints?: number;
    effectiveFrom?: string;
  }
): Promise<ShiftPayRule> {
  if (!input.employeeId) {
    throw new AppError(
      'Select an employee: shift pay is configured on the employee shift assignment.',
      400,
      'EMPLOYEE_REQUIRED'
    );
  }

  const assignment = await loadActiveAssignment(
    fastify,
    organizationId,
    input.employeeId,
    input.premisesId
  );

  if (!assignment) {
    throw new AppError(
      'Active shift assignment not found',
      404,
      'SHIFT_ASSIGNMENT_NOT_FOUND'
    );
  }

  const payColumn =
    input.attendanceStatus === 'HALF_DAY'
      ? 'halfDayPay'
      : input.attendanceStatus === 'ABSENT'
        ? 'absentPay'
        : 'presentPay';

  const effectiveFrom =
    input.effectiveFrom ?? new Date().toISOString().slice(0, 10);

  const [updated] = await fastify.db
    .update(schema.employeeShiftAssignments)
    .set({
      [payColumn]: toMoney(input.paymentCents),
      updatedAt: new Date(),
    })
    .where(eq(schema.employeeShiftAssignments.id, assignment.id))
    .returning({
      id: schema.employeeShiftAssignments.id,
      organizationId: schema.employeeShiftAssignments.organizationId,
      premisesId: schema.employeeShiftAssignments.premisesId,
      employeeId: schema.employeeShiftAssignments.employeeId,
      absentPay: schema.employeeShiftAssignments.absentPay,
      presentPay: schema.employeeShiftAssignments.presentPay,
      leavePay: schema.employeeShiftAssignments.leavePay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
      createdAt: schema.employeeShiftAssignments.createdAt,
      updatedAt: schema.employeeShiftAssignments.updatedAt,
    });

  return {
    ...assignmentRule(
      updated,
      input.attendanceStatus,
      input.paymentCents
    ),
    effectiveFrom,
  };
}

export async function createUnworkedPaymentRule(
  fastify: FastifyInstance,
  organizationId: string,
  input: {
    employeeId?: string | null;
    premisesId?: string | null;
    dayType: (typeof schema.unworkedDayTypeEnum.enumValues)[number];
    paymentInr?: number;
    paymentCents?: number;
    multiplierBasisPoints?: number;
  }
) {
  if (input.employeeId) {
    const [profile] = await fastify.db
      .select({ id: schema.employees.id })
      .from(schema.employees)
      .where(
        and(
          eq(schema.employees.id, input.employeeId),
          eq(schema.employees.organizationId, organizationId)
        )
      )
      .limit(1);
    if (!profile) {
      throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
    }
  }

  const [created] = await fastify.db
    .insert(schema.unworkedPaymentRules)
    .values({
      organizationId,
      premisesId: input.premisesId ?? null,
      employeeId: input.employeeId ?? null,
      dayType: input.dayType,
      paymentInr: input.paymentInr ?? input.paymentCents ?? 0,
      multiplierBasisPoints: input.multiplierBasisPoints ?? 15000,
    })
    .returning();

  return created;
}

