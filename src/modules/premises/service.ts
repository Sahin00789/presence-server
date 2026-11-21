import { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { CreatePremisesInput, Premises, UpdatePremisesInput } from './schemas.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';

/**
 * Purpose: Retrieves active premises list for an organization.
 * How it works: Queries `premises` table where `organizationId` matches and `isActive` is `true`.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @returns Array of formatted Premises objects.
 */
export async function getPremises(
  fastify: FastifyInstance,
  organizationId: string
): Promise<Premises[]> {
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
    address: r.address ?? null,
    latitude: String(r.latitude),
    longitude: String(r.longitude),
    radiusMeters: r.radiusMeters,
    isActive: r.isActive,
  }));
}

/**
 * Purpose: Resolves a single primary premises for an organization, creating a default one if none exist.
 * How it works: Invokes `getPremises()`. If non-empty, returns the first premises. Otherwise creates a default "Main Premises" entry.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @returns Primary Premises instance.
 */
export async function getSinglePremises(
  fastify: FastifyInstance,
  organizationId: string
): Promise<Premises> {
  const list = await getPremises(fastify, organizationId);
  if (list.length > 0) {
    return list[0];
  }
  return createPremises(fastify, organizationId, {
    name: 'Main Premises',
    address: 'Main Office',
    latitude: '0.0000000',
    longitude: '0.0000000',
    radiusMeters: 50,
  });
}

/**
 * Purpose: Creates a new premises work location with geofence settings.
 * How it works: Inserts new row into `premises` and publishes a `premises_update` domain event over WebSocket stream.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @param input CreatePremisesInput containing name, address, latitude, longitude, radiusMeters.
 * @returns Created Premises object.
 */
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
      address: input.address,
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
    address: created.address ?? null,
    latitude: String(created.latitude),
    longitude: String(created.longitude),
    radiusMeters: created.radiusMeters,
    isActive: created.isActive,
  };

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

/**
 * Purpose: Updates an existing premises location configuration (name, geofence coordinates, radius).
 * How it works: Executes UPDATE query on `premises` table matching `premisesId` and `organizationId`, then publishes `premises_update` domain event.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @param premisesId Target premises UUID.
 * @param input UpdatePremisesInput partial fields.
 * @returns Updated Premises object.
 * @throws AppError 404 if premises location not found.
 */
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
      ...(input.address !== undefined ? { address: input.address } : {}),
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
    address: updated.address ?? null,
    latitude: String(updated.latitude),
    longitude: String(updated.longitude),
    radiusMeters: updated.radiusMeters,
    isActive: updated.isActive,
  };

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
