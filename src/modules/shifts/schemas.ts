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

export const shiftTemplateSchema = shiftSchema;

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

export const createShiftTemplateSchema = createShiftSchema;

export const updateShiftSchema = createShiftSchema.partial();
export const updateShiftTemplateSchema = updateShiftSchema;

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

export const weeklyOffSchema = z.object({
  staffProfileId: z.string(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)),
});

export const setWeeklyOffSchema = z.object({
  staffProfileId: z.string().uuid().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7),
});

export const holidaySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  date: z.string(),
  isPaid: z.boolean(),
});

export const createHolidaySchema = z.object({
  name: z.string().trim().min(2).max(120),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  isPaid: z.boolean().default(true),
});

export const scheduleEntrySchema = z.object({
  date: z.string(),
  dayOfWeek: z.number(),
  type: z.enum(['SHIFT', 'WEEKLY_OFF', 'HOLIDAY', 'UNSCHEDULED']),
  shiftTemplateId: z.string().nullable(),
  shiftName: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  breakMinutes: z.number().nullable(),
  lateGraceMinutes: z.number().nullable(),
  halfDayThresholdMinutes: z.number().nullable(),
  scheduledMinutes: z.number(),
  overnight: z.boolean(),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  holidayName: z.string().nullable(),
  isPaidHoliday: z.boolean().nullable(),
  lateClockInAllowed: z.boolean().nullable().optional(),
});

export const scheduleQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  staffProfileId: z.string().uuid().optional(),
});

export type ShiftTemplate = z.infer<typeof shiftTemplateSchema>;
export type CreateShiftTemplateInput = z.infer<typeof createShiftTemplateSchema>;
export type UpdateShiftTemplateInput = z.infer<typeof updateShiftTemplateSchema>;
export type ShiftAssignment = z.infer<typeof shiftAssignmentSchema>;
export type CreateShiftAssignmentInput = z.infer<typeof createShiftAssignmentSchema>;
export type Holiday = z.infer<typeof holidaySchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;
export type ScheduleQuery = z.infer<typeof scheduleQuerySchema>;
