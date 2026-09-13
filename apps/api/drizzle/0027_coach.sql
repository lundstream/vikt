-- The coach chat (D139), §6 phase 8b.
--
-- Two tables, because a conversation is a thing the user names and deletes as a
-- unit while a message is one line inside it. Both cascade from the account:
-- chat history is personal data held per user under D9, it is in the export,
-- and deleting the account takes it.
--
-- `refusal` is the column that makes the guardrail visible afterwards. When the
-- post-check refuses a reply, what is stored is the refusal and its reason, not
-- the text that was refused: keeping the violating sentence would put the one
-- thing the check exists to prevent into the history, where it would be read
-- later without the check in front of it.
--
-- `context_chars` and `reply_chars` are kept per turn because the context has
-- to fit the model variant's `num_ctx` with room for the answer, and a context
-- that grows quietly is exactly the failure this records. They are two integers
-- against a question that would otherwise be answered by guessing.

CREATE TABLE IF NOT EXISTS "coach_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- The first question, trimmed. Nobody should have to name a conversation.
  "title" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_message_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "coach_conversations_user_idx"
  ON "coach_conversations" ("user_id", "last_message_at" DESC);

CREATE TABLE IF NOT EXISTS "coach_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL
    REFERENCES "coach_conversations"("id") ON DELETE CASCADE,
  -- `user` or `coach`. Text rather than an enum: the set is two values and a
  -- migration to add a third would be worse than a check that reads as prose.
  "role" text NOT NULL,
  "body" text NOT NULL,
  -- Which model answered, so a change of model is visible in the history.
  "model" text,
  -- Why a reply was refused, when it was. Null on an ordinary turn.
  "refusal" text,
  "context_chars" integer,
  "reply_chars" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "coach_messages_conversation_idx"
  ON "coach_messages" ("user_id", "conversation_id", "created_at");

-- The dashboard shows the newest weekly review once, so it needs somewhere to
-- record that it has been seen. On the review rather than in the browser: a
-- card dismissed on the phone must stay dismissed on the laptop, which is the
-- same reason the announcement read-marks are rows (D108).
ALTER TABLE "weekly_reviews" ADD COLUMN IF NOT EXISTS "dismissed_at" timestamptz;
