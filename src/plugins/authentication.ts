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
        .select({
          isActive: schema.loggedDevices.isActive,
          userId: schema.loggedDevices.userId,
          expiresAt: schema.loggedDevices.expiresAt,
        })
        .from(schema.loggedDevices)
        .where(eq(schema.loggedDevices.sessionJti, payload.jti))
        .limit(1);

      // A token whose session row no longer exists must never be trusted.
      if (!deviceRecord || deviceRecord.userId !== payload.userId) {
        return reply.status(401).send({
          status: 'error',
          statusCode: 401,
          error: 'Unauthorized',
          code: 'SESSION_NOT_FOUND',
          message: 'This session is no longer valid. Please sign in again.',
          timestamp: new Date().toISOString(),
        });
      }

      if (!deviceRecord.isActive) {
        return reply.status(401).send({
          status: 'error',
          statusCode: 401,
          error: 'Unauthorized',
          code: 'DEVICE_REVOKED',
          message: 'This device session has been logged out because a new session was initiated on another device or revoked.',
          timestamp: new Date().toISOString(),
        });
      }

      if (deviceRecord.expiresAt.getTime() <= Date.now()) {
        return reply.status(401).send({
          status: 'error',
          statusCode: 401,
          error: 'Unauthorized',
          code: 'SESSION_EXPIRED',
          message: 'Your session has expired. Please sign in again.',
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
          status: 'error',
          statusCode: 403,
          error: 'Forbidden',
          code: 'ACCOUNT_DEACTIVATED',
          message: 'Your account has been deactivated.',
          timestamp: new Date().toISOString(),
        });
      }

      // 3. PostgreSQL Organization Access Verification
      // Owners are identified by organizations.owner_user_id; Managers and
      // Staff by their active employee record. Roles are re-read from the
      // database so a stale token can never retain elevated privileges.
      const [organization] = await fastify.db
        .select({ ownerUserId: schema.organizations.ownerUserId })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, payload.organizationId))
        .limit(1);

      if (!organization) {
        return reply.status(403).send({
          status: 'error',
          statusCode: 403,
          error: 'Forbidden',
          code: 'ORGANIZATION_NOT_FOUND',
          message: 'Your organization is no longer available.',
          timestamp: new Date().toISOString(),
        });
      }

      let authoritativeRole: 'OWNER' | 'MANAGER' | 'STAFF' | null = null;
      if (organization.ownerUserId === payload.userId) {
        authoritativeRole = 'OWNER';
      } else {
        const [employee] = await fastify.db
          .select({ role: schema.employees.role })
          .from(schema.employees)
          .where(
            and(
              eq(schema.employees.userId, payload.userId),
              eq(schema.employees.organizationId, payload.organizationId),
              eq(schema.employees.isActive, true)
            )
          )
          .limit(1);

        if (employee) {
          authoritativeRole = employee.role;
        }
      }

      if (!authoritativeRole) {
        return reply.status(403).send({
          status: 'error',
          statusCode: 403,
          error: 'Forbidden',
          code: 'MEMBERSHIP_INACTIVE',
          message: 'Your organization access is no longer active.',
          timestamp: new Date().toISOString(),
        });
      }

      if (authoritativeRole !== payload.role) {
        return reply.status(403).send({
          status: 'error',
          statusCode: 403,
          error: 'Forbidden',
          code: 'ROLE_CHANGED',
          message: 'Your role has changed. Please sign in again.',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      return reply.status(401).send({
        status: 'error',
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
