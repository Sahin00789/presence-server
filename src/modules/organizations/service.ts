import { FastifyInstance } from 'fastify';
import { and, count, eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import {
  CreateOrganizationInput,
  Organization,
  OrganizationMember,
  OrganizationSummary,
  UpdateOrganizationInput,
} from './schemas.js';

import { uploadToCloudinary } from '../../shared/services/cloudinary.service.js';

export async function getOrganization(
  fastify: FastifyInstance,
  organizationId: string
): Promise<Organization> {
  const [organization] = await fastify.db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  if (!organization) {
    throw new AppError('Organization not found', 404, 'ORGANIZATION_NOT_FOUND');
  }

  return {
    id: organization.id,
    name: organization.name,
    logoUrl: organization.logoUrl || null,
    timezone: organization.timezone,
    currency: organization.currency,
    createdAt: organization.createdAt.toISOString(),
  };
}

export async function getOrganizationSummary(
  fastify: FastifyInstance,
  organizationId: string
): Promise<OrganizationSummary> {
  const organization = await getOrganization(fastify, organizationId);

  const [memberTotals] = await fastify.db
    .select({ total: count() })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.isActive, true)
      )
    );

  const [staffTotals] = await fastify.db
    .select({ total: count() })
    .from(schema.staffProfiles)
    .where(eq(schema.staffProfiles.organizationId, organizationId));

  const [managerTotals] = await fastify.db
    .select({ total: count() })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.role, 'MANAGER'),
        eq(schema.memberships.isActive, true)
      )
    );

  return {
    organization,
    memberCount: memberTotals?.total ?? 0,
    staffCount: staffTotals?.total ?? 0,
    managerCount: managerTotals?.total ?? 0,
  };
}

/**
 * Creates an additional organization for an Owner.
 *
 * The Owner keeps their existing membership and gains an `OWNER` membership in
 * the newly created organization (`docs/ROLE_PERMISSIONS.md` §3.1 - a user may
 * belong to more than one organization).
 */
export async function createOrganization(
  fastify: FastifyInstance,
  ownerUserId: string,
  input: CreateOrganizationInput
): Promise<Organization> {
  const result = await fastify.db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(schema.organizations)
      .values({
        name: input.name,
        timezone: input.timezone,
        currency: input.currency.toUpperCase(),
      })
      .returning();

    await tx.insert(schema.memberships).values({
      organizationId: organization.id,
      userId: ownerUserId,
      role: 'OWNER',
      isActive: true,
    });

    if (input.premisesName) {
      await tx.insert(schema.premises).values({
        organizationId: organization.id,
        name: input.premisesName,
        latitude: input.latitude ?? '0.0000000',
        longitude: input.longitude ?? '0.0000000',
        radiusMeters: input.radiusMeters ?? 50,
        isActive: true,
      });
    }

    return organization;
  });

  await writeAuditLog(fastify, {
    organizationId: result.id,
    actorId: ownerUserId,
    action: 'ORGANIZATION_CREATED',
    resourceType: 'organization',
    resourceId: result.id,
    metadata: { name: result.name },
  });

  return {
    id: result.id,
    name: result.name,
    logoUrl: result.logoUrl || null,
    timezone: result.timezone,
    currency: result.currency,
    createdAt: result.createdAt.toISOString(),
  };
}

export async function updateOrganization(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  input: UpdateOrganizationInput
): Promise<Organization> {
  let resolvedLogoUrl = input.logoUrl;

  if (input.logo) {
    resolvedLogoUrl = await uploadToCloudinary(input.logo, 'organization-logos');
  }

  const [updated] = await fastify.db
    .update(schema.organizations)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.currency !== undefined ? { currency: input.currency.toUpperCase() } : {}),
      ...(resolvedLogoUrl !== undefined ? { logoUrl: resolvedLogoUrl } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.organizations.id, organizationId))
    .returning();

  if (!updated) {
    throw new AppError('Organization not found', 404, 'ORGANIZATION_NOT_FOUND');
  }

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'ORGANIZATION_UPDATED',
    resourceType: 'organization',
    resourceId: organizationId,
    metadata: input as Record<string, unknown>,
  });

  return {
    id: updated.id,
    name: updated.name,
    logoUrl: updated.logoUrl || null,
    timezone: updated.timezone,
    currency: updated.currency,
    createdAt: updated.createdAt.toISOString(),
  };
}

