CREATE TYPE "public"."savings_cadence" AS ENUM('every_day', 'weekday', 'weekend_day', 'per_event');--> statement-breakpoint
CREATE TYPE "public"."food_source" AS ENUM('openfoodfacts', 'livsmedelsverket', 'manual', 'llm_estimate');--> statement-breakpoint
CREATE TYPE "public"."llm_job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."meal_slot" AS ENUM('breakfast', 'lunch', 'dinner', 'snack');--> statement-breakpoint
CREATE TYPE "public"."milestone_metric" AS ENUM('weight_kg', 'waist_cm', 'chest_cm', 'whtr', 'log_streak_days', 'sober_days');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."sex" AS ENUM('male', 'female', 'unspecified');--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_uuid" uuid NOT NULL,
	"local_date" date NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activity_type" text NOT NULL,
	"duration_min" integer NOT NULL,
	"intensity" smallint,
	"met_value" numeric(4, 2),
	"kcal_estimate" integer,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "daily_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_uuid" uuid NOT NULL,
	"local_date" date NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sweat" smallint,
	"energy" smallint,
	"mood" smallint,
	"hunger" smallint,
	"sleep_hours" numeric(3, 1),
	"steps" integer,
	"alcohol_units" numeric(4, 1),
	"note" text
);
--> statement-breakpoint
CREATE TABLE "food_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_uuid" uuid NOT NULL,
	"local_date" date NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meal_slot" "meal_slot" DEFAULT 'snack' NOT NULL,
	"food_item_id" uuid,
	"freetext" text,
	"grams" numeric(7, 1) NOT NULL,
	"kcal" numeric(7, 1) NOT NULL,
	"protein_g" numeric(6, 1),
	"carbs_g" numeric(6, 1),
	"fat_g" numeric(6, 1),
	"fiber_g" numeric(6, 1),
	"confidence" numeric(3, 2) DEFAULT '1.00' NOT NULL,
	"confirmed" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "food_source" NOT NULL,
	"source_ref" text,
	"barcode" text,
	"name" text NOT NULL,
	"brand" text,
	"created_by" uuid,
	"kcal_per_100" numeric(7, 2) NOT NULL,
	"protein_per_100" numeric(6, 2),
	"carbs_per_100" numeric(6, 2),
	"fat_per_100" numeric(6, 2),
	"fiber_per_100" numeric(6, 2),
	"salt_per_100" numeric(6, 2),
	"serving_hints" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"invite_code" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"code" text PRIMARY KEY NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"used_by" uuid,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" "llm_job_status" DEFAULT 'queued' NOT NULL,
	"model" text,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "manual_intake" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_uuid" uuid NOT NULL,
	"local_date" date NOT NULL,
	"kcal" integer NOT NULL,
	"protein_g" integer,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "meal_template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"food_item_id" uuid,
	"freetext" text,
	"grams" numeric(7, 1) NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meal_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_meal_slot" "meal_slot",
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measurement_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_uuid" uuid NOT NULL,
	"local_date" date NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"waist_cm" numeric(5, 1),
	"chest_cm" numeric(5, 1),
	"neck_cm" numeric(5, 1),
	"hips_cm" numeric(5, 1),
	"thigh_cm" numeric(5, 1),
	"arm_cm" numeric(5, 1),
	"note" text
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"metric" "milestone_metric" NOT NULL,
	"target_value" numeric(8, 2) NOT NULL,
	"reward_text" text,
	"reward_cost_sek" numeric(10, 2),
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"achieved_at" timestamp with time zone,
	"achieved_value" numeric(8, 2),
	"reward_claimed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"storage_path" text NOT NULL,
	"thumb_path" text,
	"pose" text,
	"weight_kg_at_capture" numeric(5, 2),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "plan_status" DEFAULT 'active' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"start_weight_kg" numeric(5, 2),
	"goal_weight_kg" numeric(5, 2),
	"target_intake_kcal" integer NOT NULL,
	"target_rate_kg_week" numeric(4, 2),
	"protein_floor_g" integer,
	"intake_floor_kcal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"height_cm" numeric(5, 1) NOT NULL,
	"birth_date" date,
	"sex" "sex" DEFAULT 'unspecified' NOT NULL,
	"timezone" text DEFAULT 'Europe/Stockholm' NOT NULL,
	"locale" text DEFAULT 'sv-SE' NOT NULL,
	"activity_factor" numeric(3, 2) DEFAULT '1.35' NOT NULL,
	"add_exercise_to_target" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"label" text NOT NULL,
	"amount_sek" numeric(10, 2) NOT NULL,
	"milestone_id" uuid
);
--> statement-breakpoint
CREATE TABLE "savings_offsets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "savings_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"amount_sek" numeric(10, 2) NOT NULL,
	"cadence" "savings_cadence" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "weekly_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"stats" jsonb NOT NULL,
	"body" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weight_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_uuid" uuid NOT NULL,
	"local_date" date NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"weight_kg" numeric(5, 2) NOT NULL,
	"body_fat_pct" numeric(4, 1),
	"source" text DEFAULT 'manual' NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_log" ADD CONSTRAINT "daily_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_entries" ADD CONSTRAINT "food_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_entries" ADD CONSTRAINT "food_entries_food_item_id_food_items_id_fk" FOREIGN KEY ("food_item_id") REFERENCES "public"."food_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_items" ADD CONSTRAINT "food_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_jobs" ADD CONSTRAINT "llm_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_intake" ADD CONSTRAINT "manual_intake_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_template_items" ADD CONSTRAINT "meal_template_items_template_id_meal_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."meal_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_template_items" ADD CONSTRAINT "meal_template_items_food_item_id_food_items_id_fk" FOREIGN KEY ("food_item_id") REFERENCES "public"."food_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_templates" ADD CONSTRAINT "meal_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_log" ADD CONSTRAINT "measurement_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_events" ADD CONSTRAINT "savings_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_events" ADD CONSTRAINT "savings_events_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_offsets" ADD CONSTRAINT "savings_offsets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_offsets" ADD CONSTRAINT "savings_offsets_rule_id_savings_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."savings_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_rules" ADD CONSTRAINT "savings_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reviews" ADD CONSTRAINT "weekly_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weight_log" ADD CONSTRAINT "weight_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_log_client_key" ON "activity_log" USING btree ("user_id","client_uuid");--> statement-breakpoint
