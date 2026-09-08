/**
 * Vikt — initial database schema
 * Postgres 16 + Drizzle ORM
 *
 * Conventions:
 *  - Every user-owned table has user_id with ON DELETE CASCADE.
 *  - Every log table has client_uuid, unique per user, for idempotent offline replay.
 *  - Every log table stores logged_at (timestamptz) AND local_date (date, from the
 *    client's timezone). Day buckets always use local_date. Never derive a day from UTC.
 *  - Body measurements and money are numeric, never float. Drizzle returns numeric as a
 *    string; parse at the boundary.
 *  - Units are SI throughout: kg, cm, kcal, g, SEK, minutes.
 *  - Whether something has happened is a timestamp column, never a nullable
 *    foreign key: an FK with ON DELETE SET NULL is cleared by unrelated
 *    deletions and silently reads as "has not happened". See CLAUDE.md §3 and
 *    DECISIONS.md D17, which audits every nullable FK below.
 */

import {
  customType,
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  date,
  integer,
  smallint,
  numeric,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ---------------------------------------------------------------- enums */

export const sexEnum = pgEnum("sex", ["male", "female", "unspecified"]);
export const mealSlotEnum = pgEnum("meal_slot", [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
]);
export const foodSourceEnum = pgEnum("food_source", [
  "openfoodfacts",
  "livsmedelsverket",
  "manual",
  "llm_estimate",
]);
export const planStatusEnum = pgEnum("plan_status", ["active", "archived"]);

/**
 * Who can see a food item. **Not** inferred from `created_by` being null.
 *
 * `created_by` is a foreign key with ON DELETE SET NULL, so deleting a user
 * would have cleared it and turned every private food that user had created
 * into a shared one — the D16/D17 bug, in the table where it leaks somebody's
 * food diary rather than an invite code.
 */
export const foodVisibilityEnum = pgEnum("food_visibility", ["private", "shared"]);
export const milestoneMetricEnum = pgEnum("milestone_metric", [
  "weight_kg",
  "waist_cm",
  "chest_cm",
  "whtr",
  "log_streak_days",
  "sober_days",
]);
export const cadenceEnum = pgEnum("savings_cadence", [
  "every_day",
  "weekday",
  "weekend_day",
  "per_event",
]);
export const llmJobStatusEnum = pgEnum("llm_job_status", [
  "queued",
  "running",
  "done",
  "failed",
]);

/* ------------------------------------------------------ identity & auth */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    /**
     * When this account agreed to the privacy text (D107).
     *
     * A **timestamp, not a boolean**, and §3's rule about state is why: a
     * boolean says whether, and the question anybody ever actually asks is
     * when. It is also the shape that survives the text changing, because a
     * consent recorded before a rewrite is consent to the old words and the
     * date is what says so.
     *
     * Null for every account created before this column existed, which is what
     * makes them the ones asked on next sign-in.
     */
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    /**
     * The app's first authorisation concept (D89).
     *
     * A boolean rather than a roles table, because there are exactly two kinds
     * of account and inventing a role system for the second one is scaffolding
     * for a building nobody has drawn. Set by a CLI script and never through
     * the UI: an admin flag that any request can raise is a privilege
     * escalation waiting for one missing check.
     */
    isAdmin: boolean("is_admin").notNull().default(false),
  },
  (t) => [uniqueIndex("users_email_key").on(sql`lower(${t.email})`)],
);

