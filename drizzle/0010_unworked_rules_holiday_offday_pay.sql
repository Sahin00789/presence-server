ALTER TABLE "public"."unworked_payment_rules" ADD COLUMN IF NOT EXISTS "holiday_pay" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "public"."unworked_payment_rules" ADD COLUMN IF NOT EXISTS "off_day_pay" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "public"."unworked_payment_rules" SET "holiday_pay" = "payment_inr" WHERE "day_type" = 'HOLIDAY' AND "holiday_pay" = 0;--> statement-breakpoint
UPDATE "public"."unworked_payment_rules" SET "off_day_pay" = "payment_inr" WHERE "day_type" = 'WEEKLY_OFF' AND "off_day_pay" = 0;
