import { z } from 'zod';

export const overtimeStatusSchema = z.enum([
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);

export const overtimeSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  staffProfileId: z.string().uuid(),
  staffName: z.string(),
  staffEmail: z.string(),
  staffCode: z.string(),
  requestedBy: z.string().uuid(),
  approvedBy: z.string().uuid().nullable(),
  workDate: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  plannedMinutes: z.number().int(),
  workedMinutes: z.number().int(),
  paymentCents: z.number().int(),
  status: overtimeStatusSchema,
  reason: z.string().nullable(),
  attendanceEventId: z.string().uuid().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const createOvertimeSchema = z.object({
  /** Target staff member. Omit to create the overtime for yourself. */
  staffProfileId: z.string().uuid().optional(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  /** Agreed payment for the overtime, in minor units. */
  paymentCents: z.number().int().positive(),
  reason: z.string().trim().min(2).max(500),
});

export const reviewOvertimeSchema = z.object({
  approved: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

export const overtimeListQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  staffProfileId: z.string().uuid().optional(),
  status: overtimeStatusSchema.optional(),
});

export type Overtime = z.infer<typeof overtimeSchema>;
export type CreateOvertimeInput = z.infer<typeof createOvertimeSchema>;
export type OvertimeStatus = z.infer<typeof overtimeStatusSchema>;
