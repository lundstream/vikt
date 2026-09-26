-- The label photo (Phase 14, D190).
--
-- A food transcribed from a photographed nutrition declaration is an ordinary
-- private food with its own source, so the screens can say "från etikett" and
-- nothing else has to. Additive: one value on an enum. Postgres allows adding
-- an enum value inside the migration's transaction; the value is used only by
-- requests, after the transaction has committed.

ALTER TYPE "food_source" ADD VALUE IF NOT EXISTS 'label_photo';
