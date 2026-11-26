import fp from 'fastify-plugin';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyWebsocket, { WebSocket } from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import {
  DOMAIN_EVENT_CHANNEL,
  DomainEvent,
  domainEventBus,
  publishDomainEvent,
} from '../shared/services/event-bus.js';

interface WsClient {
  userId: string;
  organizationId: string;
  role: 'OWNER' | 'EMPLOYEE';
  premisesId?: string | null;
  sessionJti: string;
  subscribedPremisesIds: Set<string>;
  socket: WebSocket;
}

/**
 * A WebSocket handshake is authenticated once, but the underlying session can
 * be revoked at any time (another device signs in, logout, reuse detection,
 * expiry). Sockets are therefore revalidated against PostgreSQL on every
 * heartbeat instead of trusting the JWT until it expires.
 */
async function isSessionStillActive(
  fastify: FastifyInstance,
  userId: string,
  sessionJti: string
): Promise<boolean> {
  const [record] = await fastify.db
    .select({
      userId: schema.loggedDevices.userId,
      isActive: schema.loggedDevices.isActive,
      expiresAt: schema.loggedDevices.expiresAt,
    })
    .from(schema.loggedDevices)
    .where(eq(schema.loggedDevices.sessionJti, sessionJti))
    .limit(1);

  return Boolean(
    record &&
      record.userId === userId &&
      record.isActive &&
      record.expiresAt.getTime() > Date.now()
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    publishDomainEvent: (event: DomainEvent) => Promise<void>;
  }
}

/**
 * WebSocket transport for real-time ledger, attendance, location, and notification updates
 * with multi-tenant organization, owner, role, user, and premises room targeting.
 */
