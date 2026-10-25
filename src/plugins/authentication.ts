import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { env } from '../config/env.js';
import * as schema from '../db/schema.js';

export interface UserJwtPayload {
  userId: string;
  googleSub: string;
  organizationId: string;
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  jti: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: UserJwtPayload;
    user: UserJwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (fastify) => {
  await fastify.register(fastifyJwt, {
    secret: env.ACCESS_TOKEN_SECRET,
    sign: {
      expiresIn: '15m',
    },
  });

  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const payload = request.user;

      // 1. PostgreSQL Logged Device Session Verification (Single-Device Enforcement)
      const [deviceRecord] = await fastify.db
        .select({ isActive: schema.loggedDevices.isActive })
        .from(schema.loggedDevices)
        .where(eq(schema.loggedDevices.sessionJti, payload.jti))
        .limit(1);

      if (deviceRecord && !deviceRecord.isActive) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          code: 'DEVICE_REVOKED',
          message: 'This device session has been logged out because a new session was initiated on another device or revoked.',
          timestamp: new Date().toISOString(),
        });
      }

      // 2. PostgreSQL User Account Verification
      const [userRecord] = await fastify.db
        .select({ isActive: schema.users.isActive })
        .from(schema.users)
        .where(eq(schema.users.id, payload.userId))
        .limit(1);

      if (!userRecord || !userRecord.isActive) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          code: 'ACCOUNT_DEACTIVATED',
          message: 'Your account has been deactivated.',
          timestamp: new Date().toISOString(),
        });
      }

      // 3. PostgreSQL Organization Membership Verification
      const [membership] = await fastify.db
        .select({ isActive: schema.memberships.isActive })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.userId, payload.userId),
            eq(schema.memberships.organizationId, payload.organizationId)
          )
        )
        .limit(1);

      if (!membership || !membership.isActive) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          code: 'MEMBERSHIP_INACTIVE',
          message: 'Your organization membership is no longer active.',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired access token',
        timestamp: new Date().toISOString(),
      });
    }
  });

  fastify.log.info('Authentication plugin registered');
});
