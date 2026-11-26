import { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { enrollMultiPoseSchema, clockInFaceSchema, biometricsStatusQuerySchema } from './schemas.js';
import { getMultiPoseEnrollmentStatus, matchLiveFaceVector, saveMultiPoseEnrollment } from './service.js';

/**
 * Multi-Pose Face Biometrics Routes Plugin.
 * Purpose: Provides REST API endpoints for querying face enrollment status, enrolling 5-pose face embedding templates,
 * and performing 1:N / 1:1 live face embedding verification. Delegates business logic to biometrics service.
 */
export const biometricsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * Purpose: Retrieves biometrics multi-pose face enrollment status for an employee.
   * Service Delegation: Calls `getMultiPoseEnrollmentStatus()` to check if enrolled poses (CENTER, LEFT, RIGHT, UP, DOWN) exist.
   * Permissions: Authenticated users.
   */
  app.get(
    '/api/v1/biometrics/status',
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: biometricsStatusQuerySchema,
      },
    },
    async (request: any, reply: any) => {
      const result = await getMultiPoseEnrollmentStatus(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.query?.employeeProfileId
      );
      return reply.status(200).send(result);
    }
  );

  /**
   * Purpose: Enrolls 5 multi-pose numerical face embedding vectors for an employee.
   * Service Delegation: Calls `saveMultiPoseEnrollment()` to validate 128-d vectors and store encrypted embeddings in `multi_pose_face_templates`.
   * Permissions: Authenticated OWNER role only.
   */
  app.post(
    '/api/v1/biometrics/enroll',
    {
      preHandler: [
        fastify.authenticate,
        fastify.authorizeRoles('OWNER'),
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

  /**
   * Purpose: Verifies a live captured face embedding vector against enrolled templates for clock-in.
   * Service Delegation: Calls `matchLiveFaceVector()` to compute cosine similarity against stored pose embeddings.
   * Permissions: Authenticated users.
   */
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
