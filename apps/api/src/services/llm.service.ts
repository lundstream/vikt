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
  PHOTO_CONFIDENCE,
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
import { PARSE_SCHEMA, parseFoodMessages, readParsedFood } from "../llm/parse-food.js";
import { parsePhotoMessages, readParsedPhoto } from "../llm/parse-photo.js";
import { LABEL_SCHEMA, readLabel, readLabelMessages } from "../llm/read-label.js";
import { RECIPE_SCHEMA, readRecipe, readRecipeMessages } from "../llm/read-recipe.js";
import type { ReadLabelResponse, ReadRecipeResponse, RecipeRow } from "shared";
import { hasTwoSets, parseRecipeLine, parseYield, ratioChecks, recipeSets } from "shared";
import { RateLimiter } from "../lib/rate-limit.js";
import { visionAvailable } from "../lib/vision-watch.js";
import { COACH_TURNS_PER_HOUR } from "./coach.service.js";
import { recipeMessages, readGeneratedRecipe } from "../llm/recipe.js";
import { checkCompleteness, type CompletenessFailure } from "../llm/recipe-completeness.js";
import { estimateMessages, readDishEstimate } from "../llm/estimate.js";
import { getInsights } from "./insights.service.js";
import { countLoggedFoods, searchFoodItems, type FoodItemRow } from "../repositories/food.repo.js";
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

