import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createDeductionSchema,
  monthYearQuerySchema,
  reconcileRequestSchema,
  recordTransactionSchema,
} from './schemas.js';
import {
  createPayrollDeduction,
  deletePayrollDeduction,
  deletePayrollTransaction,
  getDailyEarningLedger,
  getDailyEarningTotals,
  getMonthlyAttendanceStats,
  getOrGenerateMonthlyPayroll,
  listMonthlyPayrollSummaries,
  listPayrollDeductions,
  listPayrollTransactions,
  rebuildMonthlyAttendanceStats,
  recordPayrollTransaction,
} from './service.js';
import { findStaffProfile } from '../../shared/services/staff.service.js';

export async function payrollRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // 1. Get monthly attendance statistics
  server.get(
    '/api/v1/payroll/attendance-stats',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER', 'STAFF')],
      schema: {
        description: 'Get monthly attendance statistics',
        tags: ['Payroll'],
        querystring: monthYearQuerySchema,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof monthYearQuerySchema>;
      let staffId = q.staffProfileId;
      if (request.user.role === 'STAFF') {
        const profile = await findStaffProfile(fastify, request.user.userId, request.user.organizationId);
        staffId = profile?.id;
      }
      const stats = await getMonthlyAttendanceStats(
        fastify,
        request.user.organizationId,
        q.month,
        q.year,
        q.premisesId,
        staffId
      );
      return reply.send(stats);
    }
  );

  // 10. Rebuild monthly attendance statistics
  server.post(
    '/api/v1/payroll/rebuild-stats',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Rebuild monthly attendance statistics',
        tags: ['Payroll'],
        body: monthYearQuerySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof monthYearQuerySchema>;
      await rebuildMonthlyAttendanceStats(
        fastify,
        request.user.organizationId,
        body.month,
        body.year,
        body.premisesId,
        body.staffProfileId
      );
      return reply.send({ status: 'SUCCESS' });
    }
  );

  // 2. Get or generate monthly payroll
  server.get(
    '/api/v1/payroll/monthly',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER', 'STAFF')],
      schema: {
        description: 'Get or generate monthly payroll',
        tags: ['Payroll'],
        querystring: monthYearQuerySchema,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof monthYearQuerySchema>;
      let staffId = q.staffProfileId;
      if (request.user.role === 'STAFF') {
        const profile = await findStaffProfile(fastify, request.user.userId, request.user.organizationId);
        if (!profile) return reply.send(null);
        staffId = profile.id;
      }
      if (!staffId || !q.premisesId) {
        return reply.status(400).send({ error: 'staffProfileId and premisesId required' });
      }
      const payroll = await getOrGenerateMonthlyPayroll(
        fastify,
        request.user.organizationId,
        q.premisesId,
        staffId,
        q.month,
        q.year
      );
      return reply.send(payroll);
    }
  );

  // 3. Get monthly payroll summaries
  server.get(
    '/api/v1/payroll/monthly/summary',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Get monthly payroll summaries for staff',
        tags: ['Payroll'],
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

  // 4. Get daily earning ledger entries
  server.get(
    '/api/v1/payroll/earning-ledger',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER', 'STAFF')],
      schema: {
        description: 'Get daily earning ledger entries',
        tags: ['Payroll'],
        querystring: monthYearQuerySchema,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof monthYearQuerySchema>;
      let staffId = q.staffProfileId;
      if (request.user.role === 'STAFF') {
        const profile = await findStaffProfile(fastify, request.user.userId, request.user.organizationId);
        if (!profile) return reply.send([]);
        staffId = profile.id;
      }
      if (!staffId) {
        return reply.status(400).send({ error: 'staffProfileId required' });
      }
      const entries = await getDailyEarningLedger(
        fastify,
        request.user.organizationId,
        staffId,
        q.month,
        q.year
      );
      return reply.send(entries);
    }
  );

  // 5. Get daily earning totals grouped by date
  server.get(
    '/api/v1/payroll/earning-totals',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER', 'STAFF')],
      schema: {
        description: 'Get daily earning totals grouped by date',
        tags: ['Payroll'],
        querystring: monthYearQuerySchema,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof monthYearQuerySchema>;
      let staffId = q.staffProfileId;
      if (request.user.role === 'STAFF') {
        const profile = await findStaffProfile(fastify, request.user.userId, request.user.organizationId);
        if (!profile) return reply.send([]);
        staffId = profile.id;
      }
      if (!staffId) {
        return reply.status(400).send({ error: 'staffProfileId required' });
      }
      const totals = await getDailyEarningTotals(
        fastify,
        request.user.organizationId,
        staffId,
        q.month,
        q.year
      );
      return reply.send(totals);
    }
  );

  // 6. Deductions
  server.post(
    '/api/v1/payroll/deductions',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Create monthly deduction',
        tags: ['Payroll'],
        body: createDeductionSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createDeductionSchema>;
      const deduction = await createPayrollDeduction(
        fastify,
        request.user.organizationId,
        request.user.userId,
        body
      );
      return reply.send(deduction);
    }
  );

  server.get(
    '/api/v1/payroll/deductions',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'List deductions for a monthly payroll',
        tags: ['Payroll'],
        querystring: z.object({ monthlyPayrollId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const q = request.query as { monthlyPayrollId: string };
      const deductions = await listPayrollDeductions(fastify, request.user.organizationId, q.monthlyPayrollId);
      return reply.send(deductions);
    }
  );

  server.delete(
    '/api/v1/payroll/deductions/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Delete payroll deduction',
        tags: ['Payroll'],
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await deletePayrollDeduction(fastify, request.user.organizationId, id);
      return reply.send(result);
    }
  );

  // 7. Transactions (Payments)
  server.post(
    '/api/v1/payroll/transactions',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Record salary payment transaction',
        tags: ['Payroll'],
        body: recordTransactionSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof recordTransactionSchema>;
      const tx = await recordPayrollTransaction(
        fastify,
        request.user.organizationId,
        request.user.userId,
        body
      );
      return reply.send(tx);
    }
  );

  server.get(
    '/api/v1/payroll/transactions',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'List payment transactions for a monthly payroll',
        tags: ['Payroll'],
        querystring: z.object({ monthlyPayrollId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const q = request.query as { monthlyPayrollId: string };
      const txs = await listPayrollTransactions(fastify, request.user.organizationId, q.monthlyPayrollId);
      return reply.send(txs);
    }
  );

  server.delete(
    '/api/v1/payroll/transactions/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Delete payment transaction',
        tags: ['Payroll'],
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await deletePayrollTransaction(fastify, request.user.organizationId, id);
      return reply.send(result);
    }
  );

  // 9. Reconcile
  server.post(
    '/api/v1/payroll/reconcile',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Recalculate and reconcile monthly payrolls',
        tags: ['Payroll'],
        body: reconcileRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof reconcileRequestSchema>;
      const summaries = await listMonthlyPayrollSummaries(
        fastify,
        request.user.organizationId,
        body.month,
        body.year,
        body.premisesId
      );
      return reply.send({ status: 'RECONCILED', count: summaries.length });
    }
  );

  // Compatibility endpoints for Android app (`PayrollApiService`)
  server.get(
    '/api/v1/payroll/periods',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
    },
    async (request, reply) => {
      const now = new Date();
      const summaries = await listMonthlyPayrollSummaries(
        fastify,
        request.user.organizationId,
        now.getMonth() + 1,
        now.getFullYear()
      );
      return reply.send(
        summaries.map((s) => ({
          id: s.id,
          organizationId: s.organizationId,
          startDate: `${s.year}-${String(s.month).padStart(2, '0')}-01`,
          endDate: `${s.year}-${String(s.month).padStart(2, '0')}-${new Date(s.year, s.month, 0).getDate()}`,
          status: s.status === 'PAID' ? 'PAID' : 'LOCKED',
          createdAt: s.createdAt,
          itemCount: 1,
          grossSalaryCents: Math.round(Number(s.earnedAmount) * 100),
          netSalaryCents: Math.round(Number(s.dueAmount) * 100),
        }))
      );
    }
  );

  server.get(
    '/api/v1/payroll/periods/:id/items',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
    },
    async (request, reply) => {
      const now = new Date();
      const summaries = await listMonthlyPayrollSummaries(
        fastify,
        request.user.organizationId,
        now.getMonth() + 1,
        now.getFullYear()
      );
      return reply.send(
        summaries.map((s) => ({
          id: s.id,
          payrollPeriodId: s.id,
          staffProfileId: s.staffId,
          staffName: s.staffName ?? 'Staff',
          staffEmail: s.staffEmail ?? '',
          staffCode: s.staffCode ?? '',
          grossSalaryCents: Math.round(Number(s.earnedAmount) * 100),
          additionsCents: 0,
          deductionsCents: Math.round(Number(s.deductionAmount) * 100),
          netSalaryCents: Math.round(Number(s.dueAmount) * 100),
          breakdown: { earnings: [], deductions: [] },
          attendanceSummary: {
            totalDays: 30,
            presentDays: 20,
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
          createdAt: s.createdAt,
          payment: null,
        }))
      );
    }
  );

  server.get(
    '/api/v1/payroll/my-payslips',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const profile = await findStaffProfile(fastify, request.user.userId, request.user.organizationId);
      if (!profile) return reply.send([]);
      const now = new Date();
      const payroll = await getOrGenerateMonthlyPayroll(
        fastify,
        request.user.organizationId,
        profile.premisesId ?? '',
        profile.id,
        now.getMonth() + 1,
        now.getFullYear()
      );
      return reply.send([
        {
          id: payroll.id,
          payrollPeriodId: payroll.id,
          periodStartDate: `${payroll.year}-${String(payroll.month).padStart(2, '0')}-01`,
          periodEndDate: `${payroll.year}-${String(payroll.month).padStart(2, '0')}-${new Date(payroll.year, payroll.month, 0).getDate()}`,
          periodStatus: payroll.status,
          grossSalaryCents: Math.round(Number(payroll.earnedAmount) * 100),
          additionsCents: 0,
          deductionsCents: Math.round(Number(payroll.deductionAmount) * 100),
          netSalaryCents: Math.round(Number(payroll.dueAmount) * 100),
          breakdown: { earnings: [], deductions: [] },
          attendanceSummary: {
            totalDays: 30,
            presentDays: 20,
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
          createdAt: payroll.createdAt,
        },
      ]);
    }
  );
}
