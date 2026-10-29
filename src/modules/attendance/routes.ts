import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  attendanceEventSchema,
  attendanceRecordSchema,
  attendanceRecordsQuerySchema,
  clockInSchema,
  correctDailyAttendanceSchema,
  dailyAttendanceSchema,
} from './schemas.js';
import {
  clockIn,
  getDailyAttendanceByDateAndPremises,
  getEmployeeAttendanceAndEarningsHistory,
  getUpcomingAttendance,
  listAttendanceRecords,
  manualMarkAttendance,
  toPublicAttendanceEvent,
} from './service.js';
import { z } from 'zod';

export async function attendanceRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/api/v1/attendance/clock-in',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('MANAGER', 'STAFF')],
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
    '/api/v1/attendance/manual-mark',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Manual mark attendance for shift/overtime (ABSENT/HALF_DAY/LEAVE or delete overtime). Available after clock-in and before shift/overtime ends.',
        tags: ['Attendance'],
        body: z.object({
          attendanceEventId: z.string().uuid().optional(),
          employeeId: z.string().uuid().optional(),
          workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          overtimeId: z.string().uuid().optional(),
          action: z.enum(['ABSENT', 'HALF_DAY', 'LEAVE', 'DELETE_OVERTIME']),
          reason: z.string().min(3).max(500).optional(),
        }),
        response: {
          200: attendanceEventSchema.or(z.object({ deleted: z.boolean(), overtimeId: z.string().uuid() })),
        },
      },
    },
    async (request, reply) => {
      const result = await manualMarkAttendance(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body as any
      );
      return reply.send(result as any);
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



  server.get(
    '/api/v1/attendance/my-history',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('MANAGER', 'STAFF')],
      schema: {
        description: 'Retrieve employee daily attendance and earnings history',
        tags: ['Attendance'],
        querystring: z.object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
          year: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { from, to, month, year } = request.query as { from?: string; to?: string; month?: string; year?: number };
      let f = from;
      let t = to;
      if (month && !f && !t) {
        const [y, m] = month.split('-').map((v) => parseInt(v));
        f = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
        const last = new Date(y, m, 0).getDate();
        t = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
      } else if (year && !month && !f && !t) {
        f = `${year}-01-01`;
        t = `${year}-12-31`;
      }
      const result = await getEmployeeAttendanceAndEarningsHistory(
        fastify,
        request.user.organizationId,
        request.user.userId,
        f,
        t
      );
      return reply.send(result as any);
    }
  );

  server.get(
    '/api/v1/attendance/upcoming',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('MANAGER', 'STAFF')],
      schema: {
        description: 'Fetch upcoming shift or overtime for the authenticated user',
        tags: ['Attendance'],
        querystring: z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { date } = request.query as { date?: string };
      const result = await getUpcomingAttendance(fastify, request.user.organizationId, request.user.userId, date);
      return reply.send(result as any);
    }
  );
}
