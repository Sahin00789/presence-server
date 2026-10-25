import { describe, expect, it } from 'vitest';
import {
  FACE_EMBEDDING_SIMILARITY_THRESHOLD,
  FACE_PASSIVE_LIVENESS_MIN,
} from '../src/shared/utils/face.js';
import { assertLivenessEvidence } from '../src/shared/utils/liveness.js';
import {
  bestPoseMatch,
  poseSimilarities,
  sanitizePoseVector,
} from '../src/shared/utils/multi-pose.js';

function unitBasis(index: number, dimensions = 128): number[] {
  const vector = new Array(dimensions).fill(0);
  vector[index] = 1;
  return vector;
}

const poses = {
  center: unitBasis(0),
  left: unitBasis(1),
  right: unitBasis(2),
  up: unitBasis(3),
  down: unitBasis(4),
};

describe('Multi-pose vector matching', () => {
  it('uses the SFace cosine threshold of 0.363', () => {
    expect(FACE_EMBEDDING_SIMILARITY_THRESHOLD).toBeCloseTo(0.363, 5);
  });

  it('accepts exactly 128 dimensions and rejects legacy 512-D vectors', () => {
    expect(sanitizePoseVector(unitBasis(0))).toHaveLength(128);
    expect(() => sanitizePoseVector(unitBasis(0, 512))).toThrow(/128/);
  });

  it('reports the best matching pose across all five columns', () => {
    const result = bestPoseMatch(unitBasis(1), poses);
    expect(result.pose).toBe('LEFT');
    expect(result.similarity).toBeCloseTo(1, 5);
  });

  it('scores each pose independently', () => {
    const similarities = poseSimilarities(unitBasis(3), poses);
    expect(similarities.UP).toBeCloseTo(1, 5);
    expect(similarities.CENTER).toBeCloseTo(0, 5);
    expect(similarities.DOWN).toBeCloseTo(0, 5);
  });

  it('rejects missing active liveness and low passive texture', () => {
    expect(() =>
      assertLivenessEvidence({
        activeBlinkDetected: false,
        blinkCount: 0,
        passiveTextureScore: 0.9,
        passivePassed: true,
      })
    ).toThrow(/Active liveness/);

    expect(() =>
      assertLivenessEvidence({
        activeBlinkDetected: true,
        blinkCount: 1,
        passiveTextureScore: FACE_PASSIVE_LIVENESS_MIN / 2,
        passivePassed: true,
      })
    ).toThrow(/Passive liveness/);
  });

  it('accepts a fresh, complete liveness sample', () => {
    expect(() =>
      assertLivenessEvidence({
        activeBlinkDetected: true,
        blinkCount: 1,
        passiveTextureScore: Math.max(0.5, FACE_PASSIVE_LIVENESS_MIN),
        passivePassed: true,
        capturedAt: new Date().toISOString(),
      })
    ).not.toThrow();
  });
});
