import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createEmployeeSchema,
  employeeDtoSchema,
  updateEmployeeSchema,
} from './schemas.js';
import {
  createEmployee,
  getEmployeeById,
  getSelfEmployeeProfile,
  listEmployees,
  revokeEmployee,
  updateEmployee,
} from './service.js';

export async function employeeRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // 1. Create Employee (OWNER only)
  server.post(
    '/api/v1/employees',
    {
      preHandler: [
        fastify.authenticate,
        fastify.authorizeRoles('OWNER'),
        fastify.rateLimit({ bucket: 'employees', limit: 10, windowSeconds: 60 }),
      ],
      schema: {
        description: 'Add an Employee to the organization',
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

  // 2. List Employees (OWNER or EMPLOYEE)
  server.get(
    '/api/v1/employees',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'EMPLOYEE')],
      schema: {
        description: 'List provisioned employees for the active organization',
        tags: ['Employees'],
        querystring: z.object({
          premisesId: z.string().uuid().optional(),
          search: z.string().optional(),
        }),
        response: {
          200: z.array(employeeDtoSchema),
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { premisesId?: string; search?: string };
      const result = await listEmployees(fastify, request.user.organizationId, query);
      return reply.send(result);
    }
  );

  // 3. Get Self Employee Profile (EMPLOYEE or OWNER)
  server.get(
    '/api/v1/employees/me',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'EMPLOYEE')],
      schema: {
        description: 'Get current user employee profile details',
        tags: ['Employees'],
        response: {
          200: employeeDtoSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await getSelfEmployeeProfile(
        fastify,
        request.user.organizationId,
        request.user.userId
      );
      return reply.send(result);
    }
  );

  // 4. Get Employee By ID (OWNER or EMPLOYEE)
  server.get(
    '/api/v1/employees/:employeeId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'EMPLOYEE')],
      schema: {
        description: 'Get single employee record by ID',
        tags: ['Employees'],
        params: z.object({ employeeId: z.string().uuid() }),
        response: {
          200: employeeDtoSchema,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { employeeId: string };
      const result = await getEmployeeById(
        fastify,
        request.user.organizationId,
        params.employeeId,
        request.user.userId,
        request.user.role
      );
      return reply.send(result);
    }
  );

  // 5. Update Employee Details and Avatar
  server.patch(
    '/api/v1/employees/:employeeId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'EMPLOYEE')],
      schema: {
        description: 'Update employee details and avatar',
        tags: ['Employees'],
        params: z.object({ employeeId: z.string().uuid() }),
        body: updateEmployeeSchema,
        response: {
          200: employeeDtoSchema,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { employeeId: string };
      const result = await updateEmployee(
        fastify,
        request.user.organizationId,
        params.employeeId,
        request.user.userId,
        request.user.role,
        request.body
      );
      return reply.send(result);
    }
  );

  // 6. Revoke / Deactivate Employee (OWNER only)
  server.delete(
    '/api/v1/employees/:employeeId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
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
