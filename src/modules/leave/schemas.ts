import { z } from 'zod';

export const createLeaveRequestSchema = z.object({
  shiftAssignmentId: z.string().uuid(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'workDate must be in YYYY-MM-DD format'),
  reason: z.string().trim().min(2, 'Reason must be at least 2 characters').max(1000),
});

export const reviewLeaveRequestSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reviewRemarks: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(1000).optional(),
});

export const leaveRequestSchema = z.object({
  id: z.string().uuid(),
  organisationId: z.string().uuid(),
  organizationId: z.string().uuid(),
  premisesId: z.string().uuid(),
  premisesName: z.string(),
  staffId: z.string().uuid(),
  staffProfileId: z.string().uuid(),
  staffName: z.string(),
  staffCode: z.string(),
  shiftAssignmentId: z.string().uuid(),
  shiftName: z.string(),
  shiftHours: z.string(),
  workDate: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  reason: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']),
  reviewedBy: z.string().uuid().nullable().optional(),
  reviewedByName: z.string().nullable().optional(),
  reviewedAt: z.date().or(z.string()).nullable().optional(),
  reviewRemarks: z.string().nullable().optional(),
  reviewNote: z.string().nullable().optional(),
  createdAt: z.date().or(z.string()),
  updatedAt: z.date().or(z.string()),
});

export const leaveRequestsQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  premisesId: z.string().uuid().optional(),
  staffId: z.string().uuid().optional(),
  staffProfileId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;
export type ReviewLeaveRequestInput = z.infer<typeof reviewLeaveRequestSchema>;
