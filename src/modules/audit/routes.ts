import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditLogSchema, auditLogsQuerySchema } from './schemas.js';
import { listAuditLogs } from './service.js';

export async function auditRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/audit-logs',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description:
          'List the operational audit trail. Owners see everything, Managers see operational events only.',
        tags: ['Audit'],
        querystring: auditLogsQuerySchema,
        response: { 200: z.array(auditLogSchema) },
      },
    },
    async (request, reply) => {
      const result = await listAuditLogs(
        fastify,
        request.user,
        request.user.organizationId,
        request.query as any
      );
      return reply.send(result);
    }
  );
}
