import { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { enrollMultiPoseSchema, clockInFaceSchema } from './schemas.js';
import { getMultiPoseEnrollmentStatus, matchLiveFaceVector, saveMultiPoseEnrollment } from './service.js';

/**
 * Multi-pose face biometrics routes.
 */
export const biometricsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/api/v1/biometrics/status',
    {
      preHandler: [fastify.authenticate],
    },
    async (request: any, reply: any) => {
      const result = await getMultiPoseEnrollmentStatus(
        fastify,
        request.user.organizationId,
        request.user.userId
      );
      return reply.status(200).send(result);
    }
  );

  app.post(
    '/api/v1/biometrics/enroll',
    {
      preHandler: [
        fastify.authenticate,
        fastify.authorizeRoles('OWNER', 'MANAGER'),
        fastify.rateLimit({
          limit: 10,
          windowSeconds: 60,
          bucket: 'multi-pose-enroll',
        }),
      ],
      schema: {
        body: enrollMultiPoseSchema,
      },
    },
    async (request: any, reply: any) => {
      const result = await saveMultiPoseEnrollment(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body
      );
      return reply.status(200).send(result);
    }
  );

  app.post(
    '/api/v1/biometrics/verify',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: clockInFaceSchema,
      },
    },
    async (request: any, reply: any) => {
      const result = await matchLiveFaceVector(fastify, request.user.organizationId, request.body);
      return reply.status(200).send(result);
    }
  );
};
