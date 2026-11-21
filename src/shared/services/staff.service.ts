import { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../errors/app-error.js';

export type StaffProfileRecord = typeof schema.employees.$inferSelect;

/**
 * Purpose: Resolves the employee record for a given user ID within a specific organization.
 * How it works: Performs a SELECT on `employees` table matching `userId` and `organizationId`. Returns `null` if not found.
 *
 * @param fastify Fastify app instance containing Drizzle ORM client.
 * @param userId UUID of the user account.
 * @param organizationId UUID of the target organization.
 * @returns StaffProfileRecord or null if user has no employee profile in this organization.
 */
export async function findStaffProfile(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string
): Promise<StaffProfileRecord | null> {
  const [profile] = await fastify.db
    .select()
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.userId, userId),
        eq(schema.employees.organizationId, organizationId)
      )
    )
    .limit(1);

  return profile ?? null;
}

/**
 * Purpose: Ensures an employee profile exists for a user, creating one on-demand if missing.
 * How it works: Checks `findStaffProfile`. If missing, confirms user exists and is not the organization owner (owners cannot be employees).
 * Inserts a new row into `employees` with an auto-generated staff code and returns the created record.
 *
 * @param fastify Fastify instance.
 * @param userId UUID of the user.
 * @param organizationId UUID of the organization.
 * @returns StaffProfileRecord instance.
 * @throws AppError 404 if user not found; 400 if user is organization owner.
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

  const [user] = await fastify.db
    .select({ fullName: schema.users.fullName })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user) {
    throw new AppError('User account not found', 404, 'USER_NOT_FOUND');
  }

  const [org] = await fastify.db
    .select({ ownerUserId: schema.organizations.ownerUserId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  if (org?.ownerUserId === userId) {
    throw new AppError(
      'The organization owner is not an employee and cannot have an employee profile.',
      400,
      'OWNER_CANNOT_BE_EMPLOYEE'
    );
  }

  const [created] = await fastify.db
    .insert(schema.employees)
    .values({
      organizationId,
      userId,
      role: 'EMPLOYEE',
      name: user.fullName,
      employeeCode: await generateStaffCode(fastify, organizationId),
      hireDate: new Date().toISOString().slice(0, 10),
    })
    .returning();

  return created;
}

/**
 * Purpose: Flexible staff profile resolver accepting either an `employeeId` or a `userId`.
 * How it works: Attempts direct lookup by employee primary key `id`. If missing, attempts lookup by `userId`.
 * If missing, checks if `employeeOrUserId` is a valid `users.id` and creates a profile via `ensureStaffProfile`.
 *
 * @param fastify Fastify instance.
 * @param organizationId UUID of the organization.
 * @param employeeOrUserId UUID representing either an employee record ID or user ID.
 * @returns Resolved StaffProfileRecord.
 * @throws AppError 404 if no employee or user match is found.
 */
export async function resolveStaffProfile(
  fastify: FastifyInstance,
  organizationId: string,
  employeeOrUserId: string
): Promise<StaffProfileRecord> {
  const [byEmployeeId] = await fastify.db
    .select()
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.id, employeeOrUserId),
        eq(schema.employees.organizationId, organizationId)
      )
    )
    .limit(1);

  if (byEmployeeId) {
    return byEmployeeId;
  }

  const byUserId = await findStaffProfile(fastify, employeeOrUserId, organizationId);
  if (byUserId) {
    return byUserId;
  }

  const [user] = await fastify.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, employeeOrUserId))
    .limit(1);

  if (user) {
    return ensureStaffProfile(fastify, user.id, organizationId);
  }

  throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
}

/**
 * Purpose: Generates a collision-resistant human-readable staff code (e.g., `STF-0007-123`).
 * How it works: Counts existing employees in organization, formats candidate code, checks DB for uniqueness up to 25 attempts,
 * falling back to a base-36 timestamp suffix if all candidates collide.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @returns Unique staff code string.
 */
