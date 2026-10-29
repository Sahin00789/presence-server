import { z } from 'zod';
import { roleSchema } from '../auth/schemas.js';

export const createEmployeeSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  role: z.enum(['MANAGER', 'STAFF']),
  fullName: z.string().trim().min(2).optional(),
  staffCode: z.string().trim().min(2).optional(),
  department: z.string().trim().optional(),
  designation: z.string().trim().optional(),
  premisesId: z.string().uuid().nullable().optional(),
});

export const employeeDtoSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  userId: z.string(),
  email: z.string(),
  fullName: z.string(),
  staffCode: z.string(),
  department: z.string().nullable(),
  designation: z.string().nullable(),
  role: roleSchema,
  token: z.string().nullable(),
  addedBy: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  expiresAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
  premisesId: z.string().uuid().nullable().optional(),
  premisesName: z.string().nullable().optional(),
  hireDate: z.string(),
  isActive: z.boolean(),
  earnedBalanceCents: z.number().int(),
  approvedUnpaidBalanceCents: z.number().int(),
  paidBalanceCents: z.number().int(),
});




export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type EmployeeDto = z.infer<typeof employeeDtoSchema>;
