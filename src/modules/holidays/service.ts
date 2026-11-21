import { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { postHolidayAndWeeklyOffEarnings } from '../../jobs/holidayWeeklyOffEarnings.js';

/**
 * Purpose: Retrieves a list of holiday calendar entries for an organization.
 * How it works: Queries `holidayCalendars` filtered by `organizationId`, optional date range (`from`/`to`), and `premisesId`.
 * Returns sorted array ordered by holiday date.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @param from Optional start date filter (YYYY-MM-DD).
 * @param to Optional end date filter (YYYY-MM-DD).
 * @param premisesId Optional premises UUID filter.
 * @returns Array of formatted holiday objects.
 */
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

/**
 * Purpose: Creates a new holiday calendar entry for a specific premises.
 * How it works: Validates premises existence and checks for duplicate holidays on the same date/premises.
 * Inserts new holiday row into `holidayCalendars` and triggers asynchronous holiday earnings calculation job.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @param actorUserId User ID creating the holiday.
 * @param input Input object containing `name`, `date`, `premisesId`, and optional `isPaid`.
 * @returns Created holiday object.
 * @throws AppError 400 if premises ID missing; 404 if premises not found; 409 if holiday exists on that date.
 */
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

/**
 * Purpose: Updates an existing holiday calendar entry.
 * How it works: Validates holiday existence, verifies target premises if changed, prevents conflicts on date/premises,
 * and updates specified fields in `holidayCalendars`.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @param actorUserId User ID performing update.
 * @param holidayId Holiday entry UUID.
 * @param input Partial fields to update (`name`, `date`, `isPaid`, `premisesId`).
 * @returns Updated holiday object.
 * @throws AppError 404 if holiday or premises not found; 409 if duplicate holiday exists.
 */
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

/**
 * Purpose: Deletes a holiday calendar entry from an organization.
 * How it works: Deletes row from `holidayCalendars` matching `holidayId` and `organizationId`.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @param actorUserId User ID performing deletion.
 * @param holidayId Holiday entry UUID to remove.
 * @returns Object `{ deleted: true }`.
 */
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
