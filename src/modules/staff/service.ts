import { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { InviteStaffInput, Staff } from './schemas.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';

export async function getStaffList(
  fastify: FastifyInstance,
  organizationId: string
): Promise<Staff[]> {
  const rows = await fastify.db
    .select({
      id: schema.staffProfiles.id,
      userId: schema.staffProfiles.userId,
      email: schema.users.email,
      fullName: schema.users.fullName,
      staffCode: schema.staffProfiles.staffCode,
      department: schema.staffProfiles.department,
      designation: schema.staffProfiles.designation,
      premisesId: schema.staffProfiles.premisesId,
      premisesName: schema.premises.name,
      hireDate: schema.staffProfiles.hireDate,
      isActive: schema.users.isActive,
    })
    .from(schema.staffProfiles)
    .innerJoin(schema.users, eq(schema.staffProfiles.userId, schema.users.id))
    .leftJoin(schema.premises, eq(schema.premises.id, schema.staffProfiles.premisesId))
    .where(eq(schema.staffProfiles.organizationId, organizationId));

  if (rows.length === 0) {
    return [];
  }

  // Latest compensation plan per staff member
  const salaryRows = await fastify.db
    .select({
      staffProfileId: schema.salaryStructures.staffProfileId,
      compensationType: schema.salaryStructures.compensationType,
      baseRateCents: schema.salaryStructures.baseRateCents,
      overtimeRateCents: schema.salaryStructures.overtimeRateCents,
      effectiveFrom: schema.salaryStructures.effectiveFrom,
    })
    .from(schema.salaryStructures)
    .innerJoin(
      schema.staffProfiles,
      eq(schema.staffProfiles.id, schema.salaryStructures.staffProfileId)
    )
    .where(eq(schema.staffProfiles.organizationId, organizationId))
    .orderBy(desc(schema.salaryStructures.effectiveFrom));

  const salaryByProfile = new Map<string, (typeof salaryRows)[number]>();
  for (const row of salaryRows) {
    if (!salaryByProfile.has(row.staffProfileId)) {
      salaryByProfile.set(row.staffProfileId, row);
    }
  }

  // Wallet balances
  const walletRows = await fastify.db
    .select({
      staffProfileId: schema.wallets.staffProfileId,
      walletId: schema.wallets.id,
    })
    .from(schema.wallets)
    .innerJoin(
      schema.staffProfiles,
      eq(schema.staffProfiles.id, schema.wallets.staffProfileId)
    )
    .where(eq(schema.staffProfiles.organizationId, organizationId));

  const balanceByWallet = new Map<string, { earned: number; approved: number; paid: number }>();
  if (walletRows.length > 0) {
    const aggRows = await fastify.db
      .select({
        walletId: schema.walletTransactions.walletId,
        earned: sql<number>`COALESCE(SUM(CASE WHEN ${schema.walletTransactions.balanceBucket} = 'EARNED' THEN ${schema.walletTransactions.amountCents} ELSE 0 END), 0)`,
        approved: sql<number>`COALESCE(SUM(CASE WHEN ${schema.walletTransactions.balanceBucket} = 'APPROVED_UNPAID' THEN ${schema.walletTransactions.amountCents} ELSE 0 END), 0)`,
        paid: sql<number>`COALESCE(SUM(CASE WHEN ${schema.walletTransactions.balanceBucket} = 'PAID' THEN ${schema.walletTransactions.amountCents} ELSE 0 END), 0)`,
      })
      .from(schema.walletTransactions)
      .where(
        sql`${schema.walletTransactions.walletId} IN (${sql.join(
          walletRows.map((w) => sql`${w.walletId}`),
          sql`, `
        )})`
      )
      .groupBy(schema.walletTransactions.walletId);

    for (const agg of aggRows) {
      balanceByWallet.set(agg.walletId, {
        earned: Number(agg.earned ?? 0),
        approved: Number(agg.approved ?? 0),
        paid: Number(agg.paid ?? 0),
      });
    }
  }

  const walletByProfile = new Map<string, { earned: number; approved: number; paid: number }>();
  for (const wallet of walletRows) {
    walletByProfile.set(
      wallet.staffProfileId,
      balanceByWallet.get(wallet.walletId) ?? { earned: 0, approved: 0, paid: 0 }
    );
  }

  return rows.map((r) => {
    const salary = salaryByProfile.get(r.id);
    const wallet = walletByProfile.get(r.id) ?? { earned: 0, approved: 0, paid: 0 };
    return {
      id: r.id,
      userId: r.userId,
      email: r.email,
      fullName: r.fullName,
      staffCode: r.staffCode,
      department: r.department,
      designation: r.designation,
      premisesId: r.premisesId,
      premisesName: r.premisesName ?? null,
      hireDate: String(r.hireDate),
      isActive: r.isActive,
      compensationType: salary?.compensationType ?? null,
      baseRateCents: salary?.baseRateCents ?? null,
      overtimeRateCents: salary?.overtimeRateCents ?? null,
      earnedBalanceCents: wallet.earned,
      approvedUnpaidBalanceCents: wallet.approved,
      paidBalanceCents: wallet.paid,
      totalBalanceCents: wallet.earned + wallet.approved + wallet.paid,
    };
  });
}

export async function inviteStaff(
  fastify: FastifyInstance,
  organizationId: string,
  invitedByUserId: string,
  input: InviteStaffInput
): Promise<Staff> {
  let [user] = await fastify.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, input.email))
    .limit(1);

  if (!user) {
    [user] = await fastify.db
      .insert(schema.users)
      .values({
        email: input.email,
        fullName: input.fullName,
        isActive: true,
      })
      .returning();
  }

  const [existingMembership] = await fastify.db
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.userId, user.id)
      )
    )
    .limit(1);

  if (!existingMembership) {
    await fastify.db.insert(schema.memberships).values({
      organizationId,
      userId: user.id,
      role: input.role,
      isActive: true,
    });
  }

  let [profile] = await fastify.db
    .select()
    .from(schema.staffProfiles)
    .where(
      and(
        eq(schema.staffProfiles.organizationId, organizationId),
        eq(schema.staffProfiles.userId, user.id)
      )
    )
    .limit(1);

  if (!profile) {
    [profile] = await fastify.db
      .insert(schema.staffProfiles)
      .values({
        organizationId,
        userId: user.id,
        premisesId: input.premisesId || null,
        staffCode: input.staffCode,
        department: input.department || null,
        designation: input.designation || null,
        hireDate: new Date().toISOString().split('T')[0],
      })
      .returning();
  }

  await fastify.db
    .insert(schema.wallets)
    .values({ staffProfileId: profile.id })
    .onConflictDoNothing({ target: schema.wallets.staffProfileId });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: invitedByUserId,
    action: 'STAFF_INVITED',
    resourceType: 'staffProfile',
    resourceId: profile.id,
    metadata: { email: user.email },
  });

  return {
    id: profile.id,
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    staffCode: profile.staffCode,
    department: profile.department,
    designation: profile.designation,
    premisesId: profile.premisesId,
    premisesName: null,
    hireDate: String(profile.hireDate),
    isActive: user.isActive,
    compensationType: null,
    baseRateCents: null,
    overtimeRateCents: null,
    earnedBalanceCents: 0,
    approvedUnpaidBalanceCents: 0,
    paidBalanceCents: 0,
    totalBalanceCents: 0,
  };
}