/** Registration is invite-only. Mint codes with `pnpm --filter api invite`. */
export const invites = pgTable("invites", {
  code: text("code").primaryKey(),
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
  },
  (t) => [
    uniqueIndex("sessions_token_key").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

/** Per-user token for machine ingest (Home Assistant, Bluetooth scale bridge). */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_tokens_token_key").on(t.tokenHash)],
);

export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /**
   * Nullable since D105: height creates no account, it only makes three
   * numbers computable, and asking for it at registration put a measuring
   * tape between somebody and the app they came to try.
   *
   * Every consumer already handled its absence, because D20 made "missing"
   * a first-class answer rather than a zero: BMI and waist-to-height return
   * null, and the formula maintenance returns `source: "none"` naming exactly
   * which fields it wants.
   */
  heightCm: numeric("height_cm", { precision: 5, scale: 1 }),
  birthDate: date("birth_date"),
  sex: sexEnum("sex").notNull().default("unspecified"),
  timezone: text("timezone").notNull().default("Europe/Stockholm"),
  locale: text("locale").notNull().default("sv-SE"),
  /** Baseline multiplier for the Mifflin-St Jeor fallback before adaptive TDEE kicks in. */
  activityFactor: numeric("activity_factor", { precision: 3, scale: 2 })
    .notNull()
    .default("1.35"),
  /** Whether logged exercise raises the day's intake target. Default off, see CLAUDE.md §6 phase 4. */
  addExerciseToTarget: boolean("add_exercise_to_target").notNull().default(false),
  /**
   * How the sober counter treats a day with no `daily_log` row (D35).
   *
   * `false`, the default, is the strict reading: an unlogged day is unknown and
   * stops the count. `true` counts it as dry, which some people genuinely want
   * because they only open the app when something happened. It is a stored
   * preference rather than a display toggle because a savings rule can be keyed
   * on the counter, and the two must never disagree about what the number means.
   */
  soberAssumeUnloggedDry: boolean("sober_assume_unlogged_dry").notNull().default(false),
  /**
   * Whether news announcements are also mailed (D108).
   *
   * Opt-out, and only for news. Maintenance mail is not opt-out because it
   * concerns the service the person is using rather than something they might
   * find interesting, and an outage nobody was told about is the failure this
   * whole feature exists to prevent. /integritet says both.
   */
  newsMail: boolean("news_mail").notNull().default(true),
  /**
   * Which theme to use: `system`, `dark` or `light` (D117).
   *
   * On the account rather than in `localStorage`, because it is a preference
   * about the app and not about a browser: someone who reads at night on a
   * phone reads at night on a laptop, and having to set it twice is the kind of
   * small friction that makes an app feel like several apps.
   *
   * `system` is the default and is a real value rather than a null meaning
   * "unset". Null would make "follow the OS" indistinguishable from "has not
   * chosen", and those are the same behaviour but not the same fact: the second
   * one would tempt some future screen into asking.
   */
  theme: text("theme").notNull().default("system"),
  /**
   * The last drink before the app was installed, so a run already in progress
   * can be recorded without inventing daily logs for it (D44).
   *
   * A seed, not a fact about a day: it says "nothing before this counts", and
   * any `daily_log.alcohol_units` after it wins outright. Null means no seed.
   */
  lastDrinkOn: date("last_drink_on"),
  /**
   * Macro overrides, in grams. **Null means "use the derived value"** (D52).
   *
   * Null rather than a copy of the derived number, because a copy would be a
   * second definition: the plan's target changes and four stored grams figures
   * quietly keep describing the old one. Null also gives the way back for free
   * — clearing the field restores the reference, with no "reset" flag to keep
   * in step with anything.
   */
  macroProteinG: integer("macro_protein_g"),
  macroCarbsG: integer("macro_carbs_g"),
  macroFatG: integer("macro_fat_g"),
  macroFiberG: integer("macro_fiber_g"),
  /**
   * When the default pantry staples were seeded (§6 phase 8).
   *
   * A timestamp rather than a boolean or a row count, per §3: "has this
   * happened" is a fact nothing may cascade to, and an empty staple list is a
   * legitimate state — someone who deleted every default — that a count would
   * confuse with never having been seeded, re-seeding the list they just
   * cleared.
   */
  pantrySeededAt: timestamp("pantry_seeded_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ----------------------------------------------------------------- plan */

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: planStatusEnum("status").notNull().default("active"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    startWeightKg: numeric("start_weight_kg", { precision: 5, scale: 2 }),
    goalWeightKg: numeric("goal_weight_kg", { precision: 5, scale: 2 }),
    targetIntakeKcal: integer("target_intake_kcal").notNull(),
    /**
     * kg per week, **derived** from `target_intake_kcal` against the maintenance
     * figure at write time — not user input. The two used to be independent and
     * had already drifted apart: an 1800 target against a 3000 maintenance
     * implies 1.09 kg/week while the stored rate said 1.00, and every projection
     * used the deficit, so the stored number affected nothing. See D27.
     */
    targetRateKgWeek: numeric("target_rate_kg_week", { precision: 4, scale: 2 }),
    proteinFloorG: integer("protein_floor_g"),
    /**
     * The user's own floor. It may only *raise* the limit: the server checks
     * against max(SYSTEM_INTAKE_FLOOR_KCAL, this). See DECISIONS.md D24.
     */
    intakeFloorKcal: integer("intake_floor_kcal").notNull(),
    /**
     * The maintenance figure this plan was last validated against, and where it
     * came from. The rate guardrail is checked once at write time against a
     * number that is designed to change, so these are what a later re-check
     * compares to (DECISIONS.md D25). Null on plans written before this existed.
     */
    tdeeAtWrite: numeric("tdee_at_write", { precision: 7, scale: 1 }),
    tdeeSourceAtWrite: text("tdee_source_at_write"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("plans_user_status_idx").on(t.userId, t.status)],
);

/* ------------------------------------------------------------- log data */

export const weightLog = pgTable(
  "weight_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientUuid: uuid("client_uuid").notNull(),
    localDate: date("local_date").notNull(),
    loggedAt: timestamp("logged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    weightKg: numeric("weight_kg", { precision: 5, scale: 2 }).notNull(),
    bodyFatPct: numeric("body_fat_pct", { precision: 4, scale: 1 }),
    /** "manual" | "home_assistant" | "import" */
    source: text("source").notNull().default("manual"),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("weight_log_client_key").on(t.userId, t.clientUuid),
    // One canonical reading per day. A second reading on the same day replaces it.
    uniqueIndex("weight_log_day_key").on(t.userId, t.localDate),
    index("weight_log_user_date_idx").on(t.userId, t.localDate),
  ],
);

export const measurementLog = pgTable(
  "measurement_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientUuid: uuid("client_uuid").notNull(),
    localDate: date("local_date").notNull(),
    loggedAt: timestamp("logged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    waistCm: numeric("waist_cm", { precision: 5, scale: 1 }),
    chestCm: numeric("chest_cm", { precision: 5, scale: 1 }),
    neckCm: numeric("neck_cm", { precision: 5, scale: 1 }),
    hipsCm: numeric("hips_cm", { precision: 5, scale: 1 }),
    thighCm: numeric("thigh_cm", { precision: 5, scale: 1 }),
    armCm: numeric("arm_cm", { precision: 5, scale: 1 }),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("measurement_log_client_key").on(t.userId, t.clientUuid),
    uniqueIndex("measurement_log_day_key").on(t.userId, t.localDate),
  ],
);

/** One row per day for the subjective and contextual stuff. */
export const dailyLog = pgTable(
  "daily_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientUuid: uuid("client_uuid").notNull(),
    localDate: date("local_date").notNull(),
    loggedAt: timestamp("logged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 1-5 scales. Nullable: a partial day is a valid day. */
    sweat: smallint("sweat"),
    energy: smallint("energy"),
    mood: smallint("mood"),
    hunger: smallint("hunger"),
    sleepHours: numeric("sleep_hours", { precision: 3, scale: 1 }),
    steps: integer("steps"),
    /** Feeds both the savings rules and the days-since-last-drink counter. */
    alcoholUnits: numeric("alcohol_units", { precision: 4, scale: 1 }),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("daily_log_client_key").on(t.userId, t.clientUuid),
    uniqueIndex("daily_log_day_key").on(t.userId, t.localDate),
  ],
);

/* -------------------------------------------------------------- nutrition */

/**
 * `tsvector`, which Drizzle has no built-in column type for.
 *
 * Read-only from the application's point of view: the column is
 * `GENERATED ALWAYS AS ... STORED`, so Postgres maintains it and any attempt to
 * write it would be rejected by the database rather than silently ignored.
 */
const tsVector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

/**
 * Shared cache of food data, not user-owned. Grows as items are looked up so
 * repeat lookups never touch the network. Per 100 g / 100 ml.
 */
export const foodItems = pgTable(
  "food_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: foodSourceEnum("source").notNull(),
    /** Barcode, Livsmedelsverket id, or null for manual entries. */
    sourceRef: text("source_ref"),
    barcode: text("barcode"),
    name: text("name").notNull(),
    brand: text("brand"),
    /**
     * Who created it, for provenance only. Allowed to go null when that account
     * is deleted; **never** read as "this item is shared" — that is what
     * `visibility` is for (D17). A private item whose creator is gone matches
     * no user and is therefore invisible, which is the safe direction to fail.
     */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Explicit, and nothing cascades to it. */
    visibility: foodVisibilityEnum("visibility").notNull().default("shared"),
    kcalPer100: numeric("kcal_per_100", { precision: 7, scale: 2 }).notNull(),
    proteinPer100: numeric("protein_per_100", { precision: 6, scale: 2 }),
    carbsPer100: numeric("carbs_per_100", { precision: 6, scale: 2 }),
    fatPer100: numeric("fat_per_100", { precision: 6, scale: 2 }),
    fiberPer100: numeric("fiber_per_100", { precision: 6, scale: 2 }),
    saltPer100: numeric("salt_per_100", { precision: 6, scale: 2 }),
    /**
     * Which household-measure table applies to this food (D85).
     *
     * Null is the ordinary case and means the app has no household measure for
     * it, so it falls back to grams and says so. Deliberately *not* a foreign
     * key to a categories table: the value is only ever read against a constant
     * in `packages/shared`, and a table would invite it being edited into
     * something the code has no measures for.
     */
    category: text("category"),
    /** Optional serving hints, e.g. {"skiva": 35, "portion": 250} */
    servingHints: jsonb("serving_hints"),
    /**
     * Whether this item's numbers are an estimate rather than a measurement.
     *
     * Separate from `source`, because the two answer different questions and
     * both matter. `source` says where the figure came from; this says how much
     * it is worth. A hand-typed pizzeria pizza has source `manual` and is very
     * much an estimate; a hand-typed food copied off a packet has the same
     * source and is not.
     *
     * Load-bearing beyond display: §4.2's maintenance figure is computed from
     * the intake series, and a window built largely out of estimates is a
     * weaker measurement than one built out of barcodes. It is read there (D82)
     * and it is shown on every screen the item appears on, because a number the
     * user cannot tell is a guess is a number they will treat as a fact.
     */
    isEstimate: boolean("is_estimate").notNull().default(false),
    /**
     * What the estimate was based on, in the user's own words or the model's.
     *
     * Kept so the estimate can be judged rather than merely accepted: "stor
     * pizza kebab från pizzerian" is the difference between a number someone
     * can sanity-check and a number that simply appeared.
     */
    estimateBasis: text("estimate_basis"),
    /**
     * Swedish full-text index over the name and brand, maintained by Postgres.
     *
     * Generated rather than written by a trigger or by the application: a
     * trigger has to be remembered by every writer, and an application-side
     * column drifts the first time a row is inserted by a script such as the
     * Livsmedelsverket importer. Declared here so the search query can
     * reference it; never written to. See migration `0004_food_search.sql`.
     */
    searchVector: tsVector("search_vector"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("food_items_source_ref_key").on(t.source, t.sourceRef),
    index("food_items_barcode_idx").on(t.barcode),
    index("food_items_name_idx").on(t.name),
  ],
);

export const foodEntries = pgTable(
  "food_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientUuid: uuid("client_uuid").notNull(),
    localDate: date("local_date").notNull(),
    loggedAt: timestamp("logged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    mealSlot: mealSlotEnum("meal_slot").notNull().default("snack"),
    /** Null when the entry is freetext-only and unmatched. */
    foodItemId: uuid("food_item_id").references(() => foodItems.id, {
      onDelete: "set null",
    }),
    freetext: text("freetext"),
    grams: numeric("grams", { precision: 7, scale: 1 }).notNull(),
    /**
     * Snapshot of the macros AT LOG TIME. Denormalised deliberately: if a food
     * item is later corrected upstream, history must not silently change, since
     * adaptive TDEE is computed from it.
     */
    kcal: numeric("kcal", { precision: 7, scale: 1 }).notNull(),
    proteinG: numeric("protein_g", { precision: 6, scale: 1 }),
    carbsG: numeric("carbs_g", { precision: 6, scale: 1 }),
    fatG: numeric("fat_g", { precision: 6, scale: 1 }),
    fiberG: numeric("fiber_g", { precision: 6, scale: 1 }),
    /** 0-1. LLM-parsed entries start below 1 until the user confirms. */
    confidence: numeric("confidence", { precision: 3, scale: 2 })
      .notNull()
      .default("1.00"),
    confirmed: boolean("confirmed").notNull().default(true),
  },
  (t) => [
    uniqueIndex("food_entries_client_key").on(t.userId, t.clientUuid),
    index("food_entries_user_date_idx").on(t.userId, t.localDate),
  ],
);

/**
 * Manual daily intake, used before phase 3 food logging exists and as an escape
 * hatch afterwards (restaurant meals, guesses). Day totals = sum(foodEntries)
 * unless a manualKcal row exists for that day, which overrides.
 */
export const manualIntake = pgTable(
  "manual_intake",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientUuid: uuid("client_uuid").notNull(),
    localDate: date("local_date").notNull(),
    kcal: integer("kcal").notNull(),
    proteinG: integer("protein_g"),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("manual_intake_client_key").on(t.userId, t.clientUuid),
    uniqueIndex("manual_intake_day_key").on(t.userId, t.localDate),
  ],
);

export const mealTemplates = pgTable(
  "meal_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    defaultMealSlot: mealSlotEnum("default_meal_slot"),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("meal_templates_user_used_idx").on(t.userId, t.lastUsedAt)],
);

export const mealTemplateItems = pgTable("meal_template_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id")
    .notNull()
    .references(() => mealTemplates.id, { onDelete: "cascade" }),
  foodItemId: uuid("food_item_id").references(() => foodItems.id, {
    onDelete: "set null",
  }),
  /**
   * The item's name at the time it was added. Kept so that deleting the food it
   * points at leaves a readable line rather than grams of nothing (D17). The
   * default exists only so the column could be added to an existing table; the
   * service always writes a real name, and a test holds it to that.
   */
  nameSnapshot: text("name_snapshot").notNull().default(""),
  freetext: text("freetext"),
  grams: numeric("grams", { precision: 7, scale: 1 }).notNull(),
  position: smallint("position").notNull().default(0),
});

