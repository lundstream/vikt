# CLAUDE.md

Name: **Vikt**. It is read from the `APP_NAME` environment variable at runtime — the page title, the PWA manifest and the API all take it from there — so renaming is a restart, never a code edit (DECISIONS.md D13).

`levla.me` is a candidate *domain* for when this gets hosted, not the name of the app.

A self-hosted weight and habit tracker for a small invited group. Web-first for desktop deep dives, installable PWA for phone logging. Single codebase.

Read `DECISIONS.md` before changing architecture. Update `STATE.md` at the end of every session.

---

## 1. What this is

The product thesis, in one line: **commercial trackers show you noise and a fixed calorie target, this one shows you a smoothed trend and a maintenance number that corrects itself from real data.**

Everything else is in service of the user logging consistently for months. Every design decision gets judged against "does this make logging on day 90 more likely."

The three things that must be excellent:

1. **Trend weight.** Smoothed line is the primary number, raw daily reading is secondary.
2. **Adaptive TDEE.** Maintenance calories are back-calculated from logged intake and observed trend change, not from a formula that never updates.
3. **Fast re-logging.** Repeat a previous meal in one tap.

If a feature competes with those three for screen space or build time, those three win.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite + TypeScript |
| Routing | React Router |
| Server state | TanStack Query |
| Charts | Recharts (switch to uPlot only if a chart exceeds ~2k points) |
| Styling | Tailwind, tokens defined in `apps/web/src/styles/tokens.css` |
| Offline | Dexie (IndexedDB) write queue + service worker via `vite-plugin-pwa` |
| Backend | Node 22 + Fastify + TypeScript |
| Validation | Zod, shared between client and server via `fastify-type-provider-zod` |
| DB | Postgres 16 + Drizzle ORM + drizzle-kit migrations |
| Auth | Session cookies, argon2id password hashes, invite-code registration |
| Tests | Vitest, mandatory for everything in `packages/shared/src/calc/` |
| Deploy | Docker Compose on Proxmox, nginx serves static dist, API bound to loopback, NPM, Cloudflare edge |

### Repo layout

```
apps/
  api/          Fastify server, routes/, services/, db/
  web/          React app
packages/
  shared/       Zod schemas, TS types, and ALL derived-number math
infra/
  docker-compose.yml, nginx/, .env.example
```

The math lives in `packages/shared/src/calc/` so the server and the client compute identical numbers. No duplicated formulas.

### Carried over from FormulaSpun (do not relearn these)

- `TRUST_PROXY` names the **immediate peer** allowed to speak for a client — an address or CIDR, not a hop count. Hop counts cannot validate the peer and are spoofable, and Fastify 5 accepts a number and silently trusts nothing. The client address comes from `CF-Connecting-IP`, which only Cloudflare sets, and nginx must be restricted to Cloudflare's ranges for that to mean anything. See DECISIONS.md D14. Verify by hitting the API from a cellular IP and checking the logged client IP is the phone's, not the proxy's.
- `assertProdSecrets()` runs at boot and **exits the process** if any required secret is missing or still equals its example value. Fail closed, never warn and continue.
- The API binds to loopback only. nginx is the only thing that talks to it.

---

## 3. Non-negotiable rules

### Multi-user isolation
Every user-owned table has `user_id`. Every query is scoped by it. The service layer takes `userId` as its **first argument**, always, and route handlers pass it from the session. No repository function may accept an unscoped filter. This is the number one bug class in this kind of app, treat any unscoped query as a defect.

### Idempotent writes
Every log row carries a `client_uuid` (unique per user). The offline queue replays on reconnect and replays are expected, so inserts are `ON CONFLICT (user_id, client_uuid) DO UPDATE`.

### State is never a nullable foreign key
A foreign key declared `ON DELETE SET NULL` gets cleared by deletions elsewhere in the schema. That is right for a *reference* and catastrophic for a *flag*: the flag silently flips back to "has not happened" when an unrelated row is removed, nothing errors, and the state is wrong from then on. Deleting a user once un-burned their invite code and made it valid again.

Whether something has happened goes in a **timestamp column that nothing cascades to** — `used_at`, `achieved_at`, `claimed_at`. The foreign key stays as the record of who or which, and is allowed to go null. Before adding a nullable FK, ask whether any query will ever test it for null to mean something; if so, add the timestamp instead. DECISIONS.md D17 audits every such column in the schema and names the two that still need work in phase 3.

### Day boundaries
Store `logged_at timestamptz` **and** `local_date date`. The client computes `local_date` from the user's timezone and sends it. Never derive a day bucket from a UTC timestamp on the server. Midnight snacks and travel will otherwise silently corrupt daily totals.

### Numbers
Money and body measurements use `numeric`, never float. Drizzle returns `numeric` as a string, so parse at the boundary in `packages/shared/src/parse.ts` and keep everything internal as `number`. Store SI: kg, cm, kcal, SEK.

### Every user-created row ships with edit and delete, in the phase that creates it

If a phase adds a way to create a row, that phase adds the way to change it and the way
to remove it. Not the next phase, not "when someone asks": the same one. A create-only
entity is a half-built feature, and it is half-built in the direction that matters,
because the first thing anyone does with a new form is mistype something into it.

This gap has now appeared **four separate times** — weight, food and daily logs in phases
1 to 3; savings rules in phase 5; milestones in phase 5 as well, where the API got both
and the UI got neither. Each time it was found by using the app rather than by a test,
which is the tell that it is a habit rather than an oversight.

Two forms of "edit" count, and which one applies is a property of the entity:

