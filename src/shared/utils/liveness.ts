import { AppError } from '../errors/app-error.js';
import { FACE_PASSIVE_LIVENESS_MIN } from './face.js';

export interface LivenessEvidence {
  activeBlinkDetected: boolean;
  blinkCount: number;
  passiveTextureScore: number;
  passivePassed: boolean;
  capturedAt?: string;
}

/**
 * Server-side re-check of the Android liveness evidence.
 *
 * The client computes the active blink and passive texture signals because the
 * raw frames never leave the device. The server cannot re-derive them, but it
 * can reject missing/failed evidence, enforce the configured texture floor and
 * reject stale captures (which limits replay of a previous request).
 */
export function assertLivenessEvidence(evidence: LivenessEvidence): void {
  if (!evidence.activeBlinkDetected || evidence.blinkCount < 1) {
    throw new AppError(
      'Active liveness check failed. Please blink naturally and try again.',
      422,
      'LIVENESS_ACTIVE_FAILED'
    );
  }

  if (
    !evidence.passivePassed ||
    evidence.passiveTextureScore < FACE_PASSIVE_LIVENESS_MIN
  ) {
    throw new AppError(
      'Passive liveness check failed. Improve lighting and avoid photos or screens.',
      422,
      'LIVENESS_PASSIVE_FAILED'
    );
  }

  if (evidence.capturedAt) {
    const capturedAt = Date.parse(evidence.capturedAt);
    if (!Number.isFinite(capturedAt)) {
      throw new AppError('Invalid liveness timestamp', 422, 'LIVENESS_TIMESTAMP_INVALID');
    }
    const ageMs = Math.abs(Date.now() - capturedAt);
    if (ageMs > 5 * 60 * 1000) {
      throw new AppError(
        'Liveness evidence is stale. Please capture the face again.',
        422,
        'LIVENESS_EVIDENCE_STALE'
      );
    }
  }
}
