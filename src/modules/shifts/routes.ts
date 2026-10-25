import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createHolidaySchema,
  createShiftAssignmentSchema,
  createShiftTemplateSchema,
  holidaySchema,
  scheduleEntrySchema,
  scheduleQuerySchema,
  setWeeklyOffSchema,
  shiftAssignmentSchema,
  shiftTemplateSchema,
  updateShiftAssignmentSchema,
  updateShiftTemplateSchema,
  weeklyOffSchema,
} from './schemas.js';
import {
  buildSchedule,
  createHoliday,
  createShiftAssignment,
  createShiftTemplate,
  deleteHoliday,
  deleteShiftAssignment,
  deleteShiftTemplate,
  getWeeklyOffs,
  listHolidays,
  listShiftAssignments,
  listShiftTemplates,
  resolveTimezone,
  setWeeklyOffs,
  updateShiftAssignment,
  updateShiftTemplate,
} from './service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { addDays, toDateISO } from '../../shared/utils/datetime.js';
import { findStaffProfile } from '../../shared/services/staff.service.js';

async function resolveOwnProfileId(
  fastify: FastifyInstance,
  request: any
): Promise<string> {
  const profile = await findStaffProfile(
    fastify,
    request.user.userId,
    request.user.organizationId
  );
  if (!profile) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }
  return profile.id;
}