CREATE INDEX "activity_log_user_date_idx" ON "activity_log" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_key" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_log_client_key" ON "daily_log" USING btree ("user_id","client_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_log_day_key" ON "daily_log" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "food_entries_client_key" ON "food_entries" USING btree ("user_id","client_uuid");--> statement-breakpoint
CREATE INDEX "food_entries_user_date_idx" ON "food_entries" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "food_items_source_ref_key" ON "food_items" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "food_items_barcode_idx" ON "food_items" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "food_items_name_idx" ON "food_items" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_key" ON "group_members" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "llm_jobs_status_idx" ON "llm_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "manual_intake_client_key" ON "manual_intake" USING btree ("user_id","client_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "manual_intake_day_key" ON "manual_intake" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "meal_templates_user_used_idx" ON "meal_templates" USING btree ("user_id","last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_log_client_key" ON "measurement_log" USING btree ("user_id","client_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_log_day_key" ON "measurement_log" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "milestones_user_idx" ON "milestones" USING btree ("user_id","achieved_at");--> statement-breakpoint
CREATE INDEX "photos_user_date_idx" ON "photos" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "plans_user_status_idx" ON "plans" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "savings_events_user_date_idx" ON "savings_events" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "savings_offsets_key" ON "savings_offsets" USING btree ("rule_id","local_date");--> statement-breakpoint
CREATE INDEX "savings_rules_user_idx" ON "savings_rules" USING btree ("user_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_reviews_week_key" ON "weekly_reviews" USING btree ("user_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "weight_log_client_key" ON "weight_log" USING btree ("user_id","client_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "weight_log_day_key" ON "weight_log" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "weight_log_user_date_idx" ON "weight_log" USING btree ("user_id","local_date");