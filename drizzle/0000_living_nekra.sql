CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('SCHEDULED', 'PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF');--> statement-breakpoint
CREATE TYPE "public"."attendance_type" AS ENUM('SHIFT', 'OVERTIME');--> statement-breakpoint
CREATE TYPE "public"."earning_type" AS ENUM('SHIFT', 'HOLIDAY', 'OFF_DAY', 'OVERTIME');--> statement-breakpoint
CREATE TYPE "public"."employee_role" AS ENUM('MANAGER', 'STAFF');--> statement-breakpoint
CREATE TYPE "public"."face_enrollment_method" AS ENUM('MANAGER_SUPERVISED');--> statement-breakpoint
CREATE TYPE "public"."leave_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."leave_type" AS ENUM('PAID', 'UNPAID', 'SICK', 'LATE_CLOCK_IN', 'EARLY_CLOCK_OUT');--> statement-breakpoint
CREATE TYPE "public"."location_check_result" AS ENUM('IN_PREMISES', 'OUTSIDE', 'STALE', 'LOW_ACCURACY', 'MOCKED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."monthly_payroll_status" AS ENUM('OPEN', 'FINALIZED', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."overtime_status" AS ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('OWNER', 'MANAGER', 'STAFF');--> statement-breakpoint
CREATE TYPE "public"."unworked_day_type" AS ENUM('HOLIDAY', 'WEEKLY_OFF', 'PAID_LEAVE');--> statement-breakpoint
CREATE TYPE "public"."wallet_bucket" AS ENUM('PAID', 'EARNED', 'APPROVED_UNPAID');--> statement-breakpoint
CREATE TYPE "public"."wallet_transaction_type" AS ENUM('ACCRUAL', 'CREDIT', 'DISBURSEMENT', 'DEDUCTION', 'SETTLEMENT');--> statement-breakpoint
CREATE TABLE "attendance_location_pings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attendance_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"accuracy_meters" numeric(6, 2),
	"result" "location_check_result" NOT NULL,
	"client_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clock_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"shift_assignment_id" uuid,
	"overtime_id" uuid,
	"attendance_type" "attendance_type" DEFAULT 'SHIFT' NOT NULL,
	"work_date" date NOT NULL,
	"status" "attendance_status" DEFAULT 'SCHEDULED' NOT NULL,
	"clock_in_at" timestamp with time zone,
	"clock_out_at" timestamp with time zone,
	"face_verified" boolean DEFAULT false NOT NULL,
	"geofence_verified" boolean DEFAULT false NOT NULL,
	"inside_ping_count" integer DEFAULT 0 NOT NULL,
	"outside_ping_count" integer DEFAULT 0 NOT NULL,
	"consecutive_ping_failures" integer DEFAULT 0 NOT NULL,
	"last_ping_at" timestamp with time zone,
	"last_ping_result" "location_check_result",
	"last_successful_ping_at" timestamp with time zone,
	"monitoring_alert_at" timestamp with time zone,
	"face_score" numeric(5, 4),
	"scheduled_minutes" integer DEFAULT 0 NOT NULL,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"overtime_minutes" integer DEFAULT 0 NOT NULL,
	"early_departure" boolean DEFAULT false NOT NULL,
	"status_updated_by" uuid,
	"remarks" text,
	"correction_reason" text,
	"corrected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_attendance_reference_check" CHECK ((attendance_type = 'SHIFT' AND shift_assignment_id IS NOT NULL AND overtime_id IS NULL)
      OR (attendance_type = 'OVERTIME' AND overtime_id IS NOT NULL AND shift_assignment_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "employee_earning_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"earning_date" date NOT NULL,
	"type" "earning_type" NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"shift_assignment_id" uuid,
	"attendance_id" uuid,
	"overtime_id" uuid,
	"source_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_shift_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"absent_pay" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"present_pay" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"leave_pay" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"half_day_pay" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"premises_id" uuid,
	"role" "employee_role" DEFAULT 'STAFF' NOT NULL,
	"employee_code" text NOT NULL,
	"name" text NOT NULL,
	"department" text,
	"designation" text,
	"hire_date" date NOT NULL,
	"termination_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_identities_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "holiday_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"is_paid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"shift_assignment_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"type" "leave_type" DEFAULT 'PAID' NOT NULL,
	"status" "leave_status" DEFAULT 'PENDING' NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logged_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_jti" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"device_name" text,
	"device_type" text,
	"os_name" text,
	"ip_address" text,
	"user_agent" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "logged_devices_session_jti_unique" UNIQUE("session_jti")
);
--> statement-breakpoint
CREATE TABLE "monthly_attendance_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"month" integer NOT NULL,
	"year" integer NOT NULL,
	"present_shifts_count" integer DEFAULT 0 NOT NULL,
	"absent_shifts_count" integer DEFAULT 0 NOT NULL,
	"leave_shifts_count" integer DEFAULT 0 NOT NULL,
	"half_day_shifts_count" integer DEFAULT 0 NOT NULL,
	"holiday_count" integer DEFAULT 0 NOT NULL,
	"off_day_count" integer DEFAULT 0 NOT NULL,
	"overtime_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monthly_payrolls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"month" integer NOT NULL,
	"year" integer NOT NULL,
	"earned_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"deduction_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"paid_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"due_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"status" "monthly_payroll_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "multi_pose_face_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"center_vector" vector(128) NOT NULL,
	"left_vector" vector(128) NOT NULL,
	"right_vector" vector(128) NOT NULL,
	"up_vector" vector(128) NOT NULL,
	"down_vector" vector(128) NOT NULL,
	"model_version" text DEFAULT 'sface-yunet-v1' NOT NULL,
	"quality_score" numeric(4, 3) DEFAULT '0.950',
	"liveness_score" numeric(4, 3),
	"passive_liveness_score" numeric(4, 3),
	"enrolled_by_user_id" uuid,
	"enrolled_at_premises_id" uuid,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "multi_pose_face_templates_employee_id_unique" UNIQUE("employee_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" "role" DEFAULT 'STAFF' NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overtime" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"work_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"planned_minutes" integer NOT NULL,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"payment_inr" bigint NOT NULL,
	"status" "overtime_status" DEFAULT 'REQUESTED' NOT NULL,
	"reason" text,
	"attendance_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_deductions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monthly_payroll_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monthly_payroll_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"payment_date" date NOT NULL,
	"payment_method" text DEFAULT 'MANUAL_BANK_TRANSFER' NOT NULL,
	"reference" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "premises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"latitude" numeric(10, 7) NOT NULL,
	"longitude" numeric(10, 7) NOT NULL,
	"radius_meters" integer DEFAULT 50 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid NOT NULL,
	"shift_name" text NOT NULL,
	"day_name" text NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"half_day_threshold" time DEFAULT '11:00:00' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unworked_payment_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid,
	"employee_id" uuid,
	"day_type" "unworked_day_type" NOT NULL,
	"payment_inr" bigint DEFAULT 0 NOT NULL,
	"multiplier_basis_points" integer DEFAULT 15000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"full_name" text NOT NULL,
	"avatar_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"token_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "weekly_offs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_location_pings" ADD CONSTRAINT "attendance_location_pings_attendance_id_employee_attendance_id_fk" FOREIGN KEY ("attendance_id") REFERENCES "public"."employee_attendance"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_nonces" ADD CONSTRAINT "clock_nonces_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_shift_assignment_id_employee_shift_assignments_id_fk" FOREIGN KEY ("shift_assignment_id") REFERENCES "public"."employee_shift_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_status_updated_by_users_id_fk" FOREIGN KEY ("status_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_earning_ledger" ADD CONSTRAINT "employee_earning_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_earning_ledger" ADD CONSTRAINT "employee_earning_ledger_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_earning_ledger" ADD CONSTRAINT "employee_earning_ledger_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_earning_ledger" ADD CONSTRAINT "employee_earning_ledger_shift_assignment_id_employee_shift_assignments_id_fk" FOREIGN KEY ("shift_assignment_id") REFERENCES "public"."employee_shift_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_earning_ledger" ADD CONSTRAINT "employee_earning_ledger_attendance_id_employee_attendance_id_fk" FOREIGN KEY ("attendance_id") REFERENCES "public"."employee_attendance"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_earning_ledger" ADD CONSTRAINT "employee_earning_ledger_overtime_id_overtime_id_fk" FOREIGN KEY ("overtime_id") REFERENCES "public"."overtime"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_identities" ADD CONSTRAINT "google_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday_calendars" ADD CONSTRAINT "holiday_calendars_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday_calendars" ADD CONSTRAINT "holiday_calendars_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_shift_assignment_id_employee_shift_assignments_id_fk" FOREIGN KEY ("shift_assignment_id") REFERENCES "public"."employee_shift_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logged_devices" ADD CONSTRAINT "logged_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_attendance_stats" ADD CONSTRAINT "monthly_attendance_stats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_attendance_stats" ADD CONSTRAINT "monthly_attendance_stats_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_attendance_stats" ADD CONSTRAINT "monthly_attendance_stats_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_payrolls" ADD CONSTRAINT "monthly_payrolls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_payrolls" ADD CONSTRAINT "monthly_payrolls_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_payrolls" ADD CONSTRAINT "monthly_payrolls_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_pose_face_templates" ADD CONSTRAINT "multi_pose_face_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_pose_face_templates" ADD CONSTRAINT "multi_pose_face_templates_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_pose_face_templates" ADD CONSTRAINT "multi_pose_face_templates_enrolled_by_user_id_users_id_fk" FOREIGN KEY ("enrolled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_pose_face_templates" ADD CONSTRAINT "multi_pose_face_templates_enrolled_at_premises_id_premises_id_fk" FOREIGN KEY ("enrolled_at_premises_id") REFERENCES "public"."premises"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime" ADD CONSTRAINT "overtime_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime" ADD CONSTRAINT "overtime_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime" ADD CONSTRAINT "overtime_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime" ADD CONSTRAINT "overtime_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime" ADD CONSTRAINT "overtime_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime" ADD CONSTRAINT "overtime_attendance_id_employee_attendance_id_fk" FOREIGN KEY ("attendance_id") REFERENCES "public"."employee_attendance"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_monthly_payroll_id_monthly_payrolls_id_fk" FOREIGN KEY ("monthly_payroll_id") REFERENCES "public"."monthly_payrolls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_transactions" ADD CONSTRAINT "payroll_transactions_monthly_payroll_id_monthly_payrolls_id_fk" FOREIGN KEY ("monthly_payroll_id") REFERENCES "public"."monthly_payrolls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_transactions" ADD CONSTRAINT "payroll_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "premises" ADD CONSTRAINT "premises_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unworked_payment_rules" ADD CONSTRAINT "unworked_payment_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unworked_payment_rules" ADD CONSTRAINT "unworked_payment_rules_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unworked_payment_rules" ADD CONSTRAINT "unworked_payment_rules_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_offs" ADD CONSTRAINT "weekly_offs_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_pings_request_id_idx" ON "attendance_location_pings" USING btree ("attendance_id","client_request_id") WHERE client_request_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "attendance_pings_attendance_checked_idx" ON "attendance_location_pings" USING btree ("attendance_id","checked_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clock_nonces_nonce_idx" ON "clock_nonces" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "clock_nonces_emp_idx" ON "clock_nonces" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_attendance_shift_workdate_idx" ON "employee_attendance" USING btree ("shift_assignment_id","work_date") WHERE attendance_type = 'SHIFT' AND shift_assignment_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_attendance_overtime_idx" ON "employee_attendance" USING btree ("overtime_id") WHERE attendance_type = 'OVERTIME' AND overtime_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "employee_attendance_org_premises_date_idx" ON "employee_attendance" USING btree ("organization_id","premises_id","work_date");--> statement-breakpoint
CREATE INDEX "employee_attendance_emp_date_idx" ON "employee_attendance" USING btree ("employee_id","work_date");--> statement-breakpoint
CREATE INDEX "employee_attendance_active_idx" ON "employee_attendance" USING btree ("organization_id","status","clock_in_at");--> statement-breakpoint
CREATE INDEX "employee_earning_ledger_date_idx" ON "employee_earning_ledger" USING btree ("organization_id","premises_id","employee_id","earning_date");--> statement-breakpoint
CREATE INDEX "employee_earning_ledger_emp_date_idx" ON "employee_earning_ledger" USING btree ("employee_id","earning_date");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_earning_ledger_source_idx" ON "employee_earning_ledger" USING btree ("source_reference") WHERE source_reference IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_earning_ledger_attendance_type_idx" ON "employee_earning_ledger" USING btree ("attendance_id","type") WHERE attendance_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_earning_ledger_overtime_type_idx" ON "employee_earning_ledger" USING btree ("overtime_id","type") WHERE overtime_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "emp_shift_assign_active_uniq_idx" ON "employee_shift_assignments" USING btree ("employee_id","premises_id","shift_id","is_active");--> statement-breakpoint
CREATE INDEX "emp_shift_assign_org_idx" ON "employee_shift_assignments" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_employee_code_idx" ON "employees" USING btree ("organization_id","employee_code");--> statement-breakpoint
CREATE INDEX "org_employees_user_idx" ON "employees" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "employees_user_active_idx" ON "employees" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_org_premises_date_idx" ON "holiday_calendars" USING btree ("organization_id","premises_id","date");--> statement-breakpoint
CREATE INDEX "holiday_org_date_idx" ON "holiday_calendars" USING btree ("organization_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_requests_active_assignment_workdate_idx" ON "leave_requests" USING btree ("shift_assignment_id","work_date") WHERE status IN ('PENDING', 'APPROVED');--> statement-breakpoint
CREATE INDEX "leave_requests_org_premises_idx" ON "leave_requests" USING btree ("organization_id","premises_id");--> statement-breakpoint
CREATE INDEX "leave_requests_emp_workdate_idx" ON "leave_requests" USING btree ("employee_id","work_date");--> statement-breakpoint
CREATE INDEX "leave_requests_org_status_idx" ON "leave_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "logged_devices_user_active_idx" ON "logged_devices" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "logged_devices_session_jti_idx" ON "logged_devices" USING btree ("session_jti");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_att_stats_uniq_idx" ON "monthly_attendance_stats" USING btree ("organization_id","premises_id","employee_id","month","year");--> statement-breakpoint
CREATE INDEX "monthly_att_stats_org_emp_idx" ON "monthly_attendance_stats" USING btree ("organization_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_payrolls_uniq_idx" ON "monthly_payrolls" USING btree ("organization_id","premises_id","employee_id","month","year");--> statement-breakpoint
CREATE INDEX "monthly_payrolls_org_emp_idx" ON "monthly_payrolls" USING btree ("organization_id","employee_id");--> statement-breakpoint
CREATE INDEX "idx_hnsw_center_vec" ON "multi_pose_face_templates" USING hnsw ("center_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_hnsw_left_vec" ON "multi_pose_face_templates" USING hnsw ("left_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_hnsw_right_vec" ON "multi_pose_face_templates" USING hnsw ("right_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_hnsw_up_vec" ON "multi_pose_face_templates" USING hnsw ("up_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_hnsw_down_vec" ON "multi_pose_face_templates" USING hnsw ("down_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "overtime_org_date_idx" ON "overtime" USING btree ("organization_id","work_date");--> statement-breakpoint
CREATE INDEX "overtime_emp_idx" ON "overtime" USING btree ("employee_id","work_date");--> statement-breakpoint
CREATE INDEX "overtime_status_idx" ON "overtime" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "overtime_employee_date_start_idx" ON "overtime" USING btree ("employee_id","work_date","start_time");--> statement-breakpoint
CREATE INDEX "premises_org_active_idx" ON "premises" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE INDEX "shifts_org_premises_idx" ON "shifts" USING btree ("organization_id","premises_id");--> statement-breakpoint
CREATE INDEX "unworked_payment_rules_org_idx" ON "unworked_payment_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "unworked_payment_rules_emp_idx" ON "unworked_payment_rules" USING btree ("employee_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_off_emp_day_idx" ON "weekly_offs" USING btree ("employee_id","day_of_week");