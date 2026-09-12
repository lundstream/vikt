import type {
  FoodMatch,
  LlmHealth,
  ParseFoodResponse,
  ParsePhotoResponse,
  RecipeBudget,
  RecipeResponse,
  RecipeTotal,
  EstimateResponse,
} from "shared";
import type { ParsedPhotoItem, ServingHints } from "shared";
import {
  HOUSEHOLD_UNITS,
  hintGrams,
  householdHints,
  normaliseUnit,
  resolvePortion,
  scaleToGrams,
  toNumber,
  toNumberOrNull,
} from "shared";
import type { Db } from "../db/index.js";
import type { Env } from "../env.js";
import type { LlmClient } from "../llm/client.js";
import { parseFoodMessages, readParsedFood } from "../llm/parse-food.js";
import { parsePhotoMessages, readParsedPhoto } from "../llm/parse-photo.js";
import { RateLimiter } from "../lib/rate-limit.js";
import { COACH_TURNS_PER_HOUR } from "./coach.service.js";
import { recipeMessages, readGeneratedRecipe } from "../llm/recipe.js";
import { checkCompleteness, type CompletenessFailure } from "../llm/recipe-completeness.js";
import { estimateMessages, readDishEstimate } from "../llm/estimate.js";
import { getInsights } from "./insights.service.js";
import { searchFoodItems, type FoodItemRow } from "../repositories/food.repo.js";
import { getStaples, userHintsFor } from "./portions.service.js";

/**
 * The optional LLM layer, as the API exposes it.
 *
 * Two rules from §6 phase 8 shape every function here:
 *
 * **Nothing depends on it.** Unavailability is an ordinary answer carried on a
 * 200, not an error. A caller that treats it as a fault would put an error
 * banner in front of someone whose workstation is simply switched off, which
 * the brief rules out in its first paragraph.
 *
 * **The model names, the database counts.** The parse endpoint reads
 * `food_items` and writes nothing at all. Nothing is saved until the user has
 * seen the matches and confirmed the portions, which is what makes a wrong
 * match harmless rather than a corrupted intake series.
 */

export async function llmHealth(env: Env, client: LlmClient): Promise<LlmHealth> {
  return {
    configured: client.enabled,
    reachable: await client.reachable(),
    models: { small: env.OLLAMA_MODEL_SMALL, large: env.OLLAMA_MODEL_LARGE },
  };
}

/**
 * Free text in, named foods with database nutrition out.
 *
 * Deliberately **read-only**. The tempting shortcut is to log what the model
 * found and let the user correct it afterwards, and it is the wrong shape: a
 * mis-parsed portion that reaches `food_entries` is already inside the intake
 * series, which is what the §4.2 maintenance figure is computed from. A
 * correction after the fact does not undo a day that has already been counted
 * wrong somewhere else.
 */
export async function parseFoodText(
  userId: string,
  db: Db,
  env: Env,
  client: LlmClient,
  text: string,
): Promise<ParseFoodResponse> {
  const reply = await client.chat({
    model: env.OLLAMA_MODEL_SMALL,
    messages: parseFoodMessages(text),
    json: true,
    temperature: 0,
    timeoutMs: env.OLLAMA_TIMEOUT_MS,
  });

  if (!reply.ok) return { available: false, reason: reply.reason };

  const parsed = readParsedFood(reply.content);
  if (!parsed.ok) return { available: false, reason: parsed.reason };

  return {
    available: true,
    items: await priceAll(userId, db, parsed.items),
    model: reply.model,
    ms: reply.ms,
  };
}

/**
 * How many photographs one account may send in an hour.
 *
 * The coach's allowance, deliberately the same number and deliberately not the
 * same bucket. The same number because both queue on the one GPU this
 * installation has and neither is a thing a person does forty times an hour;
 * separate buckets because a day of logging meals should not be able to use up
 * the conversation, which is the surface where being told to come back later is
 * worst.
 */
export const PHOTO_PARSES_PER_HOUR = COACH_TURNS_PER_HOUR;

const photoLimiter = new RateLimiter(PHOTO_PARSES_PER_HOUR, 60 * 60_000);

