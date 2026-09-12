import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApplyTemplate,
  ConfirmParsed,
  CreateEstimate,
  CreateFoodPortion,
  EstimateDishRequest,
  ParseFoodPhotoRequest,
  CreatePantryStaple,
  CreateSavedRecipe,
  RecipeRequest,
  UpdatePantryStaple,
  UpdateSavedRecipe,
  CreateFoodEntry,
  CreateTemplate,
  UpdateFoodEntry,
  UpdateTemplate,
} from "shared";
import { MIN_SEARCH_LENGTH } from "shared";
import { api } from "./api.js";
import { enqueueAndSync } from "./queue/enqueue.js";
import { INSIGHTS_KEY, INTAKE_KEY } from "./log.js";

export const RECENT_KEY = ["food", "recent"] as const;
export const ENTRIES_KEY = ["food", "entries"] as const;
export const TEMPLATES_KEY = ["food", "templates"] as const;

/**
 * The list that opens the logging screen. Recent foods first is the single
 * biggest tap saving in the app: the food someone is about to log is almost
 * always one they have logged before.
 */
export function useRecentFoods(limit = 20) {
  return useQuery({
    queryKey: [...RECENT_KEY, limit],
    queryFn: () => api.recentFoods(limit),
    select: (data) => data.entries,
    staleTime: 30_000,
  });
}

export function useFoodEntries(from?: string, to?: string) {
  return useQuery({
    queryKey: [...ENTRIES_KEY, from ?? null, to ?? null],
    queryFn: () => api.listFoodEntries({ ...(from ? { from } : {}), ...(to ? { to } : {}) }),
    select: (data) => data.entries,
    staleTime: 30_000,
  });
}

export function useTemplates() {
  return useQuery({
    queryKey: TEMPLATES_KEY,
    queryFn: () => api.listTemplates(),
    select: (data) => data.templates,
    staleTime: 60_000,
  });
}

/**
 * Search, deliberately **not** wired to keystrokes.
 *
 * The query is debounced and held to a minimum length before it is enabled, and
 * the server refuses anything shorter anyway. Open Food Facts allows ten
 * searches a minute for the *whole server* (D30), so a per-keystroke search
 * would exhaust a shared budget in one word.
 */
export function useFoodSearch(query: string, enabled: boolean) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["food", "search", trimmed],
    queryFn: () => api.searchFood(trimmed),
    enabled: enabled && trimmed.length >= MIN_SEARCH_LENGTH,
    // A repeated search inside a couple of minutes is answered from here rather
    // than from the network.
    staleTime: 120_000,
  });
}

export function useBarcodeLookup() {
  return useMutation({ mutationFn: (barcode: string) => api.lookupBarcode(barcode) });
}

/** Everything downstream of an intake change. */
function invalidateIntake(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: RECENT_KEY });
  void queryClient.invalidateQueries({ queryKey: ENTRIES_KEY });
  void queryClient.invalidateQueries({ queryKey: INTAKE_KEY });
  void queryClient.invalidateQueries({ queryKey: INSIGHTS_KEY });
}

/**
 * Through the queue, like every other log write: a meal logged in a shop
 * basement is logged (D39-D42).
 *
 * The timezone is a parameter rather than a hard-coded "Europe/Stockholm",
 * which it was. That was harmless while the entry's day always came from the
 * device, and stopped being harmless when `dateSource` started being derived
 * from it (D61): near midnight in another zone, a write meant as today would
 * have been stamped as a deliberate backfill.
 */
export function useSaveFoodEntry(timezone = "Europe/Stockholm") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateFoodEntry) =>
      enqueueAndSync({
        kind: "food-entry",
        timezone,
        localDate: input.localDate,
        clientUuid: input.clientUuid,
        body: input,
      }),
    onSuccess: () => invalidateIntake(queryClient),
  });
}

/**
 * Corrects an entry's amount.
 *
 * Straight to the API rather than through the queue: an edit is keyed by row
 * id, not by `client_uuid`, so replaying it against a row that has since been
 * changed again would silently undo the newer correction. It needs the network
 * and says so, which is the same reason the deletes are not queued (D42).
 */
export function useUpdateFoodEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateFoodEntry }) =>
      api.updateFoodEntry(id, input),
    onSuccess: () => invalidateIntake(queryClient),
  });
}

export function useCreateManualFood() {
  return useMutation({
    mutationFn: (input: { name: string; kcalPer100: number }) => api.createManualFood(input),
  });
}

/** Renaming a saved meal (D56). */
export function useUpdateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTemplate }) =>
      api.updateTemplate(id, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
}

export function useDeleteFoodEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteFoodEntry(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ENTRIES_KEY });
      void queryClient.invalidateQueries({ queryKey: RECENT_KEY });
      // The day's intake is a sum over what remains, and maintenance reads it.
      void queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTemplate) => api.createTemplate(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
}

export function useApplyTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, input }: { templateId: string; input: ApplyTemplate }) =>
      api.applyTemplate(templateId, input),
    onSuccess: () => {
      invalidateIntake(queryClient);
      void queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) => api.deleteTemplate(templateId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
}

/* --------------------------------------------- the optional LLM layer (§6.8) */

export const LLM_HEALTH_KEY = ["llm", "health"] as const;

