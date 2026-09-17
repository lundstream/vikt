/**
 * Publishes a release's Nyheter post, from a file, once (D182).
 *
 *   pnpm --filter api news:publish -- --file notes.md          # on a workstation
 *   docker exec vikt-api-1 node dist/news-publish.js --file …  # in production
 *
 * **It is built into the image** (`tsup.config.ts`), like `restore-check`,
 * because that is the only way it can run where it has to: `tsx` is a dev
 * dependency and a production image has none. The release command stopped at
 * its last step on `sh: 1: tsx: not found` the first time this ran (D183).
 *
 * The file is the post as it is pasted into Administration, Meddelanden: a
 * first-level heading is the title and everything after it is the body. That is
 * the shape `STATE.md` already writes them in, so the release command can hand
 * this the same block a person would have copied.
 *
 * ## Why a script and not the screen
 *
 * The screen is right for a notice somebody writes on the day. A release's post
 * is written days earlier, in `STATE.md`, reviewed in a pull request, and then
 * typed into a textarea by hand at the end of a deploy — which is the one step
 * of the runbook that had no evidence, no record of what was published, and no
 * way to tell a half-finished deploy from a finished one.
 *
 * ## Idempotent on the title
 *
 * A release command may be re-run after a step failed, and the post is near the
 * end, so it will be reached twice. A second run with the same title changes
 * nothing and says so. The title is the key because it is what the reader sees
 * and what the person re-running it can check: "Version 1.2.0" is either
 * announced or it is not.
 *
 * **It does not update a published post.** An announcement that changes moves
 * its `updatedAt`, which un-dismisses it for everybody who has already read it
 * (`announcement_seen`). Re-publishing edited notes would put the same news in
 * front of every reader a second time, so this refuses and names the id: an
 * edit is a decision somebody makes on the screen, where they can see what it
 * will do.
 */
import "../lib/dotenv.js";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { cliArgs } from "./args.js";
import { createDb } from "../db/index.js";
import { announcements } from "../db/schema.js";

export type NewsPost = { title: string; body: string };

/**
 * The post, out of the file.
 *
 * `# Version 1.2.0` is the title and the rest is the body. A file without a
 * heading is refused rather than guessed at: a post with no title is one nobody
 * can tell has already been published, which is the whole property below.
 */
export function parsePost(text: string): NewsPost {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((line) => /^#\s+\S/.test(line));

  if (at < 0) {
    throw new Error(
      "the file has no `# Title` line, so there is nothing to publish under and " +
        "nothing to recognise it by on a second run",
    );
  }

  const title = lines[at]!.replace(/^#\s+/, "").trim();
  const body = lines
    .slice(at + 1)
    .join("\n")
    .trim();

  if (body.length === 0) throw new Error(`"${title}" has a title and no body`);
  return { title, body };
}

const { values } = parseArgs({
  args: cliArgs(),
  options: {
    file: { type: "string" },
    mail: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.file === undefined) {
  process.stderr.write("--file is required: the Nyheter post, as markdown.\n");
  process.exitCode = 1;
} else {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write("DATABASE_URL is not set.\n");
    process.exitCode = 1;
  } else {
    const post = parsePost(readFileSync(values.file, "utf8"));
    const { db, client } = createDb(databaseUrl, { max: 1 });

    try {
      const [existing] = await db
        .select({ id: announcements.id, published: announcements.published })
        .from(announcements)
        .where(and(eq(announcements.kind, "news"), eq(announcements.title, post.title)))
        .limit(1);

      if (existing) {
        process.stdout.write(
          `already published: "${post.title}" is announcement ${existing.id}` +
            `${existing.published ? "" : " (a draft)"}, nothing written\n`,
        );
      } else {
        const [created] = await db
          .insert(announcements)
          .values({
            kind: "news",
            title: post.title,
            body: post.body,
            published: true,
            sendMail: values.mail === true,
            createdByEmail: "release",
          })
          .returning({ id: announcements.id });

        process.stdout.write(
          `published "${post.title}" as ${created!.id}, ${post.body.length} characters` +
            `${values.mail === true ? ", mailed" : ", not mailed"}\n`,
        );
      }
    } finally {
      await client.end();
    }
  }
}