/**
 * A photograph in, the same priced rows a sentence produces out.
 *
 * **The image is not kept.** It is decoded from the request, handed to Ollama,
 * and dropped when this function returns: it is not written to disk, not
 * written to any table, not put in a log line, and the client never queues it.
 * A photograph of a plate is a photograph of somebody's kitchen, or of the
 * people they were eating with, and the only reason this feature is acceptable
 * in a self-hosted app is that the picture stops existing the moment it has
 * been read. `apps/api/test/photo-transport.test.ts` holds that.
 *
 * Read-only in the same sense as the text parse, for the same reason: what
 * comes back is a proposal, and nothing reaches `food_entries` until a person
 * has looked at every row.
 */
export async function parseFoodPhoto(
  userId: string,
  db: Db,
  env: Env,
  client: LlmClient,
  input: { image: string; note?: string },
  log?: { info: (data: object, message: string) => void },
): Promise<ParsePhotoResponse> {
  /**
   * No model named means the path does not exist here, which is a different
   * answer from the box being off and is worth telling apart: one is an
   * installation that has not been configured for this and one is a workstation
   * somebody switched off.
   */
  const model = env.LLM_VISION_MODEL.trim();
  if (model === "") return { available: false, reason: "not_configured" };

  const limit = photoLimiter.check(`photo:${userId}`);
  if (!limit.allowed) {
    return {
      available: false,
      reason: "rate_limited",
      retryAfterSeconds: limit.retryAfterSeconds,
    };
  }

  const reply = await client.chat({
    model,
    messages: parsePhotoMessages(input.image, input.note),
    json: true,
    temperature: 0,
    // Three times the text budget, measured rather than chosen. See the
    // variable's own comment in env.ts.
    timeoutMs: env.OLLAMA_VISION_TIMEOUT_MS,
  });

  if (!reply.ok) return { available: false, reason: reply.reason };

  const parsed = readParsedPhoto(reply.content);
  if (!parsed.ok) return { available: false, reason: parsed.reason };

  const items = await pricePhotoItems(userId, db, parsed.items);

  /**
   * One line, and everything in it is a count.
   *
   * Enough to answer "is this being used and is it slow", which is what the
   * operator of a self-hosted box actually wants from a log. The size is in
   * kilobytes because the number is the useful part; the bytes themselves are
   * the thing this whole path is arranged not to write down. `hadNote` rather
   * than the note, for the same reason: "kebabpizza, hela" is not private, and
   * the next one might be.
   */
  log?.info(
    {
      model: reply.model,
      ms: reply.ms,
      kb: Math.round((input.image.length * 3) / 4 / 1024),
      items: items.length,
      hadNote: (input.note?.trim() ?? "") !== "",
    },
    "photo parsed",
  );

  return { available: true, items, model: reply.model, ms: reply.ms };
}

/**
 * Photographed names and amounts in, priced rows out.
 *
 * The same two steps as the text path — match the name, then resolve the
 * amount against that row's hints — with one rule that only exists here:
 *
 * **An amount that cannot be turned into grams is not an amount.** The text
 * parser has an estimate to fall back on, because a sentence that says "en
 * skiva bröd" was written by somebody who knows roughly what a slice is. A
 * photograph has nothing behind it: the model's answers were "stor mängd",
 * "spridd över delar" and "1 portion", and every one of those is a description
 * of a picture. Turning them into a number would be the app inventing a figure
 * and then showing it to the person as though they had given it.
 *
 * So the amount survives only when the unit is one the app can price — grams or
 * kilograms directly, or a household unit this food actually has a definition
 * for — and is null otherwise. Null rows are kept, named, and cannot be saved
 * until somebody fills the figure in.
 */
async function pricePhotoItems(
  userId: string,
  db: Db,
  parsed: ParsedPhotoItem[],
): Promise<FoodMatch[]> {
  const rows = await Promise.all(parsed.map((item) => matchRow(userId, db, item.name)));

  const ids = rows.filter((row) => row !== null).map((row) => row!.id);
  const userHints = await userHintsFor(userId, db, ids);

  return parsed.map((item, index) => {
    const row = rows[index] ?? null;
    const packet = (row?.servingHints as ServingHints | null) ?? null;
    const own = row ? (userHints.get(row.id) ?? null) : null;

    const household = householdHints(row?.category);
    const hints = packet || household ? { ...(household ?? {}), ...(packet ?? {}) } : null;

    const amount = photoAmount(item.amount ?? null, hints, own);

    return {
      name: item.name,
      estimatedGrams: amount.grams,
      portion: amount.portion,
      portionSource: amount.source,
      /**
       * The app's figure, not the model's (D55, D143). A photograph is
       * evidence of a plate and not of a quantity, so every row from one
       * carries the same lowered confidence, and a model asserting its own
       * would be the thing being judged handing in the mark.
       */
      confidence: PHOTO_CONFIDENCE,
      match: row === null ? null : priceRow(row, amount.grams, hints, own),
    };
  });
}

