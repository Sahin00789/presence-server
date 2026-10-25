import { describe, expect, it } from 'vitest';
import { calculateDailyAccrual, calculateSalary } from '../src/modules/salary/service.js';

const baseSummary = {
  presentDays: 20,
  lateDays: 2,
  halfDays: 1,
  absentDays: 1,
  totalWorkedMinutes: 20 * 8 * 60,
  totalOvertimeMinutes: 120,
  holidayDays: 2,
  paidLeaveDays: 1,
};

describe('Salary calculation engine', () => {
  it('pays a monthly salary pro-rated by attendance in integer paise', () => {
    const result = calculateSalary({
      compensationType: 'MONTHLY',
      baseRateCents: 3_000_000,
      overtimeRateCents: 0,
      attendanceSummary: baseSummary,
      workingDaysInMonth: 30,
    });

    // 20 present + 0.5 half-day + 1 paid leave + 2 paid holidays = 23.5 days
    expect(result.grossSalaryCents).toBe(2_350_000);
    expect(result.netSalaryCents).toBe(2_350_000);
    expect(Number.isInteger(result.grossSalaryCents)).toBe(true);
    expect(result.breakdown.earnings[0]?.code).toBe('BASE_SALARY');
  });

  it('applies effective-dated shift payment rules including late penalty', () => {
    const result = calculateSalary({
      compensationType: 'SHIFT',
      baseRateCents: 100_000,
      overtimeRateCents: 0,
      shiftPaymentRules: [
        { attendanceStatus: 'PRESENT', paymentCents: 100_000, staffProfileId: null },
        { attendanceStatus: 'LATE', paymentCents: 80_000, staffProfileId: null },
        { attendanceStatus: 'HALF_DAY', paymentCents: 50_000, staffProfileId: null },
        { attendanceStatus: 'ABSENT', paymentCents: 0, penaltyCents: 15_000, staffProfileId: null },
      ],
      attendanceSummary: baseSummary,
      workingDaysInMonth: 30,
    });

    // PRESENT excludes late days: 18 * 100000 + 2 * 80000 + 1 * 50000 = 2,010,000
    const base = result.breakdown.earnings.find((item) => item.code === 'BASE_SALARY');
    expect(base?.amountCents).toBe(2_010_000);
    const penalty = result.breakdown.deductions.find((item) => item.code === 'ABSENT_PENALTY');
    expect(penalty?.amountCents).toBe(15_000);
    expect(result.netSalaryCents).toBe(2_010_000 - 15_000);
  });

  it('pays holidays and paid leave from unworked rules', () => {
    const result = calculateSalary({
      compensationType: 'DAILY',
      baseRateCents: 100_000,
      overtimeRateCents: 0,
      unworkedPaymentRules: [
        { dayType: 'HOLIDAY', paymentCents: 60_000, staffProfileId: null },
        { dayType: 'PAID_LEAVE', paymentCents: 90_000, staffProfileId: null },
      ],
      attendanceSummary: baseSummary,
      workingDaysInMonth: 30,
    });

    const codes = result.breakdown.earnings.map((item) => item.code);
    expect(codes).toContain('HOLIDAY_PAY');
    expect(codes).toContain('PAID_LEAVE');
    expect(result.breakdown.earnings.find((item) => item.code === 'HOLIDAY_PAY')?.amountCents)
      .toBe(120_000);
    expect(result.breakdown.earnings.find((item) => item.code === 'PAID_LEAVE')?.amountCents)
      .toBe(90_000);
  });

  it('pays unworked weekly-off days from the WEEKLY_OFF rule', () => {
    const result = calculateSalary({
      compensationType: 'MONTHLY',
      baseRateCents: 3_000_000,
      overtimeRateCents: 0,
      unworkedPaymentRules: [
        { dayType: 'WEEKLY_OFF', paymentCents: 60_000, staffProfileId: null },
      ],
      attendanceSummary: {
        presentDays: 20,
        lateDays: 0,
        halfDays: 0,
        absentDays: 2,
        totalWorkedMinutes: 20 * 8 * 60,
        totalOvertimeMinutes: 0,
        holidayDays: 0,
        weeklyOffDays: 8,
      },
      workingDaysInMonth: 30,
    });

    expect(result.breakdown.earnings.find((item) => item.code === 'WEEKLY_OFF_PAY')?.amountCents)
      .toBe(480_000);
    expect(result.breakdown.earnings.find((item) => item.code === 'BASE_SALARY')?.amountCents)
      .toBe(2_000_000);
    expect(result.grossSalaryCents).toBe(2_480_000);
  });

  it('accrues a direct shift-rule payment at clock-out', () => {
    const amount = calculateDailyAccrual({
      compensationType: 'SHIFT',
      baseRateCents: 100_000,
      overtimeRateCents: 0,
      shiftPaymentRules: [
        { attendanceStatus: 'PRESENT', paymentCents: 95_000, staffProfileId: null },
      ],
      status: 'PRESENT',
      workedMinutes: 480,
      overtimeMinutes: 0,
      periodStartDate: '2026-10-01',
    });
    expect(amount).toBe(95_000);
  });

  it('returns zero accrual for an absent day', () => {
    const amount = calculateDailyAccrual({
      compensationType: 'MONTHLY',
      baseRateCents: 3_000_000,
      overtimeRateCents: 0,
      status: 'ABSENT',
      workedMinutes: 0,
      overtimeMinutes: 0,
      periodStartDate: '2026-10-01',
    });
    expect(amount).toBe(0);
  });
});
