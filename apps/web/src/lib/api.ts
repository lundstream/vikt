import type {
  CoachConversation,
  CoachConversationList,
  CoachReview,
  CoachReviewList,
  CreateHabit,
  Habit,
  HabitList,
  UpdateHabit,
  CreateMilestone,
  UpdateMilestone,
  CreateOffset,
  CreateSavingsEvent,
  CreateSavingsRule,
  IntakeSeries,
  PreviewSavingsRule,
  SavingsRulePreviewDto,
  UpdateSavingsRule,
  ProgressResponse,
  PotDto,
  ActivityList,
  CorrelationsResponse,
  CreateActivity,
  CreateDailyLog,
  CreateMeasurement,
  DailyLogList,
  DayLog,
  MeasurementList,
  CreateManualIntake,
  CreateWeightEntry,
  DateRangeQuery,
  ErrorResponse,
  InsightsResponse,
  LoginRequest,
  ManualIntake,
  ManualIntakeList,
  MeResponse,
  ApplyTemplate,
  BarcodeLookup,
  CreateFoodEntry,
  CreatePlan,
  ConfirmParsedInput,
  CreateTemplate,
  LlmHealth,
  ParseFoodResponse,
  ParseFoodPhotoRequest,
  ParsePhotoResponse,
  CreateEstimate,
  CreateFoodPortion,
  EstimateDishRequest,
  EstimateResponse,
  CreatePantryStaple,
  CreateSavedRecipe,
  FoodPortion,
  PantryStaple,
  RecipeRequest,
  SavedRecipe,
  UpdateFoodPortion,
  UpdatePantryStaple,
  UpdateSavedRecipe,
  RecipeResponse,
  UpdateFoodEntry,
  UpdateTemplate,
  FoodEntry,
  FoodItem,
  FoodSearchResult,
  MealTemplate,
  Plan,
  RegisterRequest,
  UpdatePlan,
  UpdateProfile,
  WeightEntry,
  WeightList,
} from "shared";
import { meResponseSchema } from "shared";

