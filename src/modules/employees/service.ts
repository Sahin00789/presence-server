import { randomBytes } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { writeAuditLog } from '../../shared/services/audit.service.js';
import { generateStaffCode } from '../../shared/services/staff.service.js';
import { sendUserCreationEmail } from '../../shared/services/mail.service.js';
import { CreateEmployeeInput, EmployeeDto } from './schemas.js';

export const EMPLOYEE_TTL_HOURS = 48;

function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100);
}

export async function createEmployee(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  actorRole: 'OWNER' | 'MANAGER' | 'STAFF',
  input: CreateEmployeeInput
): Promise<EmployeeDto> {
  if (actorRole === 'OWNER' && input.role !== 'MANAGER' && input.role !== 'STAFF') {
    throw new AppError(
      'Owners can add Managers and Staff members.',
      403,
      'EMPLOYEE_ROLE_NOT_PERMITTED'
    );
  }

  if (actorRole === 'MANAGER' && input.role !== 'STAFF') {
    throw new AppError(
      'Managers can only add Staff members.',
      403,
      'EMPLOYEE_ROLE_NOT_PERMITTED'
    );
  }

  if (actorRole === 'STAFF') {
    throw new AppError('Staff members cannot add team members', 403, 'EMPLOYEE_FORBIDDEN');
  }

  const email = input.email.toLowerCase().trim();
  const fullName = input.fullName?.trim() || email.split('@')[0];
  const now = new Date();

  const [orgRecord] = await fastify.db
    .select({ ownerUserId: schema.organizations.ownerUserId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  if (orgRecord?.ownerUserId) {
    const [ownerUser] = await fastify.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, orgRecord.ownerUserId))
      .limit(1);

    if (ownerUser && ownerUser.email.toLowerCase() === email) {
      throw new AppError(
        'The organization owner is not an employee and cannot be added as one.',
        400,
        'OWNER_CANNOT_BE_EMPLOYEE'
      );
    }
  }

  let assignedPremisesId = input.premisesId || null;
  if (actorRole === 'MANAGER') {
    const [managerProfile] = await fastify.db
      .select({ premisesId: schema.employees.premisesId })
      .from(schema.employees)
      .where(
        and(
          eq(schema.employees.userId, actorUserId),
          eq(schema.employees.organizationId, organizationId),
          eq(schema.employees.isActive, true)
        )
      )
      .limit(1);
    if (!managerProfile?.premisesId) {
      throw new AppError('Manager must be assigned to a premises to add staff', 400, 'MANAGER_PREMISES_REQUIRED');
    }
    assignedPremisesId = managerProfile.premisesId;
  } else if (input.role === 'MANAGER' && !assignedPremisesId) {
    throw new AppError('A manager must be assigned to a premises', 400, 'PREMISES_REQUIRED_FOR_MANAGER');
  }

  const [existingEmployee] = await fastify.db
    .select({ id: schema.employees.id })
    .from(schema.employees)
    .innerJoin(schema.users, eq(schema.employees.userId, schema.users.id))
    .where(
      and(
        eq(schema.employees.organizationId, organizationId),
        eq(schema.users.email, email)
      )
    )
    .limit(1);

  if (existingEmployee) {
    throw new AppError(
      'This person is already an employee of the organization',
      409,
      'ALREADY_AN_EMPLOYEE'
    );
  }

  let employeeCode = input.staffCode;
  if (!employeeCode) {
    employeeCode = await generateStaffCode(fastify, organizationId);
  }

  const expiresAt = new Date(Date.now() + EMPLOYEE_TTL_HOURS * 60 * 60 * 1000);

  const profile = await fastify.db.transaction(async (tx) => {
    let [userRecord] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (!userRecord) {
      [userRecord] = await tx
        .insert(schema.users)
        .values({ email, fullName, isActive: true })
        .returning();
    } else if (!userRecord.isActive) {
      await tx
        .update(schema.users)
        .set({ isActive: true, fullName, updatedAt: now })
        .where(eq(schema.users.id, userRecord.id));
    }

    const [employee] = await tx
      .insert(schema.employees)
      .values({
        organizationId,
        userId: userRecord.id,
        premisesId: assignedPremisesId,
        role: input.role,
        employeeCode,
        name: fullName,
        department: input.department || null,
        designation: input.designation || null,
        hireDate: now.toISOString().slice(0, 10),
      })
      .returning();

    return employee;
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'EMPLOYEE_CREATED',
    resourceType: 'employee',
    resourceId: profile.id,
    metadata: { email, role: input.role },
  });

  const [org] = await fastify.db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  const orgName = org?.name || 'Organization';

  try {
    await sendUserCreationEmail({
      to: email,
      role: input.role,
      organizationName: orgName,
      logger: fastify.log,
    });
  } catch (mailErr) {
    fastify.log.warn({ err: mailErr, email }, 'Failed to send employee onboarding email');
  }

  const [premisesRecord] = profile.premisesId ? await fastify.db
    .select({ name: schema.premises.name })
    .from(schema.premises)
    .where(eq(schema.premises.id, profile.premisesId))
    .limit(1) : [null];

  return {
    id: profile.id,
    organizationId,
    organizationName: orgName,
    userId: profile.userId!,
    email,
    fullName: profile.name,
    staffCode: profile.employeeCode,
    department: profile.department,
    designation: profile.designation,
    role: input.role,
    token: null,
    addedBy: actorUserId,
    metadata: null,
    expiresAt: expiresAt.toISOString(),
    acceptedAt: now.toISOString(),
    createdAt: now.toISOString(),
    premisesId: profile.premisesId,
    premisesName: premisesRecord?.name ?? null,
    hireDate: String(profile.hireDate),
    isActive: profile.isActive,
    earnedBalanceCents: 0,
    approvedUnpaidBalanceCents: 0,
    paidBalanceCents: 0,
  };
}

