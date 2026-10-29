import fp from 'fastify-plugin';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyWebsocket, { WebSocket } from '@fastify/websocket';
import {
  DOMAIN_EVENT_CHANNEL,
  DomainEvent,
  domainEventBus,
  publishDomainEvent,
} from '../shared/services/event-bus.js';

interface WsClient {
  userId: string;
  organizationId: string;
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  premisesId?: string | null;
  subscribedPremisesIds: Set<string>;
  socket: WebSocket;
}

declare module 'fastify' {
  interface FastifyInstance {
    publishDomainEvent: (event: DomainEvent) => Promise<void>;
  }
}

/**
 * WebSocket transport for real-time ledger, attendance, location, and notification updates
 * with organization, owner/manager, and premises room targeting.
 */
export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(fastifyWebsocket, {
    options: {
      maxPayload: 1048576, // 1MB
    },
  });

  const clients = new Set<WsClient>();

  const dispatch = (event: DomainEvent) => {
    const payloadString = JSON.stringify({
      event: event.type,
      data: event.payload,
      premisesId: event.premisesId ?? null,
      emittedAt: event.emittedAt ?? new Date().toISOString(),
    });

    for (const client of clients) {
      // 1. Must belong to the same organization
      if (client.organizationId !== event.organizationId) {
        continue;
      }

      // 2. Role targeting check (Owners & Managers receive all operational events)
      const isOwnerOrManager = client.role === 'OWNER' || client.role === 'MANAGER';

      if (event.targetRoles && event.targetRoles.length > 0) {
        if (!event.targetRoles.includes(client.role) && !isOwnerOrManager) {
          continue;
        }
      }

      // 3. User ID targeting check
      if (event.userIds && event.userIds.length > 0) {
        const isDirectRecipient = event.userIds.includes(client.userId);
        if (!isDirectRecipient && !isOwnerOrManager) {
          continue;
        }
      }

      // 4. Premises Room check
      if (event.premisesId) {
        const isPremisesSubscribed =
          client.premisesId === event.premisesId ||
          client.subscribedPremisesIds.has(event.premisesId);
        if (!isPremisesSubscribed && !isOwnerOrManager) {
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
    (socket: WebSocket, request: FastifyRequest) => {
      const headerToken = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      const queryToken = (request.query as { token?: string })?.token;
      const token = headerToken ?? queryToken;

      if (!token) {
        socket.close(4001, 'Unauthorized: Access token required');
        return;
      }

      let payload: { userId: string; organizationId: string; role?: string; premisesId?: string };
      try {
        payload = fastify.jwt.verify<{
          userId: string;
          organizationId: string;
          role?: string;
          premisesId?: string;
        }>(token);
      } catch {
        socket.close(4002, 'Unauthorized: Invalid token');
        return;
      }

      const clientRole = (payload.role?.toUpperCase() as 'OWNER' | 'MANAGER' | 'STAFF') || 'STAFF';

      const client: WsClient = {
        userId: payload.userId,
        organizationId: payload.organizationId,
        role: clientRole,
        premisesId: payload.premisesId ?? null,
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
        if (socket.readyState === 1 /* OPEN */) {
          try {
            socket.ping();
          } catch {
            clearInterval(pingInterval);
          }
        } else {
          clearInterval(pingInterval);
        }
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

  fastify.log.info('WebSocket notifications plugin registered with owner & premises room support');
});
