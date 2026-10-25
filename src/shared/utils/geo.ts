/**
 * Geospatial helpers shared by the geofence engine.
 *
 * Implements the spherical geodesic (haversine) formula documented in
 * `docs/LOCATION_MONITORING.md`. All distances are expressed in metres and all
 * inputs are plain doubles - no monetary precision concerns apply here.
 */

export const EARTH_RADIUS_METERS = 6_371_008.8;

/** Maximum accepted GPS horizontal accuracy, per `docs/ATTENDANCE_RULES.md` §2. */
export const MAX_LOCATION_ACCURACY_METERS = 30;

/** Default premises geofence radius, per `docs/LOCATION_MONITORING.md` §1. */
export const DEFAULT_GEOFENCE_RADIUS_METERS = 50;

/** Location readings older than this are considered stale. */
export const MAX_LOCATION_AGE_MINUTES = 2;

export type GeoReading = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  isMocked?: boolean;
  capturedAt?: Date;
};

export type PremisesCoordinates = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

export type GeofenceOutcome =
  | { result: 'IN_PREMISES'; distanceMeters: number; withinRadius: true }
  | { result: 'OUTSIDE'; distanceMeters: number; withinRadius: false }
  | { result: 'LOW_ACCURACY'; distanceMeters: number; withinRadius: false; accuracyMeters: number }
  | { result: 'STALE'; distanceMeters: number; withinRadius: false }
  | { result: 'MOCKED'; distanceMeters: number; withinRadius: false }
  | { result: 'UNKNOWN'; distanceMeters: number; withinRadius: false };

/**
 * Haversine great-circle distance between two WGS-84 coordinates, in metres.
 */
export function haversineDistanceMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number
): number {
  if (
    !Number.isFinite(latitudeA) ||
    !Number.isFinite(longitudeA) ||
    !Number.isFinite(latitudeB) ||
    !Number.isFinite(longitudeB)
  ) {
    return Number.NaN;
  }

  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLatitude = toRadians(latitudeB - latitudeA);
  const deltaLongitude = toRadians(longitudeB - longitudeA);
  const latitudeARadians = toRadians(latitudeA);
  const latitudeBRadians = toRadians(latitudeB);

  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeARadians) *
      Math.cos(latitudeBRadians) *
      Math.sin(deltaLongitude / 2) ** 2;

  const angularDistance = 2 * Math.asin(Math.min(1, Math.sqrt(haversine)));
  return EARTH_RADIUS_METERS * angularDistance;
}

/**
 * Evaluates a GPS reading against a premises geofence and classifies the result.
 *
 * Precedence: mocked -> stale -> low accuracy -> inside/outside.
 */
export function evaluateGeofence(
  reading: GeoReading,
  premises: PremisesCoordinates,
  now: Date = new Date()
): GeofenceOutcome {
  const distanceMeters = haversineDistanceMeters(
    reading.latitude,
    reading.longitude,
    Number(premises.latitude),
    Number(premises.longitude)
  );

  if (!Number.isFinite(distanceMeters)) {
    return { result: 'UNKNOWN', distanceMeters: 0, withinRadius: false };
  }

  if (reading.isMocked) {
    return { result: 'MOCKED', distanceMeters, withinRadius: false };
  }

  const capturedAt = reading.capturedAt ?? now;
  const ageMinutes = (now.getTime() - capturedAt.getTime()) / 60_000;
  if (ageMinutes > MAX_LOCATION_AGE_MINUTES) {
    return { result: 'STALE', distanceMeters, withinRadius: false };
  }

  if (!Number.isFinite(reading.accuracyMeters) || reading.accuracyMeters > MAX_LOCATION_ACCURACY_METERS) {
    return {
      result: 'LOW_ACCURACY',
      distanceMeters,
      withinRadius: false,
      accuracyMeters: reading.accuracyMeters,
    };
  }

  const radiusMeters = premises.radiusMeters > 0 ? premises.radiusMeters : DEFAULT_GEOFENCE_RADIUS_METERS;
  if (distanceMeters <= radiusMeters) {
    return { result: 'IN_PREMISES', distanceMeters, withinRadius: true };
  }

  return { result: 'OUTSIDE', distanceMeters, withinRadius: false };
}

/** Convenience helper for rendering the distance on the client. */
export function roundDistanceMeters(distanceMeters: number): number {
  return Math.round(distanceMeters * 100) / 100;
}
