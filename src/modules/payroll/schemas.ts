import { z } from 'zod';

export const monthYearQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  premisesId: z.string().uuid().optional(),
  staffProfileId: z.string().uuid().optional(),
});

export const monthlyAttendanceStatsSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  premisesId: z.string().uuid(),
  staffId: z.string().uuid(),
  month: z.number().int(),
  year: z.number().int(),
  presentShiftsCount: z.number().int(),
  absentShiftsCount: z.number().int(),
  leaveShiftsCount: z.number().int(),
  halfDayShiftsCount: z.number().int(),
  holidayCount: z.number().int(),
  offDayCount: z.number().int(),
  overtimeCount: z.number().int(),
  createdAt: z.date().or(z.string()),
  updatedAt: z.date().or(z.string()),
});

export const monthlyPayrollSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  premisesId: z.string().uuid(),
  staffId: z.string().uuid(),
  staffName: z.string().optional(),
  staffCode: z.string().optional(),
  month: z.number().int(),
  year: z.number().int(),
  earnedAmount: z.string(),
  deductionAmount: z.string(),
  paidAmount: z.string(),
  dueAmount: z.string(),
  status: z.enum(['OPEN', 'FINALIZED', 'PAID']),
  createdAt: z.date().or(z.string()),
  updatedAt: z.date().or(z.string()),
});

export const staffEarningLedgerSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  premisesId: z.string().uuid(),
  staffId: z.string().uuid(),
  earningDate: z.string(),
  type: z.enum(['SHIFT', 'HOLIDAY', 'OFF_DAY', 'OVERTIME']),
  amount: z.string(),
  shiftAssignmentId: z.string().uuid().nullable(),
  attendanceEventId: z.string().uuid().nullable(),
  overtimeId: z.string().uuid().nullable(),
  createdAt: z.date().or(z.string()),
});

export const dailyEarningTotalSchema = z.object({
  earningDate: z.string(),
  totalAmount: z.string(),
  entryCount: z.number().int(),
  entries: z.array(staffEarningLedgerSchema),
});

export const payrollDeductionSchema = z.object({
  id: z.string().uuid(),
  monthlyPayrollId: z.string().uuid(),
  amount: z.string(),
  reason: z.string(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.date().or(z.string()),
});

export const createDeductionSchema = z.object({
  monthlyPayrollId: z.string().uuid(),
  amount: z.number().positive(),
  reason: z.string().min(1),
});

export const updateDeductionSchema = z.object({
  amount: z.number().positive().optional(),
  reason: z.string().min(1).optional(),
});

export const payrollTransactionSchema = z.object({
  id: z.string().uuid(),
  monthlyPayrollId: z.string().uuid(),
  amount: z.string(),
  paymentDate: z.string(),
  paymentMethod: z.string(),
  reference: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.date().or(z.string()),
});

export const recordTransactionSchema = z.object({
  monthlyPayrollId: z.string().uuid(),
  amount: z.number().positive(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethod: z.string().default('MANUAL_BANK_TRANSFER'),
  reference: z.string().optional(),
});

export const reconcileRequestSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  premisesId: z.string().uuid().optional(),
  staffProfileId: z.string().uuid().optional(),
});
