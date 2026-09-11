import { z } from "zod";

/**
 * Auth contracts, shared verbatim between the Fastify routes and the React
 * forms. The client never re-declares a shape the server validates.
 */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email();

/**
 * Long enough to matter, no character-class theatre. This is an invite-only app
 * for a handful of people; length is the only rule that buys real security.
 */
export const passwordSchema = z.string().min(12).max(200);

export const displayNameSchema = z.string().trim().min(1).max(60);

export const inviteCodeSchema = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .transform((code) => code.toUpperCase().replaceAll(/[\s-]/g, ""));

export const registerRequestSchema = z.object({
  inviteCode: inviteCodeSchema,
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  /** IANA zone from the browser. Day buckets depend on it — see CLAUDE.md §3. */
  timezone: z.string().trim().min(1).max(64).default("Europe/Stockholm"),
  /**
   * Explicit agreement to what /integritet says (D107).
   *
   * `literal(true)` rather than a boolean, so a request without it fails
   * validation rather than registering somebody who never said yes. Weight and
   * body measurements handled for a health purpose are health data, and the
   * one thing that must not be inferred here is agreement.
   */
  consent: z.literal(true),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * What the registration *form* validates, as opposed to what goes on the wire.
 *
 * The confirmation field never leaves the browser — the server has nothing to
 * do with it — but the rule lives here rather than in the component so it is
 * declarative, testable, and reusable by a future change-password form. A
 * mistyped password on a masked field is unrecoverable without an email reset,
 * and this app has no email.
 */
export const registerFormSchema = registerRequestSchema
  .extend({
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "The two passwords do not match.",
    path: ["confirmPassword"],
  });
export type RegisterForm = z.infer<typeof registerFormSchema>;

/** Drops the confirmation field, leaving exactly what the API accepts. */
export function toRegisterRequest({
  confirmPassword: _confirmPassword,
  ...request
}: RegisterForm): RegisterRequest {
  return request;
}

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * The three theme values (D117).
 *
 * `system` rather than a nullable "unset", because following the OS is a
 * choice: it is what most people want and it is what the app did before there
 * was a setting at all. Dark stays the default first paint regardless of this,
 * for the reason in `app/index.html`: the phone gets used before the lights are
 * on, and a white flash at that hour is worse than a wrong theme for one frame.
 */
export const themeSchema = z.enum(["system", "dark", "light"]);
export type Theme = z.infer<typeof themeSchema>;

/** What `GET /api/me` returns. Never contains a hash or a session token. */
export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  createdAt: z.string(),
  /**
   * When this account agreed to the privacy text, or null for one created
   * before consent was asked for (D107). The app asks those once.
   */
  consentedAt: z.string().nullable().default(null),
  /**
   * Whether this account may reach the admin screens (D100).
   *
   * On `/me` rather than fetched separately, because the navigation has to
   * decide whether to render the entry during the first paint and a second
   * request would make it appear a moment late.
   *
   * It authorises nothing. `requireAdmin` reads the flag from the database on
   * every admin request and answers 404 without it (D89), so this only decides
   * whether a link is drawn. Defaulted rather than required so an identity
   * cached by an older build still parses and the app still opens offline.
   */
  isAdmin: z.boolean().default(false),
  /**
   * How many invite requests are waiting for an answer (D129).
   *
   * Zero for everybody who is not an admin, and computed rather than stored:
   * it is a count of rows in a state, and a stored copy of that is a second
   * thing to keep in step.
   *
   * On `/me` for the same reason `isAdmin` is: the navigation has to decide
   * during the first paint whether to mark the admin entry, and a second
   * request would make the marker appear a moment late. Defaulted so an
   * identity cached by an older build still parses.
   */
  pendingRequests: z.number().int().min(0).default(0),
  profile: z.object({
    /** Null until the user fills it in (D105). Not a zero, never a default. */
    heightCm: z.number().nullable(),
    birthDate: z.string().nullable(),
    sex: z.enum(["male", "female", "unspecified"]),
    timezone: z.string(),
    locale: z.string(),
    activityFactor: z.number(),
    addExerciseToTarget: z.boolean(),
    /** How the sober counter treats an unlogged day (D35). */
    soberAssumeUnloggedDry: z.boolean(),
    /** Whether news announcements are also mailed (D108). Opt-out. */
    newsMail: z.boolean().default(true),
    /**
     * Whether this admin is mailed about a new invite request (D129). Read
     * only for an admin, opt-out, and defaulted for an older cached identity.
     */
    requestMail: z.boolean().default(true),
    /**
     * The two reminders (D136), off until turned on, with their times as
     * minutes past midnight in this profile's own timezone. Defaulted so an
     * identity cached by an older build still parses.
     */
    remindWeigh: z.boolean().default(false),
    remindWeighMinute: z.number().int().min(0).max(1439).default(420),
    remindDay: z.boolean().default(false),
    remindDayMinute: z.number().int().min(0).max(1439).default(1320),
    /**
     * Which theme to use (D117). Defaulted so an identity cached by an older
     * build still parses and the app still opens offline.
     */
    theme: themeSchema.default("system"),
    /** Seeds the sober counter for a run that predates the app (D44). */
    lastDrinkOn: z.string().nullable(),
    /**
     * Macro overrides in grams, **null meaning "use the derived value"** (D52).
     *
     * Not the effective target. The effective target is on `/api/insights`
     * beside the figure it was derived from, because a number and the reason
     * for it should not arrive from two endpoints.
     */
    macroOverrides: z.object({
      proteinG: z.number().nullable(),
      carbsG: z.number().nullable(),
      fatG: z.number().nullable(),
      fiberG: z.number().nullable(),
    }),
  }),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  /**
   * The row this write lost to, on the 409 a queued write gets when its day was
   * already written from another device (D41).
   *
   * It travels with the refusal because the client has to *show* both readings
   * for the user to choose between, and a second round trip to fetch the other
   * one assumes a network that may already be gone again.
   */
  existing: z.record(z.unknown()).optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * The profile fields a user can edit.
 *
 * `sex` and `birthDate` are here because Mifflin-St Jeor needs them and the
 * dashboard asks for them by name when maintenance comes back as `"none"`
 * (D20). Both stay optional: someone who logs consistently gets an adaptive
 * figure and never has to fill either in.
 */
export const updateProfileSchema = z
  .object({
    sex: z.enum(["male", "female", "unspecified"]),
    /** `YYYY-MM-DD`, or null to clear it. */
    birthDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
      .nullable(),
    heightCm: z.number().min(80).max(260),
    timezone: z.string().trim().min(1).max(64),
    activityFactor: z.number().min(1).max(2.5),
    addExerciseToTarget: z.boolean(),
    /**
     * How the sober counter treats a day with no `daily_log` row (D35).
     * Stored rather than a display toggle, because a savings rule can be keyed
     * on the counter and the two must not disagree about what it means.
     */
    soberAssumeUnloggedDry: z.boolean(),
    /** Whether news announcements are also mailed (D108). Opt-out. */
    newsMail: z.boolean(),
    /** Whether an admin is mailed about a new invite request (D129). Opt-out. */
    requestMail: z.boolean(),
    /** The two reminders and their times (D136). Minutes past local midnight. */
    remindWeigh: z.boolean(),
    remindWeighMinute: z.number().int().min(0).max(1439),
    remindDay: z.boolean(),
    remindDayMinute: z.number().int().min(0).max(1439),
    /** Which theme to use: system, dark or light (D117). */
    theme: themeSchema,
    /**
     * The last drink before the app was installed (D44). `YYYY-MM-DD`, or null
     * to clear it. A logged `alcohol_units` after this date wins.
     */
    lastDrinkOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
      .nullable(),
    /**
     * Macro overrides in grams (D52). **Null clears the override**, which is
     * the whole way back to the derived value — there is no separate reset.
     *
     * The bounds refuse typos rather than opinions: 600 g of fat is a slipped
     * decimal point, and nothing in NNR's bands comes near it.
     */
    macroProteinG: z.number().int().min(1).max(600).nullable(),
    macroCarbsG: z.number().int().min(1).max(1200).nullable(),
    macroFatG: z.number().int().min(1).max(600).nullable(),
    macroFiberG: z.number().int().min(1).max(200).nullable(),
  })
  .partial();
export type UpdateProfile = z.infer<typeof updateProfileSchema>;