- **one row per day** (weight, the daily log, measurements, manual intake): re-logging the
  day *is* the edit, because the day holds one canonical value and the write is an upsert
  on `(user_id, client_uuid)` with the day's other rows cleared. Nothing extra is needed,
  but the UI has to make re-logging reachable from where the wrong value is *shown*;
- **many rows per day** (food entries, activity sessions, savings events, and anything
  keyed by id rather than by day): re-logging creates a second row, so these need a real
  update path.

Delete has no second form. Every user-created row needs one, and it belongs on the screen
that displays the row, not in a settings page.

Where a delete would destroy derived history, the answer is **not** to omit it. A plan is
archived rather than deleted because `tdee_at_write` is the record a later plan review
compares against (D25); a savings rule *is* deleted, and the retroactive effect on the pot
is previewed first (D54). Both are decisions with a reason written down. "There is no
delete yet" is not.

### Product guardrails
These are enforced server-side, not just in the UI:
- Target intake below a configured floor is rejected by the plan endpoint.
- Target rate of loss above 1% of bodyweight per week is rejected.
- A day under target does not create a debt that carries forward. There is no "eat back" arithmetic anywhere in the codebase.
- There is no failure state in the UI. A missed day renders as a gap, never as red, never as a broken streak of the "you ruined it" kind. Streaks count logging, not compliance.

---

## 4. The math (implement exactly, test with fixtures)

All of this lives in `packages/shared/src/calc/`, pure functions, no I/O.

### 4.1 Trend weight (`trend.ts`)

Exponentially smoothed moving average, Hacker's Diet style.

```
alpha = 0.10                       // a 10-day smoothing constant, per DAY
trend[0] = weight[0]               // seed on first reading

// On a day with a reading, `gap` is the days since the previous reading:
effectiveAlpha = 1 - (1 - alpha) ^ gap
trend[t]       = trend[prev] + effectiveAlpha * (weight[t] - trend[prev])
```

**Alpha is per day, not per reading.** `trend[t-1] + alpha * (...)` applied only on days that have a reading makes the smoothing constant depend on how often the user weighs in: at weekly cadence a nominal 10-day constant becomes roughly 70 days, and the line never catches up — a real 2 kg loss over 16 days renders as 0.29 kg. Compounding alpha over the gap fixes it. With daily readings `gap` is 1 and this is identical to the plain form, so nothing about a daily series changes.

On days with no reading, carry the previous trend forward unchanged and mark the point `interpolated: true`. Do not interpolate the raw series. Only the update step is gap-aware; the carry-forward is not.

Return `{ localDate, raw | null, trend, interpolated }[]`.

### 4.2 Adaptive TDEE (`tdee.ts`)

Over a rolling window (preferred 28 days, minimum 14):

```
// first and last day in the window that carry an actual reading:
trendDeltaKg    = trend[lastReading] - trend[firstReading]
spanDays        = lastReading - firstReading
energyDeltaKcal = trendDeltaKg * 7700          // approximation, document it in the UI tooltip

meanIntake      = totalLoggedIntake / daysLogged     // days LOGGED, not days in window
tdee            = meanIntake - (energyDeltaKcal / spanDays)
```

**Every average is taken over the period it was actually measured across.** Both denominators used to be `daysInWindow`, and both were wrong for the same reason.

`meanIntake` divides by the days that have a log, because an unlogged day is a day we know nothing about — not a day of zero calories. Dividing by the window instead makes the mean too low by exactly the missing fraction: at 82% coverage it understates intake by 18%, and maintenance comes out ~18% light.

The energy term divides by the span between the first and last **reading** in the window, not by the window's calendar ends. The trend is flat after the last reading because nothing updated it, not because nothing happened, and charging those days to the divisor understates the deficit. At a weekly cadence the last reading can sit six days inside the window, so the delta covered 21 of 28 days and maintenance came out 5% light. With fewer than two readings in the window there is no observed rate at all, and the energy term contributes nothing rather than a figure invented from a flat line.

The test that catches this whole family: build a synthetic series from a known maintenance and a known intake, then check that the two projections in §4.3 — which compute the same future by different routes — agree. Run it at several coverage levels and several weighing cadences, because at 100% daily coverage every one of these mistakes is invisible.

Coverage gate: if fewer than 80% of days in the window have a food log, do **not** return an adaptive figure. Fall back to Mifflin-St Jeor times an activity factor and return `source: "formula"`. The gate is not compensating for an arithmetic error — it guards against two real things: the variance of a mean taken over few days, and the likelihood that unlogged days are not a random sample of days. People skip logging the large meal more often than the ordinary one, so a low-coverage mean is biased low however it is divided.

Return `{ tdee, source: "adaptive" | "formula", windowDays, coverage, confidence }` where confidence ramps from 0 to 1 with coverage and window length. The UI shows the confidence, it does not hide it.

### 4.3 Projections (`project.ts`)

Two numbers, always shown side by side, never blended into one:

- **On plan:** `daysToGoal = (trendNow - goalKg) * 7700 / (tdee - targetIntake)`
- **At current pace:** fit a least-squares line to the last 28 days of trend weight, extrapolate to the goal.

If current pace is flat or upward, return `null` and the UI shows "not enough movement yet to project", never a negative or infinite date.

The same function serves milestone projections. For waist milestones, regress the waist series instead of the weight series.

### 4.4 Waist-to-height (`whtr.ts`)

`whtr = waistCm / heightCm`. Plot it on the same time axis as trend weight. It frequently keeps moving when the scale stalls, which is the entire point of showing it.

### 4.5 Savings (`savings.ts`)

Accrue on read, do not run a cron job that writes rows.

