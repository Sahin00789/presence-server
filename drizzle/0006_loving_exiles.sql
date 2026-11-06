-- Consolidate the remaining schema drift that was applied directly via drizzle-kit push.
-- Kept idempotent so it can also be applied to existing databases.

ALTER TABLE "audit_logs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "monthly_attendance_stats" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payroll_deductions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "audit_logs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "monthly_attendance_stats" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "payroll_deductions" CASCADE;--> statement-breakpoint

UPDATE "public"."holiday_calendars" hc
SET "premises_id" = p."id"
FROM "public"."premises" p
WHERE hc."premises_id" IS NULL AND p."organization_id" = hc."organization_id";--> statement-breakpoint
ALTER TABLE "public"."holiday_calendars" ALTER COLUMN "premises_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holiday_premises_date_idx" ON "public"."holiday_calendars" USING btree ("premises_id","date");--> statement-breakpoint

ALTER TABLE "public"."logged_devices" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '90 days';--> statement-breakpoint
ALTER TABLE "public"."leave_requests" DROP COLUMN IF EXISTS "type";--> statement-breakpoint
ALTER TABLE "public"."monthly_payrolls" DROP COLUMN IF EXISTS "deduction_amount";--> statement-breakpoint

ALTER TABLE "public"."employee_attendance" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."employee_attendance" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
UPDATE "public"."employee_attendance"
SET "status" = CASE "status"
  WHEN 'SCHEDULED' THEN 'PRESENT'
  WHEN 'LATE' THEN 'PRESENT'
  WHEN 'HOLIDAY' THEN 'LEAVE'
  WHEN 'WEEKLY_OFF' THEN 'LEAVE'
  ELSE "status"
END;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."attendance_status";--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE');--> statement-breakpoint
ALTER TABLE "public"."employee_attendance" ALTER COLUMN "status" SET DATA TYPE "public"."attendance_status" USING "status"::"public"."attendance_status";--> statement-breakpoint
ALTER TABLE "public"."employee_attendance" ALTER COLUMN "status" SET DEFAULT 'PRESENT';--> statement-breakpoint

ALTER TABLE "public"."unworked_payment_rules" ALTER COLUMN "day_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."unworked_payment_rules" ALTER COLUMN "day_type" SET DATA TYPE text;--> statement-breakpoint
UPDATE "public"."unworked_payment_rules" SET "day_type" = 'HOLIDAY' WHERE "day_type" = 'PAID_LEAVE';--> statement-breakpoint
DROP TYPE IF EXISTS "public"."unworked_day_type";--> statement-breakpoint
CREATE TYPE "public"."unworked_day_type" AS ENUM('HOLIDAY', 'WEEKLY_OFF');--> statement-breakpoint
ALTER TABLE "public"."unworked_payment_rules" ALTER COLUMN "day_type" SET DATA TYPE "public"."unworked_day_type" USING "day_type"::"public"."unworked_day_type";--> statement-breakpoint

DROP TYPE IF EXISTS "public"."leave_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."wallet_bucket";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."wallet_transaction_type";
