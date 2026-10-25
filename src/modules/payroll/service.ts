import { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { listOrganizationStaff } from '../../shared/services/staff.service.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import { getCurrentSalaryStructure, getShiftPaymentRules, getUnworkedPaymentRules } from '../salary/service.js';

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
  if (staffProfileId) conditions.push(eq(schema.monthlyAttendanceStats.staffId, staffProfileId));

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
      .from(schema.attendanceEvents)
      .where(
        and(
          eq(schema.attendanceEvents.staffProfileId, staff.id),
          gte(schema.attendanceEvents.workDate, startDate),
          sql`${schema.attendanceEvents.workDate} < ${nextMonthStartDate}`
        )
      );

    let present = 0;
    let absent = 0;
    let halfDay = 0;
    let leave = 0;

    for (const ev of attendanceEvents) {
      if (ev.status === 'PRESENT' || ev.status === 'LATE') present++;
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
      .where(eq(schema.weeklyOffs.staffProfileId, staff.id));

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
          eq(schema.overtime.staffProfileId, staff.id),
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
        staffId: staff.id,
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
          schema.monthlyAttendanceStats.staffId,
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

  const [staff] = await fastify.db
    .select()
    .from(schema.staffProfiles)
    .where(eq(schema.staffProfiles.id, staffProfileId))
    .limit(1);

  if (!staff) return;

  try {
    const salary = await getCurrentSalaryStructure(fastify, staffProfileId, startDate);

    // 1. Attendance events -> SHIFT earnings
    const attendanceEvents = await fastify.db
      .select()
      .from(schema.attendanceEvents)
      .where(
        and(
          eq(schema.attendanceEvents.staffProfileId, staffProfileId),
          gte(schema.attendanceEvents.workDate, startDate),
          sql`${schema.attendanceEvents.workDate} < ${nextMonthStartDate}`
        )
      );

    for (const ev of attendanceEvents) {
      if (!ev.workDate || (ev.status !== 'PRESENT' && ev.status !== 'LATE' && ev.status !== 'HALF_DAY')) {
        continue;
      }

      const [existing] = await fastify.db
        .select()
        .from(schema.employeeEarningLedger)
        .where(
          and(
            eq(schema.employeeEarningLedger.attendanceEventId, ev.id),
            eq(schema.employeeEarningLedger.type, 'SHIFT')
          )
        )
        .limit(1);

      if (existing) continue;

      let amount = Number(salary.baseRateCents ?? 0);
      if (ev.status === 'HALF_DAY') {
        amount = amount / 2;
      }
      const amtStr = amount.toFixed(2);

      await fastify.db.insert(schema.employeeEarningLedger).values({
        organizationId,
        premisesId: ev.premisesId ?? premisesId,
        staffId: staffProfileId,
        earningDate: ev.workDate,
        type: 'SHIFT',
        amount: amtStr,
        shiftAssignmentId: ev.shiftAssignmentId ?? null,
        attendanceEventId: ev.id,
      });
    }

    // 2. Holidays -> HOLIDAY earnings
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

    for (const h of holidays) {
      const [existing] = await fastify.db
        .select()
        .from(schema.employeeEarningLedger)
        .where(
          and(
            eq(schema.employeeEarningLedger.staffId, staffProfileId),
            eq(schema.employeeEarningLedger.earningDate, h.date),
            eq(schema.employeeEarningLedger.type, 'HOLIDAY')
          )
        )
        .limit(1);

      if (existing) continue;

      const dailyRate = Number(salary.baseRateCents ?? 0) / 30;
      await fastify.db.insert(schema.employeeEarningLedger).values({
        organizationId,
        premisesId,
        staffId: staffProfileId,
        earningDate: h.date,
        type: 'HOLIDAY',
        amount: dailyRate.toFixed(2),
      });
    }

    // 3. Overtime -> OVERTIME earnings
    const overtimeRecords = await fastify.db
      .select()
      .from(schema.overtime)
      .where(
        and(
          eq(schema.overtime.organizationId, organizationId),
          eq(schema.overtime.staffProfileId, staffProfileId),
          gte(schema.overtime.workDate, startDate),
          sql`${schema.overtime.workDate} < ${nextMonthStartDate}`,
          sql`${schema.overtime.status} IN ('APPROVED', 'COMPLETED', 'PAID', 'CLOSED')`
        )
      );

    for (const ot of overtimeRecords) {
      const [existing] = await fastify.db
        .select()
        .from(schema.employeeEarningLedger)
        .where(
          and(
            eq(schema.employeeEarningLedger.overtimeId, ot.id),
            eq(schema.employeeEarningLedger.type, 'OVERTIME')
          )
        )
        .limit(1);

      if (existing) continue;

      const otAmount = Number(ot.paymentCents ?? 0);
      await fastify.db.insert(schema.employeeEarningLedger).values({
        organizationId,
        premisesId,
        staffId: staffProfileId,
        earningDate: ot.workDate,
        type: 'OVERTIME',
        amount: otAmount.toFixed(2),
        overtimeId: ot.id,
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
        eq(schema.monthlyPayrolls.staffId, staffProfileId),
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
        staffId: staffProfileId,
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

  const [earnedResult] = await fastify.db
    .select({
      total: sql<string>`COALESCE(SUM(${schema.employeeEarningLedger.amount}), 0)`,
    })
    .from(schema.employeeEarningLedger)
    .where(
      and(
        eq(schema.employeeEarningLedger.staffId, payroll.staffId),
        eq(schema.employeeEarningLedger.premisesId, payroll.premisesId),
        gte(schema.employeeEarningLedger.earningDate, startDate),
        sql`${schema.employeeEarningLedger.earningDate} < ${nextMonthStartDate}`
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
      staffCode: staff.staffCode,
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
  return await fastify.db
    .select()
    .from(schema.employeeEarningLedger)
    .where(
      and(
        eq(schema.employeeEarningLedger.organizationId, organizationId),
        eq(schema.employeeEarningLedger.staffId, staffProfileId),
        gte(schema.employeeEarningLedger.earningDate, startDate),
        sql`${schema.employeeEarningLedger.earningDate} < ${nextMonthStartDate}`
      )
    )
    .orderBy(desc(schema.employeeEarningLedger.earningDate));
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

export async function listPayrollDeductions(fastify: FastifyInstance, organizationId: string, monthlyPayrollId: string) {
  const [payroll] = await fastify.db
    .select()
    .from(schema.monthlyPayrolls)
    .where(and(eq(schema.monthlyPayrolls.id, monthlyPayrollId), eq(schema.monthlyPayrolls.organizationId, organizationId)))
    .limit(1);

  if (!payroll) {
    throw new AppError('Monthly payroll not found', 404, 'PAYROLL_NOT_FOUND');
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

export async function listPayrollTransactions(fastify: FastifyInstance, organizationId: string, monthlyPayrollId: string) {
  const [payroll] = await fastify.db
    .select()
    .from(schema.monthlyPayrolls)
    .where(and(eq(schema.monthlyPayrolls.id, monthlyPayrollId), eq(schema.monthlyPayrolls.organizationId, organizationId)))
    .limit(1);

  if (!payroll) {
    throw new AppError('Monthly payroll not found', 404, 'PAYROLL_NOT_FOUND');
  }

  return await fastify.db
    .select()
    .from(schema.payrollTransactions)
    .where(eq(schema.payrollTransactions.monthlyPayrollId, monthlyPayrollId));
}
