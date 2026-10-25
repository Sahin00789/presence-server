import { z } from 'zod';
import { roleSchema } from '../auth/schemas.js';

export const createInvitationSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  role: z.enum(['MANAGER', 'STAFF']),
  fullName: z.string().trim().min(2).optional(),
  staffCode: z.string().trim().min(2).optional(),
  department: z.string().trim().optional(),
  designation: z.string().trim().optional(),
  premisesId: z.string().uuid().nullable().optional(),
  compensationType: z.enum(['MONTHLY', 'DAILY', 'HOURLY', 'SHIFT', 'MIXED']).optional(),
  baseRateCents: z.number().int().positive().optional(),
});

export const invitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.string(),
  role: roleSchema,
  token: z.string(),
  invitedBy: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(10),
});

export const invitationPreviewSchema = z.object({
  organizationName: z.string(),
  email: z.string(),
  role: roleSchema,
  expiresAt: z.string(),
  isExpired: z.boolean(),
  isAccepted: z.boolean(),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;
