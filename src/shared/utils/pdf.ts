import PDFDocument from 'pdfkit';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Modern A4 Color Payslip PDF Generator & Legacy Report Export Utility.
 */

function escapePdfText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E]/g, '?');
}

function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) {
    return [line];
  }

  const parts: string[] = [];
  let remaining = line;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(' ', maxChars);
    if (cut <= 0) {
      cut = maxChars;
    }
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

export interface PdfTable {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}

/**
 * Minimal dependency-free PDF writer used for generic tabular reports (CSV/PDF exports).
 */
export function buildPdfReport(table: PdfTable): Buffer {
  const maxChars = 108;
  const lines: string[] = [];

  lines.push(table.title);
  if (table.subtitle) {
    lines.push(table.subtitle);
  }
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(table.columns.join(' | '));
  lines.push('-'.repeat(Math.min(maxChars, table.columns.join(' | ').length)));

  for (const row of table.rows) {
    const text = row
      .map((cell) => String(cell ?? ''))
      .join(' | ');
    lines.push(...wrapLine(text, maxChars));
  }

  const linesPerPage = 58;
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage));
  }
  if (pages.length === 0) {
    pages.push(['No data']);
  }

  const objects: string[] = [];
  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2);
  const fontObjectNumber = 3;

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectNumbers
      .map((number) => `${number} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');

  pages.forEach((pageLines, index) => {
    const pageObjectNumber = 4 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`
    );

    const body = [
      'BT',
      '/F1 8 Tf',
      '40 800 Td',
      '10 TL',
      ...pageLines.map((line) => `(${escapePdfText(line)}) Tj T*`),
      'ET',
    ].join('\n');

    objects.push(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

// ----------------------------------------------------------------------
// MODERN A4 COLOR PAYSLIP PDF ENGINE (PDFKit)
// ----------------------------------------------------------------------

export interface PayslipShiftDetail {
  shiftName: string;
  dayName: string;
  startTime: string;
  endTime: string;
  halfDayThreshold?: string | null;
  presentPay: string;
  absentPay: string;
  halfDayPay: string;
  leavePay: string;
}

export interface PayslipUnworkedRule {
  dayType: 'HOLIDAY' | 'WEEKLY_OFF' | string;
  paymentInr: string;
  holidayPay?: string;
  offDayPay?: string;
  multiplierBasisPoints?: number;
}

export interface PayslipAttendanceSummary {
  presentDays: number;
  halfDays: number;
  absentDays: number;
  leaveDays: number;
  holidayDays: number;
  weeklyOffDays: number;
  totalOvertimeMinutes: number;
  totalWorkedMinutes?: number;
}

export interface PayslipEarningEntry {
  earningDate: string;
  type: string;
  amount: string;
  sourceReference?: string | null;
  description?: string | null;
}

export interface PayslipPaymentTransaction {
  paymentDate: string;
  paymentMethod: string;
  reference?: string | null;
  amount: string;
}

export interface PayslipPdfData {
  orgName: string;
  orgLogoUrl?: string | null;
  currency: string;
  premisesName: string;
  premisesAddress?: string | null;
  employeeName: string;
  employeeCode: string;
  designation?: string | null;
  department?: string | null;
  email?: string | null;
  hireDate?: string | null;
  month: number;
  year: number;
  payrollStatus: string;
  earnedAmount: string;
  paidAmount: string;
  dueAmount: string;
  shifts: PayslipShiftDetail[];
  unworkedRules: PayslipUnworkedRule[];
  attendanceSummary: PayslipAttendanceSummary;
  earningLedger: PayslipEarningEntry[];
  payments: PayslipPaymentTransaction[];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function formatCurrency(amount: string | number, symbol = '₹'): string {
  const num = typeof amount === 'number' ? amount : parseFloat(amount) || 0;
  return `${symbol} ${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCount(count: number, unitSingular: string, unitPlural: string): string {
  const n = count ?? 0;
  return `${n} ${n === 1 ? unitSingular : unitPlural}`;
}

function formatOvertime(minutes: number): string {
  if (!minutes || minutes <= 0) return '0 Mins Worked';
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs > 0 && mins > 0) return `${hrs}h ${mins}m Worked`;
  if (hrs > 0) return `${hrs} Hrs Worked`;
  return `${mins} Mins Worked`;
}

/**
 * Builds a modern, professional, A4-sized color payslip PDF with rich infographics,
 * organization details, employee cards, assigned shift roster with pay rules,
 * unworked day payment rules, summary count stat chips, itemized earning ledger,
 * and high-impact final payment summary card.
 */
export function buildModernPayslipPdf(data: PayslipPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 28,
        info: {
          Title: `Salary Payslip - ${data.employeeName} - ${MONTH_NAMES[data.month - 1]} ${data.year}`,
          Author: data.orgName,
          Subject: 'Official Staff Salary Payslip Statement',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk as Buffer));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const margin = 28;
      const pageWidth = 595.28;
      const pageHeight = 841.89;
      const contentWidth = pageWidth - margin * 2; // 539.28 pt
      const maxBottom = pageHeight - margin; // 813.89 pt

      const monthLabel = MONTH_NAMES[data.month - 1] || `Month ${data.month}`;
      const symbol = data.currency === 'INR' || !data.currency ? '₹' : data.currency;

      // Helper to check page break
      function checkPageBreak(neededHeight: number) {
        if (doc.y + neededHeight > maxBottom) {
          doc.addPage();
        }
      }

      // Helper: Section Title Header
      function drawSectionHeader(title: string) {
        checkPageBreak(28);
        const y = doc.y;
        doc.save();
        // Accent bar
        doc.roundedRect(margin, y, 4, 13, 2).fill('#4F46E5');
        // Text
        doc.font('Helvetica-Bold')
           .fontSize(10)
           .fillColor('#1E293B')
           .text(title.toUpperCase(), margin + 10, y + 1);
        doc.restore();
        doc.y = y + 18;
      }

function getLogoPath(orgLogoUrl?: string | null): string | null {
  const possiblePaths = [
    orgLogoUrl ? path.resolve(process.cwd(), orgLogoUrl) : '',
    path.resolve(process.cwd(), 'assets/logo.png'),
    path.resolve(process.cwd(), 'src/assets/logo.png'),
    path.resolve(process.cwd(), '../marketing/public/presence_logo_512x512.png'),
    path.resolve(process.cwd(), '../marketing/public/logo.png'),
  ];
  for (const p of possiblePaths) {
    if (p) {
      try {
        if (fs.existsSync(p)) return p;
      } catch (_) {}
    }
  }
  return null;
}

// -------------------------------------------------------------
// 1. TOP HEADER BANNER CARD (Corporate Header with Logo)
// -------------------------------------------------------------
const headerHeight = 50;
const headerY = margin;

doc.save();
// Outer Card Box
doc.roundedRect(margin, headerY, contentWidth, headerHeight, 8).fill('#0F172A');

// Left Emblem / Logo Box
const emblemX = margin + 12;
const emblemY = headerY + 8;
const emblemDim = 34;

const logoPath = getLogoPath(data.orgLogoUrl);
let logoDrawn = false;
if (logoPath) {
  try {
    doc.roundedRect(emblemX, emblemY, emblemDim, emblemDim, 6).fill('#FFFFFF');
    doc.image(logoPath, emblemX + 2, emblemY + 2, { fit: [30, 30], align: 'center', valign: 'center' });
    logoDrawn = true;
  } catch (_) {
    logoDrawn = false;
  }
}
if (!logoDrawn) {
  doc.roundedRect(emblemX, emblemY, emblemDim, emblemDim, 6).fill('#4F46E5');
  const initialLetter = (data.orgName || 'P').trim().charAt(0).toUpperCase();
  doc.font('Helvetica-Bold')
     .fontSize(18)
     .fillColor('#FFFFFF')
     .text(initialLetter, emblemX, emblemY + 7, { width: emblemDim, align: 'center' });
}

// Org Name
doc.font('Helvetica-Bold')
   .fontSize(15)
   .fillColor('#FFFFFF')
   .text(data.orgName.toUpperCase(), margin + 54, headerY + 11, { width: 330, height: 20, lineBreak: false });

// Corporate Subtitle Tag
doc.font('Helvetica')
   .fontSize(8)
   .fillColor('#94A3B8')
   .text('REGISTERED WORKFORCE ORGANIZATION', margin + 54, headerY + 30, { width: 330 });

// Right Side Corporate Badge
const corpBadgeW = 105;
const corpBadgeH = 18;
const corpBadgeX = margin + contentWidth - 14 - corpBadgeW;
const corpBadgeY = headerY + 16;
doc.roundedRect(corpBadgeX, corpBadgeY, corpBadgeW, corpBadgeH, 6).fill('#1E1B4B');
doc.font('Helvetica-Bold')
   .fontSize(7.5)
   .fillColor('#818CF8')
   .text('VERIFIED ORG STATEMENT', corpBadgeX, corpBadgeY + 5, { width: corpBadgeW, align: 'center' });

doc.restore();

      // -------------------------------------------------------------
      // 2. DEDICATED ASSIGNED PREMISES LOCATION CARD
      // -------------------------------------------------------------
      const premisesY = headerY + headerHeight + 6;
      const premisesHeight = 36;

      doc.save();
      doc.roundedRect(margin, premisesY, contentWidth, premisesHeight, 6)
         .fillAndStroke('#EEF2FF', '#C7D2FE');

      // Tag Label
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#4338CA')
         .text('ASSIGNED PREMISES LOCATION', margin + 12, premisesY + 5);

      // Premises Name & Address Line
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1E1B4B')
         .text(data.premisesName, margin + 12, premisesY + 17, { continued: Boolean(data.premisesAddress) });

      if (data.premisesAddress) {
        doc.font('Helvetica').fontSize(8.5).fillColor('#3730A3')
           .text(`  •  ${data.premisesAddress}`, { width: contentWidth - 24, height: 16, lineBreak: false });
      }

      doc.restore();

      // -------------------------------------------------------------
      // 3. FULL-WIDTH SALARY PAYSLIP BANNER CARD (Below Premises Card)
      // -------------------------------------------------------------
      const payslipBannerY = premisesY + premisesHeight + 6;
      const payslipBannerH = 36;

      doc.save();
      doc.roundedRect(margin, payslipBannerY, contentWidth, payslipBannerH, 6).fill('#4F46E5');

      // Left: Document Title
      doc.font('Helvetica-Bold')
         .fontSize(13)
         .fillColor('#FFFFFF')
         .text('SALARY PAYSLIP', margin + 14, payslipBannerY + 11, { width: 150 });

      // Center: Pay Period
      doc.font('Helvetica-Bold')
         .fontSize(10.5)
         .fillColor('#C7D2FE')
         .text(`PAY PERIOD: ${monthLabel.toUpperCase()} ${data.year}`, margin + 160, payslipBannerY + 12, { width: 220, align: 'center' });

      // Right: Status Badge
      const statusText = (data.payrollStatus || 'OPEN').toUpperCase();
      let badgeBg = '#6366F1';
      if (statusText === 'PAID') badgeBg = '#10B981';
      else if (statusText === 'FINALIZED') badgeBg = '#312E81';
      else if (statusText === 'OPEN') badgeBg = '#F59E0B';

      const badgeWidth = 75;
      const badgeHeight = 16;
      const badgeX = margin + contentWidth - 14 - badgeWidth;
      const badgeY = payslipBannerY + 10;

      doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 6).fill(badgeBg);
      doc.font('Helvetica-Bold')
         .fontSize(8)
         .fillColor('#FFFFFF')
         .text(statusText, badgeX, badgeY + 4, { width: badgeWidth, align: 'center' });

      doc.restore();
      doc.y = payslipBannerY + payslipBannerH + 10;

      // -------------------------------------------------------------
      // 4. EMPLOYEE INFORMATION CARD (UI Fixed & Key-Value Aligned)
      // -------------------------------------------------------------
      const userInfoHeight = 68;
      checkPageBreak(userInfoHeight + 20);
      drawSectionHeader('Employee Information');

      const userCardY = doc.y;
      doc.save();
      doc.roundedRect(margin, userCardY, contentWidth, userInfoHeight, 6)
         .fillAndStroke('#F8FAFC', '#E2E8F0');

      const col1X = margin + 14;
      const col2X = margin + 276;
      const labelW1 = 82;
      const valW1 = 170;
      const labelW2 = 78;
      const valW2 = 170;

      // Row 1: Name & Designation
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#64748B').text('EMPLOYEE NAME:', col1X, userCardY + 10, { width: labelW1 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0F172A').text(data.employeeName, col1X + labelW1, userCardY + 9, { width: valW1, lineBreak: false });

      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#64748B').text('DESIGNATION:', col2X, userCardY + 10, { width: labelW2 });
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1E293B').text(data.designation || 'N/A', col2X + labelW2, userCardY + 9, { width: valW2, lineBreak: false });

      // Row 2: Employee ID & Department
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#64748B').text('EMPLOYEE ID:', col1X, userCardY + 30, { width: labelW1 });
      doc.font('Helvetica').fontSize(9).fillColor('#1E293B').text(data.employeeCode, col1X + labelW1, userCardY + 29, { width: valW1, lineBreak: false });

      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#64748B').text('DEPARTMENT:', col2X, userCardY + 30, { width: labelW2 });
      doc.font('Helvetica').fontSize(9).fillColor('#1E293B').text(data.department || 'N/A', col2X + labelW2, userCardY + 29, { width: valW2, lineBreak: false });

      // Row 3: Email Address & Hire Date
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#64748B').text('EMAIL ADDRESS:', col1X, userCardY + 50, { width: labelW1 });
      doc.font('Helvetica').fontSize(8.5).fillColor('#1E293B').text(data.email || 'N/A', col1X + labelW1, userCardY + 49, { width: valW1, lineBreak: false });

      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#64748B').text('HIRE DATE:', col2X, userCardY + 50, { width: labelW2 });
      doc.font('Helvetica').fontSize(9).fillColor('#1E293B').text(data.hireDate || 'N/A', col2X + labelW2, userCardY + 49, { width: valW2, lineBreak: false });

      doc.restore();
      doc.y = userCardY + userInfoHeight + 12;

      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#64748B').text('DEPARTMENT', col2X, userCardY + 26);
      doc.font('Helvetica').fontSize(9.5).fillColor('#1E293B').text(data.department || 'N/A', col2X + 75, userCardY + 26);

      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#64748B').text('HIRE DATE', col2X, userCardY + 42);
      doc.font('Helvetica').fontSize(9.5).fillColor('#1E293B').text(data.hireDate || 'N/A', col2X + 75, userCardY + 42);

      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#64748B').text('PAY PERIOD', col2X, userCardY + 56);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#4F46E5').text(`${monthLabel} ${data.year}`, col2X + 75, userCardY + 56);

      doc.restore();
      doc.y = userCardY + userInfoHeight + 12;

      // -------------------------------------------------------------
      // 3. ASSIGNED SHIFT(S) & PAY RULES + UNWORKED PAY RULES CARD
      // -------------------------------------------------------------
      const shiftsCount = data.shifts.length;
      const shiftRowHeight = 22;
      const shiftCardHeight = 30 + (shiftsCount > 0 ? shiftsCount * shiftRowHeight : 22) + 30;

      checkPageBreak(shiftCardHeight + 20);
      drawSectionHeader('Assigned Shift Roster & Payment Rules');

      const shiftCardY = doc.y;
      doc.save();
      doc.roundedRect(margin, shiftCardY, contentWidth, shiftCardHeight, 6)
         .fillAndStroke('#F8FAFC', '#E2E8F0');

      // Shift Table Header inside Card
      const thY = shiftCardY + 8;
      doc.roundedRect(margin + 6, thY, contentWidth - 12, 18, 4).fill('#E2E8F0');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#334155');
      doc.text('SHIFT NAME & WEEKDAY', margin + 14, thY + 5, { width: 135 });
      doc.text('TIMINGS', margin + 155, thY + 5, { width: 100 });
      doc.text('PAYMENT RULES (PRESENT / ABSENT / HALF / LEAVE)', margin + 260, thY + 5, { width: 265 });

      let currentShiftY = thY + 22;
      if (data.shifts.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#64748B')
           .text('No active shift assignments configured for this employee.', margin + 14, currentShiftY + 3);
        currentShiftY += shiftRowHeight;
      } else {
        data.shifts.forEach((s) => {
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A')
             .text(`${s.shiftName}`, margin + 14, currentShiftY, { width: 135 });
          doc.font('Helvetica').fontSize(7.5).fillColor('#475569')
             .text(`(${s.dayName})`, margin + 14, currentShiftY + 10, { width: 135 });

          const timingStr = `${s.startTime.slice(0, 5)} - ${s.endTime.slice(0, 5)}`;
          const halfStr = s.halfDayThreshold ? `Half: ${s.halfDayThreshold.slice(0, 5)}` : '';
          doc.font('Helvetica').fontSize(8.5).fillColor('#1E293B')
             .text(timingStr, margin + 155, currentShiftY);
          if (halfStr) {
            doc.font('Helvetica').fontSize(7.5).fillColor('#64748B')
               .text(halfStr, margin + 155, currentShiftY + 10);
          }

          const rulesStr = `Present: ${formatCurrency(s.presentPay, symbol)}  |  Absent: ${formatCurrency(s.absentPay, symbol)}  |  Half: ${formatCurrency(s.halfDayPay, symbol)}  |  Leave: ${formatCurrency(s.leavePay, symbol)}`;
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#334155')
             .text(rulesStr, margin + 260, currentShiftY + 4, { width: 265 });

          currentShiftY += shiftRowHeight;
        });
      }

      // Unworked Pay Rules section at bottom of shift card
      doc.moveTo(margin + 10, currentShiftY + 2)
         .lineTo(margin + contentWidth - 10, currentShiftY + 2)
         .stroke('#CBD5E1');

      const unworkedY = currentShiftY + 6;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#4338CA')
         .text('UNWORKED DAY PAY RULES:', margin + 14, unworkedY);

      let unworkedText = 'Holiday & Weekly Off-day pay rates configured by premises.';
      if (data.unworkedRules.length > 0) {
        unworkedText = data.unworkedRules.map((ur) => {
          const typeLabel = ur.dayType === 'HOLIDAY' ? 'Holiday Pay' : 'Weekly Off Pay';
          const amt = ur.paymentInr || ur.holidayPay || ur.offDayPay || '0';
          const mult = ur.multiplierBasisPoints ? ` (${ur.multiplierBasisPoints / 100}%)` : '';
          return `${typeLabel}: ${formatCurrency(amt, symbol)}${mult}`;
        }).join('   |   ');
      }
      doc.font('Helvetica').fontSize(8.5).fillColor('#1E293B')
         .text(unworkedText, margin + 160, unworkedY, { width: 360 });

      doc.restore();
      doc.y = shiftCardY + shiftCardHeight + 12;

      // -------------------------------------------------------------
      // 4. SUMMARY CHIPS OF COUNTS (Color Infographics)
      // -------------------------------------------------------------
      checkPageBreak(100);
      drawSectionHeader('Attendance & Overtime Summary');

      const chipsStartY = doc.y;
      const att = data.attendanceSummary;

      // 7 Stat Chips
      const chipDefs = [
        { label: 'PRESENT SHIFTS', val: formatCount(att.presentDays, 'Shift', 'Shifts'), bg: '#ECFDF5', border: '#A7F3D0', text: '#047857' },
        { label: 'HALF DAY SHIFTS', val: formatCount(att.halfDays, 'Shift', 'Shifts'), bg: '#FEF3C7', border: '#FDE68A', text: '#B45309' },
        { label: 'ABSENT SHIFTS', val: formatCount(att.absentDays, 'Shift', 'Shifts'), bg: '#FEF2F2', border: '#FECACA', text: '#B91C1C' },
        { label: 'LEAVE SHIFTS', val: formatCount(att.leaveDays, 'Shift', 'Shifts'), bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8' },
        { label: 'HOLIDAY DAYS', val: formatCount(att.holidayDays, 'Day', 'Days'), bg: '#F3E8FF', border: '#E9D5FF', text: '#6B21A8' },
        { label: 'WEEKLY OFFS', val: formatCount(att.weeklyOffDays, 'Day', 'Days'), bg: '#ECFEFF', border: '#A5F3FC', text: '#0E7490' },
        { label: 'OVERTIME WORKED', val: formatOvertime(att.totalOvertimeMinutes), bg: '#FFF7ED', border: '#FFEDD5', text: '#C2410C' },
      ];

      const gap = 8;
      const chipW4 = (contentWidth - gap * 3) / 4;
      const chipH = 34;

      // Row 1: 4 chips
      chipDefs.slice(0, 4).forEach((chip, i) => {
        const cx = margin + i * (chipW4 + gap);
        doc.save();
        doc.roundedRect(cx, chipsStartY, chipW4, chipH, 6)
           .fillAndStroke(chip.bg, chip.border);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(chip.text)
           .text(chip.label, cx + 4, chipsStartY + 5, { width: chipW4 - 8, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(chip.text)
           .text(chip.val, cx + 4, chipsStartY + 16, { width: chipW4 - 8, align: 'center' });
        doc.restore();
      });

      // Row 2: 3 chips
      const row2Y = chipsStartY + chipH + gap;
      const chipW3 = (contentWidth - gap * 2) / 3;

      chipDefs.slice(4, 7).forEach((chip, i) => {
        const cx = margin + i * (chipW3 + gap);
        doc.save();
        doc.roundedRect(cx, row2Y, chipW3, chipH, 6)
           .fillAndStroke(chip.bg, chip.border);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(chip.text)
           .text(chip.label, cx + 4, row2Y + 5, { width: chipW3 - 8, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(chip.text)
           .text(chip.val, cx + 4, row2Y + 16, { width: chipW3 - 8, align: 'center' });
        doc.restore();
      });

      doc.y = row2Y + chipH + 14;

      // -------------------------------------------------------------
      // 5. ITEMIZED EARNING LEDGER TABLE
      // -------------------------------------------------------------
      const ledgerCount = data.earningLedger.length;
      const rowH = 18;
      const tableHeadH = 20;

      checkPageBreak(tableHeadH + Math.min(ledgerCount, 4) * rowH + 30);
      drawSectionHeader('Itemized Staff Earning Ledger');

      let tableY = doc.y;

      function drawLedgerHeader(y: number) {
        doc.save();
        doc.roundedRect(margin, y, contentWidth, tableHeadH, 4).fill('#1E293B');
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
        doc.text('DATE', margin + 10, y + 6, { width: 70 });
        doc.text('EARNING TYPE', margin + 85, y + 6, { width: 90 });
        doc.text('DESCRIPTION / REFERENCE', margin + 180, y + 6, { width: 235 });
        doc.text('EARNED AMOUNT', margin + 420, y + 6, { width: 109, align: 'right' });
        doc.restore();
      }

      drawLedgerHeader(tableY);
      tableY += tableHeadH + 2;

      if (ledgerCount === 0) {
        doc.save();
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#64748B')
           .text('No earning ledger entries recorded for this pay period.', margin + 10, tableY + 5);
        doc.restore();
        tableY += 22;
      } else {
        data.earningLedger.forEach((entry, idx) => {
          if (tableY + rowH > maxBottom - 110) {
            doc.addPage();
            tableY = margin;
            drawLedgerHeader(tableY);
            tableY += tableHeadH + 2;
          }

          const bg = idx % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
          doc.save();
          doc.rect(margin, tableY, contentWidth, rowH).fill(bg);

          // Date
          doc.font('Helvetica').fontSize(8.5).fillColor('#334155')
             .text(entry.earningDate, margin + 10, tableY + 4, { width: 70 });

          // Type pill
          const typeStr = (entry.type || 'SHIFT').toUpperCase();
          let typeBg = '#E0E7FF';
          let typeColor = '#3730A3';
          if (typeStr === 'SHIFT') { typeBg = '#DCFCE7'; typeColor = '#166534'; }
          else if (typeStr === 'HOLIDAY') { typeBg = '#F3E8FF'; typeColor = '#6B21A8'; }
          else if (typeStr === 'OFF_DAY') { typeBg = '#CFFAFE'; typeColor = '#155E75'; }
          else if (typeStr === 'OVERTIME') { typeBg = '#FFEDD5'; typeColor = '#9A3412'; }

          doc.roundedRect(margin + 85, tableY + 2, 75, 14, 4).fill(typeBg);
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor(typeColor)
             .text(typeStr, margin + 85, tableY + 5, { width: 75, align: 'center' });

          // Description / Reference
          const descText = entry.description || entry.sourceReference || 'Standard Earning Accrual';
          doc.font('Helvetica').fontSize(8.5).fillColor('#1E293B')
             .text(descText, margin + 180, tableY + 4, { width: 235, height: 14, lineBreak: false });

          // Amount
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A')
             .text(formatCurrency(entry.amount, symbol), margin + 420, tableY + 4, { width: 109, align: 'right' });

          doc.restore();
          tableY += rowH;
        });
      }

      doc.y = tableY + 10;

      // -------------------------------------------------------------
      // 6. DISBURSED SALARY PAYMENTS TABLE (Payment Table)
      // -------------------------------------------------------------
      const paymentCount = (data.payments || []).length;
      const payRowH = 18;
      const payHeadH = 20;

      checkPageBreak(payHeadH + Math.min(paymentCount, 3) * payRowH + 30);
      drawSectionHeader('Disbursed Salary Payments & Disbursements');

      let payY = doc.y;

      function drawPaymentHeader(y: number) {
        doc.save();
        doc.roundedRect(margin, y, contentWidth, payHeadH, 4).fill('#047857');
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
        doc.text('PAYMENT DATE', margin + 10, y + 6, { width: 85 });
        doc.text('PAYMENT METHOD', margin + 100, y + 6, { width: 120 });
        doc.text('TRANSACTION REFERENCE', margin + 225, y + 6, { width: 190 });
        doc.text('PAID AMOUNT', margin + 420, y + 6, { width: 109, align: 'right' });
        doc.restore();
      }

      drawPaymentHeader(payY);
      payY += payHeadH + 2;

      if (paymentCount === 0) {
        doc.save();
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#64748B')
           .text('No salary payment disbursements recorded for this pay period.', margin + 10, payY + 5);
        doc.restore();
        payY += 22;
      } else {
        data.payments.forEach((p, idx) => {
          if (payY + payRowH > maxBottom - 110) {
            doc.addPage();
            payY = margin;
            drawPaymentHeader(payY);
            payY += payHeadH + 2;
          }

          const bg = idx % 2 === 0 ? '#FFFFFF' : '#F0FDF4';
          doc.save();
          doc.rect(margin, payY, contentWidth, payRowH).fill(bg);

          // Payment Date
          doc.font('Helvetica').fontSize(8.5).fillColor('#334155')
             .text(p.paymentDate, margin + 10, payY + 4, { width: 85 });

          // Payment Method Pill
          const methodStr = (p.paymentMethod || 'BANK TRANSFER').replace(/_/g, ' ').toUpperCase();
          doc.roundedRect(margin + 100, payY + 2, 110, 14, 4).fill('#DCFCE7');
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#15803D')
             .text(methodStr, margin + 100, payY + 5, { width: 110, align: 'center' });

          // Reference
          doc.font('Helvetica').fontSize(8.5).fillColor('#1E293B')
             .text(p.reference || 'Direct Bank Disbursement', margin + 225, payY + 4, { width: 190, height: 14, lineBreak: false });

          // Paid Amount
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#047857')
             .text(formatCurrency(p.amount, symbol), margin + 420, payY + 4, { width: 109, align: 'right' });

          doc.restore();
          payY += payRowH;
        });
      }

      doc.y = payY + 10;

      // -------------------------------------------------------------
      // 6. FINAL SUMMARY CARD OF PAYMENTS (Due & Earned)
      // -------------------------------------------------------------
      const finalCardH = 75;
      checkPageBreak(finalCardH + 35);

      const finalY = doc.y;
      doc.save();
      doc.roundedRect(margin, finalY, contentWidth, finalCardH, 8)
         .fillAndStroke('#F1F5F9', '#CBD5E1');

      // Box 1: Gross Earned
      const box1X = margin + 16;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#475569')
         .text('TOTAL GROSS EARNED', box1X, finalY + 14);
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#0F172A')
         .text(formatCurrency(data.earnedAmount, symbol), box1X, finalY + 30);
      doc.font('Helvetica').fontSize(7.5).fillColor('#64748B')
         .text('Accumulated shift + overtime pay', box1X, finalY + 52);

      // Box 2: Total Paid
      const box2X = margin + 185;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#475569')
         .text('TOTAL AMOUNT PAID', box2X, finalY + 14);
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#059669')
         .text(formatCurrency(data.paidAmount, symbol), box2X, finalY + 30);
      doc.font('Helvetica').fontSize(7.5).fillColor('#64748B')
         .text('Disbursed payroll transactions', box2X, finalY + 52);

      // Box 3: Highlighted Net Due Box
      const box3W = 165;
      const box3H = 55;
      const box3X = margin + contentWidth - 16 - box3W;
      const box3Y = finalY + 10;

      doc.roundedRect(box3X, box3Y, box3W, box3H, 6).fill('#4F46E5');
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#E0E7FF')
         .text('NET PAYMENT DUE', box3X, box3Y + 10, { width: box3W, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(17).fillColor('#FFFFFF')
         .text(formatCurrency(data.dueAmount, symbol), box3X, box3Y + 24, { width: box3W, align: 'center' });

      doc.restore();

      // -------------------------------------------------------------
      // FOOTER / AUTHORIZATION NOTE
      // -------------------------------------------------------------
      const footerY = finalY + finalCardH + 12;
      doc.save();
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#64748B')
         .text(
           `This is a computer-generated salary payslip statement issued by ${data.orgName}. No physical signature required.`,
           margin,
           footerY,
           { width: contentWidth, align: 'center' }
         );
      doc.font('Helvetica').fontSize(7).fillColor('#94A3B8')
         .text(
           `Generated on: ${new Date().toLocaleString()}  •  Presence Workforce System`,
           margin,
           footerY + 12,
           { width: contentWidth, align: 'center' }
         );
      doc.restore();

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
