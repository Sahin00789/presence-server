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

export const auditReportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  format: reportFormatSchema,
});

export const dashboardSummarySchema = z.object({
  role: z.enum(['OWNER', 'MANAGER', 'STAFF']),
  generatedAt: z.string(),
  organization: z.object({
    staffCount: z.number().int().optional(),
    presentToday: z.number().int().optional(),
    lateToday: z.number().int().optional(),
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
