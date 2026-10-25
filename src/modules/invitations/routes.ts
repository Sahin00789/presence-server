import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema.js';
import {
  acceptInvitationSchema,
  createInvitationSchema,
  invitationPreviewSchema,
  invitationSchema,
} from './schemas.js';
import {
  acceptMemberOnboarding,
  createMember,
  getMemberPreview,
  listMembers,
  revokeMemberOnboarding,
} from './service.js';

export async function invitationRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/api/v1/invitations',
    {
      preHandler: [
        fastify.authenticate,
        fastify.authorizeRoles('OWNER', 'MANAGER'),
        fastify.rateLimit({ bucket: 'invitations', limit: 10, windowSeconds: 60 }),
      ],
      schema: {
        description: 'Add a Manager or Staff member to the organization',
        tags: ['Onboarding'],
        body: createInvitationSchema,
        response: {
          200: invitationSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createMember(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.user.role,
        request.body
      );
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/invitations',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'List pending user onboarding records for the active organization',
        tags: ['Onboarding'],
        response: {
          200: z.array(invitationSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await listMembers(fastify, request.user.organizationId);
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/invitations/preview',
    {
      schema: {
        description: 'Preview member onboarding details without authenticating',
        tags: ['Onboarding'],
        querystring: z.object({ token: z.string().min(10) }),
        response: {
          200: invitationPreviewSchema,
        },
      },
    },
    async (request, reply) => {
      const { token } = request.query as { token: string };
      const result = await getMemberPreview(fastify, token);
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/invitations/accept',
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimit({ bucket: 'invitations-accept', limit: 10, windowSeconds: 60 }),
      ],
      schema: {
        description: 'Complete member account onboarding',
        tags: ['Onboarding'],
        body: acceptInvitationSchema,
        response: {
          200: z.object({
            organizationId: z.string(),
            role: z.enum(['MANAGER', 'STAFF']),
          }),
        },
      },
    },
    async (request, reply) => {
      const userRecords = await fastify.db
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, request.user.userId))
        .limit(1);

      if (!userRecords[0]) {
        const err: any = new Error('Authenticated user no longer exists');
        err.statusCode = 404;
        err.code = 'USER_NOT_FOUND';
        throw err;
      }

      const result = await acceptMemberOnboarding(
        fastify,
        request.user.userId,
        userRecords[0].email,
        request.body.token
      );
      return reply.send(result);
    }
  );

  server.delete(
    '/api/v1/invitations/:invitationId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Cancel a pending user onboarding record',
        tags: ['Onboarding'],
        params: z.object({ invitationId: z.string().uuid() }),
        response: {
          200: z.object({ revoked: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      const result = await revokeMemberOnboarding(
        fastify,
        request.user.organizationId,
        request.user.userId,
        invitationId
      );
      return reply.send(result);
    }
  );
}
