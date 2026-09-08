ALTER TABLE "milestones" ADD COLUMN "celebrated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "sober_assume_unlogged_dry" boolean DEFAULT false NOT NULL;