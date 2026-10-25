import { randomBytes } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, gt } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import { generateStaffCode } from '../../shared/services/staff.service.js';
import { sendUserCreationEmail } from '../../shared/services/mail.service.js';
import { CreateInvitationInput, Invitation, InvitationPreview } from './schemas.js';

/** Invitations expire after 48 hours (`docs/REQUIREMENTS.md` FR-AUTH-5). */
export const INVITATION_TTL_HOURS = 48;

function generateInvitationToken(): string {
  return randomBytes(32).toString('hex');
}

export async function createMember(
  fastify: FastifyInstance,
  organizationId: string,
  invitedByUserId: string,
  inviterRole: 'OWNER' | 'MANAGER' | 'STAFF',
  input: CreateInvitationInput
): Promise<Invitation> {
  // Role permissions: OWNER can create MANAGER and STAFF. MANAGER can create STAFF.
  if (inviterRole === 'OWNER' && input.role !== 'MANAGER' && input.role !== 'STAFF') {
    throw new AppError(
      'Owners can add Managers and Staff members.',
      403,
      'INVITATION_ROLE_NOT_PERMITTED'
    );
  }

  if (inviterRole === 'MANAGER' && input.role !== 'STAFF') {
    throw new AppError(
      'Managers can only add Staff members.',
      403,
      'INVITATION_ROLE_NOT_PERMITTED'
    );
  }

  if (inviterRole === 'STAFF') {
    throw new AppError('Staff members cannot add team members', 403, 'INVITATION_FORBIDDEN');
  }

  const email = input.email.toLowerCase().trim();
  const fullName = input.fullName?.trim() || email.split('@')[0];

  // Check if member already belongs to this organization
  const [existingMembership] = await fastify.db
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.users.email, email)
      )
    )
    .limit(1);

  if (existingMembership) {
    throw new AppError(
      'This person is already a member of the organization',
      409,
      'ALREADY_A_MEMBER'
    );
  }

  const metadata: Record<string, unknown> = {};
  if (input.fullName) metadata.fullName = input.fullName;
  if (input.department) metadata.department = input.department;
  if (input.designation) metadata.designation = input.designation;
  if (input.compensationType) metadata.compensationType = input.compensationType;
  if (input.baseRateCents !== undefined) metadata.baseRateCents = input.baseRateCents;

  let staffCode = input.staffCode;
  if (input.role === 'STAFF' && !staffCode) {
    staffCode = await generateStaffCode(fastify, organizationId);
  }
  if (staffCode) metadata.staffCode = staffCode;

  const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000);
  const token = generateInvitationToken();
  const now = new Date();

  // "Created means created": Instantly provision user, membership, staff profile, employment record & wallet
  const createdRecord = await fastify.db.transaction(async (tx) => {
    // 1. Find or create User
    let [userRecord] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (!userRecord) {
      [userRecord] = await tx
        .insert(schema.users)
        .values({
          email,
          fullName,
          isActive: true,
        })
        .returning();
    } else if (!userRecord.isActive) {
      await tx
        .update(schema.users)
        .set({ isActive: true, fullName, updatedAt: now })
        .where(eq(schema.users.id, userRecord.id));
    }

    // 2. Insert Membership
    await tx.insert(schema.memberships).values({
      organizationId,
      userId: userRecord.id,
      role: input.role,
      isActive: true,
    });

    // 3. Insert Staff Profile
    const hireDate = now.toISOString().slice(0, 10);
    const [profile] = await tx
      .insert(schema.staffProfiles)
      .values({
        organizationId,
        userId: userRecord.id,
        premisesId: input.premisesId || null,
        staffCode: staffCode || `STAFF-${Math.floor(1000 + Math.random() * 9000)}`,
        department: input.department || null,
        designation: input.designation || null,
        hireDate,
      })
      .returning();

    // 4. Employment Record
    await tx.insert(schema.employmentRecords).values({
      staffProfileId: profile.id,
      status: 'ACTIVE',
      effectiveFrom: hireDate,
      note: 'Account created directly by Administrator.',
    });

    // 5. Wallet
    await tx
      .insert(schema.wallets)
      .values({ staffProfileId: profile.id })
      .onConflictDoNothing({ target: schema.wallets.staffProfileId });

    // 6. Salary structure if provided
    if (input.compensationType && typeof input.baseRateCents === 'number') {
      await tx.insert(schema.salaryStructures).values({
        staffProfileId: profile.id,
        compensationType: input.compensationType,
        baseRateCents: input.baseRateCents,
        overtimeRateCents: 0,
        effectiveFrom: hireDate,
      });
    }

    // 7. Onboarding record marked accepted immediately
    const [created] = await tx
      .insert(schema.invitations)
      .values({
        organizationId,
        email,
        role: input.role,
        token,
        invitedBy: invitedByUserId,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        acceptedAt: now,
        expiresAt,
      })
      .returning();

    return created;
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: invitedByUserId,
    action: 'USER_CREATED',
    resourceType: 'user',
    resourceId: createdRecord.id,
    metadata: { email, role: input.role },
  });

  // Attempt to deliver welcome email
  try {
    const [org] = await fastify.db
      .select({ name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, organizationId))
      .limit(1);

    await sendUserCreationEmail({
      to: email,
      role: input.role,
      organizationName: org?.name || 'Organization',
      token: createdRecord.token,
      logger: fastify.log,
    });
  } catch (mailErr) {
    fastify.log.warn({ err: mailErr, email }, 'Failed to send user onboarding email');
  }

  return {
    id: createdRecord.id,
    organizationId: createdRecord.organizationId,
    email: createdRecord.email,
    role: createdRecord.role,
    token: createdRecord.token,
    invitedBy: createdRecord.invitedBy,
    metadata: createdRecord.metadata,
    expiresAt: createdRecord.expiresAt.toISOString(),
    acceptedAt: createdRecord.acceptedAt ? createdRecord.acceptedAt.toISOString() : null,
    createdAt: createdRecord.createdAt.toISOString(),
  };
}

