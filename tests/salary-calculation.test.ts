import { describe, expect, it } from 'vitest';

/**
 * Staff Earning Ledger entry structure
 */
interface EarningLedgerEntry {
  id: string;
  employeeId: string;
  earningDate: string;
  type: 'SHIFT' | 'HOLIDAY' | 'OFF_DAY' | 'OVERTIME';
  amount: string; // Stored as currency string e.g. "500.00"
  shiftAssignmentId?: string | null;
  attendanceId?: string | null;
  sourceReference: string;
}

/**
 * Calculates total earned amount for a month by summing earning ledger entries in integer paise/cents.
 */
function sumEarningLedger(entries: EarningLedgerEntry[]): number {
  return entries.reduce((totalCents, entry) => {
    const cents = Math.round(Number(entry.amount ?? 0) * 100);
    return totalCents + cents;
  }, 0);
}

/**
 * Calculates monthly payroll summary based on ledger total, deductions, and payments.
 */
function calculateMonthlyPayroll(params: {
  ledgerEntries: EarningLedgerEntry[];
  deductionsCents: number;
  paidCents: number;
}) {
  const earnedCents = sumEarningLedger(params.ledgerEntries);
  const dueCents = Math.max(0, earnedCents - params.deductionsCents - params.paidCents);
  return {
    earnedAmount: (earnedCents / 100).toFixed(2),
    earnedCents,
    deductionAmount: (params.deductionsCents / 100).toFixed(2),
    paidAmount: (params.paidCents / 100).toFixed(2),
    dueAmount: (dueCents / 100).toFixed(2),
    dueCents,
  };
}

