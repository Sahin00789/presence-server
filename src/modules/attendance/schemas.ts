import { z } from 'zod';
import { livenessEvidenceSchema } from '../biometrics/schemas.js';

export const clockInSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().nonnegative(),
  /** The on-device engine reports its own result for UX, but the server never trusts it. */
  faceVerified: z.boolean().optional(),
  faceScore: z.number().min(0).max(1).optional(),
  /** 128/512-dimensional face embedding produced by the on-device ONNX model. */
  embeddingVector: z.array(z.number()).optional(),
  premisesId: z.string().uuid().optional(),
  timestamp: z.string().datetime().optional(),
  /** Android passes this so the server can reject mocked location providers. */
  isMocked: z.boolean().optional(),
  /** Active blink + passive texture evidence from the on-device pipeline. */
  liveness: livenessEvidenceSchema.optional(),
  /** Check in for an approved overtime entry instead of the regular shift. */
  overtimeId: z.string().uuid().optional(),
});

export const manualClockInSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().nonnegative(),
  reason: z.string().min(5).max(500),
  timestamp: z.string().datetime().optional(),
  premisesId: z.string().uuid().optional(),
});

export const clockOutSchema = z.object({
  attendanceEventId: z.string().uuid().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyMeters: z.number().nonnegative().optional(),
  timestamp: z.string().datetime().optional(),
});

/**
 * Attendance event as returned to the client (camelCase).
 */
export const attendanceEventSchema = z.object({
  id: z.string().uuid(),
  staffProfileId: z.string().uuid(),
  clockIn: z.date().or(z.string()).nullable().optional(),
  clockOut: z.date().or(z.string()).nullable().optional(),
  status: z.string(),
  workDate: z.string().nullable().optional(),
  faceVerified: z.boolean().optional(),
  geofenceVerified: z.boolean().optional(),
  workedMinutes: z.number().int().optional(),
  scheduledMinutes: z.number().int().optional(),
  premisesId: z.string().uuid().nullable().optional(),
  overtimeId: z.string().uuid().nullable().optional(),
});

export const attendanceRecordSchema = z.object({
  id: z.string().uuid(),
  staffProfileId: z.string().uuid(),
  staffName: z.string().optional(),
  staffEmail: z.string().optional(),
  staffCode: z.string().optional(),
  workDate: z.string().nullable().optional(),
  clockIn: z.date().or(z.string()).nullable().optional(),
  clockOut: z.date().or(z.string()).nullable().optional(),
  status: z.string(),
  faceVerified: z.boolean().optional(),
  geofenceVerified: z.boolean().optional(),
  workedMinutes: z.number().int().optional(),
  overtimeMinutes: z.number().int().optional(),
  scheduledMinutes: z.number().int().optional(),
  premisesId: z.string().uuid().nullable().optional(),
  overtimeId: z.string().uuid().nullable().optional(),
});

export const attendanceRecordsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  staffProfileId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const exceptionSchema = z.object({
  id: z.string().uuid(),
  attendanceEventId: z.string().uuid(),
  reason: z.enum(['THREE_GPS_FAILURES', 'FACE_MISMATCH', 'OUTSIDE_GEOFENCE']),
  status: z.enum(['OPEN', 'RESOLVED', 'REJECTED']),
  createdAt: z.date().or(z.string()),
  staffProfileId: z.string().uuid().optional(),
  staffName: z.string().optional(),
  staffEmail: z.string().optional(),
  staffCode: z.string().optional(),
});

export const resolveExceptionSchema = z.object({
  correctedStatus: z.enum(['PRESENT', 'ABSENT', 'HALF_DAY', 'LATE', 'HOLIDAY', 'RESUME']),
  reason: z.string().min(2),
  note: z.string().optional(),
});

export const dailyAttendanceSchema = z.object({
  id: z.string().uuid(),
  organisationId: z.string().uuid().optional(),
  premisesId: z.string().uuid(),
  staffId: z.string().uuid(),
  shiftAssignmentId: z.string().uuid(),
  workDate: z.string(),
  attendanceStatus: z.enum(['PRESENT', 'ABSENT', 'LEAVE', 'HALF_DAY']),
  clockInAt: z.date().or(z.string()).nullable().optional(),
  clockOutAt: z.date().or(z.string()).nullable().optional(),
  insidePingCount: z.number().int(),
  outsidePingCount: z.number().int(),
  paymentAmount: z.number().or(z.string()),
  statusUpdatedBy: z.string().uuid().nullable().optional(),
  remarks: z.string().nullable().optional(),
  staffName: z.string().optional(),
  staffCode: z.string().optional(),
  shiftName: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  halfDayThreshold: z.string().optional(),
});

export const correctDailyAttendanceSchema = z.object({
  attendanceStatus: z.enum(['PRESENT', 'ABSENT', 'LEAVE', 'HALF_DAY']),
  remarks: z.string().trim().max(500).optional(),
  overridePaymentAmount: z.number().min(0).optional(),
});
