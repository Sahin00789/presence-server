import fp from 'fastify-plugin';
import { FastifyRequest, FastifyReply } from 'fastify';

type Role = 'OWNER' | 'MANAGER' | 'STAFF';

declare module 'fastify' {
  interface FastifyInstance {
    authorizeRoles: (...allowedRoles: Role[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (fastify) => {
  fastify.decorate('authorizeRoles', (...allowedRoles: Role[]) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;

      if (!user || !allowedRoles.includes(user.role)) {
        return reply.status(403).send({
          status: 'error',
          statusCode: 403,
          error: 'Forbidden',
          code: 'INSUFFICIENT_PERMISSIONS',
          message: `Access denied. Requires one of roles: ${allowedRoles.join(', ')}`,
          timestamp: new Date().toISOString(),
        });
      }
    };
  });

  fastify.log.info('Authorization plugin registered');
});
