import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  activeLocationSessionResponseSchema,
  locationCheckBodySchema,
  locationCheckResponseSchema,
  todayLocationPresenceResponseSchema,
} from './schemas.js';
import {
  getActiveLocationSession,
  getTodayLocationPresence,
  submitLocationCheck,
} from './service.js';

export async function locationRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  const presenceHandler = async (request: any, reply: any) => {
    const { premisesId, date } = request.query as {
      premisesId?: string;
      date?: string;
    };
    const result = await getTodayLocationPresence(
      fastify,
      request.user,
      premisesId,
      date
    );
    return reply.send(result);
  };

  const presenceSchema = {
    description: 'Get real-time workforce presence, active shifts, and GPS monitoring metrics for premises.',
    tags: ['Live Monitor'],
    querystring: z.object({
      premisesId: z.string().optional(),
      date: z.string().optional(),
    }),
    response: { 200: todayLocationPresenceResponseSchema },
  };

  server.get('/api/v1/live-monitor/presence', { preHandler: [fastify.authenticate], schema: presenceSchema }, presenceHandler);
  server.get('/api/v1/location/presence', { preHandler: [fastify.authenticate], schema: presenceSchema }, presenceHandler);

  const activeHandler = async (request: any, reply: any) => {
    const result = await getActiveLocationSession(
      fastify,
      request.user.userId,
      request.user.organizationId
    );
    return reply.send(result);
  };

  const activeSchema = {
    description: 'Get current active location session for authenticated user.',
    tags: ['Live Monitor'],
    response: { 200: activeLocationSessionResponseSchema },
  };

  server.get('/api/v1/live-monitor/active', { preHandler: [fastify.authenticate], schema: activeSchema }, activeHandler);
  server.get('/api/v1/location/active', { preHandler: [fastify.authenticate], schema: activeSchema }, activeHandler);

  const checkHandler = async (request: any, reply: any) => {
    const body = request.body as {
      attendanceEventId?: string;
      shiftAttendanceId?: string;
      latitude: number;
      longitude: number;
      accuracyMeters: number;
      isMock?: boolean;
      timestamp?: string;
      clientRequestId?: string;
    };
    const checkRes = await submitLocationCheck(
      fastify,
      request.user.userId,
      request.user.organizationId,
      body
    );
    return reply.send({
      success: true,
      result: checkRes.result,
    });
  };

  const checkSchema = {
    description: 'Submit GPS geofence location check for active shift.',
    tags: ['Live Monitor'],
    body: locationCheckBodySchema,
    response: { 200: locationCheckResponseSchema },
  };

  server.post('/api/v1/live-monitor/checks', { preHandler: [fastify.authenticate], schema: checkSchema }, checkHandler);
  server.post('/api/v1/location/checks', { preHandler: [fastify.authenticate], schema: checkSchema }, checkHandler);
}
