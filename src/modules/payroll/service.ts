import { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { AppError } from '../../shared/errors/app-error.js';
import { findStaffProfile, listOrganizationStaff } from '../../shared/services/staff.service.js';
import { dayOfWeek, enumerateDates, toDateISO } from '../../shared/utils/datetime.js';
import { buildPdfReport, PdfTable } from '../../shared/utils/pdf.js';

function getMonthDateRange(year: number, month: number) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonthStartDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  return { startDate, nextMonthStartDate };
}

function toYmd(val: any): string {
  if (!val) return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  return s;
}

/**
 * 1. Get monthly attendance statistics dynamically (calculated on-the-fly).
 */
export async function getMonthlyAttendanceStats(
  fastify: FastifyInstance,
  organizationId: string,
  month: number,
  year: number,
  premisesId?: string,
  staffProfileId?: string
) {
  const { startDate, nextMonthStartDate } = getMonthDateRange(year, month);
  const staffList = await listOrganizationStaff(fastify, organizationId);
  const filteredStaff = staffList.filter(
    (s) => (!premisesId || s.premisesId === premisesId) && (!staffProfileId || s.id === staffProfileId)
  );

  const stats = [];
  for (const staff of filteredStaff) {
    const premId = staff.premisesId;
    if (!premId) continue;

    const attendanceEvents = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.employeeId, staff.id),
          gte(schema.employeeAttendance.workDate, startDate),
          sql`${schema.employeeAttendance.workDate} < ${nextMonthStartDate}`
        )
      );

    let present = 0;
    let absent = 0;
    let halfDay = 0;
    let leave = 0;

    for (const ev of attendanceEvents) {
      if (ev.status === 'PRESENT') present++;
      else if (ev.status === 'HALF_DAY') halfDay++;
      else if (ev.status === 'ABSENT') absent++;
      else if (ev.status === 'LEAVE') leave++;
    }

    const holidays = await fastify.db
      .select()
      .from(schema.holidayCalendars)
      .where(
        and(
          eq(schema.holidayCalendars.organizationId, organizationId),
          staff.premisesId ? eq(schema.holidayCalendars.premisesId, staff.premisesId) : sql`true`,
          gte(schema.holidayCalendars.date, startDate),
          sql`${schema.holidayCalendars.date} < ${nextMonthStartDate}`
        )
      );
    const holidayCount = holidays.length;

    const weeklyOffs = await fastify.db
      .select()
      .from(schema.weeklyOffs)
      .where(eq(schema.weeklyOffs.employeeId, staff.id));

    let offDayCount = 0;
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const dayOfWeek = new Date(year, month - 1, d).getDay();
      if (weeklyOffs.some((wo) => wo.dayOfWeek === dayOfWeek)) {
        offDayCount++;
      }
    }

    const overtimeRecords = await fastify.db
      .select()
      .from(schema.overtime)
      .where(
        and(
          eq(schema.overtime.organizationId, organizationId),
          eq(schema.overtime.employeeId, staff.id),
          gte(schema.overtime.workDate, startDate),
          sql`${schema.overtime.workDate} < ${nextMonthStartDate}`,
          inArray(schema.overtime.status, ['CREATED', 'IN_PROGRESS', 'COMPLETED'])
        )
      );
    const overtimeCount = overtimeRecords.length;

    stats.push({
      organizationId,
      premisesId: premId,
      employeeId: staff.id,
      month,
      year,
      presentShiftsCount: present,
      absentShiftsCount: absent,
      leaveShiftsCount: leave,
      halfDayShiftsCount: halfDay,
      holidayCount,
      offDayCount,
      overtimeCount,
    });
  }
  return stats;
}

/**
 * Generates individual earning ledger entries idempotently.
 */
