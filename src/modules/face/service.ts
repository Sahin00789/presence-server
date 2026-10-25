import { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import { findStaffProfile, resolveStaffProfile } from '../../shared/services/staff.service.js';
import {
  FACE_EMBEDDING_SIMILARITY_THRESHOLD,
  cosineSimilarity,
  decryptEmbedding,
  encryptEmbedding,
  normalizeEmbedding,
  sanitizeEmbedding,
} from '../../shared/utils/face.js';

interface FaceStatusRow {
  enrolled: boolean;
  staffProfileId: string | null;
  modelVersion: string | null;
  enrolledAt: Date | string | null;
  embeddingDimensions: number | null;
  enrollmentMethod: 'MANAGER_SUPERVISED' | null;
  enrolledByUserId: string | null;
  enrolledByName: string | null;
  enrolledAtPremisesId: string | null;
  revokedAt: Date | string | null;
}

function emptyStatus(staffProfileId: string | null = null): FaceStatusRow {
  return {
    enrolled: false,
    staffProfileId,
    modelVersion: null,
    enrolledAt: null,
    embeddingDimensions: null,
    enrollmentMethod: null,
    enrolledByUserId: null,
    enrolledByName: null,
    enrolledAtPremisesId: null,
    revokedAt: null,
  };
}

async function readTemplate(
  fastify: FastifyInstance,
  staffProfileId: string,
  organizationId: string
) {
  const [row] = await fastify.db
    .select({
      template: schema.faceTemplates,
      enrolledByName: schema.users.fullName,
    })
    .from(schema.faceTemplates)
    .leftJoin(schema.users, eq(schema.faceTemplates.enrolledByUserId, schema.users.id))
    .where(
      and(
        eq(schema.faceTemplates.staffProfileId, staffProfileId),
        eq(schema.faceTemplates.organizationId, organizationId)
      )
    )
    .limit(1);

  return row ?? null;
}

function toStatus(
  row: Awaited<ReturnType<typeof readTemplate>>,
  staffProfileId: string
): FaceStatusRow {
  if (!row) {
    return emptyStatus(staffProfileId);
  }

  const template = row.template;
  const active = template.revokedAt == null;

  let dimensions: number | null = null;
  try {
    dimensions = decryptEmbedding(template.embeddingVector).length;
  } catch {
    dimensions = null;
  }

  return {
    enrolled: active,
    staffProfileId: template.staffProfileId,
    modelVersion: active ? template.modelVersion : null,
    enrolledAt: template.enrolledAt,
    embeddingDimensions: dimensions,
    enrollmentMethod: active ? 'MANAGER_SUPERVISED' : null,
    enrolledByUserId: template.enrolledByUserId,
    enrolledByName: row.enrolledByName,
    enrolledAtPremisesId: template.enrolledAtPremisesId,
    revokedAt: template.revokedAt,
  };
}

/** Face status of the authenticated employee (read-only). */
export async function getFaceStatus(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string
): Promise<FaceStatusRow> {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    return emptyStatus();
  }

  return toStatus(await readTemplate(fastify, profile.id, organizationId), profile.id);
}

/** Face status of any staff profile inside the active organization. */
export async function getStaffFaceStatus(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string
): Promise<FaceStatusRow> {
  const profile = await resolveStaffProfile(fastify, organizationId, staffProfileId);
  return toStatus(await readTemplate(fastify, profile.id, organizationId), profile.id);
}

/**
 * Creates or replaces a staff face template. Only Owners and Managers can call
 * this; the capture is expected to happen with the employee physically present
 * (`docs/FACE_VERIFICATION.md` §1.1).
 */