/* --------------------------------------------------------------- activity */

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientUuid: uuid("client_uuid").notNull(),
    localDate: date("local_date").notNull(),
    loggedAt: timestamp("logged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    activityType: text("activity_type").notNull(),
    durationMin: integer("duration_min").notNull(),
    /** 1-5 subjective intensity, used to pick the MET value band. */
    intensity: smallint("intensity"),
    metValue: numeric("met_value", { precision: 4, scale: 2 }),
    kcalEstimate: integer("kcal_estimate"),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("activity_log_client_key").on(t.userId, t.clientUuid),
    index("activity_log_user_date_idx").on(t.userId, t.localDate),
  ],
);

/* ------------------------------------------------- milestones & savings */

export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    metric: milestoneMetricEnum("metric").notNull(),
    /** Target value. Direction is inferred from the metric and the current value. */
    targetValue: numeric("target_value", { precision: 8, scale: 2 }).notNull(),
    rewardText: text("reward_text"),
    rewardCostSek: numeric("reward_cost_sek", { precision: 10, scale: 2 }),
    sortOrder: smallint("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set once, never cleared. Detection runs against the TREND value, not raw. */
    achievedAt: timestamp("achieved_at", { withTimezone: true }),
    achievedValue: numeric("achieved_value", { precision: 8, scale: 2 }),
    /**
     * When the celebration was shown, so it fires **once** and not on every
     * dashboard load (D38).
     *
     * Its own column rather than something inferred from `achieved_at`: those
     * are two different facts, and "achieved but not yet celebrated" is exactly
     * the state that has to be representable for one-shot to work at all. Per
     * §3 and D17 it is a timestamp nothing cascades to, never a nullable FK.
     */
    celebratedAt: timestamp("celebrated_at", { withTimezone: true }),
    /**
     * When the reward was cashed in. This, and never
     * `savings_events.milestone_id`, is the answer to "has this been paid?" —
     * that column is `ON DELETE SET NULL` and D17 names it as provenance only.
     */
    rewardClaimedAt: timestamp("reward_claimed_at", { withTimezone: true }),
  },
  (t) => [index("milestones_user_idx").on(t.userId, t.achievedAt)],
);

