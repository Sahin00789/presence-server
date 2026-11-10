import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  attendanceEventSchema,
  attendanceRecordSchema,
  attendanceRecordsQuerySchema,
  clockInSchema,
  dailyAttendanceSchema,
  locationCheckResponseSchema,
  manualMarkOvertimeSchema,
  manualMarkShiftSchema,
  overtimeLocationPingSchema,
  shiftLocationPingSchema,
} from './schemas.js';
import {
  clockInOvertime,
  clockInShift,
  correctOvertimeAttendance,
  correctShiftAttendance,
  getDailyAttendanceByDateAndPremises,
  getEmployeeAttendanceAndEarningsHistory,
  getNextUpcomingAttendance,
  getUpcomingAttendance,
  listAttendanceRecords,
  submitOvertimeLocationCheck,
  submitShiftLocationCheck,
  toPublicAttendanceEvent,
} from './service.js';
import { z } from 'zod';

export async function attendanceRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  // Shift Clock-In Route
  server.post(
    '/api/v1/attendance/shift/clock-in',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
      schema: {
        description: 'Clock in for assigned shift with location and face verification',
        tags: ['Attendance'],
        body: clockInSchema,
        response: {
          200: attendanceEventSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await clockInShift(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body
      );
      return reply.send(toPublicAttendanceEvent(result));
    }
  );

  // Overtime Clock-In Route
  server.post(
    '/api/v1/attendance/overtime/clock-in',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
      schema: {
        description: 'Clock in for scheduled overtime with location and face verification',
        tags: ['Attendance'],
        body: clockInSchema,
        response: {
          200: attendanceEventSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await clockInOvertime(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body
      );
      return reply.send(toPublicAttendanceEvent(result));
    }
  );

  const handleShiftCorrection = async (request: any, reply: any) => {
    const result = await correctShiftAttendance(
      fastify,
      request.user.organizationId,
      request.user.userId,
      request.body as any
    );
    return reply.send(result as any);
  };

  const handleOvertimeCorrection = async (request: any, reply: any) => {
    const result = await correctOvertimeAttendance(
      fastify,
      request.user.organizationId,
      request.user.userId,
      request.body as any
    );
    return reply.send(result as any);
  };

  // 1. Shift Attendance Manual Mark
  server.post(
    '/api/v1/attendance/shift/manual-mark',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: { body: manualMarkShiftSchema },
    },
    handleShiftCorrection
  );

  // 2. Overtime Attendance Manual Mark
  server.post(
    '/api/v1/attendance/overtime/manual-mark',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: { body: manualMarkOvertimeSchema },
    },
    handleOvertimeCorrection
  );

  server.get(
    '/api/v1/attendance/records',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description:
          'List attendance events. Employees receive their own records, Owners receive the whole organization.',
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
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
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
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
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
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
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

  server.get(
    '/api/v1/attendance/next-upcoming',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
    },
    async (request, reply) => {
      const result = await getNextUpcomingAttendance(fastify, request.user.organizationId, request.user.userId);
      return reply.send(result as any);
    }
  );

  // Location Ping Routes
  server.post(
    '/api/v1/attendance/shift/location-ping',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: shiftLocationPingSchema,
        response: { 200: locationCheckResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await submitShiftLocationCheck(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body as any
      );
      return reply.send(result as any);
    }
  );

  server.post(
    '/api/v1/attendance/overtime/location-ping',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: overtimeLocationPingSchema,
        response: { 200: locationCheckResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await submitOvertimeLocationCheck(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.body as any
      );
      return reply.send(result as any);
    }
  );
}
