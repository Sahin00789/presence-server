CREATE TABLE "employee_shift_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"shift_assignment_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"assigned_shift_start_time" time,
	"assigned_shift_end_time" time,
	"status" "attendance_status" DEFAULT 'PRESENT' NOT NULL,
	"clock_in_at" timestamp with time zone,
	"clock_out_at" timestamp with time zone,
	"face_verified" boolean DEFAULT false NOT NULL,
	"geofence_verified" boolean DEFAULT false NOT NULL,
	"inside_ping_count" integer DEFAULT 0 NOT NULL,
	"outside_ping_count" integer DEFAULT 0 NOT NULL,
	"consecutive_ping_failures" integer DEFAULT 0 NOT NULL,
	"face_score" numeric(5, 4),
	"status_updated_by" uuid,
	"remarks" text,
	"correction_reason" text,
	"corrected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_overtime_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"premises_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"overtime_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"assigned_overtime_start_time" time,
	"assigned_overtime_end_time" time,
	"status" "attendance_status" DEFAULT 'PRESENT' NOT NULL,
	"clock_in_at" timestamp with time zone,
	"clock_out_at" timestamp with time zone,
	"face_verified" boolean DEFAULT false NOT NULL,
	"geofence_verified" boolean DEFAULT false NOT NULL,
	"inside_ping_count" integer DEFAULT 0 NOT NULL,
	"outside_ping_count" integer DEFAULT 0 NOT NULL,
	"consecutive_ping_failures" integer DEFAULT 0 NOT NULL,
	"face_score" numeric(5, 4),
	"status_updated_by" uuid,
	"remarks" text,
	"correction_reason" text,
	"corrected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE IF EXISTS "employee_attendance" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "employee_attendance" CASCADE;--> statement-breakpoint
