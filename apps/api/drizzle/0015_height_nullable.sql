-- Height leaves registration and becomes optional (D105).
--
-- Additive in the sense that matters: dropping NOT NULL never fails and never
-- loses a row. Every existing profile keeps the height it has.

ALTER TABLE "profiles" ALTER COLUMN "height_cm" DROP NOT NULL;
