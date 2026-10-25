import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createPremisesSchema, premisesSchema, updatePremisesSchema } from './schemas.js';
import { createPremises, getPremises, updatePremises } from './service.js';

export async function premisesRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // List Premises
  server.get(
    '/api/v1/premises',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get active geofenced premises for the current organization',
        tags: ['Premises'],
        response: {
          200: z.array(premisesSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await getPremises(fastify, request.user.organizationId);
      return reply.send(result);
    }
  );

  // Create Premises
  server.post(
    '/api/v1/premises',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        description: 'Create a new geofenced premises location',
        tags: ['Premises'],
        body: createPremisesSchema,
        response: {
          200: premisesSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createPremises(
        fastify,
        request.user.organizationId,
        request.body
      );
      return reply.send(result);
    }
  );

  // Update Premises
  server.put(
    '/api/v1/premises/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        description: 'Update an existing geofenced premises location',
        tags: ['Premises'],
        params: z.object({ id: z.string().uuid() }),
        body: updatePremisesSchema,
        response: {
          200: premisesSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await updatePremises(
        fastify,
        request.user.organizationId,
        request.params.id,
        request.body
      );
      return reply.send(result);
    }
  );
}
