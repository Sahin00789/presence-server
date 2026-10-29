import { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { multiPoseFaceTemplates } from '../../db/schema.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import {
  FACE_EMBEDDING_SIMILARITY_THRESHOLD,
} from '../../shared/utils/face.js';
import { assertLivenessEvidence } from '../../shared/utils/liveness.js';
import {
  sanitizePoseVector,
  sanitizePoseVectors,
} from '../../shared/utils/multi-pose.js';
import { ClockInFaceInput, EnrollMultiPoseInput } from './schemas.js';

const POSE_CANDIDATES_PER_COLUMN = 5;

import { resolveStaffProfile } from '../../shared/services/staff.service.js';

interface FaceMatchRow {
  employee_id: string;
  user_id: string;
  employee_code: string;
  full_name: string;
  pose: string;
  similarity: number | string;
}

async function assertStaffProfile(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string
) {
  return await resolveStaffProfile(fastify, organizationId, staffProfileId);
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
 * API Route 1: save the five supervised pose vectors for an employee.
 */
export async function saveMultiPoseEnrollment(
  fastify: FastifyInstance,
  actorUserId: string,
  organizationId: string,
  input: EnrollMultiPoseInput
) {
  assertLivenessEvidence(input.liveness);

  const profile = await assertStaffProfile(fastify, organizationId, input.staffProfileId);
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

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'FACE_MULTI_POSE_ENROLLED',
    resourceType: 'staff_profile',
    resourceId: profile.id,
    metadata: {
      modelVersion: input.modelVersion,
      poseCount: 5,
      dimensions: poses.center.length,
      qualityScore,
      passiveLivenessScore: input.liveness.passiveTextureScore,
      blinkCount: input.liveness.blinkCount,
      premisesId: input.premisesId ?? null,
    },
  });

  return {
    success: true,
    message: 'Multi-pose face vectors enrolled successfully.',
    employeeId: profile.id,
    staffProfileId: profile.id,
    userId: profile.userId,
    staffCode: profile.employeeCode,
    modelVersion: input.modelVersion,
    poseCount: 5,
    qualityScore,
    livenessScore,
    enrolledAt: now.toISOString(),
  };
}

/**
 * API Route 2: identify an employee from a single live vector.
 *
 * Each pose column is searched independently with pgvector's cosine distance
 * operator (`<=>`) and an HNSW index, then the union is ranked. The query is
 * always scoped to the caller's organization, so a vector from one tenant can
 * never match an employee in another tenant.
 */
export async function matchLiveFaceVector(
  fastify: FastifyInstance,
  organizationId: string,
  input: ClockInFaceInput
) {
  assertLivenessEvidence(input.liveness);

  const liveVector = sanitizePoseVector(input.liveVector);
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
      users.full_name
    FROM candidates
    INNER JOIN employees
      ON employees.id = candidates.employee_id
      AND employees.organization_id = ${organizationId}::uuid
    INNER JOIN users ON users.id = employees.user_id
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
      employeeId: null,
      staffProfileId: null,
      similarity: Number.isFinite(similarity) ? Number(similarity.toFixed(4)) : 0,
      threshold,
      message: 'No employee matched above the similarity threshold.',
    };
  }

  await writeAuditLog(fastify, {
    organizationId,
    action: 'FACE_MULTI_POSE_CLOCK_IN',
    resourceType: 'employee',
    resourceId: best.employee_id,
    metadata: {
      matchedPose: best.pose,
      similarity: Number(similarity.toFixed(4)),
      threshold,
      blinkCount: input.liveness.blinkCount,
      passiveTextureScore: input.liveness.passiveTextureScore,
      premisesId: input.premisesId ?? null,
    },
  });

  return {
    success: true,
    matched: true,
    employeeId: best.employee_id,
    staffProfileId: best.employee_id,
    userId: best.user_id,
    staffName: best.full_name,
    staffCode: best.employee_code,
    matchedPose: best.pose,
    similarity: Number(similarity.toFixed(4)),
    threshold,
    message: 'Face matched against the enrolled multi-pose template.',
  };
}

export async function getMultiPoseEnrollmentStatus(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string
) {
  const [employee] = await fastify.db
    .select({ id: schema.employees.id })
    .from(schema.employees)
    .where(and(eq(schema.employees.userId, userId), eq(schema.employees.organizationId, organizationId)))
    .limit(1);

  if (!employee) {
    return {
      enrolled: false,
      employeeId: null,
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
      employeeId: employee.id,
    };
  }

  return {
    enrolled: true,
    employeeId: employee.id,
    enrolledAt: template.enrolledAt?.toISOString() ?? null,
    modelVersion: template.modelVersion ?? null,
  };
}