ALTER TABLE "attendance_location_pings" DROP CONSTRAINT IF EXISTS "attendance_location_pings_attendance_id_employee_attendance_id_fk";
--> statement-breakpoint
ALTER TABLE "employee_earning_ledger" DROP CONSTRAINT IF EXISTS "employee_earning_ledger_attendance_id_employee_attendance_id_fk";
--> statement-breakpoint
ALTER TABLE "overtime" DROP CONSTRAINT IF EXISTS "overtime_attendance_id_employee_attendance_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "attendance_pings_request_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "attendance_pings_attendance_checked_idx";--> statement-breakpoint
ALTER TABLE "public"."overtime" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."overtime" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."overtime_status";--> statement-breakpoint
CREATE TYPE "public"."overtime_status" AS ENUM('CREATED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
ALTER TABLE "public"."overtime" ALTER COLUMN "status" SET DATA TYPE "public"."overtime_status" USING "status"::"public"."overtime_status";--> statement-breakpoint
ALTER TABLE "overtime" ALTER COLUMN "status" SET DEFAULT 'CREATED';--> statement-breakpoint
ALTER TABLE "attendance_location_pings" ADD COLUMN "shift_attendance_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_location_pings" ADD COLUMN "overtime_attendance_id" uuid;--> statement-breakpoint
ALTER TABLE "employee_shift_attendance" ADD CONSTRAINT "employee_shift_attendance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_attendance" ADD CONSTRAINT "employee_shift_attendance_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_attendance" ADD CONSTRAINT "employee_shift_attendance_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_attendance" ADD CONSTRAINT "employee_shift_attendance_shift_assignment_id_employee_shift_assignments_id_fk" FOREIGN KEY ("shift_assignment_id") REFERENCES "public"."employee_shift_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_attendance" ADD CONSTRAINT "employee_shift_attendance_status_updated_by_users_id_fk" FOREIGN KEY ("status_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_overtime_attendance" ADD CONSTRAINT "employee_overtime_attendance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_overtime_attendance" ADD CONSTRAINT "employee_overtime_attendance_premises_id_premises_id_fk" FOREIGN KEY ("premises_id") REFERENCES "public"."premises"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_overtime_attendance" ADD CONSTRAINT "employee_overtime_attendance_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_overtime_attendance" ADD CONSTRAINT "employee_overtime_attendance_overtime_id_overtime_id_fk" FOREIGN KEY ("overtime_id") REFERENCES "public"."overtime"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_overtime_attendance" ADD CONSTRAINT "employee_overtime_attendance_status_updated_by_users_id_fk" FOREIGN KEY ("status_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_shift_attendance_assignment_date_idx" ON "employee_shift_attendance" USING btree ("shift_assignment_id","work_date");--> statement-breakpoint
CREATE INDEX "employee_shift_attendance_org_premises_date_idx" ON "employee_shift_attendance" USING btree ("organization_id","premises_id","work_date");--> statement-breakpoint
CREATE INDEX "employee_shift_attendance_emp_date_idx" ON "employee_shift_attendance" USING btree ("employee_id","work_date");--> statement-breakpoint
CREATE INDEX "employee_shift_attendance_active_idx" ON "employee_shift_attendance" USING btree ("organization_id","status","clock_in_at");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_overtime_attendance_overtime_idx" ON "employee_overtime_attendance" USING btree ("overtime_id");--> statement-breakpoint
CREATE INDEX "employee_overtime_attendance_org_premises_date_idx" ON "employee_overtime_attendance" USING btree ("organization_id","premises_id","work_date");--> statement-breakpoint
CREATE INDEX "employee_overtime_attendance_emp_date_idx" ON "employee_overtime_attendance" USING btree ("employee_id","work_date");--> statement-breakpoint
CREATE INDEX "employee_overtime_attendance_active_idx" ON "employee_overtime_attendance" USING btree ("organization_id","status","clock_in_at");--> statement-breakpoint
ALTER TABLE "attendance_location_pings" ADD CONSTRAINT "attendance_location_pings_shift_attendance_id_employee_shift_attendance_id_fk" FOREIGN KEY ("shift_attendance_id") REFERENCES "public"."employee_shift_attendance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_location_pings" ADD CONSTRAINT "attendance_location_pings_overtime_attendance_id_employee_overtime_attendance_id_fk" FOREIGN KEY ("overtime_attendance_id") REFERENCES "public"."employee_overtime_attendance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_earning_ledger" ADD CONSTRAINT "employee_earning_ledger_attendance_id_employee_shift_attendance_id_fk" FOREIGN KEY ("attendance_id") REFERENCES "public"."employee_shift_attendance"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime" ADD CONSTRAINT "overtime_attendance_id_employee_shift_attendance_id_fk" FOREIGN KEY ("attendance_id") REFERENCES "public"."employee_shift_attendance"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_pings_shift_request_id_idx" ON "attendance_location_pings" USING btree ("shift_attendance_id","client_request_id") WHERE client_request_id IS NOT NULL AND shift_attendance_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_pings_overtime_request_id_idx" ON "attendance_location_pings" USING btree ("overtime_attendance_id","client_request_id") WHERE client_request_id IS NOT NULL AND overtime_attendance_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "attendance_pings_shift_checked_idx" ON "attendance_location_pings" USING btree ("shift_attendance_id","checked_at");--> statement-breakpoint
CREATE INDEX "attendance_pings_overtime_checked_idx" ON "attendance_location_pings" USING btree ("overtime_attendance_id","checked_at");--> statement-breakpoint
ALTER TABLE "attendance_location_pings" DROP COLUMN "attendance_id";--> statement-breakpoint
ALTER TABLE "attendance_location_pings" ADD CONSTRAINT "attendance_pings_reference_check" CHECK ((shift_attendance_id IS NOT NULL AND overtime_attendance_id IS NULL)
      OR (overtime_attendance_id IS NOT NULL AND shift_attendance_id IS NULL));--> statement-breakpoint
DROP TYPE IF EXISTS "public"."face_enrollment_method";