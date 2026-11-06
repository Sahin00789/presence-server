-- Align the legacy role enums with the current domain model.
-- The initial migration created "role" as ('OWNER','MANAGER','STAFF') and
-- "employee_role" as ('MANAGER','STAFF'), but the application only supports
-- OWNER and EMPLOYEE. Existing legacy rows are normalized to EMPLOYEE.

ALTER TYPE "public"."face_enrollment_method" ADD VALUE IF NOT EXISTS 'OWNER_SUPERVISED' BEFORE 'MANAGER_SUPERVISED';--> statement-breakpoint

ALTER TABLE "public"."employees" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."employees" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
UPDATE "public"."employees" SET "role" = 'EMPLOYEE';--> statement-breakpoint
DROP TYPE "public"."employee_role";--> statement-breakpoint
CREATE TYPE "public"."employee_role" AS ENUM('EMPLOYEE');--> statement-breakpoint
ALTER TABLE "public"."employees" ALTER COLUMN "role" SET DATA TYPE "public"."employee_role" USING "role"::"public"."employee_role";--> statement-breakpoint
ALTER TABLE "public"."employees" ALTER COLUMN "role" SET DEFAULT 'EMPLOYEE';--> statement-breakpoint

ALTER TABLE "public"."otp_requests" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."otp_requests" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
UPDATE "public"."otp_requests" SET "role" = CASE WHEN "role" = 'OWNER' THEN 'OWNER' ELSE 'EMPLOYEE' END;--> statement-breakpoint
DROP TYPE "public"."role";--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('OWNER', 'EMPLOYEE');--> statement-breakpoint
ALTER TABLE "public"."otp_requests" ALTER COLUMN "role" SET DATA TYPE "public"."role" USING "role"::"public"."role";--> statement-breakpoint
ALTER TABLE "public"."otp_requests" ALTER COLUMN "role" SET DEFAULT 'EMPLOYEE';