export async function listEmployees(
  fastify: FastifyInstance,
  organizationId: string
): Promise<EmployeeDto[]> {
  const [org] = await fastify.db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  const orgName = org?.name || 'Organization';

  const rows = await fastify.db
    .select({
      id: schema.employees.id,
      userId: schema.employees.userId,
      role: schema.employees.role,
      name: schema.employees.name,
      email: schema.users.email,
      createdAt: schema.employees.createdAt,
      department: schema.employees.department,
      designation: schema.employees.designation,
      employeeCode: schema.employees.employeeCode,
      premisesId: schema.employees.premisesId,
      premisesName: schema.premises.name,
      hireDate: schema.employees.hireDate,
      isActive: schema.employees.isActive,
    })
    .from(schema.employees)
    .innerJoin(schema.users, eq(schema.employees.userId, schema.users.id))
    .leftJoin(schema.premises, eq(schema.premises.id, schema.employees.premisesId))
    .where(eq(schema.employees.organizationId, organizationId))
    .orderBy(desc(schema.employees.createdAt));

  if (rows.length === 0) {
    return [];
  }

  const employeeIds = rows.map((row) => row.id);

  // Earned accruals from ledger
  const earnedRows = await fastify.db
    .select({
      employeeId: (schema as any).employeeEarningLedger.employeeId,
      earned: sql<string>`COALESCE(SUM(${(schema as any).employeeEarningLedger.amount}), 0)`,
    })
    .from((schema as any).employeeEarningLedger)
    .where(
      and(
        eq((schema as any).employeeEarningLedger.organizationId, organizationId),
        inArray((schema as any).employeeEarningLedger.employeeId, employeeIds)
      )
    )
    .groupBy((schema as any).employeeEarningLedger.employeeId);

  const earnedByEmployee = new Map(
    earnedRows.map((row) => [row.employeeId, toCents(row.earned)])
  );

  // Paid and due from payroll
  const payrollRows = await fastify.db
    .select({
      employeeId: schema.monthlyPayrolls.employeeId,
      paid: sql<string>`COALESCE(SUM(${schema.monthlyPayrolls.paidAmount}), 0)`,
      due: sql<string>`COALESCE(SUM(${schema.monthlyPayrolls.dueAmount}), 0)`,
    })
    .from(schema.monthlyPayrolls)
    .where(
      and(
        eq(schema.monthlyPayrolls.organizationId, organizationId),
        inArray(schema.monthlyPayrolls.employeeId, employeeIds)
      )
    )
    .groupBy(schema.monthlyPayrolls.employeeId);

  const payrollByEmployee = new Map(
    payrollRows.map((row) => [
      row.employeeId,
      { paid: toCents(row.paid), due: toCents(row.due) },
    ])
  );

  return rows.map((row) => {
    const payroll = payrollByEmployee.get(row.id) ?? { paid: 0, due: 0 };
    const earned = earnedByEmployee.get(row.id) ?? 0;

    return {
      id: row.id,
      organizationId,
      organizationName: orgName,
      userId: row.userId ?? '',
      email: row.email,
      fullName: row.name,
      staffCode: row.employeeCode,
      department: row.department,
      designation: row.designation,
      role: row.role,
      token: null,
      addedBy: null,
      metadata: null,
      expiresAt: null,
      acceptedAt: null,
      createdAt: new Date(row.createdAt).toISOString(),
      premisesId: row.premisesId,
      premisesName: row.premisesName ?? null,
      hireDate: String(row.hireDate),
      isActive: row.isActive,
      earnedBalanceCents: earned,
      approvedUnpaidBalanceCents: payroll.due,
      paidBalanceCents: payroll.paid,
    };
  });
}


export async function revokeEmployee(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  employeeId: string
): Promise<{ revoked: boolean }> {
  const [employee] = await fastify.db
    .select()
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.id, employeeId),
        eq(schema.employees.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!employee) {
    throw new AppError('Employee record not found', 404, 'EMPLOYEE_NOT_FOUND');
  }

  await fastify.db.transaction(async (tx) => {
    await tx
      .update(schema.employees)
      .set({ isActive: false, terminationDate: new Date().toISOString().slice(0, 10), updatedAt: new Date() })
      .where(eq(schema.employees.id, employeeId));

    await tx
      .delete(schema.multiPoseFaceTemplates)
      .where(eq(schema.multiPoseFaceTemplates.employeeId, employeeId));
  });

  await writeAuditLog(fastify, {
    organizationId,
    actorId: actorUserId,
    action: 'EMPLOYEE_REVOKED',
    resourceType: 'employee',
    resourceId: employeeId,
  });

  return { revoked: true };
}


