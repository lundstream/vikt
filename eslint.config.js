import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import isolation from "./eslint-rules/user-id-first-param.js";
import ownership from "./eslint-rules/derived-data-owner.js";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/drizzle/**",
      "**/.vite/**",
      "apps/web/dev-dist/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },

  /**
   * Multi-user isolation (CLAUDE.md §3). Every exported function in the service
   * and repository layers takes `userId` first. The allowlists below are the
   * complete set of exemptions; each one runs before there is a session, and
   * each is explained in the file it lives in.
   */
  {
    files: ["apps/api/src/services/**/*.ts"],
    plugins: { isolation },
    rules: {
      "isolation/user-id-first-param": [
        "error",
        {
          allowUnscoped: [
            // No session exists yet at these three points, by definition.
            "register",
            "login",
            "resolveSession",
            // Operator action from the CLI, with no user to scope to.
            "mintInvite",
            /**
             * Reports whether an Ollama host is configured and answering. That
             * is server configuration, identical for every account, and it
             * reads no row of any kind. Scoping it by `userId` would suggest
             * the answer could differ per user, which is the misleading half of
             * a signature.
             */
            "llmHealth",
            /**
             * Splits a habit id out of a reminder kind string (D137). Pure
             * string work on a value the caller already holds: it reads no row,
             * touches no database and has no user to scope to. Scoping it would
             * suggest the answer could differ per account.
             */
            "habitIdOf",
            /**
             * Builds the sentence shown when the coach's own guardrail refuses
             * a reply (D139). Pure text assembly from values the caller already
             * holds: no row, no database, nothing to scope.
             */
            "refusalMessage",
            /**
             * The Monday on or before a date. Calendar arithmetic on a string;
             * whose date it is, is the caller's question.
             */
            "weekStartOf",
            /**
             * The Sunday sweep (D141), which is the same shape as `runReminders`
             * beside it: it runs for **every** account and finds whose local
             * clock has just passed Sunday at eight. Its per-user work is
             * scoped; the sweep itself has no one user to belong to.
             */
            "runWeeklyReviews",
            /**
             * Pulls the host out of a push endpoint so a removal can be logged
             * without the token in it. String work on a value the caller holds;
             * there is no row and nobody to scope to.
             */
            "hostOf",

            /**
             * Pure functions of their arguments. Neither touches the database,
             * so there is no row to scope: `isPlausibleMatch` compares two
             * strings, and `estimateDish` asks the model about a dish name and
             * returns a proposal that nothing has written yet.
             */
            "isPlausibleMatch",
            "estimateDish",

            /**
             * The invite request flow (D89) runs entirely before there is an
             * account. A visitor with no session asks for a code; an operator
             * later approves or rejects the row. `userId` does not exist on
             * either side of that, and the operator-side calls are guarded by
             * requireAdmin at the route rather than by a scope parameter.
             */
            "requestInvite",
            "listInviteRequests",
            "approveInviteRequest",
            "rejectInviteRequest",
            "deleteInviteRequest",
            /**
             * How many requests are waiting (D129). Installation-wide: there is
             * one queue of requests, every admin sees the same number, and the
             * rows it counts belong to people who do not have accounts yet.
             * `getMe` asks it only for an admin, and `requireAdmin` guards
             * every route that acts on what it counts.
             */
            "countPendingInviteRequests",
            /**
             * The reminder scheduler (D136). It runs on a timer with no session
             * and its whole job is to sweep **every** profile: a `userId` first
             * parameter would be a lie about what it does. The per-user reads
             * it makes — `alreadyDone`, `claimDay` — take one and are absent
             * from this list for that reason.
             *
             * `insideWindow` and `payloadFor` are pure: a number and a string,
             * no row of any kind.
             */
            "insideWindow",
            "payloadFor",
            "dueNow",
            "runReminders",

            /**
             * Password reset is pre-session by definition: the caller has lost
             * the means to prove who they are, and the token is the only claim
             * they hold. `hashToken` is a pure helper over that token.
             */
            "hashToken",
            "requestReset",
            "completeReset",

            /**
             * Administration acts on **another** account (D95), so a leading
             * `userId` would mean the opposite of what it means everywhere
             * else: not "the caller's scope" but "the person being acted upon".
             * These take an explicit `actor` instead, every one of them writes
             * an audit row naming that actor, and requireAdmin guards the
             * routes. The subject is named `userId` where there is one, and it
             * follows the actor deliberately — reading it as a scope is the
             * mistake this exemption exists to prevent.
             */
            "listUsers",
            "setUserDisabled",
            "previewDeletion",
            "deleteUser",
            "resetForUser",
            "listInvites",
            "mintInviteAs",
            "revokeInvite",
            "retryMail",
            "listAdminLog",

            /**
             * Mail settings are per **installation**, not per account (D102).
             * There is one mail server, one row, and the routes that reach
             * these are behind requireAdmin. A `userId` here would mean nothing
             * at all: there is no user whose settings these are.
             */
            "readMailSettings",
            "writeMailSettings",
            "mailerConfig",
            "importMailSettingsFromEnv",

            /**
             * Backups are per installation too (D103): one database, one
             * destination, one schedule. `runBackup` takes an optional `actor`
             * for the audit row, which is who pressed the button rather than
             * whose data is being read, because the answer to that is
             * everybody's.
             */
            "readBackupSettings",
            "writeBackupSettings",
            "listBackupRuns",
            "nextRunAt",
            "runBackup",
            "latestBackupFile",
            /**
             * Writes a probe file to the one destination this installation has
             * and deletes it again (D130). Like every other backup function it
             * takes an `actor` for the audit row, which is who pressed the
             * button rather than whose data is being written, because the
             * answer to that is everybody's.
             */
            "testBackupDestination",
            /**
             * Formats the one destination this installation has, for a log line
             * and an audit row (D132). Pure: it takes settings and returns a
             * string, touches no row, and there is no user whose destination it
             * could be, because there is one per installation.
             */
            "describeDestination",

            /**
             * Announcements are per installation (D108): one notice, everybody
             * sees it. The two that are per person, `announcementsFor` and
             * `markSeen`, take `userId` first like everything else and are
             * absent from this list for that reason.
             */
            "listAnnouncements",
            "createAnnouncement",
            "updateAnnouncement",
            "deleteAnnouncement",
            "mailAnnouncement",
            "isShowing",
            "defaultMaintenanceBody",
          ],
        },
      ],
    },
  },

  {
    files: ["apps/api/src/repositories/**/*.ts"],
    plugins: { isolation },
    rules: {
      "isolation/user-id-first-param": [
        "error",
        {
          allowUnscoped: [
            // `users` is the identity table: the lookup is what establishes who
            // the caller is, so there is no other user's row to leak.
            "findUserByEmail",
            "insertUser",
            // `invites` is not user-owned — a code is redeemed by someone with
            // no session. See invites.repo.ts.
            "insertInvite",
            "findUsableInvite",
            "markInviteUsed",
            // Resolving a cookie is what produces the user id in the first
            // place, and `sessions_token_key` is unique table-wide.
            "findSessionByTokenHash",
            // Deletes only rows that are already expired, for every user.
            "deleteExpiredSessions",
          ],
        },
      ],
    },
  },

  /**
   * Derived data has one owner (D47).
   *
   * Five defects across five phases shared a shape: a correct rule in a shared
   * module, and call sites reaching past it. Intake was the worst (D44) —
   * `calc/intake.ts` had defined a day's intake since Phase 2 and four call
   * sites each built the index themselves, each passing the manual rows only.
   * The maintenance figure was wrong for months and nothing errored.
   *
   * The Phase 6 guards handle the typeable version of this. This one is not
   * typeable: the offending call is well-typed and correct in isolation, and
   * only wrong because of who is making it. So ownership is declared here.
   */
  {
    files: ["apps/api/src/**/*.ts"],
    plugins: { ownership },
    rules: {
      "ownership/derived-data-owner": [
        "error",
        {
          owners: [
            {
              tables: ["manualIntake", "foodEntries"],
              readers: ["listManualIntake", "listFoodEntries"],
              allow: [
                // The owner. It reads both tables and is the only thing that
                // may, because a day's intake is one or the other, never a
                // sum of both (D44).
                "services/intake.service.ts",
                // The repositories that define the reads themselves.
                "repositories/intake.repo.ts",
                "repositories/food.repo.ts",
                // Food *entry* CRUD is about individual rows, not about what a
                // day's intake is. It never aggregates them into a total.
                "services/food.service.ts",
                "services/template.service.ts",
                // Owns "which days have any log entry" for the streak (§4.6),
                // which reads that a row exists and never its calories.
                "services/series.service.ts",
                "db/schema.ts",
              ],
              use: "`resolveIntake` / `resolveIntakeOn` from services/intake.service.ts",
              why: "a day's intake is the manual row or the day's food entries, never one of the two (D44).",
            },
            {
              tables: ["weightLog"],
              readers: ["listWeightEntries"],
              allow: [
                // The owner: everything that turns readings into a series.
                "services/weight.service.ts",
                "services/series.service.ts",
                "repositories/weight.repo.ts",
                "db/schema.ts",
              ],
              use: "`resolveTrend` from services/series.service.ts",
              why: "the trend is the number this product is about (D2), and it is smoothed by §4.1 exactly once.",
            },
          ],
        },
      ],
    },
  },

  {
    // Node scripts, run by `pnpm` rather than bundled into anything. The glob
    // covers the workspace root and each package, since `check-placeholders`
    // lives beside the build output it inspects.
    files: ["scripts/**/*.mjs", "**/scripts/**/*.mjs", "infra/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly" },
    },
  },

  /**
   * Rules of hooks.
   *
   * A `useState` was placed below an early `return null`, so the screen ran a
   * different number of hooks depending on whether a query had resolved. React
   * threw "Rendered more hooks than during the previous render" at runtime and
   * every render test failed on missing elements rather than on the cause,
   * which cost an afternoon. The rule is static and would have named the line.
   *
   * `exhaustive-deps` is a warning rather than an error on purpose: a stale
   * closure is a real defect but the rule cannot tell an intentionally narrow
   * dependency list from a forgotten one, and `eslint .` does not fail on
   * warnings. Rules of hooks has no such judgement in it — a conditional hook
   * is always wrong — so it is an error.
   */
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  /**
   * The hand-written half of the service worker (D136).
   *
   * It runs in a worker, where `self` is the global scope and there is no
   * `window`. Declared here rather than with a file-level eslint comment,
   * because the scope is a property of where the file runs rather than an
   * exception somebody decided to make.
   */
  {
    files: ["apps/web/public/app/push-sw.js"],
    languageOptions: {
      globals: { self: "readonly", clients: "readonly", registration: "readonly" },
    },
  },

  {
    files: ["**/*.test.ts", "**/*.config.ts", "eslint-rules/**/*.js"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
