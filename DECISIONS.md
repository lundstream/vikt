# DECISIONS.md

Append-only. Newest at the bottom. Record the reasoning and the rejected alternative, not just the choice.

---

### D1 — PWA, not React Native

One codebase for desktop deep dives and phone logging. No app store, no signing, no second build pipeline, and installs to the Android home screen fine.

Rejected: React Native, would mean maintaining two frontends for a handful of users. Rejected: separate mobile app talking to the same API, same problem.

Cost we accept: no Health Connect access, so step and workout data is manual or imported, never read directly from the phone.

---

### D2 — Trend weight is the primary number

Daily weight swings on water, salt and gut contents. Showing raw daily readings as the headline number is the single most demotivating thing tracking apps do. The EMA is what the user sees, raw readings are visible but secondary.

Rejected: 7-day rolling average, which lags harder on a gap-heavy series and handles missing days worse than an EMA.

---

### D3 — Adaptive TDEE over a static formula

Mifflin-St Jeor times an activity factor is a starting guess with a wide error band. Once there are ~28 days of intake and weight data, maintenance can be back-calculated and it self-corrects as body mass changes.

Formula is the fallback, not the default, and the UI always shows which one is in play plus a confidence figure. Never present a low-confidence estimate as fact.

---

### D4 — Macros are snapshotted on the food entry

`food_entries` denormalises kcal and macros at log time rather than joining live to `food_items`. Upstream databases get corrected, and if history silently changed, the adaptive TDEE calculation would change with it and the trend would be unexplainable.

Cost: correcting a food item does not retroactively fix past entries. That is the intended behaviour.

---

### D5 — The LLM never produces nutrition numbers

The model parses language into `{name, estimatedGrams, confidence}`. The database supplies calories and macros. A model that confidently invents plausible numbers would poison the intake series, which is the input to D3.

Rejected: letting the model estimate calories directly for unmatched foods. If nothing matches, the user types a number and it is marked as an estimate.

---

### D6 — The LLM layer is strictly optional

The inference workstation is not always on. Every LLM feature degrades to a manual path silently, with no error banner and no blocked screen. Nothing in phases 1 to 7 may import from the LLM service.

---

### D7 — Savings accrue on read

Rules plus offsets plus one-off events are summed at query time rather than materialised nightly. A cron that writes rows would drift, would need backfilling when a rule changes retroactively, and buys nothing at this data volume.

---

### D8 — Milestones fire on the trend value

Detection compares against the smoothed value, not the raw reading. Otherwise one dehydrated morning triggers "under 100 kg" and the achievement means nothing. Once fired, it is permanent.

---

### D9 — Group views never expose body data

Members see each other's logging consistency and streaks only. Comparing absolute weights between people is demotivating and measures nothing useful. Photos and measurements are never shared under any setting.

---

### D10 — Photos on disk, private, auth-gated

Files live on a server volume outside the web root, served through an authenticated endpoint issuing short-lived signed URLs. Not in Postgres (bloats backups), not on a CDN, not public-by-obscure-URL.

---

### D11 — local_date is stored, not derived

Every log row carries the client-computed local date alongside the timestamptz. Deriving day buckets from UTC on the server breaks late-evening entries and travel, and corrupts daily totals in ways that are very hard to spot afterwards.

---

### D12 — "Bound to loopback" means "publishes no port" in Docker

`CLAUDE.md` §2 says the API binds to loopback and nginx is the only thing that talks to it. Inside Compose a literal `127.0.0.1` bind would make the API unreachable from the nginx container, so the guarantee is expressed differently: the API publishes no ports at all, and the only route to it is nginx over the `edge` network. Postgres publishes nothing and sits on `backend`, which is `internal: true`, so it has no route off the host in either direction. nginx is the single ingress and publishes only to `127.0.0.1` on the Docker host, where NPM proxies to it.

`HOST` still defaults to `127.0.0.1`, so a bare `node dist/index.js` on a host is loopback-only. Compose overrides it to `0.0.0.0`, which is safe precisely because nothing is published.

Rejected: `network_mode: host` for the API, which would make the loopback bind literal but gives up Compose's network isolation and DNS, and does not work the same way on every host.

The development stack is the one exception: `infra/docker-compose.dev.yml` publishes Postgres on `127.0.0.1:5432` because drizzle-kit and the API run on the host, outside Docker.

---

### D13 — The app name is substituted at runtime, never compiled in

The name is not settled, and changing it must not need a code edit or a rebuild. `APP_NAME` is read in three places and baked into none of them:

- the API reads it from the environment at boot;
- `index.html` and `public/manifest.webmanifest` carry the literal `__APP_NAME__`, which `vite-plugin-app-name.ts` fills in when serving in development and `infra/nginx/30-app-name.sh` rewrites inside the nginx container at startup;
- the client reads the substituted value back out of `<meta name="app-name">` rather than importing a constant.

`vite build` deliberately leaves the placeholder in the output, so one built image serves any name. Renaming in production is `APP_NAME=Something docker compose up -d nginx`.

Rejected: a `VITE_APP_NAME` define, which is a compile-time constant and would mean rebuilding the image to rename the app. Rejected: serving the manifest from the API, which puts a static asset behind a Node process for no benefit.

Cost we accept: `index.html` and the manifest must not be cached by the browser, which the nginx config enforces. Hashed assets under `/assets/` are still immutable.

---

### D14 — Proxy trust validates the peer; the client IP comes from `CF-Connecting-IP`

Two questions have to be answered separately, and conflating them is the bug.

**Is the immediate peer one of ours?** `TRUST_PROXY` now holds the peer's address or CIDR — the pinned `edge` subnet, `172.31.240.0/24` — not a hop count. Fastify compiles it and refuses to read any forwarding header from a connection that does not match.

**Which address is the client?** `CF-Connecting-IP`. Cloudflare *sets* it on every request rather than appending to it, so a browser cannot forge it through Cloudflare the way it can prepend entries to `X-Forwarded-For`. The API reads it only when the peer check passes, and only if it parses as a bare IP.

A first attempt reimplemented Fastify 4's hop-count trust after discovering that Fastify 5 accepts a number and silently trusts nothing. That was the wrong fix. Fastify removed it deliberately: hop-count trust cannot check the peer at all, so anything able to open a socket to the API can send `X-Forwarded-For: <victim>, <padding>, <padding>` and be believed. Restoring it reintroduced precisely that. Peer validation is the fix.

The old numeric form is now **rejected at boot** with a message pointing here, rather than being coerced into something that looks like it works. An operator with a stale `TRUST_PROXY=3` finds out immediately.

**This is only as strong as the guarantee that traffic reaches nginx only through Cloudflare.** A client that reaches nginx directly can set `CF-Connecting-IP` itself, and nginx is a trusted peer, so the API will believe it. `infra/nginx/default.conf` carries the allow-list block that has to be filled in from Cloudflare's published ranges before this is exposed. Until that is done, treat the logged client IP as advisory.

`request.clientIp` is a **getter**, not a value assigned in an `onRequest` hook. Fastify writes its "incoming request" log line before hooks run, so the hook version left every log line showing the proxy's address — the exact failure this decision exists to prevent, reintroduced by the fix for it. `test/client-ip.test.ts` reads the captured log output rather than the function's return value, because that is where it went wrong.

Fastify is pinned to an exact version (`5.12.1`) rather than a caret range, because this depends on its internal trust-proxy semantics — the behaviour that changed silently between 4 and 5. A bump is a deliberate, reviewed upgrade.

Rejected: `uniquelocal` or a bare private-range list for `TRUST_PROXY`. It works, but it trusts every private address rather than the one peer that exists; pinning the compose subnet costs one line and names the actual thing.

---

### D15 — Multi-user isolation is enforced by a lint rule, not only by review

`CLAUDE.md` §3 calls unscoped queries the number one bug class here, and the failure is silent: an unscoped read returns another user's rows and looks entirely normal in any test with one user in the database.

`eslint-rules/user-id-first-param.js` makes the first-parameter half of the convention mechanical. Every exported function in `apps/api/src/services/**` and `apps/api/src/repositories/**` must take `userId` as its first positional parameter. It catches three shapes: no scope at all, scope in the wrong position, and scope buried inside an options object.

Functions that genuinely run before there is a user — `register`, `login`, `resolveSession`, `mintInvite`, and the invite/identity lookups — are listed by name in `allowUnscoped` in `eslint.config.js`. That list is the point: adding to it is a deliberate act that shows up in a diff, rather than a quiet omission.

The rule cannot see whether a `where` clause actually contains a `user_id` predicate. That half stays a review rule, documented in `apps/api/src/repositories/README.md`.


---

### D16 — A burnt invite is burnt permanently, keyed on `used_at`

`invites.used_by` is a foreign key to `users` with `ON DELETE SET NULL`, which is
right for the column — an invite should outlive the account it created, for
audit. It is wrong as the *used* flag. Deleting an account set `used_by` back to
null and made a spent code valid again, which turned account cleanup into
silently reissuing invitations to whoever still had the old code.

Both the lookup and the burn now test `used_at`, an ordinary timestamp that
nothing cascades to. `used_by` stays as the record of who redeemed it, and is
allowed to go null.

Rejected: dropping the foreign key or making it `ON DELETE RESTRICT`, which would
block deleting a user until their invite row was dealt with, for no benefit.


---

### D17 — A nullable foreign key is never the flag for whether something happened

Generalised from D16, which was one instance of it.

A foreign key declared `ON DELETE SET NULL` is cleared by a deletion somewhere else in the schema. That is correct behaviour for the *reference* — the row should outlive what it points at — and catastrophic for a *flag*, because the flag silently flips back to "has not happened" when an unrelated row is removed. Nothing errors. Nothing logs. The state is simply wrong from then on.

**The rule: state lives in a timestamp column that nothing cascades to.** `used_at`, `achieved_at`, `claimed_at`. The foreign key stays as the record of *who* or *which*, and is allowed to go null.

#### Audit of every nullable FK in `schema.ts`

| Column | Shape | Verdict |
|---|---|---|
| `invites.used_by` | `SET NULL`, was the used-flag | **Was the bug.** Fixed in D16: `used_at` is the flag. |
| `food_items.created_by` | `SET NULL`, and `NULL` means "shared, not user-private" | **Same bug, latent.** Deleting a user turns their private food into a shared one. Phase 3 must add an explicit `visibility` column rather than inferring it from this. |
| `food_entries.food_item_id` | `SET NULL`, and `NULL` means "freetext, unmatched" | **Same shape, low harm.** Macros are snapshotted at log time (D4), so nutrition is unaffected; only provenance is lost, and a corrected entry becomes indistinguishable from a hand-typed one. Acceptable, but do not derive "was this matched?" from it — add a column if that question is ever asked. |
| `meal_template_items.food_item_id` | `SET NULL` | **Same shape.** A template item would silently become grams of nothing. Phase 3 should delete the item or keep a name snapshot. |
| `savings_events.milestone_id` | `SET NULL`, links a payout to its milestone | **Safe as written, dangerous if reused.** The pot balance sums amounts, so deleting a milestone leaves the balance correct and only loses provenance. It must never become the answer to "has this reward been paid?" |
| `milestones.reward_claimed_at` | timestamp, nothing cascades | **Correct, and it is the answer** to the question above. Phase 5 reads this, never `savings_events.milestone_id`. |
| `invites.created_by`, `groups.created_by` | `SET NULL`, provenance only | Correct. Not flags. |

The two that need action are `food_items.created_by` and `meal_template_items.food_item_id`, both in Phase 3. Neither is reachable today — no code touches those tables yet — so they are recorded here rather than fixed pre-emptively against an unwritten feature.


---

### D18 — Client UUIDs come from a helper, not from `crypto.randomUUID`

`crypto.randomUUID()` is exposed only in **secure contexts**. Over plain HTTP on a LAN address it is `undefined`, so every attempt to log anything threw — and that is precisely how this app gets used from a phone before there is a certificate on the box. Production is HTTPS behind Cloudflare, so the failure would only ever have appeared on the device that matters most, and only during exactly the testing that is supposed to catch things.

`apps/web/src/lib/uuid.ts` prefers `crypto.randomUUID()` and falls back to assembling a v4 from `crypto.getRandomValues`, which carries no secure-context restriction. It throws rather than reaching for `Math.random`: `client_uuid` is the idempotency key the whole offline queue is built on (CLAUDE.md §3), and a collision means one entry silently overwriting another.

Nothing outside that helper may call `crypto.randomUUID()` directly.


---

### D19 — The adaptive TDEE confidence ramp

§4.2 says confidence "ramps from 0 to 1 with coverage and window length" without saying how. Defined here so it is not invented per call site:

```
GATE             = 0.80    // the coverage floor below which no adaptive figure is returned
MIN_WINDOW       = 14
PREFERRED_WINDOW = 28

coverageTerm = (coverage - GATE) / (1 - GATE)                    // 0 at the gate, 1 at full
lengthTerm   = (windowDays - MIN_WINDOW) / (PREFERRED - MIN)     // 0 at 14 days, 1 at 28

confidence   = 0.5 * coverageTerm + 0.5 * lengthTerm             // both terms clamped to [0, 1]
```

Monotonic in both inputs, 0 only at the worst admissible case (exactly 80% coverage over exactly 14 days), and **1.0 only at full coverage across the full 28-day window**. A formula-sourced figure returns a fixed `0.25`; it does not ramp, because nothing about the user's own data feeds it, and it must never approach an adaptive figure's confidence. `source: "none"` returns 0.

#### Why the weights changed from 0.7/0.3 to 0.5/0.5

The first version of this decision argued that coverage deserved the larger weight because missing days *biased the estimate low*: §4.2 divided `totalLoggedIntake` by `daysInWindow`, so an unlogged day contributed nothing to the numerator while still counting in the denominator. That was true, and it was an arithmetic error in the specification rather than a property of the data — at the 80% gate it understated maintenance by 20%. §4.2 now divides by `daysLogged`, the bias is gone, and the argument that rested on it has to go with it.

Re-deriving from what remains. Write the estimate as `tdee = meanIntake − trendDelta·7700/windowDays`, and take rough but honest magnitudes: day-to-day intake variation σ ≈ 400 kcal, day-to-day scale noise σ ≈ 1.0 kg, and an EMA whose standard error is about `σ·√(α/(2−α))` ≈ 0.23 kg per endpoint, so ≈ 0.32 kg on the delta.

**Standard error of the intake term** is `400/√daysLogged`:

| | 28 days | 14 days |
|---|---|---|
| 100% coverage | 76 kcal | 107 kcal |
| 80% coverage | 85 kcal | 120 kcal |

**Standard error of the energy term** is `0.32 × 7700 / windowDays`: **88 kcal** at 28 days, **176 kcal** at 14. Coverage does not enter it at all.

Combined, the worst admissible case (14 days, 80%) sits at ≈ 213 kcal and the best (28 days, 100%) at ≈ 116 kcal. Decomposing that gap: holding coverage at 100% and shortening the window 28 → 14 costs ≈ 90 kcal; holding the window at 28 and dropping coverage 100% → 80% costs ≈ 6 kcal. **On variance alone the weights should be roughly reversed** — window length is worth an order of magnitude more than coverage.

What keeps coverage in the argument is that its error is not only variance. Unlogged days are not a random sample of days: the large restaurant meal goes unlogged far more often than the ordinary Tuesday. If skipped days average Δ kcal more than logged ones, the estimate is biased low by `(1 − coverage)·Δ`, which does **not** shrink with a longer window and does not average out. At the 80% gate with Δ = 500 kcal that is a 100 kcal bias — comparable to the entire 90 kcal that window length is worth, and of a worse kind.

So the two are now the same order of magnitude, with the balance turning on Δ, which we cannot measure. Δ = 250 would argue for roughly 0.35/0.65 in favour of window length; Δ = 800 for roughly 0.65/0.35 the other way. **An even split is the honest answer to a quantity we do not know**, and it is a judgement rather than a derivation — the derivation only establishes that neither term dominates, which is the thing that actually changed.

The ramp stays linear. The MNAR bias is linear in `(1 − coverage)` by construction, and the variance terms are close enough to linear over these narrow ranges that a curve would imply more precision about the error model than the paragraph above can support. This number is shown to the user and used in no arithmetic, so its job is to be honestly *ordered* — more data must never read as less confident — not to be a calibrated probability. It is rendered as four steps labelled Rough / Early / Fair / Strong for the same reason: "73% confident" would claim a precision that does not exist.

Rejected: multiplying the two terms, which would report zero confidence for a fortnight of perfect logging. Rejected: letting confidence depend on the observed variance of the readings, which conflates "this estimate rests on little data" with "this person's weight is noisy", and the second is not a reason to distrust the number. Rejected: weighting by the variance calculation alone, which would score a sparsely-logged month as nearly as trustworthy as a fully-logged one and ignores the one error that logging more is the only cure for.

---

### D20 — Missing formula inputs return `source: "none"`, never a guess

Mifflin-St Jeor needs sex and age. `profiles.sex` defaults to `unspecified` and `profiles.birth_date` is nullable, so for a new account both are routinely absent. Substituting a default — "assume male", "assume 40" — would produce a maintenance figure that looks exactly like a real one and can be several hundred kcal wrong in either direction. The user has no way to tell, and D3 already commits us to never presenting a low-confidence estimate as fact.

So `estimateTdee` returns a third source:

```ts
{ tdee: null, source: "none", confidence: 0, missing: ["sex", "birthDate"], daysUntilAdaptive: 12 }
```

`missing` names exactly which profile fields are absent, so the UI can ask for those and nothing else. `daysUntilAdaptive` says how many more days of logging would produce an adaptive figure, so the pre-data state can tell the user what it is waiting for instead of showing a spinner or a zero.

The order of preference is adaptive, then formula, then none. Adaptive needs no profile fields beyond what logging already provides, so a user who logs consistently never has to fill in a birth date at all — the formula is the fallback, and "none" is the fallback to the fallback.

A silently guessed TDEE is worse than a visibly absent one: the absent one prompts a thirty-second profile edit, while the guessed one quietly poisons the daily target, the projections, and the user's trust in all of it.


---

### D21 — The interface is in Swedish, with no language switcher

Dates were already rendering `sv-SE` from the profile locale while every label around them was in English. That is the worst of both: it reads as an oversight rather than a choice, and it means neither language is actually right.

This is a self-hosted tracker for one household in Sweden. There is one language. Adding a switcher would mean maintaining a second set of strings, a preference column, and a fallback path, for a user base that does not want any of it.

`apps/web/src/i18n/` holds a single `sv` dictionary keyed by dot-separated ids, and a `t()` that takes a key and optional interpolation values. Deliberately minimal — no plural rules engine, no lazy loading, no context provider. What it does buy, which string literals scattered through components do not:

- **one place to read the whole voice of the app.** Tone matters here more than usual: §3 forbids a failure state, so the difference between "Du har inte loggat" and "Ingen viktnotering än" is a product decision, and it should be reviewable in one file rather than hunted across twenty components;
- **a translation that cannot silently go missing.** `t()` returns the key itself for an unknown id, which is conspicuous on screen and catchable in a test;
- **a seam if this ever does need a second language**, without committing to one now.

Introduced before phase 3 on purpose. Food logging is the highest-string-count screen in the app, and retrofitting an i18n layer across it afterwards would be several times the work of having it in place first.

Done in the same pass: the all-caps stat labels are now sentence case. §5 names all-caps labels as a generic-SaaS tell, and the strings were being touched anyway.


---

### D22 — The smoothing note disappears after 21 days of history

When the trend rests on few readings the headline figure can sit visibly away from the most recent reading — the scale says 88.3, the dashboard says 87.4 — and with nothing explaining the gap that reads as the app being wrong rather than as the app doing its job. So a short line under the headline says what the number is smoothed over, and then gets out of the way.

**Threshold: 21 days since the first reading**, not a count of readings. Under the corrected time-aware alpha (§4.1) the seed's influence decays per *day* at `(1 − α)^days`, independently of how often the user weighs in:

| days of history | weight still carried by the first reading |
|---|---|
| 7 | 47.8% |
| 14 | 22.9% |
| **21** | **10.9%** |
| 28 | 5.2% |

At three weeks the first reading contributes about a tenth, so the headline is genuinely a smoothing of recent data rather than partly an echo of wherever the user happened to start — which is the thing the note exists to explain. Before the §4.1 fix a reading count would have been the right measure and 21 readings would have meant 21 *weigh-ins*, five months at a weekly cadence; measuring in days is only correct because the decay is now per day.

The note is not a warning and is not styled as one. §3 forbids a failure state, and "your data is insufficient" is exactly the tone to avoid; it reads as an explanation of what the number is, which is true at every point in the series and merely more *useful* early on.


---

### D23 — One error, three times: every average is taken over the interval it was measured across

Three separate arithmetic bugs shipped in §4.1 and §4.2. They looked unrelated and were found weeks apart, but they are one mistake: **a numerator and a denominator measured over different intervals.** Recorded together because the pattern is the useful part, not the individual fixes.

| | The mismatch | Effect |
|---|---|---|
| §4.2 mean intake | `totalLoggedIntake` was summed over *logged* days and divided by *all* days in the window | at 82% coverage, maintenance ~18% light |
| §4.2 energy term | the trend delta spanned *first reading to last reading* and was divided by the *whole window* | at weekly cadence, a further ~5% light |
| §4.1 alpha | the smoothing step ran *per reading* while alpha was documented *per day* | at weekly cadence, a 2 kg loss rendered as 0.29 kg |

The corrected §4.2 divides intake by `daysLogged` and the energy delta by the span between the first and last reading in the window. §4.1 compounds alpha across the gap. All three are now spec, not deviations from it.

**Every one of them was invisible at 100% daily coverage.** With a reading and a log every day, `daysLogged == daysInWindow`, the reading span equals the window, and the gap is always 1 — all three denominators collapse onto the same number and the arithmetic is correct by accident. Every fixture written before this session used exactly that shape, which is why a suite with full coverage of the *code* had zero coverage of the *bugs*.

Two things follow, and both are now enforced:

- **Synthetic fixtures must vary cadence and coverage.** A test grid that only walks the happy path of the data model is not testing the model. `tdee.test.ts` runs the convergence invariant across weigh-in cadences, coverage levels, and non-constant intake patterns.
- **Cross-check derived numbers against each other, not just against stored expectations.** §4.3 computes the same future twice by different routes — from the planned deficit, and by regressing the resulting trend. On a series built from a known maintenance and a known intake they must agree. That single assertion catches all three bugs; a hand-computed expected value catches none of them, because the hand computation makes the same assumption the code does.

Rejected: keeping `daysInWindow` in the energy term on the grounds that the spec said so. The spec was wrong in the same way twice, and a specification that produces a demonstrably wrong number is a specification to amend, not to implement faithfully.


---

### D24 — A system intake floor the user cannot lower

`plans.intake_floor_kcal` is set by the user, and §3 lists the intake floor as a guardrail *enforced server-side, not just in the UI*. A limit whose owner can move it downwards is not a guardrail; it is a reminder. On a bad evening the field that stops someone setting 900 kcal is the same field they can edit to 900.

`SYSTEM_INTAKE_FLOOR_KCAL` is instance configuration, defaulting to **1200 kcal**, and the server checks `max(systemFloor, userFloor)`. The user's own number may only ever *raise* the limit, and the field is labelled and described as doing exactly that.

1200 is the conventional line below which sustained intake is a matter for medical supervision rather than an app. It lives in `.env` rather than in the source because the one person who could legitimately need it moved is whoever runs their own instance — and moving it is then a deliberate act on a server, visible in configuration, rather than a slider reachable in a moment of enthusiasm.

A rejection says **which** limit was hit, because the two have different remedies: the user's own floor can be lowered (to a point), the system floor cannot be touched from the app at all. Two codes, `intake_below_floor` and `intake_below_system_floor`, and two messages.

Rejected: hard-coding the floor as a constant, which would make an operator with a genuine reason patch the source. Rejected: silently clamping the target up to the floor, which would write a plan the user did not ask for and did not see.

---

### D25 — A plan is re-checked when maintenance moves, and the user decides

The rate guardrail is validated once, at plan write time, against a maintenance figure that is *expected to change*. That is the whole design: D3 says the adaptive number corrects itself from real data. So a plan validated against a formula estimate — or against nothing, when maintenance was `"none"` — can silently come to imply a rate the guardrail would have refused.

This is not hypothetical. The §4.2 fix moved the seeded account from 2083 to 2499 kcal, which changes the implied deficit against a 2000 kcal target from 83 kcal/day to 499 — a sixfold change in the rate the same plan produces.

**When it re-checks.** On reading insights, the active plan is re-validated against the current maintenance figure whenever either holds:

- the TDEE **source improved** — `none` or `formula` to `adaptive`. The plan was validated against a guess or against nothing; the first real figure is the first meaningful check.
- the adaptive figure has **moved materially** since the plan was written.

**"Materially" is 10%.** Below that the change is within the noise the estimate carries anyway: §4.2's own standard error is ~116 kcal at full coverage over 28 days (D19), which is 4.5% of a 2600 kcal figure, and a threshold inside the error band would fire on nothing but sampling. 10% of 2600 is 260 kcal — about half a day's deficit, enough to move a goal date by weeks. It is also comfortably above the ~4.5% the estimate wanders on its own, so a notice means something changed rather than that a scale reading was noisy.

**It never rewrites the plan.** A guardrail that silently edits the user's targets is worse than one that fires late: the plan is the user's statement of intent, and the app's job is to say the intent now implies something different, not to substitute its own. `GET /api/insights` returns a `planReview` describing what changed and what the plan now implies; the dashboard surfaces it; the user edits the plan or dismisses it.

Rejected: re-validating on write only, which is the bug. Rejected: blocking the dashboard until the plan is re-confirmed, which punishes the user for the estimate improving.


---

### D26 — One parser and one formatter for every number

`Number("180,0")` is `NaN`. A comma is what a Swedish numeric keypad produces, and after D21 made the interface Swedish, every numeric field in the app was quietly rejecting values typed the way the app itself invited. Worse, the failure surfaced as a validation error on a correctly-entered number, which reads as the app being broken rather than fussy.

`packages/shared/src/numbers.ts` holds exactly two entry points. `parseDecimal` for anything arriving from an input; `formatDecimal` (and its `formatKcal` / `formatKg` / `formatForInput` wrappers) for anything going onto a screen. No component does its own `toFixed` or `toLocaleString`.

**Ambiguity is refused, not guessed.** `1,234` is one thousand two hundred and thirty-four to an English reader and 1.234 to a Swedish one. Both readings are defensible, the difference is a factor of a thousand, and a weight tracker that silently picks one is worse than one that asks. The parser returns a reason — `empty`, `not_a_number`, `ambiguous` — and the UI says which.

**Display and input formatting are different jobs.** Screen output groups thousands (`2 499`); a value going *into* a field does not, because a non-breaking space inside an `<input>` is awkward to edit and some mobile keyboards cannot produce one. Both use the locale's decimal separator, so a field pre-filled from a stored value shows `180,0` and matches the keyboard the user is about to type on.

The other half of this fix is in the markup: **`<input type="number">` discards a comma before any JavaScript sees it**, so a locale-aware parser behind one never runs. Every numeric field is `type="text"` with an `inputMode` for the right keypad. That gives up the browser's own `min`/`max`/`step`, which was never doing the real validation anyway — the Zod schema and the server were.

Rejected: `Intl.NumberFormat.formatToParts` to derive separators at runtime, which is the general solution to a problem this app does not have. There is one locale (D21); hard-coding its two separators and accepting the other one anyway is simpler and covers a user pasting from an English spreadsheet.


---

### D27 — The planned rate is derived from the target, not stored beside it

`plans.target_intake_kcal` and `plans.target_rate_kg_week` were independent fields, and they had already drifted: an 1800 kcal target against a 3000 kcal maintenance implies **1.09 kg/week** while the stored rate said **1.00**. Nothing noticed, because every projection in §4.3 works from the deficit — the stored rate affected nothing at all. It was a number the user typed, the guardrail checked, and the app then ignored.

**The target is what the user sets; the rate is derived.** `targetRateKgWeek` is gone from the create and update schemas, computed on every save as `impliedRateKgWeek(tdee, targetIntake)`, and returned read-only. The guardrail checks the derived rate, so the 1%-per-week cap now applies to what the plan *does* rather than to what was typed next to it.

**Why that direction and not the other.** Setting a rate and deriving the target reads better as intent — "lose half a kilo a week" is what a person actually wants. But deriving a target from a rate requires a maintenance figure, and maintenance is frequently `"none"` (D20): no logged intake, or no sex and birth date. A plan would then be unsettable at exactly the moment people want to set one. Intake is the number that can always be entered, and it is also the number acted on daily, so it is the one that is stored.

The UI shows the implied rate beside the target as read-only feedback, which keeps the intent visible without letting it disagree with the plan. A test asserts `implied === stored` across several targets; it cannot drift again without failing.

---

### D28 — A plan cannot be saved before a weight has been logged

Both plan guardrails need a weight. The 1%-per-week cap is a percentage *of bodyweight*, and the deficit that the cap is applied to comes from maintenance, which needs a weight series. With neither, `checkPlanGuardrails` had nothing to check and the plan saved **completely unvalidated**.

That is not a rare edge. It is the default path: a new user opens the app, sets a plan in the first minutes, and logs their first weight afterwards. The one plan most likely to be aggressive was the one plan nothing looked at.

So a plan now requires at least one weight reading, with a 422 carrying `no_weight_reading` and copy that says *what cannot be checked* rather than just refusing — "logga en vikt först, utan den finns det inget att räkna kaloriunderskottet mot, och ingen kroppsvikt att mäta 1 %-gränsen mot". Enforced on create and on edit, and the D25 re-review runs the same check.

Rejected: saving the plan and validating later, which leaves a window where the app has accepted something it would refuse. Rejected: falling back to a default bodyweight for the cap, which is D20's mistake in another costume — a guardrail measured against a number nobody supplied is not a guardrail.


---

### D29 — Open Food Facts data is ODbL, and caching it carries obligations

`food_items` caches everything looked up, so this instance holds a derived copy of an Open Food Facts extract. That data is licensed **ODbL 1.0**, and the licence follows the copy.

What that means here, in practice:

