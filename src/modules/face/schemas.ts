import { z } from 'zod';

export const embeddingSchema = z
  .array(z.number().finite())
  .min(128)
  .max(512)
  .refine((vector) => vector.length === 128 || vector.length === 512, {
    message: 'Embedding must contain exactly 128 or 512 dimensions',
  });

/**
 * Supervised enrolment only. Face templates are always created by an Owner or
 * Manager present with the employee (`docs/FACE_VERIFICATION.md` §1.1); staff
 * never enrol themselves.
 */
export const supervisedEnrollFaceSchema = z.object({
  /** The staff member whose face is being enrolled. */
  staffProfileId: z.string().uuid(),
  /** Numeric embedding produced by the on-device ONNX model. */
  embeddingVector: embeddingSchema,
  /** Identifier of the bundled model pair, e.g. `sface-yunet-v1`. */
  modelVersion: z.string().trim().min(1).max(64).default('sface-yunet-v1'),
  /** Optional on-device quality score (blur/lighting) in [0, 1]. */
  qualityScore: z.number().min(0).max(1).optional(),
  /** Premises where the supervised capture took place. */
  premisesId: z.string().uuid().optional(),
});

export const verifyFaceSchema = z.object({
  embeddingVector: embeddingSchema,
});

export const faceStatusSchema = z.object({
  enrolled: z.boolean(),
  staffProfileId: z.string().uuid().nullable(),
  modelVersion: z.string().nullable(),
  enrolledAt: z.date().or(z.string()).nullable(),
  embeddingDimensions: z.number().int().nullable(),
  enrollmentMethod: z.enum(['MANAGER_SUPERVISED']).nullable(),
  enrolledByUserId: z.string().uuid().nullable(),
  enrolledByName: z.string().nullable(),
  enrolledAtPremisesId: z.string().uuid().nullable(),
  revokedAt: z.date().or(z.string()).nullable(),
});

export const faceVerificationSchema = z.object({
  matched: z.boolean(),
  similarity: z.number(),
  threshold: z.number(),
});

export type SupervisedEnrollFaceInput = z.infer<typeof supervisedEnrollFaceSchema>;
export type VerifyFaceInput = z.infer<typeof verifyFaceSchema>;
