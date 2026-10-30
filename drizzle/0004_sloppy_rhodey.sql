ALTER TABLE "logged_devices" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '90 days';--> statement-breakpoint
-- Existing active sessions get the new 3-month lifetime from the deployment time.
UPDATE "logged_devices" SET "expires_at" = now() + interval '90 days' WHERE "is_active" = true;
