import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  attendanceEventSchema,
  attendanceRecordSchema,
  attendanceRecordsQuerySchema,
  claimUnhandledEventResponseSchema,
  claimUnhandledEventSchema,
  clockInSchema,
  dailyAttendanceSchema,
  locationCheckResponseSchema,
  manualMarkOvertimeSchema,
  manualMarkShiftSchema,
  overtimeLocationPingSchema,
  shiftLocationPingSchema,
  unhandledEventsResponseSchema,
} from './schemas.js';
import {
  claimUnhandledEvent,
  clockInOvertime,
  clockInShift,
  correctOvertimeAttendance,
  correctShiftAttendance,
  getDailyAttendanceByDateAndPremises,
  getEmployeeAttendanceAndEarningsHistory,
  getNextUpcomingAttendance,
  getOvertimeLocationPings,
  getShiftLocationPings,
  getUnhandledEvents,
  getUpcomingAttendance,
  listAttendanceRecords,
  submitOvertimeLocationCheck,
  submitShiftLocationCheck,
  toPublicAttendanceEvent,
} from './service.js';

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

  // 1. Shift Attendance Manual Mark
  server.post(
    '/api/v1/attendance/shift/manual-mark',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: { body: manualMarkShiftSchema },
    },
    async (request, reply) => {
      const result = await correctShiftAttendance(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body as any
      );
      return reply.send(result as any);
    }
  );

  // 2. Overtime Attendance Manual Mark
  server.post(
    '/api/v1/attendance/overtime/manual-mark',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: { body: manualMarkOvertimeSchema },
    },
    async (request, reply) => {
      const result = await correctOvertimeAttendance(
        fastify,
        request.user.organizationId,
        request.user.userId,
        request.body as any
      );
      return reply.send(result as any);
    }
  );

  // 3. Attendance Records (General)
  server.get(
    '/api/v1/attendance/records',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description:
          'List attendance events. Employees receive their own records, Owners receive the whole organization.',
        tags: ['Attendance'],
        querystring: attendanceRecordsQuerySchema,
        response: { 200: z.array(attendanceRecordSchema) },
      },
    },
    async (request, reply) => {
      const result = await listAttendanceRecords(
        fastify,
        request.user,
        request.user.organizationId,
        request.query as any
      );
      return reply.send(result);
    }
  );

  // 4. All Attendance Records (OWNER)
  server.get(
    '/api/v1/attendance/all',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER')],
      schema: {
        description: 'List all attendance records for organization (Owner)',
        tags: ['Attendance'],
        querystring: attendanceRecordsQuerySchema,
        response: { 200: z.array(attendanceRecordSchema) },
      },
    },
    async (request, reply) => {
      const result = await listAttendanceRecords(
        fastify,
        { userId: request.user.userId, role: 'OWNER' },
        request.user.organizationId,
        request.query as any
      );
      return reply.send(result);
    }
  );

  // 5. Daily Attendance (OWNER)
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
        response: { 200: z.array(dailyAttendanceSchema) },
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

  // 6. My Attendance History (EMPLOYEE)
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
      const q = request.query as { from?: string; to?: string; month?: string; year?: number };
      const result = await getEmployeeAttendanceAndEarningsHistory(
        fastify,
        request.user.organizationId,
        request.user.userId,
        q.from,
        q.to,
        q.month,
        q.year
      );
      return reply.send(result as any);
    }
  );

  server.get(
    '/api/v1/attendance/my',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE', 'OWNER')],
      schema: {
        description: 'Retrieve my attendance history',
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
      const q = request.query as { from?: string; to?: string; month?: string; year?: number };
      const result = await getEmployeeAttendanceAndEarningsHistory(
        fastify,
        request.user.organizationId,
        request.user.userId,
        q.from,
        q.to,
        q.month,
        q.year
      );
      return reply.send(result as any);
    }
  );

  // 7. Upcoming Attendance
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

  // 8. Unhandled Events Queue (Weekly off, Holiday, Approved Leave, Absent marking)
  const unhandledEventsHandler = async (request: any, reply: any) => {
    const result = await getUnhandledEvents(fastify, request.user.organizationId, request.user.userId);
    return reply.send(result as any);
  };

  const unhandledEventsRouteSchema = {
    description: 'Fetch pending unhandled attendance events (weekly offs, holidays, leaves, absents)',
    tags: ['Attendance'],
    response: {
      200: unhandledEventsResponseSchema,
    },
  };

  server.get(
    '/api/v1/attendance/unhandled-events',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
      schema: unhandledEventsRouteSchema,
    },
    unhandledEventsHandler
  );

  server.get(
    '/api/v1/attendance/queue',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
      schema: unhandledEventsRouteSchema,
    },
    unhandledEventsHandler
  );

  // 9. Claim Unhandled Event
  const claimUnhandledEventHandler = async (request: any, reply: any) => {
    const result = await claimUnhandledEvent(
      fastify,
      request.user.organizationId,
      request.user.userId,
      request.body as any
    );
    return reply.send(result as any);
  };

  const claimUnhandledEventRouteSchema = {
    description: 'Claim/confirm a pending unhandled attendance event and credit earning/record attendance',
    tags: ['Attendance'],
    body: claimUnhandledEventSchema,
    response: {
      200: claimUnhandledEventResponseSchema,
    },
  };

  server.post(
    '/api/v1/attendance/unhandled-events/claim',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
      schema: claimUnhandledEventRouteSchema,
    },
    claimUnhandledEventHandler
  );

  server.post(
    '/api/v1/attendance/claim',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('EMPLOYEE')],
      schema: claimUnhandledEventRouteSchema,
    },
    claimUnhandledEventHandler
  );

  // Shift Location Ping Handler
  const shiftPingHandler = async (request: any, reply: any) => {
    const result = await submitShiftLocationCheck(
      fastify,
      request.user.userId,
      request.user.organizationId,
      request.body as any
    );
    return reply.send(result as any);
  };

  const shiftPingSchema = {
    description: 'Submit a periodic GPS location ping for active shift attendance',
    tags: ['Location', 'Attendance'],
    body: shiftLocationPingSchema,
    response: { 200: locationCheckResponseSchema },
  };

  server.post('/api/v1/attendance/shift/location-ping', { preHandler: [fastify.authenticate], schema: shiftPingSchema }, shiftPingHandler);
  server.post('/api/v1/location/shift/ping', { preHandler: [fastify.authenticate], schema: shiftPingSchema }, shiftPingHandler);
  server.post('/api/v1/location/shift/location-ping', { preHandler: [fastify.authenticate], schema: shiftPingSchema }, shiftPingHandler);

  // Overtime Location Ping Handler
  const overtimePingHandler = async (request: any, reply: any) => {
    const result = await submitOvertimeLocationCheck(
      fastify,
      request.user.userId,
      request.user.organizationId,
      request.body as any
    );
    return reply.send(result as any);
  };

  const overtimePingSchema = {
    description: 'Submit a periodic GPS location ping for active overtime attendance',
    tags: ['Location', 'Attendance'],
    body: overtimeLocationPingSchema,
    response: { 200: locationCheckResponseSchema },
  };

  server.post('/api/v1/attendance/overtime/location-ping', { preHandler: [fastify.authenticate], schema: overtimePingSchema }, overtimePingHandler);
  server.post('/api/v1/location/overtime/ping', { preHandler: [fastify.authenticate], schema: overtimePingSchema }, overtimePingHandler);
  server.post('/api/v1/location/overtime/location-ping', { preHandler: [fastify.authenticate], schema: overtimePingSchema }, overtimePingHandler);

  // Shift Location Pings List
  const shiftPingsListHandler = async (request: any, reply: any) => {
    const { shiftAttendanceId } = request.query as { shiftAttendanceId: string };
    const result = await getShiftLocationPings(
      fastify,
      request.user.organizationId,
      shiftAttendanceId
    );
    return reply.send(result);
  };

  const shiftPingsListSchema = {
    description: 'Get list of location pings recorded for a shift attendance event',
    tags: ['Location', 'Attendance'],
    querystring: z.object({
      shiftAttendanceId: z.string(),
    }),
  };

  server.get('/api/v1/attendance/shift/location-pings', { preHandler: [fastify.authenticate], schema: shiftPingsListSchema }, shiftPingsListHandler);
  server.get('/api/v1/location/shift/pings', { preHandler: [fastify.authenticate], schema: shiftPingsListSchema }, shiftPingsListHandler);
  server.get('/api/v1/location/shift/location-pings', { preHandler: [fastify.authenticate], schema: shiftPingsListSchema }, shiftPingsListHandler);

  // Overtime Location Pings List
  const overtimePingsListHandler = async (request: any, reply: any) => {
    const { overtimeAttendanceId } = request.query as { overtimeAttendanceId: string };
    const result = await getOvertimeLocationPings(
      fastify,
      request.user.organizationId,
      overtimeAttendanceId
    );
    return reply.send(result);
  };

  const overtimePingsListSchema = {
    description: 'Get list of location pings recorded for an overtime attendance event',
    tags: ['Location', 'Attendance'],
    querystring: z.object({
      overtimeAttendanceId: z.string(),
    }),
  };

  server.get('/api/v1/attendance/overtime/location-pings', { preHandler: [fastify.authenticate], schema: overtimePingsListSchema }, overtimePingsListHandler);
  server.get('/api/v1/location/overtime/pings', { preHandler: [fastify.authenticate], schema: overtimePingsListSchema }, overtimePingsListHandler);
  server.get('/api/v1/location/overtime/location-pings', { preHandler: [fastify.authenticate], schema: overtimePingsListSchema }, overtimePingsListHandler);
}
