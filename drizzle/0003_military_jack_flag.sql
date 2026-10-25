CREATE TYPE "public"."face_enrollment_method" AS ENUM('MANAGER_SUPERVISED');--> statement-breakpoint
ALTER TABLE "overtime_requests" RENAME TO "overtime";--> statement-breakpoint
ALTER TABLE "overtime" RENAME CONSTRAINT "overtime_requests_pkey" TO "overtime_pkey";--> statement-breakpoint
ALTER TABLE "overtime" RENAME CONSTRAINT "overtime_requests_organization_id_organizations_id_fk" TO "overtime_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "overtime" RENAME CONSTRAINT "overtime_requests_staff_profile_id_staff_profiles_id_fk" TO "overtime_staff_profile_id_staff_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "overtime" RENAME CONSTRAINT "overtime_requests_requested_by_users_id_fk" TO "overtime_requested_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "overtime" RENAME CONSTRAINT "overtime_requests_approved_by_users_id_fk" TO "overtime_approved_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "overtime" RENAME CONSTRAINT "overtime_requests_attendance_event_id_attendance_events_id_fk" TO "overtime_attendance_event_id_attendance_events_id_fk";--> statement-breakpoint
ALTER INDEX "overtime_requests_org_date_idx" RENAME TO "overtime_org_date_idx";--> statement-breakpoint
ALTER INDEX "overtime_requests_staff_idx" RENAME TO "overtime_staff_idx";--> statement-breakpoint
ALTER INDEX "overtime_requests_status_idx" RENAME TO "overtime_status_idx";--> statement-breakpoint
CREATE TABLE "shift_payment_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"staff_profile_id" uuid,
	"shift_template_id" uuid,
	"attendance_status" "attendance_status" DEFAULT 'PRESENT' NOT NULL,
	"payment_cents" bigint NOT NULL,
	"penalty_cents" bigint DEFAULT 0 NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unworked_payment_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"staff_profile_id" uuid,
	"day_type" text NOT NULL,
	"payment_cents" bigint DEFAULT 0 NOT NULL,
	"multiplier_basis_points" integer DEFAULT 15000 NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "notifications" CASCADE;--> statement-breakpoint
ALTER TABLE "payroll_items" ALTER COLUMN "attendance_summary" SET DEFAULT '{"totalDays":0,"presentDays":0,"lateDays":0,"halfDays":0,"absentDays":0,"leaveDays":0,"unpaidLeaveDays":0,"paidLeaveDays":0,"holidayDays":0,"workedHolidayDays":0,"offDayWorkDays":0,"totalWorkedMinutes":0,"totalOvertimeMinutes":0}'::jsonb;--> statement-breakpoint
ALTER TABLE "face_templates" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
UPDATE "face_templates" AS ft SET "organization_id" = sp."organization_id" FROM "staff_profiles" AS sp WHERE sp."id" = ft."staff_profile_id";--> statement-breakpoint
ALTER TABLE "face_templates" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "face_templates" ADD COLUMN "enrolled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "face_templates" ADD COLUMN "enrollment_method" "face_enrollment_method" DEFAULT 'MANAGER_SUPERVISED' NOT NULL;--> statement-breakpoint
ALTER TABLE "face_templates" ADD COLUMN "enrolled_at_premises_id" uuid;--> statement-breakpoint
ALTER TABLE "face_templates" ADD COLUMN "quality_score" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "face_templates" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "face_templates" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "salary_structures" ADD COLUMN "off_day_rate_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "salary_structures" ADD COLUMN "holiday_rate_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD COLUMN "premises_id" uuid;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD COLUMN "days_of_week" text;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD COLUMN "payment_cents" bigint;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD COLUMN "premises_id" uuid;--> statement-breakpoint
ALTER TABLE "shift_payment_rules" ADD CONSTRAINT "shift_payment_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_payment_rules" ADD CONSTRAINT "shift_payment_rules_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_payment_rules" ADD CONSTRAINT "shift_payment_rules_shift_template_id_shift_templates_id_fk" FOREIGN KEY ("shift_template_id") REFERENCES "public"."shift_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unworked_payment_rules" ADD CONSTRAINT "unworked_payment_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unworked_payment_rules" ADD CONSTRAINT "unworked_payment_rules_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shift_payment_rules_org_idx" ON "shift_payment_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "shift_payment_rules_profile_idx" ON "shift_payment_rules" USING btree ("staff_profile_id","effective_from");--> statement-breakpoint
CREATE INDEX "unworked_payment_rules_org_idx" ON "unworked_payment_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "unworked_payment_rules_profile_idx" ON "unworked_payment_rules" USING btree ("staff_profile_id","effective_from");--> statement-breakpoint
ALTER TABLE "face_templates" ADD CONSTRAINT "face_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_templates" ADD CONSTRAINT "face_templates_enrolled_by_user_id_users_id_fk" FOREIGN KEY ("enrolled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_templates" ADD CONSTRAINT "face_templates_enrolled_at_premises_id_premises_id_fk" FOREIGN KEY ("enrolled_at_premises_id") REFERENCES "public"."premises"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP TYPE "public"."notification_type";