CREATE TYPE "public"."employment_status" AS ENUM('ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED');--> statement-breakpoint
CREATE TYPE "public"."leave_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."leave_type" AS ENUM('PAID', 'UNPAID', 'SICK');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('SHIFT_ASSIGNED', 'GPS_FAILURE_ALERT', 'GPS_RECOVERED', 'ATTENDANCE_EXCEPTION', 'CORRECTION_RESOLVED', 'LEAVE_REQUESTED', 'LEAVE_APPROVED', 'LEAVE_REJECTED', 'WALLET_UPDATED', 'PAYROLL_READY', 'PAYROLL_APPROVED', 'PAYROLL_PAID');--> statement-breakpoint
CREATE TYPE "public"."wallet_bucket" AS ENUM('EARNED', 'APPROVED_UNPAID', 'PAID');--> statement-breakpoint
CREATE TABLE "clock_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employment_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"status" "employment_status" DEFAULT 'ACTIVE' NOT NULL,
	"designation" text,
	"department" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holiday_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"is_paid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"type" "leave_type" DEFAULT 'PAID' NOT NULL,
	"status" "leave_status" DEFAULT 'PENDING' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text NOT NULL,
	"review_note" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"dedupe_key" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_rate_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"compensation_type" "compensation_type" NOT NULL,
	"base_rate_cents" bigint NOT NULL,
	"overtime_rate_cents" bigint DEFAULT 0 NOT NULL,
	"holiday_multiplier_basis_points" integer DEFAULT 15000 NOT NULL,
	"off_day_multiplier_basis_points" integer DEFAULT 15000 NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_offs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "work_date" date;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "scheduled_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "worked_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "overtime_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "early_departure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "face_score" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "premises_id" uuid;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "breakdown" jsonb DEFAULT '{"earnings":[],"deductions":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "attendance_summary" jsonb DEFAULT '{"totalDays":0,"presentDays":0,"lateDays":0,"halfDays":0,"absentDays":0,"leaveDays":0,"unpaidLeaveDays":0,"holidayDays":0,"offDayWorkDays":0,"totalWorkedMinutes":0,"totalOvertimeMinutes":0}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "salary_structures" ADD COLUMN "holiday_multiplier_basis_points" integer DEFAULT 15000 NOT NULL;--> statement-breakpoint
ALTER TABLE "salary_structures" ADD COLUMN "off_day_multiplier_basis_points" integer DEFAULT 15000 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "balance_bucket" "wallet_bucket" DEFAULT 'EARNED' NOT NULL;--> statement-breakpoint
ALTER TABLE "clock_nonces" ADD CONSTRAINT "clock_nonces_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday_calendars" ADD CONSTRAINT "holiday_calendars_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_rate_history" ADD CONSTRAINT "salary_rate_history_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_offs" ADD CONSTRAINT "weekly_offs_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clock_nonces_nonce_idx" ON "clock_nonces" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "clock_nonces_profile_idx" ON "clock_nonces" USING btree ("staff_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_org_date_idx" ON "holiday_calendars" USING btree ("organization_id","date");--> statement-breakpoint
CREATE INDEX "leave_requests_org_status_idx" ON "leave_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "leave_requests_staff_idx" ON "leave_requests" USING btree ("staff_profile_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_idx" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "salary_rate_history_profile_effective_idx" ON "salary_rate_history" USING btree ("staff_profile_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_off_staff_day_idx" ON "weekly_offs" USING btree ("staff_profile_id","day_of_week");--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_events_profile_workdate_idx" ON "attendance_events" USING btree ("staff_profile_id","work_date");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "invitations_org_email_idx" ON "invitations" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "salary_structures_profile_effective_idx" ON "salary_structures" USING btree ("staff_profile_id","effective_from");--> statement-breakpoint
CREATE INDEX "wallet_tx_wallet_bucket_idx" ON "wallet_transactions" USING btree ("wallet_id","balance_bucket");