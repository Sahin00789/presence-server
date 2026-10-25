CREATE TYPE "public"."overtime_status" AS ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'OVERTIME_ACCRUAL' BEFORE 'BONUS_CREDIT';--> statement-breakpoint
CREATE TABLE "overtime_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"work_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"planned_minutes" integer NOT NULL,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"payment_cents" bigint NOT NULL,
	"status" "overtime_status" DEFAULT 'REQUESTED' NOT NULL,
	"reason" text,
	"attendance_event_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "overtime_id" uuid;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_attendance_event_id_attendance_events_id_fk" FOREIGN KEY ("attendance_event_id") REFERENCES "public"."attendance_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "overtime_requests_org_date_idx" ON "overtime_requests" USING btree ("organization_id","work_date");--> statement-breakpoint
CREATE INDEX "overtime_requests_staff_idx" ON "overtime_requests" USING btree ("staff_profile_id","work_date");--> statement-breakpoint
CREATE INDEX "overtime_requests_status_idx" ON "overtime_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "attendance_events_overtime_idx" ON "attendance_events" USING btree ("overtime_id");