/**
 * What a photographed amount is worth, or null.
 *
 * Grams and kilograms resolve on their own; everything else has to be a unit
 * the household table knows **and** one this food has a definition for. "1
 * portion" of yoghurt is 200 g because the table says so; "1 portion" of a
 * kebab pizza is not a quantity, because nothing anywhere says what a portion
 * of kebab pizza weighs, and inventing it here is exactly what this rule is for.
 */
function photoAmount(
  amount: { count: number; unit: string } | null,
  hints: ServingHints | null,
  userHints: ServingHints | null,
): {
  grams: number | null;
  source: FoodMatch["portionSource"];
  portion: FoodMatch["portion"];
} {
  const nothing = { grams: null, source: "unknown", portion: null } as const;
  if (amount === null) return nothing;

  const unit = normaliseUnit(amount.unit);
  if (!HOUSEHOLD_UNITS.includes(unit)) return nothing;

  /**
   * Grams and kilograms carry **no portion label**, because there is nothing
   * left to label: the amount and the grams are the same fact, and "250 g ·
   * 250 g" on one line is a screen repeating itself. The label exists for
   * "1 portion" and "2 skivor", where the words and the mass are different
   * things and the user needs both to judge the second by the first.
   */
  if (unit === "g") return { grams: round(amount.count), source: "hint", portion: null };
  if (unit === "kg") {
    return { grams: round(amount.count * 1000), source: "hint", portion: null };
  }

  const hint = hintGrams(unit, hints, userHints);
  if (hint === null) return nothing;

  return {
    grams: round(amount.count * hint.grams),
    source: hint.source,
    // The label is capped by `statedPortionSchema`, and a count past it is not
    // a portion anybody stated: it is the model having produced a gram figure
    // under a household unit's name.
    portion: amount.count <= 200 ? amount : null,
  };
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * The confidence every row from a photograph carries.
 *
 * A fixed figure rather than a computed one, and below anything the text path
 * produces, because the uncertainty is not in this row: it is in the fact that
 * a model looked at a picture. D55's estimates lower confidence rather than
 * excluding themselves from the arithmetic, and these do the same — the
 * coverage counts them, because the database priced them, and the confidence
 * says where they came from.
 */
export const PHOTO_CONFIDENCE = 0.6;

/**
 * Names and stated portions in, priced rows out.
 *
 * Shared by the parser and the recipe generator because §6 says the recipe's
 * output goes through the same parse-and-match path, and because the portion
 * resolution is the part that would otherwise be written twice and drift.
 *
 * The order matters. The food has to be **matched first**, because the hints
 * live on the food item and there is nothing to resolve a portion against until
 * the row is known. So: match on the name, then resolve "5 skivor" against that
 * row's hints, then price the resolved grams. Pricing the model's estimate and
 * then correcting the label would show a number that belongs to a different
 * quantity than the one on screen.
 */
async function priceAll(
  userId: string,
  db: Db,
  parsed: {
    name: string;
    estimatedGrams: number;
    confidence: number;
    portion?: { count: number; unit: string } | null;
  }[],
): Promise<FoodMatch[]> {
  const rows = await Promise.all(
    parsed.map((item) => matchRow(userId, db, item.name)),
  );

  const ids = rows.filter((row) => row !== null).map((row) => row!.id);
  const userHints = await userHintsFor(userId, db, ids);

  return parsed.map((item, index) => {
    const row = rows[index] ?? null;
    const packet = (row?.servingHints as ServingHints | null) ?? null;
    const own = row ? (userHints.get(row.id) ?? null) : null;

    /**
     * All three layers, in D85's order of precedence.
     *
     * The household table joins the packet's own hints as a *lower* authority,
     * merged rather than chosen between: a bread with a `portion` from its
     * wrapper and a `skiva` from the table should offer both, and the user's own
     * definition of either wins over both.
     */
    const household = householdHints(row?.category);
    const hints =
      packet || household ? { ...(household ?? {}), ...(packet ?? {}) } : null;

    const resolved = resolvePortion(item.portion ?? null, item.estimatedGrams, hints, own);

    return {
      name: item.name,
      estimatedGrams: resolved.grams,
      portion: resolved.portion,
      portionSource: resolved.source,
      confidence: item.confidence,
      match: row === null ? null : priceRow(row, resolved.grams, hints, own),
    };
  });
}

/**
 * The best food in the database for a name, or null.
 *
 * Reuses the same ranked search the food screen uses, so a name the user could
 * have found by typing it resolves the same way here. **Null is a normal
 * answer**: an unmatched name comes back with no nutrition attached, and the
 * user can search for it or leave it as freetext. Guessing at a near-miss to
 * avoid an empty field is how the wrong food's calories end up in the series.
 */
async function matchRow(userId: string, db: Db, name: string): Promise<FoodItemRow | null> {
  /**
   * A handful of candidates rather than one, and the first *plausible* one.
   *
   * The ranking is tuned for a person reading a list of twenty: a near-miss at
   * the top is harmless there, because the reader skips it. Taking the top row
   * unread is a different job with a much higher bar, and the first live run
   * showed exactly why — "kycklingfilé" came back as "Korv kycklingkorv" and
   * "fetaost" as "Grekisk sallad m. fetaost", both priced with full confidence.
   */
  const rows = await searchFoodItems(userId, db, name, 5);
  return rows.find((candidate) => isPlausibleMatch(name, candidate.name)) ?? null;
}

/**
 * The row's energy at the resolved grams. Computed here, never by the model.
 *
 * `grams` may be null, which is the photo path's honest answer when nobody
 * knows the amount yet (D143). The food is still worth naming and its figure
 * per hundred grams is still worth showing; what cannot be stated is what this
 * particular helping is worth, so that field is null rather than a number
 * standing on an assumed portion.
 */
function priceRow(
  row: FoodItemRow,
  grams: number | null,
  hints: ServingHints | null,
  userHints: ServingHints | null,
): NonNullable<FoodMatch["match"]> {
  const scaled = scaleToGrams(
    {
      kcalPer100: toNumber(row.kcalPer100),
      macros: {
        proteinG: toNumberOrNull(row.proteinPer100),
        carbsG: toNumberOrNull(row.carbsPer100),
        fatG: toNumberOrNull(row.fatPer100),
        fiberG: toNumberOrNull(row.fiberPer100),
        saltG: toNumberOrNull(row.saltPer100),
      },
    },
    grams ?? 0,
  );

  /**
   * Both sets of hints travel to the client, the user's own merged over the
   * source's, so a portion picker on the screen does not need a request per
   * row. Merged in that order for the same reason the lookup checks them in
   * that order: the kitchen scale wins.
   */
  const merged =
    hints || userHints ? { ...(hints ?? {}), ...(userHints ?? {}) } : null;

  return {
    foodItemId: row.id,
    name: row.name,
    brand: row.brand,
    kcalPer100: toNumber(row.kcalPer100),
    // Computed here, from the row. Never from the model. Null when there are
    // no grams to compute it at, which is not the same as zero.
    kcal: grams === null ? null : Math.round(scaled.kcal * 10) / 10,
    servingHints: merged,
  };
}

/**
 * Whether a database row is actually the food that was named.
 *
 * Three rules, and each one exists because of a specific wrong answer from the
 * first live runs against the real database.
 *
 * **A row is only its head.** Food names in this database mark the "contains"
 * relation explicitly — "Grekisk sallad m. fetaost", "Fatteh m. kyckling",
 * "Pannkaka med ägg" — and everything after that connector is an ingredient of
 * something else, not the thing itself. Matching against the part before it is
 * what separates "Kyckling med curry", which is chicken, from "Fatteh m.
 * kyckling", which is not. Stripping "med" as a filler word, which is the
 * obvious thing to do, deletes exactly the signal that tells them apart.
 *
 * **Every word asked for has to be there.** "Kycklingfilé" is not
 * "kycklingkorv", however close the trigram score; pricing one as the other
 * puts a different food's energy into the intake series under a name the user
 * recognises. A longer inflection is the same word, since the model is asked
 * for the base form and the database is not written in it.
 *
 * **At most one word of qualification.** "Ägg rått" and "Spenat färsk" are the
 * food; three words for a one-word query is a product that merely contains it.
 *
 * Failing any of them leaves `match` null, which is a first-class outcome
 * everywhere this is used: the row keeps its name, shows no energy, and says
 * so. An honest gap beats a confident wrong number.
 */
const CONTAINS_CONNECTOR = /\s(?:m\.|med|innehåller)\s|[,&+/]/i;

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zà-öø-ÿ0-9]+/i)
    .filter((word) => word.length > 0);
}

