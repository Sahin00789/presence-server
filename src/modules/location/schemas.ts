import { z } from 'zod';

export const activeLocationSessionResponseSchema = z.object({
  attendanceEventId: z.string().nullable().optional(),
  isActive: z.boolean(),
  consecutiveFailures: z.number(),
});

export const locationStaffCardSchema = z.object({
  staffProfileId: z.string(),
  userId: z.string().optional(),
  fullName: z.string(),
  staffCode: z.string().nullable().optional(),
  role: z.string().optional(),
  premisesId: z.string().nullable().optional(),
  premisesName: z.string().nullable().optional(),
  attendanceStatus: z.string().optional(),
  locationStatus: z.string(),
  dayOfWeek: z.string().optional(),
  shiftName: z.string().nullable().optional(),
  assignedStartTime: z.string().nullable().optional(),
  assignedEndTime: z.string().nullable().optional(),
  regularShiftStartTime: z.string().nullable().optional(),
  regularShiftEndTime: z.string().nullable().optional(),
  hasOvertimeToday: z.boolean().optional(),
  overtimeId: z.string().nullable().optional(),
  overtimeName: z.string().nullable().optional(),
  overtimeStartTime: z.string().nullable().optional(),
  overtimeEndTime: z.string().nullable().optional(),
  overtimeClockInTime: z.string().nullable().optional(),
  overtimeClockOutTime: z.string().nullable().optional(),
  attendanceEventId: z.string().nullable().optional(),
  clockInTime: z.string().nullable().optional(),
  clockOutTime: z.string().nullable().optional(),
  consecutiveFailures: z.number(),
  exceptionId: z.string().nullable().optional(),
  earnedAmountPaise: z.number(),
  counts: z.object({
    inside: z.number(),
    outside: z.number(),
    missed: z.number(),
  }),
  latestPings: z.array(
    z.object({
      id: z.string(),
      timestamp: z.string(),
      latitude: z.number(),
      longitude: z.number(),
      isInsideGeofence: z.boolean(),
    })
  ),
});

export const todayLocationPresenceResponseSchema = z.object({
  premisesId: z.string().nullable().optional(),
  premisesName: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  radiusMeters: z.number().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  summaryDate: z.string(),
  date: z.string(),
  totalActiveStaff: z.number(),
  totalClockedIn: z.number(),
  outsideGeofenceCount: z.number(),
  staffCards: z.array(locationStaffCardSchema),
  staff: z.array(locationStaffCardSchema),
});
