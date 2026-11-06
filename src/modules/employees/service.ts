import { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { generateStaffCode } from '../../shared/services/staff.service.js';
import { sendUserCreationEmail } from '../../shared/services/mail.service.js';
import { uploadToCloudinary } from '../../shared/services/cloudinary.service.js';
import { CreateEmployeeInput, EmployeeDto, UpdateEmployeeInput } from './schemas.js';

export const EMPLOYEE_TTL_HOURS = 48;

function toPaise(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100);
}

export async function createEmployee(
  fastify: FastifyInstance,
  organizationId: string,
  actorUserId: string,
  actorRole: 'OWNER' | 'EMPLOYEE',
  input: CreateEmployeeInput
): Promise<EmployeeDto> {
  if (actorRole !== 'OWNER') {
    throw new AppError(
      'Only Organization Owners can add Employees.',
      403,
      'EMPLOYEE_ROLE_NOT_PERMITTED'
    );
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

  // Premises Validation & Assignment
  let assignedPremisesId: string | null = input.premisesId || null;
  if (assignedPremisesId) {
    const [validPremises] = await fastify.db
      .select({ id: schema.premises.id })
      .from(schema.premises)
      .where(
        and(
          eq(schema.premises.id, assignedPremisesId),
          eq(schema.premises.organizationId, organizationId)
        )
      )
      .limit(1);

    if (!validPremises) {
      throw new AppError(
        'The specified premises was not found in this organization.',
        400,
        'PREMISES_NOT_FOUND'
      );
    }
  } else {
    // If premisesId is not supplied, assign default premises if one exists for organization
    const [defaultPremises] = await fastify.db
      .select({ id: schema.premises.id })
      .from(schema.premises)
      .where(eq(schema.premises.organizationId, organizationId))
      .limit(1);

    if (defaultPremises) {
      assignedPremisesId = defaultPremises.id;
    }
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

  let uploadedAvatarUrl: string | null = null;
  if (input.avatarBase64) {
    try {
      uploadedAvatarUrl = await uploadToCloudinary(input.avatarBase64, 'employee-avatars');
    } catch (err) {
      fastify.log.warn({ err }, 'Failed to upload employee avatar to Cloudinary');
      uploadedAvatarUrl = input.avatarBase64;
    }
  } else if (input.avatarUrl) {
    uploadedAvatarUrl = input.avatarUrl;
  }

  const profile = await fastify.db.transaction(async (tx) => {
    let [userRecord] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    const userPayload: Record<string, any> = {
      email,
      fullName,
      isActive: true,
      updatedAt: now,
    };
    if (input.phone) userPayload.phone = input.phone;
    if (uploadedAvatarUrl) userPayload.avatarUrl = uploadedAvatarUrl;

    if (!userRecord) {
      [userRecord] = await tx
        .insert(schema.users)
        .values({
          email,
          fullName,
          isActive: true,
          phone: input.phone || null,
          avatarUrl: uploadedAvatarUrl || null,
        })
        .returning();
    } else {
      [userRecord] = await tx
        .update(schema.users)
        .set(userPayload)
        .where(eq(schema.users.id, userRecord.id))
        .returning();
    }

    const [employee] = await tx
      .insert(schema.employees)
      .values({
        organizationId,
        userId: userRecord.id,
        premisesId: assignedPremisesId,
        role: 'EMPLOYEE',
        employeeCode,
        name: fullName,
        department: input.department || null,
        designation: input.designation || null,
        address: input.address || null,
        hireDate: now.toISOString().slice(0, 10),
      })
      .returning();

    return { employee, userRecord };
  });

  const [org] = await fastify.db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  const orgName = org?.name || 'Organization';

  setImmediate(() => {
    sendUserCreationEmail({
      to: email,
      role: 'EMPLOYEE',
      organizationName: orgName,
      logger: fastify.log,
    }).catch((mailErr) => {
      fastify.log.warn({ err: mailErr, email }, 'Failed to send employee onboarding email');
    });
  });

  const [premisesRecord] = profile.employee.premisesId
    ? await fastify.db
        .select({ name: schema.premises.name })
        .from(schema.premises)
        .where(eq(schema.premises.id, profile.employee.premisesId))
        .limit(1)
    : [null];

  return {
    id: profile.employee.id,
    organizationId,
    organizationName: orgName,
    userId: profile.employee.userId!,
    email,
    fullName: profile.employee.name,
    staffCode: profile.employee.employeeCode,
    department: profile.employee.department,
    designation: profile.employee.designation,
    phone: profile.userRecord.phone ?? input.phone ?? null,
    address: profile.employee.address ?? input.address ?? null,
    avatarUrl: profile.userRecord.avatarUrl ?? uploadedAvatarUrl ?? null,
    role: 'EMPLOYEE',
    token: null,
    addedBy: actorUserId,
    metadata: null,
    expiresAt: expiresAt.toISOString(),
    acceptedAt: now.toISOString(),
    createdAt: now.toISOString(),
    premisesId: profile.employee.premisesId,
    premisesName: premisesRecord?.name ?? null,
    hireDate: String(profile.employee.hireDate),
    isActive: profile.employee.isActive,
    earnedBalancePaise: 0,
    approvedUnpaidBalancePaise: 0,
    paidBalancePaise: 0,
  };
}

export async function listEmployees(
  fastify: FastifyInstance,
  organizationId: string,
  options?: { premisesId?: string; search?: string }
): Promise<EmployeeDto[]> {
  const [org] = await fastify.db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  const orgName = org?.name || 'Organization';

  const conditions = [eq(schema.employees.organizationId, organizationId)];

  if (options?.premisesId) {
    conditions.push(eq(schema.employees.premisesId, options.premisesId));
  }

  if (options?.search && options.search.trim().length > 0) {
    const term = `%${options.search.trim()}%`;
    conditions.push(
      or(
        ilike(schema.employees.name, term),
        ilike(schema.users.email, term),
        ilike(schema.employees.employeeCode, term)
      )!
    );
  }

  const rows = await fastify.db
    .select({
      id: schema.employees.id,
      userId: schema.employees.userId,
      role: schema.employees.role,
      name: schema.employees.name,
      email: schema.users.email,
      phone: schema.users.phone,
      avatarUrl: schema.users.avatarUrl,
      address: schema.employees.address,
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
    .where(and(...conditions))
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
    earnedRows.map((row) => [row.employeeId, toPaise(row.earned)])
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
      { paid: toPaise(row.paid), due: toPaise(row.due) },
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
      phone: row.phone ?? null,
      address: row.address ?? null,
      avatarUrl: row.avatarUrl ?? null,
      role: 'EMPLOYEE' as const,
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
      earnedBalancePaise: earned,
      approvedUnpaidBalancePaise: payroll.due,
      paidBalancePaise: payroll.paid,
    };
  });
}

export async function getEmployeeById(
  fastify: FastifyInstance,
  organizationId: string,
  employeeId: string,
  actorUserId: string,
  actorRole: 'OWNER' | 'EMPLOYEE'
): Promise<EmployeeDto> {
  const list = await listEmployees(fastify, organizationId);
  const emp = list.find((e) => e.id === employeeId);
  if (!emp) {
    throw new AppError('Employee record not found', 404, 'EMPLOYEE_NOT_FOUND');
  }
  return emp;
}

export async function getSelfEmployeeProfile(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string
): Promise<EmployeeDto> {
  const list = await listEmployees(fastify, organizationId);
  const emp = list.find((e) => e.userId === userId);
  if (!emp) {
    throw new AppError(
      'Employee profile not found for this user account.',
      404,
      'EMPLOYEE_NOT_FOUND'
    );
  }
  return emp;
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
      .set({
        isActive: false,
        terminationDate: new Date().toISOString().slice(0, 10),
        updatedAt: new Date(),
      })
      .where(eq(schema.employees.id, employeeId));

    await tx
      .delete(schema.multiPoseFaceTemplates)
      .where(eq(schema.multiPoseFaceTemplates.employeeId, employeeId));
  });

  return { revoked: true };
}

