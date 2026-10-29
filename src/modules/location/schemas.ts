import { z } from 'zod';

export const locationCheckBodySchema = z.object({
  attendanceEventId: z.string().uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().nonnegative(),
  isMock: z.boolean().optional(),
  timestamp: z.string().datetime().optional(),
  /** Client-generated UUID so a retried ping is stored exactly once. */
  clientRequestId: z.string().uuid().optional(),
});

export type LocationCheckBody = z.infer<typeof locationCheckBodySchema>;

export const locationCheckResponseSchema = z.object({
  result: z.enum(['IN_PREMISES', 'OUTSIDE', 'STALE', 'LOW_ACCURACY', 'MOCKED', 'UNKNOWN']),
  consecutiveFailures: z.number().int().nonnegative(),
  exceptionCreated: z.boolean(),
});

export const activeLocationSessionSchema = z.object({
  attendanceEventId: z.string().uuid().nullable(),
  isActive: z.boolean(),
  consecutiveFailures: z.number().int().nonnegative(),
});

export type ActiveLocationSession = z.infer<typeof activeLocationSessionSchema>;

export const gpsPingSummarySchema = z.object({
  id: z.string(),
  checkTime: z.string(),
  distanceMeters: z.number().nullable(),
  accuracyMeters: z.number().nullable(),
  status: z.enum(['Inside', 'Outside', 'Uncertain', 'Stale', 'Mocked', 'No location']),
});

export type GpsPingSummary = z.infer<typeof gpsPingSummarySchema>;

export const gpsCountsSchema = z.object({
  inside: z.number().int().nonnegative(),
  outside: z.number().int().nonnegative(),
  missed: z.number().int().nonnegative(),
});

export type GpsCounts = z.infer<typeof gpsCountsSchema>;

export const locationStaffCardSchema = z.object({
  staffProfileId: z.string(),
  userId: z.string(),
  fullName: z.string(),
  role: z.string().default('STAFF'),
  staffCode: z.string(),
  avatarUrl: z.string().nullable(),
  premisesId: z.string().nullable(),
  premisesName: z.string(),
  attendanceStatus: z.string(),
  locationStatus: z.enum(['Inside', 'Outside', 'GPS Uncertain', 'GPS Unavailable']),
  dayOfWeek: z.string(),
  shiftName: z.string(),
  overtimeName: z.string().nullable(),
  regularShiftStartTime: z.string().nullable(),
  regularShiftEndTime: z.string().nullable(),
  overtimeStartTime: z.string().nullable(),
  overtimeEndTime: z.string().nullable(),
  clockInTime: z.string().nullable(),
  clockOutTime: z.string().nullable(),
  overtimeClockInTime: z.string().nullable(),
  overtimeClockOutTime: z.string().nullable(),
  shiftStatus: z.string(),
  hasOvertimeToday: z.boolean(),
  overtimeId: z.string().uuid().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  exceptionId: z.string().nullable(),
  counts: gpsCountsSchema,
  latestPings: z.array(gpsPingSummarySchema),
});

export type LocationStaffCard = z.infer<typeof locationStaffCardSchema>;

export const locationPresenceQuerySchema = z.object({
  premisesId: z.string().uuid().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type LocationPresenceQuery = z.infer<typeof locationPresenceQuerySchema>;

export const locationTodayPresenceResponseSchema = z.object({
  premisesId: z.string().nullable(),
  premisesName: z.string().nullable(),
  address: z.string().nullable().optional(),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  radiusMeters: z.number().nullable(),
  date: z.string(),
  staff: z.array(locationStaffCardSchema),
});

export type LocationTodayPresenceResponse = z.infer<typeof locationTodayPresenceResponseSchema>;
