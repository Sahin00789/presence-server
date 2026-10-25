import { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../errors/app-error.js';

export type StaffProfileRecord = typeof schema.staffProfiles.$inferSelect;

/**
 * Resolves the staff profile that belongs to the authenticated user inside the
 * given organization. Every staff-scoped query funnels through here so the
 * `organization_id` guard is applied in exactly one place
 * (`docs/ROLE_PERMISSIONS.md` §3).
 */
export async function findStaffProfile(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string
): Promise<StaffProfileRecord | null> {
  const [profile] = await fastify.db
    .select()
    .from(schema.staffProfiles)
    .where(
      and(
        eq(schema.staffProfiles.userId, userId),
        eq(schema.staffProfiles.organizationId, organizationId)
      )
    )
    .limit(1);

  return profile ?? null;
}

/**
 * Same as {@link findStaffProfile} but creates a profile on demand.
 *
 * Managers are also employees (`docs/ROLE_PERMISSIONS.md` allows a Manager to
 * clock in "If Employed"), so an employment record can legitimately be created
 * the first time somebody clocks in.
 */
export async function ensureStaffProfile(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string
): Promise<StaffProfileRecord> {
  const existing = await findStaffProfile(fastify, userId, organizationId);
  if (existing) {
    return existing;
  }

  const [created] = await fastify.db
    .insert(schema.staffProfiles)
    .values({
      organizationId,
      userId,
      staffCode: await generateStaffCode(fastify, organizationId),
      hireDate: new Date().toISOString().slice(0, 10),
    })
    .returning();

  await fastify.db.insert(schema.employmentRecords).values({
    staffProfileId: created.id,
    status: 'ACTIVE',
    effectiveFrom: created.hireDate,
    note: 'Auto-provisioned on first clock-in.',
  });

  return created;
}

/**
 * Resolves a staff profile by either staffProfileId or userId.
 * Auto-provisions a staff profile if the user exists in the organization but
 * does not have a staff profile record yet (e.g. Managers).
 */
export async function resolveStaffProfile(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileOrUserId: string
): Promise<StaffProfileRecord> {
  const [byProfileId] = await fastify.db
    .select()
    .from(schema.staffProfiles)
    .where(
      and(
        eq(schema.staffProfiles.id, staffProfileOrUserId),
        eq(schema.staffProfiles.organizationId, organizationId)
      )
    )
    .limit(1);

  if (byProfileId) {
    return byProfileId;
  }

  const byUserId = await findStaffProfile(fastify, staffProfileOrUserId, organizationId);
  if (byUserId) {
    return byUserId;
  }

  const [membership] = await fastify.db
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.userId, staffProfileOrUserId)
      )
    )
    .limit(1);

  if (membership) {
    return await ensureStaffProfile(fastify, membership.userId, organizationId);
  }

  throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
}

/** Generates a unique human-readable staff code such as `STF-0007`. */
export async function generateStaffCode(
  fastify: FastifyInstance,
  organizationId: string
): Promise<string> {
  const rows = await fastify.db
    .select({ id: schema.staffProfiles.id })
    .from(schema.staffProfiles)
    .where(eq(schema.staffProfiles.organizationId, organizationId));

  const used = new Set<string>();
  for (const row of rows) {
    used.add(row.id);
  }

  // Codes are derived from the row count plus a random suffix to stay unique
  // even under concurrent inserts.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = `STF-${String(rows.length + attempt + 1).padStart(4, '0')}-${Math.floor(
      Math.random() * 900 + 100
    )}`;
    const [clash] = await fastify.db
      .select({ id: schema.staffProfiles.id })
      .from(schema.staffProfiles)
      .where(
        and(
          eq(schema.staffProfiles.organizationId, organizationId),
          eq(schema.staffProfiles.staffCode, candidate)
        )
      )
      .limit(1);
    if (!clash) {
      return candidate;
    }
  }

  return `STF-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Resolves every user id that should receive operational notifications for a
 * given organization (owners + managers + the staff member themselves).
 */
export async function resolveNotificationTargets(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId?: string,
  includeManagers = true
): Promise<string[]> {
  const targets = new Set<string>();

  const memberships = await fastify.db
    .select({ userId: schema.memberships.userId, role: schema.memberships.role })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.isActive, true)
      )
    );

  for (const membership of memberships) {
    if (includeManagers && (membership.role === 'OWNER' || membership.role === 'MANAGER')) {
      targets.add(membership.userId);
    }
  }

  if (staffProfileId) {
    const [profile] = await fastify.db
      .select({ userId: schema.staffProfiles.userId })
      .from(schema.staffProfiles)
      .where(eq(schema.staffProfiles.id, staffProfileId))
      .limit(1);
    if (profile) {
      targets.add(profile.userId);
    }
  }

  return [...targets];
}

/**
 * Lists every active staff profile of an organization joined with its user.
 */
export async function listOrganizationStaff(
  fastify: FastifyInstance,
  organizationId: string
): Promise<
  Array<
    typeof schema.staffProfiles.$inferSelect & {
      email: string;
      fullName: string;
      userIsActive: boolean;
    }
  >
> {
  return fastify.db
    .select({
      id: schema.staffProfiles.id,
      organizationId: schema.staffProfiles.organizationId,
      userId: schema.staffProfiles.userId,
      premisesId: schema.staffProfiles.premisesId,
      staffCode: schema.staffProfiles.staffCode,
      department: schema.staffProfiles.department,
      designation: schema.staffProfiles.designation,
      hireDate: schema.staffProfiles.hireDate,
      terminationDate: schema.staffProfiles.terminationDate,
      createdAt: schema.staffProfiles.createdAt,
      updatedAt: schema.staffProfiles.updatedAt,
      email: schema.users.email,
      fullName: schema.users.fullName,
      userIsActive: schema.users.isActive,
    })
    .from(schema.staffProfiles)
    .innerJoin(schema.users, eq(schema.staffProfiles.userId, schema.users.id))
    .where(eq(schema.staffProfiles.organizationId, organizationId));
}

/**
 * Returns the user ids of all owners of an organization.
 */
export async function listOwnerUserIds(
  fastify: FastifyInstance,
  organizationId: string
): Promise<string[]> {
  const rows = await fastify.db
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.role, 'OWNER'),
        eq(schema.memberships.isActive, true)
      )
    );

  return rows.map((row) => row.userId);
}

/**
 * Returns the user ids of every active manager of an organization.
 */
export async function listManagerUserIds(
  fastify: FastifyInstance,
  organizationId: string
): Promise<string[]> {
  const rows = await fastify.db
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.role, 'MANAGER'),
        eq(schema.memberships.isActive, true)
      )
    );

  return rows.map((row) => row.userId);
}

/**
 * Returns the user ids of the given staff profile ids inside an organization.
 */
export async function listUserIdsForProfiles(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileIds: string[]
): Promise<string[]> {
  if (staffProfileIds.length === 0) {
    return [];
  }

  const rows = await fastify.db
    .select({ userId: schema.staffProfiles.userId })
    .from(schema.staffProfiles)
    .where(
      and(
        eq(schema.staffProfiles.organizationId, organizationId),
        inArray(schema.staffProfiles.id, staffProfileIds)
      )
    );

  return rows.map((row) => row.userId);
}
