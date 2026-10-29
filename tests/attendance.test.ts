import { describe, expect, it } from 'vitest';
import {
  halfDayThresholdMinutes,
  isPendingReview,
  resolveClockOutResult,
  isMissingPing,
  resolveFinalShiftStatus,
  shouldFinalizeAt,
} from '../src/modules/attendance/service.js';
import { shouldRaiseOutsideAlert } from '../src/modules/location/service.js';
import { locationCheckBodySchema } from '../src/modules/location/schemas.js';
import {
  resolveShiftWindow,
  toDateISOInTimeZone,
} from '../src/shared/utils/datetime.js';

describe('Attendance status rules', () => {
  it('marks a short shift as HALF_DAY and keeps LATE otherwise', () => {
    const halfDay = resolveClockOutResult({
      attendanceType: 'SHIFT',
      existingStatus: 'LATE',
      workedMinutes: 120,
      scheduledMinutes: 480,
      halfDayThresholdMinutes: 240,
    });
    expect(halfDay.status).toBe('HALF_DAY');
    expect(halfDay.earlyDeparture).toBe(true);
    expect(halfDay.overtimeMinutes).toBe(0);

    const late = resolveClockOutResult({
      attendanceType: 'SHIFT',
      existingStatus: 'LATE',
      workedMinutes: 480,
      scheduledMinutes: 480,
      halfDayThresholdMinutes: 240,
    });
    expect(late.status).toBe('LATE');
    expect(late.earlyDeparture).toBe(false);

    const present = resolveClockOutResult({
      attendanceType: 'SHIFT',
      existingStatus: 'PRESENT',
      workedMinutes: 500,
      scheduledMinutes: 480,
      halfDayThresholdMinutes: 240,
    });
    expect(present.status).toBe('PRESENT');
    expect(present.overtimeMinutes).toBe(20);
  });

  it('always completes overtime as PRESENT and counts all minutes', () => {
    const result = resolveClockOutResult({
      attendanceType: 'OVERTIME',
      existingStatus: 'LATE',
      workedMinutes: 90,
      scheduledMinutes: 60,
      halfDayThresholdMinutes: 30,
    });
    expect(result.status).toBe('PRESENT');
    expect(result.overtimeMinutes).toBe(90);
    expect(result.earlyDeparture).toBe(false);
  });

  it('uses the real shift half-day threshold', () => {
    expect(halfDayThresholdMinutes('09:00', '13:00')).toBe(240);
    expect(halfDayThresholdMinutes('22:00', '02:00')).toBe(240);
  });

  it('treats SCHEDULED as pending manual review', () => {
    expect(isPendingReview('SCHEDULED')).toBe(true);
    expect(isPendingReview('PRESENT')).toBe(false);
  });

  it('never auto-absents a completed shift and preserves manual corrections', () => {
    expect(
      resolveFinalShiftStatus({
        workedMinutes: 480,
        halfDayThresholdMinutes: 240,
        currentStatus: 'PRESENT',
        corrected: false,
      })
    ).toBe('PRESENT');

    expect(
      resolveFinalShiftStatus({
        workedMinutes: 480,
        halfDayThresholdMinutes: 240,
        currentStatus: 'LATE',
        corrected: false,
      })
    ).toBe('LATE');

    expect(
      resolveFinalShiftStatus({
        workedMinutes: 60,
        halfDayThresholdMinutes: 240,
        currentStatus: 'PRESENT',
        corrected: false,
      })
    ).toBe('HALF_DAY');

    expect(
      resolveFinalShiftStatus({
        workedMinutes: 480,
        halfDayThresholdMinutes: 240,
        currentStatus: 'PRESENT',
        corrected: true,
      })
    ).toBe('PRESENT');
  });

  it('finalizes only after the shift end plus grace period', () => {
    const end = new Date('2026-10-26T12:00:00.000Z');
    expect(shouldFinalizeAt(end, new Date('2026-10-26T11:59:00.000Z'))).toBe(
      false
    );
    expect(shouldFinalizeAt(end, new Date('2026-10-26T12:00:30.000Z'))).toBe(
      false
    );
    expect(shouldFinalizeAt(end, new Date('2026-10-26T12:01:30.000Z'))).toBe(
      true
    );
  });
});

describe('Attendance work date and timezone', () => {
  it('keeps an overnight shift attributed to its start date', () => {
    const window = resolveShiftWindow(
      '2026-10-31',
      '22:00',
      '06:00',
      0,
      'Asia/Kolkata'
    );
    expect(window.workDate).toBe('2026-10-31');
    expect(window.overnight).toBe(true);
    expect(window.scheduledMinutes).toBe(480);
    expect(window.startAt.toISOString()).toBe('2026-10-31T16:30:00.000Z');
    expect(window.endAt.toISOString()).toBe('2026-11-01T00:30:00.000Z');
  });

  it('resolves the work date in the organization timezone, not the UTC day', () => {
    const instant = new Date('2026-10-26T20:30:00.000Z');
    expect(toDateISOInTimeZone(instant, 'UTC')).toBe('2026-10-26');
    expect(toDateISOInTimeZone(instant, 'Asia/Kolkata')).toBe('2026-10-27');
  });
});

describe('GPS monitoring rules', () => {
  it('raises the outside alert only after more than three failures', () => {
    expect(shouldRaiseOutsideAlert(1, null)).toBe(false);
    expect(shouldRaiseOutsideAlert(3, null)).toBe(false);
    expect(shouldRaiseOutsideAlert(4, null)).toBe(true);
    expect(
      shouldRaiseOutsideAlert(5, new Date('2026-10-26T10:00:00.000Z'))
    ).toBe(false);
  });

  it('detects missing pings without treating them as a failed reading', () => {
    const now = new Date('2026-10-26T10:20:00.000Z');
    expect(isMissingPing(null, now)).toBe(true);
    expect(
      isMissingPing(new Date('2026-10-26T10:10:00.000Z'), now)
    ).toBe(false);
    expect(
      isMissingPing(new Date('2026-10-26T10:00:00.000Z'), now)
    ).toBe(true);
  });

  it('accepts a stable client request id for idempotent retries', () => {
    const body = {
      attendanceEventId: '8f5f1e24-8a5b-4f4e-9a4f-6a3f5b2c1d0e',
      latitude: 12.9716,
      longitude: 77.5946,
      accuracyMeters: 8,
      timestamp: '2026-10-26T10:00:00.000Z',
      clientRequestId: '0f1e2d3c-4b5a-4968-8776-655443322110',
    };
    const parsed = locationCheckBodySchema.parse(body);
    expect(parsed.clientRequestId).toBe(body.clientRequestId);
  });
});