export async function enrollFaceSupervised(
  fastify: FastifyInstance,
  actorUserId: string,
  organizationId: string,
  input: {
    staffProfileId: string;
    embeddingVector: number[];
    modelVersion: string;
    qualityScore?: number;
    premisesId?: string;
  }
): Promise<FaceStatusRow> {
  const profile = await resolveStaffProfile(fastify, organizationId, input.staffProfileId);

  if (input.premisesId) {
    const [premises] = await fastify.db
      .select({ id: schema.premises.id })
      .from(schema.premises)
      .where(
        and(
          eq(schema.premises.id, input.premisesId),
          eq(schema.premises.organizationId, organizationId)
        )
      )
      .limit(1);
    if (!premises) {
      throw new AppError('Premises not found', 404, 'PREMISES_NOT_FOUND');
    }
  }

  const vector = sanitizeEmbedding(input.embeddingVector);
  const encrypted = encryptEmbedding(vector);
  const now = new Date();

  const [template] = await fastify.db
    .insert(schema.faceTemplates)
    .values({
      organizationId,
      staffProfileId: profile.id,
      embeddingVector: encrypted,
      modelVersion: input.modelVersion,
      enrolledByUserId: actorUserId,
      enrollmentMethod: 'MANAGER_SUPERVISED',
      enrolledAtPremisesId: input.premisesId ?? null,
      qualityScore: input.qualityScore != null ? String(input.qualityScore) : null,
      enrolledAt: now,
      revokedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.faceTemplates.staffProfileId,
      set: {
        embeddingVector: encrypted,
        modelVersion: input.modelVersion,
        enrolledByUserId: actorUserId,
        enrollmentMethod: 'MANAGER_SUPERVISED',
        enrolledAtPremisesId: input.premisesId ?? null,
        qualityScore: input.qualityScore != null ? String(input.qualityScore) : null,
        enrolledAt: now,
        revokedAt: null,
        updatedAt: now,
      },
    })
    .returning();

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'FACE_ENROLLED_SUPERVISED',
    resourceType: 'staff_profile',
    resourceId: profile.id,
    metadata: {
      faceTemplateId: template.id,
      modelVersion: input.modelVersion,
      dimensions: vector.length,
      qualityScore: input.qualityScore ?? null,
      premisesId: input.premisesId ?? null,
    },
  });

  return toStatus(await readTemplate(fastify, profile.id, organizationId), profile.id);
}

/** Self-comparison used by diagnostic tooling; does not enrol anything. */
export async function verifyFace(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string,
  embeddingVector: number[]
) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  const row = await readTemplate(fastify, profile.id, organizationId);
  if (!row || row.template.revokedAt != null) {
    throw new AppError(
      'No face template enrolled for this staff member',
      409,
      'FACE_ENROLLMENT_REQUIRED'
    );
  }

  const enrolled = normalizeEmbedding(decryptEmbedding(row.template.embeddingVector));
  const candidate = sanitizeEmbedding(embeddingVector);
  const similarity = cosineSimilarity(enrolled, candidate);

  return {
    matched: similarity >= FACE_EMBEDDING_SIMILARITY_THRESHOLD,
    similarity: Number(similarity.toFixed(4)),
    threshold: FACE_EMBEDDING_SIMILARITY_THRESHOLD,
  };
}

/**
 * Compares a candidate embedding against the stored template of a staff
 * profile. Used by the clock-in endpoint; revoked templates never match.
 */
export async function compareWithEnrolledFace(
  fastify: FastifyInstance,
  staffProfileId: string,
  embeddingVector: number[]
): Promise<{ matched: boolean; similarity: number; enrolled: boolean }> {
  const [template] = await fastify.db
    .select()
    .from(schema.faceTemplates)
    .where(
      and(
        eq(schema.faceTemplates.staffProfileId, staffProfileId),
        isNull(schema.faceTemplates.revokedAt)
      )
    )
    .limit(1);

  if (!template) {
    return { matched: false, similarity: 0, enrolled: false };
  }

  const enrolled = normalizeEmbedding(decryptEmbedding(template.embeddingVector));
  const candidate = sanitizeEmbedding(embeddingVector);
  const similarity = cosineSimilarity(enrolled, candidate);

  return {
    matched: similarity >= FACE_EMBEDDING_SIMILARITY_THRESHOLD,
    similarity: Number(similarity.toFixed(4)),
    enrolled: true,
  };
}

/**
 * Revokes a staff face template. Managers do this when a device changes or the
 * employee needs to be re-enrolled. The row is kept for the audit trail.
 */
export async function revokeFaceEnrollment(
  fastify: FastifyInstance,
  actorUserId: string,
  organizationId: string,
  staffProfileId: string
) {
  const profile = await resolveStaffProfile(fastify, organizationId, staffProfileId);

  const now = new Date();
  await fastify.db
    .update(schema.faceTemplates)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.faceTemplates.staffProfileId, profile.id),
        isNull(schema.faceTemplates.revokedAt)
      )
    );

  await fastify.db
    .update(schema.multiPoseFaceTemplates)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.multiPoseFaceTemplates.staffProfileId, profile.id),
        eq(schema.multiPoseFaceTemplates.organizationId, organizationId),
        isNull(schema.multiPoseFaceTemplates.revokedAt)
      )
    );

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'FACE_ENROLLMENT_REVOKED',
    resourceType: 'staff_profile',
    resourceId: profile.id,
  });

  return { revoked: true, staffProfileId: profile.id };
}
