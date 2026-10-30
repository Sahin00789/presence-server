ALTER TABLE "logged_devices" ADD COLUMN "previous_refresh_token_hash" text;--> statement-breakpoint
ALTER TABLE "logged_devices" ADD COLUMN "previous_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "logged_devices" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "logged_devices" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
CREATE INDEX "logged_devices_refresh_hash_idx" ON "logged_devices" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "logged_devices_previous_refresh_hash_idx" ON "logged_devices" USING btree ("previous_refresh_token_hash");