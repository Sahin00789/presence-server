import { z } from 'zod';

export const salaryStructureSchema = z.object({
  id: z.string().uuid(),
  staffProfileId: z.string().uuid(),
  compensationType: z.enum(['MONTHLY', 'DAILY', 'HOURLY', 'SHIFT', 'MIXED']),
  baseRateCents: z.number().int(),
  overtimeRateCents: z.number().int().default(0),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
});

export const shiftPaymentRuleSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  staffProfileId: z.string().uuid().nullable().optional(),
  shiftTemplateId: z.string().uuid().nullable().optional(),
  attendanceStatus: z.enum(['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT']),
  paymentCents: z.number().int(),
  penaltyCents: z.number().int().default(0),
  effectiveFrom: z.string(),
  createdAt: z.string(),
});

export const createShiftPaymentRuleSchema = z.object({
  staffProfileId: z.string().uuid().optional().nullable(),
  shiftTemplateId: z.string().uuid().optional().nullable(),
  attendanceStatus: z.enum(['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT']).default('PRESENT'),
  paymentCents: z.number().int().min(0),
  penaltyCents: z.number().int().min(0).default(0),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required')
    .optional()
    .default(() => new Date().toISOString().slice(0, 10)),
});

export const unworkedPaymentRuleSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  staffProfileId: z.string().uuid().nullable().optional(),
  dayType: z.enum(['HOLIDAY', 'WEEKLY_OFF', 'PAID_LEAVE']),
  paymentCents: z.number().int(),
  multiplierBasisPoints: z.number().int(),
  effectiveFrom: z.string(),
  createdAt: z.string(),
});

export const createUnworkedPaymentRuleSchema = z.object({
  staffProfileId: z.string().uuid().optional().nullable(),
  dayType: z.enum(['HOLIDAY', 'WEEKLY_OFF', 'PAID_LEAVE']),
  paymentCents: z.number().int().min(0).default(0),
  multiplierBasisPoints: z.number().int().min(0).default(15000),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required')
    .optional()
    .default(() => new Date().toISOString().slice(0, 10)),
});

export type ShiftPaymentRule = z.infer<typeof shiftPaymentRuleSchema>;
export type CreateShiftPaymentRuleInput = z.infer<typeof createShiftPaymentRuleSchema>;
export type UnworkedPaymentRule = z.infer<typeof unworkedPaymentRuleSchema>;
export type CreateUnworkedPaymentRuleInput = z.infer<typeof createUnworkedPaymentRuleSchema>;
