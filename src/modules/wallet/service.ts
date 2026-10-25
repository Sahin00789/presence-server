import { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { findStaffProfile } from '../../shared/services/staff.service.js';

export async function getWalletSummary(fastify: FastifyInstance, userId: string, organizationId: string) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  let [wallet] = await fastify.db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.staffProfileId, profile.id))
    .limit(1);

  if (!wallet) {
    const [created] = await fastify.db
      .insert(schema.wallets)
      .values({ staffProfileId: profile.id })
      .onConflictDoNothing({ target: schema.wallets.staffProfileId })
      .returning();
    if (!created) {
      [wallet] = await fastify.db
        .select()
        .from(schema.wallets)
        .where(eq(schema.wallets.staffProfileId, profile.id))
        .limit(1);
    } else {
      wallet = created;
    }
  }

  // Re-aggregate from ledger to be authoritative
  const [agg] = await fastify.db
    .select({
      earned: sql<number>`COALESCE(SUM(CASE WHEN ${schema.walletTransactions.balanceBucket} = 'EARNED' THEN ${schema.walletTransactions.amountCents} ELSE 0 END), 0)`,
      approved: sql<number>`COALESCE(SUM(CASE WHEN ${schema.walletTransactions.balanceBucket} = 'APPROVED_UNPAID' THEN ${schema.walletTransactions.amountCents} ELSE 0 END), 0)`,
      paid: sql<number>`COALESCE(SUM(CASE WHEN ${schema.walletTransactions.balanceBucket} = 'PAID' THEN ${schema.walletTransactions.amountCents} ELSE 0 END), 0)`,
    })
    .from(schema.walletTransactions)
    .where(eq(schema.walletTransactions.walletId, wallet.id));

  const earned = Number(agg?.earned ?? 0);
  const approved = Number(agg?.approved ?? 0);
  const paid = Number(agg?.paid ?? 0);

  await fastify.db
    .update(schema.wallets)
    .set({
      earnedBalanceCents: earned,
      approvedUnpaidBalanceCents: approved,
      paidBalanceCents: paid,
      updatedAt: new Date(),
    })
    .where(eq(schema.wallets.id, wallet.id));

  return {
    staffProfileId: profile.id,
    earnedBalanceCents: earned,
    approvedUnpaidBalanceCents: approved,
    paidBalanceCents: paid,
    totalBalanceCents: earned + approved + paid,
  };
}

export async function listWalletTransactions(
  fastify: FastifyInstance,
  userId: string,
  organizationId: string,
  query: { limit?: number; offset?: number }
) {
  const profile = await findStaffProfile(fastify, userId, organizationId);
  if (!profile) {
    throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
  }

  let [wallet] = await fastify.db
    .select()
    .from(schema.wallets)
    .where(eq(schema.wallets.staffProfileId, profile.id))
    .limit(1);

  if (!wallet) {
    const [created] = await fastify.db
      .insert(schema.wallets)
      .values({ staffProfileId: profile.id })
      .onConflictDoNothing({ target: schema.wallets.staffProfileId })
      .returning();
    wallet = created ?? (await fastify.db.select().from(schema.wallets).where(eq(schema.wallets.staffProfileId, profile.id)).limit(1))[0];
  }

  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const txs = await fastify.db
    .select()
    .from(schema.walletTransactions)
    .where(eq(schema.walletTransactions.walletId, wallet.id))
    .orderBy(desc(schema.walletTransactions.createdAt))
    .limit(limit)
    .offset(offset);

  return txs;
}

/**
 * Append-only double-entry ledger posting helper. Every call must provide an idempotency key.
 * This enforces "no direct DB balance updates" - balances are aggregated from transactions.
 */
export async function postLedgerTransaction(
  fastify: FastifyInstance,
  params: {
    walletId: string;
    type: (typeof schema.walletTransactionTypeEnum.enumValues)[number];
    amountCents: number;
    balanceBucket: (typeof schema.walletBucketEnum.enumValues)[number];
    idempotencyKey: string;
    referenceId?: string | null;
    description?: string | null;
  }
) {
  await fastify.db
    .insert(schema.walletTransactions)
    .values({
      walletId: params.walletId,
      type: params.type,
      amountCents: params.amountCents,
      balanceBucket: params.balanceBucket,
      idempotencyKey: params.idempotencyKey,
      referenceId: params.referenceId ?? null,
      description: params.description ?? null,
    })
    .onConflictDoNothing({ target: schema.walletTransactions.idempotencyKey });

  // Re-aggregate and update wallet balance summary view
  const [agg] = await fastify.db
    .select({
      earned: sql<number>`COALESCE(SUM(CASE WHEN ${schema.walletTransactions.balanceBucket} = 'EARNED' THEN ${schema.walletTransactions.amountCents} ELSE 0 END), 0)`,
      approved: sql<number>`COALESCE(SUM(CASE WHEN ${schema.walletTransactions.balanceBucket} = 'APPROVED_UNPAID' THEN ${schema.walletTransactions.amountCents} ELSE 0 END), 0)`,
      paid: sql<number>`COALESCE(SUM(CASE WHEN ${schema.walletTransactions.balanceBucket} = 'PAID' THEN ${schema.walletTransactions.amountCents} ELSE 0 END), 0)`,
    })
    .from(schema.walletTransactions)
    .where(eq(schema.walletTransactions.walletId, params.walletId));

  await fastify.db
    .update(schema.wallets)
    .set({
      earnedBalanceCents: Number(agg?.earned ?? 0),
      approvedUnpaidBalanceCents: Number(agg?.approved ?? 0),
      paidBalanceCents: Number(agg?.paid ?? 0),
      updatedAt: new Date(),
    })
    .where(eq(schema.wallets.id, params.walletId));
}
