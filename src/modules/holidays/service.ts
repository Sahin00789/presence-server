import { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';

export async function listHolidays(
  fastify: FastifyInstance,
  organizationId: string,
  from?: string,
  to?: string,
  premisesId?: string
) {
  const conditions = [eq(schema.holidayCalendars.organizationId, organizationId)];
  if (from) conditions.push(gte(schema.holidayCalendars.date, from));
  if (to) conditions.push(lte(schema.holidayCalendars.date, to));
  if (premisesId) {
    conditions.push(eq(schema.holidayCalendars.premisesId, premisesId as any));
  }

  const rows = await fastify.db
    .select()
    .from(schema.holidayCalendars)
    .where(and(...conditions))
    .orderBy(asc(schema.holidayCalendars.date));

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    premisesId: (r as any).premisesId ?? null,
    name: r.name,
    date: String(r.date),
    isPaid: r.isPaid,
    createdAt: r.createdAt,
  }));
}

export async function createHoliday(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  input: { name: string; date: string; isPaid: boolean; premisesId?: string }
) {
  if (input.premisesId) {
    const [premise] = await fastify.db
      .select()
      .from(schema.premises)
      .where(and(eq(schema.premises.id, input.premisesId), eq(schema.premises.organizationId, organizationId)))
      .limit(1);
    if (!premise) {
      throw new AppError('Premises not found in this organisation', 404, 'PREMISES_NOT_FOUND');
    }
  }

  const [existing] = await fastify.db
    .select({ id: schema.holidayCalendars.id })
    .from(schema.holidayCalendars)
    .where(
      and(
        eq(schema.holidayCalendars.organizationId, organizationId),
        eq(schema.holidayCalendars.date, input.date),
        input.premisesId ? eq((schema.holidayCalendars as any).premisesId, input.premisesId) : sql`true`
      )
    )
    .limit(1);

  if (existing) {
    throw new AppError('Holiday already exists for this date', 409, 'HOLIDAY_EXISTS');
  }

  const [created] = await fastify.db
    .insert(schema.holidayCalendars)
    .values({
      organizationId,
      name: input.name,
      date: input.date,
      isPaid: input.isPaid,
      ...(input.premisesId ? { premisesId: input.premisesId } : {}),
    } as any)
    .returning();

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'HOLIDAY_CREATED',
    resourceType: 'holiday',
    resourceId: created.id,
    metadata: { name: created.name, date: created.date },
  });

  return {
    id: created.id,
    organizationId: created.organizationId,
    premisesId: (created as any).premisesId ?? null,
    name: created.name,
    date: String(created.date),
    isPaid: created.isPaid,
    createdAt: created.createdAt,
  };
}

export async function updateHoliday(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  holidayId: string,
  input: { name?: string; date?: string; isPaid?: boolean; premisesId?: string | null }
) {
  const [existing] = await fastify.db
    .select()
    .from(schema.holidayCalendars)
    .where(and(eq(schema.holidayCalendars.id, holidayId), eq(schema.holidayCalendars.organizationId, organizationId)))
    .limit(1);

  if (!existing) {
    throw new AppError('Holiday not found', 404, 'HOLIDAY_NOT_FOUND');
  }

  if (input.premisesId) {
    const [premise] = await fastify.db
      .select()
      .from(schema.premises)
      .where(and(eq(schema.premises.id, input.premisesId), eq(schema.premises.organizationId, organizationId)))
      .limit(1);
    if (!premise) {
      throw new AppError('Premises not found in this organisation', 404, 'PREMISES_NOT_FOUND');
    }
  }

  const [updated] = await fastify.db
    .update(schema.holidayCalendars)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.isPaid !== undefined ? { isPaid: input.isPaid } : {}),
      ...(input.premisesId !== undefined ? { premisesId: input.premisesId } : {}),
    } as any)
    .where(eq(schema.holidayCalendars.id, holidayId))
    .returning();

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'HOLIDAY_UPDATED',
    resourceType: 'holiday',
    resourceId: holidayId,
    metadata: input,
  });

  return {
    id: updated.id,
    organizationId: updated.organizationId,
    premisesId: (updated as any).premisesId ?? null,
    name: updated.name,
    date: String(updated.date),
    isPaid: updated.isPaid,
    createdAt: updated.createdAt,
  };
}

export async function deleteHoliday(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  holidayId: string
) {
  await fastify.db
    .delete(schema.holidayCalendars)
    .where(and(eq(schema.holidayCalendars.id, holidayId), eq(schema.holidayCalendars.organizationId, organizationId)));

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'HOLIDAY_DELETED',
    resourceType: 'holiday',
    resourceId: holidayId,
  });

  return { deleted: true };
}
