-- pgvector is required for the five vector(128) columns and their HNSW indexes.
-- Install it in the target PostgreSQL instance before running this migration:
--   CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "multi_pose_face_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"staff_profile_id" uuid NOT NULL,
	"center_vector" vector(128) NOT NULL,
	"left_vector" vector(128) NOT NULL,
	"right_vector" vector(128) NOT NULL,
	"up_vector" vector(128) NOT NULL,
	"down_vector" vector(128) NOT NULL,
	"model_version" text DEFAULT 'sface-yunet-v1' NOT NULL,
	"quality_score" numeric(4, 3) DEFAULT '0.950',
	"liveness_score" numeric(4, 3),
	"passive_liveness_score" numeric(4, 3),
	"enrolled_by_user_id" uuid,
	"enrolled_at_premises_id" uuid,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "multi_pose_face_templates_staff_profile_id_unique" UNIQUE("staff_profile_id")
);
--> statement-breakpoint
ALTER TABLE "face_templates" ALTER COLUMN "model_version" SET DEFAULT 'sface-yunet-v1';--> statement-breakpoint
ALTER TABLE "multi_pose_face_templates" ADD CONSTRAINT "multi_pose_face_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_pose_face_templates" ADD CONSTRAINT "multi_pose_face_templates_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_pose_face_templates" ADD CONSTRAINT "multi_pose_face_templates_enrolled_by_user_id_users_id_fk" FOREIGN KEY ("enrolled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_pose_face_templates" ADD CONSTRAINT "multi_pose_face_templates_enrolled_at_premises_id_premises_id_fk" FOREIGN KEY ("enrolled_at_premises_id") REFERENCES "public"."premises"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hnsw_center_vec" ON "multi_pose_face_templates" USING hnsw ("center_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_hnsw_left_vec" ON "multi_pose_face_templates" USING hnsw ("left_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_hnsw_right_vec" ON "multi_pose_face_templates" USING hnsw ("right_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_hnsw_up_vec" ON "multi_pose_face_templates" USING hnsw ("up_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_hnsw_down_vec" ON "multi_pose_face_templates" USING hnsw ("down_vector" vector_cosine_ops);