- **Attribution.** Any screen showing a food sourced from Open Food Facts must credit it. `food_items.source` already records provenance per row, so the UI can attribute per item rather than with a blanket footer.
- **Share-alike on a Produced Work.** ODbL's copyleft binds the *database*, not the individual facts. A personal food diary derived from it is a Produced Work; publishing the cached database itself, or a substantial extract, would require offering it under ODbL.
- **This instance is private**, single-household, behind authentication, and never publishes a food list. That keeps the obligation to attribution alone. **Phase 7's CSV and JSON export is where this needs thinking about again**: an export containing OFF-derived rows redistributes them, and if that ever becomes a public artefact rather than one user's own copy of their own diary, the share-alike clause engages.

Livsmedelsverket's livsmedelsdatabas is separately licensed and less restrictive, but the same per-row `source` makes it attributable in the same way.

Rejected: not caching, so as to sidestep the licence. Their rate limit makes a cache mandatory rather than optional — 15 product reads a minute for the whole server means the second scan of the same tin must be local.

---

### D30 — The outbound rate limit is the server's, not the user's, and it queues

Open Food Facts allows **15 requests a minute for product reads and 10 a minute for search, per IP**. Every call this app makes leaves one server address, so that budget is shared across every user of the instance. A limiter keyed on the user would enforce nothing.

So `food/rate-limit.ts` holds one limiter per endpoint class, created once at boot and decorated onto the Fastify instance. Consequences worth stating:

- **It queues rather than bursting.** A caller waits its turn instead of being rejected, because the failure mode being designed against is a barcode scan in a shop that fails because someone else logged lunch a second earlier. Waiters are serialised, so three arriving together take the next three slots in order rather than all waking at once and firing four requests into a budget of one.
- **It gives up eventually.** Past `maxQueueMs` a caller gets `RateLimitExceeded`, which the adapter turns into `AdapterUnavailable` and the service turns into a **cache-only answer with a message**. A scanner that returns nothing is a scanner that stops being used; one that says "showing what is already saved" is not.
- **Search is never wired to keystrokes.** A three-character minimum lives in the Zod schema, so the server refuses a shorter query however the client is written, and the local cache is always consulted first — a search that the cache can satisfy never spends a slot at all.

It is deliberately in-process: there is one API container (D12), and a cross-replica limiter would need Redis for replicas that do not exist.

Rejected: a token bucket that bursts. The published limit is a rate, and bursting to it makes the *next* user wait the full window.

---

### D31 — Activity calories are unavailable on an adaptive maintenance figure, not merely switched off

`profiles.add_exercise_to_target` used to be a preference defaulting to off. That is not enough, because on an adaptive figure it is not a preference at all — it is a double count.

§4.2 derives maintenance from what the trend line **actually did** against what was **actually eaten**. Every calorie burned on a run is already inside that number: the run made the weight fall, the falling weight is what the formula reads. Adding the run again on top counts it twice, and unlike an ordinary estimation error this one scales with training volume, so it lands hardest on the people training hardest — the exact people most likely to go looking for the switch.

So the rule is by source, computed fresh every day:

| maintenance source | toggle | reason |
|---|---|---|
| `adaptive` | **unavailable** | the figure already contains the training |
| `formula` | available, may apply | Mifflin × activity factor is a baseline that knows nothing about today |
| `none` | unavailable | there is nothing to add to |

Held in three places, because two of them alone would be decoration:

- `exerciseAdjustment(preference, source)` in `calc/activity.ts` is the single definition, shared by server and client;
- `PATCH /api/me/profile` **refuses** `addExerciseToTarget: true` with `422 adaptive_includes_activity` while the source is adaptive. A greyed-out checkbox is a UI detail; the 422 is what makes "unavailable" true;
- the profile screen disables the control and says why, and the daily screen states which case is in force where the consequence actually shows up.

The stored preference is **preserved rather than cleared** when it becomes unavailable. Someone who set it during their formula weeks has not changed their mind, and silently rewriting their row would be a lie about what they asked for. But it does not creep back either: `inForce` is recomputed from today's source, so crossing into adaptive on day 28 switches it off without touching the row. Tested in both directions, including that crossing.

Rejected: clearing the row when it becomes unavailable — destroys a stated preference to save one boolean. Rejected: allowing it and subtracting the estimate elsewhere to compensate — two rough numbers cancelling is not the same as one right number, and nothing on screen would explain the arithmetic.

---

### D32 — Measurements are smoothed by the §4.1 EMA, reusing `calc/trend.ts` rather than reimplementing it

A waist measured by hand carries roughly **±1 cm**: tape tension, exactly where it sits, whether you had just breathed out. A month of steady loss moves a waist about the same distance. So on a raw waist chart the measurement error and the real change have the same amplitude, and the eye genuinely cannot separate them — the same argument that makes trend weight the primary number (D2), only with a worse signal-to-noise ratio.

Measurements therefore run through the **same time-aware EMA as weight**, smoothed line in front, raw points behind, exactly like the weight chart.

The important half is the second one: `computeTrend` was generalised into `computeSeriesTrend(readings: DatedValue[])` and now delegates to it, so there is **one** implementation of §4.1 in the codebase. Measurements and waist-to-height call that same function. A second copy would drift — and the drift would be silent, because both copies would look right in isolation. The existing 34 trend tests pin the weight path bit-for-bit through the refactor, and `whtr.test.ts` asserts the ratio series equals `computeSeriesTrend` applied to waist rather than merely resembling it.

`whtr.ts` (§4.4) divides the **smoothed** waist by height. Height is constant, so smoothing the waist and dividing is the same operation as smoothing the ratio — done on the waist so one number is smoothed once. It is plotted on the trend chart's own time axis as a **toggleable second series**, off by default: it earns its place, but two lines by default would cost the trend line the hero position §5 gives it. It gets its own right-hand axis, since a ratio near 0.5 and a weight near 90 cannot share a scale, and it is dashed as well as differently coloured so the chart stays readable without relying on colour.

`smoothedChange()` exists for the same reason: two raw readings 30 days apart differ by the real change plus up to 2 cm of tape error, so quoting that difference states a number that is mostly noise.

Rejected: showing raw measurements only. Rejected: a separate, simpler smoother for measurements "because they are less important" — that is how two implementations of one formula get into a codebase.

---

### D33 — MET-derived activity calories are estimates, kept out of every calculation

`kcal = MET × 3.5 × kg / 200 × minutes` is the standard ACSM form, and the number it produces is a population average applied to one person. Compendium MET values span a wide range of body compositions and efficiencies; the same 40-minute run differs by well over 30% between two people; and the intensity is a self-reported 1-5 chosen after the fact.

So the figure is **stored and displayed as an estimate, and read by nothing**. Concretely, it does not reach `estimateTdee`, either projection, or the daily target. `apps/api/test/exercise-target.test.ts` asserts this end to end: logging a week of hard training leaves the entire insights payload **byte-identical**. Not close, not within rounding — identical. The correlation view plots activity **minutes** rather than the kcal estimate for the same reason: minutes are measured, kcal is inferred, and putting an inference on an axis makes it look like data.