export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(fastifyWebsocket, {
    options: {
      maxPayload: 1048576, // 1MB
    },
  });

  const clients = new Set<WsClient>();

  const dispatch = (event: DomainEvent) => {
    const actorId =
      (event.payload?.actorId as string) ??
      (event.payload?.userId as string) ??
      null;

    const payloadString = JSON.stringify({
      event: event.type,
      premisesId: event.premisesId ?? null,
      emittedAt: event.emittedAt ?? new Date().toISOString(),
      data: {
        ...event.payload,
        actorId,
      },
    });

    for (const client of clients) {
      // 1. STRICT Multi-Tenancy Isolation: Must belong to the same organization
      if (client.organizationId !== event.organizationId) {
        continue;
      }

      const isOwner = client.role === 'OWNER';

      // 2. User ID targeting check (e.g. personal notification, private ledger or user alert)
      if (event.userIds && event.userIds.length > 0) {
        const isDirectRecipient = event.userIds.includes(client.userId);
        const isTargetedRole = event.targetRoles && event.targetRoles.includes(client.role);
        if (!isDirectRecipient && !isTargetedRole) {
          continue;
        }
      }

      // 3. Role targeting check
      if (event.targetRoles && event.targetRoles.length > 0) {
        const isTargetRole = event.targetRoles.includes(client.role);
        const isTargetUser = event.userIds && event.userIds.includes(client.userId);
        if (!isTargetRole && !isTargetUser) {
          continue;
        }
      }

      // 4. Premises Room check
      if (event.premisesId) {
        const isPremisesSubscribed =
          client.premisesId === event.premisesId ||
          client.subscribedPremisesIds.has(event.premisesId);
        // Owners in the org manage all premises in their organization.
        // Employees MUST belong or be subscribed to the premises room.
        if (!isPremisesSubscribed && !isOwner) {
          continue;
        }
      }

      // Deliver message if socket is open
      if (client.socket.readyState === 1 /* OPEN */) {
        try {
          client.socket.send(payloadString);
        } catch {
          clients.delete(client);
        }
      }
    }
  };

  domainEventBus.on(DOMAIN_EVENT_CHANNEL, dispatch);

  fastify.decorate('publishDomainEvent', async (event: DomainEvent) => {
    await publishDomainEvent(fastify, event);
  });

  // WebSocket connection endpoint
  fastify.get(
    '/api/v1/events/ws',
    { websocket: true },
    async (socket: WebSocket, request: FastifyRequest) => {
      const headerToken = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      const queryToken = (request.query as { token?: string })?.token;
      const token = headerToken ?? queryToken;

      if (!token) {
        socket.close(4001, 'Unauthorized: Access token required');
        return;
      }

      let payload: {
        userId: string;
        organizationId: string;
        role?: string;
        premisesId?: string;
        jti?: string;
      };
      try {
        payload = fastify.jwt.verify<{
          userId: string;
          organizationId: string;
          role?: string;
          premisesId?: string;
          jti?: string;
        }>(token);
      } catch {
        socket.close(4002, 'Unauthorized: Invalid token');
        return;
      }

      if (!payload.jti) {
        socket.close(4002, 'Unauthorized: Invalid session');
        return;
      }

      try {
        const active = await isSessionStillActive(fastify, payload.userId, payload.jti);
        if (!active) {
          socket.close(4003, 'Unauthorized: Session revoked or expired');
          return;
        }
      } catch (err) {
        fastify.log.warn({ err }, 'WebSocket session validation failed');
        socket.close(1011, 'Session validation unavailable');
        return;
      }

      const clientRole = (payload.role?.toUpperCase() as 'OWNER' | 'EMPLOYEE') || 'EMPLOYEE';

      const client: WsClient = {
        userId: payload.userId,
        organizationId: payload.organizationId,
        role: clientRole,
        premisesId: payload.premisesId ?? null,
        sessionJti: payload.jti,
        subscribedPremisesIds: new Set<string>(),
        socket,
      };

      if (payload.premisesId) {
        client.subscribedPremisesIds.add(payload.premisesId);
      }

      clients.add(client);

      // Send initial connected event
      socket.send(
        JSON.stringify({
          event: 'connected',
          data: {
            userId: payload.userId,
            organizationId: payload.organizationId,
            role: clientRole,
            premisesId: payload.premisesId ?? null,
            rooms: [
              `org:${payload.organizationId}`,
              `user:${payload.userId}`,
              `role:${payload.organizationId}:${clientRole}`,
              ...(payload.premisesId ? [`premises:${payload.premisesId}`] : []),
            ],
          },
        })
      );

      // Handle client messages (e.g. room subscriptions or pings)
      socket.on('message', (rawMsg: Buffer | string) => {
        try {
          const msg = JSON.parse(rawMsg.toString());
          if (msg.action === 'subscribe_premises' && typeof msg.premisesId === 'string') {
            client.subscribedPremisesIds.add(msg.premisesId);
            socket.send(
              JSON.stringify({
                event: 'subscribed',
                data: { room: `premises:${msg.premisesId}` },
              })
            );
          } else if (
            msg.action === 'unsubscribe_premises' &&
            typeof msg.premisesId === 'string'
          ) {
            client.subscribedPremisesIds.delete(msg.premisesId);
            socket.send(
              JSON.stringify({
                event: 'unsubscribed',
                data: { room: `premises:${msg.premisesId}` },
              })
            );
          } else if (msg.action === 'ping') {
            socket.send(JSON.stringify({ event: 'pong', data: { timestamp: Date.now() } }));
          }
        } catch {
          // Ignore invalid JSON messages
        }
      });

      // Heartbeat / ping interval
      const pingInterval = setInterval(() => {
        if (socket.readyState !== 1 /* OPEN */) {
          clearInterval(pingInterval);
          return;
        }

        void (async () => {
          try {
            const active = await isSessionStillActive(
              fastify,
              client.userId,
              client.sessionJti
            );
            if (!active) {
              clearInterval(pingInterval);
              clients.delete(client);
              socket.close(4003, 'Session revoked or expired');
              return;
            }
            socket.ping();
          } catch (err) {
            fastify.log.warn({ err }, 'WebSocket heartbeat session check failed');
          }
        })();
      }, 30_000);

      socket.on('close', () => {
        clearInterval(pingInterval);
        clients.delete(client);
      });

      socket.on('error', () => {
        clearInterval(pingInterval);
        clients.delete(client);
      });
    }
  );

  // Legacy fallback endpoint for SSE clients
  fastify.get(
    '/api/v1/events/stream',
    async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.status(426).send({
        statusCode: 426,
        error: 'Upgrade Required',
        code: 'WEBSOCKET_REQUIRED',
        message: 'Please upgrade to WebSocket endpoint at /api/v1/events/ws',
        timestamp: new Date().toISOString(),
      });
    }
  );

  fastify.addHook('onClose', async () => {
    domainEventBus.off(DOMAIN_EVENT_CHANNEL, dispatch);
    for (const client of clients) {
      try {
        client.socket.close(1001, 'Server shutting down');
      } catch {
        // Ignore
      }
    }
    clients.clear();
  });

  fastify.log.info('WebSocket notifications plugin registered with multi-tenant organization & room support');
});