export function isPlausibleMatch(query: string, name: string): boolean {
  // Only the head of the row's name. A query may still be several words.
  const head = name.split(CONTAINS_CONNECTOR)[0] ?? name;

  const asked = significantWords(query);
  const found = significantWords(head);
  if (asked.length === 0 || found.length === 0) return false;

  const covered = asked.every((word) =>
    found.some(
      (candidate) =>
        candidate === word ||
        // An inflection, either direction, but never a short prefix: "ris"
        // starting "risotto" is a different food, "tomat" starting "tomater"
        // is not.
        (word.length >= 4 && candidate.startsWith(word)) ||
        (candidate.length >= 4 && word.startsWith(candidate)),
    ),
  );

  return covered && found.length <= asked.length + 1;
}

/* ----------------------------------------------------------------- recipes */

/**
 * What is left of the day, read from the same place the dashboard reads it.
 *
 * `getInsights` rather than a second calculation. It is heavier than this one
 * caller needs — it computes the trend, maintenance and both projections on the
 * way — and that is the right trade: a day's remaining room has one definition
 * (D44, D47), and the alternative is a second one that agrees today and drifts
 * later. The call sits in front of an eight second generation anyway.
 *
 * Nulls mean "no budget to speak of" rather than zero. Without a plan there is
 * no target to have room inside, and "0 kcal left" is a limit the app invented.
 */