The estimate is computed **server-side** from the MET table and the body weight already on file, never accepted from the client — two devices would otherwise disagree, and a number the client can set is a number that can be set to anything. With no weight reading it is `null` rather than assuming a default: the formula is linear in weight, so a stand-in of "75 kg" is a silent 20% error for plenty of people (D20's rule again).

The UI says what it is for, in those words: *"en anteckning om vad du gjort, inte ett underlag för räkningen"* — a record of what you did, not an input to the maths.

Rejected: hiding the number entirely. People want to know roughly what a session cost, and refusing to say sends them to a worse estimate elsewhere. Rejected: showing it beside the day's intake, where proximity alone would imply it nets off.

---

### D34 — The correlation view shows data, sample size and date range, and computes no statistic

No r, no r², no p-value, no fitted line, no "strong/weak", no causal language. This is a deliberate constraint, recorded so that a later change adding a trend line has to reopen the decision rather than drift past it.

The reasoning is not that statistics are hard. It is that every pair on this screen is **one person's self-report over a few weeks**, and each candidate relationship has an obvious third cause:

- sleep against energy is confounded by the working week, by illness, and by the fact that a day already going badly gets both rated low;
- activity against sweat is partly a definition rather than a finding;
- intake against trend change is confounded by salt, by glycogen, and by the coverage of the food log itself — a stretch of poor logging moves both axes at once.

An r of 0.41 over 23 self-rated days **looks like a finding**. It is not one, and it is worse than useless because a number on a chart reads as evidence in a way the same claim in prose would not — and this is a screen whose whole purpose is to change what someone does next.

What twenty-odd points honestly support is looking at them. So each pane shows the points, the sample size, the number of half-logged days it had to drop, and the dates covered. Below the minimum (14 paired days) it shows a designed pre-data state — how many it has, how many it needs, what to log — rather than a four-point scatter.

Enforced in four places rather than described in one: `calc/correlate.ts` has a test asserting its own source contains no coefficient, regression or fit; the response schema carries no such field; an API test asserts the JSON has no field named after one; and `Correlations.tsx` has no `<Line>` in it. Half-logged days are dropped by an inner join, never filled with zero — a column of points at x=0 is itself a fabricated pattern.

Rejected: showing r "with a caveat". The caveat is read once and the number is read every time. Rejected: a trend line "just to guide the eye" — guiding the eye is precisely the claim that is not supported.

---

### D35 — An unlogged day is unknown to the sober counter, not dry

`daily_log.alcohol_units` is nullable, and a day may have no `daily_log` row at all. So "null or zero means sober" has two ways of being wrong and only one of them looks wrong: it counts every day nobody logged as a dry day.

Follow that through. The counter would grow **fastest for the person who stopped using the app**, a month of silence would read as a month of sobriety, and a savings rule keyed on the counter would pay out real money for it. This is the third appearance of absent-is-not-zero in this codebase (mean intake in §4.2, missing macros in D4), and it is the first time the conflation writes to a ledger.

So an unlogged day is **unknown**, and unknown breaks the chain of *knowing* rather than the chain of not drinking. Two modes, and the UI always names which one produced the number:

- **`strict`**, the default. The count spans only days actually logged; a gap ends it and the copy says the count runs from the last logged day. A day logged with a blank alcohol field is a gap too: the row's existence says something was recorded, not that this question was answered.
- **`assumeSober`**, opt-in, stored on the profile as `sober_assume_unlogged_dry`. Some people genuinely only open the app when something happened, and for them the strict reading is useless. It is a stored preference rather than a display toggle precisely because a savings rule can be keyed on the counter: the number on screen and the number in the ledger must never mean different things.

`SoberCount.basis` distinguishes `no_data`, `gap`, `since_drink` and `never_recorded`, so the copy can be specific rather than showing a bare number whose meaning depends on invisible state. The test that pins it: one drink logged, one dry day logged, then a month of silence. Strict says 0 days on a `gap` basis; permissive says 31. Both are defensible readings of the same rows, which is exactly why the app has to say which one it is doing.

Rejected: a single mode, either way. Strict-only makes the counter useless for occasional loggers; permissive-only pays out for silence. Rejected: inferring the mode from logging density, which would make the number change meaning without anyone choosing.

---

### D36 — The EMA's lag gets a visible "close to this one" state

At daily cadence the time-aware EMA lags a steadily changing series by `(1 - alpha) / alpha` = **nine days** (§4.1, derived in `trendLagDays`). So someone falling 0.1 kg a day sees 99.9 on the scale about nine days before the smoothed line crosses 100 and the milestone fires.

That lag is correct and is the entire point of smoothing: detection on the raw value would fire on one dehydrated morning, which is a milestone that fires on nothing. But **silent** lag is indistinguishable from a broken feature. Someone watches the number they have been chasing appear on the scale, opens the app, gets nothing, and concludes milestones do not work. Nine days is long enough to stop trusting it.

So the raw series drives a visible state while the trend still decides achievement:

| state | meaning |
|---|---|
| `raw_reached` | the scale has shown the number; the smoothed line has not crossed yet |
| `close` | the trend is within a band of the target |
| `open` | further off, or nothing to measure |
| `achieved` | stamped, permanent |

`raw_reached` is deliberately distinct from `close`, because it is the precise moment someone goes looking for the celebration, and the copy answers the question they actually have: the scale has been there, the line follows in a few days, and it waits so that one bad morning cannot trigger it.

The band is a fraction of the metric's own scale with an absolute cap, since 0.5 kg, 0.5 cm and 0.005 on a ratio are not comparable distances.

Rejected: detecting on the raw value and "confirming" with the trend, which is two sources of truth and a milestone that can un-fire. Rejected: shortening alpha so the lag is smaller, which trades a visible explanation for a noisier line everywhere else in the app.

---

### D37 — Savings offsets live inside the daily screen, not in a flow of their own

An offset is the row that says "I did buy the lunch after all". Without them the pot only ever grows, and a pot that only grows is not a record of anything.

The failure mode is not technical. Offsets are the least rewarding thing in the app to enter — they *reduce* a number the user likes watching go up — so anything that makes them a separate errand guarantees they go unfiled. The pot would then be confidently wrong, and confidently wrong about money, which is worse than not tracking it: it would be spent against.

So they are folded into the daily screen that already gets opened every day, as part of the same single pass as sweat and sleep. Concretely:

- `GET /api/day` returns the rules whose cadence **matched that day**, each flagged with whether an offset is already filed. It is never a menu of things that did not happen;
- one tap per rule, toggling, with no confirmation step;
- the write is idempotent on `(rule_id, local_date)`, a natural key, so a replay from the offline queue files one fact rather than two deductions;
- the cadence test is `dayMatchesCadence` from the shared calc package, not a local copy, so the screen offering the offset and the sum applying it cannot disagree about a Sunday.

Measured cost: a full daily log with one offset is **9 taps**, one more than without.

Rejected: a savings screen with a date picker, which is where offsets go to not be entered. Rejected: prompting for offsets, which turns the least rewarding action in the app into the most nagging one, against §3.

---

### D38 — The celebration is tracked by its own timestamp column

A milestone reached should produce one deliberate moment, not a dialog on every dashboard load until something happens to make it stop.

That needs "achieved" and "already celebrated" to be **two facts**, and the second one needs somewhere to live. `milestones.celebrated_at` is that column: an ordinary timestamp that nothing cascades to, per §3 and D17.

The alternatives all fail in a specific way:

- **infer it from `achieved_at`** — there is nothing to infer from. The two are the same fact, so any rule ("show it if achieved in the last hour") is a guess that either re-fires or misses;
- **a nullable foreign key** — D17's whole subject. A flag that a `SET NULL` cascade can flip back to "has not happened" is a flag that will;
- **client state** — re-fires on reload;
- **`localStorage`** — re-fires on the other device, which for this app means the celebration you already saw on the phone appears again on the desktop.

`savings_events.milestone_id` is likewise **not** the answer to "has this reward been paid": D17 names it as provenance only, and it is `ON DELETE SET NULL`. `milestones.reward_claimed_at` is that answer, and there is a test asserting a reward stays claimed after its payout event is deleted.

Two more details worth stating. `markAchieved` filters on `achieved_at IS NULL` in the UPDATE itself rather than checking first, so two writes arriving together (a weight and a measurement in the same second, or the offline queue replaying) cannot both stamp it and re-fire the moment. And acknowledging an already-acknowledged celebration is a **204, not an error**: a double tap or a replayed request is not a failure.

Rejected: a `celebrated boolean`. A timestamp costs the same and answers "when", which is worth having the first time anyone asks why a milestone from March showed up in May.

---

### D39 — `local_date` is stamped when an entry is created, never when it is sent

§3 already says the client computes the day and the server never derives one. The offline queue is where that stops being a formality: a queued entry has two candidate days, the one it was written on and the one it was sent on, and they are routinely different.

An entry typed at 23:50 and synced at 08:00 the next morning belongs to the day it was typed. Deriving the day at send time would move it forward, silently, and only for people who log late in the evening — which is most people, some of the time, and disproportionately the meals worth logging.

So `localDate` is a **column on the queued row**, computed at creation from the user's zone and written through untouched. The same applies to the zone itself: an entry created in Tokyo and synced in Stockholm keeps Tokyo's date. The test that pins it uses 16:00 UTC, which is 01:00 the next day in Tokyo and still 17:00 the same day in Stockholm — one instant, two dates.

`enqueue()` takes an injected `now` rather than reading the clock, for the same reason every function in `calc/` takes `asOf`: a unit that reads the clock cannot be tested across midnight, and midnight is the entire subject. Faking the clock globally is not available here, because IndexedDB's own transactions need real timers to settle and `vi.useFakeTimers()` deadlocks Dexie.

Rejected: sending `loggedAt` and letting the server bucket it. That is precisely the mistake §3 was written to prevent, and it fails hardest for travel and midnight, the two cases it would exist to handle.

---

### D40 — A replay is a normal event, and the interesting case is the lost response

Every log endpoint has upserted on `(user_id, client_uuid)` since Phase 1, and this is the phase that spends it. Nothing on the server changed to make the queue possible, which was the point of building it that way three phases early.

The failure mode worth naming is not "the client sent it twice". It is **the server committed and the response was lost** — a dropped connection after the write, a tunnel closing, a browser killed between the commit and the read. The client never heard success, so it retries, and it must get the same row rather than a second one or an error. There is a test for exactly that shape, and it is the one that would catch a well-meaning change to `ON CONFLICT DO NOTHING` or a uniqueness error surfaced as a 409.

Consequences that follow:

- a succeeded mutation is **deleted** from the queue rather than marked sent. Keeping it would make the queue a second copy of the log that has to be reconciled with the first, and the server is the record;
- re-queueing an existing `clientUuid` **amends** the pending body rather than adding a row. Correcting an entry that has not synced yet is one pending write, not two;
- `clientUuid` comes from `lib/uuid.ts` (D18), never `crypto.randomUUID`, which is `undefined` in exactly the insecure context this queue exists to serve;
- mutations are sent in creation order, so a food entry logged before a weight reaches the server in that order and the milestone detection on the second sees the first.

---

### D41 — Two devices on one day: the live write wins, and the loser is shown

`weight_log` is unique on `(user_id, local_date)`, so a weight logged offline on the phone and another on the desktop means one of them loses. Last-write-wins would make the outcome depend on which request happened to arrive first, which is not a rule anyone can predict or explain.

The rule is about **what kind of write it is**, not when it turned up:

- a **live** write replaces the day. The user is looking at the current value and chose to change it;
- a **queued** write does not. It was composed before the other device's reading existed, so it cannot have been a decision to replace it. It is refused with `409 day_already_written`.

That is deterministic in both orderings, and there is a test that runs them in both. Replaying the *same* `clientUuid` is never a conflict, because that is one write arriving twice (D40).

Nothing is discarded. The refusal carries the reading it lost to, so the client can show both without a second round trip to a network that may already be gone; the losing entry stays in the queue marked `conflict`; and the user chooses in the inspector. A conflict is a question, not an error.

The `fromQueue` flag on the request body is what distinguishes the two. It is set by the queue and by nothing else.

Rejected: resolving by `loggedAt`, earliest or latest. Both are defensible and neither is explainable to someone looking at two numbers, and inventing a semantic rule about which measurement is "truer" is a worse answer than asking. Rejected: merging, which is meaningless for a scalar.

---

### D42 — A rejected mutation stops, keeps what was typed, and asks a person

A 4xx means the server read the entry and said no: an intake under the floor, a value out of range. Retrying sends identical bytes to an identical rule and gets an identical answer, so a retry loop is an infinite loop that also burns battery.

So the two failure kinds are separated, and they behave differently:

| | retried | ends as |
|---|---|---|
| transport (offline, DNS, dropped tunnel) | yes, up to 8 attempts, exponential backoff to 5 min | `failed`, entry kept |
| server refusal (4xx) | **never** | `failed`, entry kept, with the server's message |
| `409` | never | `conflict` (D41) |
| `401` | yes, indefinitely | stays `pending` |

`401` is the one worth explaining: an expired session is not the entry's fault, and failing the entry would lose data at the exact moment the user needs to sign in again. It stays pending and goes out after the next sign-in.

Backoff lives in a `nextAttemptAt` **column**, not a `setTimeout`, so a retry schedule survives a reload, a tab close and the app being killed — which on a phone is most of the time.

Recovery is in the queue inspector in settings: the entry is shown with the server's own message verbatim, and the two actions are retry and discard. Discard is never automatic. Every row in that list is something a person typed, and the app does not get to decide it was not worth keeping.

---

### D43 — Offline, an unavailable number is absent and says so

§3 rules out two answers here, and they are the two that come naturally: a stale number presented as current, and a spinner that never resolves.

What works offline is everything the device can do by itself, which is **all logging**: weight, food, the daily log, measurements, activity and savings offsets are written to IndexedDB immediately and sent later. The trend line keeps drawing, because it is computed in the browser from data already fetched.

What does not work is everything that needs server-side aggregation: maintenance, both projections, the correlation view, the pot and milestone detection. Those render an explicit notice naming what is unavailable **and what still works**, because "you are offline" on its own reads as "nothing works" when in fact the thing people opened the app to do is precisely the thing that does.

The service worker enforces the first half: `/api/**` is `NetworkOnly` and excluded from the navigation fallback, so there is no path by which a cached maintenance figure can be served as a current one. The app shell is precached, so the app opens; the data does not come with it.

`navigator.onLine` is used only to decide **when to retry**, never to decide what to show. It reports a connection to a captive portal, to a wifi network with no route out, and to a tunnel that has dropped. What the UI shows is driven by whether requests actually succeeded, which is the only thing that can be known.

---

### D44 — Intake resolution has one implementation, and it reads both tables

`calc/intake.ts` has defined a day's intake since Phase 2: the `manual_intake` row if there is one, otherwise the sum of that day's `food_entries`, otherwise **absent**. The rule was never wrong. What was missing was anywhere that assembled both halves.

Four call sites each built the index themselves and each passed `manual` only. Nothing failed, nothing logged, and a day with a full food log counted as a day nobody logged.

The visible symptom was the dashboard saying "Inte än" for calories on a day with 1 484 kcal of food in it. The invisible one was worse: **`estimateTdee` was reading the same short index**, so food-only days were excluded from the §4.2 coverage gate. Enough of them and maintenance falls back to the Mifflin formula while the user logs every single day and is told their coverage is too low.

The mean was not dragged toward zero the way the D23 bug was, because `meanIntake` divides by `daysLogged`. It was computed over a **subsample**: only the days logged one particular way. That is a subtler error and not obviously a smaller one, since which method someone reaches for is not random — the manual row is the escape hatch for restaurant meals and guesses, which are exactly the days that differ.

So there is now one function, `resolveIntake(userId, db, range)`, which reads both tables and returns the index. No caller constructs one. Forgetting the food half is no longer something a call site can do, which is the only fix that stays fixed.

The dashboard was the fourth consumer and the worst kind: it read `manual_intake` from the client and did its own resolution, a second definition of a logged day living in a second place. `GET /api/insights` now returns `todayIntakeKcal`, resolved server-side, and the client holds no opinion.

Rejected: fixing the four call sites and leaving the pattern. They were correct once too.

---

### D45 — A sober run that predates the app is seeded by one date

The counter can only be built from `daily_log` rows, so someone eighty days sober when they install this has nothing to build it from. Asking them to backfill eighty days to see a number they already know is how a feature goes unused.

`profiles.last_drink_on` seeds it. Three properties make it fit alongside D35 rather than undermining it:

- **It is a floor, not a source of dry days.** It says "nothing before this counts", and the days it covers are `[seed, first logged day)`. It does not claim those days were dry, only that the run started then.
- **A logged drink after it wins**, because a recorded fact beats a remembered one. A logged drink *before* it is ignored, because the seed is the later statement about the same stretch of time.
- **It does not paper over gaps.** A hole inside the logged era still stops a strict count exactly as D35 says it must. The seed answers for the era before logging began, and for nothing else.

`SoberCount.basis` gains `seeded`, so the UI can say which of the five things produced the number rather than showing a bare count whose meaning depends on invisible state.

Rejected: inferring a start date from the first `daily_log` row, which would silently reset the counter for anyone who logged a drink on their first day. Rejected: letting the seed suppress gap detection, which would make the permissive reading the default for seeded users without anyone choosing it.

---

### D46 — Local food search ranks, and the ranking is the feature

Search was `ILIKE '%query%'` ordered by `fetched_at DESC`. The matching was fine. The ordering was import order, which has nothing to do with relevance.

Searching "banan" matched about forty rows and returned the twelve most recently imported: a chicken gratin, two infant porridges, a Flygande Jakob. The plain "Banan" was in the result set and ranked off the page, so the honest description of the bug is not "search finds nothing" but "search finds everything and shows the wrong twelve".

Three ways to match, because they fail differently:

- a Swedish `tsvector`, via `websearch_to_tsquery`, which stems (so "ägg" finds "Ägg kokt") and which cannot raise a syntax error on whatever a user types, unlike `to_tsquery`;
- a plain substring, for partial words a stemmer will not join up;
- trigram similarity above 0.3, for typos, which no amount of stemming reaches.

The ranking, in order of weight: an exact name, then a prefix, then `ts_rank` with normalisation 1 (which divides by the log of the document length, so a short name beats a long compound dish on the same matched lexeme), then trigram similarity, then a **bonus for an unbranded food**. For a bare noun the generic entry is almost always what was meant; a brand is a specific request and reads as one.

The `search_vector` column is `GENERATED ALWAYS AS ... STORED` rather than trigger-maintained or application-maintained. A trigger has to be remembered by every writer, and an application-side column drifts the first time a row is inserted by a script — which this table has, in the Livsmedelsverket importer.

---

### D47 — Derived data has one owner, and the owner is enforced

Five defects across five phases had one shape: a correct rule in a shared module, and call sites that reached past it.

| what | how many bypassed | how it showed up |
|---|---|---|
| intake resolution | 4 call sites | food-logged days counted as unlogged, corrupting the §4.2 coverage gate (D44) |
| colour tokens | 7 files | a modal backdrop with no background at all, and six dead declarations |
| number formatting | 3 components | `Vid 87.27` in a Swedish interface |

The Phase 6 guards handle the typeable half of this: a class name that resolves to nothing, a number interpolated into JSX without the formatter. This half is **not typeable**. `listManualIntake(userId, db, {})` is a well-typed, correct call. The only thing wrong with it is who is making it, and no type system asks that question.

So ownership is declared rather than hoped for. Each derived concept has exactly one module that assembles its inputs, and `eslint-rules/derived-data-owner.js` names the tables and readers that belong to it:

| concept | owner | what it owns |
|---|---|---|
| a day's intake | `services/intake.service.ts` | `manual_intake`, `food_entries` as calories |
| the weight series and TDEE | `services/series.service.ts` | `weight_log` |
| which days count as logged | `services/series.service.ts` | the existence of rows, never their values |

`resolveLoggedDays` is worth its own line because it reads `food_entries` and must **not** go through `resolveIntake`: the streak asks whether someone turned up, not what they ate. Two questions, two answers, one owner each.

The rule is deliberately shallow. It matches imported identifiers, not data flow, so it is a signpost at the point of temptation rather than a proof. That is the right trade for a rule whose job is to make someone stop and read the owner's doc comment before writing the fifth version of a rule that already exists.

The token half of the same problem is fixed differently and better, by removing the failure mode instead of guarding it: see the tokens note in D48.

Rejected: another test. There were already two, and both were written after the fact for defects that had shipped. A guard that fires at the moment of writing beats one that fires at the next full run.

---

### D48 — Tokens are colours, not RGB channels

The tokens were space-separated triples (`22 35 43`) so Tailwind's `<alpha-value>` could wrap them in `rgb(...)`. That worked perfectly through a Tailwind class and failed silently for every other use:

- `bg-[var(--logged)]` compiled to `background-color: 22 35 43`, which is not a colour. The browser dropped the declaration. Seven files were doing it.
- `bg-[var(--ink)]/70` emitted **no rule whatsoever**, which is how the celebration dialog shipped with a fully transparent backdrop.

Neither errored, and neither is visible in a diff.

The tokens are now real colours (`#16232b`), and opacity comes from `color-mix(in srgb, var(--ink) calc(<alpha> * 100%), transparent)` in the Tailwind config. `bg-ink/70` still works, and so does the raw `bg-[var(--ink)]` that used to be a silent no-op — which is the actual win. The representation makes the mistake impossible rather than detectable.

The chart reads tokens straight out of the computed style for SVG presentation attributes, which do not resolve `var()`. Hex needs no unwrapping there, and `alpha()` builds a `color-mix` string, which SVG accepts.

`--muted` darkened from `#6B7B82` to `#5C6B72` on light, where it was 3.9:1 against `--paper` and is now above 4.5:1. A `--surface` token joins the set: one step of separation for the dashboard's insight block, which §5 wants grouped without becoming a grid of identical cards.

---

### D49 — One milestone per metric and target

Nothing stopped two milestones with the same metric and target existing side by side, and the app handles that badly rather than harmlessly. Detection stamps both, because both are legitimately un-achieved when the trend crosses. The celebration then fires **once for each**, because `celebrated_at` is per row (D38) and both rows are genuinely uncelebrated. Reaching 100 kg would be announced twice, in the one moment the product is trying to make feel earned.

Two identical milestones are not two goals. They are one goal entered twice, which is a mis-tap or a double-submit. So `POST /api/milestones` refuses the second with `409 milestone_exists` and names the one already there, since "you already have this" is only actionable if you can see which.

What stays allowed:

- **different targets on the same metric**, which is the normal case and the intended use: 100, then 95, then 90;
- **the same target on a different metric**, because 100 kg and a 100 cm waist are unrelated;
- the same metric and target for a **different user**, obviously.

Uniqueness is enforced in the service rather than by a database constraint. A partial unique index would be the stronger guarantee, but it would also make the refusal a driver error rather than a message someone can read, and it would need care around `target_value`'s numeric scale. The check is a scoped lookup immediately before the insert; a race between two identical submissions would create a duplicate, which is worth exactly what it costs to prevent here.

The pair found in the working data was on the `test@example.test` verification account, created by two runs of the same browser script, not by a defect in the app. It has been removed.

Rejected: allowing duplicates and de-duplicating at celebration time. That leaves the list showing two identical rows, which is confusing on its own, and puts the rule in the place least likely to be read.

---

### D50 — The sentence-case rule lives in §5, and the accent has exactly one exception

Two amendments to §5, both recording rules that were already being enforced from
somewhere they were not written down.

**Sentence case (A).** The rule came from the Phase 2 i18n brief, not from §5, so the
two tests that enforce it pointed at a section that did not contain it. It was also
broken once by exactly that gap: the design pass reintroduced all-caps stat labels, and
the reviewer's objection had to cite a brief rather than the constitution. It is now in
§5 with both halves named, because the strings and the CSS transform are separately
capable of shouting and neither test can see the other's half.

**The accent (B).** §5 reserved lingonberry for "the trend line and nothing else", which
is the right instinct and slightly too absolute: a wordmark is identity rather than data.
The amended rule is *the line and the wordmark, nothing else*.

The reason to write the exception down rather than let it be obvious: an unstated
exception is how a reserved colour erodes. The first button that "is basically a logo
treatment" is arguable, the fifth is a theme. Stating that the logo is the single
exception makes the sixth reach for it an edit to this file rather than a judgement call
in a component.

The exception is safe because a wordmark never appears inside a chart, so it cannot be
mistaken for data. Anything that *can* be mistaken for data still may not use it.

---

### D51 — The Framsteg header is a steady state, not a repeated celebration

A permanent motivating element at the top of the progress screen is wanted. D38 stands:
the celebration fires **once** per milestone and is acknowledged, and nothing about this
header changes that.

So the header is a *state*, not an *event*. It renders what is true right now: achieved
milestones as a row of markers, the logging streak, the pot against the nearest reward.
It has no animation on load, no confetti, no entrance transition, and no dependency on
whether anything changed since the last visit.

Why the distinction is worth a decision rather than a code comment:

- **A celebration that repeats stops being one.** The single deliberate moment D38 buys
  is spent the second time it fires, and everything after that is furniture. If the
  header animated on arrival, the eighth visit would teach the user that the animation
  means nothing, and by then the real celebration would mean nothing either.
- **Motion on load is a cost with no recipient.** The person opening this screen at
  seven in the morning already knows what they achieved. Movement is for things that
  have just changed, and nothing has just changed on a page load.
- **§3 has no failure state, and the mirror holds too.** A header that only lights up on
  a good week is a header that is visibly dark on a bad one. A steady state shows the
  same markers either way, which is the point: the achieved milestones are still
  achieved.

Reduced motion is respected everywhere already, but "respect the setting" is the wrong
frame here. This element has no animation for anyone.

Rejected: a "new since last visit" highlight. That is `celebrated_at` in a second
costume, and it would need its own per-device state to be honest about "last visit".

---

### D52 — Macro targets are derived from NNR 2023, and three of its properties are not optional

**Source.** The Nordic Nutrition Recommendations 2023, as published by Livsmedelsverket
for Sweden. Chosen over the alternatives for one reason: it is the reference the Swedish
authority actually publishes, so the numbers the app shows are the numbers the user would
find if they looked them up. A macro split invented by a fitness app is a house style
presented as nutrition science.

**The planning targets**, taken from inside the recommended bands rather than at their
edges: fat **32-33 E%**, carbohydrate **52-53 E%** including fibre, protein **15 E%**. The
bands are wider (fat 25-40, carbohydrate 45-60); a planning target has to be a single
number and the middle of a band is the defensible choice. Fibre is the one absolute
figure in the set: **at least 3 g per MJ**, which scales with intake instead of being a
flat 25-35 g that is severe on a small target and slack on a large one.

**The energy factors are NNR's own** — protein and carbohydrate 17 kJ/g, fat 37 kJ/g,
fibre 8 kJ/g, 1 kcal = 4.184 kJ — not the 4/4/9 shorthand. The shorthand is those same
values rounded for mental arithmetic; 4 kcal/g is 16.7 kJ/g and 9 is 37.7, which is close
enough to look right and far enough to move a protein target by grams. `food.ts` already
treats kJ against kcal as load-bearing rather than cosmetic, so the conversion is imported
from there and 4.184 has one definition.

Three properties of the source constrain the implementation more than the arithmetic
does. Each is a place where the obvious version would say something NNR does not.

**1. Protein is not a flat percentage in a deficit.** NNR notes the protein proportion
should be raised when energy intake falls below 8 MJ/day, about 1900 kcal. Taking a flat
15 E% of a weight-loss target does the opposite: it yields *fewer grams exactly when the
requirement is least negotiable*, because protein need scales with body mass and not with
how much someone happens to be eating this month. So both figures are computed — 15 E%,
and NNR's recommended intake of **0.83 g per kg of body weight** — and the **higher**
wins. At 1600 kcal and 92 kg that is 75 g rather than 59. The weight used is the §4.1
trend, not the morning's reading, so the target does not move with water weight.
`macros.test.ts` pins both directions: a target under 8 MJ where g/kg wins, and one above
where the percentage does.

**2. The values refer to average intake over at least a week.** They are not daily
allowances, because diet composition varies meal to meal. So the target comparison runs
against a **rolling seven-day average**. A single day shows amounts without a verdict: a
daily bar that goes red on a normal Tuesday would assert something the source does not
say, and would do it in the app's most-visited card.

**3. The values are for groups, not individuals.** NNR states directly that reference
values cannot be applied to an individual without estimating that person's energy need.
The UI says so in one sentence, at the register of the correlation page's footer. This is
not a disclaimer for our benefit; it is the difference between showing a reference and
issuing a prescription, and §3's honesty rule does not have an exception for numbers that
came from a good source.

**Derived, never stored.** The targets are a function of the plan's daily target and the
trend weight, so they move when the plan does. A stored copy would be a second definition
to keep in step, which is the failure D44 and D47 exist to prevent. The user may override
any of them in the profile; the derived value is the default and is always one tap away
again, so an override is a deliberate departure from the reference rather than a silent
replacement of it.

---

### D53 — The bottom bar's centre button is removed, not expanded

The dashboard gets three quick actions — log weight, scan a barcode, log food —
as round icon buttons with the label underneath. The bar's raised centre button
is **gone** rather than turned into something that expands into them.

**What was wrong with the button.** It was one affordance that meant "log" and
did exactly one thing: open the weight sheet. Someone who tapped it wanting to
log a meal got the wrong sheet, and nothing about a plus sign could have told
them in advance. The ambiguity was the defect, not the position.

**Why not expand it.** An expanding FAB fixes the ambiguity by adding a second
navigation layer on top of the one already at the bottom of the screen: a tap to
open, an overlay to dismiss, and labels that exist only while it is open. Two
taps to reach anything, and the thing you are choosing between is invisible
until you commit to choosing. The bar also loses either way — the notch cut out
of its middle is there for a control that is not a destination, and four
destinations around a hole is a worse bar than four destinations.

**What the quick actions get instead.** One tap each, always labelled, always
visible, and three different silhouettes rather than one plus sign. The scan
action gets a real scanner icon: a barcode inside a frame, which is what the
camera is about to do. It links to `/food?skanna` rather than opening a second
camera on the dashboard, for the same reason the old button linked to
`/?logga` — a link works from a cold start and from the offline shell, and
`getUserMedia` should have exactly one place it can fail.

**What it costs.** The fast path lives on the dashboard rather than on every
screen. The bar reaches the dashboard in one tap from anywhere and the food
screen has its own scan and search controls, so the loss is one tap on the
rarer case. The dashboard's own full-width "Logga vikt" bar went with it: it did
what the first quick action does, one screenful above, and sat directly over the
bottom bar on a phone.

---

### D54 — A savings rule change is previewed against the pot before it is saved

Savings rules were the last log type that could be neither edited nor deleted.
Weight, food and the daily log all got both in the six-fix pass; a rule was
still write-once, so a typo in the amount was permanent and a rule someone had
stopped following kept filling the pot forever. Both are added.

What makes this different from the other three, and why it is not just a delete
button: **the pot accrues on read** (§4.5). No per-day rows are written, so the
rule *is* the record and every change to it is retroactive by construction.
Moving a start date back three months does not adjust anything going forward, it
makes three months of savings appear. Deleting a rule does not stop it, it
removes everything it ever added, along with the offsets filed against it.

That is correct behaviour — it is what makes the pot impossible to drift out of
step with the rules — and it is genuinely surprising. So the consequence is
shown as a figure and confirmed:

`POST /api/savings/rules/:id/preview` takes the proposed fields, or `null` to
preview a deletion, and returns both balances, the delta, this rule's own
accrual and its eligible-day count before and after. It is computed by
`potBalance` — the same function `getPot` calls, on the same rows, with one rule
swapped or removed in memory. Nothing is written. A preview that used its own
arithmetic could promise something the save did not deliver, which is worse than
having no preview at all; `savings-rules.test.ts` asserts the predicted balance
against the real one after the edit.

Three details worth stating:

- **Both balances, not only the delta.** "−400 kr" reads very differently
  against a pot of 500 than against one of 12 000, and the balance is the number
  people came to this screen for.
- **Days as well as kronor.** A cadence change is easiest to understand as
  "fourteen days counted, now four do"; the money follows from that rather than
  the other way round.
- **The reward that stops being affordable.** The pot exists to make a reward
  reachable, so a rule edit that quietly puts one back out of reach is exactly
  the thing someone finds out about weeks later.

The API does not enforce that the preview was seen. That is the UI's job: an
endpoint that demanded a token from a preview call would break the offline queue
for a deletion that is perfectly well specified without one.

Not styled as a warning. Editing a rule is legitimate and is usually a
correction; §3 has no failure state, and colouring this red would make fixing a
typo feel like breaking something.

---

### D55 — A macro total below 90% coverage is reported as partial, not as a total

The threshold promised in D52, decided and written down.

**The hazard.** Crowdsourced food data frequently lacks individual macros. A day
of six entries where two carry no protein figure still produces a protein total,
and that total is silently low. This is absent-is-not-zero (D44) in its quietest
form: unlike a missing day, the result still looks like an answer, and it is an
answer that will be compared against a target and found wanting.

**Coverage is per macro, and weighted by energy.** Per macro because a food can
carry protein and not fibre, and one number for the day would hide which. By
energy rather than by entry count because a day of five labelled snacks and one
unlabelled dinner is mostly unknown — counting entries would call it 83%
covered when four fifths of the calories are unaccounted for.

**The threshold is 0.9.** Above it a total is stated; at or below it the figure
is shown as *at least* that much and the row says what fraction of the day
carries data, and the day is excluded from the seven-day mean the target is
actually compared against.

Why 0.9 rather than something looser: the number this guards is compared against
a reference value, and a total missing a fifth of the day's food would sit
visibly under that reference while being *wrong* rather than *low*. Someone
acting on it would eat more protein than they need to, which is harmless, or
conclude the app is unreliable, which is not. Why not stricter: one unlabelled
coffee should not invalidate a day, and a threshold nobody clears is a threshold
that trains people to ignore the marking.

The gate lives in `calc/macros.ts` as `MACRO_COVERAGE_THRESHOLD`, next to the
function that applies it, so the bar the browser draws and the figure the server
sends cannot disagree about what "complete" means.

---

### D56 — Edit and delete ship with the create, and the audit that came with the rule

Written into CLAUDE.md §3, because a rule that has been broken four times is not
being remembered by anyone reading DECISIONS.md alone: **every user-created row
ships with edit and delete in the phase that creates it.**

Four occurrences, each found by using the app rather than by a test, which is
the tell that it is a habit and not an oversight: weight, food and daily logs in
phases 1 to 3; savings rules in phase 5 (D54); milestones, where the API got
both endpoints in phase 5 and the UI got neither controls, so an endpoint
existed that nothing called; and `manual_intake`, found by this audit.

Two forms of "edit" count, and which applies is a property of the entity. **One
row per day** — weight, the daily log, measurements, manual intake — is edited
by re-logging the day, because the day holds one canonical value and the write
is an upsert that clears the day's other rows. **Many rows per day** — food
entries, activity sessions, savings events — needs a real update path, because
re-logging makes a second row. Delete has no second form; every row needs one.

Where a delete would destroy derived history the answer is a decision with a
reason, not an omission. A plan is archived rather than deleted because
`tdee_at_write` is what a later plan review compares against (D25). A savings
rule is deleted, and the retroactive effect on the pot is previewed first (D54).

**The audit, run against the current schema.** Nothing else lacks *both*:

- `food_items` created through `POST /api/food/manual` has neither, and is the
  one remaining entity that lacks both. Deliberately left: a food item is
  referenced by every `food_entry` that ever used it, and the entries snapshot
  their macros at log time precisely so history does not move (§7). Deleting one
  is therefore safe for history and unsafe for the *list*, and editing one has a
  visibility question attached (`food_visibility`, D16/D17) that is not a
  five-minute decision. It is named here rather than fixed quietly.
- `measurement_log` and `manual_intake` are edited by re-logging the day.
  `manual_intake` had no delete and now has one, below. `measurement_log` still
  has none.
- `activity_log`, `food_entries` and `savings_events` have delete and no update
  path. All three are many-per-day, so re-logging does not stand in for an edit:
  correcting 250 g to 150 g means deleting a row and typing it again.
- `plans` has edit and archives rather than deletes, which is D25's design.
- `photos`, `llm_jobs`, `weekly_reviews`, `groups` and `group_members` are not
  built yet. The rule now applies to them before they are.

**`manual_intake` got its delete in this pass**, because the gap there was not
cosmetic. A manual row **owns its day** (D44): while it exists, the meals logged
afterwards are not what the app counts as eaten. Someone who typed a rough total
at breakfast and then logged real food all day had no way to hand the day back
to the food log, because overwriting the number with another guess is not a
delete. `DELETE /api/manual-intake/:id` exists, and the control sits in the
quick sheet where the figure is shown.

That delete is **not queued offline**, unlike the creates. The queue replays,
and a create is idempotent on `client_uuid` while a delete is not: replaying one
against a row that has since been re-entered would remove the new figure too.
It needs the network and says so (D42).

---

### D57 — A milestone target carries its unit, and a band to be typed inside

The target field took a bare number. The metric was already chosen in the select
directly beside it, so the unit was derivable the whole time and the user was
carrying it instead: **95 is a plausible waist in centimetres, a plausible weight
in kilos, and a nonsense waist-to-height ratio**, and the form accepted all
three without saying which it wanted.

So `METRIC_UNIT` in `calc/milestone.ts` gives every metric a suffix, a plausible
band and the number of decimals it is meaningful to. The suffix renders inside
the field, beside the digits as they are typed rather than in the label.

Three things worth stating:

- **Waist-to-height gets no suffix at all.** That is a fact about the ratio, not
  a missing string: "kg" beside 0,48 would be worse than nothing.
- **The bands are wide.** 30 to 400 kg, 0,2 to 1,5 for the ratio. This is the
  slipped-decimal-point check, not a judgement about what anyone should weigh,
  and a band that refuses a legitimate goal would be worse than no band.
  `waist_cm` and `chest_cm` reuse `MEASUREMENT_RANGE_CM`, so a milestone cannot
  be set to a figure the measurement form would itself refuse — a target
  unreachable by construction.
- **The check runs on the server too** (§3 puts guardrails server-side), and the
  message names the range rather than saying "invalid", because naming it is the
  difference between fixing a typo and guessing at one.

The edit path validates against the metric the row **ends up with**, not the one
in the payload. Changing only the metric leaves the stored target in place, and
95 kg would have been saved as a waist-to-height ratio of 95.

Rejected: inferring the unit from the magnitude of what was typed. That is the
same guess the user was being asked to make, moved somewhere it cannot be seen.

---

### D58 — The chart is not focusable, and the line leads the dashboard

Two changes to the trend chart, from using it rather than reading it.

**Clicking the plot drew a white ring around the whole chart.** Recharts 3 turns
on its `accessibilityLayer` by default, which puts `tabIndex={0}` and
`role="application"` on the SVG; a `role="application"` element matches
`:focus-visible` on *pointer* focus in Chrome, so any click lit up the container.
The fix is `accessibilityLayer={false}` — removing what made it focusable —
rather than suppressing the focus style, because §5 requires visible focus on
things that are genuinely interactive and the range buttons and the waist toggle
sit inches away. A ring around a container nobody can operate teaches people to
ignore the ring that means something.

What that costs is Recharts' arrow-key traversal of the data points. Taken
deliberately, and the chart now says what it is instead: `role="img"` with a
one-sentence label giving the span and the direction, which is a better answer
for a screen reader than an application region with no documented keys. Applied
to all three charts.

**The line leads the page.** §5 calls it the signature element, and the hero
position is the top of the screen rather than the second screenful; a figure
with the chart beneath it made the number the subject and the line its footnote.
Order is now chart, trend weight, quick actions: how is it going, what is it
now, what do I do about it.

That order has a constraint attached, and it is the reason the chart is 12rem on
a phone rather than 14. The three quick actions are the everyday path and must
be reachable **without scrolling at 360 px**. On a 360x667 screen — the shortest
this has to work on — they sat 44 px below the bottom bar. The chart gives up
32 px and the legend shares a row with the waist toggle for another 28; they now
clear the bar by 14 px on that screen. A hero that pushes the everyday actions
off the screen has stopped being the top of a page and become the whole of it.

---

### D59 — The macro card has two views, and only one of them is a verdict

Both views draw the same bars against the same targets. What differs is what the
comparison **claims**, and that is stated rather than implied.

**Weekly is the verdict.** NNR's values are averages over at least a week (D52),
so this is the only view entitled to say a target is met or missed, and it is
the default whenever there are enough days past the coverage gate to build one.

**Today is an indication.** The argument for having it at all: someone who eats
much the same food most days can read a single day usefully, and daily feedback
is what a person can act on this evening rather than next Sunday. The argument
against showing it as a verdict is D52's second constraint, unchanged. So the
day gets the same bars and a line saying, in words, that the recommendation is a
weekly average and a single day says nothing on its own. No red, no warning
state, no "missat": §3 has no failure state, and one day is not evidence of one
in either direction.

Coverage (D55) applies to both. On the daily view a total below the gate reads
"minst 107 av 78 g", because it is a floor rather than a figure. The weekly mean
is built only from days that cleared the gate, so it never needs the hedge.

The toggle is two labelled segments rather than a switch: neither view is "off",
and a switch would have to pick one of them to be the absence of the other. The
weekly segment is **disabled rather than hidden** before there is a week, since
a control that appears on the fourth day is a control nobody knows exists.

---

### D60 — The milestone card leads with distance, and money moves below it

Two things were wrong with the steady header, and they turned out to be the
same thing.

**The bug.** It showed exactly one milestone: `[0]` of the rewards the pot did
not yet cover. Two milestones on different metrics, both open, and only one
appeared — the same symptom as the Framsteg list defect diagnosed last pass and
ruled out there, in different code. Ruling it out of the list was right; the
card was never checked because the card was not what was reported.

**The framing.** That `[0]` was picking a *reward*, which is why picking one at
all seemed reasonable: there is only one nearest reward. But the question this
card answers is "how am I doing", and the answer to that is distance, not
money. Every unreached milestone is listed now, nearest first, each with how far
it is in its own unit (D57) and the date `project.ts` puts it at — the same
regression on the same smoothed series the dashboard's goal date uses (§4.3).

Ones with no distance to measure sort last rather than being dropped. A
milestone on a metric with no series behind it says so; omitting it would be the
original bug with better manners.

**The pot is a footnote of the card it used to headline.** It is what pays for a
reward, not what earns one. And nothing about it may gate or discourage claiming
one: the balance is allowed to go negative and says so plainly, `claimReward`
checks only that the milestone is achieved and unclaimed, and the claim control
lives with the milestone rather than with the balance. Someone who has reached
99 kg has reached it whether or not the jar has the money in it yet.

Dates render identically whether they moved closer or further away. §3 has no
failure state, and a slipping date is information about a rate.

---

### D61 — `local_date` says where it came from

The column has always held two different facts, and nothing could tell them
apart:

- **`device`** is §3's rule. The client's own day boundary at the moment of
  writing, which is why an entry made at 23:50 in Stockholm and synced at 08:00
  in Tokyo keeps the Stockholm day (D39).
- **`chosen`** is a person filling in last Tuesday. That is not a statement
  about any clock, and it became possible the moment the date selector shipped.

The offline queue has never rewritten either at send time, and the tests for
that predate this decision. What was missing was the ability to *say which*, and
it was missing in three places at once: the queue inspector could not tell a
three-week-old backfill from a device with a wrong clock; a D41 conflict could
not explain that one of two devices had deliberately picked a day; and the
property "a backfill is not rewritten to the sync date" could only be asserted
by testing the absence of a bug.

So `dateSource` travels on the queued row and in the payload. Three details:

- **A supplied date equal to today is still `device`.** The screens pass their
  selected date on every write and on most days that date is today; calling
  those "chosen" would make the distinction useless by making nearly everything
  chosen. What marks a backfill is that the date differs from the boundary the
  device would have computed — judged in the creating timezone, not UTC.
- **The server stores neither, and still derives no day.** It checks that the
  pair is possible, which is the one thing it is better placed to see: a
  `device` date more than one calendar day from the server's own is a broken
  clock, since no timezone is further than that from UTC; a `chosen` date may be
  any past day and is refused in the future, because there is nothing to record
  about a day that has not happened.
- **Absent means unchecked.** The field arrived long after the endpoints, and
  refusing writes that omit it would break the contract in order to enforce a
  property only the newer client can state.

The queue's Dexie schema goes to v2 to stamp existing rows `device`. That is the
correct historical answer rather than a guess: until the selector existed there
was no way for a person to choose a date.

One bug fell out of building this. `useSaveFoodEntry` hard-coded
`"Europe/Stockholm"` as the timezone it passed to the queue. Harmless while the
day always came from the device; not harmless once `dateSource` is derived from
it, because near midnight in another zone a write meant as today would have been
stamped a deliberate backfill. It takes the profile's timezone now.

---

### D62 — The chosen day is shared between Dagen and Mat, for the session only

Dagen and Mat were hard-wired to today, which made a mistake permanent and a
forgotten day unfillable. Both tables have carried `local_date` since phase 1
and every write has been an upsert since then, so this was a UI gap the whole
time.

The selection is **shared between the two screens, held in memory, and lost on
reload.** Each property is doing a job:

**Shared**, because filling in a past day is one task that spans both screens:
you rate Tuesday's sleep, then log Tuesday's dinner. Resetting on every
navigation is the reported complaint, and two screens disagreeing about "the
day" would be a quiet way to file half a backfill under the wrong date.

**Not persisted**, because the alternative is worse in the case that matters. A
date written to storage survives closing the app, so someone who backfilled last
Tuesday at midnight would open the app the next morning, log breakfast, and file
it under Tuesday. Losing a selection on reload costs two taps. Keeping one costs
a misfiled day nobody notices.

**Self-correcting at midnight**, because a session can outlive a day. The clock
is re-read on a one-minute tick; if the selection *was* today it follows, and if
it is a deliberate past date it stays where it was put. A minute is enough:
being sixty seconds late is invisible, and a timer set to the exact boundary
gets it wrong on a device that sleeps through midnight anyway.

Two safeguards, because a shared non-today date is exactly the kind of state
that causes a mistake it does not announce. The strip changes appearance when
the day is not today and carries a one-tap way back; and both screens print a
sentence naming the date they are writing to. The food screen's total says which
day it is counting, rather than "i dag" whichever date is showing — which on a
backfill was the app stating something false about the number beside it.

Forward is **disabled on today** rather than hidden. A control that vanishes at
the edge of its range reads as a rendering bug; there is simply nothing to log
about tomorrow, and the picker's `max` says the same thing to the browser.

---

### D63 — The data section is a viewer, and D34's rules apply to all of it

A place to dig rather than a summary: every logged series — the four 1-5
ratings, sleep, steps, alcohol, activity minutes, waist and intake — over a
selectable range, dense and desktop-first.

**D34 governs it entirely.** No correlation coefficients, no fitted lines, no
causal language. That decision was made for the correlation screen and the
reasoning is stronger here, not weaker: ten series on one page is exactly where
the temptation to rank them by "strength" appears, and a viewer that starts
ranking is an analysis whether or not it prints an r.

Three properties follow from it:

- **Self-reported scales are points.** Never joined, never smoothed, on a fixed
  1-5 axis rather than a fitted one. A person picking one of five words is not a
  continuous measurement; joining the dots draws values nobody gave on days
  nobody answered, and fitting the axis makes a week of 3s and 4s look like a
  swing.
- **Every panel states its coverage**, as "50 av 90 dagar". A series with four
  points across ninety days is a legitimate thing to look at and a dishonest
  thing to present as continuous, and the difference between those is one line
  of text.
- **Days with nothing logged are gaps**, not zero-height bars. The window is
  built from the calendar rather than from the rows, so every panel shares an x
  axis and a missing Tuesday is missing in all of them at the same place.

**Intake comes from the server.** A new `GET /api/intake-series` resolves it
through the one function that owns the question (D44): the manual row if there
is one, otherwise that day's food entries, otherwise absent. Summing food
entries in the browser would have been the D44 bug rebuilt from scratch in a new
screen, and it would have been wrong in the same direction — a day logged the
other way reading as a day nobody logged.

Reachable from the sidebar and marked `wideOnly`, like the correlation view: it
renders stacked at 360 px and is reachable there by URL, but a five-item bottom
bar costs every destination a fifth of its width for a screen nobody opens on a
phone.

---

### D64 — Every route has a smoke render test

`apps/web` had no rendering tests at all, and this project shipped a blank
dashboard because of it: a `const` read inside a callback before its declaration
typechecks cleanly — TypeScript cannot prove when the callback runs — and threw
at render. The full suite passed. A screenshot caught it.

So every route now gets one test that mounts it and asserts it renders its
heading. Deliberately that weak:

- **not visual regression.** Pixel comparison is a different tool with a
  different maintenance cost, and it fails on a font hint;
- **not behaviour.** The guards already check copy, class names, number
  formatting and the tick maths from source, and the API tests cover the
  contracts. This closes the gap between them, which is the render itself;
- **wide rather than deep.** Ten routes, one assertion each, fast enough to run
  on every commit. Blankness is the failure mode that gets shipped, because it
  is the one nothing else notices.

Three things the harness makes explicit, each of which was a wrong first answer:

- **The heading is awaited, not asserted immediately.** A route whose identity
  query has not settled legitimately renders nothing for a tick. "Blank forever"
  is the bug; "blank on the first frame" is a cold load.
- **The auth screens are rendered signed out.** Signed in they redirect, and
  asserting that a redirect is a blank page would be asserting the wrong thing.
- **The stub returns a real insights payload, not `{}`.** `{}` is truthy, so the
  dashboard rendered its panel against a payload with no `maintenance` on it and
  threw. That is the harness feeding garbage rather than a defect — both ends of
  that endpoint are schema-validated — and a smoke test the app has to be
  defended against is not testing the render path.

The date selector and the data viewer get a few assertions beyond the heading,
because they hold real client state and a broken reducer still renders a
heading.

---

### D65 — A food entry can be corrected, and the correction is recomputed from the item

Food entries had a delete and no update path. §3 says every user-created row
ships with both, and a food entry is many-per-day, so re-logging is not an edit
(D56): it makes a second row. Fixing 250 g typed for 150 meant deleting the row
and entering it again, which loses the time it was logged at.

`PATCH /api/food-entry/:id` takes the amount and, optionally, the meal it
belongs to. Three things it deliberately does not take:

- **the food.** Changing which food a row is makes it a different entry rather
  than a corrected one;
- **the day.** Moving a row between days is a delete and a re-log, with both
  days' totals recomputed, and doing it as an edit would hide that;
- **the numbers.** They are derived, not typed.

**The macros are recomputed from the food item**, not scaled from the stored
snapshot. That looks like it contradicts the rule that entries denormalise their
macros at log time so a later upstream correction cannot move history, and it
does not: the rule protects entries *nobody touched*. An edit is a new statement
about this entry, made now, so it reads the item as it is now. Nothing
recomputes silently.

A freetext entry has no item to read, so its own figures scale by the ratio of
the amounts. That is the only honest answer available — the numbers were the
user's estimate for a portion, and half the portion is half the estimate — and
an absent macro stays absent rather than becoming zero. A zero-gram original has
no ratio, so the figures are left alone: visibly odd, and therefore fixable,
which a silently wrong number is not.

**Saved meals got the same treatment**, and one thing fell out of testing it.
`DELETE /api/meal-templates/:id` returned 204 for a template belonging to
somebody else. The query had always been scoped by `user_id`, so nothing leaked
and nothing was deleted — but reporting success for a no-op tells a client a row
is gone when it is not, and every other delete in the codebase answers 404
there. The odd one out was the one hiding a bug.

---

### D66 — The day's list has columns, and a saved meal is a chosen subset

Two changes to the list of what was logged today.

**It has a fixed column structure.** Each row was a flex container sizing every
cell to its own content, so the amounts and the controls sat at a different
horizontal position on every line depending on how long the food's name happened
to be. A grid with the same tracks on every row is what makes a column a column;
the name track takes the slack and truncates, rather than pushing everything
else around.

**Saving a meal takes a selection, not the day.** It used to take every row,
which is wrong for the case the feature exists for: breakfast is three of the
day's nine rows, and a "meal" containing dinner is not one anybody will apply
again. Every row starts selected, because the whole day is still the common case
on the day you first think to save one, and the checkboxes only appear while a
meal is being assembled — a permanent column of checkboxes on a list you mostly
read would be a control looking for a use.

**Saved meals moved behind a disclosure**, like the recent list before them.
That costs the fastest path in the app a tap and the cost is measured rather
than assumed. What it buys is a screen that opens on the two things people come
to do — find something, or log something they have logged before — instead of on
two stacked ledgers.

---

### D67 — `/data` has a portrait view, and two entry points that are not the bottom bar

The data screen was `wideOnly`, which on a phone meant it existed only in
landscape: a screen you can reach by rotating the device is a screen nobody
reaches.

**Portrait shows one series at a time, behind a picker.** Not the same page with
a scrollbar: ten dense panels stacked is around 2 800 px of thumb travel, which
is a way of having the screen without anyone using it. One at a time is what
this screen is for anyway — you come here to look at *sleep*, not at ten things
— so the selector makes that the first decision rather than a scroll. The wide
layout is unchanged.

The switch is `matchMedia` at Tailwind's `lg`, so the JS and the CSS agree about
what "wide" means instead of having two thresholds that drift. One render path,
not two hidden subtrees: rendering both would mount twenty charts to show ten.

**It stays out of the bottom bar.** Four destinations is the bar's shape, and a
fifth costs every one of them a fifth of its width for a screen that is opened
occasionally. So two entry points instead:

- **the dashboard's reference-figures card**, at its foot. That card is BMI,
  height, readings, weight — someone reading those is one step from wanting the
  series behind them;
- **Dagen's header.** That is where the ratings are entered, and "what does my
  sleep column actually look like" is the question you have while filling one
  in.

The sidebar keeps it on desktop, where there is room.

---

### D68 — The queue tells the cache when the **server** has the write

A logged food did not appear until a manual refresh, and then the list was
always exactly one entry behind.

That signature is a query read before the mutation invalidated it, and the cause
is a property the queue has on purpose. `enqueueAndSync` resolves as soon as the
entry is stored **locally** (D39-D42): a meal logged in a shop basement is
logged, and the screen must not wait on a network that may not be there. The
mutation's `onSuccess` then invalidated the cache at that moment, so the refetch
raced the POST and normally won. The list came back without the entry that had
just been added, and `staleTime` kept that answer for thirty seconds — which is
why a reload fixed it and waiting did not.

This was not cosmetic. The day's calorie total is a sum over that list, and it
is the number the adaptive maintenance figure, the daily target and both
projections are built from. It was wrong on screen while the user was looking at
it, in the one place the whole app rests.

So `drainQueue` notifies listeners after a send actually succeeds, naming the
kinds it sent, and `useQueueSync` invalidates the lists that kind makes stale.
Three details:

- **once per drain, not once per entry.** Four queued entries cause one refetch
  per affected list;
- **not on failure.** Nothing changed on the server, so there is nothing to
  re-read;
- **keyed by kind.** Sending a weight does not refetch the food log. Every
  mutation kind is listed, including the four the queue can carry but nothing
  enqueues yet, so routing one through the queue later makes the compiler ask
  what it invalidates rather than letting it go quiet.

The enqueue-time invalidation stays. It is the right thing for local feedback,
and it is now the first of two rather than the only one.

**Every other list was checked for the same shape.** The daily log,
measurements, activity, savings and milestones all call the API directly and
await the response, so their own `onSuccess` fires after the server has it and
they were never affected. The three queued kinds — weight, manual intake, food
entries — were, and weight was additionally missing `DAY_KEY`: `GET /api/day`
carries the day's reading, so the daily screen showed yesterday's until it was
reopened.

Writing the regression test taught something worth recording, because three
versions of it passed against the broken code. `gcTime: 0` collects a query
before its observer reads it, so nothing ever renders; `staleTime: 0` makes
React Query refetch often enough to recover on its own; and a stub that returns
a live array reference answers a request made *before* a write with the state
*after* it. A test harness that is more forgiving than production does not test
production.

---

### D69 — `/diagnostik` answers the on-device questions in one visit

Four checks have been open since Phase 3 because they cannot be answered from a
development machine: whether `BarcodeDetector` runs or the ZXing fallback does,
whether the service worker and the offline queue behave in the **installed** app
rather than in a tab, how the OS draws a select, a date field and a checkbox,
and whether a native date input formats to the OS locale rather than to `sv-SE`.

A real certificate now makes the app reachable on a phone, so the page is built
to close all four in one visit and write the answers down without anybody
remembering them:

- everything answerable without a tap is answered on load;
- everything else is a button that writes its result beside itself;
- the foot of the page is a block of plain text meant to be copied straight into
  STATE.md, so what gets recorded is what the phone said.

The date format is read out of the input's **shadow DOM text**, not its value:
the value is always ISO, and what was in question is the displayed order.

**The "Igen" investigation is a diagnostic, not a fix.** Three causes were named
and they leave different traces, so the probe records all three rather than
testing one and guessing. Press it in the installed app, then read in this
order:

1. **no `click` line** after `pointerdown` or `touchstart`: the tap never became
   a click. A gesture or overlay problem, not a data one;
2. **`click` but no `fetch` line**: the request did not leave. Look at the
   service worker line — a `NetworkOnly` route being answered from a cache, or a
   controller from an old deploy, both show up there;
3. **`click` and a `fetch` with a status**: the request reached the server, and
   the fault is the cache not refreshing afterwards, which is D68.

The display mode is recorded on load, because "works in a tab, not in the
installed app" is the whole shape of the report.

If nginx misbehaves while this is being done, the two things to check are
`proxy_ssl_verify` against Vite's mkcert certificate — it is not a public CA, so
verification has to be off or pointed at the local root — and that `Upgrade` and
`Connection` are forwarded, without which the dev server's HMR socket fails and
the app appears to load and then not update.

---

### D70 — A schema bump is for indexes, and an open that can block needs a bound

Adding food hung on "Sparar…" and never finished. Three faults, one of them the
cause and two of them the reason it was as bad as it was.

**The cause.** `dateSource` (D61) was added with a Dexie `version(2)` whose only
job was to stamp existing rows: the field is not indexed, so the schema did not
change at all. An IndexedDB version change cannot proceed while any other
connection holds the database at the old version, and a phone routinely has
two — the installed app beside a browser tab. The open fired `blocked` and then
simply waited.

So the version bump is gone. The default lives at the point of reading instead
(`dateSourceOf`), where a missing value means `device`: until the date selector
shipped, nothing in the UI could choose a date, so that is the historical answer
rather than a guess. Verified against both populations: a device that never
upgraded opens with no version change at all, and one that already reached v2
keeps its rows and its higher version, because Dexie opens what is there rather
than insisting on what it declared.

**Why it hung rather than failed.** `queueAvailable()` awaited `db.open()` with
no bound. A blocked open never settles, so `enqueue` never returned, the
mutation never resolved, and the button sat there forever. It is bounded now,
and a database that will not open in three seconds is treated exactly like one
the browser refused. A promise that can legitimately never settle must not be
the only thing between a tap and a result.

**What made that worse than a hang.** The branch that handles "no usable queue"
returned without writing anywhere and without making a request, under a comment
saying the write went straight out. Nothing did. Every entry made without a
queue was **silently discarded** — the worst failure mode this app has — and it
stayed invisible because the branch was almost never taken. Making a blocked
database fall through to it would have turned a hang into silent data loss.

It now sends the write, and throws on refusal rather than reporting success:
there is no queue to park the entry in and no later attempt to make, so the only
honest thing is to let the screen say it did not save (D42). Its own test file,
without the `fake-indexeddb` polyfill, because the absence of a database is the
condition being tested.

The lesson worth keeping is narrower than "be careful with migrations": **the
cost of a schema version is paid by every device that already has data**, and it
is paid at the least convenient moment. A migration that exists only to fill in
a default is a migration that did not need to exist.

---

### D71 — Ollama's native endpoint, not the OpenAI-compatible one, and the model never says a calorie

Two decisions in the first slice of §6 phase 8. The second is the important one.

**The transport.** §6 says "Ollama's OpenAI-compatible endpoint" and also warns
that `/v1/` ignores options sent in the request body. Both models on this host
reason by default, `/v1/` ignores `think` along with everything else, and the
cost is not marginal:

| | `/v1/chat/completions` | `/api/chat`, `think: false` |
|---|---|---|
| parsing one breakfast | **15.0 s**, 1 399 characters of discarded reasoning | **0.56 s** |

Same items, same grams. So the native endpoint, which honours `think`. That is
a departure from the brief's letter in service of its intent: the reason it says
"set `think: false`" is to avoid exactly this waste, and its suggested
workaround — baking the setting into a saved model variant — exists only because
`/v1/` cannot be told per request.

**`num_ctx` is never sent**, which the brief also asks for and which turns out to
matter more than it sounds: changing it between calls makes Ollama evict and
reload the model, an 11.9 s round trip for a prompt that answers in 0.56 s once
the options stop changing. A larger context belongs in a saved model variant,
and the model names are configuration so one can be named without a code change.

**The model names things; the database says what they contain.** This is the
rule the whole phase rests on, and it is enforced rather than requested:

- the item schema is `.strict()`, so an unexpected key is a parse failure;
- `FORBIDDEN_MODEL_KEYS` names the fields a model reaches for when it decides to
  be helpful, and the reply is walked **at every depth** — a `totals` object
  beside `items`, a `nutrition` object inside one, a per-item `kcal`;
- a violation is not an error the user sees. It degrades to the manual path like
  every other unavailability in this layer.

The reason for the belt and braces is what an invented number does *here*
specifically. It does not sit on a screen being wrong: it enters
`food_entries`, and from there the §4.2 adaptive maintenance figure, and from
there the daily target and both projections. One fabricated calorie count
becomes every number in the app, and nothing downstream can tell it from a real
one.

**Nothing is written until a person has read it.** The parse endpoint queries
`food_items` and writes nothing at all. The user sees each match with the
database's own figure, corrects the portions, and confirms; only then does
anything reach the log. Logging first and correcting afterwards would put the
mis-parse inside the intake series before anyone looked at it, and a later
correction does not un-count a day that has already been counted somewhere else.

**Unavailability is an ordinary answer, carried on a 200.** §6 opens the phase by
saying the workstation is not always on, nothing may depend on the layer, and
the degradation carries no error banner. A 503 would make every client treat a
switched-off machine as a fault. So the response is a discriminated union, and
the UI's honouring of "no error banner" is total: when the host does not answer,
the control is not rendered at all and the screen is exactly the screen it was
before the phase existed.

The coach's personality lives in one file with nothing else describing the
voice, per the brief. Its rules are written as prohibitions rather than
adjectives — never peppy, never guilt, never a target — because §3 says this UI
has no failure state and a coach is the easiest place in the product to build
one by accident: a model asked to comment on someone's week reaches for
encouragement-shaped disappointment unless told not to.

### D72 — A recipe is priced by the database, and a row it cannot recognise stays unpriced

The recipe generator (§6 phase 8) sends the day's remaining room and a list of
what is in the fridge, and gets back a title, some steps and named amounts. It
never gets back a number. The item list is deliberately the parser's shape, so
the recipe goes through **the same match-and-price path** a typed sentence goes
through — one pipeline, one guard, one place a figure could be smuggled in and
one place that refuses it.

Three things came out of building it that are decisions rather than mechanics.

**Prose needs its own guard.** The forbidden-key walk cannot see "Stek äggen,
cirka 300 kcal", and a recipe is mostly free text. So the title and every step
are scanned for a figure next to an energy word, in either order, and a hit
refuses the whole recipe rather than stripping the sentence. A model that
ignored that instruction ignored the portioning one too, and the refusal is
invisible: it degrades to "no suggestion this time" like every other
unavailability in this layer.

**An exhausted budget is a different request, not an impossible one.** The
remaining figure is clamped at zero, so zero means the day's target is behind
us. The first live run passed that through as "högst 0 kcal" — a constraint no
recipe can satisfy, which the model correctly disregarded, and an instruction
that cannot be followed teaches it to disregard the budget generally. It now
becomes "the day's target is already met, suggest something small", in the
prompt and on the screen. The wording stays flat in both: §3 rules out a failure
state, and someone who has eaten their day and is standing at the fridge is
having an ordinary evening.

**The top search hit is not a match.** `bestMatch` took the first row the food
search returned, and the first live run priced "kycklingfilé" as "Korv
kycklingkorv" and "fetaost" as "Grekisk sallad m. fetaost". The ranking is tuned
for a person reading twenty rows, where a near-miss at the top is harmless
because the reader skips it; reading the top row unattended is a different job
with a much higher bar. So a candidate must now be *recognisably the same food*:
every word asked for present (a longer inflection counts), at most one word of
qualification, and — the rule that does the real work — the match is made
against the part of the name **before** a "med" or "m.", because this database
marks the contains-relation explicitly and that connector is exactly what
separates "Kyckling med curry", which is chicken, from "Fatteh m. kyckling",
which is not. Stripping "med" as a filler word, the obvious thing to do, deletes
the only signal that tells them apart.

Failing it leaves the row unmatched, which is a first-class outcome on both
screens: the ingredient keeps its name, shows no energy, says so, and is
excluded from the total — with the total itself saying how many rows it is
missing. A gap the reader can see beats a confident number for the wrong food,
which would enter the intake series under a name they recognise.

The generator is folded away behind a disclosure and adds nothing to the cold
path: five API requests on a cold Mat load, the same five as before, because the
health query it needs was already being made by the sentence parser and shares
its key. Nothing is requested when the disclosure opens either — only when
someone presses the button, which is where an eight second wait belongs. That
wait shows a running second count rather than a spinner, because half a minute
from cold reads as a hang otherwise.

And generating is not logging. A recipe is a proposal to cook; the save button
is a separate, later act with the portions still editable, because the model
cooked for one and nobody's pan agrees with it exactly.

### D73 — Portions are a display and input layer, and a label is never a claim about mass

Grams stay the only unit in the system. `food_entries` stores grams, every
calculation reads grams, and D44's single definition of a day's intake depends on
there being one. What changes is that grams stop being the only thing a person
is allowed to *say*.

The two complaints were the same defect from opposite ends. "Fem tunna skivor
rökt skinka" failed because the model had to guess a mass it cannot know, and a
recipe rendering "citron 50 g" failed because grams are not an instruction
anyone can follow at a chopping board. In both cases the app was pushing a
judgement onto the one participant that cannot be asked and cannot be corrected.

So a portion has two halves, kept apart deliberately:

- the **label**, "5 skivor" or "1 citron", which is what the user said or what
  the model proposed. It is rendered back verbatim, plural and all, because
  Swedish plural is something a language model gets right and a suffix rule does
  not. It is never authoritative about mass;
- the **grams**, which come from a hint when one exists and from an estimate
  when one does not. Which of the two it was is **stated on screen next to the
  number**, every time. "Uppskattad vikt" is a different claim from "vikt från
  portionen", and the difference is the user's to act on.

Hints come from three places, in this order of authority: the user's own
definition for that food, then the food item's `serving_hints`, then nothing.
The user's wins because a serving figure comes from whoever packaged it and a
defined portion comes from the kitchen scale in the kitchen.

**`serving_hints` was in the schema and unused.** The Open Food Facts adapter was
already reading `serving_quantity`, the grams, and throwing away `serving_size`,
the text beside it, which is where the unit name lives: "1 skiva (35 g)",
"2 kex (25 g)". Stored under the generic key `portion`, the grams have nothing
for a count to multiply. The parse is narrow on purpose, because the data is
crowdsourced and messy, and it divides down to **one** of the unit: reading
"2 kex (25 g)" as 25 g per kex would double every count a user ever stated and
would look like a plausible portion rather than like a bug.

Mass units are refused as portion names, because a hint saying one gram weighs
thirty grams is worse than no hint. **Volume units are kept**, and that is the
subtler half: "2 dl (200 g)" is not circular the way "30 g" is, it is a
*density*, and a density is the only thing standing between an ingredient list
and "1,5 dl mjölk". There is nowhere else in the system to get one.

Livsmedelsverket's nutrient endpoint carries no serving data at all, so its
adapter still writes null. Named here rather than faked.

User-defined portions live in `food_portions`, keyed on the **normalised** unit,
so "skiva" and "Skivor" cannot both exist and resolve differently depending on
which the lookup happened to find. Defining one is an upsert: saying a slice is
42 g twice is one portion corrected, not two portions that disagree. Edit and
delete ship with it (§3, D56), on the sheet where the row is displayed, which is
also the moment the user knows the answer, because they have just weighed the
thing and typed the number into the field above.

---

### D74 — An incomplete total is not a total, and a row nobody priced is not worth zero

Three faults with one cause, fixed together.

**The recipe card read "358 kcal enligt databasen"** with "1 råvara saknas i
summan" in small grey text beneath. Taco sauce at 30 g is roughly 50 kcal, so the
headline was understated and presented as a fact. This is absent-is-not-zero
(D44) in its quietest form and D55's hazard in a new place: a number that looks
like an answer, is wrong rather than merely low, and carries its own correction
in the size the eye skips.

The total now travels as `{kcal, complete, missing}`. An incomplete one renders
as **"minst"**, and what is outside it is **named at the same size as the
figure**, in the app's own voice rather than as a footnote.

**And logging it wrote a silently low row.** The confirm endpoint sent zero for
anything the database could not price. That is the same rule broken at a worse
point: not the app reporting a number it is unsure of, but the app *writing* one
into `food_entries`, from where it reaches the §4.2 maintenance figure and both
projections. An unmatched row now requires a value, and the route refuses without
one, naming the rows that are waiting.

Which of the three options offered: **both the second and the third**, because
they answer different questions. Show the total as incomplete with the unmatched
items named at full weight, *and* require a value before logging. A range was
rejected: the app has no basis for the upper end, so the range would be invented
precision, and D34's prohibition on coefficients applies to the bounds of a guess
as much as to a fitted line.

Zero remains a legal answer. It just has to be **chosen**, which is what "räkna
som noll" does on the row, and what marking a pantry staple negligible does in
advance for a whole class of them.

---

### D75 — Recipes are validated as instructions, not just as JSON, and refused twice before being reported

The guards in `recipe.ts` protect the numbers. This protects the prose, and it
exists because the recipes shipped were not wrong so much as unfinished. Real
output: cod placed in an oven dish with no temperature and no time; a sauce whose
entire method is "blanda smör, dill och citronsaft"; an omelette whose steps stop
before anything is cooked; and "dränka pastan", which is `drain` rendered as
`drown`.

None of those is a schema failure. All of them are caught by asking five
questions of the finished text: an oven step states temperature and time, every
ingredient is used in at least one step, the steps end with the dish finished,
seasoning is stated where it applies, and the Swedish is Swedish.

Each rule is written to be **generous where a false rejection is expensive**.
Temperature and time may appear in the step that turns the oven on rather than
the one that puts the food in, because that is how people write. A salad is not
told it stopped before cooking. Porridge is not asked to season itself. And the
"unused ingredient" check matches on stems in both directions, because Swedish
refers to a compound by its *head*: `olivolja` becomes "oljan" and `tomatsås`
becomes "såsen", so a prefix rule alone would reject good recipes all day.

**Two attempts, then an honest failure.** A first failure regenerates with the
failed rules named rather than the broken text quoted, because handing a model
back its own recipe invites it to patch the sentence that was quoted and leave
the rest. A second failure says the model could not produce a complete recipe.
Showing a half-recipe with a warning was rejected outright: someone starts
cooking it.

Every failure is logged with the rule that caught it and the text that failed.
These rules are a proxy for "a person could cook this", and the only way to know
whether the proxy is any good is to see what it rejects on real cases. A test
holds the logging to that, because a rule that fires silently teaches nobody
anything.

**The Swedish itself.** "Dränka pastan" is the tell of a model composing in
English and translating, so the system prompt now opens by saying it is a Swedish
cook writing in Swedish, and the calque list catches the specific words that are
real Swedish and wrong here. That combination is why nothing else sees them: the
text is fluent and the instruction is nonsense.

What these checks cannot do is judge whether the recipe is any good, or whether a
stated time is honest. A model can write "15 minuter" for a dish that takes
forty. The rules verify that the constraint is **stated**, not that it is true.

---

### D76 — Pantry staples are two kinds, and a saved recipe is not a saved meal

**Staples.** Seeded with a real Swedish list the user prunes rather than an empty
box, because a feature whose value depends on configuration nobody performs has
no value. The seeding is guarded by a timestamp on the profile and not by a row
count, per §3: an emptied list is a legitimate state, and a count-based guard
would re-seed the list the user had just cleared, forever, with no way to stop it.

The split is the whole reason this is a table rather than a string. **Negligible**
staples may be assumed silently. Everything else is assumed *available* but still
appears in the ingredient list with an amount and still produces a food entry,
because three tablespoons of oil is roughly 360 kcal. The prompt says both things
in different words for that reason, and the calorie-bearing sentence is the
emphatic one.

Which side a staple falls on is **derived from the matched food item's energy**,
not asked of the user, at a threshold of 50 kcal per 100 g held in one place.
Asking someone whether flour is calorie-bearing is asking them to do the app's
job, and the cost of a wrong answer lands in their intake series rather than in
their opinion. It is shown on every row and can be overridden, so the
classification is visible rather than hidden, and an override is a deliberate
departure.

**Saved recipes** are their own table, separate from meal templates, because they
answer different questions. A template is "log these rows again in one tap"; a
recipe is "how did I cook that". Saving one generates the template through the
**phase 3 path** rather than a parallel one, and holds a reference to it, so
cooking it again is one tap and reading how is one tap more.

Only priced rows go into the template. A template built from rows the database
could not price would write a zero-energy meal on every future application of it,
which is D74 arriving by a side door.

The three rules §6 sets for storing model-generated prose are kept: the text is
**frozen** when saved, because regenerating the same dish produces different
words and a recipe that rewrote itself would be a record of something that never
happened; it is **editable**, because corrections to timings and method are the
entire value of keeping it, and the first thing anyone learns after cooking is
that fifteen minutes was twenty-five; and the **nutrition still comes from the
database**, priced at generation through the same match path everything else uses.

Equipment and the per-request maximum cooking time, also in §6 phase 2, are not
built. Named here so they are not mistaken for done.

---

### D77 — The food screen leads with logging, and the occasional tools are one tap away

Six blocks were competing on one screen: the date strip, Senast loggat, free-text
parsing, recipe suggestion, search and scan, and the day's list. The everyday
path, which is repeat a meal or scan something, was buried among things used once
a week.

The order is now: date, **scan and search**, **Senast loggat**, **Sparade
måltider**, two buttons, the day's list.

**The two fast paths came out from behind their disclosures.** Folding them was
the right answer to a different problem, two stacked ledgers above the search
box, and the better answer to *that* was to move the search box up, which is what
happened here. Repeating a meal is what people open this screen to do, and a tap
is a tap. The recent list is capped at six on the surface rather than twelve,
because twelve rows is the ledger the fold was hiding and six is the last day or
two, which is what "again" means.

**The two occasional tools went into sheets**, behind one clearly labelled button
each. Describing a meal in a sentence is for the meal that fits none of the fast
paths; asking what to cook happens at a fridge. Both cost a tap and return the
whole screen. When the workstation is off the buttons are not there at all, which
is the same rule as before: no error banner, no disabled control, no trace.

The sheet is one component rather than three copies, and it closes on Escape,
moves focus in and back out, and locks the page behind it. A second hand-written
focus trap is a second place to get it wrong.

Measured on the production build at 360x740 under 4x CPU throttling and about
80 ms latency on 1.6 Mbps, the same conditions as the previous table:

| | before | now |
|---|---|---|
| repeat food, cold open to logged | 2 taps, 89 ms | **1 tap, 74 ms** |
| saved meal, cold open to logged | 2 taps, 203 ms | **1 tap, 182 ms** |

Both fast paths lost a tap and neither got slower. The cold load still makes the
same five API requests, and the sheets fetch nothing until they are opened.

### D78 — A save may not fail silently, and one row's save is not the whole list's

Reported: on a phone, logging food from the recent list does nothing, and
scanning gets stuck on "Sparar…". The same actions work in a desktop browser.

**What was ruled out, with evidence.** Two hypotheses looked strong and both are
wrong, which is worth recording so they are not tried again.

The first was the queue database's version. A device that ran the build fixed in
D70 has `vikt-queue` at an IndexedDB version written by a `version(2)`
declaration, while the current code declares `version(1)`, and opening a lower
version than the one on disk is a hard `VersionError`. Reproduced directly, it
does throw — but only with raw version numbers. Dexie multiplies its declared
version by ten, so the real numbers are 10 against 20, and Dexie opens an
existing 20 quite happily and bumps it to 21. Seeded that exact state and logged
from the recent list: it worked, queued a row offline, and released the button
in 62 ms. The same test on a fresh database behaved identically.

The second was the service worker serving an old build. Dev has no service
worker at all (`devOptions.enabled: false`), and the phone reaches the dev
server through nginx, so there is nothing to serve a stale bundle from.

**So the trigger is still unidentified**, and it is not reproducible off the
device. What *is* certain from the code is why it looks the way it does, and
those are two defects worth fixing on their own terms.

**One shared mutation disabled every row.** `useSaveFoodEntry` is one
`useMutation` instance for the whole recent list, and every row was disabled on
its `isPending`. Tapping one row disabled all of them; a save that never settled
left the entire list permanently dead. That is exactly "logging from recent does
not work", and it is true whatever the original stall was. Pending is now
tracked by row id.

**A rejected save said nothing at all.** Both handlers awaited `mutateAsync`
without catching, so a failure became an unhandled rejection: no message, no
retry, the tap simply did nothing. §3 forbids a failure *state* in this UI; it
does not license a hidden one, and D42 already says a write the app could not
make is one it has to admit to. Failures are now caught and spoken, and a
failure notice stays up for six seconds rather than the 1.6 a confirmation gets,
because a receipt is for something the user already knows they did and a failure
is the only chance they have to notice.

**And every await in the save path is now bounded.** `queueAvailable()` was
bounded in D70 and nothing else was: the two Dexie calls that write the row and,
in the no-queue fallback, a bare `fetch` with no timeout. Any of them stalling
produced a permanent "Sparar…" with no message and no way back. An unbounded
await is a lie about what the app knows. IndexedDB gets five seconds, which is
not a deadline but a declaration that a single-digit-millisecond operation has
stopped; the network fallback gets twenty and an actual abort.

None of that is a claim to have found the cause. It converts a silent, spreading
hang into a stated, local failure, which is both correct on its own and the
thing that makes the next report diagnosable.

**The probe that can name the cause.** `/diagnostik` could count the rows
already in the queue, which says nothing about why a write into it never
returns. It now runs the three steps of a save separately, each with its own
stopwatch and its own bound: open the database, write and remove a row in the
real table, reach the server. The network step is a `GET /api/health` rather
than a real write, because a diagnostic that logs food to find out whether
logging works would put a row in someone's day every time it ran. Whichever line
reads "tog slut" is the answer.

### D79 — Counted metrics project by arithmetic, measured ones by regression

A milestone on `sober_days` or `log_streak_days` read "Serien rör sig för lite
för ett datum" — about a number that advances by exactly one every day, without
exception, by definition.

`project.ts` fits a least-squares line to a series and extrapolates. That is the
right tool for **measured** metrics — weight, waist, chest, the ratio between
them — which are quantities the body arrives at, sampled with noise, moving at a
rate that has to be estimated. Null is a real answer there: sometimes the trend
genuinely is not moving.

A **counted** metric is not measured at all. At day 28 of 100 the answer is 72
days and there is nothing to estimate. Worse, the regression did not fail
because a counter looks flat — a counter is a perfect line of slope 1 — it
failed because a young streak has fewer than the seven points the fit requires.
So the app declined to do arithmetic it could do exactly, and blamed the data
for not moving.

`projectCounted` is subtraction. It never returns null while the count is below
its target, except at the same 730-day cap the regression uses, because a
hundred-year streak target is arithmetic rather than information either way.
`metricKind` decides which applies, as a function rather than a property, so the
two call sites cannot disagree about what `sober_days` is.

**What a counted projection assumes, said once and said flat.** A streak's date
is exact and the only thing that can falsify it is the streak ending, so the
card carries one line: "Om serien håller." Not a warning. §3 rules out a failure
state in this UI, and the difference between naming a method's assumption and
cautioning someone about their own behaviour is the whole distance between this
app and the ones it is not. Measured metrics get no such line, because a
regression already carries its uncertainty in being allowed to say nothing.

---

### D80 — Restaurant food is three problems, and only two of them are ours to solve

**a. Chains that publish data: coverage is poor, so no scrapers.** Measured
before building, against the live adapters, for fifteen Swedish chains. Ten
answered before the shared rate budget ran out:

| | usable hits | actually that brand |
|---|---|---|
| Subway | 7 | 7 |
| Espresso House | 6 | 6 |
| Max | 8 | 4 |
| Burger King | 4 | 3 |
| Pizza Hut | 3 | 3 |
| Sibylla, Pressbyrån | 1 | 1 |
| McDonald's | 5 | 1 |
| Wayne's Coffee, O'Learys | 4, 1 | 0 |

Two chains are genuinely covered. The rest are patchy, and the *shape* of what
is there is the real finding: searching "mcdonalds big mac" returns a wrap, and
the best Max hit is a garlic dressing. The flagship items — the ones people
actually eat and actually want to log — are the ones missing, and what is
present is crowdsourced, so a burger's per-100 g figure has unknown provenance.

So no per-chain scraper. §6's contract tests exist because adapters rot, and a
scraper per chain is a dozen of them rotting in parallel for a handful of
sandwiches. What these chains needed was for name search to work at all, which
is D83, and every number in that table is a result the app could not have found
last week.

**b. Independent restaurants: a typed estimate, remembered.** The pizzeria case,
where nothing exists to find. The alternative to letting someone type a figure
is the day going unlogged, and that is worse for every number downstream:
§4.2's maintenance figure averages over the days that *were* logged, and §4.2
itself notes that people skip logging the large meal more often than the
ordinary one. An honest guess beats a hole.

It asks for **the portion, not per 100 g**, because nobody knows the kcal per
100 g of a pizza; the per-100 g figure the cache needs is derived from the pair.
It is stored **private**, because one person's guess about one restaurant is not
data for anyone else. It is marked `is_estimate` permanently and shown as such
on every screen it reaches. And it is **remembered as a reusable food item** —
see D81 for why that matters more than it looks.

**c. Composed meals: the existing parse path, pointed at a plate.** No new
mechanism, which is D81's clarification.

**Favourites**, because b and c produce exactly the rows that are most expensive
to recreate and least likely to be found by searching, and they recur: the same
pizzeria, most Fridays. Its own table rather than a column on `food_items`, for
the reason every user-scoped fact about a shared row needs one (D17): a column
there would make the last person to tap the star the owner of everyone's
opinion.

---

### D81 — The model may decompose freely; it may estimate only under four conditions

D5 stands: **the model never produces nutrition numbers**, because a model that
confidently invents plausible ones would poison the intake series. Two additions.

**The clarification.** D5 does not forbid the model *decomposing* a described
dish into components with estimated portions. That is what the free-text parse
path has always done, and a restaurant plate is a shopping list in different
words: "torsk med kokt potatis, gräddsås och broccoli" becomes component rows
with estimated grams, each matched against `food_items`, nutrition from the
database as always, portions shown and correctable before anything is saved. No
rule changes and no new mechanism — the existing path pointed at a new input,
which is why composed meals cost almost nothing to support.

**The exception, and why it is worth making.** Some items do not decompose
usefully: a named chain burger, a pizzeria pizza. There the alternative to a
model estimate is not a database figure, it is **the user guessing** — and
people systematically underestimate restaurant portions. Refusing to estimate
does not avoid an invented number; it moves the invention somewhere less
examined and biases it downward.

So the model may estimate calories and macros when **all four** hold, and the
first three are conditions on what already happened rather than preferences:

- the item is not found by barcode or by name;
- decomposition has been tried and either produced nothing or was rejected;
- the user asked, in as many words;
- and the request says so. `after` and `requested: true` are in the request
  schema, `requested` as a literal, so the endpoint refuses without them and a
  client that hard-codes them does it where a reader can see it.

The estimate is hedged everywhere it can be. It is stored `source:
"llm_estimate"`, `confidence < 1`, `confirmed: false` until accepted. It arrives
as a **proposal that fills a form**, not a save: editable, with what it was
based on beside it. And it is asked for a **range** as well as a figure, because
the width is the honest part — a burger the model knows is 650 to 950 kcal and a
dish it does not is 400 to 1200, and a person can act on that difference. The
confidence is *derived from that width* rather than asked for, because a model
asked how confident it is answers with a number about its tone. A point figure
outside its own stated range is refused outright: a model that cannot keep its
own arithmetic straight has not understood the question.

**An accepted estimate is remembered**, and that is the decision the brief asked
for. Re-estimating the same pizza gives a different number every time, and that
variation lands in the series §4.2 computes maintenance from — noise injected
into the one place this app cannot afford it. A remembered estimate is one
number, stable across every Friday it recurs, editable when the user learns
better, and still marked as an estimate for as long as it exists.

---

### D82 — An estimated day counts toward coverage, and pays for itself in confidence

The decision that actually moves the number. §4.2's adaptive maintenance figure
is computed over days that clear an 80% coverage gate, and whether an estimated
day counts moves maintenance either way.

**Excluding them was rejected**, and the reason is §4.2's own. The gate exists
because "unlogged days are not a random sample of days". Restaurant days are
precisely the days that differ from the rest — larger, less predictable, more
often social — so excluding every day containing an estimate would drop coverage
below the gate for anyone who eats out regularly, lose the adaptive figure
entirely, and fall back to Mifflin. That does not avoid the bias, it reproduces
it deliberately, and throws away the measurement as well.

**Counting them silently was also rejected.** Systematic estimation error would
walk maintenance somewhere it should not go with no signal anywhere.

So: **estimates count as logged, and reduce confidence in proportion.** §4.2
already has exactly the channel for "this number is real and less certain than
usual", and is explicit that the UI shows the confidence rather than hiding it.
`estimateShare` is the share of the window's logged energy that came from
estimated items; confidence is multiplied by `1 - 0.5 * estimateShare`.

The 0.5 is a judgement and is stated as one: a window made entirely of estimates
halves its confidence rather than zeroing it, because it is still a measurement
of something and zero would mean "we know nothing", which is not true. The
penalty applies only to the adaptive figure — a formula figure is not computed
from intake at all, so estimates could not have moved it, and discounting it for
their presence would be discounting the wrong number.

The UI says what is in force: when the window contains estimates, the maintenance
card names the share above the confidence bar. A bar that quietly dropped would
be the app knowing something it did not say.

The existing rules hold underneath. An entry with no determinable energy is still
not logged silently (D74). D55's macro coverage still applies per macro, so a
restaurant item with calories and no protein figure leaves the day's protein
*unknown* rather than quietly depressing it — the estimate form writes null for
a blank macro field, never zero.

---

### D83 — Open Food Facts' `search_terms` does nothing, and the ranking demoted the answer

Searching by name did not work, and the brief named four suspects. The cause was
the first one, and worse than expected.

**`/api/v2/search?search_terms=` ignores the parameter.** Every query came back
with page one of the entire database. "kvarg", "proteinpulver" and "star
nutrition" all returned the same four Moroccan dairy products, and `count` on
the response was **4 730 807** — the whole of Open Food Facts. Those results
were then written into the shared `food_items` cache as though they were
matches, so "Sidi Ali" became a cached hit for "rågbröd". That had been visible
in an earlier session's output and was read as the network being unavailable.

The same defect as Livsmedelsverket's `namn` parameter, already documented as
not filtering. **Two food APIs out of two have shipped a silently ignored search
parameter**, which is why the contract test added here asserts on whether the
results have anything to do with the query rather than on the request having
succeeded. A search that is ignored still returns 200 and still returns
products; nothing about the request is wrong.

`search.openfoodfacts.org` does filter, and is now what `search()` calls. Its
shape differs in two ways that fail silently if unhandled: results are `hits`
rather than `products`, and `brands` is an array rather than a comma string — an
array reaching `firstString` yields no brand at all rather than an error, so a
branded product would have become unfindable by its brand.

**The other three suspects, checked:**

- **Ranking put the answer off the page**, and this one was real. The order-by
  carried an unconditional `+1.5` for rows with no brand, so every branded
  product was demoted against every generic one — exactly backwards for someone
  searching for a named protein powder, and the same shape as the earlier
  "banan" defect. The bonus now applies only to single-word queries, where a
  bare noun does want the Livsmedelsverket row; "lindahls kvarg" is a specific
  request and is treated as one. Decided from the query rather than per row,
  because it is a fact about the question.
- **Brands were not filtered out, but they were not matched either.** Only
  `name` was matched, so "star nutrition" found a product *called* that and
  nothing merely made by them, and the phrasing people actually type — brand and
  product together — matched neither half. The `where` clause now matches brand,
  and `brand || ' ' || name`, and the ranking scores that combination like a name
  match.
- **The three-character minimum and submit-only search are fine and stay.**
  Search is a shared rate budget spent per keystroke otherwise; that trade is
  already recorded and search now returns real answers, which is what made it
  feel broken.

One more, found on the way: `searchFood` short-circuited to cache-only whenever
the local cache returned a full page, so a query matching twelve loose rows never
reached the network at all. Loose is what the local matcher is — substrings,
stems and trigrams over thousands of Livsmedelsverket rows. It now short-circuits
only when the cache has actually *answered*: a row whose name, or whose brand and
name together, closely matches. A page of maybes is worth a request.

Verified against the live service: "lindahls kvarg" returns Lindahls Kvarg,
"proteinpulver" returns protein powders, "nocco" returns Nocco.

### D84 — A contract check asserts what a parameter did, not that the call returned

The Open Food Facts search check passed for as long as `search_terms` had been
ignored, because it asked whether results came back and the answer was always
yes (D83). The standard that would have caught it, applied to every check: each
must assert the **effect of the parameter it sends**.

Three changed. Each sends something that selects, and none of them checked that
the selection happened.

**The barcode lookup.** A product API that ignored the path and answered with
some other product would have passed every assertion below it: a real payload,
real nutriments, a clean normalisation. The check now compares the returned
`code` with the barcode it asked for.

**Livsmedelsverket's list.** `offset` and `size` are what the importer walks the
database with. If `offset` were ignored, every page would be page one: the
import would loop over the same five foods forever or silently import a
fraction of 2 600, and the old check — rows came back, therefore healthy — would
have called that fine. It now asserts `size` limits and that offset 0 and offset
5 return different foods.

**Livsmedelsverket's nutrients.** The food id selects the food. If it were
ignored, all 2 600 rows would import with the first food's numbers, under 2 600
different names, and every code would still be present and every row would still
normalise beautifully. Two different ids must now return different values.

What did not change: the field-presence checks, which already assert something
that can only be true if the field is there, and the energy-unit checks, which
assert a computed figure rather than a successful request.

A small stale label surfaced on the way: barcode 7622210449283 is labelled
"Marabou mjölkchoklad" in the fixtures and Open Food Facts now returns "Prince"
for it. Not a contract break — the product behind a barcode is allowed to change
— but the identity assertion is what made it visible, which is the point.

---

### D85 — Portions resolve through three layers, and grams are the last resort rather than the default

`serving_hints` was wired up in D73 and in practice almost nothing had one.
Livsmedelsverket publishes no serving data at all and Open Food Facts carries it
inconsistently, so nearly every food fell back to 100 g. That is not a portion,
it is a placeholder, and it quietly asked the user to do the one thing the
feature existed to spare them: estimate grams, or weigh the food.

Three layers now, in this order, and the order is the argument:

1. **The last amount this user logged for this food.** 250 g of filmjölk last
   time is 250 g this time. Not an equivalence at all — it is what this person
   actually ate — which is why it outranks every table ever printed. Derived from
   `food_entries` rather than stored, because the log already holds that fact
   exactly and a second copy would be a second definition to keep in step, which
   is what D44 and D47 exist to prevent. It is also correct the instant an entry
   is edited or deleted, with no write path to remember.
2. **The user's own portion for that item** (D73), set once and reused.
3. **A household measure for the food's category**, from a table in
   `packages/shared`.

Anything with none of the three falls back to grams **and says so**. The screen
names which layer answered — "samma mängd som du loggade senast" is a different
claim from "100 g som utgångspunkt", and only one of them is worth trusting
without checking.

**The table is by category because density is.** A decilitre of flour is 60 g and
a decilitre of milk is 100 g; a table that ignored that would be worse than no
table, because it would be confidently wrong in the direction people cook in.
The figures are approximations of standard Swedish household measures and are
approximations on purpose: pretending a decilitre of milk is 103.4 g would be
fabricated precision. Every resolved amount is shown in grams beside its portion
and stays editable, so a wrong equivalence is visible before it is saved.

**Categories come from the adapters, and are allowed to be absent.** Open Food
Facts publishes `categories_tags`, a real taxonomy, used first. Livsmedelsverket
publishes a name and nothing else, so its foods are matched on the name — a
heuristic, and treated as one: a miss is null and the food falls back to grams.
That is acceptable here precisely because being wrong is *visible*, and it would
not be acceptable in `calc/`, where nothing is shown before it is used.

Storage stays in grams. Nothing about `food_entries`, `calc/` or D44's single
definition of a day's intake changes; this is a display and input layer on top.

---

### D86 — The graphic profile, and the two rules a test has to hold

`docs/Vikt-grafisk-profil.pdf` implemented. §5 amended to match. This pass changed
appearance only: no calculation, no behaviour, and no copy beyond a renamed
state.

**Lingon still belongs to two things**, per D51 and per the profile: the trend
line and the wordmark. Nothing else. That is the oldest rule in §5 and the reason
the accent means anything — the eye knows red is *your trend* because red is
never anything else.

**Four accents are added, and each names an area rather than a feeling.** Gran is
not "good", Gran is "logged". Is is secondary data, Honung is reward, Blåbär is
nutrition. When something new needs a colour the question is which area it
belongs to, and no answer means no accent, which is usually right.

**Uncertainty gets none.** Estimates, incomplete totals and "inte än" are Sten
with a dashed edge or a `≈` prefix. Uncertainty is not an area; it is an absence
of information about something that already has one. **Errors, warnings and empty
states get none either** — a 422 is explained in Snö with no red frame, because
§3 says this app has no failure state and a colour that only appears on a bad day
builds one.

**Two layers of token, and the separation is the point.** The palette carries the
profile's Norrland names and is **not exposed as Tailwind classes at all**; the
semantic layer names meanings and points at it. A class called `text-gran` would
let a component pick a colour because it liked the green; `text-logged` cannot be
misused that way, because using it is a claim about what the thing is. After this
pass no component names a colour and none contains a hex.

**Two guards, both proved by reintroduction.** `colour-meaning.test.ts` checks
that Lingon appears in exactly two files, and that the components carrying
errors, sync state and the queue use no accent. Both are proved twice: against
strings that break the rule, and — for Lingon — by actually putting `bg-trend` on
a quick action and watching the suite fail. The comment-stripping matters more
than it sounds: this file and half the codebase discuss these colours constantly,
and a guard that counted the word "trend" in a sentence explaining the rule would
fail on documentation and pass on a violation.

**Four decisions the profile left to the mapping.** The confidence bar under
Underhåll lost its Gran: maintenance is a *summary* of several areas rather than
one of them, and page 8 keeps summaries in Snö and Sten. The pot's chart and
reached milestones gained Honung, having been Gran — the profile draws the line
between them explicitly, streaks being *streck* and milestones being
*belöningar*. The waist-to-height series moved from Gran to Is, joining the raw
readings it is a sibling of. And "Spara dagen" became the primary button it
always was in the layout but never in the class.

**One mapping had nowhere to land.** Page 8 puts "mått på Dagen" in Is, and Dagen
displays no measurement figures — only input fields. An input is not a reading,
so nothing there took the accent, and the measurement data that *is* displayed,
the waist series, is Is on Översikt and on Data. Recorded rather than solved by
colouring a label to satisfy a table.

**The logo is one component.** Wordmark, mark, and the two together — which is
what makes "Lingon in exactly two places" a fact a test can check rather than a
convention someone has to remember. The mark is exported as `icon.svg` and as the
maskable icon on Skymning, drawn inside the safe zone so an Android launcher
cannot crop the endpoint off the trend line.

**And a build id**, unrelated to colour and overdue. `registerType: "prompt"`
means an installed PWA keeps its bundle until an update is accepted, so "the fix
is deployed" and "the phone has the fix" are different facts with no way to tell
them apart from the device. `/diagnostik` now prints one, first in the list,
because everything below it is worthless if the app is old.

### D87 — The tree goes under version control, and what the audit found first

Eight phases were built outside git. Every regression in that period was
unrecoverable, and at least three cost a session each. That is the reason this
came before anything else in the pass.

**The `.gitignore` was written before `git init`**, which is the only order that
works: git does not un-track a file because a pattern appeared later, and it
cannot remove one from a commit that already happened. Secrets, certificates and
keys, photos, database dumps, screenshots of a real dashboard, scratchpad and
build output, all excluded before a single file was staged. A `.gitattributes`
normalises text to LF — the tree is developed on Windows and deployed on Debian,
and without it every Windows-touched file arrives in review as wholly rewritten.

**The audit, and what it changed.** A gitignore does not scrub committed text, so
305 candidate files were searched before the first commit:

- **the development seed password.** `seed-dev.ts` held `SEED_PASSWORD` as a
  literal, which in a public repository is a working password for an account
  that exists on every machine that ever ran the seeder. Moved to the
  environment with **no default**: the seeder refuses without one, because a
  default is the same published password one indirection further away.
- **the trend fixture's 110 kg**, which was the owner's own starting weight.
  Shifted to 100. The exponential moving average is translation-invariant, so
  every expected value in the file is unchanged and the same case is exercised —
  which is also the proof that the figure was never load-bearing.
- **D27's plan pair**, 1500 against 2690, likewise the owner's. Replaced with
  1800 against 3000, which makes the identical point: an implied 1.09 kg/week
  against a stored 1.00. Edited in `DECISIONS.md` as well as in the schema
  comment and the test. Append-only governs *decisions*, not personal figures
  inside them.
- **LAN addresses.** A private-range address in the constitution, a script
  comment and a document; another in a test fixture. All replaced with
  placeholders.
  RFC1918 addresses are not exploitable from outside, but they describe the
  owner's home network and there is no reason to publish it.

**What was checked and found clean:** the owner's email address appears in no
tracked file; no API tokens, private keys or credentials of any kind; the test
passwords in the auth suites are obviously synthetic strings. The staged content
itself was searched again after `git add`, because what matters is what goes into
the commit rather than what is in the working tree.

**AGPL-3.0**, chosen by the owner when asked. Cached Open Food Facts data is
ODbL and is deliberately not in the repository: it is fetched at runtime into a
local cache. The repository is **private** for now; making it public is a
decision for after the audit above has been read by a person.

---

### D88 — Email exists now, and nothing is ever sent inside a request

The app had no outbound email by design, and that was right while it had one
user who knew the owner. It stops being right the moment anyone else can have an
account: without mail there is no password reset, and a forgotten password is an
account nobody can recover.

**What it buys.** Password reset, which is the largest usability gain available.
A receipt for an invite request, so asking does not feel like shouting into a
void. An invite code delivered without the owner copying it into a chat window.

**What it costs, stated plainly.** A dependency on someone else's SMTP server.
An address held by a third party for every message. A new class of failure that
happens minutes after the request that caused it, out of the user's sight. And a
surface that can be used to send mail to an address the sender does not control,
which is why both public endpoints are rate limited two ways.

**Nothing is sent inside a request.** An SMTP conversation takes seconds on a
good day and hangs on a bad one; a reset request that waits for a mail server
fails when the mail server does. The request writes a row and a worker drains
it, with status, attempts, last error and exponential backoff — the same shape
as the LLM job queue, because two queues that behave differently are two things
to learn. A permanent refusal (5xx) stops at once; a temporary one retries six
times over about two hours and then stops, because a message nobody has received
after that needs a person, and silent infinite retry is how a broken
configuration hides for a month.

**A failed send is visible.** The row keeps its reason and the admin view lists
it. §3's honesty rule covers the app's own failures, not only the user's data.
The queue row is also kept after success, unlike the offline write queue: there
the server is the record of what was logged, whereas here this row is the only
thing that can answer "did the reset mail go out".

**Email is optional and the app boots without it.** An empty `SMTP_HOST` means
off, and every feature degrades rather than failing: reset says it cannot send,
and approving an invite shows the code on screen for the owner to pass on by
hand. A self-hosted install with no mail server is a supported configuration,
because the alternative is an app that refuses to start over a feature its owner
never wanted.

**Password reset, and the four properties that are tested rather than reasoned
about.** The request endpoint answers identically whether or not the address
exists — for a weight-tracking app an account-existence oracle is a more
sensitive disclosure than it would be for most. Tokens are 32 random bytes,
stored hashed like session tokens, so a database copy is not a set of working
links into accounts. They are single-use, enforced by a conditional update that
matches no rows the second time rather than by a check-then-write. They expire
in an hour. And completing a reset **drops every session for that user**,
including the one making the request: a reset is what someone does when they
think another person has their password, and leaving that person signed in makes
it a gesture.

Mail is plain text first, with a minimal HTML variant that is the same words in
a readable measure. No images, so nothing loads from a server that could log the
open; no tracking pixel, no click wrapper. There is no marketing template and
there will not be: a sender that has never sent marketing is one nobody has to
unsubscribe from.

---

### D89 — Anyone can ask for a code, and the app grows its first authorisation concept

Registration has been invite-only since phase 0, which meant in practice that
the only way in was knowing the owner. The landing page adds a form.

**It stores as little as it can**: an address, an optional line about why, and a
timestamp. Nothing about the browser, nothing derived from the address. A
rejected request is **deleted rather than marked rejected**, because a record of
someone the owner turned down is personal data kept for no purpose anyone could
name, and rejection sends no mail — an unasked-for notice from an address nobody
can reply to.

Public and unauthenticated, so it is treated as the same class of surface as the
ingest endpoint: rate limited per IP on `request.clientIp`, which is D14's path
and validates the peer before believing any forwarding header; a honeypot field
that is accepted rather than refused, so a scraper learns nothing from the
response; capped input lengths; and the same answer for a repeat as for a new
request, because whether an address has already asked is not something an
anonymous caller gets to learn.

**The admin role is the app's first authorisation concept**, which is why it is a
decision rather than a column. A boolean on `users`, set by a CLI script and
never through the UI: an endpoint that can grant admin is a privilege escalation
waiting for one missing check, and granting it happens once, for the owner, on
the machine with the database. `requireAdmin` is composed on top of `requireAuth`
rather than sitting beside it, so an admin route cannot forget the session check;
it reads the flag from the database on every request rather than from the
session, so revoking it takes effect immediately rather than at the end of a
session's life; and it answers **404**, because a non-admin has no business
learning these endpoints exist.

Rejected: a roles table. There are exactly two kinds of account, and inventing a
role system for the second is scaffolding for a building nobody has drawn.

**Responsibility, stated.** D9 and D10 already protect the data itself — group
views never expose body data, photos live outside the web root behind
authentication. What changes once other people log data here is that the owner
becomes responsible for it, and the landing page says in the app's own register
what the address is for, that it is deleted on rejection, that mail passes
through an external provider, and that a self-hosted install stores nothing
anywhere else.

---

### D90 — The app moves to /app so the landing page can never be cached

A public landing page at the root, the application under `/app/`.

The mechanics, each of which had to be decided rather than defaulted:

- **Two Vite entries in one project.** `index.html` is the landing page,
  `app/index.html` the application. One project so both share the tokens, the
  fonts and the component layer and cannot drift apart visually; the landing
  bundle imports no router, no query client and no service-worker registration.
- **The service worker is scoped to `/app/`** and is registered only by the app's
  entry. That is the reason for the whole move: an installed app that could
  answer for `/` would serve visitors a landing page from whenever its owner
  last accepted an update. The worker file stays at `/sw.js`, because a worker
  may always claim a scope at or below its own path and only a broader claim
  needs `Service-Worker-Allowed`. Verified on the production build: `/` has zero
  registrations and no controller; `/app/` has one, scoped to `/app/`.
- **`start_url` and `scope` are `/app/`**, so the installed app opens the
  application rather than the marketing page.
- **The router basename is `/app`**, so no route inside the app mentions the
  prefix and moving it again is one string.
- **The session cookie narrows from `/` to `/api`.** It was right when the app
  was the site; now the root is public and a session cookie sent with every
  request for it is a credential handed to a surface with no use for it.
- **nginx gets an explicit `location /app/`** with its own SPA fallback, and the
  root gets none: an unknown path under `/` is a 404 rather than a landing page
  pretending every URL exists. Vite's dev server needed the same rule as a
  middleware, and without it every app route in development was answered with
  the landing page — which is exactly how it was found.

**The installed PWA on the phone must be reinstalled.** `start_url` and `scope`
have moved, and an already-installed app keeps the old ones.

---

### D91 — The mark loses its raw-reading dots, and gains a place in the header

Page 7 of the graphic profile draws the mark as the trend line with two raw
readings in Is behind it. At icon size those dots are noise: at 24 px they are
two grey pixels that read as dirt on the glass, and at 16 px they merge with the
curve and thicken it. The picture that survives is the one the favicon already
used — a falling curve with a single endpoint, on a Skymning rounded square.

The end dot is drawn large relative to the stroke rather than proportionally,
because it is the part that has to survive. Tested rather than assumed: rendered
at 16, 24, 48, 192 and 512 px and sampled at the pixel where the dot should be.
It is full-strength Lingon at all five.

**And it goes in the header**, which page 7 forbids. That rule's stated objection
was that the mark "competes with the graph directly beneath it" — an objection
about **size**, not presence. At 20 px, beside the word and above a chart
occupying a third of the screen, it competes with nothing and reads as an
identity, which is what a header is for.

---

### D92 — Samband becomes a tab, and the bottom bar gets a fifth item

Data, Samband and Inställningar existed only in the landscape sidebar. On a
portrait phone — which is how this app is actually used — they were unreachable
except by typing a URL, and Profil and sign-out were no better.

**Samband merges into Data as a tab.** Both are views of the same logged series
and both carry D34's constraints, so one entry point is fewer things to place and
one fewer screen to find. The tab is in the query string rather than in state
alone, so it is a place a person can return to and the back button does what it
looks like it does. `/samband` redirects rather than 404s: it is in browser
histories.

**A fifth bar item, Mer**, opening a sheet with Data, Profil, Inställningar and
Logga ut. The standard overflow for a bottom bar, and it stays under a thumb.
D53 removed the raised centre button, which is what left room for it without
crowding four destinations into three quarters of the width.

**Labelled, and deliberately not a hamburger.** In a bar of four labelled tabs
the unlabelled icon is the one thing nobody can read, and the label costs
nothing. The sheet is the same component the rest of the app opens things in, so
it closes on Escape and returns focus without being taught to.

The landscape sidebar keeps listing everything directly.

---

### D93 — An installed PWA is identified by its manifest `id`, not by where it was installed from

The app moved to `/app` in D90, the manifest said `start_url: "/app/"` and
`scope: "/app/"`, and the installed icon on the phone still opened the landing
page. Reinstalling did not fix it.

**Diagnosed before anything was changed**, by asking Chrome rather than
reasoning about it. `Page.getAppManifest` over CDP returned the manifest with
the right `start_url` and `scope`, no parse errors — and `computed id: (none)`,
with the manifest itself served from the root.

Two causes, both real:

**The manifest had no `id`.** When `id` is absent Chrome computes one from the
manifest's own URL, so a manifest served at `/manifest.webmanifest` identifies
the app as the thing at `/`, whatever `start_url` says. The installed entry was
therefore correct about where to start and wrong about what it *was*, and a
reinstall re-derived the same wrong identity. `"id": "/app/"` is now explicit,
and the manifest is served from under `/app/` as well, so the two agree even if
one is later edited without the other.

**A service worker was still registered at scope `/`.** From before D90, when the
app was at the root. A worker may control any scope at or below its own path, so
the old one was still answering navigations to `/app/` from a cache that predated
the move. `update.ts` now unregisters, on every boot, any registration whose
scope is not `/app/` — not only the root one, because the general statement is
the one that stays true.

**Rejected: telling the user to clear site data.** It works once, on one device,
and leaves the defect in place for everyone who installs next. The manifest `id`
is the durable fix; clearing the phone was how the fix was *verified*, not what
the fix was.

The lesson worth keeping is the first step, not the answer: `start_url` says
where an installed app opens, `id` says which installed app it is, and only the
browser can say what it actually computed.

---

### D94 — Deployment modes live in the environment, and never in the admin interface

Three things are optional in a Vikt deployment: the public landing page, outbound
mail, and the LLM layer. All three are now switched in configuration —
`LANDING_ENABLED`, `SMTP_*` with `PUBLIC_ORIGIN`, and `LLM_ENABLED` with
`OLLAMA_URL` — and **each defaults to off**.

**Never a toggle in the admin UI.** A setting an administrator can flip at runtime
is a setting that can be flipped by anyone who reaches an admin session, and two
of these three decide whether the server talks to the outside world at all. They
belong with the deployment, next to the database password, in a file the operator
already treats as a secret and a reverse proxy never serves.

**Off by default, in every case.** The alternative is a fresh install that mails
strangers, or reaches for a model host that is not there, because somebody did
not read far enough down `.env.example`. A default that acts is a default that
surprises.

**The control is absent, not disabled.** With `LLM_ENABLED` off, the free-text
button, the recipe button, the model-estimate button, the pantry and the saved
recipes are not rendered at all. A greyed-out control is an advertisement for a
feature the operator has deliberately not deployed, and it invites a support
question that has no good answer. Walked with the flag off before this was
written: those five are gone; search, scan, the repeat list, saved meals, the
manual estimate and all four other screens are untouched, which is the other half
of the claim.

**A startup line states the modes**, so `docker logs` answers "is mail on?"
without reading the environment of a running container, and `/api/health`
reports the same three booleans for anything automated.

**A booleanish parser, not `z.coerce.boolean()`.** `z.coerce.boolean()` on the
string `"false"` is `true` — every non-empty string is truthy — and it shipped
`llm: true` with `LLM_ENABLED=false` in the environment. The codebase already had
`z.enum(["true","false","1","0"]).transform(...)` for exactly this; all three
flags use it, and an unparseable value now fails at boot instead of silently
meaning yes. `SMTP_SECURE` was the same bug, unnoticed.

The mail switch is derived rather than declared: mail is on when `SMTP_HOST` and
`PUBLIC_ORIGIN` are both set, because a `MAIL_ENABLED=true` beside an empty host
is a claim the process cannot honour, and there is no reason to let those two
disagree.

---

### D95 — Administration acts on a named subject, and every action writes who did it

D89 gave the app its first authorisation concept for approving invite requests.
This extends it into the rest of what running a server for other people actually
requires: users, invites, password resets on behalf, and the mail queue. Every
route is behind `requireAdmin`.

**Users.** List with created and last seen; disable and re-enable; delete. Last
seen is `max(sessions.created_at)`, which is the honest available answer — it is
when they last signed in, not when they last opened the app, and the label says
so. Disabling drops their sessions, because a disabled account that stays signed
in on a phone is not disabled.

**Deletion states its consequences before it happens.** `previewDeletion` returns
the counts — weights, food entries, daily log, photos — and the interface shows
them in the confirmation. "Delete user" is an abstraction; "delete 84 weights and
113 food entries" is the thing that is actually about to happen, and the operator
should have to read it.

**Reset on behalf, never a password.** The admin mints the same reset token the
"forgot password" flow mints, and hands over the link. The admin never sees,
sets, or chooses a password, so there is no moment at which the operator knows a
credential belonging to somebody else. This also means the account holder's next
password is chosen by them, which is the property that makes the audit log worth
anything.

**Invites.** Mint on behalf, list the unused, revoke. Revocation only touches rows
where `used_at is null`: revoking a code someone has already redeemed would
either do nothing or lie, and both are worse than refusing.

**The mail queue is visible.** Pending, failed with the error text, and retry.
D88 made sending asynchronous; a queue nobody can look at is where mail goes to
die silently.

**Every action writes an audit row**, and it is written **by the service, not the
route**. A route that remembers to log is a route that will one day forget, and
the one that forgets is the one that matters. `record()` is private to
`admin.service.ts` and every mutating function calls it on its own success path.

The row keeps `actor_id` with `on delete set null` **and** a snapshot of the
actor's email. An audit trail that erases who did something when that person's
account is deleted is not an audit trail, and the foreign key alone would do
exactly that.

**Signatures.** These functions are the one place in the service layer that does
not take `userId` first. They act on *another* account, so a leading `userId`
would mean the opposite of what it means everywhere else — the subject, not the
caller's scope. They take an explicit `actor` instead, and they are listed by
name in the isolation rule's `allowUnscoped` with that reasoning, which is the
deliberate, diff-visible act the rule was built to require.

**Correction, added later.** As written above, this entry described an interface
that did not exist. "The interface shows them in the confirmation" was true of
`previewDeletion`'s *purpose* and false of the app: the endpoint was built and
tested, and `Admin.tsx` never called it. The same applies to the users list, the
disable and delete actions, reset on behalf, the invite list, mint and revoke,
the mail retry, and the audit log. What shipped in that pass was the API and its
tests. What the admin screen showed was invite requests and the mail queue,
which is what it had shown since D89.

The sentences above are left as they were rather than quietly rewritten, because
the failure is worth being able to see: every one of them describes a real
capability of the system, and not one of them was checked by opening the page.
It is the same mistake as the lint claim in D98 — a summary written from what was
built rather than from what was exercised — and it survived a verification pass
that took screenshots of eight screens without noticing that the ninth was
missing everything the pass had added.

CLAUDE.md §7 now carries the rule that came out of it: the current-state section
of `STATE.md` describes only what was exercised through the interface, and
anything that exists as API only is listed under **API without a screen** until a
screen calls it.

The screens were built in the pass after this one, and D100 covers them.

---

### D96 — The export is proved by a round trip, and the backup by an actual restore

Two halves of the same idea: a copy of your data is worth exactly what has been
demonstrated about it.

#### The export

Per-user CSV per table, streamed, plus one JSON file with everything. Nineteen
tables in dependency order. **Reachable from the app**, not only from the admin
screens — it is the user's data, and needing to ask an operator for it is the
thing an export exists to avoid.

**Six tables are deliberately excluded**: sessions, password resets, API tokens,
LLM jobs, photos and group members. The first three are credentials and must
never leave in a file somebody mails to themselves; a test pins the exclusion
list and greps the output for `password_hash` and `token_hash`, so a table added
to the export later has to pass it.

**The CSV is semicolon-delimited UTF-8 with a byte-order mark**, chosen for the
one place these files are actually opened: Excel with a Swedish locale. `;` is
the list separator there, and without the BOM Excel assumes a legacy code page
and renders å, ä and ö as mojibake. Both are pinned by a test, because both look
like arbitrary details and are the difference between a file that opens and a
file that needs explaining.

**Numbers are formatted sv-SE** for the same reason.

**A round-trip test is the actual deliverable.** Export an account, import into an
empty one, and assert that `maintenance.tdee`, its source and coverage, the trend
weight, the target intake and today's intake all come out identical. What this
proves is not that import works — it is that **the export is complete**. The
derived numbers sit downstream of nearly every table: the trend needs the weight
log, maintenance needs the trend and the intake, the target needs the plan, the
macros need the profile. A table left out of the export shows up as a number that
moved.

It earned its place immediately. The first version returned `null` maintenance,
because the export carries primary keys, importing beside the source collided on
every one, and `on conflict do nothing` imported nothing at all — silently.
Imported rows now get fresh UUIDs, and the four cross-table foreign keys are
remapped through an old-id-to-new map. `food_item_id` is deliberately *not*
remapped: food items are a shared cache, not user-owned, and the export carries
only the rows its entries point at rather than a copy of the whole database.

#### The backup

Nightly `pg_dump -Fc` plus a tar of the uploads volume, written **off the Proxmox
host**, kept 30 days, deleted by age rather than by count so a week the job did
not run cannot silently shorten the window. `.partial` until complete, so an
interrupted run never leaves a truncated file that looks like a backup. Dumped
through the running container so `pg_dump` always matches the server version —
a host binary one major version behind refuses outright, which is a failure only
ever discovered during a restore.

Photos live on disk outside the database by D10, so a database-only backup would
restore an app whose every photo is a broken link. The uploads tar runs even
though Phase 7 has not shipped: a script that starts covering a directory only
once somebody remembers to add it is a script that misses the first month.

**Not encrypted, and that is a decision.** A backup that needs a key is a backup
that fails to restore on the day the key was on the machine that died. The
runbook says where to add `age` or `gpg` and to write the decryption step into
the restore procedure in the same commit.

**And a restore was actually performed.** Not a script that could do one — one
that was done: dump, fresh database, `pg_restore --no-owner`, then compared row
counts (users 2, weight_log 84, food_entries 113, daily_log 55, plans 2,
food_items 2690 — identical) and the derived inputs (mean/min/max weight to four
decimals `89.2126|83.4000|92.4400`, 78 readings, 2026-06-03 to 2026-09-01, intake
sum `28320.90` — identical). The scratch database was dropped afterwards.

Row counts alone would not have been enough. A restore can bring back every row
and still be useless if a numeric column arrives with the wrong scale, and the
trend is the first place that would show — which is why `restore-check.sh` prints
the §4.1 and §4.2 inputs from both databases rather than counts, restores into a
generated scratch name, and drops it on exit so it is safe to run on the
production host.

---

### D97 — The landing page argues with three measured numbers and four real screens

The first landing page was a single column of prose. It said true things in the
right register and gave a visitor no reason to believe any of them, because
nothing on it could be checked and nothing on it showed the app.

Rebuilt on the structure of postliminalsystems.com — hero, figure strip, one
section per capability, footer — and on none of its tone.

**The figure strip is three measured numbers, not three claims.** 2 taps to log a
repeat meal, 0 kronor, 100 % of the data on the user's own server. The tap figure
is read from the fast-path table in `docs/measurements.md`, where it was measured on the production
build under throttling; it was not estimated for the page. A landing page that
rounds its own measurements is the same genre of thing as an app that calls a
water swing progress, and this app's whole argument is that it is not that.

**Four phone-framed screenshots, real, at 360 px, dark, captured from the running
app.** CSS device frames — a rounded rectangle in the app's own edge colour with
a notch — rather than a photograph or a stock mockup, which would put someone
else's hardware and someone else's lighting between the reader and the thing
being shown. The trend chart is in the first one, because it is the argument.

Captured at a fixed 360×760 viewport rather than full page, unlike `shoot2.mjs`:
a full-page capture of the progress screen is two thousand pixels tall and inside
a 300 px frame reads as a ribbon. The food screenshot is taken with the repeat
list opened, because that list is what the "2 taps" figure beside it refers to,
and a screenshot showing a collapsed disclosure would not support the sentence
next to it.

**"Så räknar den" is where the ODbL and Livsmedelsverket attribution now lives**,
moved out of the footer. Attribution belongs with the claim it supports: the
section says the macro targets come from NNR 2023 as Livsmedelsverket publishes
them and the food figures come from Open Food Facts, and the licence line sits
directly underneath. In the footer it was a legal obligation being discharged;
here it is evidence.

**The AI section says what the model does not do, first.** Every app this reader
has already tried has an AI feature that guesses calories. The honest difference
is not accuracy, it is that this one never produces a calorie or macro figure at
all: the model names the food and estimates the amount, and the numbers come from
the database every time. Stating that plainly is worth more than any claim about
how good the model is, and it is the same rule the app actually enforces.

**The support link uses formulaspun's icon, path for path** — the FA6 empty beer
mug, inlined rather than installed, because the app ships no icon library and one
glyph does not justify one. Same link, same person, and someone who has seen one
footer should recognise the other.

**Rejected: a pricing section, a testimonial, a feature grid, and a newsletter.**
There is no price, there are no users to quote, a grid of twelve icons says less
than four screenshots, and the invite form already collects the one address the
site has any business asking for.

---

### D98 — "Clean" stops being a claim, and the placeholder that reached a phone

Two findings from the same root, so they get one entry.

STATE.md said "lint and typecheck clean" for a pass in which `HEAD` had **27
lint errors**. Nobody lied. The sentence was written from memory at the end of a
long session and there was nothing between the memory and the document. In the
same period the installed app on a phone was called `__APP_NAME__`, and that
also survived because the thing that would have caught it was a person
remembering to look.

#### What replaces the memory

**A pre-commit hook**, in `.githooks/` and committed, wired up by the `prepare`
script so `pnpm install` installs it. It runs lint and typecheck, and
deliberately not the tests: the suite needs Postgres and takes long enough that
a hook running it would be disabled inside a week, and a hook people turn off is
worse than no hook because it is still believed. `--no-verify` remains for the
deliberate case.

**GitHub Actions on every push and pull request**, running lint, typecheck, the
full suite against a real Postgres service container, the build, and the
placeholder check below. `pnpm --filter api contract:food` is deliberately
excluded: it hits the live Open Food Facts and Livsmedelsverket APIs, and a
build that fails because somebody else's server is down teaches people to ignore
red.

**STATE.md's verification line now cites a run.** That is the actual change. A
green check is a fact about a commit and a sentence is a fact about a mood.

#### The manifest, and why it was three bugs

The symptom was one word on a home screen. Underneath were three separate
things, and the interesting part is that each one was individually reasonable.

**The dev plugin composed a manifest of its own** rather than serving the file.
So there were two manifests, and they were free to disagree. They did: when D90
moved the app to `/app/` and D93 added the `id`, the file was updated and the
copy was not, so the copy still described an app at `/` with no identity, a
light background and a single non-maskable icon.

**The plugin watched the path the manifest used to live at.** It answered
`/manifest.webmanifest`. Since D90 the app links `/app/manifest.webmanifest`.
Nothing connected the two, so the substitution simply never ran on the file
anybody actually fetched, and that file went out with the placeholder in it.

**`vite preview` did not substitute at all**, which is correct behaviour for
`vite build` (D13 leaves the placeholder for nginx) and wrong behaviour for a
server whose entire purpose is standing in for production. Preview now does what
`30-app-name.sh` does, alongside the `try_files` rule it gained last pass.

The fix in one sentence: the manifest on disk is the only manifest, it is served
at the path the HTML links, and the only thing done to it is the substitution.

#### The check, and what it deliberately is not

`check:placeholders` runs after the build in CI. It is **not** "are there
placeholders in dist" — there are, on purpose, because nginx fills them in at
container start. It asks whether each one sits in a file something actually
rewrites: `*.html`, `*.webmanifest` and `*.json` are the three
`30-app-name.sh` passes to sed, and a placeholder anywhere else is one nobody
will ever fill.

The tokens it looks for are **discovered from this repository's own source**
rather than hard-coded, so a placeholder invented next year is covered without
anyone remembering the script exists. That also keeps third-party conventions
out of the results: `__PURE__`, `__WB_REVISION__` and
`__REACT_DEVTOOLS_GLOBAL_HOOK__` are not ours and are not findings.

One placeholder is allowed to compile into a bundle, with the reason recorded
next to it: `src/lib/app-name.ts` compares against the literal so the app can
tell a failed substitution from a real name and fall back to "Vikt" rather than
rendering `__APP_NAME__` on screen. That fallback is why the *title* was right
while the manifest was wrong, which is also why nobody noticed sooner.

**Honest limit.** This check would not have caught the original defect, because
the build was correct and the dev server was not. `manifest.test.ts` is the part
that would: it asserts the plugin serves the path the HTML links, that no second
manifest exists in the source, and that the D93 identity fields say what D93
decided.

#### And a third thing, found by running the documentation

`pnpm --filter api admin -- --email you@example.com` — the command in the README
and in STATE.md — did not work. pnpm 9 forwards the `--` separator itself, and
Node's `parseArgs` treats everything after a `--` as positional, so it refused
the flags outright. Every CLI script now strips a leading `--` before parsing, so
both forms work. It was found by running the command rather than by reading it,
which is the same lesson as the rest of this entry.

---

### D99 — Profile v1.2 settles the header, and buys the landing page one red button

`docs/Vikt-grafisk-profil-v1.2.pdf` supersedes v1.1. Two things in it change
code, and both were open questions rather than surprises.

#### The header lockup is now the rule

v1 page 7 said the header gets the wordmark alone, never the mark. D91 overrode
that, on the grounds that the stated objection was that the mark "competes with
the graph beneath it" — an objection about size, not presence — and that at 20 px
it competes with nothing. STATE.md carried the disagreement as an open item
rather than pretending it was settled.

v1.2 page 7 now reads: *"Sidhuvudet i appen: märke och ordbild som en kompakt
lockup på 20 pt. I den storleken konkurrerar det inte med grafen under."* The
document and the code agree, the open item closes, and D91 stands as written.

It adds a line for this page too: *"Landningssidan: samma lockup i sidhuvudet,
inte upprepad i hjälten."* So the landing hero loses its centred logo and opens
on the slogan. That is better than it sounds like: the first thing on the page is
now a sentence about what the app does rather than a second copy of its name.

#### One Lingon button, and a boundary that a test can see

Page 4 adds an exception:

> Landningssidan är inte appen. Där finns en enda handling, och den primära
> knappen får Lingon. Inuti appen gäller regeln oförändrat: Lingon är
> trendlinjen och ordbilden, ingen knapp.

The reasoning holds up. Inside the app, Lingon means *your trend*, and it means
that only because it is never anything else: a red button would spend the
meaning on a control. The landing page is not the app. Nobody arriving on it has
a trend line yet, there is no chart on the page for the colour to be confused
with, and there is exactly one thing to do.

**The interesting part is the shape of the exception, not the exception.**
`colour-meaning.test.ts` holds the Lingon rule by naming the *files* allowed to
use the accent, which is what makes it a rule about two specific things rather
than a budget. Writing the exception as "the landing page may use Lingon" would
have quietly converted it into a budget, because the landing page is several
hundred lines long and the guard would then permit red anywhere in it.

So the exception is a file containing one element. `LandingPrimary.tsx` renders
one anchor, takes no variant, and is named in the guard alongside the trend chart
and the wordmark. Two further assertions keep it honest: the file must contain
exactly one Lingon class and exactly one `<a>`, and nothing inside `/app` may
import it. A second red button has to either appear in that file, where it is
obvious in a diff, or fail the test.

**Contrast, measured rather than assumed.** The exception says nothing about the
text on the button, and a red button with the wrong foreground would be worse
than no exception. Dark text on Lingon gives **4.57:1** on the dark theme and
**5.92:1** on the light one, both above the 4.5 needed at 15 px. It works on both
because the token flips with the theme: Lingon darkens to `#B0203C` in light mode
while the text lightens with `--paper`.

#### The rest of the page

**Figure cards with icons**, in the style of postliminalsystems.com's capability
cards. The colours come from the profile's semantic map and not from what looks
good together: Gran carries the taps because Gran is logging, Honung carries the
price because Honung is money and rewards, Is carries the one about where the
data sits because Is is secondary data. A fourth card would need a fourth area to
belong to, and there is not one, which is the map doing its job rather than
constraining it.

**Icons on every footer link**, not on the support button alone. One decorated
link in a row of plain ones reads as the important one, and it was not: the
repository and the licence are the two that back up what the page claims. The
footer also gains the privacy link the page was missing, pointing at the section
that was already there.

All the icons are drawn here, on a 24 unit grid at stroke width 1.75. **One
exception, and it is a judgement call worth naming:** GitHub's mark stays filled.
It is a brand mark rather than a drawing, it is recognised as a shape rather than
read as a picture, and an outlined redraw is both less recognisable and, strictly,
not their mark.

That does mean **revising a detail of D97**. The beer mug was taken from
formulaspun path for path so the same link from the same person would be
recognised in both places. It is now redrawn as a line icon: the idea and the
glyph are the same, but a filled mug in a row of four line icons was the one
thing in the footer that looked pasted in. GitHub keeps its logo because it is a
logo. The mug was never one.

#### The copy rules, and the guard they were missing

Every paragraph is now a bold lead-in and then its sentence, so the page can be
read by lead-ins alone and still say the same thing. It was already the shape of
"Så räknar den" and turned out to be the shape the whole page wanted. Emphasis
appears nowhere else: a bold phrase mid-paragraph is a second voice arguing with
the first, and once there are two the reader trusts neither.

No semicolons. A rule about rhythm rather than grammar — a semicolon joins two
clauses that could each stand alone, which on a page read by somebody deciding
whether to trust it means two claims arriving as one. Split them and each gets
its own weight. It also removes the punctuation mark most likely to end up alone
at the start of a line at 360 px.

**And §5's rules now actually run against this page.** The dash and sentence-case
checks covered `i18n/sv.ts` only, which meant the one surface a stranger reads
before anything else was the only one they had never been applied to. The landing
page ships without the dictionary on purpose (D90), so `landing-copy.ts` reads
the strings out of the JSX instead. That is less tidy than iterating a dictionary
and it is the right trade: the alternative on offer was pulling `sv.ts` into the
landing bundle to make it testable, which would have traded a real property for a
convenient one.

Two acronyms joined the allowlist, `NNR` and `AGPL`, because the page names them
and neither is the app raising its voice.

---

### D100 — The admin API gets its screens, and the unlinked route stops pretending to be a defence

D95 built ten admin endpoints with tests. `Admin.tsx` called two of them. The
other eight were reachable only by `curl`, and the pass that added them recorded
them in STATE.md as though they were an interface. D95 now carries a correction
saying so, and CLAUDE.md §7 carries the rule that came out of it.

This is the interface.

**Seven tabs, in the query string.** `?vy=konton`, the shape Data uses since D92:
a tab you can link to, return to, and leave with the back button doing what it
looks like it does. One long column would have put the audit log a minute of
scrolling below the invite requests on a phone.

**The render tests assert data, not mounting.** `routes.test.tsx` proves a route
is not blank, which is the right bar for a screen somebody opens daily. These
are the opposite case: "the admin page renders" was true for the entire period
it showed none of what D95 built, so each test here pins a value from the stubbed
response into the document. A tab that mounts and shows nothing fails.

**Deletion still states its consequences**, which was D95's intent and is now
actually on screen: the counts come from `previewDeletion`, fetched when somebody
starts a delete rather than guessed by a dialog, and the confirmation names them.
You cannot delete the account you are signed in as, because the cascade would
take the session doing the deleting and the screen would come back as a 404 with
no explanation.

**Revoke appears only on unused codes**, and the reason is stated once above the
list rather than on each of twelve used rows. Twelve identical sentences down the
right-hand side reads as though something were wrong with each of them.

**Retry appears only on what has actually stopped.** A pending row is already
going to be tried again, and a retry button on it invites a second send of
something that had not failed.

#### Amending D89: the link's absence protected nothing

D89 left `/admin` unlinked, on the grounds that "a non-admin has no business
learning these endpoints exist". That reasoning is sound for the **404** and
wrong for the link. `/app/admin` is a route in the JavaScript bundle every
account downloads: anyone curious enough to read it finds the path in seconds,
and anyone not curious was never the threat. What the absence actually cost was
the owner having to remember a URL.

So the entry is in the Mer sheet, for admins, and **the 404 stays exactly as it
was**. `requireAdmin` still reads the flag from the database on every request and
still answers 404 rather than 403. `me.isAdmin` now rides on `/me` so the
navigation can decide during the first paint, and it authorises nothing: it
decides whether a link is drawn, and the server decides everything else. That
distinction is the one worth keeping — hiding a control is tidiness, and the
refusal behind it is the security property.

Rejected: putting Admin in the bottom bar. Four destinations is the right number
for a thumb (D53), and an admin opens this a few times a year.

**Every entry in that sheet gained an icon**, not the two the brief named. A
sheet where half the rows carry one reads as unfinished rather than as emphasis,
and they are the stroke set the sidebar already uses.

---

### D101 — The copy rules read the markup, and a dash stops standing in for a value

Two halves of §5, both of which had a hole nothing was looking through.

**The dash rule only ever read the dictionary.** `copy-style.test.ts` iterated
`i18n/sv.ts`, which is where the app's copy is supposed to live, so a string
typed inline in a component was invisible to it. `Correlations.tsx` rendered a
date range as `{from} – {to}` with a real en dash in the markup, on a screen that
had been screenshotted repeatedly, and no test could see it. It was found by
looking at a picture.

The guard now reads every `.tsx` under `src/`, with the same rule. Run against
the tree it finds **no dashed clause**, which is last pass's fix holding rather
than an empty result: the extractor asserts it found something before it asserts
it found no offenders, because a guard that has silently stopped reading looks
exactly like a guard with nothing to report.

The extractor is conservative in one direction only. A technical string that
slips through is a false failure, noticed at once; a piece of copy filtered out
is merely unchecked, which is where all of it already was.

**And a dash is not an empty value.** Seven places used `"—"` where the app did
not have a number: the trend weight before there are readings, a height nobody
entered, and four service-worker facts the browser had not reported.

§3 is explicit that absent is not zero and that this app says what it does not
know. A dash says nothing at all, in the one place where saying nothing is the
thing the whole design is against — and it says it in the register of a spec
sheet, which is the opposite of the notebook this is supposed to read like.

Each is now either **"Inte än"**, which is the app's own phrase and was already
the idiom two stats to the left on the same screen, or **the specific reason**.
On the diagnostics screen the specific reason is the more useful half:
"BarcodeDetector saknas i den här webbläsaren" answers the question a dash
raises, and "ingen registrering" says why a scope is blank.

The trend figure needed one extra thought. Its unit sits beside it, and "Inte än
kg" is not a thing anybody says, so the unit is now inside the branch that has a
number: a lone "kg" under a missing figure reads as a value that failed to load.

Both checks are proved by reintroduction, like the colour guard, because "no
offenders" is the same output as "not looking".

---

### D102 — Mail settings move into the database, and what encrypting them does and does not buy

D94 said deployment modes live in the environment and are never a toggle in the
admin UI. That still holds for `LANDING_ENABLED` and `LLM_ENABLED`: those decide
whether a feature exists at all, and a switch an admin session can flip is a
switch anyone who reaches an admin session can flip.

Mail is a different shape of thing, and treating it as a mode was the mistake.
It is not "does this feature exist", it is **a connection to somebody else's
server** — a host that changes when a provider does, a password that rotates, a
port that depends on whether they want STARTTLS or implicit TLS, and a failure
mode whose diagnosis is a string from their server that the operator needs to
read. None of that belongs in a file you have to open a shell to edit and
restart a container to apply.

So the settings are a row, edited under Administration, Mejlserver.

#### What the encryption buys, exactly

The password is stored encrypted with a key that stays in the environment as
`SECRET_KEY`, or in the file `SECRET_KEY_FILE` names for Docker secrets. Three
things follow, and they are worth stating precisely because this is the kind of
claim that grows in the retelling:

- **One secret in the environment instead of four.** `SECRET_KEY` replaces
  `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` as the things an
  operator has to get into a container.
- **Editing and testing from the interface.** Changing mail servers stops being
  an edit on the host followed by a restart, and "does it work" stops being a
  question you answer by triggering a password reset and waiting.
- **A database dump that does not contain the mail password in clear.** D96's
  backup goes to a destination read by whoever can read that destination. This
  is the difference between a leaked dump costing the mail account and not.

#### What it does not buy, stated because it is what gets overclaimed

**This does not make the install secretless.** `SECRET_KEY` is a secret in the
environment, exactly like `SESSION_SECRET` and the database password. Anyone who
can read the environment of the running process can decrypt everything it
protects. It defends a dump **at rest** and nothing else: an attacker with the
environment has the key, and an attacker with only the database has ciphertext.
That is a real and narrow improvement, and calling it anything more would be the
kind of security theatre that makes people stop reading these entries.

`assertProdSecrets` covers it. Not as a required secret — an install with no mail
server and no backup destination needs no key and should not be refused a boot
over one — but checked whenever present, with a minimum length, because a
four-character key produces something that looks encrypted and is not, and that
failure is invisible. Setting both `SECRET_KEY` and `SECRET_KEY_FILE` is refused
too: the file wins, so a stale variable beside it decrypts nothing while looking
configured.

#### The details that are decisions

**AES-256-GCM, keyed per use through HKDF.** The `use` string is a domain
separator, so a value encrypted for the mail password cannot be read by the code
that reads a backup destination: a bug that crossed the two would otherwise
decrypt cleanly and be invisible. GCM's tag means a tampered value is refused
rather than half-decrypted.

**A missing key is not a wrong password.** `mailerConfig` returns null when it
cannot decrypt, and the screen says the key is gone. Building a transport with a
password it failed to read would produce an SMTP authentication error blaming
the operator's mail account for something that happened in this process.

**Write-only, end to end.** The password is not in the settings response, not in
the audit row, and not in the form. Omitting the field means keep it; clearing
it is an explicit checkbox, because an empty field is what you get by not typing.

**Three named security modes, not nodemailer's boolean.** `secure` means implicit
TLS from the first byte, and reads as "is this secure at all", which is how
somebody ends up sending a password in clear while believing the opposite.
`starttls` sets `requireTLS`, not the opportunistic default, so a server that
does not offer STARTTLS fails rather than silently downgrading.

**The test button sends only to the signed-in admin.** A recipient parameter
would be an open relay wearing a diagnostic hat, reachable by anyone who reached
an admin session. It sends **inside the request**, which D88 otherwise forbids,
and the exception is deliberate and one endpoint wide: D88's rule exists so a
user-facing request never waits on SMTP, and this is a person deliberately asking
whether the server they just configured works. An answer delivered through a
queue drained thirty seconds later by a worker that may not be running is not an
answer.

**Every change writes an audit row.** Whoever controls the SMTP server receives
every password reset this app sends, which makes this the single most
consequential line the log will ever hold.

#### Migration

On the first boot after this, `SMTP_*` is imported into the table once, logged at
warn level with an instruction to remove the variables, and never read again. An
operator upgrading should not have their mail stop because the settings moved.
The old `SMTP_SECURE` boolean maps to implicit TLS and its absence to STARTTLS,
reproducing the behaviour they already had rather than a weaker one.

`describeModes` no longer decides whether mail is on. It takes the answer from
the mailer, because it cannot read the database and should not learn to.

**The migration is hand-written**, like every one since 0008. `drizzle-kit
generate` emitted a file recreating every table added since then, because the
snapshot chain in `meta/` has gaps and it diffs against the newest snapshot it
can find rather than against the database. Applying it would have failed on the
first `CREATE TABLE`. That is STATE.md's own drizzle gotcha, met again.

---

### D103 — The backup schedule D96 wrote and never installed

#### What existed before this pass, stated first

- `infra/backup.sh`: `pg_dump -Fc` plus a tar of the uploads volume, retention by
  age, `.partial` until complete. Written in the D96 pass.
- `infra/restore-check.sh`: restores into a generated scratch database, compares
  row counts and the §4.1 inputs, drops it on exit.
- `docs/backup.md`: where they go, how long they are kept, the restore.
- **A restore that was genuinely performed**, in the D96 pass: dump, fresh
  database, `pg_restore --no-owner`, then row counts and derived inputs compared
  against the live database and found identical.
- **No schedule.** The cron line lived in a comment at the top of the script.
  Nobody ran `crontab -e`. STATE.md said so under "do this next", for two passes.

So: the mechanism was built, documented and rehearsed, and it had never taken a
backup that somebody did not personally start. A backup script nobody scheduled
produces no backups, and this is the second time in three passes that the gap
between "built" and "actually running" is the thing that mattered.

#### What this adds

**The schedule is in the app.** One time of day, ticked once a minute, skipping
while a run is in flight. Not a cron expression: the schedule is one time, and a
parser plus a timezone argument plus its own tests would be machinery for
something nobody asked for. A schedule inside the thing being backed up starts
when that thing starts, which is the whole point — there is no second step to
forget.

**Every run is a row, successful or not.** A backup system that records only its
successes shows green on the morning the disk filled up. The row is written
*before* the work starts, so a crash mid-dump leaves a `running` row rather than
no evidence.

**The dump is encrypted before it is written.** Not encrypted after: the
plaintext archive never exists as a file. `VIKTBK1`, a 12-byte IV, the AES-256-GCM
ciphertext, and the tag appended at the end. The tag being at the end and checked
before a byte is written on the way out means a truncated backup fails loudly
instead of restoring most of a database, which is the property worth having. It
uses its own HKDF `use` string, so the key that reads a backup cannot read the
mail password.

With no `SECRET_KEY` the run **refuses** rather than writing plaintext. An
unencrypted copy of every user's data leaving the machine by accident is worse
than no backup, because it is invisible.

**`pg_dump` moves into the API image.** D96's script ran
`docker compose exec postgres pg_dump`, which the API container cannot do: it has
no docker socket and should never have one. The dump is taken over the ordinary
Postgres connection instead, so `postgresql-client-16` is installed in the
runtime image — pinned to 16 because pg_dump refuses a server newer than itself,
and that is a failure only ever discovered during a restore.

**Download is admin-only and logged.** It is the one endpoint that hands a copy
of every user's data to a browser. The file is encrypted, which is what makes
offering it reasonable at all.

**Restore is not a button and will not be.** It is `infra/backup-decrypt.mjs`
followed by `pg_restore`, documented in `docs/backup.md`. Restoring is the single
operation that destroys a live database by succeeding, and a button four pixels
from "run now" is not the right shape for it. An interface cannot ask "are you
certain" in a way that survives being asked twice a year.

#### The boundary, named rather than implied

**Only a `local` destination is implemented.** SMB and S3 are in the settings
enum, because that column is what would have to change to add them and a
migration later is worse than a value refused today. The service **refuses them
with a reason** rather than accepting the setting and silently doing nothing.

That is a deliberate stopping point, not an oversight, and it is written here
rather than left to be discovered: SMB from Node means a client library with a
poor security record, and S3 means either an AWS SDK or a hand-rolled SigV4
implementation, and shipping either badly would be worse than the local
destination plus an honest boundary. The encryption is already in place, which is
the part that has to be right before a backup leaves the host at all, so adding a
destination later is an adapter rather than a redesign.

#### The restore, this pass

The encrypted format was proved end to end on the development machine: a real
`pg_dump -Fc`, encrypted with the service's parameters, decrypted by
`infra/backup-decrypt.mjs` to a byte-identical archive, restored into a scratch
database, and the derived inputs compared against the live one — mean, min and
max weight to four decimals, reading count, date range, intake sum, food-entry
and daily-log counts, all identical. The scratch database was dropped.

What could **not** be proved here is `runBackup` spawning `pg_dump` itself: it is
not on the Windows host's PATH, only inside the postgres container. That is a
property of this development machine, and it is exactly why the Dockerfile change
above exists. On this machine a run fails with
"pg_dump could not be started … It has to be on PATH in the API image", which is
the error path working.

---

### D104 — The queue nobody drained, and why liveness had to become visible

Two invite mails sat in `outbound_email` with `status: pending` and
`attempts: 0`. Zero attempts is the whole diagnosis: nothing had ever tried to
send them.

**Diagnosed before anything was changed**, against the three candidates:

- **Does the worker run?** No, and it could not. `pnpm --filter api mail:worker`
  was in the README, no process was running it in development, and
  `infra/docker-compose.yml` has three services — postgres, api, nginx — and no
  worker. In production nothing would have drained the queue either. **This is
  the cause.**
- **Does it read SMTP from the environment while the settings live in the
  database?** It did before D102 and does not now: it builds its mailer from the
  settings table and re-reads on every tick. Not the cause, and it would have
  been a week earlier.
- **Does the test button bypass the queue?** Yes, deliberately (D102). That is
  why every visible signal said mail worked: the one button that gives feedback
  is the one that does not use the queue.

#### The drainer moves into the API

D88 made it a separate process for a good reason and did not arrange for that
process to exist. Its rule is that **a request** must not wait on SMTP, and an
interval timer is not a request: nobody is blocked on it, and a hung send delays
only the next tick. What the separate process bought was isolation the app never
used; what it cost was existing.

A self-hosted single-instance app should have one thing to start.
`MAIL_WORKER_IN_PROCESS` defaults on, and the CLI worker refuses to run beside
it, because two drainers on one queue send a password reset twice and the second
copy arrives looking exactly as valid as the first.

Rejected: adding a worker service to compose. It is one more container to
explain, one more thing to forget when self-hosting, and it would not have fixed
development, where the queue was equally dead.

#### The part that matters more than the fix

**"Väntar" and "nothing is running" looked identical.** The admin screen showed
two pending messages, which is exactly what a message waiting its turn looks
like, and there was no signal anywhere that distinguished a queue being worked
from a queue being ignored. It took an hour and a person noticing that a
delivered test mail and an undelivered invite mail were inconsistent.

So there is a `worker_heartbeat` row, written on **every** tick including the
empty ones — a heartbeat that only appears when there is work cannot answer "is
anything running" — and the mail screen shows the last tick, the count sent
since start, and the last error. A stale heartbeat beside pending messages says
so in a sentence naming the flag to check.

#### The test that was missing

`mail-queue.test.ts` covered `drainMail` and passed throughout. It was not
wrong: the function worked. What was missing was **anything calling it**, which
no test of that function can catch. `mail-drainer.test.ts` tests the layer above,
and its first case is the one the brief asked for: a queued message is *sent*,
not only enqueued.

Confirmed on the live development database: both stuck messages went out on the
first tick after the restart, `attempts` 1, `sent_at` set.

#### One instance, and that is a constraint with a name (added with D109)

The drainer runs **in the API process**. That is what made a queued message
finally send, and it is also a limit on how this can be deployed: a second API
replica would run a second drainer, neither would know about the other, and
**every message would go out twice**. There is no lock.

A single API instance is therefore the supported deployment until one exists.
Written down here rather than left implicit, because the failure is invisible
from inside the app — nothing errors, nothing is logged, and the first report
comes from somebody who got the same invite code twice. The rate limiters and the
human check's replay set (D112) are in-memory per instance for the same reason
and would degrade the same way.

---

### D105 — Onboarding is the empty state, not a flow

Registration asks for what creates an account: an invite code, a name, an email,
a password twice, and consent. Height is none of those, and it left the form.

**Nothing in this app is needed to log.** Weighing yourself needs a scale.
Logging food needs a search box. Height, a birth date and a goal are inputs to
*calculations* — BMI, waist-to-height, the formula maintenance figure, a
projection — and every one of those already says exactly what it is waiting for,
because D20 made "missing" a first-class answer rather than a zero.

So a registration form that demanded height was asking somebody to find a tape
measure before they could see the app at all, in order to make a number
computable that they had not asked for and might never look at. The screens ask
for what they need, where they need it, at the moment the person is looking at
the thing it would improve.

`profiles.height_cm` is nullable. Every consumer was **verified rather than
assumed**, which is the part worth writing down: "already handles it" was true of
the code and was a claim about a state nobody had run.

- `bmi()` and `whtr()` take `number | null` and return null. Unchanged.
- `mifflinStJeor` pushed `heightCm` into `missing` for any non-finite value, so
  null already behaved correctly at runtime; `TdeeProfile.heightCm` widens to
  `number | null` to say what the check already did.
- The milestone units read the metric, not the profile, so they never touched it.
- The dashboard's height stat says "Inte än" and dims, which is the idiom two
  stats to its left were already using (D101).

#### The welcome card, and why it is not a wizard

Three links, once, dismissible, and gone by itself when all three are done. It
exists because the empty states are individually quiet by design, and on a
completely empty account "quiet everywhere" gives no first step. It names three
and then leaves.

**No forced steps and no checklist that follows you around.** A wizard is a
statement that the app is not usable until it has been satisfied, and this one
is: an account with nothing in it can log a weight and a meal immediately, which
is the whole product.

Dismissal is `localStorage`. It is a per-device preference about a piece of
guidance, it authorises nothing, and a migration plus a write path for "I have
seen the welcome card" is more machinery than the thing is worth. It is the same
reasoning as the cached identity in `session.ts`: a fact that does not go out of
date between one morning and the next.

**The test factory sets a height by default**, because most tests want figures
that compute and saying so in each of them would be noise. `heightCm: null` is
how a test asks for an account exactly as a real new one is, and six API tests do.

---

### D106 — Privacy and terms become pages, and what those pages are not

The privacy text was a five-item list under the invite form on the landing page.
It was true, and it covered about a third of what a service other people use has
to say. What was missing was everything that matters once somebody else's data is
on the server: who is responsible, what is stored, why weight is treated as
sensitive, who else ever sees anything, how long it is kept, and what a person
can actually do about it.

`/integritet` and `/villkor` are pages now.

#### Served without a router

Both are the landing bundle, switching on `window.location.pathname`. nginx maps
each with a `location =` block, and vite does the same in dev and preview so the
three servers agree.

**No router**, and that is the same decision D90 made for this bundle: three
static pages that never navigate between each other without a full load do not
need a history stack, a link component and a context provider. There is also
still no SPA fallback here, so an unknown path is a 404 rather than the landing
page pretending every URL exists.

#### What the privacy page has to have

**Every right names the thing in the app that fulfils it.** A page that says "you
have the right to erasure" and then makes you write an email has described a
right rather than given one. See is the Data screen, take is the export in
Inställningar, delete is the self-service deletion D107 adds, and only "rätta
något the app cannot" falls back to an address.

**Weight and body measurements are named as sensitive**, because they are: they
are handled here for a health purpose, which makes them health data, and that is
the reason D107's consent is explicit rather than inferred. Saying so on the page
is what makes the checkbox mean something.

**The mail provider is named as the one third party that sees anything**, and
what it sees is the address and the message. Nothing logged is ever mailed.

#### They are the owner's text, and they say so

Both pages end with a line saying they were written by the person running the
service and are not legal advice. That line is not a disclaimer in the legal
sense and is not trying to be one; it is there because a page in this register,
laid out like the rest of the app, could otherwise read as having been reviewed
by somebody it was not.

**The privacy page must be reread when the coach chat ships** (§6 phase 8b). Chat
history is a new category of stored personal data, held per user under D9, and
the page will be wrong the day that lands. It is listed under "Om coachen slås
på" today, in the future tense, which is honest now and becomes a lie on release.

Rejected: a cookie banner. The app sets one cookie, it is the session, it is
strictly necessary, and there is no analytics, no embed and no third-party
script anywhere. A banner would be theatre.

---

### D107 — Consent is explicit and dated, and leaving needs nobody's permission

Two halves of the same thing: agreeing to store somebody's body data, and
letting them take it back.

#### Consent

**A timestamp, not a boolean.** A boolean says whether; the question anybody ever
asks is when. It is also the shape that survives the text changing, because
consent recorded before a rewrite is consent to the old words and the date is
what says so.

**`z.literal(true)`, not `z.boolean()`.** A request that omits consent, or sends
false, fails validation rather than registering somebody who never said yes.
Health data is the one thing that must not be agreed to by implication, and a
boolean that defaults to false and is silently ignored is exactly that.

**Accounts created before the column are asked once, on next sign-in**, by a gate
in front of the app rather than a notice beside it.

That gate is the only blocking screen in an app whose §3 says nothing nags, and
the exception is deliberate: continuing to store somebody's weight without asking
is the position the checkbox exists to avoid, and asking politely at the bottom
of a settings page is asking in a way designed not to be answered. It offers the
two honest exits — read the text first, or sign out — so nobody is trapped and
nobody agrees by scrolling.

#### Leaving

Self-service deletion in Inställningar, with the three properties the admin
deletion has (D95), because it is the same cascade and a person should not get a
worse version of it than an operator does:

- **It states its consequences first**, from `previewDeletion`, so the
  confirmation says "84 vägningar, 113 matrader" rather than "delete account".
- **It offers the export in the same panel.** The moment somebody decides to
  leave is the only moment they will think to take their data, and a link they
  have to go and find is a link they will not find.
- **It asks for the password.** This is the whole security of the feature. A
  session cookie is enough to read and write, and it must not be enough to
  destroy: a borrowed phone, or a session left open on a shared machine, should
  not erase a year of somebody's logging in one tap.

Two ordering decisions in the service, both about what cannot be undone:

**Photos go first, outside the transaction.** Files on disk cannot roll back.
Removing them before the row means the worst case is a deleted photo whose
account survived a failed transaction, which the user can see and re-upload. The
other order's worst case is an orphaned directory of somebody's body photos on a
server they believe they have left (D10). Phase 7 has not shipped, so the route
passes a no-op today and the parameter is what makes the gap visible.

**The audit row is written before the delete.** `actor_id` references `users` and
that row is about to be gone; `actorEmail` is the snapshot that keeps the entry
readable, which is exactly what D95 built it for and this is the first case that
actually exercises it. The action is `account.self_delete`, distinct from
`user.delete`, because who acted is the difference between the two.

Rejected: a grace period with reactivation. It means keeping everything for
thirty days after somebody has asked for it to be gone, which is the opposite of
what they asked, and the export already covers the case of changing your mind.

---

### D108 — Announcements, and why in-app is the primary channel

Maintenance now, news later, one table.

#### In-app first, and the reason is the offline queue

**A planned outage stops nobody from logging.** Writes go to IndexedDB and sync
when the app comes back (Phase 6). That is the single most useful thing to tell
somebody about a maintenance window, and it reaches the right person only when it
sits in the app they are holding, next to the thing they were about to do.

An email arrives in an inbox somebody may not open until after the window has
closed. So mail is optional per announcement, and the banner is not.

#### The shape

`kind` is `maintenance`, `news` or `notice`. Maintenance has a window and a lead
time; the other two have neither.

**`leadMinutes` is per announcement, not a constant.** A two-minute restart and a
four-hour migration do not deserve the same warning, and a banner that appears a
day early for a five-minute outage is a banner people learn to dismiss without
reading. It shows from `leadMinutes` before the start until the end, and **not
after**: an outage that is over is not news.

**The body is optional, and for maintenance that is the point.** Left empty, the
default sentence is rendered from the window **client-side, in the reader's own
timezone**. The server knows the instant; only the browser knows which hour to
say it in, and a window announced in the server's idea of time is how somebody in
another country reads the wrong one. It is the same principle as §3's rule about
day boundaries.

**One table for dismissals and reads**, because they are the same fact: this
person has seen this version. `seenVersion` holds the announcement's `updatedAt`
at the moment it was seen, so an edit moves `updatedAt` past it and the thing
comes back. That makes "reappearing if the announcement changes" a property
rather than a promise, and it means a window that moves is a new thing to be told
rather than one already silenced.

#### No accent colour on a maintenance notice

§5 gives a colour to an *area*, and planned maintenance is not one: not the
trend, not something logged, not money, not nutrition. It is also not a failure,
and §3 is explicit that this app has no failure state — a red banner would make
one out of a Tuesday evening restart that costs the reader nothing. Sten and Snö
on the card surface, like every other quiet thing.

The unread marker on Mer is a **dot, not a count**. The number is never large
enough to be information, and a badge with a number in it is the shape of an app
that wants attention rather than one that has something to say. It is Gran,
because it marks a thing to look at rather than a problem.

#### Mail, and the one thing that is not opt-out

**News respects the opt-out. Maintenance does not.** Maintenance concerns the
service somebody is using, and an outage nobody was told about is the failure
this whole feature exists to prevent. News is something they might find
interesting, which is a different kind of thing entirely. `/integritet` states
both, in those words, because a mail somebody cannot turn off deserves to be
declared rather than discovered.

`mailedAt` is the guard against sending twice: a second publish, or an edit, does
not re-mail. Everything goes through the outbound queue (D88, D104), never sent
inside the request, because a publish that waited on SMTP for every account would
be the slowest request in the app by two orders of magnitude.

#### News never interrupts

Feature announcements go to `/app/nyheter` and never appear on the dashboard. The
dashboard is where somebody looks to find out how they are doing, and a notice
about a new screen sitting above their trend line is the app talking about itself
in the one place that is supposed to be about them. Opening the page marks
everything on it read — no per-item button, because a list of two-sentence items
with a "mark as read" control on each is a chore invented by software.

### D109 — Every link in every email is absolute, and the test button goes through the queue

An invite was approved, the mail was queued, the queue said sent, and the
recipient got a registration link reading `/app/register?kod=3F7K-9QMT-2XBW`. No
mail client can open that. There is no base to resolve it against once the text
has left the browser, so it renders as a fragment of a path, and the code it
carried was unusable. Nothing failed anywhere: the service built the link, the
template interpolated it, the transport delivered it, and the person on the other
end got a dead string.

#### One place that knows where this installation is

`PUBLIC_BASE_URL` is now configuration, and `apps/api/src/lib/links.ts` is the
only place that turns a path into a link. `linkTo(env, "/app/register", { kod })`
either returns an absolute URL or **throws**. It does not fall back to a relative
one, because a relative one is what shipped.

`PUBLIC_ORIGIN` is still read as a fallback so an upgrade does not silently lose
every link, but the new name wins where both are set. `assertProdSecrets` refuses
a value that is set and not absolute, which turns "somebody put the hostname in
without a scheme" into a boot failure rather than into a week of dead invites.

The registration page reads `?kod=` and prefills the field, and says that it did.
A code that arrives in a link and then has to be retyped from the address bar is
a link that only half works.

`mail-templates.test.ts` asserts the property directly: every `/app/` path in
every template's text, and every `href` in every template's HTML, is absolute.
That test would have failed on the mail that went out.

#### The test button was proving the wrong thing

The admin's "send a test" built a message and handed it straight to the
transport. That is why a working test button coexisted with a queue nothing
drained (D104): the test never touched the queue, so it proved SMTP worked and
nothing else, which is precisely the half that was not broken.

It now queues the message with `priority: 0` and drains once, synchronously, then
reports the row's status. A delivered test now proves the transport, the queue,
the drainer and the templates together. `outbound_email` gained a `priority`
column and the drainer orders by it, so the test overtakes a backlog instead of
waiting behind it.

#### One instance, and that is a supported deployment, not an accident

The drainer runs inside the API process (D104). **A second API replica would
double-send**, because both would run a drainer and neither knows about the
other. There is no lock. A single instance is therefore the supported deployment
until one exists, and this is written down rather than assumed so that scaling
out is a decision somebody makes rather than a surprise somebody's inbox
discovers. The rate limiters and the ALTCHA replay set (D112) carry the same
caveat for the same reason.

### D110 — Email is designed light, and that is not a preference

The app is dark. The mail is not, and will not be.

**Gmail inverts colours in dark mode.** It applies its own transform to what it
decides is a light design, and a design that is already dark comes back inverted
into something nobody chose. There is no reliable way to opt out across the
clients that do it. **Outlook drops most CSS**: its Word rendering engine ignores
background colours on divs, most positioning, and anything in a `<style>` block,
so a dark design there is dark text on the white it falls back to.

Between them that is most of any real recipient list. A light design degrades to
black on white, which is legible everywhere. So the profile's **light variants**
(page 4) are what the mail uses: Papper `#EDF1F2` behind, Skymning `#16232B` for
text, Sten for the footnote, Dis for the rules, and the wordmark "Vikt" in Lingon
`#B0203C`.

**The wordmark is the word, set in text.** Not a logo file. Nothing loads from
anywhere, which means nothing can log an open, which means there is no tracking
pixel whose absence has to be promised. The footnote says so in the mail itself.

**Tables and inline styles**, not because of nostalgia but because Outlook has no
flexbox and no grid and Gmail's web client strips `<style>` blocks on forwarded
mail. Archivo and Inter are named first in the font stack and are not loaded: a
webfont in an email is an image request by another name.

**The plain-text alternative stays and is still the message.** Every template
writes its text first and the HTML is that text laid out.

#### Escape first, then linkify

The first version made an anchor only out of a block that was *nothing but* a
URL. The invite mail's "Skapa kontot här:" followed by the URL on the next line
is one paragraph, so the single most important link in the whole system rendered
as text somebody had to select and copy. Found by looking at it, not by a test.

Now every URL anywhere in a paragraph becomes an anchor, and the order is the
security property: the text is escaped into HTML first, and the anchors are built
from the escaped string. No template interpolates markup and none ever should,
but the escaping must not depend on that staying true.

### D111 — The rule under a heading is as wide as the heading, and the pages stop shouting

#### A fixed rule cannot be right for two headings

The rule under every section heading was `w-16`: four rems, the same under all of
them. Under "Om AI" that is wider than the words and reads as an underline, which
is the one thing a heading must not look like. Under "Vad som lagras och varför"
it stops a quarter of the way across and reads as a fragment. One length cannot
be right for both.

`RuledHeading` takes its width from the text, with no measuring and no
JavaScript: the words sit in a shrink-to-fit box and the rule is positioned to
that box's edges. It is **absolutely positioned** rather than a block underneath,
so it takes no height — otherwise it lands inside the flex row and pushes the
section icon down by half its own height relative to the text it is meant to sit
beside. When a heading wraps to two lines the box becomes the column and the rule
spans it, which is still the width of the heading.

Shared by the landing page and both text pages, which had the same helper written
out three times.

#### Twenty-five bold lead-ins are a texture, not emphasis

Every paragraph on the landing page, /integritet and /villkor opened on a bold
lead-in: a short bolded sentence, then the sentence explaining it. Twenty-five of
them down one page and twenty-one down another, and it stops being emphasis. The
eye reads the bold line and skips what follows — which on a privacy page means
skipping the part that says what actually happens, because the bold half is
always the claim and the plain half is always the qualification.

Plain paragraphs in Sten now, hero subline included. The lead-in sentences were
**kept, unbolded**, as each paragraph's first sentence, which is where they were
doing the work. The copy guard was inverted to match: it used to assert that a
`<strong>` was only ever a paragraph's first child, and now asserts there is no
`<strong>`, `<b>`, `<em>` or bold class on any of the three pages.

#### A figure the page has no right to state

"100 % av din data ligger på din egen server" is true for a reader who
self-hosts and false for a reader using an instance somebody else runs. The page
cannot tell them apart, so it must not say it.

What is true either way is the number of third parties that see a measurement,
and that number is **0**, with "tredje parter som ser dina mätvärden" under it and
one line beneath saying the mail provider sees an address and never a
measurement. Each such card now names, in a `source` field, the sentence on
/integritet it condenses, and `landing-figures.test.ts` checks that sentence is
still on that page word for word. A summary that outlives what it summarises is
exactly how the old card survived.

"0 kr att använda, och koden är öppen" became "källkoden är öppen". "Koden" on a
page about an app reads as the invite code two sections below it.

### D112 — A human check that keeps the page's own promise

The invite form had a honeypot and a rate limit. Neither costs a caller anything,
and the form causes mail to be sent, so it wanted a third guard.

#### ALTCHA, and why not the obvious ones

/integritet lists every party that sees anything, and the landing page says
nothing leaves the server. A reCAPTCHA or an hCaptcha would make that list longer
in the worst possible way: an advertising company told the address of every
visitor who asked for an account on a **weight-tracking app**. Turnstile is
better on that axis and is still a third party on the one page where the claim is
being made.

ALTCHA is proof of work, self-hosted. This server issues the challenge, the
browser finds the number that hashes to it, this server checks the answer against
its own HMAC. Nothing is fetched from anywhere, no cookie is set, and there is
**nothing to click**: the work happens inside the submit the visitor already
pressed. Measured end to end through the page at 360 px: 264 ms from press to
"tack, din förfrågan har kommit fram".

The fallback the brief allowed — Turnstile, declared on the privacy page — was
not needed and is not present. There is no third party to declare.

#### What it is, and what it is not

It is a **cost, not an identity check**. Someone determined to submit a thousand
requests can pay the CPU for a thousand requests. What it stops is the cheapest
and commonest thing: a script that posts to every form it finds, which runs no
JavaScript and cannot produce a signature.

So the three **stack** rather than replace each other, and each fails
differently: the honeypot catches the bot that fills every field, the rate limit
caps volume, and this makes every attempt cost something. The honeypot still
answers 200, because telling a scraper it was caught teaches it how not to be.
The human check answers **400 out loud**, because a person whose challenge
expired while they were writing needs to know to press the button again.

`maxnumber` is 20 000. Measured with the real solver: 133 ms at 10 000, 162 ms at
20 000, 466 ms at 50 000, and a phone is a few times slower again. Raising it
does not buy much — an attacker's cost and a visitor's cost rise together, and
the visitor has the slower device. Volume is the rate limit's job, not this one's.

A solved challenge is **spent**, in an in-memory set with the same
single-instance caveat as everything else in D109. Without that, one solution
would be worth two minutes of unlimited posting, which is the exact volume the
check exists to make expensive.

The challenge endpoint has its own rate limiter rather than sharing the
submission's. Sharing would mean one honest attempt costs two tokens and "five
requests an hour" would quietly become two and a half. It also **does not exist
where the landing page does not** (D94), like the endpoint it guards: a challenge
route left behind on a private install would be a public route on an install
supposed to have none.

#### And a name

The form asks who is asking. The owner reads these one at a time and decides by
hand, and an address alone is not much to decide on. Nullable in the database,
because every row written before the field existed has none and inventing one
would be a lie, and the admin list leads with the name where there is one and
falls back to the address where there is not.

### D113 — Absolute was the wrong question; reachable is the right one

D109 made every link in every email absolute and added a boot check that refuses
a `PUBLIC_BASE_URL` which is not. The value in the live instance's `.env` was
`https://localhost:5173`, which is absolute, passed the check, and is useless to
every recipient there has ever been. Invites went out linking to a development
server on one machine.

The failure was invisible from every vantage point the app had. The link was
built, the template rendered it, the queue said `sent`, the relay accepted it.
The only way to discover it was to read a delivered message, which is exactly
what happened, twice, for two different reasons.

**So the guard asks the real question now.** In production, a base URL whose host
is `localhost`, a `127.0.0.0/8` address, one of the three private IPv4 ranges,
`169.254/16` or a `.local` name refuses the boot. `isLocalBaseUrl` is a pure
string test with no DNS and no network: it runs before anything is listening and
gives the same answer every time.

**Only in production.** A development instance *should* hold a local address, and
a guard that refused it would be a guard somebody works around rather than one
anybody trusts.

**And the value is on a screen.** Administration, Mejlserver prints the base every
link will be built from, and says so plainly when it is local. That is where
somebody stands when they send mail, and it is the one place the old failure
could have been noticed without opening an inbox. No accent on the warning:
profile page 8 gives this screen none, and §5 is explicit that a colour which
only appears on a bad day builds a failure state.

What is deliberately **not** checked is whether the host resolves or answers. A
hostname pointing at a private address passes this and is caught by reading the
mail, which is what the screen is for.

### D114 — One separator per heading, and a figure that parses

Three landing-page corrections from looking at it, which is where all three of
the previous ones came from too.

#### A rule under a heading with an icon is a second separator

D111 gave every section heading a rule as wide as its own text, which fixed a
stub that read as an underline under short headings and as a fragment under long
ones. It applied the rule to all seven headings, including the four that have an
icon in a tinted square at the start of the line.

An icon in a tinted square already says "a section starts here", loudly. The rule
underneath says it again, quieter, and the pair reads as a page trying twice. So
**the rule is drawn only where there is no icon**: the four capability headings
have icons and no rule, and "Så räknar den", "Om AI" and "Gratis" have the rule
and no icon, because without it they are body text in a slightly larger size.

`RuledHeading` takes a `rule` flag and `Heading` derives it from whether an icon
was passed, so the two cannot disagree.

#### "0 tredje parter" was true and did not parse

The third figure card has now been wrong twice, in two different ways, and the
second wrong is more interesting than the first.

It read **"100 % av din data ligger på din egen server"**, which is true for a
reader who self-hosts and false for a reader on somebody else's instance. The
page cannot tell them apart, so it must not say it (D111).

It was replaced with **"0 tredje parter som ser dina mätvärden"**, which is true
either way and broke the form. The strip is three number-and-unit pairs: "2
tryck", "0 kr", and then a bare zero followed by a seven-word clause. The eye
reads the first two as figures and the third as a sentence that happens to start
with a digit, and the card stopped belonging to the strip it was in.

It is **"1 server"**, with "Där stannar allt du loggar." beneath it. That parses
like its neighbours and is true whether the server is the reader's own or the
owner's, which is the property the first version lacked and the second had.

The sentence about the mail provider seeing an address and never a measurement
is on /integritet, where it already was: "Mejlleverantören ser din adress …
Ingenting du loggar skickas med mejl." The strip's `source` field still pins each
claim to the sentence it condenses, and `landing-figures.test.ts` still checks
that sentence is on that page word for word.

#### The request is one card

"Be om en kod" was a heading, an explanation, a form in a narrower panel, and a
sentence about what happens to the address, stacked down a full-width column as
four separate things. They are one thing: the page's only ask, and the terms of
it.

One centred card holds all four, with the privacy sentence inside it and above
the card's own edge rather than below in the page. **No rule under the heading**,
because the card's border is the separator and a rule inside a bordered box is
the same trying-twice as above. Same treatment as the figure cards, inverted for
its ground: those sit on a Skymning band and are Natt, this sits on the page's
Natt and is Skymning, and `rounded-card` with a Dis border is the constant.

The privacy sentence shows in **both** states, before and after sending. "What
happens to what I just typed" is a question somebody has after submitting as much
as before.

### D115 — One destination list, because two lists drifted and neither could see it

The owner reported that the desktop sidebar was missing things. It was, and the
report understated it, which is why the fix started with an inventory read out of
the running app rather than with an edit.

| | sidebar | bottom bar | Mer sheet |
|---|---|---|---|
| Översikt, Dagen, Mat, Framsteg | yes | yes | — |
| Data | yes | — | yes |
| Nyheter | **no** | — | yes |
| Profil | **no** | — | yes |
| Inställningar | a bare text link in the footer, no icon | — | yes |
| Administration | **no** | — | yes, for admins |
| Logga ut | **no** | — | yes |

So a desktop account had **no way to sign out at all**, because the only one was
in a sheet that is `sm:hidden`. That is four defects, and none of them was
reported as a defect, because from inside either surface everything looked
complete. Two lists maintained by hand will always end up here; the only question
is how long it takes.

**There is one list now.** `DESTINATIONS` holds every place in the signed-in app,
and each entry carries its own placement rules: `inBar` for the four that fit the
phone's bottom bar, `adminOnly` for the one that is conditional. The sidebar
renders all of them, the bar renders those marked `inBar`, and the Mer sheet
renders the rest. **The sheet's contents are derived rather than listed**, which
is what makes the two surfaces cover the same set by construction instead of by
two people remembering to edit both.

Sign-out is an action rather than a destination, so it is not in the list, and it
is appended to both surfaces explicitly.

**The test checks two different things**, because the list being right is not the
property anybody cares about. Against the router: every route rendered through
`signedIn(...)` is in the list, so adding a screen fails until it is listed.
`/diagnostik` is the one exemption, named and explained — it is a probe for the
BarcodeDetector path on a real phone, not a place. Against the rendered document:
the sidebar draws the same set the bar and sheet draw between them, for an admin
and for an ordinary account. Proved by removing a destination and watching it
fail with the route named.

**Inställningar gets a gear.** The old icon was a circle with eight rays around
it, which is a sun, and a sun beside "Inställningar" reads as a theme toggle.
That misreading was about to get much worse, because D117 puts the theme choice
on the screen behind it: the icon would have named one setting on a page of
settings.

### D116 — Installing is offered where installing is possible, and nowhere else

The PWA has been installable since phase 6 and the app has never once said so.
The only route in was the browser's own menu, which on Android is three taps into
an overflow and on iOS is a Share sheet nobody thinks to open on a website.

**Three states, not a button.** The obvious implementation shows a button and
calls `prompt()`, and it is wrong on two of the three platforms this app runs on:

- **Chromium** fires `beforeinstallprompt`, which can be stashed and replayed
  from a click. This is the only place a real button exists.
- **iOS** never fires it and has no API at all, in any browser: every browser
  there is WebKit underneath. The only route is Share, then "Lägg till på
  hemskärmen". A button would be a button that cannot work, so the offer is the
  two gestures written out, named the way the OS names them — there is no control
  anywhere on that platform with the word "install" on it.
- **Already installed**, where the whole thing is noise. This is the state that
  gets shipped broken, because it is the state the developer is never in while
  writing it.

**The event is captured at module load, not in the hook.**
`beforeinstallprompt` fires once, early, usually before React has mounted. A
listener installed on mount misses it on a cold load and then reports "not
installable" for a browser that offered.

**Two placements.** Inställningar, where somebody goes to look for it, and the
welcome card, which is the one moment a person is deciding where this app lives
and which disappears afterwards — the right lifetime for an offer like this. It
is not one of the welcome card's steps: those are "what makes the numbers real",
and the app works identically in a tab.

Chromium decides on its own whether to fire, based on a manifest, a service
worker, HTTPS and an engagement heuristic. There is no way to force it and no way
to ask. Absent event means no button, and that is not a bug to work around.

### D117 — The theme is a choice on the account, not a reading of the OS

The app followed `prefers-color-scheme` and nothing else, with a comment saying a
switcher was unnecessary because "the OS already knows the answer". It knows *an*
answer. It does not know that this particular app is a graph read in the dark, or
that a work laptop is set light by policy.

**Three values: `system`, `dark`, `light`, defaulting to `system`**, which is what
the app did before and what most people want. `system` is a real value rather than
a null meaning "unset": following the OS is a choice somebody makes and can come
back to, and a null would behave identically while tempting some future screen
into asking a question already answered.

**On the account, not in `localStorage`.** It is a preference about the app rather
than about a browser: somebody who reads at night on a phone reads at night on a
laptop, and setting it twice is the kind of friction that makes one app feel like
several. `profiles.theme`, in `/api/me`, patched through the endpoint every other
profile field goes through.

**And mirrored into `localStorage` anyway**, because the first paint happens long
before `/api/me` can answer and a dark app that flashes light for 400 ms every
morning is worse than no setting at all. The mirror is a **cache, never an
authority**: the account wins the instant it arrives, and a device that has never
synced falls through to the OS. Same shape as the cached identity in
`session.ts`, for the same reason.

**The OS listener is now conditional.** It used to be unconditional, which was
correct when following the OS was the only behaviour and would now drag a chosen
dark theme light at sunset along with the rest of somebody's desktop.

**Applied from the shell, not from the settings screen.** A choice that only took
effect while looking at Inställningar is a setting that appears not to work.

Re-run after the change: **zero contrast failures on both themes** across the six
screens, and focus visible on all 186 interactive elements. Driven through the
buttons rather than by forcing the class: each of the three applies immediately,
caches, reaches the account, and survives a reload.

### D118 — A local store that will not take a row stops preventing logging

Reported as "I can't log food, it says the app does not respond, try to restart
it". Restarting did not help, and it failed in a browser tab as well as in the
installed app.

The save probe on the device settled it:

```
1 öppna databasen: 1 ms, version 1
2 skriv en rad: tog slut efter 10000 ms
3 nå servern: 115 ms, HTTP 200
```

**The database opened instantly. The server answered in 115 ms. A single row
into `mutations` never completed.** So the app refused to log, with a working
server the whole time.

#### The fallback existed and was unreachable

D70 already built the branch this needed: no usable queue means the write goes
straight to the server, and it is genuinely sent. The condition guarding it is
`queueAvailable()`, which asks whether `db.open()` resolves.

**Opening is not the property that matters.** Being able to write is, and on
that phone the two disagreed: open in 1 ms, write never. So the app took the
queue path, `withTimeout` raised `SaveStalled("queue")` after five seconds, and
the screen said the device had stopped answering — while a fallback that would
have worked sat one branch above, ruled out by the wrong question.

There is no way to test "can this store accept a row" except by putting a row in
it, so the fallback moved to the failure of the write rather than into a better
availability check.

**Only `SaveStalled` falls through.** A `ConstraintError` from the unique index
on `clientUuid` is a real conflict and means something else entirely; swallowing
every error here would turn a bug into a silent direct send, which is the D70
failure in a new costume.

**The session gives up after the first stall.** Five seconds per tap is not a
working app, and a store that stalled once will stall again. A reload re-tests
it, which is the right granularity: whatever wedged the store is not going to be
fixed between two taps.

#### What the app says about it

Losing the queue is not a failure — logging still works — but it is a capability
that has gone, and it goes silently. Inställningar says so under Kö: writes are
going straight to the server, so logging works and stops working the moment the
network does. §3 has no failure state; D42's rule is that the app says what it
could not do rather than letting somebody find out in a basement.

#### The two things that made this hard to see

**The diagnostics screen could not report storage.** With open fast, network
fine and the write hanging, the two remaining explanations were "out of room"
and "the store is wedged", and there was no way to tell them apart from the
phone. `navigator.storage.estimate()` answers it in one line and is now on the
screen, run on load rather than behind a button: whoever opens that screen is
already there because something failed. The answer was
`0.1 MB av 10240.1 MB (0 %)` — not room, so the store itself.

**The bucket was best effort.** The same line reported "kan rensas av
webbläsaren", which is the default nobody chose. An app whose entire offline
story is a queue of writes a person has made should not keep it somewhere the
browser may drop under pressure, so `navigator.storage.persist()` is now
requested at boot. A request, not a guarantee: Chrome grants it for an installed
app or a site with enough engagement and silently declines otherwise, and there
is no arguing with the answer.

#### What this does not explain

Why that Chrome profile's IndexedDB stopped completing transactions is not
known, and this decision does not pretend to know. It is not quota, not a
blocked upgrade (that stalls step 1, and step 1 was 1 ms), and not our Dexie
usage — every call is a single operation with its own auto-commit transaction,
and nothing anywhere holds a transaction open across an `await` on a non-Dexie
promise, which is the one way app code can wedge a store.

Clearing the site's data is the remedy for the device. The point of this change
is that it stops being an outage: the app degrades to online-only logging and
says so, instead of stopping.

### D121 — The operator is a setting, not a constant

Vikt is meant to be self-hosted, and the repository carried one particular
operator's email address on `/integritet`, their name in the footer, and their
support link beside it. That is a privacy question and, more simply, it is wrong
for everybody else who runs this.

**Under the GDPR the controller is whoever deploys the software**, not whoever
wrote it. Article 13 requires the controller's identity and contact details;
Article 12 requires that exercising a right be facilitated. So the address on
that page is a fact about a deployment, and a deployment cannot inherit it from
a repository.

`CONTACT_EMAIL`, `OPERATOR`, `REPO_URL` and `SUPPORT_URL` are environment
variables now, substituted into `index.html` at container start by
`32-site-config.sh`, exactly as `__APP_NAME__` has been since D13.

#### Why not substitute into the bundle

`30-app-name.sh` rewrites `*.html`, `*.webmanifest` and `*.json` and
deliberately not the JavaScript. Bundle filenames carry a content hash and the
service worker's precache manifest records each file's size and revision, so
rewriting bytes inside one leaves the worker refusing its own cache. The values
therefore go into a `<script>` tag in the HTML and are read from a global.

That global is `viktSiteConfig` and **not** `__VIKT__`, which is where the
placeholder guard earned its keep again: the double-underscore shape is this
project's convention for a substitution token, `check-placeholders.mjs`
discovers tokens from the source by that shape, and it correctly reported a
runtime global wearing it as a placeholder nobody would ever fill. Renaming was
the fix; weakening the guard was not.

#### A missing address fails at boot, not on the page

`assertProdSecrets` refuses to start a **production** install with
`LANDING_ENABLED=true` and no `CONTACT_EMAIL`. A public installation whose
privacy page names nobody is not lawful to run, and a container that will not
start with a reason in its log beats a page rendering an empty sentence to a
reader who cannot fix it.

Only in production, and only where a landing page is served: a private install
has no public privacy page to be wrong, and a development instance should not be
refused a boot over a field nobody has filled in yet.

#### A form was considered instead of an address, and rejected

A contact form was the alternative. It is fine **in addition** and poor
**instead**: a form gives the person no record that they asked, nothing to
attach evidence to, and no reply channel when it silently fails. Several
supervisory authorities treat a form-only channel as inadequate for a
data-subject request. The address stays required; a form may be added beside it.

#### What went with it

The installation's own record — the deployment, the migration runbook, the
publication audit, host addresses — left the repository for an ignored
`INFRA.md`. The rule from here: **`DECISIONS.md` and `CLAUDE.md` are about the
program**, and every entry in them should be useful to somebody who has just
cloned this and will never see the server it was written on.

`STATE.md` stayed as a convention (§7) and was rewritten from nothing. The old
one was a session log naming a particular phone, particular CI runs and a
particular host, which is the right document to keep and the wrong one to
publish. The fast-path measurements it carried moved to `docs/measurements.md`,
because a tap count is a fact about the program: the landing page quotes it and
a test still pins the page to the file, so the claim cannot outlive the
measurement.

### D122 — Two chart defects, and saying why a number is missing

#### A ruler whose marks are not evenly spaced

The weight axis read `109,0 / 108,8 / 108,5 / 108,3 / 108,0`. The step was
0.25 kg and the labels carry one decimal, so the printed gaps alternate 0,2 and
0,3. Every label was correct and the ruler was wrong, which is the worse
failure: nothing about it looks like a defect, and a reader measuring the
distance between two marks is being told two different things alternately.

**A step must be a whole multiple of the precision it is printed at.** That
admits 0.1, 0.2, 0.5, 1, 2 and 5, and rejects 0.25. **2.5 survives**, because at
one decimal `108,0 / 110,5 / 113,0` is exact and evenly spaced — the rule is
about what prints evenly, not about which numbers look round.

De-duplicating on the rendered label, which the axis already did, does not catch
this. Those five labels are all different. They are simply not evenly spaced.

**And the step is chosen by counting rather than estimating.**
`floor(range / step) + 1` is how many marks a step *would* place if the first
sat exactly on the domain minimum. It does not: it sits on the first multiple at
or above it. The estimate therefore runs one high, and on a 3,1 kg window that
decided between three marks and six.

#### A domain that excluded the newest reading

The y-domain was built from the **trend alone**, so that outlying readings could
not squash the line into the middle quarter of the plot. Right about the hero,
wrong about the arithmetic.

The trend is an exponential moving average, so it **lags**. On a real series it
runs through the middle of the readings that produced it, and the most recent
reading — the one somebody opens the app to see — is the one furthest from it. A
morning weigh-in of 106,9 against a trend still at 108,4 fell outside and was
clipped. Clipped, not clamped, so it was **invisible rather than wrong**, which
is why it survived a design pass: the chart looked fine and the missing point
looked like a day nobody logged.

The fixture defending the old behaviour swung ±6 kg between consecutive days,
which no body does. Real daily noise is salt, hydration and glycogen, about
±1 kg, and the trend is drawn from those readings, so widening to hold them
costs the line its noise band rather than half the plot.

**What this costs:** a mistyped reading now stretches the axis instead of being
hidden. That is the better failure. The point becomes visible, and D56 put edit
and delete on the row that shows it — a chart that quietly omits a value is a
chart nobody can correct from.

The tooltip also carried two decimals where the headline carries one. The trend
averages scale readings that are ±0.1 at best; the second decimal is arithmetic,
not measurement.

#### "Inte än" is not a reason

Fibre showed nothing while the other three macros rendered. Confirmed as D55's
per-macro coverage gate working exactly as designed: crowdsourced food data
omits fibre far more often than protein, so fewer than three days cleared 90 %
and the mean was correctly withheld.

Correctly withheld and wrongly explained. "Inte än" cannot distinguish **"you
have logged nothing"** from **"what you logged does not carry this figure"**,
and those ask different things of the reader — one is "log something", the other
is "pick foods with fibre data, or accept that this number will not appear".

`weeklyDaysLogged` carries the second number, and it counts **the day, not the
macro**. Counting the macro was the first attempt and cannot work: a day of six
entries that all omit fibre reports fibre coverage 0, which is the same value as
a day nobody logged — the very distinction being drawn. The day's own `kcal`
total is non-null exactly when something was logged.

The reason line applies to **all four** macros. A rule that fires only for the
case that prompted it is a rule nobody remembers when the next one goes quiet.

### D123 — Honung marks a cost, and irreversible actions are typed

#### The audit found one primary and one secondary already

`.btn` is `bg-ink text-paper`, which is Snö on Natt in dark and Natt on Snö in
light: the rule was already right. Across the app and the landing page, 21
buttons use it, 25 use `.btn-secondary`, and **three** were neither:

- **`QuickActions`** — Dis circle, Snö icon, Gran when pressed. The profile
  names these separately on page 4; they are not buttons in this sense. Left.
- **A row in `FoodLog`** that is a tap target rather than a button. Left.
- **The scanner's cancel**, hand-rolled because its bar is `bg-ink` — a dark
  strip under a live viewfinder glares less — so `border-edge text-ink` would be
  dark on dark. Now `btn-secondary` with the two colours the surface demands
  overridden, so height, radius, focus and disabled state come from the shared
  class and stay in step with it.

The landing page's Lingon primary is D99's stated exception and is unchanged.

#### Honung, and why it is not a collision

The profile gives Honung to *belöning*: the pot, milestone markers, "ta ut".
Putting it on "radera kontot" looks like the palette colliding with itself.

**Amended: Honung marks a thing that has a cost.** Taking money out of the pot
spends something; so does deleting an account. The reward reading was the
narrower one, and both share the property that matters at the moment of
pressing: this one is not free.

§5 holds. An accent still names an area rather than a feeling, and this is
emphatically **not** a warning colour — nothing here is red, nothing turns red on
a bad day, and §3's "no failure state" is intact. Honung on a delete is not the
app being alarmed; it is the app saying what kind of action this is.

**Natt text in both themes**, which is the one pair that does not flip. Honung is
a mid tone in both (`#A8761E` light, `#E2B25A` dark): dark text clears AA on
both, light text clears neither. A pair that flipped would be unreadable in one
of them, so `--on-reward` is defined once outside the `.dark` block.

#### Two tiers of confirmation

**Irreversible — typing.** Deleting your own account types your address;
deleting somebody else's, as an admin, types theirs. There is no undo, so the
guard is deliberateness, and only typing proves somebody read the sheet rather
than tapping through it. The admin case is the one that matters most: it
destroys another person's data, and the admin is not the one who will notice it
missing. The row preview guards against pressing it by accident; typing the
address guards against pressing it on the **wrong row**, which is the mistake a
list of similar accounts actually invites.

Deleting your own account **keeps the password as well**. The two guard
different things: the password authorises — without it somebody holding an
unlocked phone could do it, and the address is on screen under Profil to read —
while typing the address makes it deliberate.

**Reversible — a plain confirm.** Disabling an account and revoking an unused
invite both undo in one action. Asking somebody to type an address to do
something they can undo in two seconds is theatre, and theatre teaches people to
click past confirmations. `ConfirmSheet` is the shared mechanism; enabling an
account back does not ask at all, because only switching it off has a cost.

**Deleting a backup is on the list and does not exist.** There is no endpoint and
no control. Listed anyway, so that when it is built the style is already
permitted and this decision has already been taken.

#### The guard

`class-names.test.ts` holds the allow-list by **file**, not by test id: the guard
reads source text, and a test id is a string in that same text, so matching on it
would check that a file mentions a name it also defines. It checks two things —
which files carry `btn-impact`, and which files open `ConfirmSheet`, since a
shared component rendering the style for anyone would otherwise be a hole
straight through the list.

### D124 — Two ways to log a food again, onto two different days

Browsing a past day on Mat now offers "Logga i dag" on each row, and "Logga
hela dagen i dag" above the list. Both sit on the same screen as "Igen" under
Senast loggat, and the three do nearly the same thing to different days:

- **"Igen"** writes to the day being **viewed**. That is backfilling: somebody
  filling in last Tuesday wants last Tuesday, and this is the behaviour that
  already existed.
- **"Logga i dag"** writes to **today**. That is somebody looking at yesterday
  and eating the same thing again.

**The labels carry the whole distinction**, because nothing else can. Two
controls a few centimetres apart that both mean "log this again" are
indistinguishable unless the label names the day, so one names it and the other
does not need to: "Igen" is about the day already on screen.

#### `dateSource` falls out of it rather than being set

The copy passes the **device's own** day. `enqueue` compares the supplied date
against the boundary the device would have computed and calls them equal
`device`, different `chosen` (D61) — so writing today's date here produces
`device` without this code mentioning `dateSource` at all, which is right,
because it *is* a statement about a clock.

#### Absent rather than disabled

While viewing today the copy actions are not rendered. Copying today's lunch to
today is an action with no effect, and a control that does nothing is worse than
one that is not there: it invites a press and then explains itself.

#### The whole day is sequential, and reports a partial result as one

One write at a time rather than `Promise.all`. Each goes through the offline
queue, and a burst of parallel IndexedDB transactions on a phone is how D118's
stall was reached. If the fourth of six fails there is no undo and no
pretending: the message says how many landed, and the rest are still on the day
being viewed.

#### The test is the pair, and it found a real defect

Asserting only that the new action writes to today would pass on a build where
"Igen" had quietly started doing the same — silently breaking backfilling, the
older behaviour and the one nobody would think to re-check. So the test drives
both, through the real date picker, and reads `localDate` off the request body.

Writing it caught something the type checker could not: the `copyingDay` hook
had landed **after** `if (me.isPending) return null`, so it ran on some renders
and not others. React's "rendered more hooks than during the previous render"
crashed the whole screen to a blank `<div>`, and every assertion failed on a
missing element rather than on the cause. The lesson is the older one: a blank
screen is a thrown render until proven otherwise.

### D125 — A logged row opens onto what is in it

The collapsed line carries a name, an amount and a calorie figure. Everything
else about an entry — its four macros, whether the numbers came from a database
or were typed, whether somebody estimated them — existed only in the database. A
reader comparing a day against a macro target could not see which entry carried
the fibre, or that one of them was a guess.

Tapping the name opens the row onto all of it, and **one row is open at a time**.
That state lives in the list rather than in each row, because "one at a time" is
a fact about the list and a row cannot know what its neighbours are doing.

#### The actions moved in with it

Edit, delete and, on a past day, "Logga i dag" (D124) used to sit on the
collapsed line. Three controls on each of four rows is twelve targets a thumb
has to aim between on a 360 px screen, and eleven of them belong to entries
nobody is looking at. Inside the disclosure they belong to the one row somebody
chose to open. D56 is unaffected: edit and delete are still on the screen that
displays the row, which is what that rule asks for.

#### Two things stay on the collapsed line

**The amount and the calories**, because they are what the line is for.

**The estimate marker.** It changes how the number beside it should be read, so
it cannot be behind a tap — a reader scanning a day has to be able to see which
figures are guesses without opening each one. `confidence < 1` is the test, which
is the schema's own definition rather than a second one invented here.

#### While a meal is being assembled, the row does not expand

The checkbox and the disclosure would be two meanings for one tap. In
`selectable` mode the row keeps its single meaning — this is a thing you are
choosing — and the name is plain text again. One tap, one thing, and which thing
changes with the mode rather than with where in the row the thumb lands.

#### A missing macro says "inte än", not zero

D44's rule, in the smallest place it applies. A fibre figure nobody recorded is
not a fibre figure of zero, and rendering it as `0 g` would put a fabricated
number next to three real ones.

### D126 — Framsteg leads with distance and folds the setup away

Framsteg opened on four blocks in this order: the header card, the sober count,
the pot, the milestone list with an empty create form under it, and a second
empty create form under that. Two of the five were things to type in, and they
were on screen every visit whether or not anybody wanted to add anything. On a
360 px phone the pot chart — the one figure that changes daily — started below
the fold.

**The lists are reference material.** A milestone list changes when somebody
changes it; a savings rule list changes less often than that. §5 calls that
reference material and folds it, which is what `Disclosure` is for and what
"Senast loggat" on the food screen already does. Both are folded by default,
each with its row count beside the label, because a count is what makes a fold
safe to leave folded.

**Creating is a button and a sheet.** An empty form is not information. It is a
tool, and §5's rule for occasional tools is that they cost one tap and give the
screen back. Both create forms move into `Sheet`, which brings Escape, focus
return and a scroll lock with it rather than three more inline copies of that
behaviour. Each closes on success: the milestone appearing in the list behind it
and the count going up by one is the acknowledgement, so there is no toast.

**The add buttons stay outside their folds.** Adding a milestone is not
something you do to the list of milestones, so it must not cost a fold first,
and the disclosure's own doc warns against being the only route to a control.

**There is no separate "next milestone" block**, because D60 already put every
unreached milestone in the header card, nearest first, with its distance in its
own unit and its projected date. Lifting the nearest one out would put a border
between two halves of one answer and reintroduce the `[0]` framing D60 was
written to remove. The card *is* the distance.

**The order below the card is how often the answer has changed since last
time.** The pot moves daily and answers "can I afford the reward yet". The sober
count moves daily too but is a single figure and reads fine below a chart. The
two lists move when somebody moves them. The savings rules left the pot panel in
the same change: they were hanging off the bottom of a chart, and the retroactive
note (D54) belongs beside the rules it warns about rather than beside the
balance.

### D127 — Asking for a code is its own deployment mode, at its own path

The request form sat in the landing page's last section, behind
`LANDING_ENABLED`, and the hero carried a second button pointing at it. Turning
on a page for people to read turned on a public write endpoint with it, and
there was no way to have one without the other.

**They are different decisions.** A landing page is something to read: it costs
its owner nothing to serve, and it is the thing that makes an open-source
project findable. A request form takes a stranger's name, address and a line of
free text, and every code approved from it makes whoever runs the installation
responsible for that person's weight, meals, measurements and address, under
their own name on `/integritet`. That is a decision worth making one person at a
time, and a form on a public page is the opposite of making it one person at a
time.

So `REQUEST_ENABLED`, off by default, independent of `LANDING_ENABLED`, and
documented as a deployment mode beside it in `README.md` and `.env.example`.

**Off means absent, at both locks.** nginx returns 404 for `/kod`, and the API
does not register `POST /invite-requests` or its challenge endpoint. A route
that answers 403 is still a route: still reachable, still something to probe and
rate-limit around. `invite-request.test.ts` asserts the landing-on,
request-off configuration specifically, because that is the one the separation
was made for and the one that did not exist before.

**On means everything that guarded it is still there.** The human check (D112),
the honeypot, and the per-IP limits on both the challenge and the submission all
moved with the form. Being unlinked is not a security property and is not
treated as one: it is unlinked because it is not for browsing.

**The hero says something true for every reader instead.** "Be om en kod" as a
second button implied asking was a normal way in, and on most installations it
pointed at a page that does not exist. What replaces it is a sentence, not a
control, because there is no action here that is right for everybody: somebody
with a code opens the app, somebody without one cannot get one here, and both
can run their own copy. The link goes to the repository, which is the one offer
this page can make to anybody who reads it.

`/integritet` gained a paragraph saying the form may not exist at all, and that
where it does not, no request is stored here in the first place.

### D128 — Announcements take a small Markdown subset, parsed rather than sanitised

An announcement body was one string of plain text, dropped into a `<p>` in the
app and into `wrap()` for the mail. That is right for "we are restarting on
Tuesday" and useless for a release note, which wants a heading, a list of what
changed, and a link to the screen it changed.

**The subset is paragraphs, two heading levels, bold, bullet and numbered lists,
and links.** Not italics: at 12 px in a mail client it is indistinguishable from
bold, and §5 already rules that a second emphasis is a second voice arguing with
the first. Not images, because D88 says no mail from here carries one. Not
tables, not code, not nested lists. The stopping point is what a release note
needs and nothing past it.

**Parsed to a tree, not sanitised into one.** The obvious build is a Markdown
library plus a sanitiser plus `dangerouslySetInnerHTML`, and that puts a
sanitiser between an admin's textarea and script running in every reader's
browser. Instead `packages/shared/src/markdown.ts` parses to a tree of three
block types and three inline types, and each of the three surfaces walks it:
React elements in the app, an HTML string for the mail, plain text for the
mail's text part. **There is no markup to strip, because the tree cannot carry
any.** Raw HTML in the source renders as the characters somebody typed, in all
three, by construction rather than by configuration.

The one place a string does become markup is the mail's HTML renderer, which
escapes every value including the href, and refuses every scheme but `http`,
`https`, `mailto` and a same-site path. An unsafe scheme keeps its label and
loses its link, which is the right failure: `javascript:` and `data:` are the
two that turn a link into an attack, and a reader who sees the words has lost
nothing they could safely have had.

**Heading levels are a parameter, not a constant.** The subset's two levels are
"first" and "second", and each renderer places them: under the news list's `h2`
they are `h3` and `h4`, in the admin preview they are one lower again. A body
that hard-codes `h2` puts a hole in the outline of whichever page it lands on.

**The banner gets one line.** `AnnouncementLine` renders the first block and
stops. A maintenance notice is a sentence beside a dismiss button, and a banner
that grew to hold a heading and a list would push the app down the screen on
every route.

**The editor previews with the renderer, not with an approximation of it.** An
announcement is written once, read by everybody, and mailed once with no recall.
The thing that makes that safe is seeing the actual rendering before pressing
save, so the preview is the same component the news page uses.

**The copy guards run over the rendered output.** No test can check what an
admin will type, but it can check that the renderer introduces nothing: a
formatter with smart typography would put an en dash into every announcement,
and a heading style with `text-transform` would shout one written in sentence
case. `copy-style.test.ts` runs its own dash rule and its own `shoutedWords`
over both string renderers, and the render test asserts no `uppercase` class
reaches the DOM.

### D129 — The admin is told a request arrived, and can turn that off

The receipt somebody gets for asking says a person will read their request.
Nothing made that person aware of it. The row went into a list that has no
reason to be opened on any particular day, which is how somebody who asked
politely waits three weeks for an answer that was one click away. The feature
was half built: it stored the request and told the asker, and never told the
one person who could act.

**Mail, through the queue** (D104). Not sent inline: a mail server that is down
or unconfigured must not turn a stranger's request into a 500 on a public
endpoint. The drainer retries, and the request is stored either way.

**Failures are swallowed on purpose.** The visitor is not the person this mail
is for, and the thing they asked for has already happened. An installation with
no `PUBLIC_BASE_URL` cannot build the link, and that is a reason to skip the
notification rather than a reason to refuse the request.

**It quotes rather than summarises.** Who asked, the address, and the line they
wrote, because the decision is made by reading those and a mail that says
"somebody asked" only moves the reading somewhere else. The link goes to the
requests tab, which is the admin screen's default view; there is no per-request
page and a request is answered from its row.

**A dot on the admin entry, not a count.** Same reasoning as the news marker
(D108): the number is never large enough to be information, and a numbered badge
is the shape of an app that wants attention rather than one that has something
to say. Gran, because a request waiting is work rather than a failure. It is
counted from the rows on `/me` rather than stored, so it is right whether or not
the mail was sent, whether or not this admin opted out, and whether or not the
mail server works. It rides on `/me` for the same reason `isAdmin` does: the
navigation decides during the first paint, and a second request would make the
marker appear a moment late.

**The opt-out is per admin and default on**, like the news mail and for the
mirror of its reason: news is something you might find interesting, and this is
work waiting for you. The default has to be the one where the thing gets
noticed. The hint says what turning it off does not do — the request still
arrives, the list still holds it, the dot still appears — because a preference
whose blast radius is unclear is one people leave alone out of caution.

`request_mail` is on every profile rather than only on admins'. `is_admin` can be
set at any time, and a column that existed only for current admins would have to
be created at the moment somebody is promoted; a boolean with a default costs one
byte per row and removes that whole case.

### D130 — SMB is spoken, not mounted

D103 built the backup schedule with `local` as the only destination and `smb`
and `s3` refused with a reason. SMB is the one people actually want: the point
of a backup is that it survives the machine the database is on, and for a
self-hoster the thing that survives is usually a NAS.

**The mechanism was the decision, and it was made before any of this was
written.** There are two ways to reach a share from a container:

**Mounting it inside the container is not acceptable.** `mount -t cifs` requires
`CAP_SYS_ADMIN`, which is most of the way to root on the host. Granting that so
a backup can be written is a bad trade, and worse, it is a trade a self-hoster
following the README would make without knowing they had made it. A capability
in a compose file is invisible in a way an admin screen is not.

**Speaking the protocol from Node needs nothing.** No mount, no capability, no
privileged container, no host-side fstab entry. It also puts the host, share,
username and password in the admin screen beside everything else that is
configured there, under the same encrypted-secret pattern as the SMTP password
(D102), rather than in a file the app cannot see and cannot check.

So: `@marsaud/smb2`, whose surface is fs-shaped — `createWriteStream`, `unlink`,
`readdir`, `stat` — which is exactly what a backup needs and nothing more.

**The mounted path is kept, and is the documented fallback.** It was never a
separate feature: a mount is a `local` destination pointed at a path that
happens to be one, and nothing in `backup-smb.ts` is involved. That matters
because this client speaks **SMB 2.0.2**. Samba and every Windows since Vista
accept it; a server hardened to require SMB 3 refuses the connection. That is a
clean refusal at connect time rather than a corrupt backup, the error names the
limit in as many words, and the mounted path is the way through it.

**Encryption happens before the destination sees anything**, which is what makes
an SMB 2.0.2 transport acceptable here and would not make it acceptable for a
password. What crosses the network is ciphertext with a GCM tag. `dumpEncrypted`
takes a stream rather than a path for this: a local file and a file on a share
are both a `Writable`, and everything else about the dump is identical. The byte
count is kept as the bytes go past rather than read back with `stat`, because a
destination that cannot be stat'ed afterwards is the case this was extended for.

**"Test connection" writes and deletes a probe file.** Not a connect check: a
share that authenticates and then refuses to accept a file is a real
configuration, and it is the one a connect-only check would call healthy. It
tests what is **saved** rather than what is typed, and sits below the save
button for that reason — a probe against unsaved values would pass and the
schedule would then run against the old ones. Logged either way, because a pass
dates the last time the destination was known to work.

**The password is never sent to the browser.** The screen gets `smbPasswordSet`,
a boolean. An empty password field therefore means "leave the stored one alone",
because that is the only thing it can honestly mean; clearing it is a separate
checkbox, since one empty box cannot express two intentions. Without that,
changing the retention window would wipe the password, silently, and the
scheduled run at three in the morning would be what found out.

**Saving a share with no `SECRET_KEY` is refused**, not stored in the clear and
not quietly dropped. And switching back to a local destination erases the
credentials, because keeping a share's password after somebody stopped using
that share is storing a secret for no purpose anybody could name.

Pruning over SMB follows the local rule — by age, not by count — with one
addition: a file whose modification time the share will not report is left
alone. Deleting on a guess is the one mistake here that cannot be undone, and a
destination filling up is a problem somebody can see.

### D131 — The preview server was serving truncated responses, and /kod did not exist in it

Found while taking the verification screenshots for this pass, which is exactly
what a verification pass is for. Three defects in the dev and preview servers,
none of which any test could have caught, because they are in the tooling that
stands in for nginx.

**`/kod` was a 404 in dev and in preview.** `PUBLIC_PAGES` in `vite.config.ts`
mirrors nginx's `location =` blocks for `/integritet` and `/villkor`, and D127
added a third path to nginx without adding it here. The page shipped, the tests
passed, and it could not be opened on a development machine.

**And then it existed unconditionally.** The preview server's SPA fallback
answers any unknown path with the landing HTML, so once the rewrite was added
the flag decided nothing: `/kod` was served whether `REQUEST_ENABLED` was on or
off. The one property D127 is about — that the path does not exist unless it is
switched on — was the one property that could not be tried locally. Both servers
now return 404 for it when the flag is off, which is what nginx does.

**The app-name substitution truncated every static response.** The preview
server buffers a response, replaces `__APP_NAME__` with the configured name, and
writes it back. `__APP_NAME__` is twelve characters and "Vikt" is four, so the
`Content-Length` sirv had already sent was too large by eight bytes per
occurrence, and the browser sat waiting for bytes that were never coming.

The symptom was a page stuck at `readyState: "loading"` forever, `curl` taking
six seconds and exiting 56, and a screenshot run that timed out with nothing
written. The first attempt at a fix — skipping the length when the headers had
already gone out — turned a crash into a hang, which was worse, because a crash
says what is wrong. The actual fix strips `Content-Length` in `writeHead`, so
the rewritten body is chunked and its length is nobody's business.

**What made this take four attempts is worth writing down.** Every check of the
preview server had been made with `curl`, and `curl` does not ask for
compression unless told to. The browser does, so the browser was getting a
different response from the one every check had looked at, and the failure it
reported — `ERR_CONTENT_DECODING_FAILED` — pointed at compression rather than at
the length header that was actually wrong. Chasing the encoding was a detour:
the served gzip turned out to be valid once the length was fixed. The lesson is
the check, not the bug. **A server is verified with the client that will use
it.**

The same pass also lost twenty minutes to five abandoned screenshot processes
still attached to the same CDP session, silently consuming each other's
replies — `pkill -f` is a no-op on Windows, which CLAUDE.md §7 already says
about dev servers and evidently needs saying about everything else too.

Left as it was found: the SPA fallback still answers unknown paths under `/`
with the landing page, where nginx would 404. That is a divergence worth
knowing about and it is not what this pass was for.
