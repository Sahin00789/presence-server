import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { walletSummarySchema, walletTransactionSchema, walletTransactionsQuerySchema } from './schemas.js';
import { getWalletSummary, listWalletTransactions } from './service.js';
import { z } from 'zod';

export async function walletRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/wallet/summary',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Get wallet balance summary for the authenticated staff member',
        tags: ['Wallet'],
        response: {
          200: walletSummarySchema,
        },
      },
    },
    async (request, reply) => {
      const result = await getWalletSummary(
        fastify,
        request.user.userId,
        request.user.organizationId
      );
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/wallet/transactions',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'List wallet transactions for the authenticated staff member',
        tags: ['Wallet'],
        querystring: walletTransactionsQuerySchema,
        response: {
          200: z.array(walletTransactionSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await listWalletTransactions(
        fastify,
        request.user.userId,
        request.user.organizationId,
        request.query as any
      );
      return reply.send(result);
    }
  );
}
