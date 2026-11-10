import { z } from 'zod';
import { roleSchema, normalizedEmailSchema } from '../auth/schemas.js';

export const createEmployeeSchema = z.object({
  email: normalizedEmailSchema,
  role: z.preprocess(
    (val) => (val === 'STAFF' || val === 'MANAGER' ? 'EMPLOYEE' : val),
    z.enum(['EMPLOYEE']).optional().default('EMPLOYEE')
  ),
  fullName: z.string().trim().min(2).optional(),
  staffCode: z.string().trim().min(2).optional(),
  department: z.string().trim().optional(),
  designation: z.string().trim().optional(),
  premisesId: z.string().uuid().nullable().optional(),
  phone: z.string().trim().optional(),
  address: z.string().trim().optional(),
  avatarBase64: z.string().optional(),
  avatarUrl: z.string().optional(),
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
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
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
  earnedBalancePaise: z.number().int(),
  approvedUnpaidBalancePaise: z.number().int(),
  paidBalancePaise: z.number().int(),
});

export const updateEmployeeSchema = z.object({
  email: z
    .preprocess(
      (val) => (typeof val === 'string' && val.trim() === '' ? null : val),
      normalizedEmailSchema.nullable().optional()
    ),
  fullName: z.string().trim().min(2).optional(),
  department: z.string().trim().nullable().optional(),
  designation: z.string().trim().nullable().optional(),
  premisesId: z.string().uuid().nullable().optional(),
  phone: z.string().trim().nullable().optional(),
  address: z.string().trim().nullable().optional(),
  avatarBase64: z.string().optional(),
  avatarUrl: z.string().nullable().optional(),
});

export const uploadEmployeePhotoSchema = z.object({
  photoBase64: z.string().optional(),
  photoUrl: z.string().optional(),
  avatarBase64: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type EmployeeDto = z.infer<typeof employeeDtoSchema>;
export type UploadEmployeePhotoInput = z.infer<typeof uploadEmployeePhotoSchema>;
