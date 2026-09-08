-- A priority on the outbound queue (D109).
--
-- One caller uses it: the admin test mail, which now goes through the queue
-- rather than around it, so a delivered test proves the drainer works.

ALTER TABLE "outbound_email" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 10 NOT NULL;
