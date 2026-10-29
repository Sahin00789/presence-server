import fp from 'fastify-plugin';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RateLimitOptions {
  /** Maximum number of requests allowed inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Namespace prefix so different policies do not share a bucket. */
  bucket: string;
  /** Derives the identity being limited. Defaults to the authenticated user, else the IP. */
  identify?: (request: FastifyRequest) => string;
}

declare module 'fastify' {
  interface FastifyInstance {
    rateLimit: (options: RateLimitOptions) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * In-process sliding-window rate limiter.
 *
 * Mandated rate limits:
 *   - auth endpoints: 5 requests / minute / IP
 *   - clock-in & location checks: 30 requests / minute / user
 *   - general API endpoints: 100 requests / minute / user
 */
export default fp(async (fastify: FastifyInstance) => {
  /** In-process buckets: bucket -> identity -> timestamps (ms). */
  const memoryBuckets = new Map<string, Map<string, number[]>>();

  const consumeInMemory = (bucket: string, identity: string, limit: number, windowMs: number) => {
    const now = Date.now();
    let identities = memoryBuckets.get(bucket);
    if (!identities) {
      identities = new Map();
      memoryBuckets.set(bucket, identities);
    }

    const timestamps = (identities.get(identity) ?? []).filter((ts) => ts > now - windowMs);

    if (timestamps.length >= limit) {
      const oldest = timestamps[0];
      identities.set(identity, timestamps);
      return { allowed: false, retryAfterSeconds: Math.ceil((oldest + windowMs - now) / 1000) };
    }

    timestamps.push(now);
    identities.set(identity, timestamps);
    return { allowed: true, retryAfterSeconds: 0 };
  };

  fastify.decorate('rateLimit', (options: RateLimitOptions) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const identity = options.identify
        ? options.identify(request)
        : request.user?.userId ?? request.ip;
      const windowMs = options.windowSeconds * 1000;

      const result = consumeInMemory(options.bucket, identity, options.limit, windowMs);

      if (!result.allowed) {
        reply.header('Retry-After', String(result.retryAfterSeconds || 1));
        return reply.status(429).send({
          status: 'error',
          statusCode: 429,
          error: 'Too Many Requests',
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests. Please retry in ${result.retryAfterSeconds || 1} second(s).`,
          timestamp: new Date().toISOString(),
        });
      }
    };
  });

  fastify.addHook('onClose', async () => {
    memoryBuckets.clear();
  });

  fastify.log.info('In-process rate limiting plugin registered');
});
