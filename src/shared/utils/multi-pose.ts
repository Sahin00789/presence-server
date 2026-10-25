import { cosineSimilarity, normalizeEmbedding, sanitizeEmbedding } from './face.js';

/** Pose order used by the enrolment wizard and the pgvector columns. */
export const POSE_NAMES = ['CENTER', 'LEFT', 'RIGHT', 'UP', 'DOWN'] as const;
export type PoseName = (typeof POSE_NAMES)[number];

export interface PoseVectors {
  center: number[];
  left: number[];
  right: number[];
  up: number[];
  down: number[];
}

const POSE_KEYS: Record<PoseName, keyof PoseVectors> = {
  CENTER: 'center',
  LEFT: 'left',
  RIGHT: 'right',
  UP: 'up',
  DOWN: 'down',
};

/**
 * The multi-pose model is fixed at 128 dimensions. `sanitizeEmbedding` also
 * accepts 512-D MobileFaceNet vectors for the legacy template path, so this
 * helper rejects anything that is not exactly SFace-shaped.
 */
export function sanitizePoseVector(input: unknown): number[] {
  const vector = sanitizeEmbedding(input);
  if (vector.length !== 128) {
    throw new Error('Multi-pose embeddings must contain exactly 128 dimensions');
  }
  return normalizeEmbedding(vector);
}

export function sanitizePoseVectors(input: PoseVectors): PoseVectors {
  return {
    center: sanitizePoseVector(input.center),
    left: sanitizePoseVector(input.left),
    right: sanitizePoseVector(input.right),
    up: sanitizePoseVector(input.up),
    down: sanitizePoseVector(input.down),
  };
}

export function poseSimilarities(
  liveVector: number[],
  poses: PoseVectors
): Record<PoseName, number> {
  const live = sanitizePoseVector(liveVector);
  return {
    CENTER: cosineSimilarity(live, poses.center),
    LEFT: cosineSimilarity(live, poses.left),
    RIGHT: cosineSimilarity(live, poses.right),
    UP: cosineSimilarity(live, poses.up),
    DOWN: cosineSimilarity(live, poses.down),
  };
}

/**
 * Highest cosine similarity across the five enrolled poses. A live frame that
 * does not match the frontal template can still match the pose the employee
 * actually presented to the camera.
 */
export function bestPoseMatch(
  liveVector: number[],
  poses: PoseVectors
): { pose: PoseName; similarity: number } {
  const similarities = poseSimilarities(liveVector, poses);
  let bestPose: PoseName = POSE_NAMES[0];
  let bestSimilarity = similarities[bestPose];

  for (const pose of POSE_NAMES) {
    if (similarities[pose] > bestSimilarity) {
      bestPose = pose;
      bestSimilarity = similarities[pose];
    }
  }

  return { pose: bestPose, similarity: bestSimilarity };
}

/** Maps a camelCase pose key to its database column name. */
export function poseColumn(pose: PoseName): keyof PoseVectors {
  return POSE_KEYS[pose];
}
