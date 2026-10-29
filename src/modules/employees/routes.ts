import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createEmployeeSchema,
  employeeDtoSchema,
} from './schemas.js';
import {
  createEmployee,
  listEmployees,
  revokeEmployee,
} from './service.js';

export async function employeeRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/api/v1/employees',
    {
      preHandler: [
        fastify.authenticate,
        fastify.authorizeRoles('OWNER', 'MANAGER'),
        fastify.rateLimit({ bucket: 'employees', limit: 10, windowSeconds: 60 }),
      ],
      schema: {
        description: 'Add a Manager or Staff member to the organization',
        tags: ['Employees'],
        body: createEmployeeSchema,
        response: {
          200: employeeDtoSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createEmployee(
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
    '/api/v1/employees',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'List provisioned employees for the active organization',
        tags: ['Employees'],
        response: {
          200: z.array(employeeDtoSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await listEmployees(fastify, request.user.organizationId);
      return reply.send(result);
    }
  );

  server.delete(
    '/api/v1/employees/:employeeId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Deactivate an employee',
        tags: ['Employees'],
        params: z.object({ employeeId: z.string().uuid() }),
        response: {
          200: z.object({ revoked: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { employeeId: string };
      const result = await revokeEmployee(
        fastify,
        request.user.organizationId,
        request.user.userId,
        params.employeeId
      );
      return reply.send(result);
    }
  );
}
