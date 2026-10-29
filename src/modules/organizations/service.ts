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

  const [staffTotals] = await fastify.db
    .select({ total: count() })
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        eq(schema.employees.isActive, true),
        eq(schema.employees.role, 'STAFF')
      )
    );

  const [managerTotals] = await fastify.db
    .select({ total: count() })
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        eq(schema.employees.isActive, true),
        eq(schema.employees.role, 'MANAGER')
      )
    );

  const memberCount = 1 + (staffTotals?.total ?? 0) + (managerTotals?.total ?? 0);

  return {
    organization,
    memberCount,
    staffCount: staffTotals?.total ?? 0,
    managerCount: managerTotals?.total ?? 0,
  };
}

/**
 * Creates an additional organization for an Owner.
 *
 * Ownership is recorded directly on `organizations.owner_user_id`; there is no
 * separate membership table. A user may own more than one organization.
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
        ownerUserId,
        name: input.name,
        timezone: input.timezone,
        currency: input.currency.toUpperCase(),
      })
      .returning();

    if (input.premisesName) {
      await tx.insert(schema.premises).values({
        organizationId: organization.id,
        name: input.premisesName,
        address: input.premisesAddress,
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
  const [owner] = await fastify.db
    .select({
      organizationId: schema.organizations.id,
      joinedAt: schema.organizations.createdAt,
      userId: schema.users.id,
      email: schema.users.email,
      fullName: schema.users.fullName,
      avatarUrl: schema.users.avatarUrl,
      userIsActive: schema.users.isActive,
    })
    .from(schema.organizations)
    .innerJoin(schema.users, eq(schema.organizations.ownerUserId, schema.users.id))
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  if (!owner) {
    throw new AppError('Organization not found', 404, 'ORGANIZATION_NOT_FOUND');
  }

  const employeeRows = await fastify.db
    .select({
      userId: schema.employees.userId,
      email: schema.users.email,
      fullName: schema.users.fullName,
      avatarUrl: schema.users.avatarUrl,
      role: schema.employees.role,
      isActive: schema.employees.isActive,
      userIsActive: schema.users.isActive,
      joinedAt: schema.employees.createdAt,
      staffProfileId: schema.employees.id,
      staffCode: schema.employees.employeeCode,
      premisesId: schema.employees.premisesId,
      premisesName: schema.premises.name,
    })
    .from(schema.employees)
    .innerJoin(schema.users, eq(schema.employees.userId, schema.users.id))
    .leftJoin(schema.premises, eq(schema.premises.id, schema.employees.premisesId))
    .where(eq(schema.employees.organizationId, organizationId));

  const members: OrganizationMember[] = [
    {
      userId: owner.userId,
      email: owner.email,
      fullName: owner.fullName,
      avatarUrl: owner.avatarUrl,
      role: 'OWNER',
      isActive: owner.userIsActive,
      joinedAt: owner.joinedAt.toISOString(),
      staffProfileId: null,
      staffCode: null,
      premisesId: null,
      premisesName: null,
    },
    ...employeeRows
      .filter((row) => row.userId)
      .map((row) => ({
        userId: row.userId as string,
        email: row.email,
        fullName: row.fullName,
        avatarUrl: row.avatarUrl,
        role: row.role,
        isActive: row.isActive && row.userIsActive,
        joinedAt: row.joinedAt.toISOString(),
        staffProfileId: row.staffProfileId,
        staffCode: row.staffCode,
        premisesId: row.premisesId,
        premisesName: row.premisesName ?? null,
      })),
  ];

  return members;
}

/**
 * Deactivates (never deletes) an employee of the organization.
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

  const [organization] = await fastify.db
    .select({ ownerUserId: schema.organizations.ownerUserId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  if (!organization) {
    throw new AppError('Organization not found', 404, 'ORGANIZATION_NOT_FOUND');
  }

  if (organization.ownerUserId === targetUserId) {
    throw new AppError(
      'The organization owner cannot be deactivated',
      403,
      'OWNER_DEACTIVATION_FORBIDDEN'
    );
  }

  const [profile] = await fastify.db
    .select()
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        eq(schema.employees.userId, targetUserId)
      )
    )
    .limit(1);

  if (!profile) {
    throw new AppError('Member not found in this organization', 404, 'MEMBER_NOT_FOUND');
  }

  await fastify.db.transaction(async (tx) => {
    await tx
      .update(schema.employees)
      .set({
        isActive: false,
        terminationDate: new Date().toISOString().slice(0, 10),
        updatedAt: new Date(),
      })
      .where(eq(schema.employees.id, profile.id));

    // Biometric data must be purged on termination.
    await tx
      .delete(schema.multiPoseFaceTemplates)
      .where(eq(schema.multiPoseFaceTemplates.employeeId, profile.id));
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'MEMBER_DEACTIVATED',
    resourceType: 'employee',
    resourceId: profile.id,
    metadata: { targetUserId, role: profile.role },
  });

  return { deactivated: true };
}
