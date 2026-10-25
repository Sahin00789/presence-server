import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import postgresPlugin from './plugins/postgres.js';
import authenticationPlugin from './plugins/authentication.js';
import authorizationPlugin from './plugins/authorization.js';
import eventsPlugin from './plugins/events.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import cachePlugin from './plugins/cache.js';
import { healthRoutes } from './modules/health/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { organizationRoutes } from './modules/organizations/routes.js';
import { invitationRoutes } from './modules/invitations/routes.js';
import { premisesRoutes } from './modules/premises/routes.js';
import { staffRoutes } from './modules/staff/routes.js';
import { shiftRoutes } from './modules/shifts/routes.js';
import { attendanceRoutes } from './modules/attendance/routes.js';
import { walletRoutes } from './modules/wallet/routes.js';
import { locationRoutes } from './modules/location/routes.js';
import { payrollRoutes } from './modules/payroll/routes.js';
import { overtimeRoutes } from './modules/overtime/routes.js';
import { faceRoutes } from './modules/face/routes.js';
import { biometricsRoutes } from './modules/biometrics/routes.js';
import { leaveRoutes } from './modules/leave/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { salaryRoutes } from './modules/salary/routes.js';
import { AppError } from './shared/errors/app-error.js';

export function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          singleLine: true,
          ignore: 'pid,hostname',
        },
      } : undefined,
    },
  });

  // Configure Zod Type Provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register Security & Utility Plugins
  app.register(helmet, { global: true });
  app.register(cors, {
    origin: true,
    credentials: true,
  });
  app.register(cookie);

  // Register Infrastructure Plugins
  app.register(postgresPlugin);
  app.register(cachePlugin);
  app.register(authenticationPlugin);
  app.register(authorizationPlugin);
  app.register(eventsPlugin);
  app.register(rateLimitPlugin);

  // Register Domain Modules
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(organizationRoutes);
  app.register(invitationRoutes);
  app.register(premisesRoutes);
  app.register(staffRoutes);
  app.register(salaryRoutes);
  app.register(shiftRoutes);
  app.register(attendanceRoutes);
  app.register(walletRoutes);
  app.register(locationRoutes);
  app.register(payrollRoutes);
  app.register(overtimeRoutes);
  app.register(faceRoutes);
  app.register(biometricsRoutes);
  app.register(leaveRoutes);
  app.register(auditRoutes);
  app.register(reportRoutes);

  // Global Root Endpoint
  app.get('/', async () => {
    return {
      name: 'presence-api',
      version: '1.0.0',
      status: 'online',
      docs: '/docs',
    };
  });

  // Global Error Handler
  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof AppError) {
      const log = error.statusCode >= 500 ? app.log.error : app.log.warn;
      log.call(app.log, { err: error, reqId: request.id }, 'Request failed');
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.name,
        code: error.code,
        message: error.message,
        details: error.details,
        timestamp: new Date().toISOString(),
      });
    }

    if (error && error.validation) {
      app.log.warn(
        { reqId: request.id, validation: error.validation },
        'Request validation failed'
      );
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        code: 'VALIDATION_ERROR',
        message: 'Request payload validation failed',
        details: error.validation,
        timestamp: new Date().toISOString(),
      });
    }

    app.log.error({ err: error, reqId: request.id }, 'Unhandled request error');
    return reply.status(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal server error occurred',
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