```
For each active savings_rule:
  eligibleDays = days matching rule.cadence between rule.start and today
  accrued = eligibleDays * rule.amount_sek
  minus any savings_offset rows (days the user did buy the thing)
Plus one-off savings_event rows.
Minus reward_payout rows (milestone treats already bought).
= current pot balance
```

Cadences: `every_day`, `weekday`, `weekend_day`, `per_event`.

### 4.6 Streaks (`streak.ts`)

Counts days with **any** log entry (weight, food or daily). One grace day per rolling 7 does not break the chain. Also expose `daysSinceLastDrink` derived from `daily_log.alcohol_units`, computed the same way.

---

## 5. Visual direction

The signature element is **the line**. One long, slow, downward trend line is what this product is about, so it gets the hero position and everything else stays quiet around it. Resist chopping the dashboard into identical rounded cards.

The full specification is `docs/Vikt-grafisk-profil.pdf` (D86). What follows is the part that is binding on code.

### Colour is information

The palette carries Norrland names so it can be spoken about. Dark is the primary theme; the light variants are in `tokens.css`.

```
--natt      #0F1418   background
--skymning  #16232B   cards
--dis       #1E2D36   fields, raised surfaces, lines
--sten      #6B7B82   secondary text, meta
--sno       #EDF1F2   text, primary button

--lingon    #E0455F   the trend line. The wordmark. Nothing else.
--gran      #86AE8B   logged, chosen, saved, streaks
--is        #9FC3CC   raw readings, secondary series, measurements
--honung    #E2B25A   the pot, rewards, milestones
--blabar    #8C7FD1   nutrition: calories and macros
```

**Lingon still belongs to two things**, exactly as before: the trend line and the wordmark. That is the oldest rule here and the reason the accent means anything — the eye knows red is *your trend* because red is never anything else. `apps/web/test/colour-meaning.test.ts` holds it to the two files that are allowed it.

**The four other accents each name an area, never a feeling.** Gran is not "good", Gran is "logged". When something new needs a colour, ask which area it belongs to: the trend, something you logged, money or reward, nutrition, a secondary measurement. No answer means no accent, and that is usually the right answer.

**Uncertainty gets no accent.** Estimates, incomplete totals and "inte än" are Sten with a dashed edge or a `≈` prefix. Uncertainty is not an area; it is an absence of information about something that already has one.

**Errors, warnings and empty states get no accent either.** A 422 is explained in text, in Snö, with no red frame. "Inte än" is Sten, not a coloured box. §3 says this app has no failure state, and a colour that only appears on a bad day builds one. The same guard checks this.

**Colour never carries meaning alone.** Every coloured surface has a label, a shape or a number saying the same thing.

**Components use semantic names only.** `text-logged`, `bg-reward`, `stroke-trend`. The palette is not exposed as Tailwind classes at all, so a component cannot pick a colour because it likes it; using a class is a claim about what the thing *is*. No component names a colour directly, and no component contains a hex.

**Labels are sentence case, never all caps.** "Kalorier i dag", not "KALORIER I DAG". All-caps micro-labels are the strongest single tell of generic SaaS, and this app is meant to read like a notebook. This holds for the strings in `i18n/sv.ts` *and* for the CSS: a `uppercase` transform shouts a string that is written politely, which is exactly how it came back after being fixed once. `apps/web/test/copy-style.test.ts` checks the strings and `apps/web/test/class-names.test.ts` checks the transform, because neither can see the other's half.

### Typography

**Archivo** for figures, dates and the wordmark; **Inter** for everything else. Tabular lining figures everywhere, so digits do not jitter as a value updates.

```
hero figure     Archivo 700 · 56/60      86,9 kg
card figure     Archivo 700 · 32/36      2 536 kcal
date            Archivo 600 · 20/24      lördag 31 oktober
section heading Inter 600 · 20/26
body            Inter 400 · 15/22
meta            Inter 400 · 12/16 · Sten
```

**Numbers are the content.** The largest text on any screen is a number. The unit is always smaller than the figure and always in Sten: "86,9" is large, "kg" is small. Swedish number formats throughout, comma as decimal and a space as the thousands separator.

### The logo

The wordmark is the app's name in Archivo bold at about 112% width, in Lingon. The mark is the trend line with its endpoint and two raw readings in Is behind it. Auth screens get both, centred; the app icon is the mark alone on Skymning, maskable; the header gets the wordmark alone at 20 pt, never the mark, because it would compete with the graph beneath it. No shadow, tilt, outline or animation: the line moves in the graph, not in the logo.

### Everything else

Dark mode is required, the phone gets used in the morning before the lights are on.

Quality floor, unannounced: responsive to 360px, visible keyboard focus, reduced motion respected, all charts readable without relying on colour alone.

**No en dashes or em dashes in interface copy.** Swedish sets a parenthetical with a comma or a colon; a dash in that position reads as translated-from-English, and on a 360px screen a dashed clause is where the line breaks worst. Use a comma, a colon, a full stop or parentheses. An ordinary hyphen is fine, it is a word-joiner (`Mifflin-St Jeor`) and not punctuation between clauses. This applies to `i18n/sv.ts` only, not to comments or to these documents. `apps/web/test/copy-style.test.ts` enforces it, and new copy has to pass it.

---

## 6. Build order

Ship each phase before starting the next. Phase 1 alone delivers most of the behavioural benefit, so get it running and start logging into it while the rest gets built.

Each phase below has a prompt you can paste directly.

---

### Phase 0 — Scaffold and auth

**Done when:** you can register with an invite code, log in on desktop and phone, and `GET /api/me` returns your profile.

