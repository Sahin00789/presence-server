import { z } from 'zod';

export const monthYearQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  premisesId: z.string().uuid().optional(),
  staffProfileId: z.string().uuid().optional(),
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
  amount: z.union([z.string(), z.number()]),
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

export const updateTransactionSchema = z.object({
  amount: z.number().min(0).optional(),
  paymentDate: z.string().optional(),
  paymentMethod: z.string().optional(),
  referenceNumber: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const transactionsQuerySchema = z.object({
  monthlyPayrollId: z.string().uuid(),
});

export const myMonthlyEarningLedgerQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
});

export const myPayslipsQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const downloadPayslipQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  staffProfileId: z.string().uuid().optional(),
});

export const reconcileRequestSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  premisesId: z.string().uuid().optional(),
  staffProfileId: z.string().uuid().optional(),
});

export const unworkedPaymentRuleSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  premisesId: z.string().uuid().nullable().optional(),
  employeeId: z.string().uuid().nullable().optional(),
  dayType: z.enum(['HOLIDAY', 'WEEKLY_OFF']),
  paymentInr: z.number().int().nonnegative(),
  createdAt: z.date().or(z.string()).optional(),
});

export const createUnworkedPaymentRuleSchema = z.object({
  employeeId: z.string().uuid().optional().nullable(),
  premisesId: z.string().uuid().optional().nullable(),
  dayType: z.enum(['HOLIDAY', 'WEEKLY_OFF']),
  paymentInr: z.number().int().nonnegative().optional(),
  paymentCents: z.number().int().nonnegative().optional(),
});

export const unworkedRulesQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  premisesId: z.string().uuid().optional(),
  onDate: z.string().optional(),
});


