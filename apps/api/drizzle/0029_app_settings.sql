-- A small key-value table for facts the server needs to remember about itself
-- between boots (D136, amended).
--
-- The first fact is the VAPID public key this installation last ran with. Every
-- push subscription in the table is bound to the pair it was created with, so a
-- changed key means every one of them will answer 403 until the person taps the
-- switch again — and the only way to notice that at boot is to have written the
-- old one down.
--
-- Key-value rather than a column on a singleton settings table, because the
-- things that belong here are unrelated to each other and to anything a user
-- sets. `mail_settings` and `backup_settings` are configuration somebody edits
-- on a screen; this is the server's own memory, and a new entry should not be a
-- migration.
--
-- Not secrets. The public key is public by construction, and nothing private
-- goes in here: `assertProdSecrets` and the environment own those.

CREATE TABLE IF NOT EXISTS "app_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