export async function listOrganizationMembers(
  fastify: FastifyInstance,
  organizationId: string
): Promise<OrganizationMember[]> {
  const rows = await fastify.db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      fullName: schema.users.fullName,
      avatarUrl: schema.users.avatarUrl,
      role: schema.memberships.role,
      isActive: schema.memberships.isActive,
      joinedAt: schema.memberships.joinedAt,
      staffProfileId: schema.staffProfiles.id,
      staffCode: schema.staffProfiles.staffCode,
      premisesId: schema.staffProfiles.premisesId,
      premisesName: schema.premises.name,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .leftJoin(
      schema.staffProfiles,
      and(
        eq(schema.staffProfiles.userId, schema.memberships.userId),
        eq(schema.staffProfiles.organizationId, organizationId)
      )
    )
    .leftJoin(schema.premises, eq(schema.premises.id, schema.staffProfiles.premisesId))
    .where(eq(schema.memberships.organizationId, organizationId));

  return rows.map((row) => ({
    userId: row.userId,
    email: row.email,
    fullName: row.fullName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    isActive: row.isActive,
    joinedAt: row.joinedAt.toISOString(),
    staffProfileId: row.staffProfileId,
    staffCode: row.staffCode,
    premisesId: row.premisesId,
    premisesName: row.premisesName ?? null,
  }));
}

/**
 * Deactivates (never deletes) a member of the organization.
 *
 * `docs/SECURITY.md` §2.4 requires biometric data to be deleted upon
 * termination, so deactivating a staff member also removes their face template.
 */
export async function deactivateMember(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  targetUserId: string
): Promise<{ deactivated: boolean }> {
  if (targetUserId === actorUserId) {
    throw new AppError('You cannot deactivate your own account', 400, 'SELF_DEACTIVATION');
  }

  const [membership] = await fastify.db
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.userId, targetUserId)
      )
    )
    .limit(1);

  if (!membership) {
    throw new AppError('Member not found in this organization', 404, 'MEMBER_NOT_FOUND');
  }

  if (membership.role === 'OWNER') {
    throw new AppError(
      'The organization owner cannot be deactivated',
      403,
      'OWNER_DEACTIVATION_FORBIDDEN'
    );
  }

  await fastify.db.transaction(async (tx) => {
    await tx
      .update(schema.memberships)
      .set({ isActive: false })
      .where(
        and(
          eq(schema.memberships.organizationId, organizationId),
          eq(schema.memberships.userId, targetUserId)
        )
      );

    const [profile] = await tx
      .select({ id: schema.staffProfiles.id })
      .from(schema.staffProfiles)
      .where(
        and(
          eq(schema.staffProfiles.organizationId, organizationId),
          eq(schema.staffProfiles.userId, targetUserId)
        )
      )
      .limit(1);

    if (profile) {
      await tx
        .update(schema.staffProfiles)
        .set({ terminationDate: new Date().toISOString().slice(0, 10) })
        .where(eq(schema.staffProfiles.id, profile.id));

      // Biometric data must be purged on termination.
      await tx
        .delete(schema.faceTemplates)
        .where(eq(schema.faceTemplates.staffProfileId, profile.id));

      await tx.insert(schema.employmentRecords).values({
        staffProfileId: profile.id,
        status: 'TERMINATED',
        effectiveFrom: new Date().toISOString().slice(0, 10),
        note: 'Employment terminated.',
      });
    }
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'MEMBER_DEACTIVATED',
    resourceType: 'membership',
    resourceId: membership.id,
    metadata: { targetUserId, role: membership.role },
  });

  return { deactivated: true };
}