export async function shiftRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------------------------------
  // Shift templates
  // ------------------------------------------------------------------

  server.get(
    '/api/v1/shifts/templates',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'List the working shifts of the active organization',
        tags: ['Shifts'],
        response: {
          200: z.array(shiftTemplateSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await listShiftTemplates(fastify, request.user.organizationId);
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/shifts/templates',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Create a reusable working shift',
        tags: ['Shifts'],
        body: createShiftTemplateSchema,
        response: {
          200: shiftTemplateSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createShiftTemplate(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.patch(
    '/api/v1/shifts/templates/:templateId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Update a working shift',
        tags: ['Shifts'],
        params: z.object({ templateId: z.string().uuid() }),
        body: updateShiftTemplateSchema,
        response: {
          200: shiftTemplateSchema,
        },
      },
    },
    async (request, reply) => {
      const { templateId } = request.params as { templateId: string };
      const result = await updateShiftTemplate(
        fastify,
        request.user.organizationId,
        request.user.userId,
        templateId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.delete(
    '/api/v1/shifts/templates/:templateId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Delete an unused working shift',
        tags: ['Shifts'],
        params: z.object({ templateId: z.string().uuid() }),
        response: {
          200: z.object({ deleted: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const { templateId } = request.params as { templateId: string };
      const result = await deleteShiftTemplate(
        fastify,
        request.user.organizationId,
        request.user.userId,
        templateId
      );
      return reply.send(result);
    }
  );

  // ------------------------------------------------------------------
  // Shift assignments
  // ------------------------------------------------------------------

  server.get(
    '/api/v1/shifts/assignments',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'List shift assignments',
        tags: ['Shifts'],
        querystring: z.object({ staffProfileId: z.string().uuid().optional() }),
        response: {
          200: z.array(shiftAssignmentSchema),
        },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.query as { staffProfileId?: string };
      const result = await listShiftAssignments(
        fastify,
        request.user.organizationId,
        staffProfileId
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/shifts/assignments',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Assign a working shift to a staff member for a date range',
        tags: ['Shifts'],
        body: createShiftAssignmentSchema,
        response: {
          200: shiftAssignmentSchema,
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

  server.patch(
    '/api/v1/shifts/assignments/:assignmentId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Update or deactivate a shift assignment without deleting historical attendance',
        tags: ['Shifts'],
        params: z.object({ assignmentId: z.string().uuid() }),
        body: updateShiftAssignmentSchema,
        response: {
          200: shiftAssignmentSchema,
        },
      },
    },
    async (request, reply) => {
      const { assignmentId } = request.params as { assignmentId: string };
      const result = await updateShiftAssignment(
        fastify,
        request.user.organizationId,
        request.user.userId,
        assignmentId,
        request.body
      );
      return reply.send(result as any);
    }
  );

  server.delete(
    '/api/v1/shifts/assignments/:assignmentId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Deactivate a shift assignment without deleting historical attendance',
        tags: ['Shifts'],
        params: z.object({ assignmentId: z.string().uuid() }),
        response: {
          200: z.object({ deleted: z.boolean(), isActive: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const { assignmentId } = request.params as { assignmentId: string };
      const result = await deleteShiftAssignment(
        fastify,
        request.user.organizationId,
        request.user.userId,
        assignmentId
      );
      return reply.send(result);
    }
  );

  // ------------------------------------------------------------------
  // My schedule
  // ------------------------------------------------------------------

  server.get(
    '/api/v1/shifts/my-schedule',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get the day-by-day shift schedule of the authenticated user',
        tags: ['Shifts'],
        querystring: scheduleQuerySchema,
        response: {
          200: z.array(scheduleEntrySchema),
        },
      },
    },
    async (request, reply) => {
      const today = toDateISO(new Date());
      const from = (request.query as { from?: string }).from ?? today;
      const to = (request.query as { to?: string }).to ?? addDays(from, 30);

      const profile = await findStaffProfile(
        fastify,
        request.user.userId,
        request.user.organizationId
      );

      if (!profile) {
        return reply.send([]);
      }

      const timezone = await resolveTimezone(fastify, request.user.organizationId);

      const result = await buildSchedule(
        fastify,
        request.user.organizationId,
        profile.id,
        from,
        to,
        timezone
      );
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/shifts/schedule/:staffProfileId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Get the day-by-day schedule of a staff member',
        tags: ['Shifts'],
        params: z.object({ staffProfileId: z.string().uuid() }),
        querystring: scheduleQuerySchema,
        response: {
          200: z.array(scheduleEntrySchema),
        },
      },
    },
    async (request, reply) => {
      const { staffProfileId } = request.params as { staffProfileId: string };
      const today = toDateISO(new Date());
      const from = (request.query as { from?: string }).from ?? today;
      const to = (request.query as { to?: string }).to ?? addDays(from, 30);
      const timezone = await resolveTimezone(fastify, request.user.organizationId);

      const result = await buildSchedule(
        fastify,
        request.user.organizationId,
        staffProfileId,
        from,
        to,
        timezone
      );
      return reply.send(result);
    }
  );

  // ------------------------------------------------------------------
  // Weekly offs
  // ------------------------------------------------------------------

  server.get(
    '/api/v1/shifts/weekly-offs',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get the weekly off configuration',
        tags: ['Shifts'],
        querystring: z.object({ staffProfileId: z.string().uuid().optional() }),
        response: {
          200: weeklyOffSchema,
        },
      },
    },
    async (request, reply) => {
      const requestedId = (request.query as { staffProfileId?: string }).staffProfileId;
      const profileId = requestedId ?? (await resolveOwnProfileId(fastify, request));
      const daysOfWeek = await getWeeklyOffs(fastify, profileId);
      return reply.send({ staffProfileId: profileId, daysOfWeek });
    }
  );

  server.put(
    '/api/v1/shifts/weekly-offs',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Replace the weekly off configuration of a staff member',
        tags: ['Shifts'],
        body: setWeeklyOffSchema,
        response: {
          200: weeklyOffSchema,
        },
      },
    },
    async (request, reply) => {
      const staffProfileId =
        request.body.staffProfileId ?? (await resolveOwnProfileId(fastify, request));
      const result = await setWeeklyOffs(
        fastify,
        request.user.organizationId,
        request.user.userId,
        staffProfileId,
        request.body.daysOfWeek
      );
      return reply.send(result);
    }
  );

  // ------------------------------------------------------------------
  // Holidays
  // ------------------------------------------------------------------

  server.get(
    '/api/v1/shifts/holidays',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'List organization public holidays',
        tags: ['Shifts'],
        querystring: z.object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
        response: {
          200: z.array(holidaySchema),
        },
      },
    },
    async (request, reply) => {
      const { from, to } = request.query as { from?: string; to?: string };
      const result = await listHolidays(fastify, request.user.organizationId, from, to);
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/shifts/holidays',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Add a public holiday to the organization calendar',
        tags: ['Shifts'],
        body: createHolidaySchema,
        response: {
          200: holidaySchema,
        },
      },
    },
    async (request, reply) => {
      const result = await createHoliday(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.delete(
    '/api/v1/shifts/holidays/:holidayId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Remove a public holiday',
        tags: ['Shifts'],
        params: z.object({ holidayId: z.string().uuid() }),
        response: {
          200: z.object({ deleted: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const { holidayId } = request.params as { holidayId: string };
      const result = await deleteHoliday(
        fastify,
        request.user.organizationId,
        request.user.userId,
        holidayId
      );
      return reply.send(result);
    }
  );
}
