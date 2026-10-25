import { describe, expect, it } from 'vitest';
import {
  FACE_EMBEDDING_SIMILARITY_THRESHOLD,
  cosineSimilarity,
  decryptEmbedding,
  encryptEmbedding,
  normalizeEmbedding,
  sanitizeEmbedding,
} from '../src/shared/utils/face.js';

function deterministicEmbedding(seed: number, dimensions = 128): number[] {
  return Array.from({ length: dimensions }, (_, index) => {
    const value = Math.sin(seed * 31 + index * 7) + Math.cos(seed + index * 3);
    return value;
  });
}

describe('Face embedding security and matching', () => {
  it('round-trips an encrypted embedding', () => {
    const vector = deterministicEmbedding(1);
    const payload = encryptEmbedding(vector);
    const restored = decryptEmbedding(payload);
    expect(restored).toHaveLength(vector.length);
    restored.forEach((value, index) => expect(value).toBeCloseTo(vector[index], 5));
  });

  it('produces a unit-length normalised vector', () => {
    const normalised = normalizeEmbedding(deterministicEmbedding(2));
    const magnitude = Math.sqrt(normalised.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('scores identical embeddings at one and unrelated embeddings below threshold', () => {
    const a = normalizeEmbedding(deterministicEmbedding(3));
    const b = normalizeEmbedding(deterministicEmbedding(99));
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a, b)).toBeLessThan(FACE_EMBEDDING_SIMILARITY_THRESHOLD);
  });

  it('accepts only 128 or 512 dimensional numeric vectors', () => {
    expect(sanitizeEmbedding(deterministicEmbedding(4, 128))).toHaveLength(128);
    expect(sanitizeEmbedding(deterministicEmbedding(5, 512))).toHaveLength(512);
    expect(() => sanitizeEmbedding(deterministicEmbedding(6, 64))).toThrow();
    expect(() => sanitizeEmbedding([1, 2, 'three'])).toThrow();
  });

  it('rejects non-finite numbers', () => {
    const vector = deterministicEmbedding(7);
    vector[0] = Number.NaN;
    expect(() => sanitizeEmbedding(vector)).toThrow();
  });
});