export async function listMembers(
  fastify: FastifyInstance,
  organizationId: string
): Promise<Invitation[]> {
  const rows = await fastify.db
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.organizationId, organizationId))
    .orderBy(desc(schema.invitations.createdAt));

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    token: row.token,
    invitedBy: row.invitedBy,
    metadata: row.metadata,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Public preview of member onboarding details so the user can validate the link before
 * signing in.
 */
export async function getMemberPreview(
  fastify: FastifyInstance,
  token: string
): Promise<InvitationPreview> {
  const [invitation] = await fastify.db
    .select({
      email: schema.invitations.email,
      role: schema.invitations.role,
      expiresAt: schema.invitations.expiresAt,
      acceptedAt: schema.invitations.acceptedAt,
      organizationName: schema.organizations.name,
    })
    .from(schema.invitations)
    .innerJoin(
      schema.organizations,
      eq(schema.invitations.organizationId, schema.organizations.id)
    )
    .where(eq(schema.invitations.token, token))
    .limit(1);

  if (!invitation) {
    throw new AppError('Onboarding record not found', 404, 'INVITATION_NOT_FOUND');
  }

  return {
    organizationName: invitation.organizationName,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
    isExpired: invitation.expiresAt.getTime() < Date.now(),
    isAccepted: Boolean(invitation.acceptedAt),
  };
}

/**
 * Completes onboarding for the currently authenticated user.
 */