/** Recurring "money I am not spending" rules. Accrued on read, never by cron. */
export const savingsRules = pgTable(
  "savings_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    amountSek: numeric("amount_sek", { precision: 10, scale: 2 }).notNull(),
    cadence: cadenceEnum("cadence").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("savings_rules_user_idx").on(t.userId, t.active)],
);

/** A day the rule did NOT apply, because you did buy the lunch after all. */
export const savingsOffsets = pgTable(
  "savings_offsets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => savingsRules.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    note: text("note"),
  },
  (t) => [uniqueIndex("savings_offsets_key").on(t.ruleId, t.localDate)],
);

/** One-off savings, and reward payouts drawing the pot down (negative amounts). */
export const savingsEvents = pgTable(
  "savings_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    label: text("label").notNull(),
    amountSek: numeric("amount_sek", { precision: 10, scale: 2 }).notNull(),
    /** Set when this event is a milestone reward being cashed in. */
    milestoneId: uuid("milestone_id").references(() => milestones.id, {
      onDelete: "set null",
    }),
  },
  (t) => [index("savings_events_user_date_idx").on(t.userId, t.localDate)],
);

/* ----------------------------------------------------------------- media */

/**
 * Progress photos. The file lives on a server volume outside the web root.
 * Never public, never in Postgres, served only via an authenticated endpoint
 * with a short-lived signed URL. Never visible to other users, including in groups.
 */
