import { z } from 'zod';

export const walletSummarySchema = z.object({
  staffProfileId: z.string().uuid(),
  earnedBalanceCents: z.number().int().nonnegative(),
  approvedUnpaidBalanceCents: z.number().int().nonnegative(),
  paidBalanceCents: z.number().int().nonnegative(),
  totalBalanceCents: z.number().int().nonnegative(),
});

export const walletTransactionSchema = z.object({
  id: z.string().uuid(),
  walletId: z.string().uuid(),
  type: z.string(),
  amountCents: z.number().int(),
  balanceBucket: z.enum(['EARNED', 'APPROVED_UNPAID', 'PAID']),
  idempotencyKey: z.string(),
  referenceId: z.string().uuid().nullable(),
  description: z.string().nullable(),
  createdAt: z.date().or(z.string()),
});

export const walletTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