export async function acceptMemberOnboarding(
  fastify: FastifyInstance,
  userId: string,
  email: string,
  token: string
): Promise<{ organizationId: string; role: 'MANAGER' | 'STAFF' }> {
  const [invitation] = await fastify.db
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.token, token))
    .limit(1);

  if (!invitation) {
    throw new AppError('Onboarding record not found', 404, 'INVITATION_NOT_FOUND');
  }

  if (invitation.acceptedAt) {
    throw new AppError('This onboarding record has already been completed', 409, 'INVITATION_ALREADY_ACCEPTED');
  }

  if (invitation.expiresAt.getTime() < Date.now()) {
    throw new AppError('This onboarding link has expired', 410, 'INVITATION_EXPIRED');
  }

  if (invitation.email.toLowerCase() !== email.toLowerCase()) {
    throw new AppError(
      'This onboarding link was created for a different email address',
      403,
      'INVITATION_EMAIL_MISMATCH'
    );
  }

  const metadata = (invitation.metadata ?? {}) as Record<string, unknown>;

  await fastify.db.transaction(async (tx) => {
    const [existingMembership] = await tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.organizationId, invitation.organizationId),
          eq(schema.memberships.userId, userId)
        )
      )
      .limit(1);

    if (!existingMembership) {
      await tx.insert(schema.memberships).values({
        organizationId: invitation.organizationId,
        userId,
        role: invitation.role,
        isActive: true,
      });
    }

    if (invitation.role === 'STAFF' || invitation.role === 'MANAGER') {
      const [existingProfile] = await tx
        .select({ id: schema.staffProfiles.id })
        .from(schema.staffProfiles)
        .where(
          and(
            eq(schema.staffProfiles.organizationId, invitation.organizationId),
            eq(schema.staffProfiles.userId, userId)
          )
        )
        .limit(1);

      if (!existingProfile) {
        const staffCode =
          (metadata.staffCode as string | undefined) ??
          (await generateStaffCode(fastify, invitation.organizationId));

        const [profile] = await tx
          .insert(schema.staffProfiles)
          .values({
            organizationId: invitation.organizationId,
            userId,
            staffCode,
            department: (metadata.department as string | undefined) ?? null,
            designation: (metadata.designation as string | undefined) ?? null,
            premisesId: (metadata.premisesId as string | undefined) ?? null,
            hireDate: new Date().toISOString().slice(0, 10),
          })
          .returning();

        await tx.insert(schema.employmentRecords).values({
          staffProfileId: profile.id,
          status: 'ACTIVE',
          effectiveFrom: profile.hireDate,
          note: 'Joined organization on account creation.',
        });

        // Every employed member owns exactly one wallet.
        await tx
          .insert(schema.wallets)
          .values({ staffProfileId: profile.id })
          .onConflictDoNothing({ target: schema.wallets.staffProfileId });

        if (metadata.compensationType && typeof metadata.baseRateCents === 'number') {
          await tx.insert(schema.salaryStructures).values({
            staffProfileId: profile.id,
            compensationType: metadata.compensationType as 'MONTHLY',
            baseRateCents: metadata.baseRateCents,
            overtimeRateCents: 0,
            effectiveFrom: profile.hireDate,
          });
        }
      }
    }

    await tx
      .update(schema.invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(schema.invitations.id, invitation.id));
  });

  await writeAuditLog(fastify, {
    organizationId: invitation.organizationId,
    actorId: userId,
    action: 'INVITATION_ACCEPTED',
    resourceType: 'invitation',
    resourceId: invitation.id,
    metadata: { role: invitation.role },
  });

  return { organizationId: invitation.organizationId, role: invitation.role as 'MANAGER' | 'STAFF' };
}

/**
 * Cancels a pending user onboarding record.
 */
export async function revokeMemberOnboarding(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  invitationId: string
): Promise<{ revoked: boolean }> {
  const [invitation] = await fastify.db
    .select()
    .from(schema.invitations)
    .where(
      and(
        eq(schema.invitations.id, invitationId),
        eq(schema.invitations.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!invitation) {
    throw new AppError('Onboarding record not found', 404, 'INVITATION_NOT_FOUND');
  }

  if (invitation.acceptedAt) {
    throw new AppError('An accepted onboarding record cannot be revoked', 409, 'INVITATION_ALREADY_ACCEPTED');
  }

  await fastify.db
    .delete(schema.invitations)
    .where(eq(schema.invitations.id, invitationId));

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'INVITATION_REVOKED',
    resourceType: 'invitation',
    resourceId: invitationId,
  });

  return { revoked: true };
}

// Aliases for backward compatibility
export const createInvitation = createMember;
export const listInvitations = listMembers;
export const getInvitationPreview = getMemberPreview;
export const acceptInvitation = acceptMemberOnboarding;
export const revokeInvitation = revokeMemberOnboarding;
