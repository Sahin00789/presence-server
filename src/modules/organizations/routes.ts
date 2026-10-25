import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createOrganizationSchema,
  memberSchema,
  organizationSchema,
  organizationSummarySchema,
  updateOrganizationSchema,
} from './schemas.js';
import {
  createOrganization,
  deactivateMember,
  getOrganizationSummary,
  listOrganizationMembers,
  updateOrganization,
} from './service.js';

export async function organizationRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/organizations/current',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get the organization bound to the active session',
        tags: ['Organizations'],
        response: {
          200: organizationSummarySchema,
        },
      },
    },
    async (request, reply) => {
      const result = await getOrganizationSummary(fastify, request.user.organizationId);
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/organizations',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        description: 'Create a new organization (Owner only)',
        tags: ['Organizations'],
        body: createOrganizationSchema,
        response: {
          200: organizationSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createOrganization(fastify, request.user.userId, request.body);
      return reply.send(result);
    }
  );

  server.patch(
    '/api/v1/organizations/current',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        description: 'Update the active organization settings',
        tags: ['Organizations'],
        body: updateOrganizationSchema,
        response: {
          200: organizationSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await updateOrganization(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/organizations/current/logo',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        description: 'Upload organization logo (Owner only)',
        tags: ['Organizations'],
        body: z.object({ logo: z.string() }),
        response: {
          200: organizationSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await updateOrganization(
        fastify,
        request.user.organizationId,
        request.user.userId,
        { logo: request.body.logo }
      );
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/organizations/members',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'List all members of the active organization',
        tags: ['Organizations'],
        response: {
          200: z.array(memberSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await listOrganizationMembers(fastify, request.user.organizationId);
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/organizations/members/:userId/deactivate',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Deactivate a member of the organization',
        tags: ['Organizations'],
        params: z.object({ userId: z.string().uuid() }),
        response: {
          200: z.object({ deactivated: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const result = await deactivateMember(
        fastify,
        request.user.organizationId,
        request.user.userId,
        userId
      );
      return reply.send(result);
    }
  );
}
