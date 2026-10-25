import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { CacheService, cacheService } from '../shared/services/cache.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    cache: CacheService;
  }
}

/**
 * In-memory cache plugin providing zero-Redis caching, single-flight request coalescing,
 * tag invalidation, and automated invalidation tied to real-time domain events.
 */
export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('cache', cacheService);

  fastify.addHook('onClose', async () => {
    cacheService.destroy();
  });

  fastify.log.info('In-memory cache plugin registered');
});
