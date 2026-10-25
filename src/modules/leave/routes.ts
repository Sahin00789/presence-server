import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createLeaveRequestSchema,
  leaveRequestSchema,
  leaveRequestsQuerySchema,
  reviewLeaveRequestSchema,
} from './schemas.js';
import {
  cancelLeaveRequest,
  createLeaveRequest,
  getLeaveRequestDetails,
  listLeaveRequests,
  reviewLeaveRequest,
} from './service.js';

export async function leaveRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/leave',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description:
          'List leave requests. Staff see their own requests; Owners and Managers see permitted requests.',
        tags: ['Leave'],
        querystring: leaveRequestsQuerySchema,
        response: { 200: z.array(leaveRequestSchema) },
      },
    },
    async (request, reply) => {
      const result = await listLeaveRequests(
        fastify,
        request.user,
        request.user.organizationId,
        request.query as any
      );
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/leave/:leaveRequestId',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get details of a specific leave request',
        tags: ['Leave'],
        params: z.object({ leaveRequestId: z.string().uuid() }),
        response: { 200: leaveRequestSchema },
      },
    },
    async (request, reply) => {
      const { leaveRequestId } = request.params as { leaveRequestId: string };
      const result = await getLeaveRequestDetails(
        fastify,
        request.user,
        request.user.organizationId,
        leaveRequestId
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/leave',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Submit a single-shift leave request for a scheduled work date',
        tags: ['Leave'],
        body: createLeaveRequestSchema,
        response: { 200: leaveRequestSchema },
      },
    },
    async (request, reply) => {
      const result = await createLeaveRequest(
        fastify,
        request.user,
        request.user.organizationId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/leave/:leaveRequestId/approve',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Approve a pending leave request',
        tags: ['Leave'],
        params: z.object({ leaveRequestId: z.string().uuid() }),
        body: z.object({
          reviewRemarks: z.string().trim().max(1000).optional(),
          note: z.string().trim().max(1000).optional(),
        }).optional().default({}),
        response: { 200: leaveRequestSchema },
      },
    },
    async (request, reply) => {
      const { leaveRequestId } = request.params as { leaveRequestId: string };
      const body = request.body || {};
      const result = await reviewLeaveRequest(
        fastify,
        request.user.userId,
        request.user.organizationId,
        leaveRequestId,
        { decision: 'APPROVED', reviewRemarks: body.reviewRemarks ?? body.note }
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/leave/:leaveRequestId/reject',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Reject a pending leave request',
        tags: ['Leave'],
        params: z.object({ leaveRequestId: z.string().uuid() }),
        body: z.object({
          reviewRemarks: z.string().trim().max(1000).optional(),
          note: z.string().trim().max(1000).optional(),
        }).optional().default({}),
        response: { 200: leaveRequestSchema },
      },
    },
    async (request, reply) => {
      const { leaveRequestId } = request.params as { leaveRequestId: string };
      const body = request.body || {};
      const result = await reviewLeaveRequest(
        fastify,
        request.user.userId,
        request.user.organizationId,
        leaveRequestId,
        { decision: 'REJECTED', reviewRemarks: body.reviewRemarks ?? body.note }
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/leave/:leaveRequestId/review',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Approve or reject a pending leave request',
        tags: ['Leave'],
        params: z.object({ leaveRequestId: z.string().uuid() }),
        body: reviewLeaveRequestSchema,
        response: { 200: leaveRequestSchema },
      },
    },
    async (request, reply) => {
      const { leaveRequestId } = request.params as { leaveRequestId: string };
      const result = await reviewLeaveRequest(
        fastify,
        request.user.userId,
        request.user.organizationId,
        leaveRequestId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.delete(
    '/api/v1/leave/:leaveRequestId',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Cancel a pending leave request submitted by the authenticated employee',
        tags: ['Leave'],
        params: z.object({ leaveRequestId: z.string().uuid() }),
        response: { 200: z.object({ id: z.string().uuid(), status: z.literal('CANCELLED') }) },
      },
    },
    async (request, reply) => {
      const { leaveRequestId } = request.params as { leaveRequestId: string };
      const result = await cancelLeaveRequest(
        fastify,
        request.user.userId,
        request.user.organizationId,
        leaveRequestId
      );
      return reply.send(result);
    }
  );
}
