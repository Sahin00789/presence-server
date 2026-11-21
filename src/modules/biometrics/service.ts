import { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { multiPoseFaceTemplates } from '../../db/schema.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  FACE_EMBEDDING_SIMILARITY_THRESHOLD,
} from '../../shared/utils/face.js';
import { assertLivenessEvidence } from '../../shared/utils/liveness.js';
import {
  sanitizePoseVector,
  sanitizePoseVectors,
} from '../../shared/utils/multi-pose.js';
import { resolveStaffProfile } from '../../shared/services/staff.service.js';
import { ClockInFaceInput, EnrollMultiPoseInput } from './schemas.js';

const POSE_CANDIDATES_PER_COLUMN = 5;

interface FaceMatchRow {
  employee_id: string;
  user_id: string;
  employee_code: string;
  full_name: string;
  pose: string;
  similarity: number | string;
}

async function assertEmployeeProfile(
  fastify: FastifyInstance,
  organizationId: string,
  employeeProfileId: string
) {
  return await resolveStaffProfile(fastify, organizationId, employeeProfileId);
}

async function assertPremises(
  fastify: FastifyInstance,
  organizationId: string,
  premisesId?: string
): Promise<void> {
  if (!premisesId) return;

  const [premises] = await fastify.db
    .select({ id: schema.premises.id })
    .from(schema.premises)
    .where(
      and(
        eq(schema.premises.id, premisesId),
        eq(schema.premises.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!premises) {
    throw new AppError('Premises not found', 404, 'PREMISES_NOT_FOUND');
  }
}

/**
 * Purpose: Saves five supervised multi-pose face embedding vectors (center, left, right, up, down) for an employee.
 * How it works: Validates liveness evidence, confirms employee profile and premises belong to caller organization,
 * normalizes 128D floating point vectors, calculates quality/liveness scores, and performs an upsert (`onConflictDoUpdate`) on `multiPoseFaceTemplates`.
 *
 * @param fastify Fastify instance.
 * @param actorUserId User ID performing enrollment (Owner).
 * @param organizationId Target organization UUID.
 * @param input EnrollMultiPoseInput containing `employeeProfileId`, 5 pose vectors, `modelVersion`, and `liveness` evidence.
 * @returns Result object containing `employeeProfileId`, `modelVersion`, `poseCount`, scores, and ISO timestamp.
 */
export async function saveMultiPoseEnrollment(
  fastify: FastifyInstance,
  actorUserId: string,
  organizationId: string,
  input: EnrollMultiPoseInput
) {
  assertLivenessEvidence(input.liveness);

  const profile = await assertEmployeeProfile(fastify, organizationId, input.employeeProfileId);
  await assertPremises(fastify, organizationId, input.premisesId);

  const poses = sanitizePoseVectors({
    center: input.centerVector,
    left: input.leftVector,
    right: input.rightVector,
    up: input.upVector,
    down: input.downVector,
  });

  const now = new Date();
  const qualityScore = input.qualityScore ?? 0.95;
  const livenessScore = Math.min(
    1,
    Math.max(0, input.liveness.passiveTextureScore * 0.7 + 0.3)
  );

  await fastify.db
    .insert(multiPoseFaceTemplates)
    .values({
      organizationId,
      employeeId: profile.id,
      centerVector: poses.center,
      leftVector: poses.left,
      rightVector: poses.right,
      upVector: poses.up,
      downVector: poses.down,
      modelVersion: input.modelVersion,
      qualityScore: qualityScore.toFixed(3),
      livenessScore: livenessScore.toFixed(3),
      passiveLivenessScore: input.liveness.passiveTextureScore.toFixed(3),
      enrolledByUserId: actorUserId,
      enrolledAtPremisesId: input.premisesId ?? null,
      enrolledAt: now,
      updatedAt: now,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: multiPoseFaceTemplates.employeeId,
      set: {
        organizationId,
        centerVector: poses.center,
        leftVector: poses.left,
        rightVector: poses.right,
        upVector: poses.up,
        downVector: poses.down,
        modelVersion: input.modelVersion,
        qualityScore: qualityScore.toFixed(3),
        livenessScore: livenessScore.toFixed(3),
        passiveLivenessScore: input.liveness.passiveTextureScore.toFixed(3),
        enrolledByUserId: actorUserId,
        enrolledAtPremisesId: input.premisesId ?? null,
        enrolledAt: now,
        updatedAt: now,
        revokedAt: null,
      },
    });

  return {
    success: true,
    message: 'Multi-pose face vectors enrolled successfully.',
    employeeProfileId: profile.id,
    modelVersion: input.modelVersion,
    poseCount: 5,
    qualityScore,
    livenessScore,
    enrolledAt: now.toISOString(),
  };
}

/**
 * Purpose: Identifies an employee from a single live 128D face embedding vector using PostgreSQL pgvector HNSW cosine distance queries.
 * How it works: Queries each of the 5 pose columns (CENTER, LEFT, RIGHT, UP, DOWN) independently in `multiPoseFaceTemplates` table
 * scoped strictly to `organizationId`, takes top candidates per pose column, ranks by maximum cosine similarity (1 - distance),
 * and matches if similarity exceeds threshold (`FACE_EMBEDDING_SIMILARITY_THRESHOLD`).
 *
 * @param fastify Fastify instance.
 * @param organizationId Organization UUID for multi-tenant isolation.
 * @param input Input object containing `liveVector` (or `embeddingVector`), optional `liveness` evidence and `premisesId`.
 * @returns Result object with `matched: boolean`, `employeeProfileId`, `similarity`, `threshold`, and status message.
 */
export async function matchLiveFaceVector(
  fastify: FastifyInstance,
  organizationId: string,
  input: { liveVector?: number[]; embeddingVector?: number[]; liveness?: any; premisesId?: string }
) {
  if (input.liveness) {
    assertLivenessEvidence(input.liveness);
  }

  const rawVector = input.liveVector ?? input.embeddingVector;
  if (!rawVector) {
    throw new AppError('A face embedding vector is required', 400, 'FACE_EMBEDDING_REQUIRED');
  }

  const liveVector = sanitizePoseVector(rawVector);
  const vectorLiteral = `[${liveVector.join(',')}]`;
  const threshold = FACE_EMBEDDING_SIMILARITY_THRESHOLD;

  const rows = await fastify.pgClient<FaceMatchRow[]>`
    WITH candidates AS (
      (
        SELECT
          'CENTER'::text AS pose,
          employee_id,
          1 - (center_vector <=> ${vectorLiteral}::vector) AS similarity
        FROM multi_pose_face_templates
        WHERE organization_id = ${organizationId}::uuid
          AND revoked_at IS NULL
        ORDER BY center_vector <=> ${vectorLiteral}::vector
        LIMIT ${POSE_CANDIDATES_PER_COLUMN}
      )
      UNION ALL
      (
        SELECT
          'LEFT'::text AS pose,
          employee_id,
          1 - (left_vector <=> ${vectorLiteral}::vector) AS similarity
        FROM multi_pose_face_templates
        WHERE organization_id = ${organizationId}::uuid
          AND revoked_at IS NULL
        ORDER BY left_vector <=> ${vectorLiteral}::vector
        LIMIT ${POSE_CANDIDATES_PER_COLUMN}
      )
      UNION ALL
      (
        SELECT
          'RIGHT'::text AS pose,
          employee_id,
          1 - (right_vector <=> ${vectorLiteral}::vector) AS similarity
        FROM multi_pose_face_templates
        WHERE organization_id = ${organizationId}::uuid
          AND revoked_at IS NULL
        ORDER BY right_vector <=> ${vectorLiteral}::vector
        LIMIT ${POSE_CANDIDATES_PER_COLUMN}
      )
      UNION ALL
      (
        SELECT
          'UP'::text AS pose,
          employee_id,
          1 - (up_vector <=> ${vectorLiteral}::vector) AS similarity
        FROM multi_pose_face_templates
        WHERE organization_id = ${organizationId}::uuid
          AND revoked_at IS NULL
        ORDER BY up_vector <=> ${vectorLiteral}::vector
        LIMIT ${POSE_CANDIDATES_PER_COLUMN}
      )
      UNION ALL
      (
        SELECT
          'DOWN'::text AS pose,
          employee_id,
          1 - (down_vector <=> ${vectorLiteral}::vector) AS similarity
        FROM multi_pose_face_templates
        WHERE organization_id = ${organizationId}::uuid
          AND revoked_at IS NULL
        ORDER BY down_vector <=> ${vectorLiteral}::vector
        LIMIT ${POSE_CANDIDATES_PER_COLUMN}
      )
    )
    SELECT
      candidates.employee_id,
      candidates.pose,
      candidates.similarity,
      employees.user_id,
      employees.employee_code,
      COALESCE(users.full_name, employees.name) AS full_name
    FROM candidates
    INNER JOIN employees
      ON employees.id = candidates.employee_id
      AND employees.organization_id = ${organizationId}::uuid
    LEFT JOIN users ON users.id = employees.user_id
    ORDER BY candidates.similarity DESC
    LIMIT 1
  `;

  const best = rows[0];
  if (!best) {
    return {
      success: false,
      matched: false,
      employeeId: null,
      staffProfileId: null,
      similarity: 0,
      threshold,
      message: 'No enrolled face template found for this organization.',
    };
  }

  const similarity = Number(best.similarity);
  if (!Number.isFinite(similarity) || similarity < threshold) {
    return {
      success: false,
      matched: false,
      employeeProfileId: null,
      similarity: Number.isFinite(similarity) ? Number(similarity.toFixed(4)) : 0,
      threshold,
      message: 'No employee matched above the similarity threshold.',
    };
  }

  return {
    success: true,
    matched: true,
    employeeProfileId: best.employee_id,
    employeeName: best.full_name,
    employeeCode: best.employee_code,
    matchedPose: best.pose,
    similarity: Number(similarity.toFixed(4)),
    threshold,
    message: 'Face matched against the enrolled multi-pose template.',
  };
}

/**
 * Purpose: Checks whether a specific employee has an active multi-pose face template enrolled.
 * How it works: Resolves employee by `employeeProfileId` or `userId`, queries `multiPoseFaceTemplates` table,
 * and returns enrolled status, enrollment date, and model version.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @param userId Authenticated user UUID.
 * @param employeeProfileId Optional target employee UUID.
 * @returns Object `{ enrolled: boolean, employeeProfileId, enrolledAt, modelVersion }`.
 */
export async function getMultiPoseEnrollmentStatus(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string,
  employeeProfileId?: string
) {
  const whereClause = employeeProfileId
    ? and(eq(schema.employees.id, employeeProfileId), eq(schema.employees.organizationId, organizationId))
    : and(eq(schema.employees.userId, userId), eq(schema.employees.organizationId, organizationId));

  const [employee] = await fastify.db
    .select({ id: schema.employees.id })
    .from(schema.employees)
    .where(whereClause)
    .limit(1);

  if (!employee) {
    return {
      enrolled: false,
      employeeProfileId: null,
    };
  }

  const [template] = await fastify.db
    .select({
      enrolledAt: multiPoseFaceTemplates.enrolledAt,
      revokedAt: multiPoseFaceTemplates.revokedAt,
      modelVersion: multiPoseFaceTemplates.modelVersion,
    })
    .from(multiPoseFaceTemplates)
    .where(eq(multiPoseFaceTemplates.employeeId, employee.id))
    .limit(1);

  if (!template || template.revokedAt) {
    return {
      enrolled: false,
      employeeProfileId: employee.id,
    };
  }

  return {
    enrolled: true,
    employeeProfileId: employee.id,
    enrolledAt: template.enrolledAt?.toISOString() ?? null,
    modelVersion: template.modelVersion ?? null,
  };
}

export const verifyFaceForClockIn = matchLiveFaceVector;
export const verifyMultiPoseClockIn = matchLiveFaceVector;
export const verify = matchLiveFaceVector;
