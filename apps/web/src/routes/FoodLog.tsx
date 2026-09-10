import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import type { FoodEntry, FoodItem, MealTemplate } from "shared";
import {
  allPortionUnits,
  resolveDefaultAmount, MIN_SEARCH_LENGTH, formatDecimal, formatKcal, sumOrNull } from "shared";
import { useMe } from "../lib/session.js";
import {
  useDeletePortion,
  useFavourites,
  useLlmHealth,
  usePortions,
  useSavePortion,
  useSetFavourite,
  useApplyTemplate,
  useBarcodeLookup,
  useFoodEntries,
  useFoodSearch,
  useRecentFoods,
  useSaveFoodEntry,
  useUpdateFoodEntry,
  useUpdateTemplate,
  useDeleteTemplate,
  useTemplates,
  useCreateTemplate,
  useDeleteFoodEntry,
} from "../lib/food.js";
import { formatLongDay } from "../lib/dates.js";
import { useLogDate } from "../lib/log-date.js";
import { ApiError } from "../lib/api.js";
import { clientUuid } from "../lib/uuid.js";
import { SaveStalled } from "../lib/queue/enqueue.js";
import { readRequiredNumber } from "../lib/form-number.js";
import { BarcodeScanner } from "../components/BarcodeScanner.js";
import { DeleteButton } from "../components/DeleteButton.js";
import { Field, fieldAria } from "../components/Field.js";
import { Disclosure } from "../components/Disclosure.js";
import { DateSelector } from "../components/DateSelector.js";
import { FoodTextEntry } from "../components/FoodTextEntry.js";
import { RecipeSuggestion } from "../components/RecipeSuggestion.js";
import { Sheet } from "../components/Sheet.js";
import { EstimateEntry } from "../components/EstimateEntry.js";
import { ActionButton, barcodeIcon } from "../components/QuickActions.js";
import {
  type TranslationKey, LOCALE, t } from "../i18n/index.js";

/**
 * The logging screen.
 *
 * The highest-traffic surface in the app and the one that decides whether it is
 * still in use in three months, so the whole layout is arranged around **tap
 * count**, not visual richness:
 *
 *  - **recent foods first**, because the food someone is about to log is
 *    almost always one they have logged before. One tap logs it again at the
 *    same portion — no sheet, no confirmation, no grams field;
 *  - **saved meals next**, one tap for a whole breakfast;
 *  - **scan and search after that**, because both are slower and rarer;
 *  - nothing is behind a menu, and the day's running total is always visible so
 *    logging never requires navigating away to see what it did.
 */
/**
 * How many recent entries sit on the screen.
 *
 * The query fetches twelve and this shows six. Twelve rows unfolded is the
 * ledger the disclosure was hiding; six is the last day or two, which is what
 * "again" actually means. The rest are still reachable: they are in the day's
 * list below, and anything older is a search away.
 */
const RECENT_ON_SCREEN = 6;

/**
 * The estimate marker (profile, page 6).
 *
 * A dashed edge and a `≈` prefix, in Sten, and **no accent** — the profile is
 * explicit that uncertainty is not one of the five areas and does not get a
 * colour of its own. The dash and the glyph say it as well as the colour does,
 * which is the rule that colour is never alone in saying what something is.
 */
function EstimateTag() {
  return (
    <span className="tag tag-estimate ml-2 align-middle">
      <span aria-hidden="true">≈</span>
      {t("estimate.badge")}
    </span>
  );
}

/**
 * What to say when a save did not happen.
 *
 * Three cases, because they call for three different next steps. A stall means
 * the device stopped answering and the tap is worth repeating; a refusal from
 * the server has its own Swedish message already and is shown verbatim;
 * anything else is unknown and says so rather than inventing a cause.
 */
function saveProblem(error: unknown): string {
  if (error instanceof SaveStalled) {
    return error.step === "queue" ? t("save.stalledQueue") : t("save.stalledSend");
  }
  if (error instanceof ApiError) return error.message;
  return t("save.failed");
}