export const photos = pgTable(
  "photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    storagePath: text("storage_path").notNull(),
    thumbPath: text("thumb_path"),
    pose: text("pose"),
    weightKgAtCapture: numeric("weight_kg_at_capture", {
      precision: 5,
      scale: 2,
    }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("photos_user_date_idx").on(t.userId, t.localDate)],
);

/* ------------------------------------------------------------- LLM layer */

/**
 * Queue for work sent to Ollama. Nothing in phases 1-7 may depend on this table.
 * If the workstation is offline, jobs stay queued and every feature falls back
 * to a manual path.
 */
export const llmJobs = pgTable(
  "llm_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "parse_food" | "recipe" | "weekly_review" */
    kind: text("kind").notNull(),
    status: llmJobStatusEnum("status").notNull().default("queued"),
    model: text("model"),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("llm_jobs_status_idx").on(t.status, t.createdAt)],
);

export const weeklyReviews = pgTable(
  "weekly_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    weekStart: date("week_start").notNull(),
    /** The aggregates that were sent to the model, kept for reproducibility. */
    stats: jsonb("stats").notNull(),
    body: text("body").notNull(),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("weekly_reviews_week_key").on(t.userId, t.weekStart)],
);

/* ---------------------------------------------------- groups (phase 9) */

export const groups = pgTable("groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  inviteCode: text("invite_code").notNull(),
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Membership only. Group views expose logging consistency and streaks.
 * Weights, intake, measurements and photos are NEVER shared across users.
 */
export const groupMembers = pgTable(
  "group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("group_members_key").on(t.groupId, t.userId)],
);

/* ------------------------------------------------- portions, phase 8 (D73) */

/**
 * A portion the user defined for a food item.
 *
 * Separate from `food_items.serving_hints` and not a replacement for it. The
 * hints on the item come from whoever packaged it and are shared by everyone
 * who logs that item; this is one person's kitchen scale, and when the two
 * disagree the kitchen scale wins. Merging them into the shared row would let
 * one user's loaf redefine a slice for every other user, which the food table's
 * visibility rules (D16/D17) exist to prevent.
 *
 * Many rows per user per item, so it needs a real update path, not re-logging
 * (§3, D56). The unique index is on the **normalised** unit, written by the
 * service, so "skiva" and "Skivor" cannot both exist and resolve differently.
 */
export const foodPortions = pgTable(
  "food_portions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    foodItemId: uuid("food_item_id")
      .notNull()
      .references(() => foodItems.id, { onDelete: "cascade" }),
    /** As the user typed it, for display. */
    unit: text("unit").notNull(),
    /** Lowercased and de-pluralised by `normaliseUnit`, for lookup. */
    unitKey: text("unit_key").notNull(),
    grams: numeric("grams", { precision: 8, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("food_portions_key").on(t.userId, t.foodItemId, t.unitKey),
    index("food_portions_user_idx").on(t.userId),
  ],
);

/* --------------------------------------------- pantry staples, phase 8 (D75) */

/**
 * What is assumed to be in the kitchen without being listed each time.
 *
 * Seeded with a default list the user prunes rather than an empty box (§6), so
 * `pantry_seeded_at` on the profile records that the seeding happened. A count
 * of zero is a legitimate state — someone who deleted every default — and is
 * not the same as never having been seeded, which is exactly the §3 rule about
 * flags: the timestamp is the record, and nothing cascades to it.
 *
 * `negligible` is the load-bearing column. §6: salt and pepper may be assumed
 * silently, oil and rice may not, because three tablespoons of oil is roughly
 * 360 kcal and a recipe that omits it feeds a silently low number into the
 * series TDEE is computed from. It defaults from the matched food item's energy
 * rather than from the user's judgement.
 */
export const pantryStaples = pgTable(
  "pantry_staples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * The food it resolves to, when one was found. Allowed to go null: a
     * staple whose food item is deleted is still a staple, it just stops being
     * priceable, and the name is what the model is given either way.
     */
    foodItemId: uuid("food_item_id").references(() => foodItems.id, {
      onDelete: "set null",
    }),
    negligible: boolean("negligible").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("pantry_staples_name").on(t.userId, t.name),
    index("pantry_staples_user_idx").on(t.userId),
  ],
);

/* ---------------------------------------------- saved recipes, phase 8 (D76) */

/**
 * How a dish was cooked, kept as prose.
 *
 * Its own table rather than a field on `meal_templates`, per §6, because they
 * answer different questions: a template is "log these rows again in one tap",
 * a recipe is "how did I cook that". They link through `template_id`, so
 * cooking it again is one tap and reading how is one tap more.
 *
 * The first model-generated prose this app stores, which is why the text is
 * **frozen at save**: regenerating the same dish produces different words, and
 * a saved recipe that silently rewrote itself would be a record of something
 * that never happened. It is editable, because the user's corrections to timings and
 * method are the entire value of keeping it (§6, D56).
 */
export const savedRecipes = pgTable(
  "saved_recipes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** One step per element, frozen as generated or as later edited. */
    steps: jsonb("steps").notNull(),
    /**
     * The ingredient list as saved: name, grams, the portion label if there was
     * one, and the food item it was priced from. Snapshotted rather than joined
     * for the same reason `meal_template_items` keeps a name (D17): deleting the
     * food leaves a readable line rather than grams of nothing.
     */
    items: jsonb("items").notNull(),
    /** The template generated from it, so cooking it again is one tap. */
    templateId: uuid("template_id").references(() => mealTemplates.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("saved_recipes_user_idx").on(t.userId, t.createdAt)],
);

/* ---------------------------------------------------- favourites, phase 8 */

/**
 * Foods the user wants within reach without searching.
 *
 * Its own table rather than a column on `food_items`, for the reason every
 * user-scoped fact about a shared row is: `food_items` is a **shared cache**
 * (D17), and one person's favourite is not everyone's. A column there would
 * make the last person to tap the star the owner of the whole table's opinion.
 *
 * Exists because of estimates. A hand-typed pizzeria pizza and a restaurant
 * item are the entries most expensive to recreate and least likely to be found
 * by searching, and they recur: the same pizzeria, most Fridays.
 */
export const foodFavourites = pgTable(
  "food_favourites",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    foodItemId: uuid("food_item_id")
      .notNull()
      .references(() => foodItems.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("food_favourites_key").on(t.userId, t.foodItemId)],
);

/* ------------------------------------------------------ outbound mail (D88) */

/**
 * Mail waiting to be sent.
 *
 * **Nothing is ever sent inside a request.** An SMTP conversation takes seconds
 * on a good day and hangs on a bad one, and a registration that waits for a
 * mail server is a registration that fails when the mail server does. The
 * request writes a row; a worker drains it.
 *
 * The same shape as the queued LLM work, deliberately: status, attempts, a last
 * error and a next attempt. A failure is a row an admin can read, never a log
 * line nobody looks at (§3's rule that the app says what it could not do).
 *
 * The body is stored rather than re-rendered at send time. A template that
 * changes between queueing and sending would otherwise silently alter mail
 * already promised to someone, and a failed send that is retried a day later
 * has to be the same message it was.
 */
export const outboundEmail = pgTable(
  "outbound_email",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toAddress: text("to_address").notNull(),
    /** Which template produced it, for the admin list and for support. */
    template: text("template").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    /** Optional, and minimal where present. No images, no tracking (D88). */
    bodyHtml: text("body_html"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /**
     * Lower goes first (D109). 0 is the test mail, 10 is everything else.
     *
     * There is exactly one thing that needs to jump the queue, and it is the
     * one somebody is watching: an admin who has just pressed "send test" is
     * waiting for an answer, and a test that waits behind an announcement to
     * four hundred addresses answers a question about patience rather than
     * about the mail server.
     */
    priority: integer("priority").notNull().default(10),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("outbound_email_status_idx").on(t.status, t.nextAttemptAt)],
);

/**
 * Password reset tokens.
 *
 * **Hashed, like sessions.** The plaintext exists once, in the mail; the
 * database holds only its hash, so a database copy does not let anyone into an
 * account. `used_at` is a timestamp nothing cascades to, per §3: "has this been
 * spent" is a fact that must not be cleared by a deletion elsewhere.
 */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("password_resets_token_key").on(t.tokenHash),
    index("password_resets_user_idx").on(t.userId),
  ],
);

