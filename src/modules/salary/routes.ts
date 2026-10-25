import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as schema from '../../db/schema.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import {
  createShiftPaymentRuleSchema,
  createUnworkedPaymentRuleSchema,
  shiftPaymentRuleSchema,
  unworkedPaymentRuleSchema,
} from './schemas.js';
import {
  createShiftPaymentRule,
  createUnworkedPaymentRule,
  getShiftPaymentRules,
  getUnworkedPaymentRules,
} from './service.js';

const rulesQuerySchema = z.object({
  staffProfileId: z.string().uuid().optional(),
  onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function mapShiftRule(row: typeof schema.shiftPaymentRules.$inferSelect) {
  const statusStr = String(row.attendanceStatus);
  const validStatus = (['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT'].includes(statusStr)
    ? statusStr
    : 'PRESENT') as 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT';

  return {
    id: row.id,
    organizationId: row.organizationId,
    staffProfileId: row.staffProfileId ?? null,
    shiftTemplateId: row.shiftTemplateId ?? null,
    attendanceStatus: validStatus,
    paymentCents: row.paymentCents,
    penaltyCents: row.penaltyCents,
    effectiveFrom: String(row.effectiveFrom),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapUnworkedRule(row: typeof schema.unworkedPaymentRules.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    staffProfileId: row.staffProfileId ?? null,
    dayType: row.dayType,
    paymentCents: row.paymentCents,
    multiplierBasisPoints: row.multiplierBasisPoints,
    effectiveFrom: String(row.effectiveFrom),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Payment-rule configuration. Owners and Managers attach per-shift attendance
 * payments and holiday / weekly-off rates; the payroll engine resolves the
 * latest effective rule on the payroll period's first day.
 */
export async function salaryRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/salary/shift-rules',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Effective shift payment rules for an employee or the organization',
        tags: ['Salary'],
        querystring: rulesQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof rulesQuerySchema>;
      const rows = await getShiftPaymentRules(
        fastify,
        request.user.organizationId,
        query.staffProfileId,
        query.onDate
      );
      return reply.send(rows);
    }
  );

  server.post(
    '/api/v1/salary/shift-rules',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Create an effective-dated shift payment rule',
        tags: ['Salary'],
        body: createShiftPaymentRuleSchema,
      },
    },
    async (request, reply) => {
      const rule = await createShiftPaymentRule(
        fastify,
        request.user.organizationId,
        request.body
      );
      await writeAuditLog(fastify, {
        organizationId: request.user.organizationId,
        actorId: request.user.userId,
        action: 'SHIFT_PAYMENT_RULE_CREATED',
        resourceType: 'shift_payment_rule',
        resourceId: rule.id,
        metadata: {
          staffProfileId: rule.staffProfileId,
          shiftTemplateId: rule.shiftTemplateId,
          attendanceStatus: rule.attendanceStatus,
          paymentCents: rule.paymentCents,
          penaltyCents: rule.penaltyCents,
          effectiveFrom: String(rule.effectiveFrom),
        },
      });
      return reply.send(rule);
    }
  );

  server.get(
    '/api/v1/salary/unworked-rules',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Effective holiday, weekly-off and paid-leave rules',
        tags: ['Salary'],
        querystring: rulesQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof rulesQuerySchema>;
      const rows = await getUnworkedPaymentRules(
        fastify,
        request.user.organizationId,
        query.staffProfileId,
        query.onDate
      );
      return reply.send(rows);
    }
  );

  server.post(
    '/api/v1/salary/unworked-rules',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Create an effective-dated unworked-day payment rule',
        tags: ['Salary'],
        body: createUnworkedPaymentRuleSchema,
      },
    },
    async (request, reply) => {
      const rule = await createUnworkedPaymentRule(
        fastify,
        request.user.organizationId,
        request.body
      );
      await writeAuditLog(fastify, {
        organizationId: request.user.organizationId,
        actorId: request.user.userId,
        action: 'UNWORKED_PAYMENT_RULE_CREATED',
        resourceType: 'unworked_payment_rule',
        resourceId: rule.id,
        metadata: {
          staffProfileId: rule.staffProfileId,
          dayType: rule.dayType,
          paymentCents: rule.paymentCents,
          multiplierBasisPoints: rule.multiplierBasisPoints,
          effectiveFrom: String(rule.effectiveFrom),
        },
      });
      return reply.send(rule);
    }
  );
}