export async function remainingBudget(
  userId: string,
  db: Db,
  env: Env,
  asOf: string,
): Promise<RecipeBudget> {
  const insights = await getInsights(userId, db, asOf, env.SYSTEM_INTAKE_FLOOR_KCAL);
  const macros = insights.macros;

  /**
   * A macro whose day is only partly labelled has a **floor**, not a total
   * (D55), so what is left is an upper bound. The flag travels to the prompt
   * and to the screen, because a bound presented as a figure is the kind of
   * small lie that ends up on a plate.
   */
  const approximate =
    macros !== null &&
    (["protein", "carbs", "fat"] as const).some(
      (key) => macros[key].todayG !== null && !macros[key].todayComplete,
    );

  const left = (key: "protein" | "carbs" | "fat"): number | null => {
    if (macros === null) return null;
    const line = macros[key];
    return Math.max(0, Math.round(line.targetG - (line.todayG ?? 0)));
  };

  return {
    kcal: insights.todayRemainingKcal === null ? null : Math.max(0, insights.todayRemainingKcal),
    proteinG: left("protein"),
    carbsG: left("carbs"),
    fatG: left("fat"),
    approximate,
  };
}

/**
 * A recipe from what is in the fridge, priced by the database.
 *
 * §6: the output goes through **the same parse-and-match path** as a typed
 * sentence, so `priceAll` does the matching, the portion resolution and the
 * pricing here exactly as it does there. The model contributes a title, some
 * steps and a list of named amounts; every calorie on the screen came out of
 * `food_items`.
 *
 * The large model and the job timeout, because generation is slow: several
 * seconds warm on this hardware and half a minute from cold. The parser's short
 * interactive budget would cut a cold start off mid-sentence.
 *
 * **Two attempts, then an honest failure** (D74). A recipe that fails the
 * completeness rules is regenerated once, because these models produce a
 * finishable recipe most of the time and an unlucky draw is not worth telling
 * the user about. A second failure is reported as one: showing a half-recipe
 * with a warning is worse than showing none, since someone starts cooking it.
 */
