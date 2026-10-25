import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env } from '../../config/env.js';

/**
 * Face-embedding helpers.
 *
 * Raw facial images are never transmitted or stored. Only the numeric
 * embedding produced on-device by ONNX Runtime Mobile reaches the backend, and
 * it is encrypted at rest with AES-256-GCM before it is persisted
 * (`docs/FACE_VERIFICATION.md` §2, `docs/SECURITY.md` §2).
 */

/**
 * SFace produces 128-D descriptors. OpenCV's reference threshold for cosine
 * similarity with SFace is 0.363; the previous 0.75 value was MobileFaceNet-
 * specific and rejected genuine captures.
 */
export const FACE_EMBEDDING_SIMILARITY_THRESHOLD = env.FACE_MATCH_THRESHOLD;
/** Texture variance below this normalised value is treated as a spoof. */
export const FACE_PASSIVE_LIVENESS_MIN = env.FACE_PASSIVE_LIVENESS_MIN;
export const SUPPORTED_EMBEDDING_DIMENSIONS = [128, 512] as const;

export interface FaceTemplatePayload {
  vector: number[];
  modelVersion: string;
}

function encryptionKey(): Buffer {
  const material = process.env.FACE_ENCRYPTION_KEY ?? env.ACCESS_TOKEN_SECRET;
  return createHash('sha256').update(material).digest();
}

/** Encrypts a numeric embedding into a `v1:<iv>:<tag>:<ciphertext>` string. */
export function encryptEmbedding(vector: number[]): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(vector), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Decrypts a stored embedding. Throws when the payload is malformed. */
export function decryptEmbedding(payload: string): number[] {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported face template encoding');
  }
  const [, ivPart, tagPart, cipherPart] = parts;
  const key = encryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(cipherPart, 'base64')),
    decipher.final(),
  ]);
  const parsed = JSON.parse(plaintext.toString('utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('Corrupt face template');
  }
  return parsed.map(Number);
}

/** L2-normalises an embedding so cosine similarity is a dot product. */
export function normalizeEmbedding(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude <= 1e-9) {
    throw new Error('Embedding has zero magnitude');
  }
  return vector.map((value) => value / magnitude);
}

/** Cosine similarity in the range [-1, 1]. */
export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error('Embedding dimensions do not match');
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm <= 1e-9 || rightNorm <= 1e-9) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * Validates and normalises a client-provided embedding. Only 128- or
 * 512-dimensional finite vectors are accepted.
 */
export function sanitizeEmbedding(input: unknown): number[] {
  if (!Array.isArray(input)) {
    throw new Error('Embedding must be an array of numbers');
  }
  if (!SUPPORTED_EMBEDDING_DIMENSIONS.includes(input.length as 128 | 512)) {
    throw new Error(
      `Embedding must have ${SUPPORTED_EMBEDDING_DIMENSIONS.join(' or ')} dimensions`
    );
  }
  const vector = input.map((value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error('Embedding contains a non-finite value');
    }
    return numeric;
  });
  return normalizeEmbedding(vector);
}
