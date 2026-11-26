import fs from 'fs';
import path from 'path';
import { buildModernPayslipPdf, PayslipPdfData } from '../src/shared/utils/pdf.js';

const sampleData: PayslipPdfData = {
  orgName: 'Acme Enterprises India Pvt Ltd',
  currency: 'INR',
  premisesName: 'Main Corporate Campus',
  premisesAddress: 'Plot 42, Tech Corridor, Phase 2, Electronic City, Bangalore - 560100',
  employeeName: 'Rajesh Kumar',
  employeeCode: 'EMP-2024-089',
  designation: 'Senior Systems Engineer',
  department: 'Operations & Engineering',
  email: 'rajesh.kumar@acme.com',
  hireDate: '2021-06-01',
  month: 10,
  year: 2024,
  payrollStatus: 'FINALIZED',
  earnedAmount: '48500.00',
  paidAmount: '40000.00',
  dueAmount: '8500.00',
  shifts: [
    {
      shiftName: 'General Morning Shift',
      dayName: 'Monday',
      startTime: '09:00:00',
      endTime: '17:00:00',
      halfDayThreshold: '13:00:00',
      presentPay: '1600.00',
      absentPay: '0.00',
      halfDayPay: '800.00',
      leavePay: '800.00',
    },
    {
      shiftName: 'General Morning Shift',
      dayName: 'Tuesday',
      startTime: '09:00:00',
      endTime: '17:00:00',
      halfDayThreshold: '13:00:00',
      presentPay: '1600.00',
      absentPay: '0.00',
      halfDayPay: '800.00',
      leavePay: '800.00',
    },
    {
      shiftName: 'General Morning Shift',
      dayName: 'Wednesday',
      startTime: '09:00:00',
      endTime: '17:00:00',
      halfDayThreshold: '13:00:00',
      presentPay: '1600.00',
      absentPay: '0.00',
      halfDayPay: '800.00',
      leavePay: '800.00',
    },
    {
      shiftName: 'General Morning Shift',
      dayName: 'Thursday',
      startTime: '09:00:00',
      endTime: '17:00:00',
      halfDayThreshold: '13:00:00',
      presentPay: '1600.00',
      absentPay: '0.00',
      halfDayPay: '800.00',
      leavePay: '800.00',
    },
    {
      shiftName: 'General Morning Shift',
      dayName: 'Friday',
      startTime: '09:00:00',
      endTime: '17:00:00',
      halfDayThreshold: '13:00:00',
      presentPay: '1600.00',
      absentPay: '0.00',
      halfDayPay: '800.00',
      leavePay: '800.00',
    },
  ],
  unworkedRules: [
    {
      dayType: 'HOLIDAY',
      paymentInr: '1600',
      holidayPay: '1600',
      multiplierBasisPoints: 10000,
    },
    {
      dayType: 'WEEKLY_OFF',
      paymentInr: '1600',
      offDayPay: '1600',
      multiplierBasisPoints: 10000,
    },
  ],
  attendanceSummary: {
    presentDays: 21,
    halfDays: 1,
    absentDays: 0,
    leaveDays: 1,
    holidayDays: 2,
    weeklyOffDays: 4,
    totalOvertimeMinutes: 390,
  },
  earningLedger: [
    { earningDate: '2024-10-01', type: 'SHIFT', amount: '1600.00', sourceReference: 'General Morning Shift' },
    { earningDate: '2024-10-02', type: 'HOLIDAY', amount: '1600.00', sourceReference: 'Mahatma Gandhi Jayanti' },
    { earningDate: '2024-10-03', type: 'SHIFT', amount: '1600.00', sourceReference: 'General Morning Shift' },
    { earningDate: '2024-10-04', type: 'SHIFT', amount: '1600.00', sourceReference: 'General Morning Shift' },
    { earningDate: '2024-10-05', type: 'OFF_DAY', amount: '1600.00', sourceReference: 'Scheduled Weekly Off (Saturday)' },
    { earningDate: '2024-10-06', type: 'OFF_DAY', amount: '1600.00', sourceReference: 'Scheduled Weekly Off (Sunday)' },
    { earningDate: '2024-10-12', type: 'HOLIDAY', amount: '1600.00', sourceReference: 'Dussehra / Vijayadashami' },
    { earningDate: '2024-10-15', type: 'OVERTIME', amount: '1300.00', sourceReference: 'Production Release Monitoring (390 mins)' },
  ],
  payments: [
    {
      paymentDate: '2024-10-31',
      paymentMethod: 'MANUAL_BANK_TRANSFER',
      reference: 'NEFT-89372104921',
      amount: '25000.00',
    },
    {
      paymentDate: '2024-11-05',
      paymentMethod: 'UPI',
      reference: 'UPI/4309182740/SalDisb',
      amount: '15000.00',
    },
  ],
};

function tryWriteFile(filePath: string, buffer: Buffer): string {
  try {
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err: any) {
    if (err.code === 'EBUSY') {
      const parsed = path.parse(filePath);
      const fallbackPath = path.join(parsed.dir, `${parsed.name}_updated${parsed.ext}`);
      fs.writeFileSync(fallbackPath, buffer);
      return fallbackPath;
    }
    throw err;
  }
}

async function main() {
  const pdfBuffer = await buildModernPayslipPdf(sampleData);
  const artifactsDir = 'C:/Users/Dell/AppData/Local/Google/AndroidStudio2026.2.2/projects/presence.a9f9e09b/.artifacts/cca20637-9667-4520-a4d5-0d26bb3a8b6b';
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }
  const pdfPath = tryWriteFile(path.join(artifactsDir, 'sample_payslip.pdf'), pdfBuffer);
  const rootPdfPath = tryWriteFile(path.resolve(__dirname, '../../sample_payslip.pdf'), pdfBuffer);

  console.log(`Sample PDF generated successfully.`);
  console.log(`Artifact Path: ${pdfPath}`);
  console.log(`Project Path: ${rootPdfPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