> Set up the monorepo per section 2 of CLAUDE.md: pnpm workspaces with apps/api, apps/web, packages/shared. Fastify + TypeScript API with Zod validation, Drizzle against Postgres 16, Vite + React 18 + Tailwind frontend.
>
> Apply the schema in schema.ts as the initial drizzle-kit migration.
>
> Implement invite-only auth: argon2id password hashing, session rows in the sessions table, httpOnly SameSite=Lax secure cookies, a `requireAuth` Fastify hook that puts `userId` on the request. Registration requires a valid unused invite code. Add a CLI script `pnpm --filter api invite` that mints a code and prints it.
>
> Implement `assertProdSecrets()` running at boot: exits non-zero if SESSION_SECRET or DATABASE_URL is missing or matches the .env.example value. Set TRUST_PROXY from env.
>
> (Done. `TRUST_PROXY` ended up naming the peer rather than counting hops — see D14.)
>
> Build the service layer convention now: every service function takes userId as its first parameter. Add an eslint rule or a code comment convention to keep it that way.
>
> Also write infra/docker-compose.yml with postgres, api and an nginx serving the built web dist, API bound to loopback.

---

### Phase 1 — Weight log and the trend line

**Done when:** you can log a weight from your phone in under five seconds and see the smoothed line on desktop.

> Implement weight logging and the trend chart.
>
> API: POST /api/weight (upsert on user_id + client_uuid), GET /api/weight?from=&to=.
>
> packages/shared/src/calc/trend.ts: implement the EMA exactly as specified in CLAUDE.md section 4.1, with Vitest tests covering a seeded series, a series with gaps, and a single-reading series.
>
> Web: a dashboard route with the trend line as the hero element per section 5, raw daily readings as faint points behind it. A quick-entry control that is reachable in one tap from the dashboard and defaults to today. Range selector for 30 / 90 / 365 / all.
>
> Also add manual daily calorie entry as a single number field for now. Real food logging comes in phase 3, but the intake series has to start accumulating immediately because phase 2 depends on it.

---

### Phase 2 — Adaptive TDEE and projections

**Done when:** the dashboard shows your real maintenance number with a confidence indicator, and a goal date that moves when you are consistent.

> Implement packages/shared/src/calc/tdee.ts and project.ts exactly as specified in CLAUDE.md sections 4.2 and 4.3, with Vitest fixtures: a clean 28-day loss series, a series with 60% intake coverage that must fall back to formula, and a flat series that must return a null projection.
>
> Add the plans table endpoints: create and update a plan, with the server-side guardrails from section 3 enforced and returning a clear 422 with a readable message rather than a generic validation error.
>
> Dashboard: show maintenance calories with its source and confidence, daily target, and the two projections side by side, "on plan" and "at current pace". Tooltip explaining the 7700 kcal per kg approximation in plain language.

---

### Phase 3 — Food database, barcode, meal templates

**Done when:** scanning a barcode in a shop logs a food in seconds, and last Tuesday's breakfast is one tap away.

> Implement food logging.
>
> Ingest layer: an adapter interface with two implementations, Open Food Facts (barcode lookup and text search) and Livsmedelsverket's livsmedelsdatabas (Swedish generic foods). Both normalise into the food_item table as per-100g macros with a `source` and `source_ref`. Cache every looked-up item locally so repeat lookups never hit the network.
>
> API: search, barcode lookup, POST /api/food-entry, and meal template CRUD.
>
> Web: barcode scanning via the BarcodeDetector API with a ZXing fallback for browsers without it. A logging screen optimised for speed: recent foods first, then favourites, then search. "Log again" on any previous entry or any past day's meal. Saving a set of entries as a named meal template.
>
> This is the highest-traffic screen in the app. Optimise the tap count, not the visual richness.

---

### Phase 4 — Measurements, daily log, activity

**Done when:** waist-to-height sits alongside the trend line, and you can log sweat, energy and movement in one screen.

> Add measurement logging (waist, chest, neck, hips), the daily log (sweat 1-5, energy 1-5, sleep hours, mood, alcohol units, notes) and activity logging.
>
> Implement whtr.ts per section 4.4 and plot waist-to-height on the same time axis as trend weight, as a toggleable second series.
>
> Activity: manual entry with a type, duration and intensity, producing a kcal estimate via MET values. Keep activity calories out of the daily intake target by default, with a settings toggle, and make the default clear in the UI.
>
> Add a correlation view on desktop: scatter energy against sleep, sweat against activity, trend change against intake. This is the deep-dive screen, so give it room and let it be dense.

---

### Phase 5 — Milestones, rewards and the savings pot

**Done when:** hitting a milestone tells you what you have earned and how much is in the pot to pay for it.

> Implement milestones and savings.
>
> Milestones: user-defined targets on any tracked metric (weight under X, waist under Y, streak of N days), each optionally attached to a reward with a description and a cost. Detection runs on write, on the trend value not the raw value, so a single lucky morning reading does not trigger it. Achievement is permanent once reached.
>
> Savings: rules per section 4.5 with the four cadences, one-off events, offsets for days the user did buy the thing, and reward payouts that draw the pot down. Accrue on read, no cron.
>
> Web: a pot balance that visibly climbs, each milestone showing its projected date from project.ts and whether the pot currently covers its reward. When a milestone is reached, a single deliberate celebration moment, not confetti on every page load.
>
> Wire daily_log.alcohol_units into a "days since last drink" counter and let a savings rule reference it.

---

### Phase 6 — PWA, offline queue, install polish

**Done when:** you can log a meal in a shop basement with no signal and it syncs when you surface.

