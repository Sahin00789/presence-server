import { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { postHolidayAndWeeklyOffEarnings } from '../../jobs/holidayWeeklyOffEarnings.js';

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
    conditions.push(eq(schema.holidayCalendars.premisesId, premisesId));
  }

  const rows = await fastify.db
    .select()
    .from(schema.holidayCalendars)
    .where(and(...conditions))
    .orderBy(asc(schema.holidayCalendars.date));

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    premisesId: r.premisesId,
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
  input: { name: string; date: string; premisesId: string; isPaid?: boolean }
) {
  if (!input.premisesId) {
    throw new AppError('Premises ID is required for a holiday', 400, 'PREMISES_REQUIRED');
  }

  const [premise] = await fastify.db
    .select()
    .from(schema.premises)
    .where(and(eq(schema.premises.id, input.premisesId), eq(schema.premises.organizationId, organizationId)))
    .limit(1);
  if (!premise) {
    throw new AppError('Premises not found in this organisation', 404, 'PREMISES_NOT_FOUND');
  }

  const [existing] = await fastify.db
    .select({ id: schema.holidayCalendars.id })
    .from(schema.holidayCalendars)
    .where(
      and(
        eq(schema.holidayCalendars.organizationId, organizationId),
        eq(schema.holidayCalendars.premisesId, input.premisesId),
        eq(schema.holidayCalendars.date, input.date)
      )
    )
    .limit(1);

  if (existing) {
    throw new AppError('Holiday already exists for this date at this premises', 409, 'HOLIDAY_EXISTS');
  }

  const [created] = await fastify.db
    .insert(schema.holidayCalendars)
    .values({
      organizationId,
      premisesId: input.premisesId,
      name: input.name,
      date: input.date,
      isPaid: input.isPaid ?? true,
    })
    .returning();

  postHolidayAndWeeklyOffEarnings(fastify).catch(() => {});

  return {
    id: created.id,
    organizationId: created.organizationId,
    premisesId: created.premisesId,
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
  input: { name?: string; date?: string; isPaid?: boolean; premisesId?: string }
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

  const targetPremisesId = input.premisesId ?? existing.premisesId;
  const targetDate = input.date ?? existing.date;

  if (targetPremisesId !== existing.premisesId || targetDate !== existing.date) {
    const [duplicate] = await fastify.db
      .select({ id: schema.holidayCalendars.id })
      .from(schema.holidayCalendars)
      .where(
        and(
          eq(schema.holidayCalendars.organizationId, organizationId),
          eq(schema.holidayCalendars.premisesId, targetPremisesId),
          eq(schema.holidayCalendars.date, targetDate)
        )
      )
      .limit(1);
    if (duplicate && duplicate.id !== holidayId) {
      throw new AppError('Holiday already exists for this date at this premises', 409, 'HOLIDAY_EXISTS');
    }
  }

  const [updated] = await fastify.db
    .update(schema.holidayCalendars)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.isPaid !== undefined ? { isPaid: input.isPaid } : {}),
      ...(input.premisesId !== undefined ? { premisesId: input.premisesId } : {}),
    })
    .where(eq(schema.holidayCalendars.id, holidayId))
    .returning();

  return {
    id: updated.id,
    organizationId: updated.organizationId,
    premisesId: updated.premisesId,
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

  return { deleted: true };
}
