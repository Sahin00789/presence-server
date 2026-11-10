import { FastifyInstance } from 'fastify';
import { and, count, eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { sendOrganizationWelcomeEmail } from '../../shared/services/mail.service.js';
import {
  CreateOrganizationInput,
  Organization,
  OrganizationMember,
  OrganizationSummary,
  UpdateOrganizationInput,
} from './schemas.js';



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

  const [employeeTotals] = await fastify.db
    .select({ total: count() })
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        eq(schema.employees.isActive, true),
        eq(schema.employees.role, 'EMPLOYEE')
      )
    );

  const totalEmployees = employeeTotals?.total ?? 0;
  const memberCount = 1 + totalEmployees;

  return {
    organization,
    memberCount,
    staffCount: totalEmployees,
    managerCount: 0,
  };
}

/**
 * Creates an additional organization for an Owner.
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

  setImmediate(() => {
    fastify.db
      .select({ email: schema.users.email, fullName: schema.users.fullName })
      .from(schema.users)
      .where(eq(schema.users.id, ownerUserId))
      .limit(1)
      .then(([ownerUser]) => {
        if (ownerUser?.email) {
          return sendOrganizationWelcomeEmail({
            to: ownerUser.email,
            ownerName: ownerUser.fullName,
            organizationName: result.name,
            premisesName: input.premisesName,
            premisesAddress: input.premisesAddress,
            radiusMeters: input.radiusMeters ?? 50,
            logger: fastify.log,
          });
        }
      })
      .catch((err) => {
        fastify.log.warn({ err, ownerUserId }, 'Failed to send organization welcome email');
      });
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
  const resolvedLogoUrl = input.logo || input.logoUrl;

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
        role: ((row.role as string) === 'OWNER' ? 'OWNER' : 'EMPLOYEE') as any,
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

    await tx
      .delete(schema.multiPoseFaceTemplates)
      .where(eq(schema.multiPoseFaceTemplates.employeeId, profile.id));
  });

  return { deactivated: true };
}

export async function uploadOrganizationLogo(
  fastify: FastifyInstance,
  organizationId: string,
  _actorUserId: string,
  input: { logoBase64?: string; logoUrl?: string; logo?: string }
): Promise<{ organizationId: string; logoUrl: string }> {
  const logoInput = input.logoBase64 || input.logoUrl || input.logo;
  if (!logoInput) {
    throw new AppError('Logo data (logoBase64 or logoUrl) is required', 400, 'LOGO_REQUIRED');
  }

  const resolvedLogoUrl = input.logoBase64 || input.logoUrl || input.logo || logoInput;

  const [updated] = await fastify.db
    .update(schema.organizations)
    .set({ logoUrl: resolvedLogoUrl, updatedAt: new Date() })
    .where(eq(schema.organizations.id, organizationId))
    .returning();

  if (!updated) {
    throw new AppError('Organization not found', 404, 'ORGANIZATION_NOT_FOUND');
  }

  return { organizationId: updated.id, logoUrl: updated.logoUrl || '' };
}

export async function uploadOwnerPhoto(
  fastify: FastifyInstance,
  _organizationId: string,
  ownerUserId: string,
  input: { photoBase64?: string; photoUrl?: string; avatarBase64?: string; avatarUrl?: string }
): Promise<{ ownerUserId: string; avatarUrl: string }> {
  const rawPhoto = input.photoBase64 || input.avatarBase64 || input.photoUrl || input.avatarUrl;
  if (!rawPhoto) {
    throw new AppError('Owner photo payload (photoBase64 or photoUrl) is required', 400, 'PHOTO_REQUIRED');
  }

  const uploadedUrl = input.photoBase64 || input.avatarBase64 || input.photoUrl || input.avatarUrl || rawPhoto;

  await fastify.db
    .update(schema.users)
    .set({ avatarUrl: uploadedUrl, updatedAt: new Date() })
    .where(eq(schema.users.id, ownerUserId));

  return { ownerUserId, avatarUrl: uploadedUrl };
}
