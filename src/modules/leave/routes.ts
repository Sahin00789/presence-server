import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createLeaveRequestSchema,
  leaveRequestSchema,
  leaveRequestsQuerySchema,
  reviewLeaveRequestSchema,
  upcomingShiftSchema,
} from './schemas.js';
import {
  cancelLeaveRequest,
  createLeaveRequest,
  getLeaveRequestDetails,
  listLeaveRequests,
  listUpcomingShiftsForLeave,
  reviewLeaveRequest,
} from './service.js';

export async function leaveRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/leave/upcoming-shifts',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get upcoming shift assignments for the authenticated employee with dates to request leave',
        tags: ['Leave'],
        querystring: z.object({
          days: z.coerce.number().int().min(1).max(60).optional().default(14),
        }),
        response: { 200: z.array(upcomingShiftSchema) },
      },
    },
    async (request, reply) => {
      const { days } = request.query as { days: number };
      const result = await listUpcomingShiftsForLeave(
        fastify,
        request.user,
        request.user.organizationId,
        days
      );
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/leave',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description:
          'List leave requests. Employees see their own requests; Owners see all organization requests.',
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
        description: 'Submit leave request(s) for scheduled upcoming shift dates',
        tags: ['Leave'],
        body: createLeaveRequestSchema,
        response: { 200: z.array(leaveRequestSchema) },
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
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
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
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
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
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
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