export async function updateStaffPremises(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  staffProfileId: string,
  premisesId: string | null
): Promise<void> {
  const [profile] = await fastify.db
    .select()
    .from(schema.staffProfiles)
    .where(
      and(
        eq(schema.staffProfiles.id, staffProfileId),
        eq(schema.staffProfiles.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!profile) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  if (premisesId) {
    const [prem] = await fastify.db
      .select()
      .from(schema.premises)
      .where(
        and(
          eq(schema.premises.id, premisesId),
          eq(schema.premises.organizationId, organizationId)
        )
      )
      .limit(1);

    if (!prem) {
      throw new AppError('Premises location not found', 404, 'PREMISES_NOT_FOUND');
    }
  }

  await fastify.db
    .update(schema.staffProfiles)
    .set({ premisesId, updatedAt: new Date() })
    .where(eq(schema.staffProfiles.id, staffProfileId));

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'STAFF_PREMISES_ASSIGNED',
    resourceType: 'staffProfile',
    resourceId: staffProfileId,
    metadata: { premisesId },
  });
}

export async function getSalaryStructure(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string
) {
  const rows = await fastify.db
    .select({
      id: schema.salaryStructures.id,
      staffProfileId: schema.salaryStructures.staffProfileId,
      compensationType: schema.salaryStructures.compensationType,
      baseRateCents: schema.salaryStructures.baseRateCents,
      overtimeRateCents: schema.salaryStructures.overtimeRateCents,
      effectiveFrom: schema.salaryStructures.effectiveFrom,
    })
    .from(schema.salaryStructures)
    .innerJoin(
      schema.staffProfiles,
      eq(schema.staffProfiles.id, schema.salaryStructures.staffProfileId)
    )
    .where(
      and(
        eq(schema.salaryStructures.staffProfileId, staffProfileId),
        eq(schema.staffProfiles.organizationId, organizationId)
      )
    )
    .orderBy(desc(schema.salaryStructures.effectiveFrom));

  return rows.map((row) => ({
    ...row,
    effectiveFrom: String(row.effectiveFrom),
  }));
}

export async function upsertSalaryStructure(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  staffProfileId: string,
  input: {
    compensationType: 'MONTHLY' | 'DAILY' | 'HOURLY' | 'SHIFT' | 'MIXED';
    baseRateCents: number;
    overtimeRateCents: number;
    effectiveFrom?: string;
  }
) {
  const [profile] = await fastify.db
    .select({ id: schema.staffProfiles.id })
    .from(schema.staffProfiles)
    .where(
      and(
        eq(schema.staffProfiles.id, staffProfileId),
        eq(schema.staffProfiles.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!profile) {
    throw new AppError('Staff member not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString().slice(0, 10);

  const [created] = await fastify.db
    .insert(schema.salaryStructures)
    .values({
      staffProfileId,
      compensationType: input.compensationType,
      baseRateCents: input.baseRateCents,
      overtimeRateCents: input.overtimeRateCents,
      effectiveFrom,
    })
    .returning();

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'SALARY_STRUCTURE_SET',
    resourceType: 'staffProfile',
    resourceId: staffProfileId,
    metadata: {
      compensationType: input.compensationType,
      baseRateCents: input.baseRateCents,
      overtimeRateCents: input.overtimeRateCents,
      effectiveFrom,
    },
  });

  return {
    id: created.id,
    staffProfileId: created.staffProfileId,
    compensationType: created.compensationType,
    baseRateCents: created.baseRateCents,
    overtimeRateCents: created.overtimeRateCents,
    effectiveFrom: String(created.effectiveFrom),
  };
}
