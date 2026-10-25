import { FastifyInstance } from 'fastify';
import * as schema from '../../db/schema.js';

export interface AuditEntry {
  organizationId?: string | null;
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Appends an operational audit entry.
 *
 * `docs/SECURITY.md` §4.3 requires every write operation, attendance
 * correction and payroll approval to be auditable. Audit persistence is
 * best-effort: a failure is logged but never aborts the business transaction
 * that produced it, so a transient database hiccup cannot corrupt a payroll
 * run. The business write itself is what must be atomic.
 */
export async function writeAuditLog(
  fastify: FastifyInstance,
  entry: AuditEntry
): Promise<void> {
  try {
    await fastify.db.insert(schema.auditLogs).values({
      organizationId: entry.organizationId ?? null,
      actorId: entry.actorId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    fastify.log.error({ err, entry }, 'Failed to persist audit log entry');
  }
}
