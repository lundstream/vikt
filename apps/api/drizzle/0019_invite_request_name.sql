-- The invite form asks who is asking (D112). Nullable: every row written
-- before the field existed has no name, and inventing one would be a lie.
ALTER TABLE "invite_requests" ADD COLUMN IF NOT EXISTS "name" text;
