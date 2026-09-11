-- The coach's tone, chosen per account (D140).
--
-- On the profile rather than in the browser, for the reason every other
-- preference of this kind is: the person who picks a tone on the phone means it
-- on the laptop too, and the weekly review is written by a scheduler with no
-- browser to ask.
--
-- `torr` is the default because it is the voice that already existed, and a
-- setting that silently changes how something sounds for everybody who had it
-- before is a setting changing itself.
--
-- Text with a default rather than an enum: the set is closed and small, adding
-- to it means amending the decision and the phase entry, and a check constraint
-- would make that a migration as well for no gain the application does not
-- already give.

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "coach_tone" text NOT NULL DEFAULT 'torr';
