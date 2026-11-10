import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createUnworkedPaymentRuleSchema,
  downloadPayslipQuerySchema,
  monthYearQuerySchema,
  myMonthlyEarningLedgerQuerySchema,
  recordTransactionSchema,
  transactionsQuerySchema,
  unworkedRulesQuerySchema,
  updateTransactionSchema,
} from './schemas.js';
import {
  createUnworkedPaymentRule,
  deletePayrollTransaction,
  downloadPayslipPdf,
  getMyMonthlyEarningLedger,
  getMyOverallPayrollSummary,
  getOrGenerateMonthlyPayroll,
  getUnworkedPaymentRules,
  listMonthlyPayrollSummaries,
  listPayrollTransactions,
  recordPayrollTransaction,
  updatePayrollTransaction,
} from './service.js';
import { findStaffProfile } from '../../shared/services/staff.service.js';

export async function payrollRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // 1. Get monthly payroll report for an employee / premises
  server.get(
    '/api/v1/payroll/monthly',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'EMPLOYEE')],
      schema: {
        querystring: monthYearQuerySchema,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof monthYearQuerySchema>;
      let staffId = q.staffProfileId;
      let premisesId = q.premisesId;
      if (request.user.role === 'EMPLOYEE') {
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

  // 2. Get monthly payroll summaries for owner
  server.get(
    '/api/v1/payroll/monthly/summary',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
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

  // 3. My monthly earning ledger route for employee
  server.get(
    '/api/v1/payroll/my-monthly-earning-ledger',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
      schema: {
        querystring: myMonthlyEarningLedgerQuerySchema,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof myMonthlyEarningLedgerQuerySchema>;
      const ledger = await getMyMonthlyEarningLedger(fastify, request.user, q.month, q.year);
      return reply.send(ledger);
    }
  );

  // Alias route for my-monthly-ledger
  server.get(
    '/api/v1/payroll/my-monthly-ledger',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
      schema: {
        querystring: myMonthlyEarningLedgerQuerySchema,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof myMonthlyEarningLedgerQuerySchema>;
      const ledger = await getMyMonthlyEarningLedger(fastify, request.user, q.month, q.year);
      return reply.send(ledger);
    }
  );

  // 4. My overall payroll summary (total earned, paid, due)
  server.get(
    '/api/v1/payroll/my-overall-summary',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
    },
    async (request, reply) => {
      const summary = await getMyOverallPayrollSummary(fastify, request.user);
      return reply.send(summary);
    }
  );

  // 5. Download payslip PDF for a given month and year
  server.get(
    '/api/v1/payroll/payslip/download',
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: downloadPayslipQuerySchema,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof downloadPayslipQuerySchema>;
      const { filename, pdfBuffer } = await downloadPayslipPdf(fastify, request.user, q);
      return reply
        .type('application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(pdfBuffer);
    }
  );

  // 7. Transactions CRUD
  server.get(
    '/api/v1/payroll/transactions',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        querystring: transactionsQuerySchema,
      },
    },
    async (request, reply) => {
      const { monthlyPayrollId } = request.query as z.infer<typeof transactionsQuerySchema>;
      const transactions = await listPayrollTransactions(fastify, monthlyPayrollId);
      return reply.send(transactions);
    }
  );

  server.post(
    '/api/v1/payroll/transactions',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        body: recordTransactionSchema,
      },
    },
    async (request, reply) => {
      const transaction = await recordPayrollTransaction(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body as z.infer<typeof recordTransactionSchema>
      );
      return reply.send(transaction);
    }
  );

  server.put(
    '/api/v1/payroll/transactions/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        body: updateTransactionSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof updateTransactionSchema>;
      const updated = await updatePayrollTransaction(fastify, request.user.organizationId, id, body);
      return reply.send(updated);
    }
  );

  server.delete(
    '/api/v1/payroll/transactions/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await deletePayrollTransaction(fastify, request.user.organizationId, id);
      return reply.send({ success: true });
    }
  );

  // 8. Unworked Payment Rules GET & POST
  const handleGetUnworkedRules = async (request: any, reply: any) => {
    const q = request.query as z.infer<typeof unworkedRulesQuerySchema>;
    let targetEmployeeId = q.employeeId;
    if (request.user.role === 'EMPLOYEE') {
      const profile = await findStaffProfile(fastify, request.user.userId, request.user.organizationId);
      if (profile) {
        targetEmployeeId = profile.id;
      }
    }
    const rules = await getUnworkedPaymentRules(
      fastify,
      request.user.organizationId,
      targetEmployeeId,
      q.onDate
    );
    return reply.send(rules);
  };

  const handlePostUnworkedRule = async (request: any, reply: any) => {
    const body = request.body as z.infer<typeof createUnworkedPaymentRuleSchema>;
    const created = await createUnworkedPaymentRule(
      fastify,
      request.user.organizationId,
      body
    );
    return reply.send(created);
  };

  server.get(
    '/api/v1/salary/unworked-rules',
    {
      preHandler: [fastify.authenticate],
      schema: { querystring: unworkedRulesQuerySchema },
    },
    handleGetUnworkedRules
  );

  server.get(
    '/api/v1/payroll/unworked-rules',
    {
      preHandler: [fastify.authenticate],
      schema: { querystring: unworkedRulesQuerySchema },
    },
    handleGetUnworkedRules
  );

  server.post(
    '/api/v1/salary/unworked-rules',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: { body: createUnworkedPaymentRuleSchema },
    },
    handlePostUnworkedRule
  );

  server.post(
    '/api/v1/payroll/unworked-rules',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: { body: createUnworkedPaymentRuleSchema },
    },
    handlePostUnworkedRule
  );
}