/**
 * Same-origin fetch wrapper. nginx serves this app and proxies /api to the
 * Fastify process, so there is no base URL and no CORS. `credentials:
 * "same-origin"` is what carries the session cookie.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      // Only when there is actually a body. Declaring JSON on a bodyless POST
      // makes Fastify reject the request with FST_ERR_CTP_EMPTY_JSON_BODY.
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = body as ErrorResponse | null;
    throw new ApiError(
      response.status,
      error?.error ?? "unknown",
      error?.message ?? `Request failed (${response.status})`,
    );
  }

  return body as T;
}

export const api = {
  me: () => request<MeResponse>("/me").then((data) => meResponseSchema.parse(data)),

  register: (input: RegisterRequest) =>
    request<MeResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  login: (input: LoginRequest) =>
    request<MeResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  listWeight: (range: DateRangeQuery = {}) =>
    request<WeightList>(`/weight${queryString(range)}`),

  /**
   * Deletion is immediate, unlike a photo (D10): a log row is small, replaceable
   * and entirely the user's, and an "are you sure" on a mistyped weight is
   * friction on the recovery path rather than on the destructive one.
   */
  deleteWeight: (id: string) =>
    request<void>(`/weight/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Corrects the amount; the server recomputes what it contains (D65). */
  updateFoodEntry: (id: string, input: UpdateFoodEntry) =>
    request<FoodEntry>(`/food-entry/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteFoodEntry: (id: string) =>
    request<void>(`/food-entry/${encodeURIComponent(id)}`, { method: "DELETE" }),

  deleteDailyLog: (id: string) =>
    request<void>(`/daily/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /**
   * Taking a measurement back (D56, closed). Re-logging the day was always the
   * edit; this is the half that was missing from phase 4 until now.
   */
  deleteMeasurement: (id: string) =>
    request<void>(`/measurement/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /**
   * Removing the manual figure hands the day back to its food entries (D44).
   * The one operation that could not be done by overwriting, because a manual
   * row outranks the meals whatever number it holds.
   */
  deleteManualIntake: (id: string) =>
    request<void>(`/manual-intake/${encodeURIComponent(id)}`, { method: "DELETE" }),

  saveWeight: (input: CreateWeightEntry) =>
    request<WeightEntry>("/weight", { method: "POST", body: JSON.stringify(input) }),

  updateProfile: (input: UpdateProfile) =>
    request<MeResponse>("/me/profile", { method: "PATCH", body: JSON.stringify(input) }),

  /** Resolved server-side, so the client holds no second definition (D44). */
  intakeSeries: (from: string, to: string) =>
    request<IntakeSeries>(`/intake-series?from=${from}&to=${to}`),

  activePlan: () => request<Plan | null>("/plans/active"),

  createPlan: (input: CreatePlan) =>
    request<Plan>("/plans", { method: "POST", body: JSON.stringify(input) }),

  updatePlan: (planId: string, input: UpdatePlan) =>
    request<Plan>(`/plans/${planId}`, { method: "PATCH", body: JSON.stringify(input) }),

  // ------------------------------------------------------------------ food
  lookupBarcode: (barcode: string) =>
    request<BarcodeLookup>(`/food/barcode/${encodeURIComponent(barcode)}`),

  searchFood: (q: string, limit = 12) =>
    request<FoodSearchResult>(
      `/food/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  createManualFood: (input: { name: string; kcalPer100: number; brand?: string | null }) =>
    request<FoodItem>("/food/manual", { method: "POST", body: JSON.stringify(input) }),

  saveFoodEntry: (input: CreateFoodEntry) =>
    request<FoodEntry>("/food-entry", { method: "POST", body: JSON.stringify(input) }),

  listFoodEntries: (range: { from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    const query = params.toString();
    return request<{ entries: FoodEntry[] }>(`/food-entry${query ? `?${query}` : ""}`);
  },

  recentFoods: (limit = 20) =>
    request<{ entries: FoodEntry[] }>(`/food-entry/recent?limit=${limit}`),

  listTemplates: () => request<{ templates: MealTemplate[] }>("/meal-templates"),

  // ------------------------------------------------- the optional LLM layer
  /**
   * Asked before any of it is offered. A switched-off workstation is an
   * ordinary state of the world, not a fault (§6 phase 8).
   */
  llmHealth: () => request<LlmHealth>("/llm/health"),

  /** Reads the food database and writes nothing. */
  parseFood: (text: string) =>
    request<ParseFoodResponse>("/llm/parse-food", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  /**
   * A photograph of a plate, and the words beside it (D143).
   *
   * Base64 in JSON rather than a multipart upload, because multipart is a file
   * transfer and this is not one: there is no file at the other end. The image
   * is read, handed to the model and dropped, and a shape that looks like an
   * upload would invite somebody to give it somewhere to land.
   */
  parseFoodPhoto: (body: ParseFoodPhotoRequest) =>
    request<ParsePhotoResponse>("/llm/parse-photo", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /**
   * A recipe from what is in the fridge, priced by the database.
   *
   * Slow on purpose: the large model takes several seconds warm and around
   * half a minute from cold, so callers show progress rather than a spinner
   * that looks stuck.
   */
  generateRecipe: (input: RecipeRequest) =>
    request<RecipeResponse>("/llm/recipe", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** The rows the user accepted, after correcting the portions. */
  confirmParsedFood: (input: ConfirmParsedInput) =>
    request<{ entries: FoodEntry[] }>("/llm/parse-food/confirm", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** A restaurant meal or takeaway, valued by the person who ate it (D80). */
  createEstimate: (input: CreateEstimate) =>
    request<FoodItem>("/food/estimate", { method: "POST", body: JSON.stringify(input) }),

  listFavourites: () => request<{ items: FoodItem[] }>("/food/favourites"),

  setFavourite: (foodItemId: string, favourite: boolean) =>
    request<{ favourite: boolean }>("/food/favourite", {
      method: "POST",
      body: JSON.stringify({ foodItemId, favourite }),
    }),

  /**
   * The one call that asks the model for a number (D81).
   *
   * Its preconditions are in the body rather than assumed by the server: what
   * the app already tried, and that the user asked.
   */
  estimateDish: (input: EstimateDishRequest) =>
    request<EstimateResponse>("/llm/estimate", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // ------------------------------------- portions, pantry and saved recipes
  /** The user's own portion definitions, across every food. */
  listPortions: () => request<{ portions: FoodPortion[] }>("/portions"),

  savePortion: (input: CreateFoodPortion) =>
    request<FoodPortion>("/portions", { method: "POST", body: JSON.stringify(input) }),

  updatePortion: (id: string, input: UpdateFoodPortion) =>
    request<FoodPortion>(`/portions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deletePortion: (id: string) =>
    request<{ deleted: boolean }>(`/portions/${id}`, { method: "DELETE" }),

  /** Seeded on first read, so this is never an empty box. */
  listPantry: () => request<{ staples: PantryStaple[] }>("/pantry"),

  addStaple: (input: CreatePantryStaple) =>
    request<PantryStaple>("/pantry", { method: "POST", body: JSON.stringify(input) }),

  updateStaple: (id: string, input: UpdatePantryStaple) =>
    request<PantryStaple>(`/pantry/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  deleteStaple: (id: string) =>
    request<{ deleted: boolean }>(`/pantry/${id}`, { method: "DELETE" }),

  listRecipes: () => request<{ recipes: SavedRecipe[] }>("/recipes"),

  saveRecipe: (input: CreateSavedRecipe) =>
    request<SavedRecipe>("/recipes", { method: "POST", body: JSON.stringify(input) }),

  updateRecipe: (id: string, input: UpdateSavedRecipe) =>
    request<SavedRecipe>(`/recipes/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  deleteRecipe: (id: string) =>
    request<{ deleted: boolean }>(`/recipes/${id}`, { method: "DELETE" }),

  createTemplate: (input: CreateTemplate) =>
    request<MealTemplate>("/meal-templates", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  applyTemplate: (templateId: string, input: ApplyTemplate) =>
    request<{ entries: FoodEntry[] }>(`/meal-templates/${templateId}/apply`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateTemplate: (templateId: string, input: UpdateTemplate) =>
    request<MealTemplate>(`/meal-templates/${encodeURIComponent(templateId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteTemplate: (templateId: string) =>
    request<void>(`/meal-templates/${templateId}`, { method: "DELETE" }),

  insights: (asOf: string) => request<InsightsResponse>(`/insights?asOf=${asOf}`),

  listManualIntake: (range: DateRangeQuery = {}) =>
    request<ManualIntakeList>(`/manual-intake${queryString(range)}`),

  saveManualIntake: (input: CreateManualIntake) =>
    request<ManualIntake>("/manual-intake", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // ------------------------------------------------- measurements & the day
  listMeasurements: (range: DateRangeQuery = {}) =>
    request<MeasurementList>(`/measurement${queryString(range)}`),

  saveMeasurement: (input: CreateMeasurement) =>
    request<unknown>("/measurement", { method: "POST", body: JSON.stringify(input) }),

  listDailyLogs: (range: DateRangeQuery = {}) =>
    request<DailyLogList>(`/daily${queryString(range)}`),

  saveDailyLog: (input: CreateDailyLog) =>
    request<unknown>("/daily", { method: "POST", body: JSON.stringify(input) }),

  /** Everything logged for one day, so the daily screen opens filled in. */
  dayLog: (localDate: string) => request<DayLog>(`/day?localDate=${localDate}`),

  /* -------------------------------------------------------------- coach */

  coachConversations: () => request<CoachConversationList>("/coach/conversations"),

  coachConversation: (id: string) => request<CoachConversation>(`/coach/conversations/${id}`),

  removeConversation: (id: string) =>
    request<void>(`/coach/conversations/${id}`, { method: "DELETE" }),

  removeAllConversations: () =>
    request<{ removed: number }>("/coach/conversations", { method: "DELETE" }),

  coachReviews: () => request<CoachReviewList>("/coach/reviews"),

  coachCurrentReview: () => request<{ review: CoachReview | null }>("/coach/review/current"),

  writeReview: (asOf: string) =>
    request<{ status: string; review: CoachReview | null }>("/coach/reviews", {
      method: "POST",
      body: JSON.stringify({ asOf }),
    }),

  dismissReview: (id: string) =>
    request<{ ok: true }>(`/coach/reviews/${id}/dismiss`, { method: "POST" }),

  /* ------------------------------------------------------------- habits */

  listHabits: () => request<HabitList>("/habits"),

  createHabit: (input: CreateHabit) =>
    request<Habit>("/habits", { method: "POST", body: JSON.stringify(input) }),

  updateHabit: (id: string, patch: UpdateHabit) =>
    request<Habit>(`/habits/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  reorderHabits: (ids: readonly string[]) =>
    request<HabitList>("/habits/reorder", { method: "POST", body: JSON.stringify({ ids }) }),

  /**
   * `history` is in the query string rather than the body because a DELETE with
   * a body is a thing proxies drop. `keep` archives, `remove` takes the ticks.
   */
  removeHabit: (id: string, history: "keep" | "remove") =>
    request<void>(`/habits/${id}?history=${history}`, { method: "DELETE" }),

  listActivities: (range: DateRangeQuery = {}) =>
    request<ActivityList>(`/activity${queryString(range)}`),

  saveActivity: (input: CreateActivity) =>
    request<unknown>("/activity", { method: "POST", body: JSON.stringify(input) }),

  deleteActivity: (id: string) =>
    request<void>(`/activity/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /**
   * Points, sample size and date range. No coefficient — see D34 and
   * `calc/correlate.ts`.
   */
  correlations: (asOf: string) =>
    request<CorrelationsResponse>(`/correlations?asOf=${asOf}`),

  // ------------------------------------------ milestones and the savings pot
  progress: (asOf: string) => request<ProgressResponse>(`/progress?asOf=${asOf}`),

  pot: (asOf: string) => request<PotDto>(`/pot?asOf=${asOf}`),

  createMilestone: (input: CreateMilestone) =>
    request<{ id: string }>("/milestones", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateMilestone: (id: string, input: UpdateMilestone) =>
    request<{ id: string }>(`/milestones/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteMilestone: (id: string) =>
    request<void>(`/milestones/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Marks the celebration as shown, so it fires once and not again (D38). */
  acknowledgeCelebration: (id: string) =>
    request<void>(`/milestones/${encodeURIComponent(id)}/celebrated`, {
      method: "POST",
    }),

  claimReward: (id: string, asOf: string) =>
    request<unknown>(`/milestones/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      body: JSON.stringify({ asOf }),
    }),

  createSavingsRule: (input: CreateSavingsRule) =>
    request<{ id: string }>("/savings/rules", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateSavingsRule: (id: string, input: UpdateSavingsRule) =>
    request<{ id: string }>(`/savings/rules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  /**
   * Unlike a weight row, a savings rule is not immediate: it carries months of
   * accrual that only exist because the rule does (§4.5), so the consequence is
   * previewed and confirmed first.
   */
  deleteSavingsRule: (id: string) =>
    request<void>(`/savings/rules/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** What a change would do to the pot. `next: null` previews deleting it. */
  previewSavingsRule: (id: string, input: PreviewSavingsRule) =>
    request<SavingsRulePreviewDto>(`/savings/rules/${encodeURIComponent(id)}/preview`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  createSavingsEvent: (input: CreateSavingsEvent) =>
    request<unknown>("/savings/events", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** Idempotent on `(ruleId, localDate)`, so a replay files one fact. */
  saveOffset: (input: CreateOffset) =>
    request<void>("/savings/offsets", { method: "POST", body: JSON.stringify(input) }),

  removeOffset: (ruleId: string, localDate: string) =>
    request<void>(
      `/savings/offsets?ruleId=${encodeURIComponent(ruleId)}&localDate=${localDate}`,
      { method: "DELETE" },
    ),
};

function queryString(range: DateRangeQuery): string {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The browser's IANA zone. Day buckets are computed from it (CLAUDE.md §3). */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Stockholm";
  } catch {
    return "Europe/Stockholm";
  }
}
