import { z } from 'zod';

/**
 * SFace descriptors are 128-dimensional. Each component must be finite so a
 * malformed client cannot poison the pgvector index with NaN/Infinity values.
 */
export const vector128Schema = z
  .array(z.number().finite())
  .length(128, { message: 'Vector embedding must contain exactly 128 float values' });

/** Evidence produced by the Android liveness pipeline. */
export const livenessEvidenceSchema = z.object({
  /** A complete blink was observed by the landmark-anchored eye tracker. */
  activeBlinkDetected: z.boolean(),
  /** Number of completed blink cycles in the capture window. */
  blinkCount: z.number().int().min(0).max(20),
  /** Normalised Laplacian texture variance in [0, 1]. */
  passiveTextureScore: z.number().min(0).max(1),
  /** Client-side verdict; the server still enforces its own threshold. */
  passivePassed: z.boolean(),
  capturedAt: z.string().datetime().optional(),
});

export const enrollMultiPoseSchema = z.object({
  /** The employee whose five poses are being enrolled (supervised). */
  staffProfileId: z.string().uuid(),
  centerVector: vector128Schema,
  leftVector: vector128Schema,
  rightVector: vector128Schema,
  upVector: vector128Schema,
  downVector: vector128Schema,
  modelVersion: z.string().trim().min(1).max(64).default('sface-yunet-v1'),
  qualityScore: z.number().min(0).max(1).optional().default(0.95),
  premisesId: z.string().uuid().optional(),
  liveness: livenessEvidenceSchema,
});

export const clockInFaceSchema = z.object({
  liveVector: vector128Schema,
  liveness: livenessEvidenceSchema,
  /** Optional premises context for kiosk deployments. */
  premisesId: z.string().uuid().optional(),
});

export type EnrollMultiPoseInput = z.infer<typeof enrollMultiPoseSchema>;
export type ClockInFaceInput = z.infer<typeof clockInFaceSchema>;
export type LivenessEvidenceInput = z.infer<typeof livenessEvidenceSchema>;