export async function generateRecipe(
  userId: string,
  db: Db,
  env: Env,
  client: LlmClient,
  input: { localDate: string; have: string },
  log?: { warn: (details: object, message: string) => void },
): Promise<RecipeResponse> {
  const budget = await remainingBudget(userId, db, env, input.localDate);
  const staples = await getStaples(userId, db);

  let lastFailure: CompletenessFailure[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reply = await client.chat({
      model: env.OLLAMA_MODEL_LARGE,
      messages: recipeMessages(input.have, budget, staples, lastFailure),
      json: true,
      // Not zero. A recipe generator that returns the same omelette every night
      // is a worse tool than one that varies, and nothing downstream is
      // computed from the wording.
      temperature: 0.6,
      timeoutMs: env.OLLAMA_JOB_TIMEOUT_MS,
    });

    if (!reply.ok) return { available: false, reason: reply.reason };

    const recipe = readGeneratedRecipe(reply.content);
    if (!recipe.ok) return { available: false, reason: recipe.reason };

    /**
     * The completeness rules are a proxy for "a person could cook this", and
     * the only way to tell whether the proxy is any good is to look at what it
     * rejects on real cases. So every failure is logged with the rule that
     * caught it and the text that failed, on the way past.
     */
    const failures = checkCompleteness(recipe);
    if (failures.length > 0) {
      lastFailure = failures;
      log?.warn(
        {
          attempt,
          title: recipe.title,
          rules: failures.map((failure) => failure.rule),
          details: failures.map((failure) => failure.detail),
        },
        "recipe failed completeness",
      );
      continue;
    }

    const items = await priceAll(userId, db, recipe.items);

    return {
      available: true,
      title: recipe.title,
      steps: recipe.steps,
      items,
      budget,
      total: totalFor(items),
      model: reply.model,
      ms: reply.ms,
    };
  }

  return { available: false, reason: "incomplete_recipe" };
}

/**
 * The recipe's energy, and whether it is all of it (D74).
 *
 * Summed over priced rows only, and the flag says so. The version this replaced
 * showed the sum as a headline figure with the missing ingredients in small
 * grey text beneath, which is absent-is-not-zero (D44) in its quietest form: a
 * number that looks like an answer, is understated, and carries its own
 * correction in the size the eye skips. Taco sauce at 30 g is about 50 kcal.
 */
function totalFor(items: FoodMatch[]): RecipeTotal {
  const priced = items.filter((item) => item.match !== null);
  const missing = items.filter((item) => item.match === null).map((item) => item.name);

  return {
    kcal:
      priced.length === 0
        ? null
        : Math.round(priced.reduce((sum, item) => sum + (item.match?.kcal ?? 0), 0)),
    complete: missing.length === 0,
    missing,
  };
}

/* ------------------------------------------- the narrow estimate exception */

/**
 * What a dish is worth, when nothing else can say (D81).
 *
 * The only function in this file that returns a number the database did not
 * supply, and it exists because the alternative is worse rather than because
 * the rule was inconvenient. For a named chain burger or a pizzeria pizza there
 * is no row to match; the fallback is the user typing a figure, and people
 * systematically underestimate restaurant portions.
 *
 * Its preconditions are enforced at the route, not here, because they are facts
 * about what the app already tried. What this function guarantees is the rest:
 * the reply is schema-checked, the point figure has to sit inside the model's
 * own stated range, and the confidence is derived from the width of that range
 * rather than from anything the model says about itself.
 *
 * Nothing is written. The estimate is a proposal; accepting it is a separate
 * act through the ordinary food-item path.
 */
export async function estimateDish(
  env: Env,
  client: LlmClient,
  dish: string,
): Promise<EstimateResponse> {
  const reply = await client.chat({
    model: env.OLLAMA_MODEL_LARGE,
    messages: estimateMessages(dish),
    json: true,
    // Zero. Unlike a recipe, where variety is the point, two different answers
    // for the same burger are two different intake series.
    temperature: 0,
    timeoutMs: env.OLLAMA_JOB_TIMEOUT_MS,
  });

  if (!reply.ok) return { available: false, reason: reply.reason };

  const read = readDishEstimate(reply.content);
  if (!read.ok) return { available: false, reason: read.reason };

  return {
    available: true,
    kcal: Math.round(read.estimate.kcal),
    kcalLow: Math.round(read.estimate.kcalLow),
    kcalHigh: Math.round(read.estimate.kcalHigh),
    proteinG: read.estimate.proteinG ?? null,
    carbsG: read.estimate.carbsG ?? null,
    fatG: read.estimate.fatG ?? null,
    grams: Math.round(read.estimate.grams),
    basis: read.estimate.basis,
    confidence: read.confidence,
    model: reply.model,
    ms: reply.ms,
  };
}