> Make the web app a proper installable PWA. vite-plugin-pwa with a real manifest, maskable icons, standalone display, theme colour matched to the tokens.
>
> Dexie write queue: every mutation writes locally first with a generated client_uuid, renders optimistically, and queues for sync. Replay on reconnect against the idempotent upsert endpoints. A visible but understated sync indicator, and a queue inspector in settings for debugging.
>
> Mobile navigation: bottom bar, thumb-reachable primary log action. Desktop keeps the sidebar and the wide dashboard. Same components, different shell.

---

### Phase 7 — Photos and export

> Progress photos: private storage on a server volume outside the web root, never in Postgres, never public. Served only through an authenticated endpoint with short-lived signed URLs. Thumbnails via sharp. A comparison view that puts two dates side by side.
>
> CSV export of every table, per user, scoped and streamed. Also a JSON export for full portability. Add a Home Assistant ingest endpoint: POST /api/ingest/weight authenticated by a per-user API token, so a Bluetooth scale can push readings in.

---

### Phase 8 — Local LLM layer

The workstation on the LAN, wherever `OLLAMA_URL` points, is not always on, so this whole layer is an optional enhancement. **Nothing in phases 1 to 7 may depend on it.** If Ollama is unreachable, every feature below degrades to a manual path with no error banner.

> Add an LLM service layer talking to Ollama's OpenAI-compatible endpoint, with a health check, a short timeout and graceful degradation everywhere.
>
> Two tiers: a small always-available model for parsing, and the larger model for generation, with jobs queued when the big box is offline.
>
> 1. Natural language food parsing. Input: free text like "två ägg, en skiva rågbröd med smör och kaffe". The model outputs ONLY structured JSON: an array of {name, estimatedGrams, confidence}. It must never output calorie or macro numbers. The backend matches the names against food_item and computes the nutrition. Show the user the matches and let them correct portions before saving. Set think: false. Bake num_ctx into a saved model variant, the /v1/ endpoint ignores it in the request body.
>
> 2. Recipe generation constrained by remaining macros for the day, plus a user-supplied
>   list of what is in the fridge, plus the user's pantry staples and equipment.
>
>   Pantry staples live in their own user-owned table, edit and delete per D56, seeded
>   with a sensible default list the user prunes rather than an empty box. They are
>   assumed present, so the model may build a recipe around them without the user
>   listing them each time.
>
>   The hazard is calories. Staples split into two kinds and the app must treat them
>   differently:
>   - Negligible (salt, pepper, spices, vinegar): may be assumed silently.
>   - Calorie-bearing (oil, pasta, rice, flour, butter): assumed available, but they
>     must still appear in the recipe's ingredient list with amounts, and must still
>     produce food entries when the recipe is logged. Three tablespoons of oil is
>     roughly 360 kcal, and a recipe that omits it feeds a silently low number into the
>     intake series that TDEE is computed from.
>
>   Mark each staple as negligible or calorie-bearing when it is added, defaulting from
>   the matched food item's energy per 100 g rather than asking the user to judge.
>
>   Equipment is a stable profile setting: oven, hob, microwave, air fryer, blender, and
>   whatever else changes what can actually be cooked. Keep the list short; equipment
>   that excludes nothing is noise. The model may only propose methods the equipment
>   supports.
>
>   Maximum cooking time is per request, not a setting. What someone will cook on a
>   Tuesday evening is not what they will cook on a Saturday, and a setting nobody
>   revisits is worse than a control set each time. Default to the last value used in
>   the session. This constraint matters more than it looks: a recipe that takes too
>   long becomes a takeaway order, which is what the savings pot exists to count.
>
>   Saved recipes are their own table, separate from meal templates. A meal template is
>   "log these rows again in one tap"; a recipe is "how did I cook that". They link: a
>   saved recipe holds its ingredient list, its instructions, and a reference to the
>   meal template generated from it, so cooking it again is one tap and reading how is
>   one tap more. Edit and delete per D56.

>   Recipes are the first thing this app stores that is model-generated prose rather
>   than something the user stated or measured, so three rules:
>   - The text is frozen when saved. Regenerating the same dish produces different words,
>     and a saved recipe must not silently change.
>   - It is editable. The user's corrections to timings, amounts and method are the whole
>     value of keeping it.
>   - Nutrition still comes from the database via the parse-and-match path, never from
>     the model, exactly as with free-text food logging.
>
>   Test that a recipe built on staples produces entries covering every calorie-bearing
>   one, that an equipment constraint actually excludes methods, and that the time limit
>   is passed through and reflected in the output. Note in the decision what these tests
>   cannot check: a model can claim a dish takes fifteen minutes without it being true,
>   so the time test verifies the constraint travels and is stated, not that it is
>   honest.
>
>   A generated recipe the user accepts can also be saved as a meal template directly,
>   reusing the Phase 3 path rather than a parallel one.rather than a parallel one.
>
> 3. Weekly review: a Sunday job that feeds the week's aggregates (not raw rows) to the larger model and stores a short written summary. It comments on patterns, it never sets targets or prescribes intake.
>
> 4. Coach persona: a named character with a consistent dry voice that delivers the weekly review and milestone messages. Personality lives in one prompt file, easy to rewrite. Never nagging, never guilt, funnier when things are going well than when they are not.

---

### Phase 8b — Coach chat

Its own phase, deliberately. Chat is not one more button on the LLM layer: it is the first surface where the model answers a question the user asked in their own words, about their own body, with no schema to constrain what comes back. The parsing path has a JSON contract that the backend re-prices; a conversation has none. So it gets its own phase, its own guardrails and its own decision entry rather than arriving as a late addition to Phase 8.