export async function llmHealth(
  env: Env,
  client: LlmClient,
  db: Db,
): Promise<LlmHealth> {
  return {
    configured: client.enabled,
    reachable: await client.reachable(),
    models: { small: env.OLLAMA_MODEL_SMALL, large: env.OLLAMA_MODEL_LARGE },
    /**
     * The boot check's verdict, not the configuration (D143). A model name in
     * the environment says what an operator intended; this says whether the tag
     * was sent a picture and described it.
     */
    vision: await visionAvailable(db, env),
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
    // The shape enforced while sampling, not only checked afterwards (D199).
    schema: PARSE_SCHEMA,
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
 * A photograph of a nutrition declaration, transcribed (D190).
 *
 * The same transport rules as the plate photo, and the same allowance, because
 * it is the same kind of request to the same single GPU: the image is decoded
 * from the request, handed to Ollama and dropped, never written to a table, a
 * file or a log line (`photo-transport.test.ts` holds this path too). What
 * comes back is a **transcription for a person to confirm**, not a food: this
 * writes nothing, and `createLabelFood` refuses figures that do not add up.
 */
export async function readNutritionLabel(
  userId: string,
  env: Env,
  client: LlmClient,
  input: { image: string },
  log?: { info: (data: object, message: string) => void },
): Promise<ReadLabelResponse> {
  const model = env.LLM_VISION_MODEL.trim();
  if (model === "") return { available: false, reason: "not_configured" };

  const limit = photoLimiter.check(`photo:${userId}`);
  if (!limit.allowed) {
    return { available: false, reason: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds };
  }

  const reply = await client.chat({
    model,
    messages: readLabelMessages(input.image),
    schema: LABEL_SCHEMA,
    temperature: 0,
    timeoutMs: env.OLLAMA_VISION_TIMEOUT_MS,
  });
  if (!reply.ok) return { available: false, reason: reply.reason };

  const parsed = readLabel(reply.content);
  if (!parsed.ok) return { available: false, reason: parsed.reason };

  /** Counts only: no figure, no name, no bytes. */
  log?.info(
    {
      model: reply.model,
      ms: reply.ms,
      kb: Math.round((input.image.length * 3) / 4 / 1024),
      columns: parsed.label.columns,
      figures: Object.values(parsed.label).filter((value) => typeof value === "number").length,
    },
    "label read",
  );

  return { available: true, label: parsed.label, model: reply.model, ms: reply.ms };
}

/**
 * A photograph of a recipe's ingredient list, read into rows (D195).
 *
 * The model copies lines; `shared/recipe-photo.ts` reads them; the database
 * prices them. The same transport and allowance as the label and the plate,
 * because it is the same kind of request to the same GPU: the image is handed
 * to Ollama and dropped, never written to a table, a file or a log line.
 *
 * Every row comes back with its grams **for each amount set the recipe
 * prints**, so choosing a set on screen needs no second request and the model
 * is never asked which one was meant. It writes nothing: the rows go into the
 * meal sheet, where a person keeps or removes each one.
 */
export async function readRecipePhoto(
  userId: string,
  db: Db,
  env: Env,
  client: LlmClient,
  input: { image: string },
  log?: { info: (data: object, message: string) => void },
): Promise<ReadRecipeResponse> {
  const model = env.LLM_VISION_MODEL.trim();
  if (model === "") return { available: false, reason: "not_configured" };

  const limit = photoLimiter.check(`photo:${userId}`);
  if (!limit.allowed) {
    return { available: false, reason: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds };
  }

  const reply = await client.chat({
    model,
    messages: readRecipeMessages(input.image),
    schema: RECIPE_SCHEMA,
    temperature: 0,
    timeoutMs: env.OLLAMA_VISION_TIMEOUT_MS,
  });
  if (!reply.ok) return { available: false, reason: reply.reason };

  const read = readRecipe(reply.content);
  if (!read.ok) return { available: false, reason: read.reason };

  const lines = read.recipe.rows.map((row) => parseRecipeLine(row.line));
  const twoSets = hasTwoSets(lines);
  const checks = twoSets ? ratioChecks(lines) : lines.map(() => false);

  const found = await Promise.all(
    lines.map((line) => (line.searchName === null ? null : matchRow(userId, db, line.searchName))),
  );
  const ids = found.filter((row) => row !== null).map((row) => row!.id);
  const userHints = await userHintsFor(userId, db, ids);

  const rows: RecipeRow[] = lines.map((line, index) => {
    const row = found[index] ?? null;
    const packet = (row?.servingHints as ServingHints | null) ?? null;
    const own = row ? (userHints.get(row.id) ?? null) : null;
    const household = householdHints(row?.category);
    const hints = packet || household ? { ...(household ?? {}), ...(packet ?? {}) } : null;

    /* The photo path's own conversion, so a recipe converts what a plate does. */
    const convert = (count: number, unit: string) =>
      row === null ? null : photoAmount({ count, unit }, hints, own).grams;
    const sets = recipeSets(line, twoSets, convert);
    const priced = sets.map((set) => ({
      ...set,
      kcal: row === null || set.grams === null ? null : priceRow(row, set.grams, hints, own).kcal,
    }));
    const match = row === null ? null : priceRow(row, null, hints, own);

    return {
      line: line.printed,
      section: read.recipe.rows[index]!.section,
      name: line.searchName ?? line.name,
      reference: line.reference,
      check: checks[index] ?? false,
      sets: priced,
      match: match === null
        ? null
        : {
            foodItemId: match.foodItemId,
            name: match.name,
            brand: match.brand,
            kcalPer100: match.kcalPer100,
            servingHints: match.servingHints,
          },
    };
  });

  /** Counts only: no line, no name, no bytes. */
  log?.info(
    {
      model: reply.model,
      ms: reply.ms,
      kb: Math.round((input.image.length * 3) / 4 / 1024),
      rows: rows.length,
      matched: rows.filter((row) => row.match !== null).length,
      twoSets,
      checks: checks.filter(Boolean).length,
    },
    "recipe read",
  );

  return {
    available: true,
    title: read.recipe.title,
    yield: parseYield(read.recipe.yield),
    twoSets,
    rows,
    model: reply.model,
    ms: reply.ms,
  };
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

    /**
     * A row that came with a package weight has no amount (D143, amended).
     *
     * The model read "1000 G" off a bag of meatballs and offered it as how much
     * was being eaten; the database priced it at 2 173 kcal, one tap from the
     * day's intake. The prompt now asks for that figure as `packageG` instead,
     * and this drops whatever landed in `amount` beside it — enforced rather
     * than asked for, because a reply that has told us the number is a packet
     * has told us it is not a helping, and a model that puts it in both fields
     * is exactly the case worth defending against.
     */
    const amount =
      typeof item.packageG === "number"
        ? { grams: null, source: "unknown" as const, portion: null }
        : photoAmount(item.amount ?? null, hints, own);

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
export async function matchRow(userId: string, db: Db, name: string): Promise<FoodItemRow | null> {
  /**
   * A handful of candidates rather than one, and the first *plausible* one.
   *
   * The ranking is tuned for a person reading a list of twenty: a near-miss at
   * the top is harmless there, because the reader skips it. Taking the top row
   * unread is a different job with a much higher bar, and the first live run
   * showed exactly why — "kycklingfilé" came back as "Korv kycklingkorv" and
   * "fetaost" as "Grekisk sallad m. fetaost", both priced with full confidence.
   *
   * Twenty, not five (D196): a stricter test needs the right row to be among
   * the candidates, and the ranking puts compounds that merely start with the
   * word ("Mjölkchoklad" for "mjölk") ahead of it often enough.
   */
  const first = await searchFoodItems(userId, db, name, MATCH_CANDIDATES);

  /*
    A compound the catalogue writes apart is not in the search's twenty: the
    search cannot see "nötfärs" in "Nöt färs rå fett 10%". So when nothing
    matches fully, the query is searched again with each compound split in two
    ("nöt färs"), and those rows are judged by the same rule against the query
    as asked, which still needs every half (D198).
  */
  let rows = first;
  if (!first.some((row) => matchStrength(name, row.name) === "full")) {
    const seen = new Set(first.map((row) => row.id));
    rows = [...first];
    for (const alternative of compoundSplits(name)) {
      for (const row of await searchFoodItems(userId, db, alternative, MATCH_CANDIDATES)) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          rows.push(row);
        }
      }
    }
  }

  /*
    A row that names the part asked for beats one that does not (D198), and
    only when none does is the food without it taken: "Kyckling bröstfilé"
    for "kycklingbröst", "Vitlök" for "vitlöksklyftor".
  */
  const strengths = rows.map((row) => matchStrength(name, row.name));
  const wanted = strengths.includes("full") ? "full" : strengths.includes("part") ? "part" : null;
  if (wanted === null) return null;
  const plausible = rows.filter((_, index) => strengths[index] === wanted);
  if (plausible.length === 1) return plausible[0]!;

  /*
    Among rows the rule accepts, the one this person has logged most, then the
    search's order, which is total (Livsmedelsverket first among equals, then
    id), so the same person asking the same thing gets the same food (D198).
    History only chooses among accepted rows; it never makes a refused one
    plausible, because the refused ones are not in this list.
  */
  const logged = await countLoggedFoods(userId, db, plausible.map((row) => row.id));
  // Array.prototype.sort is stable, so equals keep the search's order.
  return [...plausible].sort((a, b) => (logged.get(b.id) ?? 0) - (logged.get(a.id) ?? 0))[0]!;
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

/** How many search rows `matchRow` reads before saying there is no match (D196). */
export const MATCH_CANDIDATES = 20;

/**
 * Whether a database row is the food that was named, and how closely.
 *
 * Each rule exists because of a specific wrong answer from a live run against
 * the real database (D72, D196, D198).
 *
 * **A row is its head and a tail.** Food names in this database mark the
 * "contains" relation explicitly — "Grekisk sallad m. fetaost", "Fatteh m.
 * kyckling", "Pannkaka med ägg" — and the words asked for are looked for only
 * in the part before that connector, which is what separates "Kyckling kokt
 * m. salt", which is chicken, from "Fatteh m. kyckling", which is not. **The
 * tail must still describe the food** (D198): after "m." the catalogue puts
 * either a preparation medium ("m. salt", "m. lag", "m. skinn") or another food
 * ("m. köttfärs", "m. curry"), and the second makes the row a dish, a variety
 * of whatever the head names. "Pizza m. ost restaurang" is not "pizza".
 *
 * **The head's first word is one of the words asked for.** These names put the
 * food first and what describes it after ("Ägg rått", "Spenat färsk", "Lök
 * gul"), so a name that starts with something else is a dish or a product that
 * contains the food: "Lasagne nötfärs" is lasagne. The query may give its words
 * in any order; "gula lökar" reaches "Lök gul".
 *
 * **Every word asked for is there, as itself or inflected**: the same stem with
 * a short ending from a closed set, in either direction (tomat, tomater; lök,
 * lökar; klyfta, klyftor). Any other remainder is another word: Swedish
 * compounds put the head last, so "mjölkchoklad" is a chocolate and
 * "pepparrot" a root. Two kinds of compound are read further (D198):
 *
 *  - **A part of a food**: when the second half names a part or a portion of
 *    the first ("basilikablad", "vitlöksklyftor", "kycklingbröst"), the food is
 *    the first half and the part is a qualifier, present or not. A row that
 *    names the part ("Kyckling bröstfilé") is preferred to one that does not
 *    ("Vitlök" for "vitlöksklyftor"), which is taken only when none does.
 *  - **A compound written apart**: the catalogue writes some compounds as two
 *    words ("Nöt färs" for nötfärs), so a query compound matches a head that
 *    has **all** of its halves as separate words, and only all of them:
 *    "pepparrot" can never become "Peppar".
 *
 *   Neither applies to a half that changes what the food is: a
 *   köttbuljongtärning is a concentrate, and "Köttbuljong tärning ätf." is
 *   broth, so "tärning" is neither a part nor a half (D198).
 *
 * **Everything else in the name describes the food, or the row is refused.**
 * Qualifiers name preparation, state, measure (fat, salt, alcohol), colour and
 * nothing else, as many as the name has ("Smör osaltat fett ca 80%" is
 * butter). A variety, a flavour or a dish word is not one: "Pizza veg.
 * hemlagad", "Yoghurt vanilje" and "Kyckling mage rå" are each a guess about
 * which pizza, yoghurt or part was meant. The lists were counted from the
 * catalogue, not guessed (D196, D198).
 *
 * Failing any of them leaves `match` null, which is a first-class outcome
 * everywhere this is used: the row keeps its name, shows no energy, and says
 * so. An honest gap beats a confident wrong number.
 */
const CONTAINS_CONNECTOR = /\s(?:m\.|med|innehåller)\s|[,&+/]/i;

/** The endings an inflected form adds to its stem, both directions (D196). */
const INFLECTIONS = ["", "a", "e", "n", "t", "en", "et", "er", "ar", "or", "na", "erna", "arna", "orna"];

/**
 * Words that describe a food rather than name one: preparation, state, measure
 * and colour, each found after the first word of a Livsmedelsverket name in
 * the development catalogue at least once (D196). Varieties, flavours and
 * dish words were taken out (D198): "veg.", "fullkorn", "smaksatt", "kryddad",
 * sweetening ("sötad", "lättsockrad"), the free-from variants ("glutenfri",
 * "laktosfri"), provenance ("hemlagad", "restaurang", "storhushåll"), texture
 * that names a kind ("grovt", "mjukt", "fylld") and "blandad". What stays is
 * what could be said of any one food without making it another.
 */
const QUALIFIERS = new Set([
  // measure: fat, salt and alcohol content
  "fett", "fetthalt", "vol", "ca", "light", "lätt", "lätta", "mager",
  "osaltat", "saltad", "saltade", "lågsalt", "extrasaltad", "extrasaltat",
  // raw, cooked and how
  "rå", "rått", "råa", "stekt", "stekta", "ugnsstekt", "ugnsstekta", "råstekt", "kokt", "kokta",
  "okokt", "okokta", "inkokt", "ångkokt", "ångprep", "tillagad", "tillagat", "tillagade",
  "bakad", "gräddad", "brungräddat", "normalgräddat", "grillad", "grillat", "friterad",
  "friterade", "friterat", "panerad", "panerade", "panerat", "wokad", "wokade", "brynt", "fräst",
  "gratinerad", "stuvad", "stuvade", "råstuvad", "värmd", "värmda", "förvälld", "förvällda",
  "bryggt", "rostad", "rostade", "rostat", "ugnsrostad", "rökt", "varmrökt", "kallrökt",
  "lättrökt", "flatrökt", "rundrökt", "orökt", "gravad", "rimmad", "rimmat", "inlagd", "syltade",
  "marinerad", "marinerade", "urvattnad", "lufttorkad", "torkad", "torkade", "torkat",
  "fermenterad", "fermenterat", "fermenterade", "pastöriserad", "färskpressad", "kallpressad",
  "vispad", "puffat", "mald", "krossad", "krossade", "riven", "skivad", "skivade", "strimlad",
  "tärnad", "putsad", "bortskuret", "avfettat", "renat", "berikad",
  // unflavoured and unsweetened: the plain food, not a kind of it
  "naturell", "naturella", "osötad", "osötat", "osötade",
  // state
  "färsk", "färska", "fryst", "frysvara", "kylvara", "kyld", "konserv", "pulver", "konc",
  "drickf", "ätf", "förpackad", "flytande", "hel", "hela", "eko", "odlad", "vildfångad",
  // colour, which tells varieties of one food apart
  "vit", "vitt", "vita", "röd", "rött", "röda", "gul", "gult", "svart", "svarta", "grönt",
  "brunt", "mörkt",
]);

/**
 * What may follow "m." and leave the row the food itself (D198): a preparation
 * medium, the skin, peel or bone a cut keeps, or a fortification. Counted from
 * the words after " m. " in the catalogue: "salt" 111, "skinn" 19, "vatten" 15,
 * "lag" 11, "olja" and "rapsolja" 12, "skal" 6. Everything else there is a food
 * ("mjölk" 20, "frukt" 17, "ost" 11, "köttfärs" 9) and makes the row a dish.
 */
const MEDIA = new Set(["salt", "vatten", "lag", "olja", "rapsolja", "skinn", "skal", "ben", "jod"]);

/**
 * Words after which the next one qualifies: "u. salt", "i olja", "el. grillad".
 * Not "typ": what follows it names a type, which is a variety (D198).
 */
const QUALIFYING_MARKERS = new Set(["u", "utan", "i", "el", "eller"]);

/** The connector's own words, which a tail may contain. */
const CONNECTOR_WORDS = new Set(["m", "med", "innehåller"]);

/**
 * Parts and portions of a food, from the catalogue ("filé" 19, "bog" 11,
 * "bitar" 9, "bröstfilé" 7, "kotlett" 5, "lägg" 5, "blad" 3, "lår" 3, "skiva"
 * 3, "vinge" 1) and the two recipe photos ("blad", "klyftor"). Skin, bone and
 * the organs are left out, because each is a different food (D198).
 */
const PARTS = ["blad", "klyfta", "bröst", "bröstfilé", "filé", "lår", "skiva", "vinge", "klubba", "bit", "kotlett", "lägg", "bog"];

/** Halves that change what the food is: neither a part nor a compound written apart (D198). */
const FORMS = ["tärning", "pulver", "koncentrat"];

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zà-öø-ÿ0-9]+/i)
    .filter((word) => word.length > 0);
}