/**
 * Whether the LLM layer is there at all.
 *
 * Asked once per session and cached for five minutes, because the answer is a
 * property of a workstation rather than of the user, and re-asking on every
 * render would put a request on the food screen's critical path for a feature
 * that is optional by design.
 *
 * `retry: false` on purpose: an unreachable host is the expected answer, not a
 * flaky one, and retrying only delays the moment the UI settles into the manual
 * path.
 */
export function useLlmHealth() {
  return useQuery({
    queryKey: LLM_HEALTH_KEY,
    queryFn: () => api.llmHealth(),
    staleTime: 300_000,
    retry: false,
  });
}

/**
 * Free text to named foods.
 *
 * Not queued, deliberately: it needs the model, which needs the network, so
 * there is nothing for an offline queue to do with it. Its absence degrades to
 * typing the foods in by hand, which is what the screen already does.
 */
export function useParseFood() {
  return useMutation({ mutationFn: (text: string) => api.parseFood(text) });
}

/**
 * A photograph of a plate to named foods (D143).
 *
 * **Never queued**, and for a stronger reason than the text parse's. The text
 * parse is not queued because there is nothing an offline queue could do with
 * it; the photograph is not queued because queueing it would mean writing the
 * image to this device's storage and keeping it there until the network came
 * back, and the one promise this feature makes is that the picture stops
 * existing as soon as it has been read.
 */
export function useParseFoodPhoto() {
  return useMutation({
    mutationFn: (body: ParseFoodPhotoRequest) => api.parseFoodPhoto(body),
  });
}

/**
 * A recipe from what is in the fridge.
 *
 * A mutation rather than a query, and not because it writes anything — it
 * writes nothing at all. It is a mutation because asking twice is supposed to
 * give two different recipes, which is the opposite of what a cache is for.
 */
export function useGenerateRecipe() {
  return useMutation({ mutationFn: (input: RecipeRequest) => api.generateRecipe(input) });
}

export function useConfirmParsedFood() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConfirmParsed) => api.confirmParsedFood(input),
    onSuccess: () => invalidateIntake(queryClient),
  });
}

/* ------------------------------ portions, pantry and saved recipes (D73-D76) */

export const PANTRY_KEY = ["pantry"] as const;
export const RECIPES_KEY = ["saved-recipes"] as const;
export const PORTIONS_KEY = ["portions"] as const;

export function usePortions() {
  return useQuery({
    queryKey: PORTIONS_KEY,
    queryFn: async () => (await api.listPortions()).portions,
    staleTime: 300_000,
  });
}

export function useSavePortion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFoodPortion) => api.savePortion(input),
    /**
     * A new portion changes what a stated amount resolves to, so anything
     * holding a resolved figure is stale. Cheap: these lists are small and the
     * user has just been typing into a form.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PORTIONS_KEY });
    },
  });
}

export function useDeletePortion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deletePortion(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PORTIONS_KEY });
    },
  });
}

/**
 * The cupboard. Seeded server-side on first read, so the first render of the
 * recipe sheet is a list to prune rather than an empty box (§6).
 */
export function usePantry() {
  return useQuery({
    queryKey: PANTRY_KEY,
    queryFn: async () => (await api.listPantry()).staples,
    staleTime: 300_000,
  });
}

export function useAddStaple() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePantryStaple) => api.addStaple(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PANTRY_KEY });
    },
  });
}

export function useUpdateStaple() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePantryStaple & { id: string }) =>
      api.updateStaple(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PANTRY_KEY });
    },
  });
}

export function useDeleteStaple() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteStaple(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PANTRY_KEY });
    },
  });
}

export function useSavedRecipes() {
  return useQuery({
    queryKey: RECIPES_KEY,
    queryFn: async () => (await api.listRecipes()).recipes,
    staleTime: 300_000,
  });
}

/**
 * Keeping a recipe also creates the meal template that cooks it again, so the
 * template list is stale too. Forgetting that half is the one-entry-behind
 * defect in a new place.
 */
export function useSaveRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSavedRecipe) => api.saveRecipe(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RECIPES_KEY });
      void queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
    },
  });
}

export function useUpdateRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateSavedRecipe & { id: string }) =>
      api.updateRecipe(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RECIPES_KEY });
    },
  });
}

export function useDeleteRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRecipe(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RECIPES_KEY });
    },
  });
}

/* --------------------------------------- estimates and favourites (D80/D81) */

export const FAVOURITES_KEY = ["food", "favourites"] as const;

export function useFavourites() {
  return useQuery({
    queryKey: FAVOURITES_KEY,
    queryFn: async () => (await api.listFavourites()).items,
    staleTime: 60_000,
  });
}

export function useSetFavourite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ foodItemId, favourite }: { foodItemId: string; favourite: boolean }) =>
      api.setFavourite(foodItemId, favourite),
    /**
     * Search results carry the star too, so both lists are stale after a tap.
     * Invalidating only the favourites list would leave the star the user just
     * pressed still hollow in the results behind it.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FAVOURITES_KEY });
      void queryClient.invalidateQueries({ queryKey: ["food", "search"] });
    },
  });
}

/**
 * A typed estimate becomes a food item, so everything that lists food is stale.
 */
export function useCreateEstimate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEstimate) => api.createEstimate(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["food", "search"] });
      void queryClient.invalidateQueries({ queryKey: FAVOURITES_KEY });
    },
  });
}

/** Asking the model what a dish is worth. Writes nothing; the answer is a proposal. */
export function useEstimateDish() {
  return useMutation({ mutationFn: (input: EstimateDishRequest) => api.estimateDish(input) });
}