export async function updateEmployee(
  fastify: FastifyInstance,
  organizationId: string,
  employeeId: string,
  actorUserId: string,
  actorRole: 'OWNER' | 'EMPLOYEE',
  input: UpdateEmployeeInput
): Promise<EmployeeDto> {
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

  if (actorRole === 'EMPLOYEE' && employee.userId !== actorUserId) {
    throw new AppError(
      'Employees can only update their own profile.',
      403,
      'FORBIDDEN'
    );
  }

  if (input.premisesId) {
    const [validPremises] = await fastify.db
      .select({ id: schema.premises.id })
      .from(schema.premises)
      .where(
        and(
          eq(schema.premises.id, input.premisesId),
          eq(schema.premises.organizationId, organizationId)
        )
      )
      .limit(1);

    if (!validPremises) {
      throw new AppError(
        'The specified premises was not found in this organization.',
        400,
        'PREMISES_NOT_FOUND'
      );
    }
  }

  let uploadedAvatarUrl: string | undefined = input.avatarUrl ?? undefined;
  if (input.avatarBase64) {
    try {
      uploadedAvatarUrl = await uploadToCloudinary(input.avatarBase64, 'employee-avatars');
    } catch (err) {
      fastify.log.warn({ err }, 'Failed to upload employee avatar to Cloudinary');
      uploadedAvatarUrl = input.avatarBase64;
    }
  }

  await fastify.db.transaction(async (tx) => {
    const empUpdates: Record<string, any> = { updatedAt: new Date() };

    if (input.fullName !== undefined && actorRole === 'OWNER') {
      empUpdates.name = input.fullName;
    }
    if (input.department !== undefined && actorRole === 'OWNER') {
      empUpdates.department = input.department;
    }
    if (input.designation !== undefined && actorRole === 'OWNER') {
      empUpdates.designation = input.designation;
    }
    if (input.premisesId !== undefined && actorRole === 'OWNER') {
      empUpdates.premisesId = input.premisesId;
    }
    if (input.address !== undefined) {
      empUpdates.address = input.address;
    }

    await tx
      .update(schema.employees)
      .set(empUpdates)
      .where(eq(schema.employees.id, employeeId));

    if (employee.userId) {
      const userUpdates: Record<string, any> = { updatedAt: new Date() };
      if (input.fullName !== undefined) userUpdates.fullName = input.fullName;
      if (input.phone !== undefined) userUpdates.phone = input.phone;
      if (uploadedAvatarUrl !== undefined) userUpdates.avatarUrl = uploadedAvatarUrl;

      await tx
        .update(schema.users)
        .set(userUpdates)
        .where(eq(schema.users.id, employee.userId));
    }
  });

  const list = await listEmployees(fastify, organizationId);
  const updated = list.find((e) => e.id === employeeId);
  if (!updated) {
    throw new AppError('Updated employee record not found', 500, 'INTERNAL_SERVER_ERROR');
  }
  return updated;
}
