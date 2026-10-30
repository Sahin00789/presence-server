import { z } from 'zod';

export const shiftSchema = z.object({
  id: z.string(),
  organizationId: z.string().optional(),
  organisationId: z.string().optional(),
  premisesId: z.string(),
  shiftName: z.string(),
  dayName: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  halfDayThreshold: z.string(),
  isActive: z.boolean(),
  createdAt: z.date().or(z.string()).optional().nullable(),
  updatedAt: z.date().or(z.string()).optional().nullable(),
});

export const createShiftSchema = z.object({
  premisesId: z.string().optional().default(''),
  shiftName: z.string().trim().min(1, 'shiftName is required').max(80),
  dayName: z.string().trim().optional().default('Everyday'),
  startTime: z.string().trim(),
  endTime: z.string().trim(),
  halfDayThreshold: z.string().trim().optional().default('11:00:00'),
  isActive: z.boolean().optional().default(true),
});

export const updateShiftSchema = z.object({
  shiftName: z.string().trim().min(1).max(80).optional(),
  dayName: z.string().trim().optional(),
  startTime: z.string().trim().optional(),
  endTime: z.string().trim().optional(),
  halfDayThreshold: z.string().trim().optional(),
  isActive: z.boolean().optional(),
});

export const employeeShiftAssignmentSchema = z.object({
  id: z.string(),
  organizationId: z.string().optional(),
  organisationId: z.string().optional(),
  premisesId: z.string(),
  employeeId: z.string().optional(),
  staffId: z.string().optional(),
  shiftId: z.string(),
  absentPay: z.number().or(z.string()),
  presentPay: z.number().or(z.string()),
  leavePay: z.number().or(z.string()),
  halfDayPay: z.number().or(z.string()),
  isActive: z.boolean(),
  staffName: z.string().optional().nullable(),
  shiftName: z.string().optional().nullable(),
  createdAt: z.date().or(z.string()).optional().nullable(),
  updatedAt: z.date().or(z.string()).optional().nullable(),
});

export const shiftAssignmentSchema = employeeShiftAssignmentSchema;

export const createEmployeeShiftAssignmentSchema = z.object({
  premisesId: z.string().optional().default(''),
  staffId: z.string().optional().default(''),
  employeeId: z.string().optional().default(''),
  shiftId: z.string().min(1, 'shiftId is required'),
  absentPay: z.number().or(z.string()).optional().default(0),
  presentPay: z.number().or(z.string()).optional().default(0),
  leavePay: z.number().or(z.string()).optional().default(0),
  halfDayPay: z.number().or(z.string()).optional().default(0),
  isActive: z.boolean().optional().default(true),
  weeklyOffs: z.array(z.number().int().min(0).max(6)).optional(),
});

export const createShiftAssignmentSchema = createEmployeeShiftAssignmentSchema;

export const updateEmployeeShiftAssignmentSchema = z.object({
  premisesId: z.string().optional(),
  staffId: z.string().optional(),
  employeeId: z.string().optional(),
  shiftId: z.string().optional(),
  absentPay: z.number().or(z.string()).optional(),
  presentPay: z.number().or(z.string()).optional(),
  leavePay: z.number().or(z.string()).optional(),
  halfDayPay: z.number().or(z.string()).optional(),
  isActive: z.boolean().optional(),
  weeklyOffs: z.array(z.number().int().min(0).max(6)).optional(),
});

export const updateShiftAssignmentSchema = updateEmployeeShiftAssignmentSchema;

export type Shift = z.infer<typeof shiftSchema>;
export type CreateShiftInput = z.infer<typeof createShiftSchema>;
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;
export type ShiftAssignment = z.infer<typeof shiftAssignmentSchema>;
export type CreateShiftAssignmentInput = z.infer<typeof createShiftAssignmentSchema>;
