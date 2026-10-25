import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  activeLocationSessionSchema,
  locationCheckBodySchema,
  locationCheckResponseSchema,
  locationPresenceQuerySchema,
  locationTodayPresenceResponseSchema,
} from './schemas.js';
import { getActiveLocationSession, getTodayLocationPresence, submitLocationCheck } from './service.js';

export async function locationRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/location/active',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get the active location monitoring session of the current staff member',
        tags: ['Location'],
        response: {
          200: activeLocationSessionSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await getActiveLocationSession(
        fastify,
        request.user.userId,
        request.user.organizationId
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/location/checks',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Submit periodic 10-minute active-shift location reading',
        tags: ['Location'],
        body: locationCheckBodySchema,
        response: {
          200: locationCheckResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await submitLocationCheck(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body
      );
      return reply.send(result as any);
    }
  );

  server.get(
    '/api/v1/location/presence',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER', 'STAFF')],
      schema: {
        description: 'Get today staff presence cards and GPS ping records for a premises location',
        tags: ['Location'],
        querystring: locationPresenceQuerySchema,
        response: {
          200: locationTodayPresenceResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { premisesId, date } = request.query as { premisesId?: string; date?: string };
      const result = await getTodayLocationPresence(
        fastify,
        request.user,
        request.user.organizationId,
        premisesId,
        date
      );
      return reply.send(result as any);
    }
  );
}