export async function generateStaffCode(
  fastify: FastifyInstance,
  organizationId: string
): Promise<string> {
  const rows = await fastify.db
    .select({ id: schema.employees.id })
    .from(schema.employees)
    .where(eq(schema.employees.organizationId, organizationId));

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = `STF-${String(rows.length + attempt + 1).padStart(4, '0')}-${Math.floor(
      Math.random() * 900 + 100
    )}`;
    const [clash] = await fastify.db
      .select({ id: schema.employees.id })
      .from(schema.employees)
      .where(
        and(
          eq(schema.employees.organizationId, organizationId),
          eq(schema.employees.employeeCode, candidate)
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
 * Purpose: Identifies all user IDs that should receive operational notifications for an action.
 * How it works: Queries the organization owner user ID (if `includeOwners` is true) and the target employee user ID (if `employeeId` given).
 * Returns a deduplicated array of user ID strings.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @param employeeId Optional staff profile UUID.
 * @param includeOwners Whether to include organization owner user ID (default true).
 * @param premisesId Optional premises UUID.
 * @returns Array of target user ID strings.
 */
export async function resolveNotificationTargets(
  fastify: FastifyInstance,
  organizationId: string,
  employeeId?: string,
  includeOwners = true,
  premisesId?: string | null
): Promise<string[]> {
  const targets = new Set<string>();

  if (includeOwners) {
    const [organization] = await fastify.db
      .select({ ownerUserId: schema.organizations.ownerUserId })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, organizationId))
      .limit(1);

    if (organization?.ownerUserId) {
      targets.add(organization.ownerUserId);
    }
  }

  if (employeeId) {
    const [profile] = await fastify.db
      .select({ userId: schema.employees.userId, premisesId: schema.employees.premisesId })
      .from(schema.employees)
      .where(eq(schema.employees.id, employeeId))
      .limit(1);
    if (profile?.userId) {
      targets.add(profile.userId);
    }
  }

  return [...targets];
}

/**
 * Purpose: Lists all employee records for an organization joined with user profile info.
 * How it works: Performs a LEFT JOIN between `employees` and `users` on `userId`, returning array of enriched staff records.
 *
 * @param fastify Fastify instance.
 * @param organizationId Organization UUID.
 * @returns Array of employee records enriched with `email`, `fullName`, and `userIsActive`.
 */
export async function listOrganizationStaff(
  fastify: FastifyInstance,
  organizationId: string
): Promise<
  Array<
    typeof schema.employees.$inferSelect & {
      email: string;
      fullName: string;
      userIsActive: boolean;
    }
  >
> {
  const rows = await fastify.db
    .select({
      id: schema.employees.id,
      organizationId: schema.employees.organizationId,
      userId: schema.employees.userId,
      premisesId: schema.employees.premisesId,
      role: schema.employees.role,
      employeeCode: schema.employees.employeeCode,
      name: schema.employees.name,
      department: schema.employees.department,
      designation: schema.employees.designation,
      address: schema.employees.address,
      hireDate: schema.employees.hireDate,
      terminationDate: schema.employees.terminationDate,
      isActive: schema.employees.isActive,
      createdAt: schema.employees.createdAt,
      updatedAt: schema.employees.updatedAt,
      userEmail: schema.users.email,
      userFullName: schema.users.fullName,
      userIsActive: schema.users.isActive,
    })
    .from(schema.employees)
    .leftJoin(schema.users, eq(schema.employees.userId, schema.users.id))
    .where(eq(schema.employees.organizationId, organizationId));

  return rows.map((r) => ({
    ...r,
    email: r.userEmail ?? '',
    fullName: r.userFullName || r.name,
    userIsActive: r.userIsActive ?? r.isActive,
  }));
}

/**
 * Purpose: Retrieves user IDs of all owners of an organization.
 * How it works: Queries `organizations.ownerUserId` for the specified `organizationId`.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @returns Array containing owner user ID strings.
 */
export async function listOwnerUserIds(
  fastify: FastifyInstance,
  organizationId: string
): Promise<string[]> {
  const rows = await fastify.db
    .select({ ownerUserId: schema.organizations.ownerUserId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId));

  return rows.map((row) => row.ownerUserId);
}

/**
 * Purpose: Legacy compatibility helper returning manager user IDs.
 * How it works: In the simplified 2-role system (OWNER & EMPLOYEE), returns an empty array.
 *
 * @param fastify Fastify instance.
 * @param organizationId Target organization UUID.
 * @returns Empty array of strings.
 */
export async function listManagerUserIds(
  fastify: FastifyInstance,
  organizationId: string
): Promise<string[]> {
  return [];
}
