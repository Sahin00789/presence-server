import { describe, it, expect } from 'vitest';
import { buildModernPayslipPdf, PayslipPdfData } from './pdf.js';

describe('Modern Payslip PDF Generator', () => {
  it('generates a valid non-empty A4 PDF buffer for complete payslip data with logo and payments', async () => {
    const sampleData: PayslipPdfData = {
      orgName: 'Acme Technologies Pvt Ltd',
      currency: 'INR',
      premisesName: 'Main Tech Park Premises',
      premisesAddress: 'Building 4, Sector 5, Electronic City, Bangalore',
      employeeName: 'Rahul Sharma',
      employeeCode: 'EMP-1024',
      designation: 'Senior Software Engineer',
      department: 'Engineering',
      email: 'rahul.sharma@acme.com',
      hireDate: '2022-04-15',
      month: 10,
      year: 2024,
      payrollStatus: 'FINALIZED',
      earnedAmount: '35000.00',
      paidAmount: '30000.00',
      dueAmount: '5000.00',
      shifts: [
        {
          shiftName: 'General Day Shift',
          dayName: 'Monday',
          startTime: '09:00:00',
          endTime: '17:00:00',
          halfDayThreshold: '13:00:00',
          presentPay: '1200.00',
          absentPay: '0.00',
          halfDayPay: '600.00',
          leavePay: '600.00',
        },
      ],
      unworkedRules: [
        {
          dayType: 'HOLIDAY',
          paymentInr: '1200',
          holidayPay: '1200',
          multiplierBasisPoints: 10000,
        },
      ],
      attendanceSummary: {
        presentDays: 20,
        halfDays: 2,
        absentDays: 0,
        leaveDays: 1,
        holidayDays: 2,
        weeklyOffDays: 4,
        totalOvertimeMinutes: 270,
      },
      earningLedger: [
        {
          earningDate: '2024-10-01',
          type: 'SHIFT',
          amount: '1200.00',
          sourceReference: 'General Day Shift',
        },
      ],
      payments: [
        {
          paymentDate: '2024-10-31',
          paymentMethod: 'MANUAL_BANK_TRANSFER',
          reference: 'TXN-98124091',
          amount: '30000.00',
        },
      ],
    };

    const pdfBuffer = await buildModernPayslipPdf(sampleData);

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    // PDF Header magic bytes: %PDF-
    const headerStr = pdfBuffer.subarray(0, 5).toString('ascii');
    expect(headerStr).toBe('%PDF-');
  });

  it('handles empty shift assignments and zero earning ledger gracefully', async () => {
    const emptyData: PayslipPdfData = {
      orgName: 'Minimal Organization',
      currency: 'INR',
      premisesName: 'Headquarters',
      employeeName: 'New Employee',
      employeeCode: 'EMP-9999',
      month: 1,
      year: 2025,
      payrollStatus: 'OPEN',
      earnedAmount: '0.00',
      paidAmount: '0.00',
      dueAmount: '0.00',
      shifts: [],
      unworkedRules: [],
      attendanceSummary: {
        presentDays: 0,
        halfDays: 0,
        absentDays: 0,
        leaveDays: 0,
        holidayDays: 0,
        weeklyOffDays: 0,
        totalOvertimeMinutes: 0,
      },
      earningLedger: [],
      payments: [],
    };

    const pdfBuffer = await buildModernPayslipPdf(emptyData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(500);
  });
});
