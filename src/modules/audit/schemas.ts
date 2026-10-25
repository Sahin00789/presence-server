import { z } from 'zod';

export const auditLogSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid().nullable(),
  actorId: z.string().uuid().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().uuid().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.date().or(z.string()),
});

export const auditLogsQuerySchema = z.object({
  action: z.string().trim().min(1).max(120).optional(),
  resourceType: z.string().trim().min(1).max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
