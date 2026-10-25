import { z } from 'zod';

export const staffSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  fullName: z.string(),
  staffCode: z.string(),
  department: z.string().nullable(),
  designation: z.string().nullable(),
  premisesId: z.string().nullable(),
  premisesName: z.string().nullable(),
  hireDate: z.string(),
  isActive: z.boolean(),
  /** Latest effective compensation plan (null when never configured). */
  compensationType: z
    .enum(['MONTHLY', 'DAILY', 'HOURLY', 'SHIFT', 'MIXED'])
    .nullable(),
  baseRateCents: z.number().int().nullable(),
  overtimeRateCents: z.number().int().nullable(),
  /** Wallet balances derived from the append-only ledger. */
  earnedBalanceCents: z.number().int(),
  approvedUnpaidBalanceCents: z.number().int(),
  paidBalanceCents: z.number().int(),
  totalBalanceCents: z.number().int(),
});

export const inviteStaffSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  fullName: z.string().trim().min(2),
  staffCode: z.string().trim().min(2),
  department: z.string().trim().optional(),
  designation: z.string().trim().optional(),
  role: z.enum(['MANAGER', 'STAFF']).optional().default('STAFF'),
  premisesId: z.string().uuid().nullable().optional(),
});

export const assignStaffPremisesSchema = z.object({
  premisesId: z.string().uuid().nullable(),
});

export const upsertSalarySchema = z.object({
  compensationType: z.enum(['MONTHLY', 'DAILY', 'HOURLY', 'SHIFT', 'MIXED']),
  baseRateCents: z.number().int().nonnegative(),
  overtimeRateCents: z.number().int().nonnegative().default(0),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const salaryStructureSchema = z.object({
  id: z.string().uuid(),
  staffProfileId: z.string().uuid(),
  compensationType: z.enum(['MONTHLY', 'DAILY', 'HOURLY', 'SHIFT', 'MIXED']),
  baseRateCents: z.number().int(),
  overtimeRateCents: z.number().int(),
  effectiveFrom: z.string(),
});

export type Staff = z.infer<typeof staffSchema>;
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;
export type AssignStaffPremisesInput = z.infer<typeof assignStaffPremisesSchema>;
export type UpsertSalaryInput = z.infer<typeof upsertSalarySchema>;
export type SalaryStructure = z.infer<typeof salaryStructureSchema>;
