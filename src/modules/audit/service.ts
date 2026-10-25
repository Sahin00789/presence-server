import { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import * as schema from '../../db/schema.js';

/** Actions a Manager must not see: owner-only governance and payroll approval. */
const MANAGER_HIDDEN_ACTION_PREFIXES = [
  'ORGANIZATION_',
  'MANAGER_',
  'OWNER_',
  'PAYROLL_APPROVED',
  'PAYROLL_LOCKED',
  'SALARY_',
];

export async function listAuditLogs(
  fastify: FastifyInstance,
  user: { userId: string; role: 'OWNER' | 'MANAGER' | 'STAFF' },
  organizationId: string,
  query: {
    action?: string;
    resourceType?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}
) {
  if (user.role === 'STAFF') {
    return [];
  }

  const conditions = [eq(schema.auditLogs.organizationId, organizationId)];

  if (query.action) {
    conditions.push(eq(schema.auditLogs.action, query.action));
  }
  if (query.resourceType) {
    conditions.push(eq(schema.auditLogs.resourceType, query.resourceType));
  }
  if (query.from) {
    conditions.push(gte(schema.auditLogs.createdAt, new Date(query.from)));
  }
  if (query.to) {
    conditions.push(lte(schema.auditLogs.createdAt, new Date(query.to)));
  }

  const rows = await fastify.db
    .select()
    .from(schema.auditLogs)
    .where(and(...conditions))
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(query.limit ?? 100)
    .offset(query.offset ?? 0);

  const visible =
    user.role === 'MANAGER'
      ? rows.filter(
          (row) =>
            !MANAGER_HIDDEN_ACTION_PREFIXES.some((prefix) => row.action.startsWith(prefix))
        )
      : rows;

  return visible.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
  }));
}
