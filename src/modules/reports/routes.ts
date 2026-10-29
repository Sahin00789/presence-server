import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  auditReportQuerySchema,
  dashboardSummarySchema,
  payrollReportQuerySchema,
  reportRangeQuerySchema,
} from './schemas.js';
import {
  buildAttendanceReport,
  buildAuditReport,
  buildPayrollReport,
  getDashboardSummary,
  renderReport,
} from './service.js';

export async function reportRoutes(fastify: FastifyInstance) {
  const server = fastify.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/api/v1/reports/dashboard',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description:
          'Role-aware dashboard summary. Staff receive their own day, month summary and shift; Owners and Managers receive organization KPIs.',
        tags: ['Reports'],
        response: { 200: dashboardSummarySchema },
      },
    },
    async (request, reply) => {
      const result = await getDashboardSummary(
        fastify,
        request.user,
        request.user.organizationId
      );
      return reply.send(result);
    }
  );

  server.get(
    '/api/v1/reports/attendance',
    {
      preHandler: [fastify.authenticate],
      schema: {
        description: 'Attendance report (JSON, CSV or PDF). Staff can only export their own records.',
        tags: ['Reports'],
        querystring: reportRangeQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as {
        from?: string;
        to?: string;
        staffProfileId?: string;
        format: 'json' | 'csv' | 'pdf';
      };
      const table = await buildAttendanceReport(
        fastify,
        request.user,
        request.user.organizationId,
        query
      );
      const rendered = renderReport(table, query.format, 'attendance-report');
      return reply
        .type(rendered.contentType)
        .header('Content-Disposition', `attachment; filename="${rendered.filename}"`)
        .send(rendered.payload);
    }
  );

  server.get(
    '/api/v1/reports/payroll/:periodId',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description: 'Payroll report for one period (JSON, CSV or PDF)',
        tags: ['Reports'],
        params: z.object({ periodId: z.string().uuid() }),
        querystring: payrollReportQuerySchema,
      },
    },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      const { format } = request.query as { format: 'json' | 'csv' | 'pdf' };
      const table = await buildPayrollReport(
        fastify,
        request.user.organizationId,
        periodId
      );
      const rendered = renderReport(table, format, 'payroll-report');
      return reply
        .type(rendered.contentType)
        .header('Content-Disposition', `attachment; filename="${rendered.filename}"`)
        .send(rendered.payload);
    }
  );

  server.get(
    '/api/v1/reports/audit',
    {
      preHandler: [fastify.authenticate, fastify.authorizeRoles('OWNER', 'MANAGER')],
      schema: {
        description:
          'Audit trail report. Owners see all actions, Managers only operational events.',
        tags: ['Reports'],
        querystring: auditReportQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as {
        from?: string;
        to?: string;
        action?: string;
        resourceType?: string;
        format: 'json' | 'csv' | 'pdf';
      };
      const table = await buildAuditReport(
        fastify,
        request.user,
        request.user.organizationId,
        query
      );
      const rendered = renderReport(table, query.format, 'audit-report');
      return reply
        .type(rendered.contentType)
        .header('Content-Disposition', `attachment; filename="${rendered.filename}"`)
        .send(rendered.payload);
    }
  );
}