/**
 * Someone asking for an invite code (D89).
 *
 * Public and unauthenticated, so it stores as little as it can: an address, an
 * optional line about why, and when. Nothing about the requester's browser,
 * nothing about their address beyond the address itself.
 *
 * A rejected request is **deleted**, not marked rejected, because keeping a
 * record of someone the owner declined is keeping personal data for no purpose
 * anyone could name.
 */
export const inviteRequests = pgTable(
  "invite_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /**
     * What the requester calls themselves (D112).
     *
     * Asked for because the owner reads these by hand and decides one at a
     * time, and an address alone is not much to decide on. Nullable because
     * every row written before the field existed has none, and free text
     * because a name is whatever the person says it is.
     */
    name: text("name"),
    /** Optional, capped, and shown to the admin. Never used for anything else. */
    reason: text("reason"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The code minted on approval, so the admin view can show it again. */
    inviteCode: text("invite_code"),
  },
  (t) => [
    uniqueIndex("invite_requests_email_key").on(sql`lower(${t.email})`),
    index("invite_requests_status_idx").on(t.status, t.createdAt),
  ],
);

/**
 * Every administrative action, and who took it (D95).
 *
 * Admin actions are the only ones in this app that touch data belonging to
 * somebody else, which is exactly the class that needs a record. Disabling an
 * account, deleting one, minting a code, sending a reset on someone's behalf:
 * each of those is a thing a person did to another person, and "who did this
 * and when" has to survive the action.
 *
 * `actorId` is `set null` on delete rather than cascade, because the log has to
 * outlive the admin: an entry that vanished when its author's account was
 * removed would be a log that erases exactly the history worth keeping. The
 * `actorEmail` snapshot is what keeps the row readable afterwards.
 *
 * Not user-owned in the D15 sense — an admin reads all of it — so it is one of
 * the small number of tables whose queries are deliberately unscoped.
 */
