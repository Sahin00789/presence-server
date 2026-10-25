import fp from 'fastify-plugin';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from '../db/schema.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: PostgresJsDatabase<typeof schema>;
    pgClient: postgres.Sql;
  }
}

export default fp(async (fastify) => {
  const pgClient = postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === 'production' ? 20 : 5,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  const db = drizzle(pgClient, { schema });

  fastify.decorate('pgClient', pgClient);
  fastify.decorate('db', db);

  // Keep-alive ping for serverless databases (e.g. NeonDB free tier) to prevent compute auto-suspend / cold starts
  const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
  const keepAliveTimer = setInterval(async () => {
    try {
      await pgClient`SELECT 1`;
      fastify.log.debug('PostgreSQL keep-alive ping succeeded');
    } catch (err) {
      fastify.log.warn({ err }, 'PostgreSQL keep-alive ping failed');
    }
  }, KEEP_ALIVE_INTERVAL_MS);
  keepAliveTimer.unref();

  fastify.addHook('onClose', async () => {
    clearInterval(keepAliveTimer);
    fastify.log.info('Closing PostgreSQL connection pool...');
    await pgClient.end();
  });

  fastify.log.info('PostgreSQL database plugin registered successfully (with 4-min NeonDB keep-alive ping)');
});
