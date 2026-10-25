import { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { enrollMultiPoseSchema, clockInFaceSchema } from './schemas.js';
import { saveMultiPoseEnrollment, matchLiveFaceVector } from './service.js';

/**
 * Multi-pose face routes.
 *
 * `/api/v1/face/enroll` and `/api/v1/face/clock-in` are the canonical paths used
 * by the Android client. The `/api/v1/biometrics/*` paths are kept for the
 * original integration contract, and the versionless aliases exist for kiosk
 * deployments that call `/enroll` and `/clock-in` directly.
 *
 * Enrollment is strictly supervised: only an Owner or Manager can create or
 * replace the five pose vectors. Clock-in accepts any authenticated employee,
 * but every query is scoped to the caller's organization.
 */
export const biometricsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const enrollHandler = async (request: any, reply: any) => {
    const result = await saveMultiPoseEnrollment(
      fastify,
      request.user.userId,
      request.user.organizationId,
      request.body
    );
    return reply.status(200).send(result);
  };

  const clockInHandler = async (request: any, reply: any) => {
    const result = await matchLiveFaceVector(
      fastify,
      request.user.organizationId,
      request.body
    );
    return reply.status(200).send(result);
  };

  for (const path of [
    '/api/v1/face/enroll',
    '/api/v1/biometrics/enroll',
    '/enroll',
  ]) {
    app.post(
      path,
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
          description:
            'Supervised enrolment of five pose-specific 128-D face vectors (centre, left, right, up, down).',
          tags: ['Biometrics'],
          body: enrollMultiPoseSchema,
        },
      },
      enrollHandler
    );
  }

  for (const path of [
    '/api/v1/face/clock-in',
    '/api/v1/biometrics/clock-in',
    '/clock-in',
  ]) {
    app.post(
      path,
      {
        preHandler: [
          fastify.authenticate,
          fastify.rateLimit({
            limit: 30,
            windowSeconds: 60,
            bucket: 'multi-pose-clock-in',
          }),
        ],
        schema: {
          description:
            'Identify an employee from a single live 128-D vector using pgvector cosine distance across all five enrolled poses.',
          tags: ['Biometrics'],
          body: clockInFaceSchema,
        },
      },
      clockInHandler
    );
  }
};
