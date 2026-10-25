import { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { CreatePremisesInput, Premises, UpdatePremisesInput } from './schemas.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';

export async function getPremises(
  fastify: FastifyInstance,
  organizationId: string
): Promise<Premises[]> {
  const cacheKey = `org:${organizationId}:premises:list`;
  const orgTag = `org:${organizationId}`;
  const premisesTag = `org:${organizationId}:premises`;

  return fastify.cache.getOrFetch(
    cacheKey,
    async () => {
      const rows = await fastify.db
        .select()
        .from(schema.premises)
        .where(
          and(
            eq(schema.premises.organizationId, organizationId),
            eq(schema.premises.isActive, true)
          )
        );

      return rows.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        name: r.name,
        latitude: String(r.latitude),
        longitude: String(r.longitude),
        radiusMeters: r.radiusMeters,
        isActive: r.isActive,
      }));
    },
    { ttlMs: 120_000, tags: [orgTag, premisesTag] }
  );
}

export async function createPremises(
  fastify: FastifyInstance,
  organizationId: string,
  input: CreatePremisesInput
): Promise<Premises> {
  const [created] = await fastify.db
    .insert(schema.premises)
    .values({
      organizationId,
      name: input.name,
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radiusMeters,
      isActive: true,
    })
    .returning();

  const premises: Premises = {
    id: created.id,
    organizationId: created.organizationId,
    name: created.name,
    latitude: String(created.latitude),
    longitude: String(created.longitude),
    radiusMeters: created.radiusMeters,
    isActive: created.isActive,
  };

  // Invalidate cache and broadcast real-time update
  fastify.cache.invalidateTag(`org:${organizationId}:premises`);
  if (typeof fastify.publishDomainEvent === 'function') {
    await fastify.publishDomainEvent({
      type: 'premises_update',
      organizationId,
      userIds: [],
      payload: { action: 'CREATED', premisesId: premises.id },
    });
  }

  return premises;
}

export async function updatePremises(
  fastify: FastifyInstance,
  organizationId: string,
  premisesId: string,
  input: UpdatePremisesInput
): Promise<Premises> {
  const [updated] = await fastify.db
    .update(schema.premises)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
      ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
      ...(input.radiusMeters !== undefined ? { radiusMeters: input.radiusMeters } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    })
    .where(
      and(
        eq(schema.premises.id, premisesId),
        eq(schema.premises.organizationId, organizationId)
      )
    )
    .returning();

  if (!updated) {
    throw new AppError('Premises location not found', 404, 'PREMISES_NOT_FOUND');
  }

  const premises: Premises = {
    id: updated.id,
    organizationId: updated.organizationId,
    name: updated.name,
    latitude: String(updated.latitude),
    longitude: String(updated.longitude),
    radiusMeters: updated.radiusMeters,
    isActive: updated.isActive,
  };

  // Invalidate cache and broadcast real-time update
  fastify.cache.invalidateTag(`org:${organizationId}:premises`);
  if (typeof fastify.publishDomainEvent === 'function') {
    await fastify.publishDomainEvent({
      type: 'premises_update',
      organizationId,
      userIds: [],
      payload: { action: 'UPDATED', premisesId: premises.id },
    });
  }

  return premises;
}