export async function generateDailyEarningLedgerEntries(
  fastify: FastifyInstance,
  organizationId: string,
  premisesId: string,
  staffProfileId: string,
  month: number,
  year: number
) {
  const { startDate, nextMonthStartDate } = getMonthDateRange(year, month);
  const lastDayOfMonth = enumerateDates(startDate, nextMonthStartDate).slice(0, -1).at(-1) ?? startDate;

  const [staff] = await fastify.db
    .select()
    .from(schema.employees)
    .where(
      and(
        eq(schema.employees.id, staffProfileId),
        eq(schema.employees.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!staff) return;

  const [activeAssignment] = await fastify.db
    .select({ createdAt: schema.employeeShiftAssignments.createdAt })
    .from(schema.employeeShiftAssignments)
    .where(
      and(
        eq(schema.employeeShiftAssignments.employeeId, staffProfileId),
        eq(schema.employeeShiftAssignments.organizationId, organizationId),
        eq(schema.employeeShiftAssignments.isActive, true)
      )
    )
    .orderBy(asc(schema.employeeShiftAssignments.createdAt))
    .limit(1);

  if (!activeAssignment) return;

  const assignmentStartDate = toDateISO(activeAssignment.createdAt);
  const currentDate = toDateISO(new Date());

  try {
    const salary = await getCurrentSalaryStructure(
      fastify,
      staffProfileId,
      startDate,
      organizationId
    ).catch(() => null);
    const dailyPresentCents = salary?.presentCents ?? 0;
    const fallbackDailyCents = Number(dailyPresentCents) > 0 ? Number(dailyPresentCents) : 0;

    // Purge any unworked holiday or weekly off-day earnings strictly in the future (after currentDate)
    const earningLedger = schema.employeeEarningLedger;
    await fastify.db
      .delete(earningLedger)
      .where(
        and(
          eq(earningLedger.employeeId, staffProfileId),
          eq(earningLedger.organizationId, organizationId),
          gte(earningLedger.earningDate, startDate),
          sql`${earningLedger.earningDate} < ${nextMonthStartDate}`,
          inArray(earningLedger.type, ['HOLIDAY', 'OFF_DAY']),
          sql`${earningLedger.earningDate} > ${currentDate}`
        )
      );

    // 1. Attendance events -> SHIFT earnings. Clock-out already writes the
    // authoritative SHIFT row; this pass backfills approved leave and repairs
    // older rows without double-inserting.
    const attendanceEvents = await fastify.db
      .select()
      .from(schema.employeeAttendance)
      .where(
        and(
          eq(schema.employeeAttendance.organizationId, organizationId),
          eq(schema.employeeAttendance.employeeId, staffProfileId),
          gte(schema.employeeAttendance.workDate, startDate),
          sql`${schema.employeeAttendance.workDate} < ${nextMonthStartDate}`
        )
      );

    const assignmentIds = Array.from(
      new Set(
        attendanceEvents
          .map((event) => event.shiftAssignmentId)
          .filter((id): id is string => Boolean(id))
      )
    );
    const assignmentRows = assignmentIds.length
      ? await fastify.db
          .select({
            id: schema.employeeShiftAssignments.id,
            presentPay: schema.employeeShiftAssignments.presentPay,
            halfDayPay: schema.employeeShiftAssignments.halfDayPay,
            leavePay: schema.employeeShiftAssignments.leavePay,
          })
          .from(schema.employeeShiftAssignments)
          .where(inArray(schema.employeeShiftAssignments.id, assignmentIds))
      : [];
    const assignmentById = new Map(assignmentRows.map((row) => [row.id, row]));
    const cents = (value: string | number | null | undefined) =>
      Math.round(Number(value ?? 0) * 100);

    // Load every ledger row already booked for this employee in the month
    // once, instead of issuing a SELECT per candidate day/weekly-off/holiday.
    const existingLedgerRows = await fastify.db
      .select({
        sourceReference: earningLedger.sourceReference,
        attendanceId: earningLedger.attendanceId,
        overtimeId: earningLedger.overtimeId,
        type: earningLedger.type,
      })
      .from(earningLedger)
      .where(
        and(
          eq(earningLedger.employeeId, staffProfileId),
          gte(earningLedger.earningDate, startDate),
          sql`${earningLedger.earningDate} < ${nextMonthStartDate}`
        )
      );

    const seenSourceReferences = new Set<string>();
    const seenAttendanceEntries = new Set<string>();
    const seenOvertimeEntries = new Set<string>();
    for (const row of existingLedgerRows) {
      if (row.sourceReference) seenSourceReferences.add(row.sourceReference);
      if (row.attendanceId) seenAttendanceEntries.add(`${row.attendanceId}:${row.type}`);
      if (row.overtimeId) seenOvertimeEntries.add(row.overtimeId);
    }

    type PendingEarning = {
      earningDate: string;
      type: 'SHIFT' | 'HOLIDAY' | 'OFF_DAY' | 'OVERTIME';
      amount: string;
      shiftAssignmentId: string | null;
      attendanceId: string | null;
      overtimeId: string | null;
      sourceReference: string;
    };
    const pendingEarnings: PendingEarning[] = [];

    const queueEarning = (values: {
      earningDate: string;
      type: 'SHIFT' | 'HOLIDAY' | 'OFF_DAY' | 'OVERTIME';
      amountCents: number;
      shiftAssignmentId?: string | null;
      attendanceId?: string | null;
      overtimeId?: string | null;
      sourceReference: string;
    }) => {
      if (values.earningDate > currentDate) return;
      const attendanceKey = values.attendanceId ? `${values.attendanceId}:${values.type}` : null;
      if (values.overtimeId && seenOvertimeEntries.has(values.overtimeId)) return;
      if (seenSourceReferences.has(values.sourceReference)) return;
      if (attendanceKey && seenAttendanceEntries.has(attendanceKey)) return;

      seenSourceReferences.add(values.sourceReference);
      if (attendanceKey) seenAttendanceEntries.add(attendanceKey);
      if (values.overtimeId) seenOvertimeEntries.add(values.overtimeId);

      pendingEarnings.push({
        earningDate: values.earningDate,
        type: values.type,
        amount: (Math.max(0, values.amountCents) / 100).toFixed(2),
        shiftAssignmentId: values.shiftAssignmentId ?? null,
        attendanceId: values.attendanceId ?? null,
        overtimeId: values.overtimeId ?? null,
        sourceReference: values.sourceReference,
      });
    };

    const workedDates = new Set<string>();
    for (const ev of attendanceEvents) {
      const workDate = toYmd(ev.workDate);
      if (ev.status === 'PRESENT' || ev.status === 'HALF_DAY') {
        workedDates.add(workDate);
      }

      if (
        ev.status !== 'PRESENT' &&
        ev.status !== 'HALF_DAY'
      ) {
        continue;
      }

      const assignment = ev.shiftAssignmentId
        ? assignmentById.get(ev.shiftAssignmentId)
        : undefined;
      const amountCents =
        ev.status === 'HALF_DAY'
          ? cents(assignment?.halfDayPay) || Math.round((cents(assignment?.presentPay) || dailyPresentCents) / 2)
          : cents(assignment?.presentPay) || dailyPresentCents || fallbackDailyCents;

      queueEarning({
        earningDate: workDate,
        type: 'SHIFT',
        amountCents,
        shiftAssignmentId: ev.shiftAssignmentId,
        attendanceId: ev.id,
        sourceReference: `attendance:${ev.id}:SHIFT`,
      });
    }

    // Resolve unworked rules once. Specific employee + premises rows win over
    // organisation-wide defaults; the latest effective row wins within a tier.
    const unworkedRules = await fastify.db
      .select()
      .from(schema.unworkedPaymentRules)
      .where(
        and(
          eq(schema.unworkedPaymentRules.organizationId, organizationId),
          sql`(${schema.unworkedPaymentRules.employeeId} = ${staffProfileId} OR ${schema.unworkedPaymentRules.employeeId} IS NULL)`,
          sql`(${schema.unworkedPaymentRules.premisesId} = ${premisesId} OR ${schema.unworkedPaymentRules.premisesId} IS NULL)`
        )
      );

    const resolveUnworkedCents = (
      dayType: 'HOLIDAY' | 'WEEKLY_OFF' | 'PAID_LEAVE',
      date: string,
      fallbackCents: number
    ) => {
      const candidates = unworkedRules
        .filter((rule) => rule.dayType === dayType)
        .sort((a, b) => {
          const specificityA =
            (a.employeeId === staffProfileId ? 4 : 0) +
            (a.premisesId === premisesId ? 2 : 0);
          const specificityB =
            (b.employeeId === staffProfileId ? 4 : 0) +
            (b.premisesId === premisesId ? 2 : 0);
          if (specificityA !== specificityB) return specificityB - specificityA;
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
      const rule = candidates[0];
      if (!rule) return fallbackCents;
      if (rule.paymentInr !== null && rule.paymentInr !== undefined) {
        return Math.round(Number(rule.paymentInr) * 100);
      }
      if (rule.multiplierBasisPoints > 0) {
        return Math.round((fallbackCents * rule.multiplierBasisPoints) / 10000);
      }
      return fallbackCents;
    };

    // 2. Paid holidays. A worked holiday is already paid as a normal SHIFT day.
    const holidays = await fastify.db
      .select()
      .from(schema.holidayCalendars)
      .where(
        and(
          eq(schema.holidayCalendars.organizationId, organizationId),
          staff.premisesId ? eq(schema.holidayCalendars.premisesId, staff.premisesId) : sql`true`,
          gte(schema.holidayCalendars.date, startDate),
          sql`${schema.holidayCalendars.date} < ${nextMonthStartDate}`
        )
      );

    const holidayDates = new Set<string>();
    for (const holiday of holidays) {
      const holidayDate = toYmd(holiday.date);
      holidayDates.add(holidayDate);
      if (!holiday.isPaid || workedDates.has(holidayDate)) continue;

      queueEarning({
        earningDate: holidayDate,
        type: 'HOLIDAY',
        amountCents: resolveUnworkedCents(
          'HOLIDAY',
          holidayDate,
          dailyPresentCents || fallbackDailyCents
        ),
        sourceReference: `holiday:${holiday.id}:${staffProfileId}:${holidayDate}:HOLIDAY`,
      });
    }

    // 3. Weekly off days -> OFF_DAY, unless the employee actually worked.
    const weeklyOffRows = await fastify.db
      .select({ dayOfWeek: schema.weeklyOffs.dayOfWeek })
      .from(schema.weeklyOffs)
      .where(eq(schema.weeklyOffs.employeeId, staffProfileId));
    const weeklyOffDays = new Set(weeklyOffRows.map((row) => row.dayOfWeek));

    for (const date of enumerateDates(startDate, lastDayOfMonth)) {
      if (
        date < assignmentStartDate ||
        date > currentDate ||
        !weeklyOffDays.has(dayOfWeek(date)) ||
        holidayDates.has(date) ||
        workedDates.has(date)
      ) {
        continue;
      }

      queueEarning({
        earningDate: date,
        type: 'OFF_DAY',
        amountCents: resolveUnworkedCents(
          'WEEKLY_OFF',
          date,
          dailyPresentCents || fallbackDailyCents
        ),
        sourceReference: `weekly-off:${staffProfileId}:${date}:OFF_DAY`,
      });
    }

    // 4. Approved paid leave is represented by an attendance row with LEAVE.
    // Only create it when the day was not already paid as worked/holiday/off.
    for (const ev of attendanceEvents) {
      if (ev.status !== 'LEAVE') continue;
      const workDate = toYmd(ev.workDate);
      if (workedDates.has(workDate) || holidayDates.has(workDate)) continue;
      if (weeklyOffDays.has(dayOfWeek(workDate))) continue;

      const assignment = ev.shiftAssignmentId
        ? assignmentById.get(ev.shiftAssignmentId)
        : undefined;
      queueEarning({
        earningDate: workDate,
        type: 'SHIFT',
        amountCents: resolveUnworkedCents(
          'PAID_LEAVE',
          workDate,
          cents(assignment?.leavePay) || dailyPresentCents || fallbackDailyCents
        ),
        shiftAssignmentId: ev.shiftAssignmentId,
        attendanceId: ev.id,
        sourceReference: `leave:${ev.id}:SHIFT`,
      });
    }

    // 5. Overtime -> OVERTIME earnings.
    const overtimeRecords = await fastify.db
      .select()
      .from(schema.overtime)
      .where(
        and(
          eq(schema.overtime.organizationId, organizationId),
          eq(schema.overtime.employeeId, staffProfileId),
          gte(schema.overtime.workDate, startDate),
          sql`${schema.overtime.workDate} < ${nextMonthStartDate}`,
          inArray(schema.overtime.status, ['CREATED', 'IN_PROGRESS', 'COMPLETED'])
        )
      );

    for (const ot of overtimeRecords) {
      const otAmountCents = Number((ot as any).paymentCents ?? (ot as any).paymentInr ?? 0);
      queueEarning({
        earningDate: toYmd(ot.workDate),
        type: 'OVERTIME',
        amountCents: otAmountCents,
        overtimeId: ot.id,
        sourceReference: `overtime:${ot.id}:OVERTIME`,
      });
    }

    // Single batched insert keeps the ledger idempotent without one round trip
    // per entry (a month of weekly offs alone was ~30 SELECT + 30 INSERT).
    if (pendingEarnings.length > 0) {
      await fastify.db
        .insert(earningLedger)
        .values(
          pendingEarnings.map((earning) => ({
            organizationId,
            premisesId,
            employeeId: staffProfileId,
            ...earning,
          }))
        )
        .onConflictDoNothing();
    }
  } catch (err) {
    fastify.log.warn({ err, staffProfileId }, 'Failed to generate earning ledger entries');
  }
}

/**
 * 2. Get or generate monthly payroll.
 */
export async function getOrGenerateMonthlyPayroll(
  fastify: FastifyInstance,
  organizationId: string,
  premisesId: string,
  staffProfileId: string,
  month: number,
  year: number
) {
  await generateDailyEarningLedgerEntries(fastify, organizationId, premisesId, staffProfileId, month, year);

  let [payroll] = await fastify.db
    .select()
    .from(schema.monthlyPayrolls)
    .where(
      and(
        eq(schema.monthlyPayrolls.organizationId, organizationId),
        eq(schema.monthlyPayrolls.premisesId, premisesId),
        eq(schema.monthlyPayrolls.employeeId, staffProfileId),
        eq(schema.monthlyPayrolls.month, month),
        eq(schema.monthlyPayrolls.year, year)
      )
    )
    .limit(1);

  if (!payroll) {
    const [inserted] = await fastify.db
      .insert(schema.monthlyPayrolls)
      .values({
        organizationId,
        premisesId,
        employeeId: staffProfileId,
        month,
        year,
        earnedAmount: '0.00',
        paidAmount: '0.00',
        dueAmount: '0.00',
        status: 'OPEN',
      })
      .returning();
    payroll = inserted;
  }

  return await reconcileMonthlyPayrollById(fastify, payroll.id);
}

/**
 * 9. Recalculate and reconcile monthly payroll summary.
 */
async function reconcileMonthlyPayrollById(fastify: FastifyInstance, payrollId: string) {
  const [payroll] = await fastify.db
    .select()
    .from(schema.monthlyPayrolls)
    .where(eq(schema.monthlyPayrolls.id, payrollId))
    .limit(1);

  if (!payroll) {
    throw new AppError('Monthly payroll not found', 404, 'PAYROLL_NOT_FOUND');
  }

  const { startDate, nextMonthStartDate } = getMonthDateRange(payroll.year, payroll.month);

  const earningLedger = schema.employeeEarningLedger;
  const [earnedResult] = await fastify.db
    .select({
      total: sql<string>`COALESCE(SUM(${earningLedger.amount}), 0)`,
    })
    .from(earningLedger)
    .where(
      and(
        eq(earningLedger.employeeId, payroll.employeeId),
        eq(earningLedger.organizationId, payroll.organizationId),
        gte(earningLedger.earningDate, startDate),
        sql`${earningLedger.earningDate} < ${nextMonthStartDate}`
      )
    );

  const earnedAmount = Number(earnedResult?.total ?? 0);

  const [paidResult] = await fastify.db
    .select({
      total: sql<string>`COALESCE(SUM(${schema.payrollTransactions.amount}), 0)`,
    })
    .from(schema.payrollTransactions)
    .where(eq(schema.payrollTransactions.monthlyPayrollId, payrollId));

  const paidAmount = Number(paidResult?.total ?? 0);

  const dueAmount = Math.max(0, earnedAmount - paidAmount);
  const status = paidAmount > 0 && dueAmount <= 0 ? 'PAID' : payroll.status;

  const [updated] = await fastify.db
    .update(schema.monthlyPayrolls)
    .set({
      earnedAmount: earnedAmount.toFixed(2),
      paidAmount: paidAmount.toFixed(2),
      dueAmount: dueAmount.toFixed(2),
      status,
      updatedAt: new Date(),
    })
    .where(eq(schema.monthlyPayrolls.id, payrollId))
    .returning();

  return updated;
}

/**
 * 3. Get monthly payroll summaries.
 */
export async function listMonthlyPayrollSummaries(
  fastify: FastifyInstance,
  organizationId: string,
  month: number,
  year: number,
  premisesId?: string
) {
  const staffList = await listOrganizationStaff(fastify, organizationId);
  const filteredStaff = staffList.filter((s) => !premisesId || s.premisesId === premisesId);

  const summaries = [];
  for (const staff of filteredStaff) {
    if (!staff.premisesId) continue;
    const payroll = await getOrGenerateMonthlyPayroll(
      fastify,
      organizationId,
      staff.premisesId,
      staff.id,
      month,
      year
    );

    summaries.push({
      ...payroll,
      staffName: staff.fullName,
      staffCode: staff.employeeCode,
      staffEmail: staff.email,
    });
  }

  return summaries;
}

/**
 * 4. Get daily earning ledger entries.
 */
export async function getDailyEarningLedger(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string,
  month: number,
  year: number
) {
  const todayIso = new Date().toISOString().split('T')[0]!;
  const { startDate, nextMonthStartDate } = getMonthDateRange(year, month);
  const earningLedger = schema.employeeEarningLedger;
  const rows = await fastify.db
    .select()
    .from(earningLedger)
    .where(
      and(
        eq(earningLedger.organizationId, organizationId),
        eq(earningLedger.employeeId, staffProfileId),
        gte(earningLedger.earningDate, startDate),
        sql`${earningLedger.earningDate} < ${nextMonthStartDate}`,
        lte(earningLedger.earningDate, todayIso)
      )
    )
    .orderBy(desc(earningLedger.earningDate));

  return rows.map((r) => ({
    ...r,
    earningDate: toYmd(r.earningDate),
  }));
}

/**
 * 5. Get daily earning totals.
 */
export async function getDailyEarningTotals(
  fastify: FastifyInstance,
  organizationId: string,
  staffProfileId: string,
  month: number,
  year: number
) {
  const entries = await getDailyEarningLedger(fastify, organizationId, staffProfileId, month, year);
  const grouped = new Map<string, typeof entries>();

  for (const entry of entries) {
    const dateStr = toYmd(entry.earningDate);
    const list = grouped.get(dateStr) ?? [];
    list.push({ ...entry, earningDate: dateStr });
    grouped.set(dateStr, list);
  }

  const totals = [];
  for (const [dateStr, list] of grouped.entries()) {
    const totalAmount = list.reduce((sum, e) => sum + Number(e.amount), 0);
    totals.push({
      earningDate: dateStr,
      totalAmount: totalAmount.toFixed(2),
      entryCount: list.length,
      entries: list,
    });
  }

  return totals.sort((a, b) => b.earningDate.localeCompare(a.earningDate));
}



/**
 * 7. Record / delete salary payments.
 */
export async function recordPayrollTransaction(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string,
  input: { monthlyPayrollId: string; amount: number; paymentDate: string; paymentMethod: string; reference?: string }
) {
  const [payroll] = await fastify.db
    .select()
    .from(schema.monthlyPayrolls)
    .where(
      and(
        eq(schema.monthlyPayrolls.id, input.monthlyPayrollId),
        eq(schema.monthlyPayrolls.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!payroll) {
    throw new AppError('Monthly payroll not found', 404, 'PAYROLL_NOT_FOUND');
  }

  const dueAmount = Number(payroll.dueAmount);
  if (input.amount > dueAmount) {
    throw new AppError(
      `Payment amount exceeds due balance of ${dueAmount}`,
      400,
      'PAYMENT_EXCEEDS_DUE_BALANCE',
      { dueAmount }
    );
  }

  const [transaction] = await fastify.db
    .insert(schema.payrollTransactions)
    .values({
      monthlyPayrollId: input.monthlyPayrollId,
      amount: input.amount.toFixed(2),
      paymentDate: input.paymentDate,
      paymentMethod: input.paymentMethod,
      reference: input.reference ?? null,
      createdBy: userId,
    })
    .returning();

  await reconcileMonthlyPayrollById(fastify, input.monthlyPayrollId);
  return transaction;
}

export async function deletePayrollTransaction(fastify: FastifyInstance, organizationId: string, transactionId: string) {
  const [txRecord] = await fastify.db
    .select({
      tx: schema.payrollTransactions,
      payroll: schema.monthlyPayrolls,
    })
    .from(schema.payrollTransactions)
    .innerJoin(schema.monthlyPayrolls, eq(schema.monthlyPayrolls.id, schema.payrollTransactions.monthlyPayrollId))
    .where(
      and(
        eq(schema.payrollTransactions.id, transactionId),
        eq(schema.monthlyPayrolls.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!txRecord) {
    throw new AppError('Payment transaction not found', 404, 'TRANSACTION_NOT_FOUND');
  }

  await fastify.db.delete(schema.payrollTransactions).where(eq(schema.payrollTransactions.id, transactionId));
  await reconcileMonthlyPayrollById(fastify, txRecord.payroll.id);
  return { status: 'DELETED' };
}

export async function updatePayrollTransaction(
  fastify: FastifyInstance,
  organizationId: string,
  transactionId: string,
  input: { amount?: number; paymentDate?: string; paymentMethod?: string; referenceNumber?: string | null; notes?: string | null }
) {
  const [txRecord] = await fastify.db
    .select({
      tx: schema.payrollTransactions,
      payroll: schema.monthlyPayrolls,
    })
    .from(schema.payrollTransactions)
    .innerJoin(schema.monthlyPayrolls, eq(schema.monthlyPayrolls.id, schema.payrollTransactions.monthlyPayrollId))
    .where(
      and(
        eq(schema.payrollTransactions.id, transactionId),
        eq(schema.monthlyPayrolls.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!txRecord) {
    throw new AppError('Payment transaction not found', 404, 'TRANSACTION_NOT_FOUND');
  }

  const set: any = {};
  if (input.amount !== undefined) set.amount = input.amount.toFixed(2);
  if (input.paymentDate !== undefined) set.paymentDate = input.paymentDate;
  if (input.paymentMethod !== undefined) set.paymentMethod = input.paymentMethod;
  if (input.referenceNumber !== undefined) set.reference = input.referenceNumber;
  if (input.notes !== undefined) set.notes = input.notes;

  const [updated] = await fastify.db
    .update(schema.payrollTransactions)
    .set(set)
    .where(eq(schema.payrollTransactions.id, transactionId))
    .returning();

  await reconcileMonthlyPayrollById(fastify, txRecord.payroll.id);
  return updated;
}

export async function listPayrollTransactions(fastify: FastifyInstance, monthlyPayrollId: string, organizationId?: string) {
  if (organizationId) {
    const [payroll] = await fastify.db
      .select()
      .from(schema.monthlyPayrolls)
      .where(and(eq(schema.monthlyPayrolls.id, monthlyPayrollId), eq(schema.monthlyPayrolls.organizationId, organizationId)))
      .limit(1);

    if (!payroll) {
      throw new AppError('Monthly payroll not found', 404, 'PAYROLL_NOT_FOUND');
    }
  }

  return await fastify.db
    .select()
    .from(schema.payrollTransactions)
    .where(eq(schema.payrollTransactions.monthlyPayrollId, monthlyPayrollId));
}

const BASIS_POINTS = 10_000;

function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100);
}

function toMoney(cents: number): string {
  return (Math.max(0, Math.round(cents)) / 100).toFixed(2);
}

export function daysInMonth(dateIso: string): number {
  const [year, month] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface AssignmentPay {
  id: string;
  organizationId: string;
  premisesId: string;
  employeeId: string;
  absentPay: string;
  presentPay: string;
  leavePay: string;
  halfDayPay: string;
  createdAt: Date;
  updatedAt: Date;
}

async function loadActiveAssignment(
  fastify: FastifyInstance,
  organizationId: string,
  employeeId: string,
  premisesId?: string | null
): Promise<AssignmentPay | null> {
  const conditions = [
    eq(schema.employeeShiftAssignments.organizationId, organizationId),
    eq(schema.employeeShiftAssignments.employeeId, employeeId),
    eq(schema.employeeShiftAssignments.isActive, true),
  ];

  if (premisesId) {
    conditions.push(eq(schema.employeeShiftAssignments.premisesId, premisesId));
  }

  const [assignment] = await fastify.db
    .select({
      id: schema.employeeShiftAssignments.id,
      organizationId: schema.employeeShiftAssignments.organizationId,
      premisesId: schema.employeeShiftAssignments.premisesId,
      employeeId: schema.employeeShiftAssignments.employeeId,
      absentPay: schema.employeeShiftAssignments.absentPay,
      presentPay: schema.employeeShiftAssignments.presentPay,
      leavePay: schema.employeeShiftAssignments.leavePay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
      createdAt: schema.employeeShiftAssignments.createdAt,
      updatedAt: schema.employeeShiftAssignments.updatedAt,
    })
    .from(schema.employeeShiftAssignments)
    .where(and(...conditions))
    .limit(1);

  return assignment ?? null;
}

export async function getCurrentSalaryStructure(
  fastify: FastifyInstance,
  employeeId: string,
  onDate?: string,
  organizationId?: string
) {
  const effectiveOn = onDate ?? new Date().toISOString().slice(0, 10);

  const conditions = [
    eq(schema.employeeShiftAssignments.employeeId, employeeId),
    eq(schema.employeeShiftAssignments.isActive, true),
  ];
  if (organizationId) {
    conditions.push(
      eq(schema.employeeShiftAssignments.organizationId, organizationId)
    );
  }

  const [assignment] = await fastify.db
    .select({
      id: schema.employeeShiftAssignments.id,
      organizationId: schema.employeeShiftAssignments.organizationId,
      presentPay: schema.employeeShiftAssignments.presentPay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
      absentPay: schema.employeeShiftAssignments.absentPay,
      leavePay: schema.employeeShiftAssignments.leavePay,
      createdAt: schema.employeeShiftAssignments.createdAt,
    })
    .from(schema.employeeShiftAssignments)
    .where(and(...conditions))
    .limit(1);

  if (!assignment) {
    throw new AppError(
      'Shift assignment pay is not configured',
      404,
      'SALARY_NOT_CONFIGURED'
    );
  }

  const presentCents = toCents(assignment.presentPay);

  return {
    id: assignment.id,
    employeeId,
    compensationType: 'SHIFT' as const,
    baseRateCents: presentCents * 30,
    overtimeRateCents: 0,
    effectiveFrom: String(effectiveOn),
    effectiveTo: null as string | null,
    presentCents,
    halfDayCents: toCents(assignment.halfDayPay),
    absentCents: toCents(assignment.absentPay),
    leaveCents: toCents(assignment.leavePay),
    createdAt: assignment.createdAt,
  };
}

export interface PaymentRuleLike {
  employeeId?: string | null;
  attendanceStatus?: string;
  dayType?: string;
  paymentCents?: number;
  penaltyCents?: number;
  multiplierBasisPoints?: number;
}

export interface SalaryCalculationInput {
  compensationType: 'MONTHLY' | 'DAILY' | 'HOURLY' | 'SHIFT' | 'MIXED';
  baseRateCents: number;
  overtimeRateCents: number;
  shiftPaymentRules?: PaymentRuleLike[];
  unworkedPaymentRules?: PaymentRuleLike[];
  attendanceSummary: {
    presentDays: number;
    lateDays: number;
    halfDays: number;
    absentDays: number;
    totalWorkedMinutes: number;
    totalOvertimeMinutes: number;
    holidayDays: number;
    paidLeaveDays?: number;
    weeklyOffDays?: number;
  };
  workingDaysInMonth?: number;
}

function pickRule(
  rules: PaymentRuleLike[] | undefined,
  key: 'attendanceStatus' | 'dayType',
  value: string
): PaymentRuleLike | null {
  if (!rules || rules.length === 0) {
    return null;
  }
  const matching = rules.filter((rule) => rule[key] === value);
  if (matching.length === 0) {
    return null;
  }
  return matching.find((rule) => Boolean(rule.employeeId)) ?? matching[0];
}

function multiplyBasisPoints(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / BASIS_POINTS);
}

export function calculateSalary(params: SalaryCalculationInput) {
  const {
    compensationType,
    baseRateCents,
    overtimeRateCents,
    shiftPaymentRules,
    unworkedPaymentRules,
    attendanceSummary,
    workingDaysInMonth = 30,
  } = params;

  const presentDays = Math.max(0, attendanceSummary.presentDays);
  const halfDays = Math.max(0, attendanceSummary.halfDays);
  const absentDays = Math.max(0, attendanceSummary.absentDays);
  const paidLeaveDays = Math.max(0, attendanceSummary.paidLeaveDays ?? 0);
  const paidHolidayDays = Math.max(0, attendanceSummary.holidayDays);
  const weeklyOffDays = Math.max(0, attendanceSummary.weeklyOffDays ?? 0);
  const workedDays = presentDays + halfDays * 0.5;

  const rulePresent = pickRule(shiftPaymentRules, 'attendanceStatus', 'PRESENT');
  const ruleHalfDay = pickRule(shiftPaymentRules, 'attendanceStatus', 'HALF_DAY');
  const ruleAbsent = pickRule(shiftPaymentRules, 'attendanceStatus', 'ABSENT');
  const hasShiftRules = Boolean(rulePresent || ruleHalfDay || ruleAbsent);

  const ruleHoliday = pickRule(unworkedPaymentRules, 'dayType', 'HOLIDAY');
  const ruleWeeklyOff = pickRule(unworkedPaymentRules, 'dayType', 'WEEKLY_OFF');
  const rulePaidLeave = pickRule(unworkedPaymentRules, 'dayType', 'PAID_LEAVE');

  const earnings: Array<{ code: string; label: string; amountCents: number }> = [];

  const dailyRate = Math.round(baseRateCents / Math.max(1, workingDaysInMonth));

  const push = (code: string, label: string, amountCents: number) => {
    const rounded = Math.max(0, Math.round(amountCents));
    if (rounded > 0) {
      earnings.push({ code, label, amountCents: rounded });
    }
    return rounded;
  };

  let basePay = 0;
  let overtimePay = 0;

  if (hasShiftRules) {
    basePay =
      presentDays * (rulePresent?.paymentCents ?? baseRateCents) +
      halfDays * (ruleHalfDay?.paymentCents ?? Math.round(baseRateCents / 2)) +
      absentDays * (ruleAbsent?.paymentCents ?? 0);

    push('BASE_SALARY', 'Shift attendance payments', basePay);
  } else if (compensationType === 'MONTHLY') {
    const pricedPaidLeaveDays = rulePaidLeave ? 0 : paidLeaveDays;
    const pricedPaidHolidays = ruleHoliday ? 0 : paidHolidayDays;
    const pricedWeeklyOffDays = ruleWeeklyOff ? 0 : weeklyOffDays;
    basePay = Math.round(dailyRate * (workedDays + pricedPaidLeaveDays + pricedPaidHolidays + pricedWeeklyOffDays));
    push('BASE_SALARY', 'Base salary', basePay);
  } else if (compensationType === 'DAILY') {
    basePay = Math.round(baseRateCents * workedDays);
    push('BASE_SALARY', 'Daily wage', basePay);
  } else if (compensationType === 'HOURLY') {
    basePay = Math.round((baseRateCents * attendanceSummary.totalWorkedMinutes) / 60);
    push('BASE_SALARY', 'Hourly wage', basePay);
  } else if (compensationType === 'SHIFT') {
    basePay = Math.round(baseRateCents * workedDays);
    push('BASE_SALARY', 'Shift wage', basePay);
  } else {
    const pricedPaidLeaveDays = rulePaidLeave ? 0 : paidLeaveDays;
    const pricedPaidHolidays = ruleHoliday ? 0 : paidHolidayDays;
    const pricedWeeklyOffDays = ruleWeeklyOff ? 0 : weeklyOffDays;
    basePay = Math.round(dailyRate * (workedDays + pricedPaidLeaveDays + pricedPaidHolidays + pricedWeeklyOffDays));
    push('BASE_SALARY', 'Fixed monthly base', basePay);

    overtimePay = Math.round(
      (overtimeRateCents * Math.max(0, attendanceSummary.totalOvertimeMinutes)) / 60
    );
    push('OVERTIME', 'Overtime pay', overtimePay);
  }

  const leaveAndHolidayRate = compensationType === 'MONTHLY' || compensationType === 'MIXED'
    ? dailyRate
    : compensationType === 'HOURLY'
      ? Math.round((baseRateCents * 480) / 60)
      : baseRateCents;

  let unworkedHolidayPay = 0;
  if (paidHolidayDays > 0 && ruleHoliday) {
    const perDay = ruleHoliday.paymentCents && ruleHoliday.paymentCents > 0
      ? ruleHoliday.paymentCents
      : Math.round(leaveAndHolidayRate * ((ruleHoliday.multiplierBasisPoints ?? 10_000) / BASIS_POINTS));
    unworkedHolidayPay = perDay * paidHolidayDays;
    push('HOLIDAY_PAY', 'Paid holiday pay', unworkedHolidayPay);
  }

  let paidLeavePay = 0;
  if (paidLeaveDays > 0 && rulePaidLeave) {
    const perDay = rulePaidLeave.paymentCents && rulePaidLeave.paymentCents > 0
      ? rulePaidLeave.paymentCents
      : Math.round(leaveAndHolidayRate * ((rulePaidLeave.multiplierBasisPoints ?? 10_000) / BASIS_POINTS));
    paidLeavePay = perDay * paidLeaveDays;
    push('PAID_LEAVE', 'Paid leave', paidLeavePay);
  }

  let unworkedWeeklyOffPay = 0;
  if (weeklyOffDays > 0 && ruleWeeklyOff) {
    const perDay = ruleWeeklyOff.paymentCents && ruleWeeklyOff.paymentCents > 0
      ? ruleWeeklyOff.paymentCents
      : Math.round(leaveAndHolidayRate * ((ruleWeeklyOff.multiplierBasisPoints ?? 10_000) / BASIS_POINTS));
    unworkedWeeklyOffPay = perDay * weeklyOffDays;
    push('WEEKLY_OFF_PAY', 'Weekly-off pay', unworkedWeeklyOffPay);
  }

  const grossSalaryCents = earnings.reduce((sum, item) => sum + item.amountCents, 0);
  const netSalaryCents = grossSalaryCents;

  return {
    grossSalaryCents,
    additionsCents:
      unworkedHolidayPay +
      paidLeavePay +
      unworkedWeeklyOffPay +
      overtimePay,
    deductionsCents: 0,
    netSalaryCents,
    breakdown: { earnings, deductions: [] },
  };
}

export function calculateDailyAccrual(params: {
  compensationType: 'MONTHLY' | 'DAILY' | 'HOURLY' | 'SHIFT' | 'MIXED';
  baseRateCents: number;
  overtimeRateCents: number;
  shiftPaymentRules?: PaymentRuleLike[];
  unworkedPaymentRules?: PaymentRuleLike[];
  status: 'PRESENT' | 'HALF_DAY' | 'ABSENT';
  workedMinutes: number;
  overtimeMinutes: number;
  periodStartDate: string;
  overtimeRateApplies?: boolean;
}): number {
  const {
    compensationType,
    baseRateCents,
    overtimeRateCents,
    shiftPaymentRules,
    status,
    workedMinutes,
    overtimeMinutes,
    periodStartDate,
  } = params;

  const directShiftRule = pickRule(shiftPaymentRules, 'attendanceStatus', status);

  if (status === 'ABSENT') {
    if (directShiftRule?.paymentCents != null) {
      return directShiftRule.paymentCents;
    }
    return 0;
  }

  const fraction = status === 'HALF_DAY' ? 0.5 : 1;
  const dailyRate = Math.round(baseRateCents / Math.max(1, daysInMonth(periodStartDate)));

  let amount = 0;

  if (directShiftRule?.paymentCents != null) {
    amount = directShiftRule.paymentCents * fraction;
    if (compensationType === 'MIXED') {
      amount += Math.round((overtimeRateCents * Math.max(0, overtimeMinutes)) / 60);
    }
  } else if (compensationType === 'MONTHLY') {
    amount = Math.round(dailyRate * fraction);
  } else if (compensationType === 'DAILY' || compensationType === 'SHIFT') {
    amount = Math.round(baseRateCents * fraction);
  } else if (compensationType === 'HOURLY') {
    amount = Math.round((baseRateCents * Math.max(0, workedMinutes)) / 60);
  } else {
    amount = Math.round(dailyRate * fraction);
    amount += Math.round((overtimeRateCents * Math.max(0, overtimeMinutes)) / 60);
  }

  return Math.max(0, amount);
}

export interface ShiftPayRule {
  id: string;
  organizationId: string;
  employeeId: string | null;
  premisesId: string | null;
  attendanceStatus: 'PRESENT' | 'HALF_DAY' | 'ABSENT';
  paymentCents: number;
  penaltyCents: number;
  multiplierBasisPoints: number;
  effectiveFrom: string;
  createdAt: string;
}

function assignmentRule(
  assignment: AssignmentPay,
  attendanceStatus: ShiftPayRule['attendanceStatus'],
  paymentCents: number
): ShiftPayRule {
  return {
    id: assignment.id,
    organizationId: assignment.organizationId,
    employeeId: assignment.employeeId,
    premisesId: assignment.premisesId,
    attendanceStatus,
    paymentCents,
    penaltyCents: 0,
    multiplierBasisPoints: 10_000,
    effectiveFrom: assignment.createdAt.toISOString().slice(0, 10),
    createdAt: assignment.createdAt.toISOString(),
  };
}

export async function getShiftPaymentRules(
  fastify: FastifyInstance,
  organizationId: string,
  employeeId?: string,
  _onDate?: string
): Promise<ShiftPayRule[]> {
  const conditions = [
    eq(schema.employeeShiftAssignments.organizationId, organizationId),
    eq(schema.employeeShiftAssignments.isActive, true),
  ];
  if (employeeId) {
    conditions.push(eq(schema.employeeShiftAssignments.employeeId, employeeId));
  }

  const assignments = await fastify.db
    .select({
      id: schema.employeeShiftAssignments.id,
      organizationId: schema.employeeShiftAssignments.organizationId,
      premisesId: schema.employeeShiftAssignments.premisesId,
      employeeId: schema.employeeShiftAssignments.employeeId,
      absentPay: schema.employeeShiftAssignments.absentPay,
      presentPay: schema.employeeShiftAssignments.presentPay,
      leavePay: schema.employeeShiftAssignments.leavePay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
      createdAt: schema.employeeShiftAssignments.createdAt,
      updatedAt: schema.employeeShiftAssignments.updatedAt,
    })
    .from(schema.employeeShiftAssignments)
    .where(and(...conditions));

  return assignments.flatMap((assignment) => [
    assignmentRule(assignment, 'PRESENT', toCents(assignment.presentPay)),
    assignmentRule(assignment, 'HALF_DAY', toCents(assignment.halfDayPay)),
    assignmentRule(assignment, 'ABSENT', toCents(assignment.absentPay)),
  ]);
}

export async function getUnworkedPaymentRules(
  fastify: FastifyInstance,
  user: { userId: string; role: 'OWNER' | 'EMPLOYEE' },
  organizationId: string,
  employeeId?: string,
  premisesId?: string,
  onDate?: string
) {
  let targetEmployeeId = employeeId?.trim() || undefined;
  let targetPremisesId = premisesId?.trim() || undefined;
  if (user.role === 'EMPLOYEE') {
    const profile = await findStaffProfile(fastify, user.userId, organizationId);
    if (profile) {
      targetEmployeeId = profile.id;
      if (!targetPremisesId && profile.premisesId) {
        targetPremisesId = profile.premisesId;
      }
    }
  }

  const conditions = [eq(schema.unworkedPaymentRules.organizationId, organizationId)];

  if (targetEmployeeId) {
    conditions.push(
      sql`(${schema.unworkedPaymentRules.employeeId} = ${targetEmployeeId} OR ${schema.unworkedPaymentRules.employeeId} IS NULL)`
    );
  }
  if (targetPremisesId) {
    conditions.push(
      sql`(${schema.unworkedPaymentRules.premisesId} = ${targetPremisesId} OR ${schema.unworkedPaymentRules.premisesId} IS NULL)`
    );
  }

  const rows = await fastify.db
    .select()
    .from(schema.unworkedPaymentRules)
    .where(and(...conditions))
    .orderBy(
      sql`CASE WHEN ${schema.unworkedPaymentRules.employeeId} IS NOT NULL THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${schema.unworkedPaymentRules.premisesId} IS NOT NULL THEN 0 ELSE 1 END`,
      desc(schema.unworkedPaymentRules.createdAt)
    );

  return rows.map((r) => ({
    ...r,
    paymentInr: Number(r.paymentInr ?? 0),
  }));
}

export async function createShiftPaymentRule(
  fastify: FastifyInstance,
  organizationId: string,
  input: {
    employeeId?: string | null;
    premisesId?: string | null;
    attendanceStatus: 'PRESENT' | 'HALF_DAY' | 'ABSENT';
    paymentCents: number;
    penaltyCents?: number;
    multiplierBasisPoints?: number;
    effectiveFrom?: string;
  }
): Promise<ShiftPayRule> {
  if (!input.employeeId) {
    throw new AppError(
      'Select an employee: shift pay is configured on the employee shift assignment.',
      400,
      'EMPLOYEE_REQUIRED'
    );
  }

  const assignment = await loadActiveAssignment(
    fastify,
    organizationId,
    input.employeeId,
    input.premisesId
  );

  if (!assignment) {
    throw new AppError(
      'Active shift assignment not found',
      404,
      'SHIFT_ASSIGNMENT_NOT_FOUND'
    );
  }

  const payColumn =
    input.attendanceStatus === 'HALF_DAY'
      ? 'halfDayPay'
      : input.attendanceStatus === 'ABSENT'
        ? 'absentPay'
        : 'presentPay';

  const effectiveFrom =
    input.effectiveFrom ?? new Date().toISOString().slice(0, 10);

  const [updated] = await fastify.db
    .update(schema.employeeShiftAssignments)
    .set({
      [payColumn]: toMoney(input.paymentCents),
      updatedAt: new Date(),
    })
    .where(eq(schema.employeeShiftAssignments.id, assignment.id))
    .returning({
      id: schema.employeeShiftAssignments.id,
      organizationId: schema.employeeShiftAssignments.organizationId,
      premisesId: schema.employeeShiftAssignments.premisesId,
      employeeId: schema.employeeShiftAssignments.employeeId,
      absentPay: schema.employeeShiftAssignments.absentPay,
      presentPay: schema.employeeShiftAssignments.presentPay,
      leavePay: schema.employeeShiftAssignments.leavePay,
      halfDayPay: schema.employeeShiftAssignments.halfDayPay,
      createdAt: schema.employeeShiftAssignments.createdAt,
      updatedAt: schema.employeeShiftAssignments.updatedAt,
    });

  return {
    ...assignmentRule(
      updated,
      input.attendanceStatus,
      input.paymentCents
    ),
    effectiveFrom,
  };
}

export async function createUnworkedPaymentRule(
  fastify: FastifyInstance,
  organizationId: string,
  input: {
    employeeId?: string | null;
    premisesId?: string | null;
    dayType: (typeof schema.unworkedDayTypeEnum.enumValues)[number];
    paymentInr?: number;
    paymentCents?: number;
    multiplierBasisPoints?: number;
  }
) {
  const employeeId = input.employeeId?.trim() || null;
  const premisesId = input.premisesId?.trim() || null;

  if (employeeId) {
    const [profile] = await fastify.db
      .select({ id: schema.employees.id })
      .from(schema.employees)
      .where(
        and(
          eq(schema.employees.id, employeeId),
          eq(schema.employees.organizationId, organizationId)
        )
      )
      .limit(1);
    if (!profile) {
      throw new AppError('Staff profile not found', 404, 'STAFF_PROFILE_NOT_FOUND');
    }
  }

  const paymentAmount = input.paymentInr ?? (input.paymentCents !== undefined ? Math.round(input.paymentCents / 100) : 0);

  // Check for an existing rule for same organization, employee/premises, and dayType
  const existingConditions = [
    eq(schema.unworkedPaymentRules.organizationId, organizationId),
    eq(schema.unworkedPaymentRules.dayType, input.dayType),
  ];
  if (employeeId) {
    existingConditions.push(eq(schema.unworkedPaymentRules.employeeId, employeeId));
  } else {
    existingConditions.push(sql`${schema.unworkedPaymentRules.employeeId} IS NULL`);
    if (premisesId) {
      existingConditions.push(eq(schema.unworkedPaymentRules.premisesId, premisesId));
    } else {
      existingConditions.push(sql`${schema.unworkedPaymentRules.premisesId} IS NULL`);
    }
  }

  const [existing] = await fastify.db
    .select()
    .from(schema.unworkedPaymentRules)
    .where(and(...existingConditions))
    .limit(1);

  let resultRule;
  if (existing) {
    const [updated] = await fastify.db
      .update(schema.unworkedPaymentRules)
      .set({
        paymentInr: paymentAmount,
        premisesId: premisesId ?? existing.premisesId,
        createdAt: new Date(),
      })
      .where(eq(schema.unworkedPaymentRules.id, existing.id))
      .returning();
    resultRule = updated;
  } else {
    const [created] = await fastify.db
      .insert(schema.unworkedPaymentRules)
      .values({
        organizationId,
        premisesId: premisesId ?? null,
        employeeId: employeeId ?? null,
        dayType: input.dayType,
        paymentInr: paymentAmount,
        createdAt: new Date(),
      })
      .returning();
    resultRule = created;
  }

  // Update unlocked employee earning ledger entries for this rule's scope in the current open period
  try {
    const ledgerType = input.dayType === 'HOLIDAY' ? 'HOLIDAY' : 'OFF_DAY';
    const currentDate = new Date().toISOString().slice(0, 10);
    const currentMonthStart = currentDate.slice(0, 7) + '-01';

    const ledgerConditions = [
      eq(schema.employeeEarningLedger.organizationId, organizationId),
      eq(schema.employeeEarningLedger.type, ledgerType),
      gte(schema.employeeEarningLedger.earningDate, currentMonthStart),
    ];
    if (employeeId) {
      ledgerConditions.push(eq(schema.employeeEarningLedger.employeeId, employeeId));
    } else if (premisesId) {
      ledgerConditions.push(eq(schema.employeeEarningLedger.premisesId, premisesId));
    }

    await fastify.db
      .update(schema.employeeEarningLedger)
      .set({
        amount: String(paymentAmount),
        updatedAt: new Date(),
      })
      .where(and(...ledgerConditions));
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to backfill earning ledger after unworked rule update');
  }

  return {
    ...resultRule,
    paymentInr: Number(resultRule.paymentInr ?? 0),
  };
}

export async function getMyMonthlyEarningLedger(
  fastify: FastifyInstance,
  user: { userId: string; organizationId: string; role: string },
  month: number,
  year: number
) {
  const profile = await findStaffProfile(fastify, user.userId, user.organizationId);
  if (!profile || !profile.premisesId) {
    throw new AppError('Employee profile or assigned premises not found', 404, 'EMPLOYEE_NOT_FOUND');
  }

  const report = await getOrGenerateMonthlyPayroll(
    fastify,
    user.organizationId,
    profile.premisesId,
    profile.id,
    month,
    year
  );

  const r: any = report as any;

  const dailyTotals = await getDailyEarningTotals(
    fastify,
    user.organizationId,
    profile.id,
    month,
    year
  );

  const rawEntries = await getDailyEarningLedger(
    fastify,
    user.organizationId,
    profile.id,
    month,
    year
  );

  const payments = await fastify.db
    .select({
      id: schema.payrollTransactions.id,
      amount: schema.payrollTransactions.amount,
      paymentDate: schema.payrollTransactions.paymentDate,
      paymentMethod: schema.payrollTransactions.paymentMethod,
      reference: schema.payrollTransactions.reference,
    })
    .from(schema.payrollTransactions)
    .innerJoin(
      schema.monthlyPayrolls,
      eq(schema.monthlyPayrolls.id, schema.payrollTransactions.monthlyPayrollId)
    )
    .where(
      and(
        eq(schema.monthlyPayrolls.organizationId, user.organizationId),
        eq(schema.monthlyPayrolls.employeeId, profile.id),
        eq(schema.monthlyPayrolls.month, month),
        eq(schema.monthlyPayrolls.year, year)
      )
    )
    .orderBy(desc(schema.payrollTransactions.paymentDate));

  return {
    staffProfileId: profile.id,
    staffName: profile.name,
    staffCode: profile.employeeCode,
    premisesId: profile.premisesId,
    month,
    year,
    earnedAmount: r.earnedAmount ?? '0.00',
    earnedPaise: Math.round(Number(r.earnedAmount ?? 0)),
    paidAmount: r.paidAmount ?? '0.00',
    dueAmount: r.dueAmount ?? '0.00',
    status: r.status ?? 'OPEN',
    attendanceSummary: r.attendanceSummary ?? {
      totalDays: 0,
      presentDays: 0,
      lateDays: 0,
      halfDays: 0,
      absentDays: 0,
      leaveDays: 0,
      unpaidLeaveDays: 0,
      paidLeaveDays: 0,
      holidayDays: 0,
      weeklyOffDays: 0,
      totalWorkedMinutes: 0,
      totalOvertimeMinutes: 0,
    },
    breakdown: r.breakdown ?? { earnings: [] },
    dailyTotals,
    entries: rawEntries.map((e: any) => {
      const inr = Math.round(Number(e.amount) || 0);
      return {
        id: e.id,
        organizationId: e.organizationId,
        staffProfileId: e.employeeId,
        type: e.type,
        amount: String(inr),
        amountPaise: inr,
        amountInr: inr,
        earningDate: e.earningDate,
        createdAt: e.createdAt,
      };
    }),
    payments: payments.map((p: any) => ({
      id: p.id,
      amountPaise: Math.round(Number(p.amount) || 0),
      paymentDate: p.paymentDate,
      paymentMethod: p.paymentMethod,
      referenceNumber: p.reference,
    })),
  };
}

export async function listMyPayslips(
  fastify: FastifyInstance,
  user: { userId: string; organizationId: string },
  query: { month?: number; year?: number }
) {
  const profile = await findStaffProfile(fastify, user.userId, user.organizationId);
  if (!profile || !profile.premisesId) return [];
  const { month: reqMonth, year: reqYear } = query;
  const now = new Date();

  const targetPairs: Array<{ month: number; year: number }> = [];
  if (reqMonth && reqYear) {
    targetPairs.push({ month: reqMonth, year: reqYear });
  } else if (reqYear) {
    const maxM = reqYear === now.getFullYear() ? now.getMonth() + 1 : 12;
    for (let m = maxM; m >= 1; m--) {
      targetPairs.push({ month: m, year: reqYear });
    }
  } else {
    let startYear = now.getFullYear();
    let startMonth = 1;
    if (profile.hireDate) {
      const [hY, hM] = profile.hireDate.split('-').map(Number);
      if (hY && hM) {
        startYear = hY;
        startMonth = hM;
      }
    }
    const currentTotalMonths = now.getFullYear() * 12 + (now.getMonth() + 1);
    const startTotalMonths = Math.max(startYear * 12 + startMonth, currentTotalMonths - 23);
    for (let tm = currentTotalMonths; tm >= startTotalMonths; tm--) {
      const y = Math.floor((tm - 1) / 12);
      const m = ((tm - 1) % 12) + 1;
      targetPairs.push({ month: m, year: y });
    }
  }

  const results = [];
  for (const { month, year } of targetPairs) {
    try {
      const report = await getOrGenerateMonthlyPayroll(
        fastify,
        user.organizationId,
        profile.premisesId,
        profile.id,
        month,
        year
      );
      if (report) {
        const r: any = report as any;
        const periodStartDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const periodEndDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
        results.push({
          id: r.id,
          payrollPeriodId: r.id,
          periodStartDate,
          periodEndDate,
          periodStatus: r.status,
          grossSalaryPaise: Math.round(Number(r.earnedAmount) * 100),
          additionsPaise: 0,
          deductionsPaise: 0,
          netSalaryPaise: Math.round(Number(r.dueAmount) * 100),
          breakdown: r.breakdown ?? { earnings: [] },
          attendanceSummary: r.attendanceSummary ?? {
            totalDays: 0,
            presentDays: 0,
            lateDays: 0,
            halfDays: 0,
            absentDays: 0,
            leaveDays: 0,
            unpaidLeaveDays: 0,
            paidLeaveDays: 0,
            holidayDays: 0,
            weeklyOffDays: 0,
            totalWorkedMinutes: 0,
            totalOvertimeMinutes: 0,
          },
          createdAt: r.createdAt,
        });
      }
    } catch (err) {
      fastify.log.warn({ err, month, year }, 'Failed to compute monthly payroll for payslip');
    }
  }
  return results;
}

export async function downloadPayslipPdf(
  fastify: FastifyInstance,
  user: { userId: string; organizationId: string; role: string },
  query: { month: number; year: number; staffProfileId?: string }
) {
  let staffId = query.staffProfileId;
  if (user.role === 'STAFF' || (user.role === 'MANAGER' && !staffId)) {
    const selfProfile = await findStaffProfile(fastify, user.userId, user.organizationId);
    if (!selfProfile) throw new AppError('Employee profile not found', 404, 'EMPLOYEE_NOT_FOUND');
    staffId = selfProfile.id;
  }
  if (!staffId) {
    throw new AppError('staffProfileId is required', 400, 'STAFF_PROFILE_ID_REQUIRED');
  }

  const [employee] = await fastify.db
    .select({
      id: schema.employees.id,
      name: schema.employees.name,
      employeeCode: schema.employees.employeeCode,
      premisesId: schema.employees.premisesId,
      department: schema.employees.department,
      designation: schema.employees.designation,
      email: schema.users.email,
    })
    .from(schema.employees)
    .innerJoin(schema.users, eq(schema.employees.userId, schema.users.id))
    .where(
      and(
        eq(schema.employees.id, staffId),
        eq(schema.employees.organizationId, user.organizationId)
      )
    )
    .limit(1);

  if (!employee || !employee.premisesId) {
    throw new AppError('Employee or assigned premises not found', 404, 'EMPLOYEE_NOT_FOUND');
  }

  const [org] = await fastify.db
    .select({ name: schema.organizations.name, currency: schema.organizations.currency })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, user.organizationId))
    .limit(1);

  const orgName = org?.name || 'Presence Organization';
  const currency = org?.currency || 'INR';

  const report = await getOrGenerateMonthlyPayroll(
    fastify,
    user.organizationId,
    employee.premisesId,
    employee.id,
    query.month,
    query.year
  );
  if (!report) throw new AppError('Payroll report could not be generated', 500, 'PAYROLL_GENERATION_FAILED');

  const r: any = report as any;
  const att = r.attendanceSummary ?? {};
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const monthLabel = monthNames[query.month - 1] || `Month ${query.month}`;

  const pdfTable: PdfTable = {
    title: `PAYSLIP - ${monthLabel.toUpperCase()} ${query.year}`,
    subtitle: `${orgName} | Employee: ${employee.name} (${employee.employeeCode}) | Status: ${r.status}`,
    columns: ['Category', 'Details', 'Amount / Count'],
    rows: [
      ['Employee', 'Name', employee.name],
      ['Employee', 'Code', employee.employeeCode],
      ['Employee', 'Email', employee.email],
      ['Period', 'Month / Year', `${monthLabel} ${query.year}`],
      ['Attendance', 'Present Days', att.presentDays ?? 0],
      ['Attendance', 'Half Days', att.halfDays ?? 0],
      ['Attendance', 'Absent Days', att.absentDays ?? 0],
      ['Attendance', 'Leave Days', att.leaveDays ?? 0],
      ['Attendance', 'Holiday Days', att.holidayDays ?? 0],
      ['Attendance', 'Weekly Off Days', att.weeklyOffDays ?? 0],
      ['Attendance', 'Overtime Minutes', att.totalOvertimeMinutes ?? 0],
      ['Earnings', 'Gross Earned', `${currency} ${r.earnedAmount}`],
      ['Summary', 'Net Due / Payable', `${currency} ${r.dueAmount}`],
      ['Summary', 'Amount Paid', `${currency} ${r.paidAmount}`],
      ['Status', 'Payroll Status', r.status],
    ],
  };

  const pdfBuffer = buildPdfReport(pdfTable);
  return {
    filename: `payslip-${employee.employeeCode}-${query.year}-${String(query.month).padStart(2, '0')}.pdf`,
    pdfBuffer,
  };
}

export async function getMyOverallPayrollSummary(
  fastify: FastifyInstance,
  user: { userId: string; organizationId: string; role: string }
) {
  const profile = await findStaffProfile(fastify, user.userId, user.organizationId);
  if (!profile) {
    throw new AppError('Employee profile not found', 404, 'EMPLOYEE_NOT_FOUND');
  }

  const earningLedger = schema.employeeEarningLedger;

  const [earnedResult] = await fastify.db
    .select({
      total: sql<string>`COALESCE(SUM(${earningLedger.amount}), 0)`,
    })
    .from(earningLedger)
    .where(
      and(
        eq(earningLedger.organizationId, user.organizationId),
        eq(earningLedger.employeeId, profile.id)
      )
    );
  const totalEarnedAmount = Number(earnedResult?.total ?? 0);

  const [payrollAgg] = await fastify.db
    .select({
      totalPaid: sql<string>`COALESCE(SUM(${schema.monthlyPayrolls.paidAmount}), 0)`,
    })
    .from(schema.monthlyPayrolls)
    .where(
      and(
        eq(schema.monthlyPayrolls.organizationId, user.organizationId),
        eq(schema.monthlyPayrolls.employeeId, profile.id)
      )
    );

  const totalPaidAmount = Number(payrollAgg?.totalPaid ?? 0);
  const totalDueAmount = Math.max(0, totalEarnedAmount - totalPaidAmount);

  const totalEarnedInr = Math.round(totalEarnedAmount);
  const totalPaidInr = Math.round(totalPaidAmount);
  const totalDueInr = Math.max(0, totalEarnedInr - totalPaidInr);

  return {
    staffProfileId: profile.id,
    staffName: profile.name,
    staffCode: profile.employeeCode,
    premisesId: profile.premisesId,
    totalEarnedAmount: totalEarnedInr.toFixed(2),
    totalEarnedPaise: totalEarnedInr,
    totalPaidAmount: totalPaidInr.toFixed(2),
    totalPaidPaise: totalPaidInr,
    totalDeductionAmount: "0.00",
    totalDeductionPaise: 0,
    totalDueAmount: totalDueInr.toFixed(2),
    totalDuePaise: totalDueInr,
    totalBalancePaise: totalDueInr,
  };
}



