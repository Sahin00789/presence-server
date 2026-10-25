import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  bigint,
  date,
  time,
  numeric,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  customType,
} from 'drizzle-orm/pg-core';

export const vector128 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(128)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return value
      .replace(/[\[\]]/g, '')
      .split(',')
      .map((v) => parseFloat(v));
  },
});

// Enums
export const roleEnum = pgEnum('role', ['OWNER', 'MANAGER', 'STAFF']);
export const employeeRoleEnum = pgEnum('employee_role', ['MANAGER', 'STAFF']);
export const attendanceStatusEnum = pgEnum('attendance_status', [
  'SCHEDULED',
  'PRESENT',
  'LATE',
  'HALF_DAY',
  'ABSENT',
  'LEAVE',
  'HOLIDAY',
  'WEEKLY_OFF',
]);
export const unworkedDayTypeEnum = pgEnum('unworked_day_type', [
  'HOLIDAY',
  'WEEKLY_OFF',
  'PAID_LEAVE',
]);
export const locationCheckResultEnum = pgEnum('location_check_result', [
  'IN_PREMISES',
  'OUTSIDE',
  'STALE',
  'LOW_ACCURACY',
  'MOCKED',
  'UNKNOWN',
]);
export const earningTypeEnum = pgEnum('earning_type', ['SHIFT', 'HOLIDAY', 'OFF_DAY', 'OVERTIME']);
export const monthlyPayrollStatusEnum = pgEnum('monthly_payroll_status', ['OPEN', 'FINALIZED', 'PAID']);
export const overtimeStatusEnum = pgEnum('overtime_status', [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);
export const leaveStatusEnum = pgEnum('leave_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
]);
export const leaveTypeEnum = pgEnum('leave_type', [
  'PAID',
  'UNPAID',
  'SICK',
  'LATE_CLOCK_IN',
  'EARLY_CLOCK_OUT',
]);
export const faceEnrollmentMethodEnum = pgEnum('face_enrollment_method', [
  'MANAGER_SUPERVISED',
]);

export interface PayrollLineItem {
  code: string;
  label: string;
  amountCents: number;
  quantity?: number;
  rateCents?: number;
}

// 1. Organizations
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  logoUrl: text('logo_url'),
  timezone: text('timezone').notNull().default('UTC'),
  currency: text('currency').notNull().default('INR'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 2. Users (Authentication Identities)
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  phone: text('phone').unique(),
  fullName: text('full_name').notNull(),
  avatarUrl: text('avatar_url'),
  isActive: boolean('is_active').notNull().default(true),
  tokenVersion: integer('token_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 3. Owners
export const owners = pgTable('owners', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('owners_org_user_idx').on(table.organizationId, table.userId)
]);

// 4. OTP Requests
export const otpRequests = pgTable('otp_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  role: roleEnum('role').notNull().default('STAFF'),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 5. Google Identities
export const googleIdentities = pgTable('google_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
});

// 6. Logged Devices
export const loggedDevices = pgTable('logged_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionJti: text('session_jti').notNull().unique(),
  refreshTokenHash: text('refresh_token_hash').notNull(),
  deviceName: text('device_name'),
  deviceType: text('device_type'),
  osName: text('os_name'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  isActive: boolean('is_active').notNull().default(true),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  index('logged_devices_user_active_idx').on(table.userId, table.isActive),
  uniqueIndex('logged_devices_session_jti_idx').on(table.sessionJti),
]);

// 7. Premises
export const premises = pgTable('premises', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  latitude: numeric('latitude', { precision: 10, scale: 7 }).notNull(),
  longitude: numeric('longitude', { precision: 10, scale: 7 }).notNull(),
  radiusMeters: integer('radius_meters').notNull().default(50),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 8. Employees (Managers & Staff)
export const employees = pgTable('employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  premisesId: uuid('premises_id').references(() => premises.id, { onDelete: 'set null' }),
  role: employeeRoleEnum('role').notNull().default('STAFF'),
  employeeCode: text('employee_code').notNull(),
  name: text('name').notNull(),
  department: text('department'),
  designation: text('designation'),
  hireDate: date('hire_date').notNull(),
  terminationDate: date('termination_date'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('org_employee_code_idx').on(table.organizationId, table.employeeCode),
  index('org_employees_user_idx').on(table.organizationId, table.userId),
]);

// 9. Multi-Pose 3D Face Vector Templates
export const multiPoseFaceTemplates = pgTable('multi_pose_face_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => employees.id, { onDelete: 'cascade' })
    .unique(),
  centerVector: vector128('center_vector').notNull(),
  leftVector: vector128('left_vector').notNull(),
  rightVector: vector128('right_vector').notNull(),
  upVector: vector128('up_vector').notNull(),
  downVector: vector128('down_vector').notNull(),
  modelVersion: text('model_version').notNull().default('sface-yunet-v1'),
  qualityScore: numeric('quality_score', { precision: 4, scale: 3 }).default('0.950'),
  livenessScore: numeric('liveness_score', { precision: 4, scale: 3 }),
  passiveLivenessScore: numeric('passive_liveness_score', { precision: 4, scale: 3 }),
  enrolledByUserId: uuid('enrolled_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  enrolledAtPremisesId: uuid('enrolled_at_premises_id').references(() => premises.id, {
    onDelete: 'set null',
  }),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  index('idx_hnsw_center_vec').using('hnsw', table.centerVector.op('vector_cosine_ops')),
  index('idx_hnsw_left_vec').using('hnsw', table.leftVector.op('vector_cosine_ops')),
  index('idx_hnsw_right_vec').using('hnsw', table.rightVector.op('vector_cosine_ops')),
  index('idx_hnsw_up_vec').using('hnsw', table.upVector.op('vector_cosine_ops')),
  index('idx_hnsw_down_vec').using('hnsw', table.downVector.op('vector_cosine_ops')),
]);