> A conversational surface where the user can ask about their own data. The coach is the Phase 8 persona, in the same voice, now answering rather than only commenting.
>
> **1. It answers from the user's own data and from the NNR figures already in the app.** Trend weight, maintenance and its coverage, the plan, the intake series, the macro targets, the streaks — all of it already computed, all of it already in `calc/`. The model is given those numbers; it does not derive them, and it does not import outside ones. "Vad ligger jag på?" is answered from `resolveIntake` and `computeTdee`, not from the model's recollection of what a person that size usually eats. Every figure it states must be traceable to a number the app already holds.
>
> **2. It inherits every plan guardrail, without exception.** §3 Product guardrails and §4.2 apply here in full. It never states an intake below the floor, and it never states a rate above 1 % of bodyweight per week — not as advice, not as an example, not as an answer to "what if I ate 800 kcal". Asked for one, it says what the floor is and why it is there. This is the rule most likely to be broken by an accommodating model, so it is enforced on the reply and not only in the prompt: parse the numbers out of what came back and refuse to render an answer that crosses either line.
>
> **3. It says when a question is medical.** Thyroid, medication, pregnancy, eating disorders, symptoms, anything diagnostic — it names the question as outside what it should answer and says so plainly, once, without a paragraph of disclaimer. Vikt is not medical advice, and a coach that improvises around that is worse than no coach.
>
> **4. History is per user, under D9, and deletable.** One row per message, `user_id` scoped like everything else, visible in the export, deletable per conversation and in full, and cascade-deleted with the account. It is not training data, not context for another user, not input to any aggregate, and not read by the weekly review. Say this in the interface where the history lives, not only here.
>
> **5. Off entirely when `LLM_ENABLED` is off.** The route does not exist, the navigation entry is not rendered, and the stored history stays where it is rather than being deleted by a configuration change. Same rule as every other LLM surface (D94): the control is absent, not disabled.
>
> Test what can be tested: that a guardrail-crossing reply is refused rather than rendered, that history is scoped and exported and deleted, and that the whole surface disappears with the flag off. Note in the decision what the tests cannot check — no test proves a model will phrase something well, only that the numbers it states are the app's own and that the two hard limits hold.

#### Where the coach goes, and where it does not

**The coach is a place, not an icon.** Amended here because the obvious implementation of a chat surface is a floating button, and the obvious implementation is wrong for this app.

> **A Coach page under Mer**, holding the reviews and the chat together. It is a destination like Data or Framsteg, listed in the one navigation list every surface renders from (D115), and reached the same way everything else is.
>
> **The weekly review appears as a card at the top of the dashboard when it is new.** Once, dismissible, with "Läs hela" leading to the Coach page. That is the same shape as the welcome card (D105) and the maintenance banner (D108), and it is the shape because a weekly review is news: worth seeing, worth seeing once, and not worth a permanent fixture on the screen somebody opens to log breakfast.
>
> **No sparkle icon, no floating button, no accent colour.** A sparkle is the universal sign for "there is a language model in here", which is a fact about the implementation rather than about what the thing does for the reader. A floating button lays a second navigation over the one already at the bottom of the screen, which is the argument D53 made when it removed the raised centre button and is no less true for arriving in a nicer shape. And §5 gives an accent to an *area* — the trend, logged, money, nutrition, secondary measurements — and the coach is none of those, so it gets Snö and Sten like everything else that is not one. **The persona's name and voice carry it**, which is what having a persona is for.
>
> **When `LLM_ENABLED` is off the page and the card do not exist.** Not disabled, not empty, not present-and-explaining: absent, per D94. The navigation list is conditional on it the same way the admin entry is conditional on `isAdmin`, so nothing renders a link to a route that is not there.

---

### Phase 9 — Optional group features

> If others join: a group with an invite, and a shared view showing **logging consistency and streaks only**. No weights, no intake, no measurements, no photos are ever visible to another user. Comparing absolute weights between people is demotivating and pointless, comparing whether everyone logged this week is not.

---

### Phase 10 — Device and service integrations

Manual logging is the floor, not the ceiling. Everything below is additive: no integration may become a dependency, and the app must work identically for someone who connects nothing. Every one of them is a source that writes into the same tables manual entry writes into, with the source recorded on the row.

**The order below is not a preference, it is what the platforms actually allow.** Two of the three things a user is most likely to ask for — Apple Health and Health Connect — cannot be read by a web app at all, and half the obvious names have shut their APIs. Read this before promising anyone anything.

#### Direct, in this order

> **Withings — first.** The one that matters, because it is the scale. An official public API with OAuth and, crucially, **webhooks**: the server is told when a measurement arrives instead of polling for it. Weight, fat mass and body composition. Build this one first and let its shape define the adapter interface the others implement.
>
> **Oura.** A personal access token per user, which is the simplest authentication of the four — no OAuth dance, the user pastes a token. Sleep and readiness, which feed the daily log rather than the weight log.
>
> **Polar AccessLink.** OAuth, and the terms are stricter than the others: read them before writing code, not after.
>
> **Strava — activities only.** Not steps. Strava knows about workouts, and treating a ride as a step count produces a number that is wrong in a way nobody notices. Activities into the activity log, nothing else.

#### Bridged, and this is the important part

Apple Health and Health Connect are **on-device stores**. There is no server-side API and no web API; a PWA cannot read either one, and no amount of manifest or permission work changes that. Anyone who says otherwise is describing a native app.

They reach Vikt the way everything else on a phone does: through an export app the user already runs, or through Home Assistant, posting to a generic ingest endpoint.

