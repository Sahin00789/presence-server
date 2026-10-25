import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  attendanceEventSchema,
  attendanceRecordSchema,
  attendanceRecordsQuerySchema,
  clockInSchema,
  clockOutSchema,
  correctDailyAttendanceSchema,
  dailyAttendanceSchema,
  manualClockInSchema,
  exceptionSchema,
  resolveExceptionSchema,
} from './schemas.js';
import {
  clockIn,
  clockOut,
  correctDailyAttendance,
  getDailyAttendanceByDateAndPremises,
  getEmployeeAttendanceAndEarningsHistory,
  listAttendanceRecords,
  listExceptions,
  requestManualClockIn,
  resolveException,
  toPublicAttendanceEvent,
} from './service.js';
import { z } from 'zod';

export async function attendanceRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/api/v1/attendance/clock-in',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Clock in with location and face verification',
        tags: ['Attendance'],
        body: clockInSchema,
        response: {
          200: attendanceEventSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await clockIn(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body
      );
      return reply.send(toPublicAttendanceEvent(result));
    }
  );

  server.post(
    '/api/v1/attendance/clock-in/manual',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description:
          'Request a manual clock-in when on-device face verification is unavailable. Always requires Manager or Owner review.',
        tags: ['Attendance'],
        body: manualClockInSchema,
        response: {
          200: z.object({
            event: attendanceEventSchema,
            exceptionId: z.string().uuid(),
            status: z.literal('PENDING_REVIEW'),
          }),
        },
      },
    },
    async (request, reply) => {
      const result = await requestManualClockIn(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/attendance/clock-out',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Clock out of the active attendance event',
        tags: ['Attendance'],
        body: clockOutSchema,
        response: {
          200: attendanceEventSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await clockOut(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body
      );
      return reply.send(toPublicAttendanceEvent(result));
    }
  );

  server.get(
    '/api/v1/attendance/records',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description:
          'List attendance events. Staff receive their own records, Owners and Managers receive the whole organization.',
        tags: ['Attendance'],
        querystring: attendanceRecordsQuerySchema,
        response: {
          200: z.array(attendanceRecordSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await listAttendanceRecords(
        fastify,
        request.user,
        request.user.organizationId,
        request.query as { from?: string; to?: string; staffProfileId?: string; limit?: number; offset?: number }
      );
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/attendance/exceptions',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description:
          'List attendance and GPS exceptions. Staff receive their own, Owners and Managers receive the whole organization.',
        tags: ['Attendance'],
        response: {
          200: z.array(exceptionSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await listExceptions(fastify, request.user, request.user.organizationId);
      return reply.send(result);
    }
  );

  server.post(
    '/api/v1/attendance/exceptions/:exceptionId/resolve',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Resolve an attendance exception with an approved correction',
        tags: ['Attendance'],
        params: z.object({ exceptionId: z.string().uuid() }),
        body: resolveExceptionSchema,
        response: {
          200: z.object({
            id: z.string().uuid(),
            status: z.literal('RESOLVED'),
            correctedStatus: z.enum(['PRESENT', 'ABSENT', 'HALF_DAY', 'LATE', 'HOLIDAY', 'RESUME']),
          }),
        },
      },
    },
    async (request, reply) => {
      const { exceptionId } = request.params as { exceptionId: string };
      const result = await resolveException(
        fastify,
        request.user.organizationId,
        request.user.userId,
        exceptionId,
        request.body
      );
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/attendance/daily',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Retrieve daily attendance records by date and optional premises',
        tags: ['Attendance'],
        querystring: z.object({
          workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          premisesId: z.string().uuid().optional(),
        }),
        response: {
          200: z.array(dailyAttendanceSchema),
        },
      },
    },
    async (request, reply) => {
      const { workDate, premisesId } = request.query as { workDate: string; premisesId?: string };
      const result = await getDailyAttendanceByDateAndPremises(
        fastify,
        request.user.organizationId,
        workDate,
        premisesId
      );
      return reply.send(result as any);
    }
  );

  server.post(
    '/api/v1/attendance/daily/:id/correct',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Allow authorised managers to correct daily attendance status and payment',
        tags: ['Attendance'],
        params: z.object({ id: z.string().uuid() }),
        body: correctDailyAttendanceSchema,
        response: {
          200: z.object({
            id: z.string().uuid(),
            attendanceStatus: z.enum(['PRESENT', 'ABSENT', 'LEAVE', 'HALF_DAY']),
            paymentAmount: z.string().or(z.number()),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await correctDailyAttendance(
        fastify,
        request.user.userId,
        request.user.organizationId,
        id,
        request.body
      );
      return reply.send(result as any);
    }
  );

  server.get(
    '/api/v1/attendance/my-history',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Retrieve employee daily attendance and earnings history',
        tags: ['Attendance'],
        querystring: z.object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { from, to } = request.query as { from?: string; to?: string };
      const result = await getEmployeeAttendanceAndEarningsHistory(
        fastify,
        request.user.organizationId,
        request.user.userId,
        from,
        to
      );
      return reply.send(result as any);
    }
  );
}