export function FoodLog() {
  const me = useMe();
  const timezone = me.data?.profile.timezone ?? "Europe/Stockholm";

  /**
   * The day being logged to, shared with Dagen (D62). Named `today` throughout
   * this file because that is what every call site below already means by it:
   * the day the entries belong to.
   */
  const { date: today, today: deviceToday, isToday } = useLogDate();
  const dayWord = isToday ? t("quick.today").toLowerCase() : t("food.dayThis");

  const recent = useRecentFoods(12);
  const templates = useTemplates();
  const todayEntries = useFoodEntries(today, today);
  const saveEntry = useSaveFoodEntry(timezone);
  const applyTemplate = useApplyTemplate();

  /**
   * `?skanna` opens the camera on arrival, so the dashboard's scan action is
   * one tap rather than two. The same pattern the weight sheet uses for
   * `/?logga`: a link works from a cold start and from an offline shell, where
   * shared state does not exist yet.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const [scannerOpen, setScannerOpen] = useState(() => searchParams.has("skanna"));
  /** Which occasional tool is open, if any. */
  const [tool, setTool] = useState<"text" | "recipe" | "estimate" | null>(null);
  /**
   * Whether the optional layer is up, asked once here rather than inside each
   * tool. The two sheets ask for it too and share the query key, so this is the
   * same request; what it buys is that the *buttons* disappear with the layer,
   * which is what "no trace when the box is off" means from outside a sheet.
   */
  const llm = useLlmHealth();
  const favourites = useFavourites();
  const [query, setQuery] = useState("");
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [pending, setPending] = useState<FoodItem | null>(null);

  /** True while a whole day is being copied forward (D124). */
  const [copyingDay, setCopyingDay] = useState(false);

  /**
   * Picking a food ends the search (D122).
   *
   * The results list used to stay behind the portion sheet and still be there
   * when it closed, so logging two things in a row meant clearing the field by
   * hand between them. The query is what drives the list, so clearing it is
   * what dismisses it; `searchEnabled` goes back to false so a keystroke does
   * not re-run the search that was just answered.
   *
   * Focus needs no work here: the amount field inside the sheet carries
   * `autoFocus`, which is the right place for it — the sheet owns the field, so
   * the sheet decides what is focused when it opens.
   */
  function choose(item: FoodItem) {
    setPending(item);
    setQuery("");
    setSearchEnabled(false);
  }
  const [flash, setFlash] = useState<string | null>(null);
  /**
   * Which row is being saved, by id.
   *
   * Not the mutation's `isPending`: one instance serves the whole list, so that
   * flag disables every row at once and never comes back if a save stalls.
   */
  const [savingId, setSavingId] = useState<string | null>(null);

  const search = useFoodSearch(query, searchEnabled);
  const lookup = useBarcodeLookup();

  /**
   * Null until something is logged, never 0.
   *
   * This header used to read "0 kcal i dag" on an empty day while the dashboard
   * said "Inte än" for the same day, which is the absent-is-not-zero rule broken
   * on one screen and kept on the other. A day with nothing logged is a day we
   * know nothing about; a day logged as 0 is a fast (`calc/intake.ts`).
   */
  const dayTotal = useMemo(
    () =>
      todayEntries.data === undefined
        ? undefined
        : sumOrNull(todayEntries.data.map((entry) => entry.kcal)),
    [todayEntries.data],
  );

  if (me.isPending) return null;
  if (!me.data) return <Navigate to="/login" replace />;

  /**
   * The one-line notice under the header.
   *
   * A failure stays up four times as long as a confirmation. "Loggad" is a
   * receipt for something the user already knows they did; a message saying the
   * save did not happen is the only chance they have to notice, and 1.6 seconds
   * is not long enough to read one on a phone in a shop.
   */
  function announce(message: string, problem = false) {
    setFlash(message);
    setTimeout(() => setFlash(null), problem ? 6000 : 1600);
  }

  /**
   * One tap: the same food, the same portion, today.
   *
   * Two things here are not incidental.
   *
   * **The pending row is tracked by id**, not by the mutation's own
   * `isPending`. One `useMutation` instance is shared by every row in the list,
   * so disabling on `saveEntry.isPending` disabled *all* of them the moment one
   * was tapped, and left the whole list dead if that one never settled. Which
   * is what "logging from recent does not work" looked like from outside.
   *
   * **A failure is said out loud.** This used to `await` with no catch, so a
   * rejected save produced an unhandled rejection and no message at all: the
   * tap did nothing, visibly and permanently. §3 forbids a failure *state*, not
   * a failure *message*, and D42 is explicit that a write the app could not
   * make is one it has to admit to.
   */
  async function logAgain(entry: FoodEntry) {
    setSavingId(entry.id);
    try {
      await saveEntry.mutateAsync({
        clientUuid: clientUuid(),
        localDate: today,
        mealSlot: entry.mealSlot,
        foodItemId: entry.foodItemId,
        freetext: entry.foodItemId ? null : entry.name,
        grams: entry.grams,
        kcal: entry.foodItemId ? null : entry.kcal,
        confidence: entry.confidence,
        confirmed: true,
      });
      announce(t("food.logged", { name: entry.name }));
    } catch (error) {
      announce(saveProblem(error), true);
    } finally {
      setSavingId(null);
    }
  }

  /**
   * Copies one past entry onto **the device's own today** (D124).
   *
   * The date is `deviceToday`, not the selected `today`, and that is the whole
   * difference between this and "Igen" below. Both put a row in the log; they
   * put it on different days:
   *
   *  - **"Igen", under Senast loggat**, writes to the day being *viewed*. That
   *    is backfilling — somebody filling in last Tuesday wants last Tuesday.
   *  - **"Logga i dag", on a past day's rows**, writes to *today*. That is
   *    somebody looking at yesterday and eating the same thing again.
   *
   * Passing the device's own day is also what makes `dateSource` come out as
   * `device` rather than `chosen` without this function saying so: `enqueue`
   * compares the supplied date against the boundary the device would have
   * computed, and equality means `device` (D61). Writing "today" here is
   * therefore a statement about a clock, which is exactly what it is.
   *
   * A fresh `clientUuid` per copy, because this is a new row and not an
   * amendment of the one being copied.
   */
  async function copyToToday(entry: FoodEntry) {
    setSavingId(entry.id);
    try {
      await saveEntry.mutateAsync({
        clientUuid: clientUuid(),
        localDate: deviceToday,
        mealSlot: entry.mealSlot,
        foodItemId: entry.foodItemId,
        freetext: entry.foodItemId ? null : entry.name,
        grams: entry.grams,
        kcal: entry.foodItemId ? null : entry.kcal,
        confidence: entry.confidence,
        confirmed: true,
      });
      announce(t("food.copiedToToday", { name: entry.name }));
    } catch (error) {
      announce(saveProblem(error), true);
    } finally {
      setSavingId(null);
    }
  }

  /**
   * The whole day, for somebody who ate the same as yesterday.
   *
   * Sequential rather than `Promise.all`: each write goes through the offline
   * queue, and a burst of parallel IndexedDB transactions on a phone is how
   * D118's stall was reached. One at a time is fast enough for a day's worth of
   * rows and cannot wedge the store.
   *
   * A partial result is reported as a partial result. If the fourth of six
   * fails there is no undo here and no pretending: the count says how many
   * landed, and the rest are still on the day being viewed to try again.
   */
  async function copyDayToToday(entries: FoodEntry[]) {
    setCopyingDay(true);
    let copied = 0;
    try {
      for (const entry of entries) {
        await saveEntry.mutateAsync({
          clientUuid: clientUuid(),
          localDate: deviceToday,
          mealSlot: entry.mealSlot,
          foodItemId: entry.foodItemId,
          freetext: entry.foodItemId ? null : entry.name,
          grams: entry.grams,
          kcal: entry.foodItemId ? null : entry.kcal,
          confidence: entry.confidence,
          confirmed: true,
        });
        copied += 1;
      }
      announce(t("food.copiedDay", { n: copied }));
    } catch (error) {
      announce(
        copied === 0
          ? saveProblem(error)
          : t("food.copiedDayPartial", { n: copied, total: entries.length }),
        true,
      );
    } finally {
      setCopyingDay(false);
    }
  }

  async function logTemplate(template: MealTemplate) {
    setSavingId(template.id);
    try {
      await applyTemplate.mutateAsync({
        templateId: template.id,
        input: {
          localDate: today,
          clientUuids: template.items.map(() => clientUuid()),
        },
      });
      announce(t("food.loggedMeal", { name: template.name }));
    } catch (error) {
      announce(saveProblem(error), true);
    } finally {
      setSavingId(null);
    }
  }

  function closeScanner() {
    setScannerOpen(false);
    // Drop the parameter, or coming back to this screen reopens the camera.
    if (searchParams.has("skanna")) setSearchParams({}, { replace: true });
  }

  async function onBarcode(barcode: string) {
    closeScanner();
    const result = await lookup.mutateAsync(barcode);
    if (result.item) {
      setPending(result.item);
      return;
    }
    announce(result.problem?.message ?? result.notice ?? t("food.barcodeMiss"));
  }

  return (
    <div className="min-h-dvh pb-28">
      <main className="mx-auto w-full max-w-3xl px-5 py-8">
        <header className="mb-6 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-title text-ink">
              {t("food.title")}
            </h1>
            {/*
              Blåbär on the figure, Sten on the words around it (profile,
              page 8). Only the number is nutrition; "inget loggat i dag än" is
              a statement about the log, and an uncertain one gets no accent.
            */}
            <p
              className={`num mt-1 text-note ${
                typeof dayTotal === "number" ? "text-nutrition" : "text-muted"
              }`}
            >
              {/* Three states, not two: still loading, nothing logged, a total. */}
              {/*
                The day is named rather than assumed. This read "i dag"
                whichever date was showing, which on a backfill is the app
                stating something false about the number beside it.
              */}
              {dayTotal === undefined
                ? t("food.dayLoading")
                : dayTotal === null
                  ? t("food.dayNothingYet", { day: dayWord })
                  : t("food.dayTotal", { kcal: formatKcal(dayTotal), day: dayWord })}
            </p>
          </div>
          <Link className="text-note text-muted underline underline-offset-4" to="/">
            {t("profile.back")}
          </Link>
        </header>

        {/*
          Which day. Every entry below is filed under it, and a queued write
          keeps it rather than picking up the sync date (D61).
        */}
        <div className="mb-6">
          <DateSelector label={t("dateSelector.dayLabel")} />
          {isToday ? null : (
            <p role="status" className="mt-2 text-micro text-muted">
              {t("dateSelector.notToday", { date: formatLongDay(today, LOCALE) })}
            </p>
          )}
        </div>

        {flash ? (
          <p
            role="status"
            className="mb-4 rounded-lg border border-edge bg-edge/20 px-3 py-2 text-note text-ink"
          >
            {flash}
          </p>
        ) : null}

        {/*
          Scan and search first, because they are the everyday path for
          something that is not already in the lists below, and because the pair
          is one line.

          Three earlier changes stand. The scan control has **no label**: it sat
          under the circle and pushed the control taller than the field beside
          it, so nothing shared a centre line and the two halves of one action
          read as two blocks. The **heading is gone** with it, since "Hitta mat"
          above a scanner and a box labelled "Sök på namn" restated the two
          controls under it. And they are **centred against each other** rather
          than top-aligned, which is what makes them one row.
        */}
        <section aria-label={t("food.find")} className="mb-8">
          <div className="flex items-center gap-3">
            <ActionButton
              action={{
                key: "scan",
                label: "action.scan",
                icon: barcodeIcon,
                onClick: () => setScannerOpen(true),
                testId: "scan",
              }}
              labelled={false}
            />

            <div className="min-w-0 flex-1">
              <SearchBox
                query={query}
                onQuery={(value) => {
                  setQuery(value);
                  setSearchEnabled(false);
                }}
                onSubmit={() => setSearchEnabled(true)}
              />
            </div>
          </div>

          {search.data?.notice ? (
            <p role="status" className="mt-2 text-micro text-muted">
              {search.data.notice}
            </p>
          ) : null}

          {search.data && search.data.items.length > 0 ? (
            <ul className="mt-3 divide-y divide-edge border-y border-edge">
              {search.data.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-4 py-3 text-left"
                    onClick={() => choose(item)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base text-ink">{item.name}</span>
                      <span className="num block text-micro text-muted">
                        {item.brand ? `${item.brand} · ` : ""}
                        {formatDecimal(item.kcalPer100, { decimals: 0 })} kcal / 100 g
                        {item.isEstimate ? <EstimateTag /> : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/*
          The two fast paths, **not folded**.

          They were behind disclosures, which was the right answer to a
          different problem: the screen had two stacked ledgers above the search
          box. The answer to *that* was to move the search box up, which is what
          happened above, rather than to put the fastest action in the app
          behind a tap. Repeating a meal is the thing people open this screen to
          do, and a tap is a tap.

          The recent list is capped at six rather than twelve. Twelve rows is a
          ledger; six is the last day or two, which is what "again" means.
        */}
        {recent.data && recent.data.length > 0 ? (
          <div className="mb-8">
            {/*
              Folded by default, and this costs the fastest path in the app a
              tap. Recorded rather than left in a diff: repeating a food is two
              taps now, where it was one.

              What it buys is the top of the screen. Six recent rows plus saved
              meals pushed everything else below the fold, and the recent list
              is the block most often scrolled past — the food someone came to
              log is usually the one they are about to search for, not the one
              they had yesterday. Saved meals stay open, because a whole meal in
              one tap is a bigger prize than a single row.
            */}
            <Disclosure
              label={t("food.recent")}
              summary={String(recent.data.length)}
              testId="recent-foods"
            >
            <ul className="mt-2 divide-y divide-edge border-y border-edge">
              {recent.data.slice(0, RECENT_ON_SCREEN).map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    data-testid="log-again"
                    className="flex w-full items-center justify-between gap-4 py-3 text-left"
                    onClick={() => void logAgain(entry)}
                    disabled={savingId === entry.id}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base text-ink">{entry.name}</span>
                      <span className="num block text-micro text-muted">
                        {formatDecimal(entry.grams, { decimals: 0 })} g ·{" "}
                        {formatKcal(entry.kcal)} kcal
                      </span>
                    </span>
                    <span className="shrink-0 text-note text-muted">{t("food.again")}</span>
                  </button>
                </li>
              ))}
            </ul>
            </Disclosure>
          </div>
        ) : null}

        {templates.data && templates.data.length > 0 ? (
          <section aria-label={t("food.meals")} className="mb-8">
            <h2 className="mb-1 text-note text-muted">{t("food.meals")}</h2>
            <ul className="divide-y divide-edge border-y border-edge">
              {templates.data.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  onLog={() => void logTemplate(template)}
                  logging={savingId === template.id}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {/*
          Favourites: the estimates and restaurant items that recur (D80).

          Above the tools and below the fast paths, because that is what it is —
          a fast path for the food that no search will find. A pizzeria pizza is
          the most expensive row in the app to recreate and the least likely to
          turn up in a database, and it comes round most Fridays.
        */}
        {favourites.data && favourites.data.length > 0 ? (
          <section aria-label={t("food.favourites")} className="mb-8">
            <h2 className="mb-1 text-note text-muted">{t("food.favourites")}</h2>
            <ul className="divide-y divide-edge border-y border-edge">
              {favourites.data.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid={`favourite-${item.id}`}
                    className="flex w-full items-center justify-between gap-4 py-3 text-left"
                    onClick={() => setPending(item)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base text-ink">{item.name}</span>
                      <span className="num block text-micro text-muted">
                        {item.brand ? `${item.brand} · ` : ""}
                        {formatDecimal(item.kcalPer100, { decimals: 0 })} kcal / 100 g
                        {item.isEstimate ? <EstimateTag /> : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/*
          The two occasional tools, behind one clear control each (§6 phase 8).

          Both were blocks on this screen and both are used once in a while:
          describing a meal in a sentence is for the meal that fits none of the
          fast paths, and asking what to cook happens at a fridge, not at a
          keyboard. As sheets they cost a tap and return the screen to the
          everyday path. They are absent entirely when the workstation is off,
          which is the same rule as before: no error banner, no disabled
          control, no trace.
        */}
        {/*
          Typing an estimate needs no model, so that control is always here; the
          two model-backed tools are not rendered at all when the box is off.
        */}
        <div className="mb-8">
          <button
            type="button"
            data-testid="open-estimate"
            className="min-h-11 w-full rounded-lg border border-edge px-4 text-note text-ink"
            onClick={() => setTool("estimate")}
          >
            {t("estimate.open")}
          </button>
          <p className="mt-1 text-center text-micro text-muted">{t("estimate.openHint")}</p>
        </div>

        {llm.data?.reachable ? (
          <div className="mb-8 flex flex-wrap gap-3">
            <button
              type="button"
              data-testid="open-text-entry"
              className="min-h-11 flex-1 rounded-lg border border-edge px-4 text-note text-ink"
              onClick={() => setTool("text")}
            >
              {t("llm.title")}
            </button>
            <button
              type="button"
              data-testid="open-recipe"
              className="min-h-11 flex-1 rounded-lg border border-edge px-4 text-note text-ink"
              onClick={() => setTool("recipe")}
            >
              {t("recipe.title")}
            </button>
          </div>
        ) : null}

        {todayEntries.data && todayEntries.data.length > 0 ? (
          <TodaySection
            entries={todayEntries.data}
            onSaved={announce}
            today={today}
            onCopyToToday={isToday ? undefined : copyToToday}
            onCopyDay={isToday ? undefined : copyDayToToday}
            copyingDay={copyingDay}
          />
        ) : null}
      </main>

      <Sheet
        open={tool === "text"}
        onClose={() => setTool(null)}
        title={t("llm.title")}
        testId="text-entry-sheet"
      >
        <FoodTextEntry
          localDate={today}
          onLogged={(message) => {
            announce(message);
            setTool(null);
          }}
        />
      </Sheet>

      <Sheet
        open={tool === "estimate"}
        onClose={() => setTool(null)}
        title={t("estimate.title")}
        testId="estimate-sheet"
      >
        <EstimateEntry
          onCreated={(item) => {
            setTool(null);
            // Straight to the portion sheet, so the estimate that was just
            // typed can be logged without finding it again.
            setPending(item);
          }}
        />
      </Sheet>

      <Sheet
        open={tool === "recipe"}
        onClose={() => setTool(null)}
        title={t("recipe.title")}
        testId="recipe-sheet"
      >
        {/*
          Not closed on logging, unlike the sentence parser. A recipe is
          something someone is reading while cooking, and closing it the moment
          the food is logged takes the instructions away at the point they are
          still being followed.
        */}
        <RecipeSuggestion localDate={today} onLogged={announce} />
      </Sheet>

      {scannerOpen ? (
        <BarcodeScanner
          onResult={(code) => void onBarcode(code)}
          onClose={closeScanner}
        />
      ) : null}

      {pending ? (
        <PortionSheet
          item={pending}
          today={today}
          timezone={timezone}
          onClose={() => setPending(null)}
          onSaved={(name) => {
            setPending(null);
            announce(t("food.logged", { name }));
          }}
        />
      ) : null}
    </div>
  );
}

function SearchBox({
  query,
  onQuery,
  onSubmit,
}: {
  query: string;
  onQuery: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex gap-2"
    >
      <input
        id="food-search"
        className="field flex-1"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        placeholder={t("food.searchPlaceholder")}
        aria-label={t("food.find")}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      <button
        type="submit"
        data-testid="search-submit"
        className="rounded-lg border border-edge px-4 text-note text-ink disabled:opacity-50"
        // Search runs on submit, never on keystrokes: the upstream budget is
        // ten searches a minute for the whole server (D30).
        disabled={query.trim().length < MIN_SEARCH_LENGTH}
      >
        {t("food.searchAction")}
      </button>
    </form>
  );
}

/**
 * The day's entries: correctable, removable, and selectable for a saved meal.
 *
 * **The list has a fixed column structure** (D66). It was a flex row per entry
 * with each cell sized to its own content, so the amounts and the delete
 * controls wandered left and right down the page depending on how long a food's
 * name happened to be. A grid with the same track widths on every row is what
 * makes a column a column; the name gets whatever is left and truncates.
 */
function TodaySection({
  entries,
  today,
  onSaved,
  onCopyToToday,
  onCopyDay,
  copyingDay = false,
}: {
  entries: FoodEntry[];
  today: string;
  onSaved: (message: string) => void;
  /**
   * Copies one row onto the device's own today. **Undefined while viewing
   * today**, which is what hides the action rather than a flag: offering to
   * copy today's lunch to today is an action with no effect, and a control
   * that does nothing is worse than one that is absent (D124).
   */
  onCopyToToday?: (entry: FoodEntry) => Promise<void>;
  onCopyDay?: (entries: FoodEntry[]) => Promise<void>;
  copyingDay?: boolean;
}) {
  const createTemplate = useCreateTemplate();
  const deleteEntry = useDeleteFoodEntry();

  /**
   * One row open at a time (D125).
   *
   * Held here rather than in each row, because "one at a time" is a fact about
   * the list and a row cannot know what its neighbours are doing. Opening the
   * second closes the first without either row being told.
   */
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  /**
   * Which rows go into the meal.
   *
   * Saving used to take the whole day, which is wrong for the case it exists
   * for: breakfast is three of the day's nine rows, and a "meal" containing
   * dinner is not a meal anyone will apply again. Everything starts selected,
   * because the whole day is still the common case on the day you first think
   * to save one.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set(entries.map((entry) => entry.id)));
  }, [entries]);

  const chosen = entries.filter((entry) => selected.has(entry.id));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "" || chosen.length === 0) return;

    await createTemplate.mutateAsync({
      name: name.trim(),
      items: chosen.map((entry) => ({
        foodItemId: entry.foodItemId,
        // The name at the time, so deleting the food leaves a readable line (D17).
        nameSnapshot: entry.name,
        freetext: entry.foodItemId ? null : entry.name,
        grams: entry.grams,
      })),
    });
    setName("");
    setSaving(false);
    onSaved(t("food.mealSaved"));
  }

  return (
    <section aria-label={t("food.today")} className="border-t border-edge pt-6">
      <h2 className="mb-2 text-note text-muted">{t("food.today")}</h2>

      {/*
        The whole day at once, for somebody who ate the same as yesterday
        (D124). Secondary, not primary: the screen's primary action is logging
        something new, and this is a shortcut past that rather than the thing
        the page is for.
      */}
      {onCopyDay && entries.length > 0 ? (
        <button
          type="button"
          data-testid="copy-day-to-today"
          className="btn-small mb-3"
          disabled={copyingDay}
          onClick={() => void onCopyDay(entries)}
        >
          {copyingDay ? t("food.copyingDay") : t("food.copyDayToToday")}
        </button>
      ) : null}

      <ul className="divide-y divide-edge border-y border-edge">
        {entries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            onCopyToToday={onCopyToToday}
            open={openId === entry.id}
            onToggleOpen={() => setOpenId((current) => (current === entry.id ? null : entry.id))}
            selectable={saving}
            selected={selected.has(entry.id)}
            onToggle={() =>
              setSelected((current) => {
                const next = new Set(current);
                if (next.has(entry.id)) next.delete(entry.id);
                else next.add(entry.id);
                return next;
              })
            }
            onDelete={() => deleteEntry.mutateAsync(entry.id)}
          />
        ))}
      </ul>

      <p className="num mt-2 text-micro text-muted">{t("food.dayOn", { date: today })}</p>

      {saving ? (
        <form onSubmit={save} className="mt-4">
          <p className="mb-2 text-micro text-muted">
            {t("food.mealPickRows", { count: chosen.length, total: entries.length })}
          </p>
          <div className="flex gap-2">
            <input
              className="field flex-1"
              aria-label={t("food.mealName")}
              placeholder={t("food.mealName")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="submit"
              data-testid="save-meal-confirm"
              className="rounded-md bg-ink px-4 text-note text-paper disabled:opacity-50"
              disabled={chosen.length === 0 || name.trim() === ""}
            >
              {t("profile.save")}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          data-testid="save-meal"
          className="mt-4 text-note text-muted underline underline-offset-4"
          onClick={() => setSaving(true)}
        >
          {t("food.saveAsMeal")}
        </button>
      )}
    </section>
  );
}

/**
 * One logged row.
 *
 * A grid, not a flex row: four tracks with the same widths on every row, so the
 * amounts and the controls line up down the page instead of each row sizing to
 * its own name. The name track is `minmax(0,1fr)` so it takes the slack and
 * truncates rather than pushing everything else around.
 */
function EntryRow({
  entry,
  selectable,
  selected,
  onToggle,
  onDelete,
  onCopyToToday,
  open,
  onToggleOpen,
}: {
  entry: FoodEntry;
  /** True while a meal is being assembled, when the row is a choice. */
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => Promise<unknown>;
  /** Present only on a past day. See `TodaySection` (D124). */
  onCopyToToday?: (entry: FoodEntry) => Promise<void>;
  /** Whether this row is the open one. The list owns that (D125). */
  open: boolean;
  onToggleOpen: () => void;
}) {
  const [copying, setCopying] = useState(false);
  const update = useUpdateFoodEntry();
  const [editing, setEditing] = useState(false);
  const [grams, setGrams] = useState(() => formatDecimal(entry.grams, { decimals: 0 }));
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = readRequiredNumber(grams);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    try {
      await update.mutateAsync({ id: entry.id, input: { grams: parsed.value } });
      setEditing(false);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("auth.unreachable"));
    }
  }

  /**
   * An estimate, judged from `confidence` (D125).
   *
   * The entry carries no `isEstimate` of its own — that lives on the food item
   * — but it does carry the confidence the figure was logged with, and the
   * schema is explicit that anything below 1 marks a figure somebody estimated
   * rather than looked up. Reading it here keeps one definition of "estimated"
   * rather than inventing a second.
   */
  const estimated = entry.confidence < 1;

  /** Where the numbers came from: a database row, or something typed. */
  const source = entry.foodItemId === null ? t("food.sourceTyped") : t("food.sourceDatabase");

  const macro = (grams: number | null) =>
    grams === null ? t("stat.notYet") : `${formatDecimal(grams, { decimals: 0 })} g`;

  return (
    <li className="py-2.5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-baseline gap-x-3">
        {selectable ? (
          <input
            type="checkbox"
            className="check self-center"
            checked={selected}
            onChange={onToggle}
            aria-label={t("food.mealInclude", { name: entry.name })}
            data-testid={`pick-${entry.id}`}
          />
        ) : (
          <span />
        )}

        {/*
          The name is the disclosure (D125). A whole row that expands would
          fight the checkbox beside it while a meal is being assembled, so
          while `selectable` the row keeps its one meaning and does not expand:
          one tap, one thing, and the thing changes with the mode.
        */}
        {selectable ? (
          <span className="min-w-0 truncate text-note text-ink">{entry.name}</span>
        ) : (
          <button
            type="button"
            data-testid={`expand-entry-${entry.id}`}
            aria-expanded={open}
            className="min-w-0 truncate text-left text-note text-ink"
            onClick={onToggleOpen}
          >
            {entry.name}
            {estimated ? <EstimateTag /> : null}
          </button>
        )}

        <span className="num shrink-0 whitespace-nowrap text-right text-micro text-muted">
          {formatDecimal(entry.grams, { decimals: 0 })} g · {formatKcal(entry.kcal)} kcal
        </span>

        {/*
          A chevron rather than the three controls that used to sit here. The
          actions moved inside the disclosure, which is what stops a row of
          four rows carrying twelve controls a thumb has to aim between.
        */}
        <span className="flex shrink-0 items-center gap-1">
          {selectable ? null : (
            <span
              aria-hidden="true"
              className={`text-micro text-muted transition-transform ${open ? "rotate-180" : ""}`}
            >
              ▾
            </span>
          )}
        </span>
      </div>

      {open && !selectable ? (
        <div data-testid={`entry-detail-${entry.id}`} className="mt-3 pl-1">
          {/*
            What is in the entry, which the collapsed line cannot carry and
            which the reader otherwise has to take on trust. A macro the entry
            does not have says "Inte än" rather than 0: absent is not zero
            (D44), and a fibre figure nobody recorded is not a fibre figure of
            zero.
          */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-micro text-muted sm:grid-cols-4">
            <div>
              <dt>{t("macro.protein")}</dt>
              <dd className="num text-ink">{macro(entry.proteinG)}</dd>
            </div>
            <div>
              <dt>{t("macro.carbs")}</dt>
              <dd className="num text-ink">{macro(entry.carbsG)}</dd>
            </div>
            <div>
              <dt>{t("macro.fat")}</dt>
              <dd className="num text-ink">{macro(entry.fatG)}</dd>
            </div>
            <div>
              <dt>{t("macro.fiber")}</dt>
              <dd className="num text-ink">{macro(entry.fiberG)}</dd>
            </div>
          </dl>

          <p className="mt-2 text-micro text-muted">
            {t("food.entryAmount", {
              grams: formatDecimal(entry.grams, { decimals: 0 }),
              kcal: formatKcal(entry.kcal),
            })}
            {" · "}
            {source}
            {entry.brand ? ` · ${entry.brand}` : ""}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-1">
            {/*
              The copy-forward action lives here too on a past day (D124), so
              every action for this entry is in one place rather than split
              between the line and the panel.
            */}
            {onCopyToToday ? (
              <button
                type="button"
                data-testid={`copy-entry-${entry.id}`}
                className="min-h-11 px-1 text-micro text-muted underline underline-offset-4 hover:text-ink"
                disabled={copying}
                onClick={() => {
                  setCopying(true);
                  void onCopyToToday(entry).finally(() => setCopying(false));
                }}
              >
                {t("food.copyToToday")}
              </button>
            ) : null}

            <button
              type="button"
              data-testid={`edit-entry-${entry.id}`}
              className="min-h-11 px-1 text-micro text-muted underline underline-offset-4 hover:text-ink"
              onClick={() => setEditing((was) => !was)}
            >
              {editing ? t("common.cancel") : t("common.edit")}
            </button>

            {/* On the screen where the entry is displayed, not in a settings page. */}
            <DeleteButton
              testId={`delete-entry-${entry.id}`}
              label={`${entry.name}, ${formatKcal(entry.kcal)} kcal`}
              onDelete={onDelete}
            />
          </div>

          {editing ? (
            <form onSubmit={submit} className="mt-2 flex items-start gap-2">
              <div className="relative w-32">
                <input
                  className="field num pr-8"
                  type="text"
                  inputMode="decimal"
                  aria-label={t("food.grams")}
                  value={grams}
                  onChange={(event) => setGrams(event.target.value)}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-note text-muted"
                >
                  g
                </span>
              </div>
              <button
                type="submit"
                data-testid={`save-entry-${entry.id}`}
                className="btn w-auto px-4"
                disabled={update.isPending}
              >
                {t("profile.save")}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-1 text-micro text-ink">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The portion sheet, shown only for a food that has not been logged before.
 * A repeat never reaches this — that is the point of the recent list.
 */
function PortionSheet({
  item,
  today,
  timezone,
  onClose,
  onSaved,
}: {
  item: FoodItem;
  today: string;
  timezone: string;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const save = useSaveFoodEntry(timezone);
  const star = useSetFavourite();
  const portions = usePortions();
  const savePortion = useSavePortion();
  const deletePortion = useDeletePortion();

  /**
   * Every unit this food can be counted in, the user's own first.
   *
   * The user's own win over the packet's for the same reason the server
   * resolves them in that order: a serving figure comes from whoever packaged
   * it, and a defined portion comes from the kitchen scale in the kitchen.
   */
  const own = portions.data?.filter((portion) => portion.foodItemId === item.id) ?? [];
  const userHints = Object.fromEntries(own.map((portion) => [portion.unit, portion.grams]));

  /**
   * Every unit this food can be counted in, across all three layers (D85).
   *
   * The household table is what makes this list non-empty for most foods:
   * Livsmedelsverket publishes no serving data at all, so before it, nearly
   * every food offered nothing but a 100 g placeholder.
   */
  const units = allPortionUnits({
    userHints,
    sourceHints: item.servingHints,
    category: item.category,
  });

  /**
   * What the field starts at, and where that came from.
   *
   * The source is shown, not hidden: "senast du loggade" and "100 g som
   * standard" are very different claims about the same number, and only one of
   * them is worth trusting without checking.
   */
  const suggested = resolveDefaultAmount({
    lastGrams: item.lastGrams,
    userHints,
    sourceHints: item.servingHints,
    category: item.category,
  });
  const [grams, setGrams] = useState(String(suggested.grams));
  const [error, setError] = useState<string | null>(null);

  /** Defining a new one: a name and what one of them weighs. */
  const [defining, setDefining] = useState(false);
  const [unitName, setUnitName] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = readRequiredNumber(grams);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }

    /**
     * Caught, not left to reject. An uncaught rejection here showed nothing at
     * all, and a stall showed "Sparar…" forever, which is the state this screen
     * was reported stuck in after a scan.
     */
    try {
      await save.mutateAsync({
        clientUuid: clientUuid(),
        localDate: today,
        mealSlot: "snack",
        foodItemId: item.id,
        grams: parsed.value,
        confidence: 1,
        confirmed: true,
      });
    } catch (problem) {
      setError(saveProblem(problem));
      return;
    }
    onSaved(item.name);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button type="button" className="absolute inset-0 bg-ink/40" aria-label={t("quick.cancel")} onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={item.name}
        className="relative w-full max-w-sm rounded-t-2xl border-t border-edge bg-paper px-5
                   pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 sm:rounded-2xl sm:border"
      >
        <h2 className="text-lg font-semibold text-ink">{item.name}</h2>
        <p className="num mt-1 text-micro text-muted">
          {formatDecimal(item.kcalPer100, { decimals: 0 })} kcal / 100 g
          {/*
            An estimate says so wherever it appears (D80). A guess the reader
            cannot tell from a packet reading is a guess they will treat as a
            fact, and this figure goes into the same series the maintenance
            number is computed from.
          */}
          {item.isEstimate ? <EstimateTag /> : null}
        </p>
        {item.isEstimate && item.estimateBasis ? (
          <p className="mt-1 max-w-prose text-micro text-muted">{item.estimateBasis}</p>
        ) : null}

        {/* Starred food skips the search entirely next time. */}
        <button
          type="button"
          data-testid={`star-${item.id}`}
          className="mt-2 min-h-11 px-1 text-micro text-muted underline underline-offset-4"
          onClick={() =>
            void star.mutateAsync({ foodItemId: item.id, favourite: !item.favourite })
          }
          disabled={star.isPending}
        >
          {item.favourite ? t("food.unstar") : t("food.star")}
        </button>

        <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
          <Field id="grams" label={t("food.grams")} error={error ?? undefined}>
            <input
              id="grams"
              className="field num text-2xl"
              type="text"
              inputMode="decimal"
              autoFocus
              enterKeyHint="done"
              {...fieldAria("grams", error ?? undefined)}
              value={grams}
              onChange={(event) => setGrams(event.target.value)}
            />
          </Field>

          {/*
            Counting instead of weighing.

            Nobody weighs a slice of bread, and the app storing grams is no
            reason to make them. Tapping a unit fills the gram field rather than
            replacing it: the number that will be saved stays visible and stays
            editable, so a hint that is wrong for this loaf is something the
            user can see and correct rather than something applied behind them.
          */}
          {/*
            The portion and the grams it resolves to, side by side (D85).

            Each chip says what one of that unit weighs, so a wrong equivalence
            is visible *before* it is tapped rather than after it is saved. The
            grams field above stays the number being stored, and stays editable.
          */}
          {units.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {units.map((unit) => (
                <button
                  key={unit.unit}
                  type="button"
                  data-testid={`unit-${unit.unit}`}
                  className="min-h-11 rounded-lg border border-edge px-3 text-note text-ink"
                  onClick={() => setGrams(formatDecimal(unit.grams, { decimals: 0 }))}
                >
                  {t("portion.oneIs", {
                    unit: unit.unit,
                    grams: formatDecimal(unit.grams, { decimals: 0 }),
                  })}
                </button>
              ))}
            </div>
          ) : null}

          <p className="text-micro text-muted" data-testid="amount-source">
            {t(`portion.from.${suggested.source}` as TranslationKey)}
          </p>

          <button className="btn" type="submit" disabled={save.isPending}>
            {save.isPending ? t("quick.saving") : t("food.logIt")}
          </button>
        </form>

        {/*
          Defining a portion for a food you use (§1 of this brief).

          Here rather than in a settings screen because this is the moment the
          user knows the answer: they have just weighed the thing and typed the
          number into the field above. The definition is the number they are
          already looking at, given a name.
        */}
        <div className="mt-4 border-t border-edge pt-3">
          {defining ? (
            <div className="flex items-end gap-2">
              <label className="min-w-0 flex-1 text-micro text-muted">
                {t("portion.unitName")}
                <input
                  className="field mt-1 w-full"
                  value={unitName}
                  placeholder={t("portion.unitPlaceholder")}
                  onChange={(event) => setUnitName(event.target.value)}
                />
              </label>
              <button
                type="button"
                data-testid="save-portion"
                className="min-h-11 shrink-0 rounded-lg border border-edge px-3 text-note text-ink disabled:opacity-50"
                disabled={unitName.trim().length === 0 || savePortion.isPending}
                onClick={() => {
                  const parsed = readRequiredNumber(grams);
                  if (!parsed.ok) {
                    setError(parsed.message);
                    return;
                  }
                  void savePortion
                    .mutateAsync({
                      foodItemId: item.id,
                      unit: unitName.trim(),
                      grams: parsed.value,
                    })
                    .then(() => {
                      setUnitName("");
                      setDefining(false);
                    });
                }}
              >
                {t("quick.save")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="define-portion"
              className="min-h-11 px-1 text-micro text-muted underline underline-offset-4"
              onClick={() => setDefining(true)}
            >
              {t("portion.define", { grams: grams || "0" })}
            </button>
          )}

          {/* Edit is redefining, which is an upsert; delete is here (§3, D56). */}
          {own.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {own.map((portion) => (
                <li key={portion.id} className="num flex items-center gap-2 text-micro text-muted">
                  <span>
                    {t("portion.oneIs", {
                      unit: portion.unit,
                      grams: formatDecimal(portion.grams, { decimals: 0 }),
                    })}
                  </span>
                  <button
                    type="button"
                    data-testid={`delete-portion-${portion.id}`}
                    className="underline underline-offset-4"
                    onClick={() => void deletePortion.mutateAsync(portion.id)}
                  >
                    {t("delete.action")}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * One saved meal: log it, rename it, remove it.
 *
 * §3 says every user-created row ships with an edit and a delete in the phase
 * that creates it (D56). A template had neither, so a meal saved with a typo in
 * its name, or one whose contents stopped matching what you eat, was permanent.
 *
 * Renaming is the whole of the edit. Changing what is *in* a meal is
 * `replaceTemplateItems` under a form that would have to re-pick rows from a
 * day, and the honest way to do that is to log the meal, adjust the day, and
 * save it again — which the row selection on the day's list now supports.
 */
function TemplateRow({
  template,
  onLog,
  logging,
}: {
  template: MealTemplate;
  onLog: () => void;
  logging: boolean;
}) {
  const update = useUpdateTemplate();
  const remove = useDeleteTemplate();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(template.name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return;
    await update.mutateAsync({ id: template.id, input: { name: name.trim() } });
    setEditing(false);
  }

  return (
    <li className="py-1">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2">
        <button
          type="button"
          data-testid="log-template"
          className="min-w-0 py-3 text-left"
          onClick={onLog}
          disabled={logging}
        >
          <span className="block truncate text-base text-ink">{template.name}</span>
          <span className="num block text-micro text-muted">
            {template.items.length === 1
              ? t("food.itemOne")
              : t("food.itemMany", { count: template.items.length })}
          </span>
        </button>

        <button
          type="button"
          data-testid={`edit-template-${template.id}`}
          className="min-h-11 shrink-0 px-1 text-micro text-muted underline underline-offset-4 hover:text-ink"
          onClick={() => setEditing((was) => !was)}
        >
          {editing ? t("common.cancel") : t("food.editMeal")}
        </button>

        <DeleteButton
          testId={`delete-template-${template.id}`}
          label={template.name}
          onDelete={() => remove.mutateAsync(template.id)}
        />
      </div>

      {editing ? (
        <form onSubmit={submit} className="mb-2 flex gap-2">
          <input
            className="field flex-1"
            aria-label={t("food.mealNameNew")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="submit"
            data-testid={`save-template-${template.id}`}
            className="btn w-auto px-4"
            disabled={update.isPending}
          >
            {t("profile.save")}
          </button>
        </form>
      ) : null}
    </li>
  );
}