/** The same word, or the same stem with two endings from the set. */
function sameWord(asked: string, candidate: string): boolean {
  if (asked === candidate) return true;
  const [short, long] = asked.length <= candidate.length ? [asked, candidate] : [candidate, asked];
  for (const shortEnding of INFLECTIONS) {
    if (!short.endsWith(shortEnding)) continue;
    const stem = short.slice(0, short.length - shortEnding.length);
    if (stem.length < 3 || !long.startsWith(stem)) continue;
    if (INFLECTIONS.includes(long.slice(stem.length))) return true;
  }
  return false;
}

const inList = (word: string, list: string[]) => list.some((entry) => sameWord(entry, word));

/**
 * The ways one asked word can be present in a name: as itself; as a compound
 * written apart (every half required); or as a food and a part of it (the food
 * required, the part only preferred).
 */
type Reading = { required: string[]; part: string | null };

function readings(word: string): Reading[] {
  const found: Reading[] = [{ required: [word], part: null }];
  for (let cut = 3; cut <= word.length - 3; cut += 1) {
    const second = word.slice(cut);
    if (inList(second, FORMS)) continue;
    const firsts = [word.slice(0, cut)];
    // A linking s ("vitlöks-klyftor") belongs to neither half.
    if (firsts[0]!.endsWith("s") && cut - 1 >= 3) firsts.push(word.slice(0, cut - 1));
    for (const first of firsts) {
      found.push({ required: [first, second], part: null });
      if (inList(second, PARTS)) found.push({ required: [first], part: second });
    }
  }
  return found;
}

