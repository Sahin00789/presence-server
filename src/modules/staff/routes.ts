import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  assignStaffPremisesSchema,
  inviteStaffSchema,
  salaryStructureSchema,
  staffSchema,
  upsertSalarySchema,
} from './schemas.js';
import {
  getSalaryStructure,
  getStaffList,
  inviteStaff,
  updateStaffPremises,
  upsertSalaryStructure,
} from './service.js';

export async function staffRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // List Staff Roster
  server.get(
    '/api/v1/staff',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get staff directory roster for current organization',
        tags: ['Staff'],
        response: {
          200: z.array(staffSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await getStaffList(fastify, request.user.organizationId);
      return reply.send(result);
    }
  );

  // Onboard / Invite Staff
  server.post(
    '/api/v1/staff/invite',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Onboard a new staff member into the organization roster',
        tags: ['Staff'],
        body: inviteStaffSchema,
        response: {
          200: staffSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await inviteStaff(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body
      );
      return reply.send(result);
    }
  );

  // Assign staff / manager to premises
  server.patch(
    '/api/v1/staff/:staffProfileId/premises',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Assign staff or manager profile to a single premises location',
        tags: ['Staff'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        body: assignStaffPremisesSchema,
        response: {
          200: z.object({ success: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params as { staffProfileId: string };
      await updateStaffPremises(
        fastify,
        request.user.organizationId,
        request.user.userId,
        staffProfileId,
        request.body.premisesId ?? null
      );
      return reply.send({ success: true });
    }
  );

  // Salary history of a staff member
  server.get(
    '/api/v1/staff/:staffProfileId/salary',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Get the effective-dated compensation plans of a staff member',
        tags: ['Staff'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        response: {
          200: z.array(salaryStructureSchema),
        },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params as { staffProfileId: string };
      const result = await getSalaryStructure(
        fastify,
        request.user.organizationId,
        staffProfileId
      );
      return reply.send(result);
    }
  );

  // Create / replace the active compensation plan of a staff member
  server.put(
    '/api/v1/staff/:staffProfileId/salary',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Set the compensation plan of a staff member',
        tags: ['Staff'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        body: upsertSalarySchema,
        response: {
          200: salaryStructureSchema,
        },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params as { staffProfileId: string };
      const result = await upsertSalaryStructure(
        fastify,
        request.user.organizationId,
        request.user.userId,
        staffProfileId,
        request.body
      );
      return reply.send(result);
    }
  );
}
