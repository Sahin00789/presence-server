import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createDeductionSchema,
  monthYearQuerySchema,
  recordTransactionSchema,
} from './schemas.js';
import {
  createPayrollDeduction,
  deletePayrollDeduction,
  deletePayrollTransaction,
  getOrGenerateMonthlyPayroll,
  listMonthlyPayrollSummaries,
  listPayrollDeductions,
  listPayrollTransactions,
  recordPayrollTransaction,
  updatePayrollDeduction,
  updatePayrollTransaction,
} from './service.js';
import { findStaffProfile } from '../../shared/services/staff.service.js';
import { buildPdfReport, PdfTable } from '../../shared/utils/pdf.js';
import * as schema from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../../shared/errors/app-error.js';

export async function payrollRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/payroll/monthly',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER', 'STAFF')],
      schema: {
        querystring: monthYearQuerySchema,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof monthYearQuerySchema>;
      let staffId = q.staffProfileId;
      let premisesId = q.premisesId;
      if (request.user.role === 'STAFF' || (request.user.role === 'MANAGER' && !staffId)) {
        const profile = await findStaffProfile(fastify, request.user.userId, request.user.organizationId);
        if (!profile) return reply.send(null);
        staffId = profile.id;
        if (!premisesId && profile.premisesId) {
          premisesId = profile.premisesId;
        }
      }
      if (!staffId || !premisesId) {
        return reply.status(400).send({ error: 'staffProfileId and premisesId required' });
      }
      const report = await getOrGenerateMonthlyPayroll(
        fastify,
        request.user.organizationId,
        premisesId,
        staffId,
        q.month,
        q.year
      );
      return reply.send(report);
    }
  );

  server.get(
    '/api/v1/payroll/monthly/summary',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        querystring: monthYearQuerySchema,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof monthYearQuerySchema>;
      const summaries = await listMonthlyPayrollSummaries(
        fastify,
        request.user.organizationId,
        q.month,
        q.year,
        q.premisesId
      );
      return reply.send(summaries);
    }
  );

  server.get(
    '/api/v1/payroll/deductions',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        querystring: z.object({ monthlyPayrollId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { monthlyPayrollId } = request.query as { monthlyPayrollId: string };
      const deductions = await listPayrollDeductions(fastify, monthlyPayrollId);
      return reply.send(deductions);
    }
  );

  server.post(
    '/api/v1/payroll/deductions',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        body: createDeductionSchema,
      },
    },
    async (request, reply) => {
      const deduction = await createPayrollDeduction(fastify, request.user.organizationId, request.user.userId, request.body as z.infer<typeof createDeductionSchema>);
      return reply.send(deduction);
    }
  );

  server.put(
    '/api/v1/payroll/deductions/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        body: z.object({
          amount: z.number().min(0).optional(),
          reason: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { amount?: number; reason?: string };
      const updated = await updatePayrollDeduction(fastify, request.user.organizationId, id, body);
      return reply.send(updated);
    }
  );

  server.delete(
    '/api/v1/payroll/deductions/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await deletePayrollDeduction(fastify, request.user.organizationId, id);
      return reply.send({ success: true });
    }
  );

  server.get(
    '/api/v1/payroll/transactions',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        querystring: z.object({ monthlyPayrollId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { monthlyPayrollId } = request.query as { monthlyPayrollId: string };
      const transactions = await listPayrollTransactions(fastify, monthlyPayrollId);
      return reply.send(transactions);
    }
  );

  server.post(
    '/api/v1/payroll/transactions',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        body: recordTransactionSchema,
      },
    },
    async (request, reply) => {
      const transaction = await recordPayrollTransaction(fastify, request.user.organizationId, request.user.userId, request.body as z.infer<typeof recordTransactionSchema>);
      return reply.send(transaction);
    }
  );

  server.put(
    '/api/v1/payroll/transactions/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        body: z.object({
          amount: z.number().min(0).optional(),
          paymentDate: z.string().optional(),
          paymentMethod: z.string().optional(),
          referenceNumber: z.string().optional().nullable(),
          notes: z.string().optional().nullable(),
        }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as any;
      const updated = await updatePayrollTransaction(fastify, request.user.organizationId, id, body);
      return reply.send(updated);
    }
  );

  server.delete(
    '/api/v1/payroll/transactions/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await deletePayrollTransaction(fastify, request.user.organizationId, id);
      return reply.send({ success: true });
    }
  );

  server.get(
    '/api/v1/payroll/my-payslips',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('MANAGER', 'STAFF')],
      schema: {
        querystring: z.object({
          month: z.coerce.number().min(1).max(12).optional(),
          year: z.coerce.number().min(2000).max(2100).optional(),
        }),
      },
    },
    async (request, reply) => {
      const profile = await findStaffProfile(fastify, request.user.userId, request.user.organizationId);
      if (!profile || !profile.premisesId) return reply.send([]);
      const { month: reqMonth, year: reqYear } = request.query as { month?: number; year?: number };
      const now = new Date();

      const targetPairs: Array<{ month: number; year: number }> = [];
      if (reqMonth && reqYear) {
        targetPairs.push({ month: reqMonth, year: reqYear });
      } else if (reqYear) {
        const maxM = reqYear === now.getFullYear() ? now.getMonth() + 1 : 12;
        for (let m = maxM; m >= 1; m--) {
          targetPairs.push({ month: m, year: reqYear });
        }
      } else {
        let startYear = now.getFullYear();
        let startMonth = 1;
        if (profile.hireDate) {
          const [hY, hM] = profile.hireDate.split('-').map(Number);
          if (hY && hM) {
            startYear = hY;
            startMonth = hM;
          }
        }
        const currentTotalMonths = now.getFullYear() * 12 + (now.getMonth() + 1);
        const startTotalMonths = Math.max(startYear * 12 + startMonth, currentTotalMonths - 23);
        for (let tm = currentTotalMonths; tm >= startTotalMonths; tm--) {
          const y = Math.floor((tm - 1) / 12);
          const m = ((tm - 1) % 12) + 1;
          targetPairs.push({ month: m, year: y });
        }
      }

      const results = [];
      for (const { month, year } of targetPairs) {
        try {
          const report = await getOrGenerateMonthlyPayroll(
            fastify,
            request.user.organizationId,
            profile.premisesId,
            profile.id,
            month,
            year
          );
          if (report) {
            const r: any = report as any;
            const periodStartDate = `${year}-${String(month).padStart(2, '0')}-01`;
            const periodEndDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
            results.push({
              id: r.id,
              payrollPeriodId: r.id,
              periodStartDate,
              periodEndDate,
              periodStatus: r.status,
              grossSalaryPaise: Math.round(Number(r.earnedAmount) * 100),
              additionsPaise: 0,
              deductionsPaise: Math.round(Number(r.deductionAmount) * 100),
              netSalaryPaise: Math.round(Number(r.dueAmount) * 100),
              breakdown: r.breakdown ?? { earnings: [], deductions: [] },
              attendanceSummary: r.attendanceSummary ?? {
                totalDays: 0,
                presentDays: 0,
                lateDays: 0,
                halfDays: 0,
                absentDays: 0,
                leaveDays: 0,
                unpaidLeaveDays: 0,
                paidLeaveDays: 0,
                holidayDays: 0,
                weeklyOffDays: 0,
                totalWorkedMinutes: 0,
                totalOvertimeMinutes: 0,
              },
              createdAt: r.createdAt,
            });
          }
        } catch (err) {
          fastify.log.warn({ err, month, year }, 'Failed to compute monthly payroll for payslip');
        }
      }
      return reply.send(results);
    }
  );

  server.get(
    '/api/v1/payroll/payslip/download',
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: z.object({
          month: z.coerce.number().min(1).max(12),
          year: z.coerce.number().min(2000).max(2100),
          staffProfileId: z.string().uuid().optional(),
        }),
      },
    },
    async (request, reply) => {
      const q = request.query as { month: number; year: number; staffProfileId?: string };
      let staffId = q.staffProfileId;
      if (request.user.role === 'STAFF' || (request.user.role === 'MANAGER' && !staffId)) {
        const selfProfile = await findStaffProfile(fastify, request.user.userId, request.user.organizationId);
        if (!selfProfile) throw new AppError('Employee profile not found', 404, 'EMPLOYEE_NOT_FOUND');
        staffId = selfProfile.id;
      }
      if (!staffId) {
        throw new AppError('staffProfileId is required', 400, 'STAFF_PROFILE_ID_REQUIRED');
      }

      const [employee] = await fastify.db
        .select({
          id: schema.employees.id,
          name: schema.employees.name,
          employeeCode: schema.employees.employeeCode,
          premisesId: schema.employees.premisesId,
          department: schema.employees.department,
          designation: schema.employees.designation,
          email: schema.users.email,
        })
        .from(schema.employees)
        .innerJoin(schema.users, eq(schema.employees.userId, schema.users.id))
        .where(
          and(
            eq(schema.employees.id, staffId),
            eq(schema.employees.organizationId, request.user.organizationId)
          )
        )
        .limit(1);

      if (!employee || !employee.premisesId) {
        throw new AppError('Employee or assigned premises not found', 404, 'EMPLOYEE_NOT_FOUND');
      }

      const [org] = await fastify.db
        .select({ name: schema.organizations.name, currency: schema.organizations.currency })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, request.user.organizationId))
        .limit(1);

      const orgName = org?.name || 'Presence Organization';
      const currency = org?.currency || 'INR';

      const report = await getOrGenerateMonthlyPayroll(
        fastify,
        request.user.organizationId,
        employee.premisesId,
        employee.id,
        q.month,
        q.year
      );
      if (!report) throw new AppError('Payroll report could not be generated', 500, 'PAYROLL_GENERATION_FAILED');

      const r: any = report as any;
      const att = r.attendanceSummary ?? {};
      const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
      ];
      const monthLabel = monthNames[q.month - 1] || `Month ${q.month}`;

      const pdfTable: PdfTable = {
        title: `PAYSLIP - ${monthLabel.toUpperCase()} ${q.year}`,
        subtitle: `${orgName} | Employee: ${employee.name} (${employee.employeeCode}) | Status: ${r.status}`,
        columns: ['Category', 'Details', 'Amount / Count'],
        rows: [
          ['Employee', 'Name', employee.name],
          ['Employee', 'Code', employee.employeeCode],
          ['Employee', 'Email', employee.email],
          ['Period', 'Month / Year', `${monthLabel} ${q.year}`],
          ['Attendance', 'Present Days', att.presentDays ?? 0],
          ['Attendance', 'Late Days', att.lateDays ?? 0],
          ['Attendance', 'Half Days', att.halfDays ?? 0],
          ['Attendance', 'Absent Days', att.absentDays ?? 0],
          ['Attendance', 'Leave Days', att.leaveDays ?? 0],
          ['Attendance', 'Holiday Days', att.holidayDays ?? 0],
          ['Attendance', 'Weekly Off Days', att.weeklyOffDays ?? 0],
          ['Attendance', 'Overtime Minutes', att.totalOvertimeMinutes ?? 0],
          ['Earnings', 'Gross Earned', `${currency} ${r.earnedAmount}`],
          ['Deductions', 'Total Deductions', `${currency} ${r.deductionAmount}`],
          ['Summary', 'Net Due / Payable', `${currency} ${r.dueAmount}`],
          ['Summary', 'Amount Paid', `${currency} ${r.paidAmount}`],
          ['Status', 'Payroll Status', r.status],
        ],
      };

      const pdfBuffer = buildPdfReport(pdfTable);
      return reply
        .type('application/pdf')
        .header('Content-Disposition', `attachment; filename="payslip-${employee.employeeCode}-${q.year}-${String(q.month).padStart(2, '0')}.pdf"`)
        .send(pdfBuffer);
    }
  );
}