export const adminLog = pgTable(
  "admin_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** Who it was, kept readable after the account is gone. */
    actorEmail: text("actor_email").notNull(),
    /** What happened: `user.disable`, `invite.mint`, `mail.retry`, and so on. */
    action: text("action").notNull(),
    /** What it happened to. A user id, an invite code, a queue row id. */
    subject: text("subject"),
    /** Anything worth reading later, such as what a delete removed. */
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("admin_log_created_idx").on(t.createdAt)],
);


/**
 * Mail settings, in the database rather than in the environment (D102).
 *
 * D94 put deployment modes in the environment and said they must never be a
 * toggle in the admin UI, and that still holds for `LANDING_ENABLED` and
 * `LLM_ENABLED`: those decide whether a feature exists. Mail is a different
 * shape of thing. It is not a mode, it is a **connection to somebody else's
 * server**, with a host that changes, a password that rotates, and a failure
 * mode the operator has to be able to diagnose without a shell on the box.
 *
 * So the settings move here and `SECRET_KEY` stays in the environment. What
 * that buys is written out in `lib/secrets.ts` and in D102, including what it
 * does not buy.
 *
 * **One row, always.** `id` is a fixed literal rather than a generated uuid, so
 * there is exactly one settings row by construction and no code path has to
 * decide which of two is current. A second insert conflicts on the primary key
 * rather than quietly winning.
 *
 * The password is stored encrypted and is never returned by any endpoint. The
 * interface shows whether one is set, and setting a new one replaces it.
 */
export const mailSettings = pgTable("mail_settings", {
  /** Always `singleton`. See above. */
  id: text("id").primaryKey().default("singleton"),

  host: text("host").notNull(),
  port: integer("port").notNull().default(587),

  /**
   * How the connection is protected.
   *
   * `starttls` upgrades a plain connection on 587, `tls` is implicit TLS on
   * 465, and `none` is neither. Three named cases rather than nodemailer's
   * `secure` boolean, because that boolean means "implicit TLS" and reads as
   * "is this secure at all", which is how somebody ends up sending a password
   * in clear while believing the opposite.
   */
  security: text("security", { enum: ["starttls", "tls", "none"] })
    .notNull()
    .default("starttls"),

  username: text("username").notNull().default(""),
  /** AES-256-GCM, keyed from `SECRET_KEY`. Empty means no password is set. */
  passwordEncrypted: text("password_encrypted").notNull().default(""),

  fromAddress: text("from_address").notNull(),
  fromName: text("from_name").notNull().default(""),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Who last changed it. Kept readable after the account is gone, like the log. */
  updatedByEmail: text("updated_by_email"),
});


/**
 * Backup settings, and every run of one (D103).
 *
 * D96 shipped `infra/backup.sh` and `infra/restore-check.sh`, and a restore was
 * actually performed. What it did not ship was a **schedule**: the script was
 * written, documented, rehearsed, and never installed in cron, so the only
 * backups that ever existed were the ones somebody ran by hand. STATE.md said
 * so, in a list of things to do next, where it stayed.
 *
 * A backup nobody scheduled is not a backup, and a schedule nobody can see the
 * state of is not much better. So the app runs it and records it.
 *
 * `backupSettings` is one row, like `mailSettings`, for the same reason: there
 * is one destination per installation and no code path should have to decide
 * which of two is current.
 */
