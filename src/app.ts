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
import { employeeRoutes } from './modules/employees/routes.js';
import { premisesRoutes } from './modules/premises/routes.js';
import { shiftRoutes } from './modules/shifts/routes.js';
import { holidayRoutes } from './modules/holidays/routes.js';
import { attendanceRoutes } from './modules/attendance/routes.js';
import { locationRoutes } from './modules/location/routes.js';
import { payrollRoutes } from './modules/payroll/routes.js';
import { overtimeRoutes } from './modules/overtime/routes.js';
import { biometricsRoutes } from './modules/biometrics/routes.js';
import { leaveRoutes } from './modules/leave/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { startLeaveEarningsJob } from './jobs/leaveEarnings.js';
import { startHolidayWeeklyOffEarningsJob } from './jobs/holidayWeeklyOffEarnings.js';
import { startMonthlyReportMailerJob } from './jobs/monthlyReportMailer.js';
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
  app.register(employeeRoutes);
  app.register(premisesRoutes);
  app.register(shiftRoutes);
  app.register(holidayRoutes);
  app.register(attendanceRoutes);
  app.register(locationRoutes);
  app.register(payrollRoutes);
  app.register(overtimeRoutes);
  app.register(biometricsRoutes);
  app.register(leaveRoutes);
  app.register(auditRoutes);
  app.register(reportRoutes);

  // Background attendance finalization, leave earnings, holiday/weekly-off earnings, and monthly report mailer.
  startLeaveEarningsJob(app);
  startHolidayWeeklyOffEarningsJob(app);
  startMonthlyReportMailerJob(app);

  
  

  // Global Root Endpoint
  app.get('/', async () => {
    return {
      name: 'presence-api',
      version: '1.0.0',
      status: 'online',
      docs: '/docs',
    };
  });

  // Global 404 Not Found Handler
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      status: 'error',
      statusCode: 404,
      error: 'Not Found',
      code: 'NOT_FOUND',
      message: `Route ${request.method} ${request.url} not found`,
      path: request.url,
      method: request.method,
      timestamp: new Date().toISOString(),
    });
  });

  // Global Error Handler
  app.setErrorHandler((error: any, request, reply) => {
    // 1. AppError (custom domain / business logic errors)
    if (error instanceof AppError) {
      const log = error.statusCode >= 500 ? app.log.error : app.log.warn;
      log.call(app.log, { err: error, reqId: request.id }, 'Request failed');
      return reply.status(error.statusCode).send({
        status: 'error',
        statusCode: error.statusCode,
        error: error.name || 'AppError',
        code: error.code || 'BAD_REQUEST',
        message: error.message,
        details: error.details,
        path: request.url,
        method: request.method,
        timestamp: new Date().toISOString(),
      });
    }

    // 2. Schema Validation Errors (Zod / Fastify)
    if (error && error.validation) {
      app.log.warn(
        { reqId: request.id, validation: error.validation },
        'Request validation failed'
      );

      let specificMessage = 'Request payload validation failed';
      if (Array.isArray(error.validation) && error.validation.length > 0) {
        const first = error.validation[0];
        const field = first.instancePath ? first.instancePath.replace(/^\//, '') : (first.params?.missingProperty || first.path?.[0]);
        const issue = first.message || first.params?.issue?.message;
        if (field && issue) {
          specificMessage = `${field}: ${issue}`;
        } else if (issue) {
          specificMessage = issue;
        } else if (field) {
          specificMessage = `Invalid field parameter: ${field}`;
        }
      }

      return reply.status(400).send({
        status: 'error',
        statusCode: 400,
        error: 'Bad Request',
        code: 'VALIDATION_ERROR',
        message: specificMessage,
        details: error.validation,
        path: request.url,
        method: request.method,
        timestamp: new Date().toISOString(),
      });
    }

    // 3. PostgreSQL Database Errors (Unique Violation 23505, FK Violation 23503)
    if (error && (error.name === 'PostgresError' || (typeof error.code === 'string' && /^\d{5}$/.test(error.code)))) {
      app.log.error({ err: error, reqId: request.id }, 'Database error');
      const statusCode = error.code === '23505' ? 409 : error.code === '23503' ? 400 : 500;
      const errorCode = error.code === '23505' ? 'DUPLICATE_RECORD' : error.code === '23503' ? 'FOREIGN_KEY_VIOLATION' : 'DATABASE_ERROR';
      let message = 'Database operation failed';
      if (error.code === '23505') {
        message = error.detail ? `A record with this value already exists: ${error.detail}` : 'A record with this unique value already exists.';
      } else if (error.code === '23503') {
        message = error.detail ? `Referenced record does not exist: ${error.detail}` : 'Referenced resource does not exist.';
      } else if (error.message) {
        message = error.message;
      }

      return reply.status(statusCode).send({
        status: 'error',
        statusCode,
        error: 'Database Error',
        code: errorCode,
        message,
        details: process.env.NODE_ENV !== 'production' ? { pgCode: error.code, detail: error.detail, column: error.column } : undefined,
        path: request.url,
        method: request.method,
        timestamp: new Date().toISOString(),
      });
    }

    // 4. HTTP Status Code errors (e.g. from Fastify plugins or http-errors)
    if (error && typeof error.statusCode === 'number') {
      const statusCode = error.statusCode;
      const log = statusCode >= 500 ? app.log.error : app.log.warn;
      log.call(app.log, { err: error, reqId: request.id }, 'HTTP status code error');

      const errorCode = error.code || (
        statusCode === 401 ? 'UNAUTHORIZED' :
        statusCode === 403 ? 'FORBIDDEN' :
        statusCode === 404 ? 'NOT_FOUND' :
        statusCode === 429 ? 'RATE_LIMIT_EXCEEDED' :
        statusCode === 400 ? 'BAD_REQUEST' : 'HTTP_ERROR'
      );

      return reply.status(statusCode).send({
        status: 'error',
        statusCode,
        error: error.name || 'HttpError',
        code: errorCode,
        message: error.message || 'HTTP request failed',
        path: request.url,
        method: request.method,
        timestamp: new Date().toISOString(),
      });
    }

    // 5. Unhandled Internal Server Errors
    app.log.error({ err: error, reqId: request.id }, 'Unhandled request error');
    return reply.status(500).send({
      status: 'error',
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'INTERNAL_SERVER_ERROR',
      message: process.env.NODE_ENV !== 'production' ? (error.message || 'An unexpected internal server error occurred') : 'An unexpected internal server error occurred',
      path: request.url,
      method: request.method,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