> **The generic ingest endpoint is therefore the integration that matters most, and it is built first — before Withings.** It is what makes Apple Health, Health Connect, Home Assistant, a Bluetooth scale, a shell script and anything not yet invented all reachable, and it is the only route by which the two largest platforms can ever work at all.
>
> - A **per-user API token**, minted and revocable in the app, scoped to ingest and nothing else. Never the session cookie.
> - A **per-source adapter**: the endpoint accepts a source identifier and a payload, and the adapter for that source maps it onto the app's own fields. New source, new adapter, no change to the endpoint.
> - Idempotent by `clientUuid` like every other write (§3), because a bridge that retries must not double-log a morning weigh-in.
> - The source is stored on the row and shown in the interface. A reading the user did not type should say where it came from.
> - It writes through the same services as manual entry, so guardrails, day boundaries and derived-number ownership hold identically. An ingest path with its own inserts is how the intake defect of D44 happens again.
>
> Phase 7 already specifies `POST /api/ingest/weight` for a Bluetooth scale. This generalises that endpoint rather than adding a second one beside it.

#### Skip, and why

Recording these so the question is not reopened every six months.

> - **Garmin.** No consumer API. The developer programme is for companies with a signed agreement, not for one person's self-hosted tracker.
> - **Google Fit.** The APIs end in 2026 and new sign-ups closed in 2024. There is no route in even if the work were free.
> - **Fitbit.** The web API is shutting down. Building on it would be building on something with a published end date.
> - **The phone's own pedometer.** No web API. A PWA cannot read the step counter; steps arrive through a bridge or by hand.

#### Steps, written down so it is not asked again

**A PWA cannot count steps.** There is no pedometer API in any browser, and the only motion sensor a web page can read is the accelerometer, which reports **only while the page is in the foreground and awake**. A step counter that works while you look at it is not a step counter, and integrating one over a screen-off pocket walk is not something the platform will let a web page do at any price.

So the daily log's step field has exactly two sources and will not gain a third: **the Health Connect or Apple Health bridge** described above, posting to the generic ingest endpoint, or **typed in by hand**. Neither is a limitation of this app's effort; both are what the platform allows. Anyone proposing otherwise is describing a native app, and building one is a different project.

---

#### Watch

> **The Google Health API.** The intended successor to the Google Fit story. Not usable yet, worth re-checking before this phase starts — if it has landed by then it may change what "bridged" means for Android.

---

### Phase 11 — Habits and reminders

A daily checklist the user writes themselves, and the first push notification this app has ever sent. Both halves are new territory: one is user-defined content in a schema that has so far only held things the app named, and the other is a channel that reaches somebody when the app is closed.

> **The checklist lives on Dagen**, beside the daily log rather than on a screen of its own. It is part of "what happened today", which is what Dagen already is, and a separate screen would make a habit a thing you go and do rather than a thing you tick while you are there anyway.
>
> **The habits are the user's words.** "D-vitamin", "två liter vatten", "stretcha rygg", "ta tabletten". A name and nothing else: no category, no icon picker, no target value. A habit with a number attached is a measurement and belongs in the daily log, which already exists. Edit and delete ship with the create, per §3 — this is exactly the entity class that has been shipped half-built four times.
>
> **One row per habit per day**, keyed `(user_id, habit_id, local_date)`, written as an upsert with `client_uuid` like everything else, so the offline queue replays it safely and re-ticking a day is the edit. `local_date` comes from the client, per §3.
>
> **A streak per habit, counting under the no-failure rule.** §3 is explicit: streaks count logging, not compliance, and a missed day renders as a gap, never as red and never as "you ruined it". So the number is "dagar i rad", it resets quietly, and there is no flame, no badge and no notification about a broken one. A habit somebody stopped doing is a habit they stopped doing.
>
> **Reminders are Web Push**, which works on Android and on iOS **only once the app has been installed to the home screen** — that is a platform rule, not a bug, and it is the reason D116's install control exists at all. VAPID keys are configuration, per-device subscriptions are rows, and a subscription that the push service rejects with 404 or 410 is deleted rather than retried.
>
> **Build the morning weigh-in reminder first**, on its own, and let the rest reuse its machinery. It is the single most valuable notification this app can send — the whole trend line depends on a daily reading taken under the same conditions — and it is the one worth getting right before there are five kinds. One time of day, in the user's timezone, off by default.
>
> **Some habits are health data.** "Ta tabletten" is a record of medication, which under the GDPR is the same special category as the weights already are (D107). The privacy page must say so when this ships: what a habit name can contain, that it is stored like everything else, that it is in the export, and that it is deleted with the account. This is not an afterthought at the end of the phase — the page changes in the same pass as the feature.
>
> No accent for a ticked habit beyond the one §5 already assigns: Gran is "logged, chosen", and a ticked habit is chosen. Nothing new enters the palette.

---

### Phase 12 — Multi-factor authentication

Invite-only registration limits who can get in. It does nothing about a password that has been reused somewhere that leaked, which is the realistic threat to an account holding somebody's weight history.