export const backupSettings = pgTable("backup_settings", {
  /** Always `singleton`. */
  id: text("id").primaryKey().default("singleton"),

  /**
   * Where backups go.
   *
   * Only `local` is implemented. `smb` and `s3` are in the enum because the
   * column is the thing that would have to change to add them and a migration
   * later is worse than a value that is refused today with a clear reason. The
   * service says plainly that it cannot use them rather than pretending.
   */
  destinationKind: text("destination_kind", { enum: ["local", "smb", "s3"] })
    .notNull()
    .default("local"),

  /** A filesystem path for `local`, a share or bucket URL for the others. */
  destinationPath: text("destination_path").notNull().default(""),

  /**
   * Credentials for a destination that needs them, encrypted like the mail
   * password. Empty for `local`, which needs none.
   */
  credentialsEncrypted: text("credentials_encrypted").notNull().default(""),

  /** Minutes past midnight, local time, or null for no schedule at all. */
  scheduleMinute: integer("schedule_minute"),

  retainDays: integer("retain_days").notNull().default(30),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByEmail: text("updated_by_email"),
});

/**
 * One row per attempt, successful or not.
 *
 * Failures are rows too. §3's honesty rule is about the app's own failures as
 * much as the user's data, and a backup system that records only its successes
 * is one whose status screen is green on the morning the disk filled up.
 */
export const backupRuns = pgTable(
  "backup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** `running`, `ok` or `failed`. A `running` row older than an hour is a crash. */
    status: text("status", { enum: ["running", "ok", "failed"] }).notNull().default("running"),
    /** Who asked, or null for the schedule. */
    startedByEmail: text("started_by_email"),
    destination: text("destination").notNull().default(""),
    fileName: text("file_name"),
    bytes: integer("bytes"),
    error: text("error"),
  },
  (t) => [index("backup_runs_started_idx").on(t.startedAt)],
);


/**
 * What a background worker last did, so a stalled one cannot look like an idle
 * one (D104).
 *
 * The mail queue sat with two `pending` rows and `attempts: 0` for an hour, and
 * the admin screen showed them as "Väntar", which is exactly what a message
 * waiting its turn looks like. Nothing distinguished "the worker will get to
 * this" from "no worker exists", and no worker existed: the drainer was a
 * separate process nobody was running and the compose stack had no service for
 * it.
 *
 * A row per worker, updated every tick. The value of it is entirely in the
 * `lastTickAt`: a queue with items and a heartbeat from four seconds ago is
 * working, and the same queue with a heartbeat from yesterday is broken, and
 * those are the two states an operator needs to tell apart.
 */
export const workerHeartbeat = pgTable("worker_heartbeat", {
  /** `mail` today. One row per worker, named rather than numbered. */
  name: text("name").primaryKey(),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }).notNull().defaultNow(),
  /** Since the process started, not since the beginning of time. */
  sentSinceStart: integer("sent_since_start").notNull().default(0),
  /** The last thing that went wrong, kept until something goes right. */
  lastError: text("last_error"),
});


/**
 * Announcements: maintenance now, news later (D108).
 *
 * **In-app is the primary channel, and that is a consequence of the offline
 * queue rather than a preference.** A planned outage stops nobody from logging:
 * writes go to IndexedDB and sync when the app is back (Phase 6). The sentence
 * that says so is worth more than the outage warning itself, and it reaches the
 * right person only when it sits in the app they are holding. Mail is optional
 * per announcement, for the same reason a receipt is optional.
 */
export const announcements = pgTable(
  "announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * `maintenance` has a window and a default body rendered from it. `news` is
     * a feature announcement that never interrupts anything. `notice` is
     * everything else that is neither an outage nor a feature.
     */
    kind: text("kind", { enum: ["maintenance", "news", "notice"] }).notNull(),

    /** The window, for maintenance. Null on the other two kinds. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),

    /**
     * How long before the window the banner appears, in minutes.
     *
     * Configurable per announcement rather than a constant: a two-minute
     * restart and a four-hour migration do not deserve the same warning, and a
     * banner that appears a day early for a five-minute outage is a banner
     * people learn to dismiss without reading.
     */
    leadMinutes: integer("lead_minutes").notNull().default(1440),

    title: text("title").notNull(),
    /** Optional. Absent on a maintenance notice means the default template. */
    body: text("body"),

    /** Drafts exist so a window can be written before it is announced. */
    published: boolean("published").notNull().default(false),
    /** Whether it also went out as mail. Set once, when it is published. */
    sendMail: boolean("send_mail").notNull().default(false),
    mailedAt: timestamp("mailed_at", { withTimezone: true }),

    createdByEmail: text("created_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Bumped on every edit, and the version a dismissal is recorded against.
     * An announcement whose window moves is a different thing to be told, so a
     * dismissal of the old wording does not silence the new one.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("announcements_kind_idx").on(t.kind, t.published, t.startsAt)],
);

/**
 * Who has dismissed or read what, and which version of it.
 *
 * One table for both, because they are the same fact: this person has seen this
 * version. A banner uses it to stay hidden and the news list uses it to drop the
 * unread marker, and a second table would be two ways to record one thing.
 *
 * `seenVersion` is the announcement's `updatedAt` at the moment it was seen. An
 * edit moves `updatedAt` past it and the thing comes back, which is what makes
 * "reappearing if the announcement changes" a property rather than a promise.
 */
export const announcementSeen = pgTable(
  "announcement_seen",
  {
    announcementId: uuid("announcement_id")
      .notNull()
      .references(() => announcements.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
    seenVersion: timestamp("seen_version", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("announcement_seen_key").on(t.announcementId, t.userId),
    index("announcement_seen_user_idx").on(t.userId),
  ],
);
