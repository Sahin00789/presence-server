import { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { addDays } from '../shared/utils/datetime.js';

/**
 * Purpose: Determines the dynamic start date watermark for catch-up background jobs.
 * How it works: Queries MAX(earning_date) from staff_earning_ledger for the given organization.
 * If found, returns MAX(earning_date) - 1 day (safety buffer) bounded to max 14 days lookback.
 * If server was running smoothly, this limits date scanning to 1-2 days instead of 7-14 days.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @param todayISO Today ISO date string.
 * @param defaultLookbackDays Default lookback days if ledger is empty (default 7).
 * @returns Start date string (YYYY-MM-DD) for job scanning.
 */
export async function getWatermarkFromDate(
  fastify: FastifyInstance,
  organizationId: string,
  todayISO: string,
  defaultLookbackDays: number = 7
): Promise<string> {
  try {
    const [maxRow] = await fastify.db
      .select({ maxDate: sql<string>`MAX(${schema.employeeEarningLedger.earningDate})` })
      .from(schema.employeeEarningLedger)
      .where(eq(schema.employeeEarningLedger.organizationId, organizationId));

    if (maxRow?.maxDate) {
      const maxDateStr = String(maxRow.maxDate);
      const watermarkFrom = addDays(maxDateStr, -1);
      const minAllowedFrom = addDays(todayISO, -14);
      return watermarkFrom > minAllowedFrom ? watermarkFrom : minAllowedFrom;
    }
  } catch (_err) {
    // Fallback on query error
  }

  return addDays(todayISO, -defaultLookbackDays);
}
