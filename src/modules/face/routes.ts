import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  faceStatusSchema,
  faceVerificationSchema,
  supervisedEnrollFaceSchema,
  verifyFaceSchema,
} from './schemas.js';
import {
  enrollFaceSupervised,
  getFaceStatus,
  getStaffFaceStatus,
  revokeFaceEnrollment,
  verifyFace,
} from './service.js';

export async function faceRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/face/status',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description:
          'Read the face-enrolment status of the authenticated employee. Staff cannot enrol themselves.',
        tags: ['Face'],
        response: { 200: faceStatusSchema },
      },
    },
    async (request, reply) => {
      const result = await getFaceStatus(
        fastify,
        request.user.userId,
        request.user.organizationId
      );
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/face/staff/:staffProfileId/status',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Read the face-enrolment status of a staff member',
        tags: ['Face'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        response: { 200: faceStatusSchema },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params as { staffProfileId: string };
      const result = await getStaffFaceStatus(
        fastify,
        request.user.organizationId,
        staffProfileId
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/face/enroll/supervised',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description:
          'Supervised face enrolment. The Owner or Manager captures the embedding with the employee physically present; staff cannot self-enrol.',
        tags: ['Face'],
        body: supervisedEnrollFaceSchema,
        response: { 200: faceStatusSchema },
      },
    },
    async (request, reply) => {
      const result = await enrollFaceSupervised(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/face/verify',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Compare a candidate embedding against the enrolled template',
        tags: ['Face'],
        body: verifyFaceSchema,
        response: { 200: faceVerificationSchema },
      },
    },
    async (request, reply) => {
      const result = await verifyFace(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body.embeddingVector
      );
      return reply.send(result);
    }
  );

  server.delete(
    '/api/v1/face/enrollment/:staffProfileId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description:
          'Revoke a staff face template so the employee must be re-enrolled under supervision.',
        tags: ['Face'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        response: {
          200: z.object({ revoked: z.boolean(), staffProfileId: z.string().uuid() }),
        },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params as { staffProfileId: string };
      const result = await revokeFaceEnrollment(
        fastify,
        request.user.userId,
        request.user.organizationId,
        staffProfileId
      );
      return reply.send(result);
    }
  );
}
