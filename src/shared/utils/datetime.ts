/**
 * Calendar & shift-time helpers.
 *
 * All business calculations (shift windows, late grace periods, half-day
 * thresholds) are anchored to the organization's configured IANA timezone, so a
 * night shift that starts at 22:00 on March 31 is correctly attributed to March
 * and ends at 06:00 on April 1 (`docs/SHIFT_RULES.md` §2).
 */

export const DEFAULT_TIMEZONE = 'UTC';

/** `HH:MM` or `HH:MM:SS` -> minutes since midnight. */
export function parseTimeToMinutes(time: string): number {
  const parts = time.split(':');
  const hours = Number(parts[0] ?? 0);
  const minutes = Number(parts[1] ?? 0);
  return hours * 60 + minutes;
}

/** `HH:MM:SS` -> `HH:MM`. */
export function normalizeTime(time: string): string {
  const parts = time.split(':');
  const hours = String(parts[0] ?? '00').padStart(2, '0');
  const minutes = String(parts[1] ?? '00').padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** A shift crosses midnight when its end time is not after its start time. */
export function isOvernightShift(startTime: string, endTime: string): boolean {
  return parseTimeToMinutes(endTime) <= parseTimeToMinutes(startTime);
}

/** Minutes of a `YYYY-MM-DD` calendar string -> `Date` at UTC midnight. */
export function parseDateISO(dateISO: string): Date {
  const [year, month, day] = dateISO.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** `Date` -> `YYYY-MM-DD` (UTC calendar day). */
export function toDateISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(dateISO: string, days: number): string {
  const date = parseDateISO(dateISO);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateISO(date);
}

/** Number of days in the month containing `dateISO`. */
export function daysInMonth(dateISO: string): number {
  const date = parseDateISO(dateISO);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Inclusive list of calendar days between two `YYYY-MM-DD` strings. */
export function enumerateDates(startDateISO: string, endDateISO: string): string[] {
  const dates: string[] = [];
  let cursor = startDateISO;
  // Guard against pathological ranges; a payroll period is at most ~1 year.
  for (let guard = 0; guard < 800 && cursor <= endDateISO; guard += 1) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

/** Day of week for a `YYYY-MM-DD` string, 0 = Sunday .. 6 = Saturday. */
export function dayOfWeek(dateISO: string): number {
  return parseDateISO(dateISO).getUTCDay();
}

/**
 * Offset (ms) of `timeZone` relative to UTC at the given instant.
 * `localWallClock = instant + offset`.
 */
export function getTimeZoneOffsetMs(timeZone: string, instant: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(instant);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour === '24' ? '00' : values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return asUtc - instant.getTime();
}

/**
 * Converts a wall-clock date/time in `timeZone` into the corresponding UTC instant.
 */
export function zonedWallClockToUtc(dateISO: string, time: string, timeZone: string): Date {
  const [year, month, day] = dateISO.split('-').map(Number);
  const totalMinutes = parseTimeToMinutes(time);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const pseudoUtc = Date.UTC(year, month - 1, day, hours, minutes, 0);

  // Two passes resolve DST boundaries correctly.
  let offset = getTimeZoneOffsetMs(timeZone, new Date(pseudoUtc));
  let utcMillis = pseudoUtc - offset;
  offset = getTimeZoneOffsetMs(timeZone, new Date(utcMillis));
  utcMillis = pseudoUtc - offset;

  return new Date(utcMillis);
}

export interface ShiftWindow {
  /** The calendar date the shift is attributed to (shift start date). */
  workDate: string;
  startAt: Date;
  endAt: Date;
  /** Net scheduled minutes (shift length minus break). */
  scheduledMinutes: number;
  /** Raw shift length in minutes, including the break. */
  grossMinutes: number;
  breakMinutes: number;
  overnight: boolean;
}

/**
 * Resolves the concrete UTC window of a shift template on a given work date.
 */
export function resolveShiftWindow(
  workDate: string,
  startTime: string,
  endTime: string,
  breakMinutes: number,
  timeZone: string = DEFAULT_TIMEZONE
): ShiftWindow {
  const overnight = isOvernightShift(startTime, endTime);
  const grossMinutes = overnight
    ? 24 * 60 - parseTimeToMinutes(startTime) + parseTimeToMinutes(endTime)
    : parseTimeToMinutes(endTime) - parseTimeToMinutes(startTime);

  const endDate = overnight ? addDays(workDate, 1) : workDate;

  return {
    workDate,
    startAt: zonedWallClockToUtc(workDate, startTime, timeZone),
    endAt: zonedWallClockToUtc(endDate, endTime, timeZone),
    scheduledMinutes: Math.max(0, grossMinutes - breakMinutes),
    grossMinutes,
    breakMinutes,
    overnight,
  };
}

/** Whole minutes between two instants (never negative). */
export function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60_000));
}
