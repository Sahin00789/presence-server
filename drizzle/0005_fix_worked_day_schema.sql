CREATE TYPE "public"."shift_payment_status" AS ENUM('PRESENT', 'LATE', 'HALF_DAY', 'ABSENT');--> statement-breakpoint
CREATE TYPE "public"."unworked_day_type" AS ENUM('HOLIDAY', 'WEEKLY_OFF', 'PAID_LEAVE');--> statement-breakpoint
UPDATE "attendance_events" SET "status" = 'PRESENT' WHERE "status"::text IN ('WORKED_HOLIDAY', 'WORKED_OFF_DAY');--> statement-breakpoint
UPDATE "attendance_corrections" SET "corrected_status" = 'PRESENT' WHERE "corrected_status"::text IN ('WORKED_HOLIDAY', 'WORKED_OFF_DAY');--> statement-breakpoint
UPDATE "shift_payment_rules" SET "attendance_status" = 'PRESENT' WHERE "attendance_status"::text NOT IN ('PRESENT', 'LATE', 'HALF_DAY', 'ABSENT');--> statement-breakpoint
DELETE FROM "unworked_payment_rules" WHERE "day_type"::text NOT IN ('HOLIDAY', 'WEEKLY_OFF', 'PAID_LEAVE');--> statement-breakpoint
ALTER TABLE "payroll_items" ALTER COLUMN "attendance_summary" SET DEFAULT '{"totalDays":0,"presentDays":0,"lateDays":0,"halfDays":0,"absentDays":0,"leaveDays":0,"unpaidLeaveDays":0,"paidLeaveDays":0,"holidayDays":0,"weeklyOffDays":0,"totalWorkedMinutes":0,"totalOvertimeMinutes":0}'::jsonb;--> statement-breakpoint
ALTER TABLE "shift_payment_rules" ALTER COLUMN "attendance_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shift_payment_rules" ALTER COLUMN "attendance_status" SET DATA TYPE shift_payment_status USING "attendance_status"::text::shift_payment_status;--> statement-breakpoint
ALTER TABLE "shift_payment_rules" ALTER COLUMN "attendance_status" SET DEFAULT 'PRESENT';--> statement-breakpoint
ALTER TABLE "unworked_payment_rules" ALTER COLUMN "day_type" SET DATA TYPE unworked_day_type USING "day_type"::text::unworked_day_type;--> statement-breakpoint
ALTER TABLE "salary_rate_history" DROP COLUMN "holiday_multiplier_basis_points";--> statement-breakpoint
ALTER TABLE "salary_rate_history" DROP COLUMN "off_day_multiplier_basis_points";--> statement-breakpoint
ALTER TABLE "salary_structures" DROP COLUMN "off_day_rate_cents";--> statement-breakpoint
ALTER TABLE "salary_structures" DROP COLUMN "holiday_rate_cents";--> statement-breakpoint
ALTER TABLE "salary_structures" DROP COLUMN "holiday_multiplier_basis_points";--> statement-breakpoint
ALTER TABLE "salary_structures" DROP COLUMN "off_day_multiplier_basis_points";--> statement-breakpoint
ALTER TABLE "public"."attendance_corrections" ALTER COLUMN "corrected_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "public"."attendance_events" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."attendance_events" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."attendance_status";--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('SCHEDULED', 'PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'HOLIDAY', 'WEEKLY_OFF');--> statement-breakpoint
ALTER TABLE "public"."attendance_corrections" ALTER COLUMN "corrected_status" SET DATA TYPE "public"."attendance_status" USING "corrected_status"::"public"."attendance_status";--> statement-breakpoint
ALTER TABLE "public"."attendance_events" ALTER COLUMN "status" SET DATA TYPE "public"."attendance_status" USING "status"::"public"."attendance_status";--> statement-breakpoint
ALTER TABLE "public"."attendance_events" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';
