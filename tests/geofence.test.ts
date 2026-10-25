import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEOFENCE_RADIUS_METERS,
  evaluateGeofence,
  haversineDistanceMeters,
  roundDistanceMeters,
} from '../src/shared/utils/geo.js';

const premises = {
  latitude: 12.9715987,
  longitude: 77.5945627,
  radiusMeters: DEFAULT_GEOFENCE_RADIUS_METERS,
};

describe('Geofence evaluation', () => {
  it('returns zero distance for identical coordinates', () => {
    const distance = haversineDistanceMeters(12.9715987, 77.5945627, 12.9715987, 77.5945627);
    expect(distance).toBeCloseTo(0, 6);
    expect(roundDistanceMeters(distance)).toBe(0);
  });

  it('accepts an accurate reading inside the premises radius', () => {
    const outcome = evaluateGeofence(
      {
        latitude: 12.97165,
        longitude: 77.5946,
        accuracyMeters: 8,
        capturedAt: new Date('2026-01-01T10:00:00Z'),
      },
      premises,
      new Date('2026-01-01T10:00:30Z')
    );
    expect(outcome.result).toBe('IN_PREMISES');
    expect(outcome.withinRadius).toBe(true);
  });

  it('rejects a reading outside the premises radius', () => {
    const outcome = evaluateGeofence(
      {
        latitude: 12.981,
        longitude: 77.5946,
        accuracyMeters: 8,
        capturedAt: new Date('2026-01-01T10:00:00Z'),
      },
      premises,
      new Date('2026-01-01T10:01:00Z')
    );
    expect(outcome.result).toBe('OUTSIDE');
    expect(outcome.withinRadius).toBe(false);
  });

  it('prioritises mocked readings', () => {
    const outcome = evaluateGeofence(
      {
        latitude: 12.9715987,
        longitude: 77.5945627,
        accuracyMeters: 5,
        isMocked: true,
        capturedAt: new Date('2026-01-01T10:00:00Z'),
      },
      premises,
      new Date('2026-01-01T10:00:30Z')
    );
    expect(outcome.result).toBe('MOCKED');
  });

  it('rejects stale readings', () => {
    const outcome = evaluateGeofence(
      {
        latitude: 12.9715987,
        longitude: 77.5945627,
        accuracyMeters: 5,
        capturedAt: new Date('2026-01-01T09:50:00Z'),
      },
      premises,
      new Date('2026-01-01T10:00:00Z')
    );
    expect(outcome.result).toBe('STALE');
  });

  it('rejects low-accuracy readings', () => {
    const outcome = evaluateGeofence(
      {
        latitude: 12.9715987,
        longitude: 77.5945627,
        accuracyMeters: 120,
        capturedAt: new Date('2026-01-01T10:00:00Z'),
      },
      premises,
      new Date('2026-01-01T10:00:30Z')
    );
    expect(outcome.result).toBe('LOW_ACCURACY');
  });
});
