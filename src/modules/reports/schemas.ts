import { z } from 'zod';

export const reportFormatSchema = z.enum(['json', 'csv', 'pdf']).default('json');

export const reportRangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  staffProfileId: z.string().uuid().optional(),
  format: reportFormatSchema,
});

export const payrollReportQuerySchema = z.object({
  format: reportFormatSchema,
});

export const monthlyReportSummaryQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  premisesId: z.string().uuid().optional(),
});

export const monthlyReportSummaryResponseSchema = z.object({
  month: z.number().int(),
  year: z.number().int(),
  premisesId: z.string().nullable(),
  totalStaff: z.number().int(),
  totalRecords: z.number().int(),
  presentCount: z.number().int(),
  absentCount: z.number().int(),
  halfDayCount: z.number().int(),
  leaveCount: z.number().int(),
  lateCount: z.number().int(),
  totalWorkedMinutes: z.number().int(),
  totalLateMinutes: z.number().int(),
  attendanceRate: z.number().int(),
  financials: z.object({
    totalEarnedInr: z.number().int(),
    totalPaidInr: z.number().int(),
    totalDueInr: z.number().int(),
  }),
});

export const dashboardSummarySchema = z.object({
  role: z.enum(['OWNER', 'EMPLOYEE']),
  generatedAt: z.string(),
  organization: z.object({
    staffCount: z.number().int().optional(),
    presentToday: z.number().int().optional(),
    absentToday: z.number().int().optional(),
    leaveToday: z.number().int().optional(),
    openExceptions: z.number().int().optional(),
    pendingLeaveRequests: z.number().int().optional(),
    latestPayrollPeriod: z
      .object({
        id: z.string().uuid(),
        status: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        netSalaryPaise: z.number().int(),
      })
      .nullable()
      .optional(),
  }),
  me: z
    .object({
      staffProfileId: z.string().uuid(),
      staffCode: z.string(),
      status: z.string().nullable(),
      clockIn: z.date().or(z.string()).nullable(),
      clockOut: z.date().or(z.string()).nullable(),
      monthSummary: z.record(z.string(), z.number()),
      todayShift: z
        .object({
          type: z.string(),
          startTime: z.string().nullable(),
          endTime: z.string().nullable(),
          startAt: z.string().nullable(),
          endAt: z.string().nullable(),
        })
        .nullable(),
    })
    .optional(),
});
