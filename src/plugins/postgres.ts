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
    onnotice: (notice) => {
      fastify.log.debug({ code: notice.code, severity: notice.severity }, notice.message);
    },
  });

  const db = drizzle(pgClient, { schema });

  fastify.decorate('pgClient', pgClient);
  fastify.decorate('db', db);

  try {
    const [{ exists: vectorExists }] = await pgClient`SELECT EXISTS (
      SELECT 1 FROM pg_extension WHERE extname = 'vector'
    )`;
    if (!vectorExists) {
      await pgClient`CREATE EXTENSION IF NOT EXISTS vector`;
    }
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to create vector extension');
  }

  try {
    const [{ exists: tableExists }] = await pgClient`SELECT EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'organizations'
    )`;
    if (tableExists) {
      const [{ exists: columnExists }] = await pgClient`SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'organizations' 
          AND column_name = 'owner_user_id'
      )`;
      if (!columnExists) {
        await pgClient`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT`;
      }
    } else {
      fastify.log.debug('organizations table does not exist yet, skipping owner_user_id migration');
    }
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to ensure owner_user_id column on organizations');
  }

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