// 10. Shifts
export const shifts = pgTable('shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  premisesId: uuid('premises_id').notNull().references(() => premises.id, { onDelete: 'cascade' }),
  shiftName: text('shift_name').notNull(),
  dayName: text('day_name').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  halfDayThreshold: time('half_day_threshold').notNull().default('11:00:00'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 11. Employee Shift Assignments
export const employeeShiftAssignments = pgTable('employee_shift_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  premisesId: uuid('premises_id').notNull().references(() => premises.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  shiftId: uuid('shift_id').notNull().references(() => shifts.id, { onDelete: 'cascade' }),
  absentPay: numeric('absent_pay', { precision: 12, scale: 2 }).notNull().default('0.00'),
  presentPay: numeric('present_pay', { precision: 12, scale: 2 }).notNull().default('0.00'),
  leavePay: numeric('leave_pay', { precision: 12, scale: 2 }).notNull().default('0.00'),
  halfDayPay: numeric('half_day_pay', { precision: 12, scale: 2 }).notNull().default('0.00'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('emp_shift_assign_active_uniq_idx').on(table.employeeId, table.premisesId, table.shiftId, table.isActive),
]);

// 12. Daily Attendance
export const dailyAttendance = pgTable('daily_attendance', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  premisesId: uuid('premises_id').notNull().references(() => premises.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  shiftAssignmentId: uuid('shift_assignment_id').notNull().references(() => employeeShiftAssignments.id, { onDelete: 'cascade' }),
  workDate: date('work_date').notNull(),
  attendanceStatus: attendanceStatusEnum('attendance_status').notNull().default('ABSENT'),
  clockInAt: timestamp('clock_in_at', { withTimezone: true }),
  clockOutAt: timestamp('clock_out_at', { withTimezone: true }),
  insidePingCount: integer('inside_ping_count').notNull().default(0),
  outsidePingCount: integer('outside_ping_count').notNull().default(0),
  paymentAmount: numeric('payment_amount', { precision: 12, scale: 2 }).notNull().default('0.00'),
  statusUpdatedBy: uuid('status_updated_by').references(() => users.id, { onDelete: 'set null' }),
  remarks: text('remarks'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('daily_attendance_assignment_workdate_idx').on(table.shiftAssignmentId, table.workDate),
  index('daily_attendance_org_premises_idx').on(table.organizationId, table.premisesId),
  index('daily_attendance_emp_workdate_idx').on(table.employeeId, table.workDate),
]);

// 13. Attendance Events
export const attendanceEvents = pgTable('attendance_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  shiftAssignmentId: uuid('shift_assignment_id').references(() => employeeShiftAssignments.id),
  clockIn: timestamp('clock_in', { withTimezone: true }),
  clockOut: timestamp('clock_out', { withTimezone: true }),
  status: attendanceStatusEnum('status').notNull().default('SCHEDULED'),
  faceVerified: boolean('face_verified').notNull().default(false),
  geofenceVerified: boolean('geofence_verified').notNull().default(false),
  workDate: date('work_date'),
  scheduledMinutes: integer('scheduled_minutes').notNull().default(0),
  workedMinutes: integer('worked_minutes').notNull().default(0),
  overtimeMinutes: integer('overtime_minutes').notNull().default(0),
  earlyDeparture: boolean('early_departure').notNull().default(false),
  faceScore: numeric('face_score', { precision: 5, scale: 4 }),
  premisesId: uuid('premises_id').references(() => premises.id),
  overtimeId: uuid('overtime_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('attendance_events_emp_workdate_idx').on(table.employeeId, table.workDate),
  index('attendance_events_overtime_idx').on(table.overtimeId),
]);

// 14. Location Monitoring Sessions
export const locationMonitoringSessions = pgTable('location_monitoring_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  attendanceEventId: uuid('attendance_event_id').notNull().references(() => attendanceEvents.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
});

// 15. Location Check Events
export const locationCheckEvents = pgTable('location_check_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => locationMonitoringSessions.id, { onDelete: 'cascade' }),
  checkTime: timestamp('check_time', { withTimezone: true }).notNull().defaultNow(),
  latitude: numeric('latitude', { precision: 10, scale: 7 }).notNull(),
  longitude: numeric('longitude', { precision: 10, scale: 7 }).notNull(),
  accuracyMeters: numeric('accuracy_meters', { precision: 6, scale: 2 }).notNull(),
  result: locationCheckResultEnum('result').notNull(),
});

// 16. Monthly Attendance Statistics
export const monthlyAttendanceStats = pgTable('monthly_attendance_stats', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  premisesId: uuid('premises_id').notNull().references(() => premises.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  month: integer('month').notNull(),
  year: integer('year').notNull(),
  presentShiftsCount: integer('present_shifts_count').notNull().default(0),
  absentShiftsCount: integer('absent_shifts_count').notNull().default(0),
  leaveShiftsCount: integer('leave_shifts_count').notNull().default(0),
  halfDayShiftsCount: integer('half_day_shifts_count').notNull().default(0),
  holidayCount: integer('holiday_count').notNull().default(0),
  offDayCount: integer('off_day_count').notNull().default(0),
  overtimeCount: integer('overtime_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('monthly_att_stats_uniq_idx').on(
    table.organizationId, table.premisesId, table.employeeId, table.month, table.year
  ),
  index('monthly_att_stats_org_emp_idx').on(table.organizationId, table.employeeId),
]);

// 17. Monthly Payrolls
export const monthlyPayrolls = pgTable('monthly_payrolls', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  premisesId: uuid('premises_id').notNull().references(() => premises.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  month: integer('month').notNull(),
  year: integer('year').notNull(),
  earnedAmount: numeric('earned_amount', { precision: 12, scale: 2 }).notNull().default('0.00'),
  deductionAmount: numeric('deduction_amount', { precision: 12, scale: 2 }).notNull().default('0.00'),
  paidAmount: numeric('paid_amount', { precision: 12, scale: 2 }).notNull().default('0.00'),
  dueAmount: numeric('due_amount', { precision: 12, scale: 2 }).notNull().default('0.00'),
  status: monthlyPayrollStatusEnum('status').notNull().default('OPEN'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('monthly_payrolls_uniq_idx').on(
    table.organizationId, table.premisesId, table.employeeId, table.month, table.year
  ),
  index('monthly_payrolls_org_emp_idx').on(table.organizationId, table.employeeId),
]);

// 18. Staff Earning Ledger
export const staffEarningLedger = pgTable('staff_earning_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  premisesId: uuid('premises_id').notNull().references(() => premises.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  earningDate: date('earning_date').notNull(),
  type: earningTypeEnum('type').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull().default('0.00'),
  shiftAssignmentId: uuid('shift_assignment_id').references(() => employeeShiftAssignments.id, { onDelete: 'set null' }),
  attendanceEventId: uuid('attendance_event_id').references(() => attendanceEvents.id, { onDelete: 'set null' }),
  overtimeId: uuid('overtime_id').references(() => overtime.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('staff_earning_ledger_date_idx').on(table.organizationId, table.premisesId, table.employeeId, table.earningDate),
  index('staff_earning_ledger_emp_date_idx').on(table.employeeId, table.earningDate),
  index('staff_earning_ledger_att_event_idx').on(table.attendanceEventId),
  index('staff_earning_ledger_overtime_idx').on(table.overtimeId),
]);

// 19. Payroll Deductions
export const payrollDeductions = pgTable('payroll_deductions', {
  id: uuid('id').primaryKey().defaultRandom(),
  monthlyPayrollId: uuid('monthly_payroll_id').notNull().references(() => monthlyPayrolls.id, { onDelete: 'cascade' }),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  reason: text('reason').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 20. Payroll Transactions
export const payrollTransactions = pgTable('payroll_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  monthlyPayrollId: uuid('monthly_payroll_id').notNull().references(() => monthlyPayrolls.id, { onDelete: 'cascade' }),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  paymentDate: date('payment_date').notNull(),
  paymentMethod: text('payment_method').notNull().default('MANUAL_BANK_TRANSFER'),
  reference: text('reference'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 21. Holiday Calendars
export const holidayCalendars = pgTable('holiday_calendars', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  date: date('date').notNull(),
  isPaid: boolean('is_paid').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('holiday_org_date_idx').on(table.organizationId, table.date),
]);

// 22. Weekly Offs
export const weeklyOffs = pgTable('weekly_offs', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  dayOfWeek: integer('day_of_week').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('weekly_off_emp_day_idx').on(table.employeeId, table.dayOfWeek),
]);

// 23. Unworked Payment Rules
export const unworkedPaymentRules = pgTable('unworked_payment_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'cascade' }),
  dayType: unworkedDayTypeEnum('day_type').notNull(),
  paymentCents: bigint('payment_cents', { mode: 'number' }).notNull().default(0),
  multiplierBasisPoints: integer('multiplier_basis_points').notNull().default(15000),
  effectiveFrom: date('effective_from').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('unworked_payment_rules_org_idx').on(table.organizationId),
  index('unworked_payment_rules_emp_idx').on(table.employeeId, table.effectiveFrom),
]);

// 24. Leave Requests
export const leaveRequests = pgTable('leave_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  shiftAssignmentId: uuid('shift_assignment_id').references(() => employeeShiftAssignments.id, { onDelete: 'set null' }),
  shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'set null' }),
  shiftName: text('shift_name'),
  requestedBy: uuid('requested_by').notNull().references(() => users.id),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  type: leaveTypeEnum('type').notNull().default('PAID'),
  status: leaveStatusEnum('status').notNull().default('PENDING'),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  reason: text('reason').notNull(),
  reviewNote: text('review_note'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('leave_requests_org_status_idx').on(table.organizationId, table.status),
  index('leave_requests_emp_idx').on(table.employeeId, table.startDate),
]);

// 25. Overtime
export const overtime = pgTable('overtime', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  requestedBy: uuid('requested_by').notNull().references(() => users.id),
  approvedBy: uuid('approved_by').references(() => users.id),
  workDate: date('work_date').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  plannedMinutes: integer('planned_minutes').notNull(),
  workedMinutes: integer('worked_minutes').notNull().default(0),
  paymentCents: bigint('payment_cents', { mode: 'number' }).notNull(),
  status: overtimeStatusEnum('status').notNull().default('REQUESTED'),
  reason: text('reason'),
  attendanceEventId: uuid('attendance_event_id').references(() => attendanceEvents.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('overtime_org_date_idx').on(table.organizationId, table.workDate),
  index('overtime_emp_idx').on(table.employeeId, table.workDate),
  index('overtime_status_idx').on(table.organizationId, table.status),
]);

export const overtimeRequests = overtime;

// 26. Clock Nonces
export const clockNonces = pgTable('clock_nonces', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  nonce: text('nonce').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('clock_nonces_nonce_idx').on(table.nonce),
  index('clock_nonces_emp_idx').on(table.employeeId),
]);

// 27. Audit Logs
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').references(() => users.id),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: uuid('resource_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('audit_logs_org_created_idx').on(table.organizationId, table.createdAt),
]);
