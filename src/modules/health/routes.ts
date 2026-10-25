import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ZodTypeProvider } from 'fastify-type-provider-zod';

const healthResponseSchema = z.object({
  status: z.string(),
  timestamp: z.string(),
  uptimeSeconds: z.number(),
  database: z.string(),
});

export async function healthRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // Liveness check
  server.get('/health/live', {
    schema: {
      description: 'Liveness check probe',
      tags: ['Health'],
      response: {
        200: z.object({ status: z.literal('OK') }),
      },
    },
  }, async () => {
    return { status: 'OK' as const };
  });

  // Readiness check
  server.get('/health/ready', {
    schema: {
      description: 'Readiness check probe verifying PostgreSQL database connection',
      tags: ['Health'],
      response: {
        200: healthResponseSchema,
        503: healthResponseSchema,
      },
    },
  }, async (request, reply) => {
    let dbStatus = 'DOWN';

    try {
      await fastify.pgClient`SELECT 1`;
      dbStatus = 'UP';
    } catch (err) {
      fastify.log.error({ err }, 'Health check: DB ping failed');
    }

    const isHealthy = dbStatus === 'UP';
    const payload = {
      status: isHealthy ? 'HEALTHY' : 'UNHEALTHY',
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      database: dbStatus,
    };

    if (!isHealthy) {
      return reply.status(503).send(payload);
    }

    return payload;
  });
}
