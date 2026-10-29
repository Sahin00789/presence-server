import { z } from 'zod';

export const shiftSchema = z.object({
  id: z.string().uuid(),
  organisationId: z.string().uuid(),
  premisesId: z.string().uuid(),
  shiftName: z.string(),
  dayName: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  halfDayThreshold: z.string(),
  isActive: z.boolean(),
  createdAt: z.date().or(z.string()).optional(),
  updatedAt: z.date().or(z.string()).optional(),
});

export const createShiftSchema = z.object({
  premisesId: z.string().uuid(),
  shiftName: z.string().trim().min(2).max(80),
  dayName: z.string().trim().default('Everyday'),
  startTime: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'startTime must be HH:MM or HH:MM:SS'),
  endTime: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'endTime must be HH:MM or HH:MM:SS'),
  halfDayThreshold: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'halfDayThreshold must be HH:MM or HH:MM:SS'),
  isActive: z.boolean().optional().default(true),
});

export const updateShiftSchema = createShiftSchema.partial();

export const employeeShiftAssignmentSchema = z.object({
  id: z.string().uuid(),
  organisationId: z.string().uuid(),
  premisesId: z.string().uuid(),
  staffId: z.string().uuid(),
  shiftId: z.string().uuid(),
  absentPay: z.number().or(z.string()),
  presentPay: z.number().or(z.string()),
  leavePay: z.number().or(z.string()),
  halfDayPay: z.number().or(z.string()),
  isActive: z.boolean(),
  staffName: z.string().optional(),
  shiftName: z.string().optional(),
  createdAt: z.date().or(z.string()).optional(),
  updatedAt: z.date().or(z.string()).optional(),
});

export const shiftAssignmentSchema = employeeShiftAssignmentSchema;

export const createEmployeeShiftAssignmentSchema = z.object({
  premisesId: z.string().uuid(),
  staffId: z.string().uuid(),
  shiftId: z.string().uuid(),
  absentPay: z.number().min(0, 'absentPay must be non-negative').default(0),
  presentPay: z.number().min(0, 'presentPay must be non-negative').default(0),
  leavePay: z.number().min(0, 'leavePay must be non-negative').default(0),
  halfDayPay: z.number().min(0, 'halfDayPay must be non-negative').default(0),
  isActive: z.boolean().optional().default(true),
});

export const createShiftAssignmentSchema = createEmployeeShiftAssignmentSchema;

export const updateEmployeeShiftAssignmentSchema = createEmployeeShiftAssignmentSchema.partial();
export const updateShiftAssignmentSchema = updateEmployeeShiftAssignmentSchema;

export type Shift = z.infer<typeof shiftSchema>;
export type CreateShiftInput = z.infer<typeof createShiftSchema>;
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;
export type ShiftAssignment = z.infer<typeof shiftAssignmentSchema>;
export type CreateShiftAssignmentInput = z.infer<typeof createShiftAssignmentSchema>;
