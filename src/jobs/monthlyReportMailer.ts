import { FastifyInstance } from 'fastify';
import { and, eq, gte, lte } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { sendMonthlyReportEmail } from '../shared/services/mail.service.js';
import { renderReport, ReportTable } from '../modules/reports/service.js';
import { listMonthlyPayrollSummaries } from '../modules/payroll/service.js';

export async function processMonthlyReports(
  fastify: FastifyInstance,
  now: Date = new Date()
): Promise<{ ownersMailed: number; managersMailed: number; staffMailed: number }> {
  // Target previous month by default (e.g. on June 1st, month = 5, year = 2025)
  const targetDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = targetDate.getMonth() + 1;
  const year = targetDate.getFullYear();
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  let ownersMailed = 0;
  let managersMailed = 0;
  let staffMailed = 0;

  // 1. Fetch all active organizations and owners
  const orgs = await fastify.db
    .select({
      orgId: schema.organizations.id,
      orgName: schema.organizations.name,
      ownerUserId: schema.organizations.ownerUserId,
      ownerEmail: schema.users.email,
      ownerName: schema.users.fullName,
    })
    .from(schema.organizations)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizations.ownerUserId));

  for (const org of orgs) {
    // --- Role 1: OWNER Monthly Report ---
    try {
      const payrollSummaries = await listMonthlyPayrollSummaries(
        fastify,
        org.orgId,
        month,
        year
      );

      const ownerTable: ReportTable = {
        title: `Monthly Organization Executive Report (${org.orgName})`,
        subtitle: `Period: ${startDate} to ${endDate}`,
        columns: ['Staff Code', 'Staff Name', 'Earned', 'Deductions', 'Paid', 'Due', 'Status'],
        rows: payrollSummaries.map((p) => [
          p.staffCode ?? '',
          p.staffName ?? '',
          p.earnedAmount ?? '0.00',
          p.deductionAmount ?? '0.00',
          p.paidAmount ?? '0.00',
          p.dueAmount ?? '0.00',
          p.status,
        ]),
      };

      const pdfReport = renderReport(ownerTable, 'pdf', `owner-report-${org.orgId}`);
      const csvReport = renderReport(ownerTable, 'csv', `owner-report-${org.orgId}`);

      await sendMonthlyReportEmail({
        to: org.ownerEmail,
        recipientName: org.ownerName,
        role: 'OWNER',
        organizationName: org.orgName,
        month,
        year,
        pdfBuffer: pdfReport.payload as Buffer,
        csvContent: csvReport.payload as string,
        logger: fastify.log,
      });
      ownersMailed += 1;
    } catch (err) {
      fastify.log.warn({ err, orgId: org.orgId }, 'Failed to process owner monthly report');
    }

    // --- Fetch Employees (MANAGERS & STAFF) ---
    const employees = await fastify.db
      .select({
        employeeId: schema.employees.id,
        userId: schema.employees.userId,
        role: schema.employees.role,
        premisesId: schema.employees.premisesId,
        email: schema.users.email,
        fullName: schema.users.fullName,
        employeeCode: schema.employees.employeeCode,
      })
      .from(schema.employees)
      .innerJoin(schema.users, eq(schema.users.id, schema.employees.userId))
      .where(
        and(
          eq(schema.employees.organizationId, org.orgId),
          eq(schema.employees.isActive, true)
        )
      );

    for (const emp of employees) {
      try {
        if (emp.role === 'MANAGER') {
          // --- Role 2: MANAGER Monthly Report ---
          const premisesPayroll = await listMonthlyPayrollSummaries(
            fastify,
            org.orgId,
            month,
            year,
            emp.premisesId ?? undefined
          );

          const managerTable: ReportTable = {
            title: `Monthly Premises Operations Summary (${org.orgName})`,
            subtitle: `Period: ${startDate} to ${endDate}`,
            columns: ['Staff Code', 'Staff Name', 'Earned', 'Deductions', 'Paid', 'Due', 'Status'],
            rows: premisesPayroll.map((p) => [
              p.staffCode ?? '',
              p.staffName ?? '',
              p.earnedAmount ?? '0.00',
              p.deductionAmount ?? '0.00',
              p.paidAmount ?? '0.00',
              p.dueAmount ?? '0.00',
              p.status,
            ]),
          };

          const pdfReport = renderReport(managerTable, 'pdf', `manager-report-${emp.employeeId}`);
          const csvReport = renderReport(managerTable, 'csv', `manager-report-${emp.employeeId}`);

          await sendMonthlyReportEmail({
            to: emp.email,
            recipientName: emp.fullName,
            role: 'MANAGER',
            organizationName: org.orgName,
            month,
            year,
            pdfBuffer: pdfReport.payload as Buffer,
            csvContent: csvReport.payload as string,
            logger: fastify.log,
          });
          managersMailed += 1;
        } else if (emp.role === 'STAFF') {
          // --- Role 3: STAFF Monthly Payslip & Attendance Report ---
          const attendanceEvents = await fastify.db
            .select()
            .from(schema.employeeAttendance)
            .where(
              and(
                eq(schema.employeeAttendance.employeeId, emp.employeeId),
                gte(schema.employeeAttendance.workDate, startDate),
                lte(schema.employeeAttendance.workDate, endDate)
              )
            );

          const staffTable: ReportTable = {
            title: `Monthly Attendance & Earnings Statement (${emp.fullName})`,
            subtitle: `Staff Code: ${emp.employeeCode} | Period: ${startDate} to ${endDate}`,
            columns: ['Work Date', 'Status', 'Worked Minutes', 'Remarks'],
            rows: attendanceEvents.map((a) => [
              String(a.workDate),
              a.status,
              a.workedMinutes ?? 0,
              a.remarks ?? '',
            ]),
          };

          const pdfReport = renderReport(staffTable, 'pdf', `staff-payslip-${emp.employeeId}`);
          const csvReport = renderReport(staffTable, 'csv', `staff-payslip-${emp.employeeId}`);

          await sendMonthlyReportEmail({
            to: emp.email,
            recipientName: emp.fullName,
            role: 'STAFF',
            organizationName: org.orgName,
            month,
            year,
            pdfBuffer: pdfReport.payload as Buffer,
            csvContent: csvReport.payload as string,
            logger: fastify.log,
          });
          staffMailed += 1;
        }
      } catch (err) {
        fastify.log.warn({ err, employeeId: emp.employeeId }, 'Failed to process employee monthly report');
      }
    }
  }

  return { ownersMailed, managersMailed, staffMailed };
}

export function startMonthlyReportMailerJob(fastify: FastifyInstance): void {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      // Only execute on 1st day of the month or when manually invoked
      if (now.getDate() === 1) {
        await processMonthlyReports(fastify, now);
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'Monthly report mailer job failed');
    } finally {
      running = false;
    }
  };

  fastify.addHook('onListen', async () => {
    // Initial delay 6 seconds on server start, then check every 12 hours
    setTimeout(run, 6000);
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
