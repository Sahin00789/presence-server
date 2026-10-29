import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createHolidaySchema, holidaySchema, updateHolidaySchema } from './schemas.js';
import { createHoliday, deleteHoliday, listHolidays, updateHoliday } from './service.js';

export async function holidayRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/holidays',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'List organization holidays',
        tags: ['Holidays'],
        querystring: z.object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          premisesId: z.string().uuid().optional(),
        }),
        response: {
          200: z.array(holidaySchema),
        },
      },
    },
    async (request, reply) => {
      const { from, to, premisesId } = request.query as { from?: string; to?: string; premisesId?: string };
      const result = await listHolidays(fastify, request.user.organizationId, from, to, premisesId);
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/holidays',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Create a holiday',
        tags: ['Holidays'],
        body: createHolidaySchema,
        response: {
          200: holidaySchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createHoliday(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.patch(
    '/api/v1/holidays/:holidayId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Update a holiday',
        tags: ['Holidays'],
        params: z.object({ holidayId: z.string().uuid() }),
        body: updateHolidaySchema,
        response: {
          200: holidaySchema,
        },
      },
    },
    async (request, reply) => {
      const { holidayId } = request.params as { holidayId: string };
      const result = await updateHoliday(
        fastify,
        request.user.organizationId,
        request.user.userId,
        holidayId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.delete(
    '/api/v1/holidays/:holidayId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Delete a holiday',
        tags: ['Holidays'],
        params: z.object({ holidayId: z.string().uuid() }),
        response: {
          200: z.object({ deleted: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const { holidayId } = request.params as { holidayId: string };
      const result = await deleteHoliday(
        fastify,
        request.user.organizationId,
        request.user.userId,
        holidayId
      );
      return reply.send(result);
    }
  );
}
