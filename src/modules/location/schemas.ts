import { z } from 'zod';

export const locationCheckBodySchema = z.object({
  attendanceEventId: z.string().optional(),
  shiftAttendanceId: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  accuracyMeters: z.number(),
  isMock: z.boolean().optional(),
  timestamp: z.string().optional(),
  clientRequestId: z.string().optional(),
});

export const locationCheckResponseSchema = z.object({
  success: z.boolean(),
  result: z.string().optional(),
});

export const activeLocationSessionResponseSchema = z.object({
  attendanceEventId: z.string().nullable().optional(),
  isActive: z.boolean(),
  consecutiveFailures: z.number(),
});

export const locationStaffCardSchema = z.object({
  staffProfileId: z.string(),
  fullName: z.string(),
  staffCode: z.string().nullable().optional(),
  premisesId: z.string().nullable().optional(),
  premisesName: z.string().nullable().optional(),
  shiftName: z.string().nullable().optional(),
  assignedStartTime: z.string().nullable().optional(),
  assignedEndTime: z.string().nullable().optional(),
  attendanceEventId: z.string().nullable().optional(),
  clockInTime: z.string().nullable().optional(),
  clockOutTime: z.string().nullable().optional(),
  locationStatus: z.string(),
  consecutiveFailures: z.number(),
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
