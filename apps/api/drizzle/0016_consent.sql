-- Explicit consent, with the date it was given (D107).
--
-- Nullable, and null is meaningful: every account that existed before this
-- column is asked once on next sign-in. A default of now() would have recorded
-- consent nobody gave, which is the exact thing this column exists to avoid.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consented_at" timestamp with time zone;
