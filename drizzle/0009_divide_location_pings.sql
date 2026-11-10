CREATE TABLE IF NOT EXISTS "shift_location_pings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_attendance_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"accuracy_meters" numeric(6, 2),
	"result" "location_check_result" NOT NULL,
	"client_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "overtime_location_pings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"overtime_attendance_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"accuracy_meters" numeric(6, 2),
	"result" "location_check_result" NOT NULL,
	"client_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shift_location_pings" ADD CONSTRAINT "shift_location_pings_shift_attendance_id_employee_shift_attendance_id_fk" FOREIGN KEY ("shift_attendance_id") REFERENCES "public"."employee_shift_attendance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_location_pings" ADD CONSTRAINT "overtime_location_pings_overtime_attendance_id_employee_overtime_attendance_id_fk" FOREIGN KEY ("overtime_attendance_id") REFERENCES "public"."employee_overtime_attendance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shift_location_pings_request_id_idx" ON "shift_location_pings" USING btree ("shift_attendance_id","client_request_id") WHERE client_request_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shift_location_pings_checked_idx" ON "shift_location_pings" USING btree ("shift_attendance_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "overtime_location_pings_request_id_idx" ON "overtime_location_pings" USING btree ("overtime_attendance_id","client_request_id") WHERE client_request_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "overtime_location_pings_checked_idx" ON "overtime_location_pings" USING btree ("overtime_attendance_id","checked_at");--> statement-breakpoint
DROP TABLE IF EXISTS "attendance_location_pings" CASCADE;