/** A word of the name that is only what describes the food. */
function describes(words: string[], index: number, extra: Set<string> = new Set()): boolean {
  const word = words[index]!;
  return (
    /\d/.test(word) ||
    QUALIFIERS.has(word) ||
    QUALIFYING_MARKERS.has(word) ||
    extra.has(word) ||
    (index > 0 && QUALIFYING_MARKERS.has(words[index - 1]!))
  );
}

/**
 * "full" when the row is the food named, with every part named present;
 * "part" when it is the food and a part the query named is not in the name;
 * null when it is not the food (D198).
 */
export function matchStrength(query: string, name: string): "full" | "part" | null {
  const connector = name.search(CONTAINS_CONNECTOR);
  const head = connector < 0 ? name : name.slice(0, connector);
  const tail = connector < 0 ? "" : name.slice(connector);

  const asked = significantWords(query);
  const found = significantWords(head);
  if (asked.length === 0 || found.length === 0) return null;

  // The tail describes the food, or the row is a dish.
  const after = significantWords(tail);
  if (!after.every((_, index) => describes(after, index, new Set([...MEDIA, ...CONNECTOR_WORDS])))) {
    return null;
  }

  // Each asked word's readings that could be present at all in this head.
  const options = asked.map((word) =>
    readings(word).filter((reading) =>
      reading.required.every((need) => found.some((candidate) => sameWord(need, candidate))),
    ),
  );
  if (options.some((list) => list.length === 0)) return null;

  let best: "full" | "part" | null = null;
  const choose = (at: number, taken: Set<number>, lead: boolean, dropped: number): void => {
    if (best === "full") return;
    if (at === asked.length) {
      // The food is named first, and the rest describes it.
      if (!lead) return;
      if (!found.every((_, index) => taken.has(index) || describes(found, index))) return;
      const strength = dropped === 0 ? "full" : "part";
      if (best === null || strength === "full") best = strength;
      return;
    }
    for (const reading of options[at]!) {
      const next = new Set(taken);
      let first = lead;
      let ok = true;
      for (const need of reading.required) {
        const index = found.findIndex((candidate, i) => !next.has(i) && sameWord(need, candidate));
        if (index < 0) {
          ok = false;
          break;
        }
        next.add(index);
        if (index === 0) first = true;
      }
      if (!ok) continue;
      let missing = 0;
      if (reading.part !== null) {
        const part = reading.part;
        const index = found.findIndex(
          (candidate, i) => !next.has(i) && (sameWord(part, candidate) || candidate.startsWith(part)),
        );
        if (index < 0) missing = 1;
        else next.add(index);
      }
      choose(at + 1, next, first, dropped + missing);
    }
  };
  choose(0, new Set(), false, 0);
  return best;
}

/**
 * The query again with one compound written apart, for each way a compound in
 * it splits into two halves of three letters or more (D198): "nötfärs" gives
 * "nöt färs" and "nötf ärs". Only for the search; the rule still judges every
 * row against the query as asked.
 */
export function compoundSplits(query: string): string[] {
  const words = significantWords(query);
  const alternatives = new Set<string>();
  words.forEach((word, at) => {
    for (const reading of readings(word)) {
      if (reading.required.length !== 2) continue;
      const replaced = [...words.slice(0, at), ...reading.required, ...words.slice(at + 1)];
      alternatives.add(replaced.join(" "));
    }
  });
  return [...alternatives];
}

/** Whether the row is the food named at all, at either strength. */
export function isPlausibleMatch(query: string, name: string): boolean {
  return matchStrength(query, name) !== null;
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
