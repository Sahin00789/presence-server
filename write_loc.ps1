$content = @"
import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { evaluateGeofence, DEFAULT_GEOFENCE_RADIUS_METERS } from '../../shared/utils/geo.js';
import * as schema from '../../db/schema.js';
import { eq } from 'drizzle-orm';

export async function locationRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/api/v1/location/verify',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Verify if coordinates are within premises geofence',
        tags: ['Location'],
        body: z.object({
          premisesId: z.string().uuid(),
          latitude: z.number(),
          longitude: z.number(),
          accuracyMeters: z.number().optional(),
        }),
        response: {
          200: z.object({
            inPremises: z.boolean(),
            result: z.string(),
            distanceMeters: z.number().nullable(),
            radiusMeters: z.number(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { premisesId, latitude, longitude, accuracyMeters } = request.body as any;
      const [premises] = await fastify.db
        .select()
        .from(schema.premises)
        .where(eq(schema.premises.id, premisesId))
        .limit(1);

      if (!premises) {
        return reply.code(404).send({ error: 'PREMISES_NOT_FOUND' });
      }

      const geofence = evaluateGeofence(
        {
          latitude,
          longitude,
          accuracyMeters: accuracyMeters ?? 0,
          isMocked: false,
          capturedAt: new Date(),
        },
        {
          latitude: Number(premises.latitude),
          longitude: Number(premises.longitude),
          radiusMeters: Number(premises.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS),
        }
      );

      return reply.send({
        inPremises: geofence.result === 'IN_PREMISES',
        result: geofence.result,
        distanceMeters: geofence.distanceMeters ?? null,
        radiusMeters: Number(premises.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS),
      });
    }
  );

  server.post(
    '/api/v1/location/checks',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Submit location check',
        tags: ['Location'],
        body: z.object({
          attendanceEventId: z.string().uuid().optional(),
          latitude: z.number(),
          longitude: z.number(),
          accuracyMeters: z.number().optional(),
        }),
        response: {
          200: z.object({
            ok: z.boolean(),
            result: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      return reply.send({ ok: true, result: 'ACCEPTED' });
    }
  );

  server.get(
    '/api/v1/location/active',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get active location session',
        tags: ['Location'],
        response: {
          200: z.object({ active: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      return reply.send({ active: false });
    }
  );

  server.get(
    '/api/v1/location/presence',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get location presence',
        tags: ['Location'],
        querystring: z.object({
          premisesId: z.string().uuid().optional(),
          date: z.string().optional(),
        }),
        response: {
          200: z.array(z.any()),
        },
      },
    },
    async (request, reply) => {
      return reply.send([]);
    }
  );
}
"@
Set-Content -Path "E:\androidprojects\presence\server\src\modules\location\routes.ts" -Value $content -Encoding UTF8