> **TOTP first**, with an authenticator app. It is self-hosted by construction: a shared secret, a QR code, and six digits from a clock. No SMS, no push service, no third party, nothing that costs money or can be discontinued. `otpauth://` URL, 30-second period, six digits, and a window of one step either side for clock drift.
>
> **Recovery codes are issued once, at enrolment**, shown once, and stored hashed like passwords. Ten of them, single-use. Somebody who loses their phone and has no way back is locked out of their own body-composition history by a security feature, which is a worse outcome than the one being prevented.
>
> **Admin accounts must enrol.** An admin can disable accounts, read the audit log, mint invite codes and change the mail server (D95, D102). That is the account worth taking, and it is the one account where the owner cannot argue that the convenience is theirs to trade away. Enrolment is a gate in front of the admin screens, not a boot-time refusal: an admin who has not enrolled can still use the app as a user.
>
> **Passkeys (WebAuthn) are a later step**, not this one. They are better in every way that matters — phishing-resistant by design, and on a phone they are the fingerprint reader the user already unlocks with — but they are a larger surface: attestation, resident keys, a credential per device, and a fallback story for the browser that has none. TOTP first because it is finishable, passkeys second because they are where this ends up.
>
> **Email as a second factor is not planned.** Email is already the password-reset channel (D88), so a code sent there is a second factor that the first factor's recovery path already grants. It would add a step without adding a barrier.

---

### Phase 13 — Import from other apps

The best onboarding this app can offer is not a tour. It is somebody's four years of weigh-ins already on the chart the first time they open it.

> **Lifesum and MyFitnessPal CSV exports**, into the import path that already exists. D96 built export and proved it with a round trip; this is the same path with a mapping layer in front of it, not a second ingest.
>
> **Three things are mapped and nothing else is invented**: weights, food entries and measurements. What the source file does not contain does not appear. A missing height stays missing (D20, D105), a missing macro stays missing rather than being derived from a calorie figure, and an entry whose calories are present but whose macros are not is stored exactly that way — the incomplete-total machinery from D55 already knows how to say so.
>
> **Everything imported is marked `source: "import"`.** The column exists and the trend chart already draws imported readings as rings rather than filled points (profile page 6), so a person can see at a glance which part of their line came with them. This is also why the phase is cheap: the hard part was deciding that a reading should say where it came from, and D61 decided it.
>
> **Idempotent by `client_uuid`, like every other write**, derived deterministically from the source file's own identifiers, so importing the same export twice does not double every weigh-in. Re-importing is a thing people do when the first attempt looked wrong.
>
> **Preview before commit.** How many rows of each kind, the date range, and what was skipped and why. An import is the largest write this app will ever make on somebody's behalf, and D54 already established that a change with a large retroactive effect gets previewed rather than performed.
>
> The formats are somebody else's and they change without notice, so the parser is per-source and the failure mode is a named, readable refusal rather than a partial import. Fixtures of both exports go in the repository, because the only way this stays working is a test that reads a real file.

---

### Backlog, unscheduled

Not phases. Each is a good idea with no deadline and no dependency on the others, written down so it is remembered and so that remembering it does not mean scheduling it.

> **An uncertainty band on the projection, instead of a single date.** "Du är framme 14 mars" is a point estimate presented as a fact, and §5's rule that uncertainty gets no accent and says `≈` applies to dates as much as to calories. A band drawn from the residual spread of the trend fit says the true thing: some weeks between here and there. The maths is already in `calc/`; what is missing is the decision about what confidence level to draw and how to label it without turning a graph into a statistics lecture.
>
> **A plate photo into the decomposition path**, if the local model handles images. Phase 8's parsing already takes a sentence and returns a structure the backend re-prices; an image is the same contract with a different input. Strictly conditional on the model running on hardware the owner controls (D94): a photograph of somebody's dinner is not going to a cloud API, and if the local model cannot do it then this does not happen.
>
> **Desktop keyboard shortcuts for logging.** The fast path is measured on a phone and lives on a phone, but the app is used at a desk too, and a keystroke that opens the weight sheet with focus in the field is the desktop equivalent of the two taps. Small, self-contained, and worth nothing until somebody actually logs from a laptop often enough to be annoyed.

---

## 7. Session conventions

### Branching

**Production deploys from `main`.** That is the whole reason for the rule below:
a commit on `main` is a commit that the next redeploy ships.

- **Never commit to `main` directly.** All work happens on `dev`.
- `main` receives **merges only, through a pull request**, when the owner decides
  to update production. Not when a pass finishes, not when CI goes green: when
  somebody decides to deploy.
- **CI runs on both branches**, so `dev` is never a place where the suite is
  allowed to be red.
- **Every pass ends with `dev` pushed and CI green.** A pass that ends with
  unpushed work has put the record of it in one place that is not backed up.
- **`STATE.md` names which commits on `dev` are not yet on `main`.** The gap
  between the two is the difference between what is built and what is running,
  and it is invisible from inside either branch. D115's two navigation surfaces
  drifted for exactly that reason.

- Update `STATE.md` with what changed, what is half-done, and the next intended step, before ending a session.
- **`STATE.md`'s current-state section describes only what was exercised through the interface in that session.** Work that exists as API only is listed under its own heading, **API without a screen**, until a screen calls it. D95 described eight admin capabilities as though they were screens; all eight were endpoints with tests and none of them was reachable by clicking. That is the same failure as the lint claim in D98 — a summary written from what was built rather than from what was checked — and both survived because nothing separated the two.
- Any architectural choice that took thought goes in `DECISIONS.md` with the reasoning and the rejected alternatives.
- Migrations are additive and checked in. Never edit an applied migration.
- **Harness scripts clean up after themselves.** Every script that drives a browser deletes its profile directory on exit, and every script that writes screenshots keeps only the last three sets, pruning older ones as it starts. The scratchpad reached 5.4 GB of abandoned Edge profiles because forty scripts each made one and none removed it; a stale profile is also a stale service worker waiting to mislead the next verification pass. `scratchpad/harness.mjs` does both in one call.
- Before implementing a phase, re-read section 3 and section 4. The math and the isolation rules are where this project can quietly go wrong.
