import { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../errors/app-error.js';

export type StaffProfileRecord = typeof schema.employees.$inferSelect;

/**
 * Resolves the employee record that belongs to the authenticated user inside
 * the given organization. Every staff-scoped query funnels through here so the
 * `organization_id` guard is applied in exactly one place.
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
 * Same as {@link findStaffProfile} but creates an employee record on demand.
 *
 * Managers are also employees, so an employment record can legitimately be
 * created the first time somebody clocks in.
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
      role: 'STAFF',
      name: user.fullName,
      employeeCode: await generateStaffCode(fastify, organizationId),
      hireDate: new Date().toISOString().slice(0, 10),
    })
    .returning();

  return created;
}

/**
 * Resolves an employee by either employeeId or userId.
 * Auto-provisions an employee record if the user exists in the organization but
 * does not have an employee record yet (e.g. Managers).
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

/** Generates a unique human-readable employee code such as `STF-0007`. */
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
 * Resolves every user id that should receive operational notifications for a
 * given organization (owner + managers + the employee themselves).
 */
export async function resolveNotificationTargets(
  fastify: FastifyInstance,
  organizationId: string,
  employeeId?: string,
  includeManagers = true,
  premisesId?: string | null
): Promise<string[]> {
  const targets = new Set<string>();

  if (includeManagers) {
    const [organization] = await fastify.db
      .select({ ownerUserId: schema.organizations.ownerUserId })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, organizationId))
      .limit(1);

    if (organization?.ownerUserId) {
      targets.add(organization.ownerUserId);
    }

    if (premisesId) {
      const managers = await fastify.db
        .select({ userId: schema.employees.userId })
        .from(schema.employees)
        .where(
          and(
            eq(schema.employees.organizationId, organizationId),
            eq(schema.employees.role, 'MANAGER'),
            eq(schema.employees.isActive, true),
            eq(schema.employees.premisesId, premisesId),
            isNotNull(schema.employees.userId)
          )
        );

      for (const manager of managers) {
        if (manager.userId) {
          targets.add(manager.userId);
        }
      }
    } else {
      const managers = await fastify.db
        .select({ userId: schema.employees.userId })
        .from(schema.employees)
        .where(
          and(
            eq(schema.employees.organizationId, organizationId),
            eq(schema.employees.role, 'MANAGER'),
            eq(schema.employees.isActive, true),
            isNotNull(schema.employees.userId)
          )
        );

      for (const manager of managers) {
        if (manager.userId) {
          targets.add(manager.userId);
        }
      }
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
 * Lists every employee of an organization joined with its user.
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
  return fastify.db
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
      hireDate: schema.employees.hireDate,
      terminationDate: schema.employees.terminationDate,
      isActive: schema.employees.isActive,
      createdAt: schema.employees.createdAt,
      updatedAt: schema.employees.updatedAt,
      email: schema.users.email,
      fullName: schema.users.fullName,
      userIsActive: schema.users.isActive,
    })
    .from(schema.employees)
    .innerJoin(schema.users, eq(schema.employees.userId, schema.users.id))
    .where(eq(schema.employees.organizationId, organizationId));
}

/**
 * Returns the user ids of all owners of an organization.
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
 * Returns the user ids of every active manager of an organization.
 */
export async function listManagerUserIds(
  fastify: FastifyInstance,
  organizationId: string
): Promise<string[]> {
  const rows = await fastify.db
    .select({ userId: schema.employees.userId })
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        eq(schema.employees.role, 'MANAGER'),
        eq(schema.employees.isActive, true),
        isNotNull(schema.employees.userId)
      )
    );

  return rows.map((row) => row.userId).filter((id): id is string => Boolean(id));
}

/**
 * Returns the user ids of the given employee ids inside an organization.
 */
export async function listUserIdsForProfiles(
  fastify: FastifyInstance,
  organizationId: string,
  employeeIds: string[]
): Promise<string[]> {
  if (employeeIds.length === 0) {
    return [];
  }

  const rows = await fastify.db
    .select({ userId: schema.employees.userId })
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        inArray(schema.employees.id, employeeIds)
      )
    );

  return rows.map((row) => row.userId).filter((id): id is string => Boolean(id));
}