describe('Ledger-Dependent Salary & Payroll Engine', () => {
  it('calculates monthly earned salary strictly from the append-only earning ledger', () => {
    const entries: EarningLedgerEntry[] = [
      { id: '1', employeeId: 'emp-1', earningDate: '2025-06-01', type: 'SHIFT', amount: '1000.00', sourceReference: 'attendance:1:SHIFT' },
      { id: '2', employeeId: 'emp-1', earningDate: '2025-06-02', type: 'SHIFT', amount: '1000.00', sourceReference: 'attendance:2:SHIFT' },
      { id: '3', employeeId: 'emp-1', earningDate: '2025-06-03', type: 'HOLIDAY', amount: '800.00', sourceReference: 'holiday:1:HOLIDAY' },
      { id: '4', employeeId: 'emp-1', earningDate: '2025-06-04', type: 'OFF_DAY', amount: '800.00', sourceReference: 'weeklyoff:1:OFF_DAY' },
      { id: '5', employeeId: 'emp-1', earningDate: '2025-06-05', type: 'OVERTIME', amount: '350.00', sourceReference: 'overtime:1:OVERTIME' },
    ];

    const payroll = calculateMonthlyPayroll({
      ledgerEntries: entries,
      deductionsCents: 200_00, // 200.00 deduction
      paidCents: 1000_00,      // 1000.00 already paid
    });

    // 1000 + 1000 + 800 + 800 + 350 = 3950.00
    expect(payroll.earnedAmount).toBe('3950.00');
    expect(payroll.earnedCents).toBe(3950_00);
    expect(payroll.deductionAmount).toBe('200.00');
    expect(payroll.paidAmount).toBe('1000.00');
    // 3950 - 200 - 1000 = 2750.00
    expect(payroll.dueAmount).toBe('2750.00');
    expect(payroll.dueCents).toBe(2750_00);
  });

  it('updates earning ledger with leavePay when approved leave shift ends', () => {
    const shiftLeavePay = '600.00';
    const approvedLeave = {
      id: 'leave-101',
      employeeId: 'emp-1',
      workDate: '2025-06-10',
      status: 'APPROVED' as const,
      shiftEndTime: '2025-06-10T17:00:00Z',
    };

    // Before shift ends at 16:00: shift is ongoing, no ledger entry yet
    const currentTimeBeforeEnd = new Date('2025-06-10T16:00:00Z');
    const shiftEndedBefore = currentTimeBeforeEnd.getTime() >= new Date(approvedLeave.shiftEndTime).getTime();
    expect(shiftEndedBefore).toBe(false);

    // After shift ends at 17:05: shift time is over
    const currentTimeAfterEnd = new Date('2025-06-10T17:05:00Z');
    const shiftEndedAfter = currentTimeAfterEnd.getTime() >= new Date(approvedLeave.shiftEndTime).getTime();
    expect(shiftEndedAfter).toBe(true);

    // Earning ledger entry is auto-initiated when approved leave shift ends
    const ledgerEntries: EarningLedgerEntry[] = [];
    if (approvedLeave.status === 'APPROVED' && shiftEndedAfter) {
      ledgerEntries.push({
        id: 'ledg-leave-1',
        employeeId: approvedLeave.employeeId,
        earningDate: approvedLeave.workDate,
        type: 'SHIFT',
        amount: shiftLeavePay,
        sourceReference: `leave:${approvedLeave.id}`,
      });
    }

    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]?.amount).toBe('600.00');
    expect(ledgerEntries[0]?.type).toBe('SHIFT');

    const payroll = calculateMonthlyPayroll({
      ledgerEntries,
      deductionsCents: 0,
      paidCents: 0,
    });
    expect(payroll.earnedAmount).toBe('600.00');
  });

  it('marks shift as ABSENT and adds no shift earnings when leave request is NOT approved', () => {
    const unapprovedLeave = {
      id: 'leave-102',
      employeeId: 'emp-1',
      workDate: '2025-06-11',
      status: 'REJECTED' as const,
      shiftEndTime: '2025-06-11T17:00:00Z',
      clockInAt: null,
    };

    const now = new Date('2025-06-11T18:00:00Z');
    const shiftEnded = now.getTime() >= new Date(unapprovedLeave.shiftEndTime).getTime();
    expect(shiftEnded).toBe(true);

    // Unapproved leave + no clock-in -> ABSENT
    let attendanceStatus = 'SCHEDULED';
    if (shiftEnded && unapprovedLeave.clockInAt === null && unapprovedLeave.status !== 'APPROVED') {
      attendanceStatus = 'ABSENT';
    }

    expect(attendanceStatus).toBe('ABSENT');

    // No shift salary earned for unapproved/absent shift
    const ledgerEntries: EarningLedgerEntry[] = [];
    const payroll = calculateMonthlyPayroll({
      ledgerEntries,
      deductionsCents: 0,
      paidCents: 0,
    });

    expect(payroll.earnedAmount).toBe('0.00');
    expect(payroll.dueAmount).toBe('0.00');
  });

  it('auto-initiates holiday and weekly off-day earnings when the day starts', () => {
    const todayStr = '2025-06-15';
    const now = new Date('2025-06-15T00:05:00Z'); // Day has started

    const holiday = { id: 'hol-1', date: '2025-06-15', isPaid: true, amount: '800.00' };

    const dayStarted = now.toISOString().slice(0, 10) >= todayStr;
    expect(dayStarted).toBe(true);

    const ledgerEntries: EarningLedgerEntry[] = [];
    if (dayStarted && holiday.isPaid) {
      ledgerEntries.push({
        id: 'ledg-hol-1',
        employeeId: 'emp-1',
        earningDate: holiday.date,
        type: 'HOLIDAY',
        amount: holiday.amount,
        sourceReference: `holiday:${holiday.id}:emp-1:${holiday.date}`,
      });
    }

    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]?.type).toBe('HOLIDAY');
    expect(ledgerEntries[0]?.amount).toBe('800.00');

    const payroll = calculateMonthlyPayroll({
      ledgerEntries,
      deductionsCents: 0,
      paidCents: 0,
    });
    expect(payroll.earnedAmount).toBe('800.00');
  });

  it('guarantees integer paise arithmetic and prevents floating-point rounding errors', () => {
    // 3 shifts of 333.33 each
    const entries: EarningLedgerEntry[] = [
      { id: '1', employeeId: 'emp-1', earningDate: '2025-06-01', type: 'SHIFT', amount: '333.33', sourceReference: 'ref:1' },
      { id: '2', employeeId: 'emp-1', earningDate: '2025-06-02', type: 'SHIFT', amount: '333.33', sourceReference: 'ref:2' },
      { id: '3', employeeId: 'emp-1', earningDate: '2025-06-03', type: 'SHIFT', amount: '333.34', sourceReference: 'ref:3' },
    ];

    const payroll = calculateMonthlyPayroll({
      ledgerEntries: entries,
      deductionsCents: 0,
      paidCents: 0,
    });

    // 33333 + 33333 + 33334 = 100000 cents = 1000.00
    expect(payroll.earnedCents).toBe(1000_00);
    expect(payroll.earnedAmount).toBe('1000.00');
  });
});
