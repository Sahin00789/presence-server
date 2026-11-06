import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createOvertimeSchema,
  overtimeListQuerySchema,
  overtimeSchema,
} from './schemas.js';
import { cancelOvertime, createOvertime, listOvertime } from './service.js';

export async function overtimeRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/overtime',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description:
          'List overtime entries. Employees receive their own, Owners receive the whole organization.',
        tags: ['Overtime'],
        querystring: overtimeListQuerySchema,
        response: {
          200: z.array(overtimeSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await listOvertime(
        fastify,
        request.user,
        request.user.organizationId,
        request.query as { from?: string; to?: string; staffProfileId?: string; status?: string }
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/overtime',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        description:
          'Raise an overtime entry for an employee.',
        tags: ['Overtime'],
        body: createOvertimeSchema,
        response: {
          200: overtimeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createOvertime(
        fastify,
        request.user,
        request.user.organizationId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/overtime/:overtimeId/cancel',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        description: 'Cancel an overtime entry that has not been worked yet',
        tags: ['Overtime'],
        params: z.object({ overtimeId: z.string().uuid() }),
        response: {
          200: z.object({ id: z.string().uuid(), status: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { overtimeId } = request.params as { overtimeId: string };
      const result = await cancelOvertime(
        fastify,
        request.user,
        request.user.organizationId,
        overtimeId
      );
      return reply.send(result);
    }
  );
}
