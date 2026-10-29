import { z } from 'zod';
import { roleSchema } from '../auth/schemas.js';

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  logoUrl: z.string().nullable().optional(),
  timezone: z.string(),
  currency: z.string(),
  createdAt: z.string(),
});

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.string().trim().min(1).default('Asia/Kolkata'),
  currency: z.string().trim().length(3).default('INR'),
  premisesName: z.string().trim().min(2).optional(),
  premisesAddress: z.string().optional(),
  latitude: z.string().trim().optional(),
  longitude: z.string().trim().optional(),
  radiusMeters: z.number().int().min(10).max(10_000).optional(),
});

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  timezone: z.string().trim().min(1).optional(),
  currency: z.string().trim().length(3).optional(),
  logoUrl: z.string().nullable().optional(),
  logo: z.string().optional(),
});

export const memberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  fullName: z.string(),
  avatarUrl: z.string().nullable(),
  role: roleSchema,
  isActive: z.boolean(),
  joinedAt: z.string(),
  staffProfileId: z.string().nullable(),
  staffCode: z.string().nullable(),
  premisesId: z.string().nullable().optional(),
  premisesName: z.string().nullable().optional(),
});

export const organizationSummarySchema = z.object({
  organization: organizationSchema,
  memberCount: z.number(),
  staffCount: z.number(),
  managerCount: z.number(),
});

export type Organization = z.infer<typeof organizationSchema>;
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type OrganizationMember = z.infer<typeof memberSchema>;
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;
