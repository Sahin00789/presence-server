import { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';

const BASIS_POINTS = 10_000;

/** Number of calendar days in the month that contains `dateIso`. */
export function daysInMonth(dateIso: string): number {
  const [year, month] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolves the compensation plan that is effective on `onDate` (defaults to
 * today). Retroactive payroll runs therefore keep using historical rates
 * (`docs/SALARY_RULES.md` §3.3).
 */
export async function getCurrentSalaryStructure(
  fastify: FastifyInstance,
  staffProfileId: string,
  onDate?: string
) {
  const effectiveOn = onDate ?? new Date().toISOString().slice(0, 10);

  const rows = await fastify.db
    .select()
    .from(schema.salaryStructures)
    .where(
      and(
        eq(schema.salaryStructures.staffProfileId, staffProfileId),
        sql`${schema.salaryStructures.effectiveFrom} <= ${effectiveOn}`
      )
    )
    .orderBy(desc(schema.salaryStructures.effectiveFrom))
    .limit(1);

  if (rows.length === 0) {
    throw new AppError('Salary structure not configured', 404, 'SALARY_NOT_CONFIGURED');
  }

  return rows[0];
}

export interface PaymentRuleLike {
  staffProfileId?: string | null;
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
  /** Effective-dated shift payment rules (staff-specific rows take precedence). */
  shiftPaymentRules?: PaymentRuleLike[];
  /** Effective-dated holiday / weekly-off / paid-leave rules. */
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
  /** Calendar days in the payroll period; defaults to 30. */
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
  // Staff-specific rules always win over organisation-wide defaults. The
  // caller orders rules by effective date descending.
  return matching.find((rule) => Boolean(rule.staffProfileId)) ?? matching[0];
}

function multiplyBasisPoints(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / BASIS_POINTS);
}

/**
 * Deterministic salary calculation in integer minor units.
 *
 * No floating point value ever reaches the persisted amount: every operation is
 * rounded back to an integer cent/paise value (`docs/SALARY_RULES.md` §3).
 */
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
    // `presentDays` already includes late arrivals, so only the remainder is
    // paid at the plain PRESENT rate.
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
    // MIXED: fixed monthly base pro-rated by attendance plus hourly overtime.
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

  // Unworked paid holidays and paid leave configured independently from the
  // base wage (`unworked_payment_rules`).
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

  // Holiday and weekly-off clock-ins are paid as normal present days by the
  // base salary calculation; there are no separate "worked holiday" premiums.

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

/**
 * Computes the real-time wallet accrual for a single completed attendance day.
 *
 * The same formulas as the payroll engine are used so monthly payroll only has
 * to post a small true-up at approval time (`docs/WALLET_LEDGER.md` §2).
 */
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

export async function getShiftPaymentRules(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId?: string,
  onDate?: string
) {
  const effectiveOn = onDate ?? new Date().toISOString().slice(0, 10);
  const rows = await fastify.db
    .select()
    .from(schema.shiftPaymentRules)
    .where(
      and(
        eq(schema.shiftPaymentRules.organizationId, organizationId),
        sql`${schema.shiftPaymentRules.effectiveFrom} <= ${effectiveOn}`,
        staffProfileId
          ? sql`(${schema.shiftPaymentRules.staffProfileId} = ${staffProfileId} OR ${schema.shiftPaymentRules.staffProfileId} IS NULL)`
          : sql`${schema.shiftPaymentRules.staffProfileId} IS NULL`
      )
    )
    .orderBy(desc(schema.shiftPaymentRules.effectiveFrom));

  return rows;
}

export async function getUnworkedPaymentRules(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId?: string,
  onDate?: string
) {
  const effectiveOn = onDate ?? new Date().toISOString().slice(0, 10);
  const rows = await fastify.db
    .select()
    .from(schema.unworkedPaymentRules)
    .where(
      and(
        eq(schema.unworkedPaymentRules.organizationId, organizationId),
        sql`${schema.unworkedPaymentRules.effectiveFrom} <= ${effectiveOn}`,
        staffProfileId
          ? sql`(${schema.unworkedPaymentRules.staffProfileId} = ${staffProfileId} OR ${schema.unworkedPaymentRules.staffProfileId} IS NULL)`
          : sql`${schema.unworkedPaymentRules.staffProfileId} IS NULL`
      )
    )
    .orderBy(desc(schema.unworkedPaymentRules.effectiveFrom));

  return rows;
}

export async function createShiftPaymentRule(
  fastify: FastifyInstance,
  organizationId: string,
  input: {
    staffProfileId?: string | null;
    shiftTemplateId?: string | null;
    attendanceStatus: 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT';
    paymentCents: number;
    penaltyCents?: number;
    effectiveFrom?: string;
  }
) {
  if (input.staffProfileId) {
    const [profile] = await fastify.db
      .select({ id: schema.staffProfiles.id })
      .from(schema.staffProfiles)
      .where(
        and(
          eq(schema.staffProfiles.id, input.staffProfileId),
          eq(schema.staffProfiles.organizationId, organizationId)
        )
      )
      .limit(1);
    if (!profile) {
      throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
    }
  }

  if (input.shiftTemplateId) {
    const [template] = await fastify.db
      .select({ id: schema.shiftTemplates.id })
      .from(schema.shiftTemplates)
      .where(
        and(
          eq(schema.shiftTemplates.id, input.shiftTemplateId),
          eq(schema.shiftTemplates.organisationId, organizationId)
        )
      )
      .limit(1);
    if (!template) {
      throw new AppError('Shift template not found', 404, 'SHIFT_TEMPLATE_NOT_FOUND');
    }
  }

  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString().slice(0, 10);

  const [created] = await fastify.db
    .insert(schema.shiftPaymentRules)
    .values({
      organizationId,
      staffProfileId: input.staffProfileId ?? null,
      shiftTemplateId: input.shiftTemplateId ?? null,
      attendanceStatus: input.attendanceStatus,
      paymentCents: input.paymentCents,
      penaltyCents: input.penaltyCents ?? 0,
      effectiveFrom,
    })
    .returning();

  return created;
}

export async function createUnworkedPaymentRule(
  fastify: FastifyInstance,
  organizationId: string,
  input: {
    staffProfileId?: string | null;
    dayType: (typeof schema.unworkedDayTypeEnum.enumValues)[number];
    paymentCents?: number;
    multiplierBasisPoints?: number;
    effectiveFrom?: string;
  }
) {
  if (input.staffProfileId) {
    const [profile] = await fastify.db
      .select({ id: schema.staffProfiles.id })
      .from(schema.staffProfiles)
      .where(
        and(
          eq(schema.staffProfiles.id, input.staffProfileId),
          eq(schema.staffProfiles.organizationId, organizationId)
        )
      )
      .limit(1);
    if (!profile) {
      throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
    }
  }

  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString().slice(0, 10);

  const [created] = await fastify.db
    .insert(schema.unworkedPaymentRules)
    .values({
      organizationId,
      staffProfileId: input.staffProfileId ?? null,
      dayType: input.dayType,
      paymentCents: input.paymentCents ?? 0,
      multiplierBasisPoints: input.multiplierBasisPoints ?? 15000,
      effectiveFrom,
    })
    .returning();

  return created;
}
