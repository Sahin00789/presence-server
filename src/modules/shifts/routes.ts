import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createEmployeeShiftAssignmentSchema,
  createShiftSchema,
  employeeShiftAssignmentSchema,
  shiftSchema,
  updateEmployeeShiftAssignmentSchema,
  updateShiftSchema,
} from './schemas.js';
import {
  createShift,
  createShiftAssignment,
  deleteShift,
  deleteShiftAssignment,
  getWeeklyOffs,
  listShiftAssignments,
  listShifts,
  setWeeklyOffs,
  updateShift,
  updateShiftAssignment,
} from './service.js';

export async function shiftRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // 1. List Shift Templates
  server.get(
    '/api/v1/shifts',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'List active shift templates/definitions for the current organization',
        tags: ['Shifts'],
        querystring: z.object({
          premisesId: z.string().optional(),
        }),
        response: {
          200: z.array(shiftSchema),
        },
      },
    },
    async (request, reply) => {
      const { premisesId } = request.query as { premisesId?: string };
      const result = await listShifts(
        fastify,
        request.user.organizationId,
        premisesId
      );
      return reply.send(result);
    }
  );

  // 2. Create Shift Template
  server.post(
    '/api/v1/shifts',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Create a new shift template',
        tags: ['Shifts'],
        body: createShiftSchema,
        response: {
          200: shiftSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createShift(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body
      );
      return reply.send(result);
    }
  );

  // 3. Update Shift Template (PUT)
  server.put(
    '/api/v1/shifts/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Update an existing shift template',
        tags: ['Shifts'],
        params: z.object({ id: z.string().uuid() }),
        body: updateShiftSchema,
        response: {
          200: shiftSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await updateShift(
        fastify,
        request.user.organizationId,
        request.user.userId,
        id,
        request.body
      );
      return reply.send(result);
    }
  );

  // 4. Update Shift Template (PATCH)
  server.patch(
    '/api/v1/shifts/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Partially update an existing shift template',
        tags: ['Shifts'],
        params: z.object({ id: z.string().uuid() }),
        body: updateShiftSchema,
        response: {
          200: shiftSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await updateShift(
        fastify,
        request.user.organizationId,
        request.user.userId,
        id,
        request.body
      );
      return reply.send(result);
    }
  );

  // 5. Delete Shift Template
  server.delete(
    '/api/v1/shifts/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Delete a shift template',
        tags: ['Shifts'],
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ deleted: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await deleteShift(
        fastify,
        request.user.organizationId,
        request.user.userId,
        id
      );
      return reply.send(result);
    }
  );

  // 6. List Shift Assignments
  server.get(
    '/api/v1/shifts/assignments',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'List employee shift assignments',
        tags: ['Shifts'],
        querystring: z.object({
          premisesId: z.string().optional(),
          staffId: z.string().optional(),
          employeeId: z.string().optional(),
        }),
        response: {
          200: z.array(employeeShiftAssignmentSchema),
        },
      },
    },
    async (request, reply) => {
      const { premisesId, staffId, employeeId } = request.query as {
        premisesId?: string;
        staffId?: string;
        employeeId?: string;
      };
      const result = await listShiftAssignments(
        fastify,
        request.user.organizationId,
        premisesId,
        staffId || employeeId
      );
      return reply.send(result);
    }
  );

  // 7. Create Shift Assignment
  server.post(
    '/api/v1/shifts/assignments',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Assign a shift to an employee',
        tags: ['Shifts'],
        body: createEmployeeShiftAssignmentSchema,
        response: {
          200: employeeShiftAssignmentSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createShiftAssignment(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body
      );
      return reply.send(result);
    }
  );

  // 8. Update Shift Assignment (PUT)
  server.put(
    '/api/v1/shifts/assignments/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Update a shift assignment',
        tags: ['Shifts'],
        params: z.object({ id: z.string().uuid() }),
        body: updateEmployeeShiftAssignmentSchema,
        response: {
          200: employeeShiftAssignmentSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await updateShiftAssignment(
        fastify,
        request.user.organizationId,
        request.user.userId,
        id,
        request.body
      );
      return reply.send(result);
    }
  );

  // 9. Update Shift Assignment (PATCH)
  server.patch(
    '/api/v1/shifts/assignments/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Partially update a shift assignment',
        tags: ['Shifts'],
        params: z.object({ id: z.string().uuid() }),
        body: updateEmployeeShiftAssignmentSchema,
        response: {
          200: employeeShiftAssignmentSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await updateShiftAssignment(
        fastify,
        request.user.organizationId,
        request.user.userId,
        id,
        request.body
      );
      return reply.send(result);
    }
  );

  // 10. Delete Shift Assignment
  server.delete(
    '/api/v1/shifts/assignments/:id',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Delete a shift assignment',
        tags: ['Shifts'],
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ deleted: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await deleteShiftAssignment(
        fastify,
        request.user.organizationId,
        request.user.userId,
        id
      );
      return reply.send(result);
    }
  );

  // 11. Get Weekly Offs
  server.get(
    '/api/v1/shifts/weekly-offs/:staffProfileId',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get weekly off days for a staff profile',
        tags: ['Shifts'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        response: {
          200: z.array(z.number()),
        },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params as { staffProfileId: string };
      const result = await getWeeklyOffs(
        fastify,
        request.user.organizationId,
        staffProfileId
      );
      return reply.send(result);
    }
  );

  // 12. Set Weekly Offs
  server.put(
    '/api/v1/shifts/weekly-offs/:staffProfileId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Set weekly off days for a staff profile',
        tags: ['Shifts'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        body: z.object({
          daysOfWeek: z.array(z.number().int().min(0).max(6)),
        }),
        response: {
          200: z.object({
            staffProfileId: z.string(),
            daysOfWeek: z.array(z.number()),
          }),
        },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params as { staffProfileId: string };
      const { daysOfWeek } = request.body as { daysOfWeek: number[] };
      const result = await setWeeklyOffs(
        fastify,
        request.user.organizationId,
        request.user.userId,
        staffProfileId,
        daysOfWeek
      );
      return reply.send(result);
    }
  );
}
