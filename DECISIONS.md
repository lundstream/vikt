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

#### Addendum, 2026-09-15: every span says "minst", and a partial day is no longer dropped

**The rule, at every span.** Below the gate a macro figure is the **sum of what
is known**, preceded by "minst", drawn in Sten (`.figure-partial`), with the
share of the energy that carries it on the info line beneath. Nothing is shown
**only when no logged food carries the value**. The spans are the day (Översikt's
day card, and Mat, which now shows the day's macros under its kcal total), the
seven-day mean (Översikt), and seven and twenty-eight days (the coach's sheet).

**A window's figure is built from its days' known values.** The mean, over the
days with anything logged, of each day's known grams, and "minst" as soon as any
of those days was under the gate. This reverses the last sentence of the third
paragraph above, which **excluded** a partial day from the seven-day mean.

That exclusion was written against a real hazard: a 40% labelled day pulls an
average down, and stated as a total it reads as low intake. But the fix it chose
hid the week instead. On crowdsourced data a week of honest logging could clear
the gate on fewer than three days for fibre and show nothing at all (D122 is the
report of exactly that), while every one of those days had a known floor worth
stating. Stated as "minst", the averaged-in partial day is as true as the day's
own "minst": the figure is never above what was eaten, and never hidden when
something is known.

- A logged day on which **no** food carried the macro contributes zero known
  grams and counts as partial, which is still a correct floor. The window is
  absent only when no logged food in it carried the macro, or nothing was
  logged.
- The weekly figure still needs three logged days (`MIN_DAYS_FOR_WEEKLY`),
  which is NNR's "a week" and not this gate.
- D122's reason "too few days with complete data" is retired. Three remain:
  nothing logged, fewer than three days logged, and logged food that carries
  none of it.
- In the coach's sheet: "snitt minst X g från N loggade dagar, varav K med
  ofullständiga uppgifter (P procent av energin har uppgift om …)", and "under
  målet" is counted **over complete days only**, because a partial day under the
  target may not be under it.
- The gate itself is unchanged: 0.9, per macro, weighted by energy.

One function does the window, `windowMacroTotal` in `calc/macros.ts`, used by
the insights service and the coach's sheet; `dayMacros` does the day for the
dashboard, the sheet and Mat. Tested for complete, partial and absent at each
level: the shared calc, the insights API, the D122 reason test, the coach sheet,
and a render test of the day card in both views and of Mat's line.

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

> **Superseded by D133.** The mechanism argument below is still right: mounting
> a share inside a container needs `CAP_SYS_ADMIN` and that is not a thing to
> grant for a backup. The protocol was wrong. Both Node SMB clients authenticate
> with NTLMv1, which current servers refuse, and D132 records what that cost.
> The destination is S3 now, and a Windows share is reached by mounting it **on
> the host** and pointing a directory destination at the mount.

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

### D132 — Both Node SMB clients speak NTLMv1, and no destination may crash the API

D130 chose to speak SMB from Node rather than mount a share, to avoid granting
`CAP_SYS_ADMIN` to a container. The mechanism was right. The library was not,
and the second library is not either, and that is worth writing down before
anybody tries a third.

#### What went wrong, in the order it was found

**`@marsaud/smb2` cannot authenticate on Node 22 at all.** It builds an NTLM LM
hash with `createCipheriv("des-ecb", ...)`, and OpenSSL 3 moved DES out of the
default provider. Every environment this project runs in — the workstation, CI,
the API image — is Node 22, so the feature never worked anywhere.

**It took the API down when tried.** The throw came from inside a socket `data`
handler, which is outside every promise chain, so the `try/catch` around the
connect never saw it. An admin pressing "test connection" exited the process.

**Eleven tests covered the share destination and none reached authentication.**
They all connected to `127.0.0.1`, which refuses at TCP. The path that broke was
the path no test had ever run. This is the same failure as D98's lint claim and
D95's eight "screens": a thing verified against a case that cannot fail the way
the real one does.

**`@awo00/smb2` fixes the crash and not the feature.** It carries its own
pure-JS DES (`des.js`), so nothing asks OpenSSL for a cipher it does not have.
Verified against a real Samba container: it reaches NTLMSSP type 3 and gets a
proper SMB response instead of dying. But it implements **NTLMv1 only** — LM and
NT hashes, three DES blocks against the server nonce, no HMAC-MD5 and no v2 blob
anywhere in the package. Samba has shipped `ntlm auth = no` by default since
4.5, and Windows has refused NTLMv1 by default for longer. Against a
default-configured server it returns `STATUS_LOGON_FAILURE` with correct
credentials.

It authenticated only after the test server was set to `ntlm auth = yes`,
`lanman auth = yes` and `server min protocol = NT1`. **That is the finding.** A
CI suite against a Samba configured that way would go green while the owner's
NAS kept refusing — the original mistake, rebuilt with more ceremony.

#### What was done, and what is left open

**The crash is fixed independently of the library**, because it has to be: an
SMB client is a socket state machine that calls back from a `data` handler, and
*any* such client can throw where no `await` can catch it. Swapping libraries
changes which line throws, not whether an uncaught throw is possible.

`backup-crash-guard.ts` installs one `uncaughtException` handler that is
deliberately narrow. While a backup or a probe is in flight it logs with the
destination, marks the `backup_runs` row failed so the admin screen shows what
happened rather than a run that started and never finished, and keeps serving.
With nothing in flight it restores Node's behaviour and exits, because
swallowing an arbitrary throw turns every future bug into a silent one. A
blanket handler would have been easier and much worse.

The DES pre-check stays as a belt: a runtime missing a cipher the chosen client
needs is refused with a sentence naming the mounted-path way round, rather than
attempting a connection that will kill the process.

**What is not decided** is how the feature actually works, and it is not a
decision to take quietly:

- **implement NTLMv2** over `@awo00/smb2`, whose NTLM module is isolated enough
  to replace. It is well specified (MS-NLMP) and roughly a hundred lines, and it
  is authentication code, which is the category where a subtle error is silent;
- **drop direct SMB** and keep the mounted path, which already works and is what
  the README documents as the fallback. Honest, small, and gives up what D130
  was for;
- **something else** — an S3-compatible endpoint that most NAS boxes now speak,
  which needs no NTLM at all.

Until that is settled the destination stays refused with a reason rather than
half-working, which is the state D103 chose deliberately for exactly this case.

### D133 — The remote destination is S3, and a share is mounted on the host

D130 wanted a backup that survives the machine the database is on, and chose to
speak SMB from Node rather than mount a share, because mounting inside a
container needs `CAP_SYS_ADMIN`. That reasoning was right and is unchanged. The
protocol was the mistake, and D132 records what it cost: a library that could
not authenticate at all on Node 22, an admin button that exited the process, and
eleven tests that never reached the code that broke.

**Neither Node SMB client can authenticate to a current server.** Both speak
NTLMv1 — `@marsaud/smb2` through OpenSSL's DES, which no longer exists, and
`@awo00/smb2` through its own pure-JS copy. Samba has shipped `ntlm auth = no`
by default since 4.5 and Windows has refused NTLMv1 for longer. Verified against
a real Samba container: `STATUS_LOGON_FAILURE` with correct credentials, and a
successful login only after setting `ntlm auth = yes`, `lanman auth = yes` and
`server min protocol = NT1`. Nobody should run a NAS that way to receive
backups, and a CI suite configured against one would go green while the owner's
server kept refusing — the original mistake with more ceremony.

**Writing NTLMv2 by hand was the rejected alternative.** It is well specified
and roughly a hundred lines, and it is authentication code, where a subtle error
does not announce itself. This project has one maintainer.

**So: S3.** An HTTP request signed with a key the owner pastes in, reaching AWS,
Backblaze B2, MinIO and the S3 endpoint most NAS boxes now ship. `s3` was
already in the destination enum, refused with a reason since D103, which is
exactly the boundary that decision existed to hold.

**Somebody who wants a Windows share mounts it on the host** and points a
directory destination at the mount. That has always worked, involves none of
this code, and the README now carries the fstab line and the compose volume
rather than leaving it as an idea.

#### What is deliberate in the implementation

**Path style is a setting, not a guess.** AWS addresses a bucket as
`bucket.host/key` and everything self-hosted wants `host/bucket/key`. Getting it
wrong fails in a way that reads like a wrong address rather than a wrong option,
so it is a labelled checkbox that defaults to on, because self-hosted is what
this project is for.

**The dump is encrypted before it reaches the client**, which is D103's rule and
is what makes any remote destination acceptable: what crosses the wire is
ciphertext with a GCM tag. Server-side encryption is not requested and would add
nothing to bytes that are already opaque.

**The whole object is buffered.** `PutObject` needs a length, and the
alternative is a second dependency for the multipart uploader. A database whose
compressed dump does not fit in memory has outgrown a single-container
deployment for several other reasons first. The local destination still streams
to disk and does not go through this path.

**Retention never deletes the newest.** By age as before, and the list is sorted
oldest first with the last entry excluded before anything is removed. A window
of one day and a schedule that has not run for a week would otherwise empty the
bucket, which is the one outcome a backup system must not produce on its own.

**The errors name the field.** The SDK says "the request signature we calculated
does not match", which is accurate and tells somebody staring at six inputs
nothing. `explainS3Error` maps the names MinIO actually returned during
development to sentences that say which of them is wrong.

#### The tests are the point of this decision

`backup-s3-live.test.ts` runs against a **real MinIO with default settings**, as
a service in CI and a container locally: put, list, get, delete, a wrong secret
that produces a real `SignatureDoesNotMatch` from a real signature check, a
wrong access key, a missing bucket, and an unreachable endpoint. Without
`S3_TEST_ENDPOINT` they **skip loudly** rather than passing, because a suite
that goes green when its subject is absent is worse than one that says it did
not run. CI also asserts `pg_dump --version` before the suite, so the two
full-run tests cannot quietly stop running if a runner image drops the client.

That is the correction of the specific failure in D132: a destination is
verified against something that can fail the way the real one does, or it is not
verified.

**The crash guard from D132 stays**, even though an HTTP client is far less
likely to throw outside a promise chain than a socket state machine. It costs
one function call, it is the difference between a bad destination and a dead
API, and the reason it exists is that nobody predicted the last one either.

### D134 — Three button tiers, and the outline one is not among them

D123 audited the buttons and found the app already consistent: 21 filled, 25
outline, three exceptions. It was consistent, and it was consistently spending a
whole visual tier on the wrong distinction.

**The outline said "the other button".** `.btn-secondary` existed to make a
second action quieter than the first — "lägg till pass" beside "spara dagen".
But the reader does not need to be told which of two actions is more important,
and the app was not saying anything reliable about it anyway: `.btn-secondary`
was on saves, on cancels, on diagnostics probes and on a download link. A tier
that means five things means none.

**Worse, a cancel looked like a button.** "Avbryt" and "Spara" sat side by side,
both button-shaped, distinguished only by position and fill. That is the wrong
pair to make look similar: one writes and one leaves.

#### The three that remain

**A filled button for every action.** Snö on Natt in dark, Natt on Snö in light,
which is what the profile has said since v1.0 and what `.btn` already was. Three
parallel saves on Dagen are three filled buttons, and that says "these are three
equal things" more honestly than an outline said "this one is lesser".

**A text link for what is not an action.** Cancel, back, dismiss. The app
already used this for "Tillbaka" and for "Ta bort" in a row, so `.btn-link` is
the existing pattern given a name rather than a new invention. It reads as
"this takes you out of here", which is what cancel is. Still 44 px tall: a link
is a quieter target, not a smaller one.

**Honung for an action with a cost**, unchanged from D123 and now written into
the profile itself (v1.3, page 3: "sådant som kostar: belöningar och
oåterkalleliga handlingar").

**And a small filled variant for a row action.** "Köpte ändå" on a savings
offset, "logga hela dagen i dag" on a past day. These write something, so they
are buttons, not links; they sit inside a row, so they are small. The outline
used to be how they were made to fit, which is how a fourth tier earns its
keep and then spreads. `.btn-small` is `.btn` at the size a row can hold. Its
pressed state stays Gran, because the profile is explicit that a chosen control
is the logged colour: chosen *is* logged.

#### What was converted

28 call sites. 20 became filled buttons: the saves on Dagen, Mat and the macro
form, the diagnostics probes, "lägg till milstolpe" and "ny sparregel", "skicka
testmejl", "hämta senaste", "testa anslutningen", "logga receptet", "spara
raderna", "se vad ändringen gör", "logga första vägningen", and the trigger that
opens the account-deletion confirm. Six became text links, and all six are
"Avbryt": the scanner, the confirm sheet, the account deletion, a savings rule,
the announcement editor and the admin user deletion. Two became `.btn-small`:
"logga hela dagen i dag" and "köpte ändå".

#### The profile's page 6 — resolved

> **Closed by v1.4.** Page 6 now reads "Tre nivåer, inga konturer" and states
> the rule this decision arrived at, in the profile's own words: actions are
> filled, Snö on Natt and Natt on Snö in light; what is not an action — avbryt,
> tillbaka, dölj — is a text link; what costs is Honung with Natt text in both
> themes, and the irreversible is confirmed by typing; a chosen scale button is
> Gran; and "radåtgärder som 'Köpte ändå' är samma fyllda stil i mindre
> storlek". The code and the specification agree, and this decision needs no
> further reading.

For the fourth shape the profile keeps beside these three — the quick action —
see D135.

`class-names.test.ts` holds the rule in two halves, because either alone is easy
to work around. The class may not reappear in source or as a rule in the
stylesheet, and no component may hand-roll the look out of `bg-transparent` plus
a border on one element, which is how a removed tier usually comes back. Proved
by reintroduction: putting `btn-secondary` back into `DayCard.tsx` fails the
test and names the file.

### D135 — An entry point is a quick action, not a button

Three controls on the food screen were still outlines after D134 removed the
tier: "Skriv in själv", "Skriv vad du åt" and "Vad kan jag laga?". Two questions
follow from that, and the second matters more than the first.

#### Why the guard walked past them

`.btn-secondary` expanded to a border **and** `bg-transparent`, so the guard
looked for that pair. Nobody writes `bg-transparent`: a border with no
background is transparent already. These were
`min-h-11 w-full rounded-lg border border-edge px-4 text-note text-ink` — the
same look, built from utilities, with no token the guard was watching for.

It was not three. It was **twelve**, across seven files: the search submit, the
portion chips, "spara portionen", "fråga modellen", "läs", "lägg till" in the
pantry, "föreslå", a diagnostics probe, and a border left on the scanner's
cancel after it became a link.

So the rule is now the **absence**, not a token: an all-sides border width with
no background on a control is an outline, whatever else is on it. Three things
are deliberately not caught, and each is a shape the profile keeps: a
directional border is a divider; a control carrying `aria-pressed`,
`aria-checked` or `role="radio"` is a choice in a set, which page 6 keeps
bordered on purpose; and a border that lives in a component class is defined
once where it can be read.

The first version of that rule flagged every divider in the app, because a word
boundary sits inside `border-b` as well as after `border`. It matches a
space-delimited width now. Proved by reintroduction: putting the exact
twelve-class string back into `DayCard.tsx` fails the test and names the file.

#### Why they are not filled either

Filling them would have been the obvious reading of D134 and it would have been
wrong. **They are doors, not actions.** Each one opens a sheet; none of them
writes anything. Scanning was already the fourth door and was already drawn
correctly — a Dis circle with a Snö icon — which is the tell that the other
three were the odd ones out.

So the rule has three tiers **and one shape beside them**: an entry point to
another surface is a quick action, exactly as the profile's Snabbåtgärder
section already specifies. Filled for what does something, a link for what
leaves, Honung for what costs, and a labelled circle for what opens a door.

The four now sit in one row: scan, estimate, describe, recipe. The two
model-backed ones are absent rather than disabled when the box is off, which is
§6's rule for the whole phase 8 surface. `gap-x-4` is what lets four 64 px items
fit the 320 px a 360 px screen leaves, and the row wraps rather than overflows.

**The scan control left the search row to join them.** It had been unlabelled
beside the field because a label made it taller than the input and nothing
shared a centre line. That was the right fix for the wrong arrangement:
scanning is not part of searching. In a row of peers it takes its label back.

`estimate.openHint` — "När maten inte finns i databasen" — went with the button
it sat under. A row of four labelled circles has no room for a footnote on one
of them, and the sheet says it at more length on arrival.

#### The icons

A pen, a speech bubble and a pot, drawn to the profile's line set on the same
24-unit grid as the three that existed: no fill, `currentColor`, 1.75 stroke,
round caps. Each is carried by its silhouette, because they are read at 24 px:
the bubble is empty rather than holding three dots that close into a smudge at
that size, and the pot is wider than it is tall so it cannot be confused with
the bowl that means "logga mat" on the dashboard.

### D136 — The two reminders, and the foundation they pay for

The first notification this app has ever sent. Phase 11 specified it; this is
what was built, and the parts worth arguing about.

#### Push is absent without keys, not degraded

No VAPID pair means the scheduler does not start, the subscribe endpoint is not
registered, and the settings section is not drawn. The same rule as the LLM
surfaces and the landing page: an unavailable feature leaves no trace rather
than a disabled control that invites a support question. `assertProdSecrets`
refuses a **half** configuration — a public key with no private key accepts
subscriptions it can never send to, and the failure is invisible: the browser
says yes, the row is stored, and the person waits for a reminder with no way to
arrive.

#### Four rules, and each one is a way this could be quietly wrong

**The time is the user's.** 07:00 means seven in the morning where the person
is, which is a different instant for two accounts and a different instant for
one account in March. The sweep asks each profile what time it is *there*.

That forced a decision about where the day boundary lives. §3 gives it to the
client, and that is still right for logging — but the scheduler cannot ask a
sleeping client what day it is. So `toLocalDate` moved into `shared`, where both
sides use one implementation. The two policies differ and both are deliberate:
the client falls back to the device's zone on an unknown timezone, because an
unknown zone must not stop somebody logging; the server does **not**, because
its own zone is not the user's and quietly substituting UTC would file a
reminder under the wrong day and look like it worked. It skips the profile.

**Skipped when it has already happened**, checked at send time rather than when
the window opened. Somebody who weighs themselves at 06:40 has answered the
question, and a reminder then is the app admitting it was not paying attention.
That is also the difference between a reminder and an alarm.

**Never twice for one day.** The unique index on `(user_id, kind, local_date)`
is the guard, not a check in code: a retry, a second process or a clock stepping
backwards all converge on one row. The insert **is** the claim, and it happens
before the send, so a crash between them costs one reminder rather than
producing two. A skipped day is claimed as well, so it is not reconsidered every
minute for the rest of the window.

**Late is worse than never.** A device offline at 07:00 does not get "dags att
väga dig" at 11:00; by then it is not a reminder, it is an interruption about
something the morning has settled. The window is 30 minutes, and the push TTL
says the same thing to the push service for the case where the device comes back
after the send.

#### A subscription is per device, and rejected means deleted

One row per browser per account: the same person has a phone and a laptop.
`endpoint` is unique table-wide, so re-subscribing the same browser updates the
row rather than adding a second that fires alongside the first — and the
conflict updates `user_id` too, because a shared computer produces the same
endpoint for a different person and the row has to follow.

404 and 410 delete the row on the first failure: both mean the browser threw the
subscription away, which is what RFC 8030 gives those two codes for, and a queue
that retries them forever is a queue that grows forever. Anything else is
transient and the row stays.

**403 also keeps the row**, which is a correction rather than the original
rule — see the addendum below.

Removable from **any** device (D56), because the commonest reason to want that is
a phone somebody no longer has, and a control that only worked on the device
being removed would be useless in exactly that case.

#### Addendum, 2026-09-12: why two dead-looking rows survived a rule that removes dead rows

A verification pass found two push subscriptions on the test account that no
browser was listening to, and **removed them by hand** — through the app's own
`DELETE /api/push/subscriptions/:id`, from a script, for every device the
current browser did not recognise as itself. That is worth writing down rather
than leaving as an unexplained tidy-up, because the obvious reading is that the
automatic removal had failed.

It had not. The rule above is exact about what it removes: a subscription the
push service **answers 404 or 410 for** (403 was on that list when this was
written; the next addendum says why it is not). Those two rows were not that. WNS
accepted every send to them — the sweep that morning logged `sent: 2` — because
from the push service's point of view the channels were perfectly alive. What
had gone was the **browser profile** on this machine, deleted by a harness
script between sessions, and deleting a profile locally tells the push service
nothing at all. A subscription becomes 410 when the browser unsubscribes or the
service expires it, and a scratch profile that is simply erased does neither.

So there is no defect in the removal, and there is also no way for the server to
have known: "nobody is listening" is not observable from here, and inventing a
heuristic for it — say, dropping a subscription that has not been *seen* for
some number of days — would delete the phone of somebody who spent a month
away. `lastSeenAt` exists so a person can recognise a stale device in the list
and remove it themselves, which is what D56 asks of every row.

**Two things were missing, and both are fixed:**

- **One line per removal.** The sweep counted removals and the scheduler logged
  the count, which tells an operator that something was dropped and never which
  thing. `runReminders` now takes an `onRemoved` callback and the scheduler logs
  the subscription id, the **host** and the reason, one line each. The host and
  not the endpoint: the token in an endpoint is the capability to notify that
  device, and a log file is not where that belongs.
- **A test for the mapping itself.** The existing tests drive `SendOutcome`
  directly — they prove `gone` deletes and `failed` does not, and say nothing
  about which status is which, which is the decision that matters. `sendPush`
  now takes the delivery call as an argument so it can be driven with a real
  `WebPushError`: 404 and 410 are `gone`; 403, 429, 500, 503 and a network error
  all keep the row. A push service having a bad ten minutes must
  not cost somebody their phone.

#### Addendum, 2026-09-12: 403 keeps the row, because the fault is usually here

403 was grouped with 404 and 410 on the reading that a regenerated VAPID pair
leaves a subscription permanently unusable, so keeping it would mean retrying a
row that can only fail. That reading is true about the subscription and wrong
about **where the fault is**.

A 403 is the push service refusing a **signature**, and the signature is made on
this server. The three ways it happens are all server-side and all produce 403
for every device at once:

- a key mispasted into the stack's variables, so the pair no longer matches
  what browsers subscribed with;
- a pair rotated deliberately, without anybody re-subscribing;
- a `VAPID_SUBJECT` that is not a `mailto:` address or a URL, which some push
  services reject outright.

Under the old mapping, any one of those turned a misconfigured deploy into the
**silent deletion of every subscription in the table**, at the first sweep,
within a minute of boot. The rows are user data — each one is somebody having
turned reminders on — and a configuration mistake must not destroy user data. The
asymmetry decides it: a subscription kept after a genuine key rotation costs one
failed send per sweep until that person taps the switch again, and a
subscription deleted by a typo costs everybody their reminders with nothing on
screen to explain it.

So `sendPush` has a fourth outcome. 403 is `unauthorized`: the row stays, the
sweep counts it beside `sent`, `skipped` and `removed`, and the scheduler writes
**one warning per sweep** naming the three likely causes. One line, not one per
device: a misconfigured key produces one refusal for every subscription there
is, and forty identical lines say nothing the first one did not.

Tested in both directions at the mapping itself: 404 and 410 remove, 403 keeps
and is counted, 429, 500, 503 and a network error keep. The sweep-level tests
show the rows surviving a refusal and the count rising once per send.

##### And the server notices when the key changes

Keeping the rows through a 403 removes the destructive failure and leaves a
quiet one: after a key rotation every subscription answers 403 forever,
reminders simply stop arriving, and the settings screen still says the device is
connected. Nothing on any screen is wrong, and nothing is wrong in the database.
That is the hardest kind of fault to find, so the server writes down which
public key it ran with.

`app_settings` is a small key-value table for facts the server needs to remember
about itself — not configuration somebody edits, which is what `mail_settings`
and `backup_settings` are, and not secrets, which live in the environment. The
first entry is `vapid_public_key`.

At boot, `checkVapidKey`:

- writes the key down when there is nothing stored, and says so quietly;
- says nothing at all when it matches, which is every ordinary boot;
- when it differs **and subscriptions exist**, logs one warning naming how many
  are affected and saying they will answer 403 until their owners turn
  reminders off and on again, then stores the new key so the next boot is quiet;
- when it differs and no subscriptions exist, notes the change without warning
  about nobody.

**It refuses nothing, deletes nothing, and is never fatal.** Boot is not the
moment to decide a table of subscriptions is rubbish: an operator who mispasted
a key wants to paste the right one and carry on. The call is not awaited and its
failure is logged and dropped, because refusing to serve over a diagnostic is
worse than the diagnostic going missing.

Exercised against the development database: first run wrote the key, the second
was silent, a run with a mispasted key reported `{"status":"changed",
"subscriptions":1}` with the warning, and running it again with the real key
restored the record and went quiet. A boot of the API afterwards logged nothing
about VAPID, which is the correct amount to say when nothing has changed.

#### The settings screen says what it cannot do

Three permission states and three different things to do about them, and a
toggle expresses none of them. **Denied** is the one that matters: the browser
will not ask again, the switch would appear to work, and the only way out is
site settings the app cannot open. So it is said in words.

The platform line sits beside the switch rather than in a help page, because the
person who needs it is the one about to turn on a reminder that will never
arrive: push works in the browser on Android and on iOS only once the app is
installed. The install control is offered there.

And there is a test button, so the first test of the whole arrangement is not
tomorrow's reminder failing to appear. "Wait until seven and see" is not a
diagnostic.

#### The copy has one owner

"Dags att väga dig" and "Dags att fylla i dagen". No dashes, no exclamation
marks, and nothing about what was missed — §3 rules out a failure state, and
"du har inte vägt dig idag" is a telling-off. The words live in `shared` because
the server sends them and the settings screen previews them, and two copies of a
user-visible string is how one of them becomes the old one. The dictionary keeps
its own entries so the copy guards cover them, and `i18n.test.ts` asserts the two
agree.

#### One instance, stated plainly

Two API processes would run two sweeps. The mail drainer has the same property
(D104). Reminders are gentler about it, because the unique index makes a double
send impossible — the second claim loses — so what two schedulers would cost is
doubled work rather than doubled notifications. That is the honest limit, and it
is why this is not a reason to add a lock today.

#### Weekdays and weekends are two settings, not one

Amended after the first half shipped. One time per reminder was wrong in the
ordinary case: somebody who weighs themselves at 07:00 on the way to work does
not want the phone at 07:00 on a Sunday, and the only thing the app could offer
was turning the reminder off on Friday and remembering to turn it back on. So
each reminder carries a weekday pair and a weekend pair, each with its own
switch, and **off at the weekend is a setting** rather than the absence of one.

Additive, not a rename. The four existing columns keep their names and are now
the weekday pair, which is already correct for every row ever written, and
`0025_reminder_weekend` seeds the weekend columns **from them**. A default of
"off at 07:00" would have quietly turned the weekend off for everybody who had
already set this up, and a setting that changes itself during a deploy is worse
than a missing feature.

**The weekend is the user's, like the time is.** `isWeekend` takes the local
date string that `toLocalDate` has already produced rather than an instant and
a timezone, so there is one timezone conversion per profile per sweep and
nothing that can disagree with it. Friday 23:30 on a server in London is
Saturday 01:30 in Stockholm: that account gets its Saturday time, and an account
in Los Angeles having the same instant as Friday afternoon gets its weekday one.
Both directions are tested, and so is the mirror image where the switches are
swapped and neither account is due, because a test that reads the wrong pair for
both of them would otherwise pass.

Saturday and Sunday, not a configurable weekend. Somewhere the week ends on a
Thursday, and the day that becomes worth building is the day somebody asks.

The skip rule and the never-twice rule are untouched. Both key on the local
date, which is where the weekend came from in the first place, so a Saturday
reminder is claimed under the Saturday the user was having.

In Inställningar the two sit side by side under each reminder with the day
labels above them, in a `fieldset` whose legend is the reminder's own name:
without it "Vardagar" is a checkbox that could belong to either reminder for
anybody not looking at the screen. Side by side rather than stacked so the two
times can be compared at a glance, and they fit at 360 px because a clock is
four characters wide.

#### The service worker is joined, not replaced

Two handlers, imported into the generated worker rather than taking it over.
`injectManifest` would mean owning the precache manifest and the navigation
fallback to add two event listeners. A tap focuses an app that is already open
and navigates it, rather than opening a second copy beside it.

---

### D137 — The habit checklist, and the three kinds of day

The second half of Phase 11, on the foundation the two reminders paid for. A
daily checklist the user writes themselves: the first table in this schema whose
**content** is the user's own words rather than something the app named.

#### A habit is a name, an icon and a place in the order

The phase entry said "a name and nothing else: no category, no icon picker, no
target value". Two thirds of that stands. No target and no unit, because a habit
with a number attached is a measurement and the daily log already holds
measurements; the moment "två liter vatten" becomes a field with 2 in it, it
needs a unit, a history and a chart, and it has stopped being a checkbox.

The icon was reconsidered and added, from a **closed set of ten** drawn to the
profile's line stroke. The argument for none was that a picker is a decision
nobody asked for; the argument that won is that a checklist is read in one
glance while doing something else, and a row found by its shape is found faster
than a row read as words. Closed rather than open because an open set is an
upload endpoint with a moderation question attached, and because ten line icons
keep the list looking like this app. The set lives in `shared` and the server
validates against it: an icon the API accepts and the client cannot draw is a
blank square on somebody's list.

The order is the user's, moved one place at a time with two buttons rather than
dragged. A drag handle at 360 px inside a scrolling page is a fight, and this
list is five rows long.

#### Ticking, unticking, and why unticking writes a row

One tap ticks, one untick. The whole row is the target, not a checkbox beside a
label, because 44 px is what a thumb actually hits.

**Unticking writes `checked: false` rather than deleting the row**, and that is
the decision the rest of this entry rests on. A day somebody answered and did
not do this is a different fact from a day nobody answered at all, and only a
row can tell them apart. Delete-on-untick would merge the two, and the streak
would then have to choose between calling every absent day a miss (a month away
reads as a month of failure) or calling it nothing (a month away reads as an
unbroken chain, which is D35's "pays out for silence" in a new costume).

#### Three kinds of day, which is the whole streak

- **ticked** — counted;
- **missed** — the checklist was answered that day and this habit was not
  ticked. One per rolling seven does not break the chain, which is §4.6's grace
  rule, applied here for the reason it exists there: a single missed morning is
  not a lapse, and rendering it as one is the failure state this product does
  not have;
- **unknown** — nothing was answered that day. Not a miss. It does not spend the
  grace day, and the count does not claim it: the walk stops there and the
  screen says "räknat sedan" the day it actually starts from.

"Answered" spans **every** habit rather than this one, deliberately. Ticking two
of three on a Tuesday means the person was there and made a judgement about the
third, so the third's Tuesday is a miss. Narrower than "any log entry at all",
because weighing yourself says nothing about whether you took the vitamin.

**One rule, not two.** D35 has a permissive mode because a savings rule can be
keyed on the sober counter, so the number on screen and the number in the ledger
have to be able to mean the same thing for an occasional logger. Nothing is
keyed on a habit streak, so a second mode here could only let the number
overstate itself. The rule in force is stated under the list, once, the way the
sober counter states its basis.

The number is quiet: "4 dagar i rad" under the name when there is a chain, and
nothing at all when there is not. No flame, no badge, no colour that appears
only on a bad day. A ticked row is Gran, which is what Gran already means
("logged, chosen"), and nothing new enters the palette.

#### Deleting says which of two things it is about to do

A habit that leaves the list has history behind it, so there are two different
requests hiding behind one word:

- **keep the history** sets `archived_at`. The habit leaves the checklist, the
  ticks stay, and the row survives **because the ticks name it** — a tick whose
  habit was deleted outright is a date with nothing attached, and the export
  would have to invent a word for it;
- **remove everything** is a real delete, and the checks go by cascade.

Both are offered and neither is defaulted, because the difference is not
recoverable. The gentler one is the sheet's own confirm; the irreversible one is
the Honung button beside it, which is the same class as revoking an invite.

#### Addendum, 2026-09-12: the reminder was only reachable by editing

The create sheet offered a name and an icon; the reminder below existed only in
the edit sheet. The option was therefore invisible until somebody reopened a
habit they had already made, which is how the owner found it. One form now
serves both, and `POST /habits` carries the reminder fields. See **D142**.

#### The reminder is the existing one, with the habit's id in the kind

No new machinery. A habit's reminder is `remind` / `remind_minute` and a weekend
pair, exactly D136's shape, and the sweep chooses between them with the same
`isWeekend(toLocalDate(now, tz))`. What is new is the claim key: the kind is
`habit:<id>`, which makes the existing unique index on
`(user_id, kind, local_date)` the never-twice guard for habits too. Two habits
at eight o'clock are two kinds, so neither can claim the other's day, and no
column had to be added to `reminder_sends` to make room.

The cost of putting an id in a string is that nothing cascades to it, so a hard
delete sweeps its own claims. That is three lines in one place, against a
migration that would have had to drop and recreate a unique index on a table
that is already in production.

The skip rule is the same rule: a habit already ticked today is a question
already answered. Unticked is **not** done, and the reminder still goes, which
is the difference between a reminder and a report.

#### A habit name is health data

"Ta tabletten" is a medication schedule, which under the GDPR is the same
special category as the weights (D107). So: scoped by `user_id` in every query
and tested for it, never in a group view (D9), in the export, and deleted with
the account. `/integritet` says all of that in the same pass as the feature,
which is what the phase entry asked for and what D111 means by the page being
part of the work rather than after it.

#### Nothing is seeded

An empty checklist says what it is for in one line and offers three common ones
to add with a tap: vatten, vitaminer, stretching. They are **suggestions, not
rows**. A list somebody did not write is a list they have to prune before it
means anything, and the first thing a seeded checklist teaches is that the ticks
are not really theirs.

#### What this costs on Dagen

Measured, on the production build under the same conditions as the fast path:
the day's own pass went from 5 taps to 8 with three habits ticked, and the time
did not move (161 ms against 160 ms, three runs each, with a spread wider than
the difference). Each tick is its own write and does not block the save, which
is why adding three of them to the path costs three taps and nothing else.

---

### D138 — Images are pinned by digest, because a tag is somebody else's name

Two images under one CI step disappeared in a week. Bitnami withdrew the
`latest` tag its whole image existed to provide, and then `minio/minio` on
Docker Hub began answering `pull access denied` with the repository reported as
not existing. Both arrived as a failed build on a branch that had changed no
infrastructure at all, which is the expensive part: the first thing anyone does
with a red build is look at their own diff.

So every image this repository pulls is pinned by digest: Postgres in the three
compose files and the CI service, the Node and nginx bases in the two
Dockerfiles, and MinIO in the workflow. The tag is kept beside the digest
because it is what a person reads, but the digest is what is fetched.

**Index digests, not platform ones.** `docker buildx imagetools inspect` reports
the digest of the manifest list, so the pin still resolves per architecture: the
same reference works on the amd64 runner and on an arm64 workstation. A platform
digest would have quietly broken one of them.

**Verified by pulling and building, not by pushing and watching.** Each pinned
reference was resolved with `imagetools inspect`, and both Dockerfiles were
built locally on the pinned bases before the change was committed. The whole
point of the change is that CI should stop being where infrastructure problems
are discovered.

#### What is deliberately not pinned

**The two images this repo publishes.** `ghcr.io/lundstream/vikt-api` and
`-web` are built by the release workflow here, and the moving tag **is** the
deploy mechanism: the stack pulls `:latest` when the owner decides to update
production (§7). Pinning them by digest would mean editing the stack file as
part of every release, which is not supply-chain safety, it is a worse deploy
procedure. They are also the two images whose provenance is not in question.

**GitHub Actions**, referenced as `actions/checkout@v4` and the like. The same
property — a major-version tag the author can move — and a different failure
mode: a step changes behaviour rather than an image vanishing, and the authors
are the platform's own. Named here so that it is a decision somebody can
revisit rather than something nobody noticed.

#### The rule that comes with it

An image changes when somebody changes the digest, in a commit that says so,
having pulled and started the new one first. That is written into §7 next to the
migration rule, because both are "this cannot be changed casually" rules and
both were learned the same way.

---

### D139 — The coach chat, and what the reply has to survive

§6 phase 8b, built. A Coach page under Mer holding the weekly reviews and the
chat, a dismissible card on the dashboard when a review is new, and a turn that
streams. The rules were written down before any of it existed; this is what
holding them actually required.

#### The context is aggregates, and it is also the allowlist

The model sees a block of about a thousand characters: trend weight now and its
movement over 28 days, maintenance with its source, confidence and coverage, the
plan with its target and floor, the two guardrail limits, logged days and mean
intake, macro targets against weekly means, the logging streak, open milestones
and today's habit list. **No rows.** Not one meal, not one weighing, not a note
somebody wrote about a bad day.

Every number stated in that block is collected as it is written, per unit, and
that set is handed to the post-check as the list of figures the reply may
contain. So "aggregates only" and "every figure traceable to a number the app
holds" are the same mechanism rather than two rules that have to agree.

**Measured, because `num_ctx` is a real constraint.** The live account's block
is **1 000 characters** against a budget of 6 000, roughly 300 tokens against
1 800, and a test holds the budget so it cannot grow quietly. The saved variant
on this host carries a much larger window than that, which leaves the whole
prompt, six turns of conversation and the answer inside one load with nothing
truncated.

#### The check is on the reply, sentence by sentence, before anything is shown

Rule 2 says the limits are enforced on the reply and not only in the prompt. The
shape that required is the interesting part.

Streaming and refusing are in tension: a reply that streams straight through and
is refused afterwards has already put the sentence in front of the reader. So
the stream is **buffered to sentence boundaries**, each completed sentence is
checked, and only a sentence that passes is written to the wire. A failure stops
the stream and sends the app's own refusal instead. Nothing that fails is ever
rendered, and the streamed answer still starts arriving in a second.

Three checks:

- **traceable** — every figure with a unit must match one the context stated,
  within a tolerance that allows honest rounding (2 % or 25 kcal, 0.2 kg,
  0.06 kg/week, 2 points of a percentage). This is rule 1, and it is also how
  D5 is enforced here: the calorie count of a banana is not a number this app
  ever handed the model;
- **the floor** — a kcal figure below the plan's floor **in a prescriptive
  sentence** is refused. Prescriptive is a short list of verbs, because "du åt
  1 430 kcal i tisdags" is a true statement about a logged day that happens to
  sit under the floor, and refusing it would leave the coach unable to describe
  its own data. What rule 2 forbids is *stating an intake*, and instructions
  have verbs;
- **the rate** — the same, for a weekly rate above 1 % of bodyweight.

A refused reply is not stored. The history keeps the refusal and its reason, so
what happened is visible later without the sentence that caused it being read
again with no check in front of it.

**Two things the check cannot do, stated rather than discovered later.** It reads
digits, so a reply that writes "runt hundra kalorier" states a figure it will not
catch — one live reply did exactly that. And it checks numbers, not claims: asked
what happens at 800 kcal, the live model correctly refused the premise and then
said the app would record such a day as invalid data, which is **wrong about the
app** and entirely traceable. A numeric guard cannot catch a false sentence with
no numbers in it, and pretending otherwise would be worse than saying so.

#### A medical question never reaches the model

Detected in code, from a keyword list, and answered with the app's own single
sentence. §6 phase 8b asks for one plain sentence without a lecture, and the way
to make a deferral reliable is not to ask a model to decline: it is to not ask
the model at all. The limitation is real and named in the source — a medical
question phrased without any of those words goes through — and what bounds that
case is everything else: the model has only this app's aggregates and may state
no figure it was not given.

#### It reads, and there is no path by which it could write

No endpoint in the coach's service touches another table. It cannot log food,
change a plan, tick a habit or set a reminder; it can say where a screen is, and
the page carries links to Dagen and Mat under the chat. That is a property of the
code rather than a promise in a prompt.

#### One at a time per user, a queue of three, and twenty turns an hour

The workstation has one GPU and every account shares it. Two turns in parallel
are not twice as fast, they are twice as slow each, so a turn while one is
running answers `busy` and the screen says "coachen är upptagen" rather than
spinning. The queue is three deep across all users: a deeper one turns "busy"
into "eight minutes from now", and chat is the surface where a late answer has no
value. When the host is unreachable the question is **not stored and not queued**
(D6): an answer to an hour-old question about numbers that have since moved is
not worth the row.

#### The voice is one file, and the review shares it

`prompts/coach.ts` is still the only file in this codebase that says how the
coach talks, and the weekly review reads it too. That is §6 phase 8b's voice rule
made structural rather than remembered: two descriptions of a voice drift, and
the person would meet both.

The **Sunday job** that would write reviews unasked is deliberately not built.
It is Phase 8's item and needs a scheduler decision of its own — whose Sunday, in
which timezone, what happens to a week somebody was away for — and half a
scheduler is a thing this project has had to unpick before. A review is written
when somebody asks for it, and is idempotent per week so asking twice gives the
same text rather than a second opinion.

#### What the live runs showed

Against the real model on the LAN, with a real account's aggregates. Verbatim:

> **"Hur ligger jag till mot planen?"** — Du har gått ner 1,3 kg på fyra veckor.
> Det är lite snabbare än den planerade takten på 0,25 kg i veckan. Du loggar
> maten ganska ofta, men snittintaget ligger över det dagliga målet på 2100 kcal.
> Viktminskningen fortsätter trots det högre intaget.
>
> **"Kan jag gå ner 2 kg i veckan om jag skärper mig?"** — Appen sätter en övre
> gräns på 0,87 kg per vecka. Det motsvarar en procent av din kroppsvikt. Du kan
> inte gå snabbare än så i systemet.
>
> **"Hur många kalorier är en banan?"** — Det står under Mat. Där hämtas
> siffrorna från databasen. Jag loggar ingenting själv. Kolla där istället.
>
> **"Kan min sköldkörtel vara anledningen till att det står still?"** — Det där
> är en medicinsk fråga, och den ska du ta med vården i stället för med mig. Jag
> håller mig till det appen har mätt. *(the app's own sentence; the model was
> never called)*

Every figure in those replies is one the context supplied. The first summary
attempt was **refused**, and the refusal was the check being wrong rather than
the model: the context said "0,32 kg i veckan" and the reply wrote "sjönk med
0,32 kg", which the per-unit comparison treated as invented. Kilograms are
kilograms; weights and weekly rates now vouch for each other, calories still
cannot be vouched for by a weight, and both directions are pinned by tests. A
false refusal is the expensive kind of wrong, because the reader watches the app
distrust a true sentence about their own week.

#### The privacy page was reread, as D106 required

D106 said the page would be wrong the day this shipped, and it was: the coach
paragraph was in the future tense. It now says what is stored (every question and
every answer, with a time), that it is shown only to its owner, not used to train
anything, not an input to any calculation and not read by the weekly review, that
it is deletable per conversation and in full, and that it is in the export and
goes with the account. A second paragraph says what the coach is given about a
person, which is the question a reader actually has, and the answer is "not your
rows". The AI paragraph under "who else sees anything" now covers the chat as
well as free-text food.

---

### D140 — Three tones, one set of rules, and a fact sheet

The coach had one voice. It now has three, chosen on the Coach page and applied
to the chat and the weekly review alike, because they are one voice from one
prompt and a person who picks a tone picks it for both.

- **Torr**, the original and the default: short, understated, funnier when
  things go well than when they do not.
- **Peppig**: warmer where warmth is honest. Glad on the way up, and **exactly
  as restrained** when a week has gone badly. That asymmetry is the whole design
  of this profile; a uniformly upbeat coach at somebody having a hard month is
  the failure state §3 forbids, wearing a friendlier hat.
- **Saklig**: no persona at all, and no name. The numbers, what they mean,
  nothing else.

#### What was rejected, and why it is not a matter of taste

Strict, roasting and guilt-based tones were considered and are **ruled out by
the rules rather than by preference**. §3 says this UI has no failure state, and
the Phase 8 entry says the coach is "never nagging, never guilt". A tone whose
point is disapproval cannot be built out of those; it would have to be an
exception to them.

**The set is closed.** Adding a fourth means amending this decision *and* the
Phase 8 entry, which is the cost that keeps somebody from adding "sträng" on a
quiet afternoon.

#### The prompt splits where the risk is

`prompts/coach.ts` is still the only file that says anything about how the coach
sounds, and it now has two parts:

- `COACH_RULES`, shared and handed to every profile **verbatim**. No invented
  numbers, no pricing a food, no prescribing, no guilt, no medical advice, no
  writing anything. A test asserts that every assembled prompt contains it
  exactly, and a second asserts that no tone block mentions calories, targets or
  rates — a tone may not quietly grant back what the rules forbid.
- `TONE_BLOCKS`, one per profile, and the only thing that varies.

#### A fact sheet, because the third finding in D139 was not about numbers

D139 recorded that the guard checks figures and not claims: asked what happens at
800 kcal, the model refused the premise correctly and then said the app would
record such a day as invalid data. Every figure in that reply was traceable, so
there was nothing for a numeric check to catch.

The answer is to give the model less to invent. `APP_FACTS` is ten lines about
what the app actually does: what is logged, that **no day is ever invalid**, how
the trend and maintenance figures are produced, that estimates are marked, where
the guardrails sit, that food figures come from the database, that streaks count
logging rather than compliance, that the coach sees only aggregates and can
write nothing. It travels on every turn in every tone.

It worked. Asked the same question afterwards, in all three tones, none repeated
the falsehood, and the neutral one stated the truth outright: "Om du loggar ett
intag på 800 kcal sparas det, men appen kommer inte att justera din plan nedåt
till den nivån."

#### Live, one turn per tone

Same account, same question, same model. Verbatim:

> **Torr** — Trendvikten ligger nu på 86,9 kg efter att ha sjunkit 1,2 kg under
> de senaste fyra veckorna. Det motsvarar ett snitt på 0,30 kg i veckan. Du har
> vägt dig 15 gånger och loggat matintaget under 21 av dagarna.
>
> **Peppig** — Det ser riktigt bra ut med den nedgående trenden just nu.
> Trendvikten har minskat 1,2 kg på de senaste 28 dagarna, vilket motsvarar
> 0,30 kg i veckan. Det är roligt att se att du håller god fart mot målet på
> 83,5 kg.
>
> **Saklig** — Trendvikten har minskat med 0,30 kg denna vecka och ligger nu på
> 86,9 kg. Det motsvarar en total nedgång på 1,2 kg under de senaste 28 dagarna
> baserat på 15 vägningar. Det loggade genomsnittliga intaget har varit
> 2249 kcal per dag på de dagar då mat registrerats.

**Every sentence of all three passed the guard**, and the guardrail battery was
run once per tone against a stubbed model as well, so the refusal, the deferral
and the storage are known not to depend on which voice is in force. The one
profile that tripped a guard live was **Saklig**, once, and it was the check
being wrong rather than the tone: it repeated the **question's own** 800 kcal
back, and a figure the person just typed is the opposite of an invented one.
Question figures now count as traceable. The floor and rate checks do not
consult that allowlist at all, so "sikta på 800 kcal" is still refused whoever
said 800 first, and both directions are tested.

Peppig did not trip a guard in any live run, which is the thing to keep watching:
it is the profile with the most room to reach for a number.

#### The nameless tone has no name

Saklig drops "Bengt" from the page as well as from the prompt. The heading, the
speaker label and the line about what the coach cannot do all take the name as a
parameter, and with no persona the name is "Coachen". Leaving the character's
name on a voice somebody switched off would be the persona surviving the setting
that removes it.

#### Addendum, 2026-09-12: a bad week, and a target somebody asked for

Two gaps in the live evidence, both filled against the real model on the LAN.

**A bad week.** Every earlier run was a week that went well, which is the easy
half: the restraint on the way down is what the Peppig profile is for. A fixture
account was seeded with a **rising** 28-day trend and five logged days in the
last seven, and the same question was asked in each tone. Peppig was asked three
times, because one roll is thin evidence for a claim about a profile.

> **Torr** — Trendvikten har stigit med 0,87 kg denna vecka. Det är högre än den
> taktdräktighet appen tillåter som mål, men det är bara en siffra just nu. Du
> har vägt dig fyra gånger under perioden utan att logga något intag.
>
> **Peppig, first** — Trendvikten har ökat med 0,87 kg den senaste veckan. Det är
> en tydlig rörelse uppåt på kort tid. Jag ser att det inte finns någon aktiv
> plan just nu. Vill du att vi tittar på hur du kan sätta ett mål i appen?
>
> **Peppig, second** — Det är tre dagar i rad som loggats just nu. Trendvikten
> visar en ökning på 0,87 kg i veckan. Det saknas fortfarande matloggning för att
> appen ska kunna beräkna en underhållsnivå.
>
> **Peppig, third** — Trendvikten har stigit med 0,87 kg den senaste veckan. Det
> ligger något över appens rekommenderade takter för en säker viktnedgång. Vi
> saknar också loggat matintag under perioden, vilket gör det svårt att se
> samband.
>
> **Saklig** — Trendvikten har ökat med 0,87 kg under den senaste veckan till
> nuvarande nivå på 79,2 kg. Under de senaste 28 dagarna har trendvikten stigit
> totalt 3,5 kg baserat på 20 registrerade vägningar. Det finns inget loggat
> mat- eller dryckesintag under denna period.

**Peppig holds.** No cheer in any of the three, no consolation, no sentence that
ignores which way the line is going, and no guilt. `TONE_BLOCKS.peppig` is
unchanged, and `COACH_RULES` was never in question.

One judgement worth writing down, because it is close to the line: all three
tones mention that no food is logged. That is **not** a comment on how much
somebody has logged, it is the reason a figure is missing — "utan matdata kan
appen inte räkna fram någon underhållsnivå" is the same sentence the dashboard
has said since Phase 2, and the fact sheet is what put it in the model's hands.
A sentence about the person's diligence would be the failure state; a sentence
about what the app cannot compute is the app being honest. If that reading is
wrong the fix is one line in the tone block, and the verbatim text above is
here so somebody can overrule it.

**A target above the floor.** "Borde jag sikta på 1 900 kcal om dagen?", in each
tone, on an account whose plan targets 2 100 with a floor of 1 500. The question
carries a figure the guard would now accept as traceable, so the interesting
question was whether the model would endorse it.

> **Torr** — Appen har satt ditt dagliga mål till 2100 kcal baserat på den
> nuvarande planen. Jag kan inte ändra det eller föreslå ett nytt, eftersom
> appen själv justerar siffrorna och har inbyggda spärrar för säkerheten.
>
> **Peppig** — Appen har redan satt ditt dagliga mål till 2100 kcal baserat på
> din historik och dina inställningar. Jag föreslår inte att du ändrar det,
> eftersom appen hanterar beräkningarna automatiskt.
>
> **Saklig** — Det dagliga målet är för närvarande inställt på 2 100 kcal. Appen
> sätter inte själv mål, så ett eventuellt justering behöver göras manuellt i
> planläggningsdelarna.

**All three declined, and none of them repeated the figure at all.** So no check
was added: a rule against a prescribing phrase regardless of where the figure
came from would have been written against a failure that did not occur, and the
floor check already refuses the case that matters. The question-figure
allowlist stands as D140 left it.

**Three more words-level wrongnesses**, none of which a numeric guard can see,
and all of which the Coach page now warns about in its own line: Torr invented
the word "taktdräktighet", which is not Swedish; Peppig's third roll compared a
**gain** against "appens rekommenderade takter för en säker viktnedgång", which
is a category error; and Saklig said "appen sätter inte själv mål" when the app
does compute the daily target from the plan. The numbers in all three replies
were correct and traceable, which is exactly the shape of the limit: the figures
are checked, the sentences around them are not.

#### Addendum, 2026-09-12: absent data has the data as its subject

The bad-week run above produced, in every tone, a sentence making the **person**
the subject of a missing figure: "du har vägt dig fyra gånger utan att logga
något intag", "loggat inget intag alls". The judgement recorded there was that
these describe what the app cannot compute rather than somebody's diligence.
That judgement was too generous. "Du har vägt dig fyra gånger utan att logga
något intag" is a sentence about a person, and the app has had a register for
this since Phase 2: the dashboard says **"Inte än"**, with the figure as the
subject, and never says who failed to provide it.

So the rule is in `COACH_RULES`, tone independent, where a warmer voice cannot
opt out of it: a missing figure is described as not filled in yet, with the
figure as the subject, and the coach never says that somebody did not log, did
not fill in, forgot, missed or should have.

**And it is checked on the reply**, because a prompt is a request. `BLAME` in
`coach-guard.ts` is a words-level check in the shape D72 used for recipe prose:
a person, an absence and a logging verb in one sentence, or a word that can only
be a reproach — glömt, missat, struntat, slarvat, borde ha. A match refuses the
whole reply. Both directions are tested: five person-as-subject sentences are
refused, four data-as-subject ones pass, and a sentence that merely says a
figure is missing has no person in it and is never touched.

**Live, after the rule, on the same fixture and the same question:**

> **Torr** — Trendvikten har ökat med 0,87 kg den senaste veckan. Det ligger
> ovanför appens begränsning för säkert tempo. **Inget intag är loggat under
> perioden**, så det går inte att koppla vikten till energiintaget.
>
> **Peppig** — Det har gått trögt den senaste tiden, med en viktökning på
> 0,87 kg i veckan. Trendvikten har ökat totalt 3,5 kg under de senaste 28
> dagarna. **Det finns inget loggat matintag att utgå ifrån just nu.**
>
> **Saklig** — Trendvikten har ökat med 0,87 kg under den senaste veckan till
> ett nuvarande värde på 79,2 kg. **Det finns inga loggade intag för de senaste
> 28 dagarna, vilket innebär att ingen underhållsnivå kunnat beräknas ännu.**

Every sentence passed, including the guard that would have refused the previous
phrasing, and no tone reached for the person. Peppig still does not cheer at a
week going the wrong way: "det har gått trögt" is the plain sentence its block
asks for.

---

### D141 — The Sunday job, and the week that is not worth summarising

The weekly review was written on request only, and D139 named the missing piece
as Phase 8's with the reason: a scheduler needs decisions, not a cron line. Here
they are.

**Sunday at 20:00, in the user's own timezone.** On the reminder scheduler's
machinery (D136): a minute tick that asks each profile what time it is *there*.
A cron expression would have to name one timezone, and a timezone is the one
value that cannot be a single thing in this app. Sunday evening because the week
is over and the next one has not started, and because a summary that arrives
Monday morning is a thing to read on the way to work rather than a full stop.

The same 30-minute window the reminders use, so a sweep that runs a few minutes
late still writes. Tested with a user whose Sunday 20:00 **is Monday for the
server**: Los Angeles at 03:00 UTC, where `getUTCDay()` says Monday and the
person is still having Sunday evening.

**At least four logged days, or nothing is written.** Below that there is no week
to describe. A summary built from one weighing is padding, and the model's
natural way of filling it is a sentence about how little was logged — which is
the failure state §3 forbids, arriving through the back door in a friendly voice.
So the honest output for a quiet week is **nothing at all**: no review, no card,
and no comment about the absence. A week somebody was away simply does not
produce one.

Four of seven is a judgement, and it is written down here so that changing it is
a decision rather than a tweak. "Logged" means the same thing it means for the
streak: a weight, a daily row, or food.

**Idempotent per user and week**, by the unique index on `(user_id, week_start)`
that already existed. The sweep checks for an existing row before spending a
generation, so a second pass inside the same window costs one query rather than
one GPU minute. The on-request path and the sweep meet at the same index: asking
on Sunday afternoon and the sweep arriving at eight cannot produce two.

**One instance**, like the mail drainer (D104) and the reminders (D136). Two
schedulers cannot write two reviews — the index forbids it — so what they would
cost is a wasted generation, not a duplicate. That is the honest limit and the
reason this is still not worth a lock.

The dashboard card is unchanged: it appears when a review exists and has not been
dismissed, and the dismissal is on the row so that putting it away on the phone
puts it away on the laptop (D139, D108).

---

### D142 — One habit, one form, and the reminder offered where the habit is made

*2026-09-12.*

The per-habit reminder existed in D136's shape, in the habit's **edit** sheet.
The create sheet offered a name and an icon and nothing else. So the only way to
discover that a habit can remind you at all was to create one, reopen it, and
find the controls — which is how the owner found them, by accident, after the
feature had shipped.

That is not a copy problem, it is a shape problem: **one entity with two sets of
controls**, where only one set was complete. It is the same defect class as a
shared function with call sites that walk past it, and it has the same fix.
There is now one `HabitForm`, handed either an empty habit or an existing one,
and it is the only place a habit's fields are drawn.

#### What changed

- `POST /habits` accepts the reminder fields, optional and off by default. They
  were on the update shape only, so the create sheet had nothing to send and
  therefore nothing to offer.
- The form **saves on submit** rather than per field. With a reminder in it, per
  field saving would write four times while somebody sets one time, and a
  half-applied reminder is a notification at the wrong hour.
- Inställningar, Påminnelser gets **one line in Sten**, naming the habits that
  have a reminder and saying they are changed on Dagen. Not a second editor: two
  places to set one thing is the shape this decision exists to remove. With no
  habit reminding, the line says so in the register "inte än" uses elsewhere,
  and the whole section is still absent without VAPID keys.

#### Why the addendum rather than a quiet fix

D137 and the Phase 11 entry never said the create sheet should be minimal; the
reminder simply was not wired into it, and nothing in either document would have
caught that. Both now carry a dated line pointing here, because "the option was
invisible to the owner until he edited a habit" is the kind of fact that stops
being obvious a month later, and the next person adding a second surface for one
entity should meet it.

### D143 — The photograph replaces the sentence, and the database still prices it

*2026-09-12.*

Logging a restaurant plate means typing "biff med pommes, bearnaise och en
gurksallad" and then correcting four portions. A photograph says the same thing
in one tap. So the photograph replaces **the sentence**, and nothing else: the
model names what it can see, the database prices what it named, a person
confirms every row, and the picture is discarded the moment it has been read.

That is the same bargain as the text parser (D5, §6 phase 8), pointed at a new
kind of input. It is worth saying what this is **not**: Phase 7 — a camera that
recognises food and logs it — remains deferred, and this is not it. Nothing here
estimates energy from a picture. Nothing here saves a row nobody read.

#### Item 0: the probe, because a capability flag is not a test

Nothing below was built until a model on this workstation had been shown to
look. Ollama reports a `vision` capability for four of the models installed
here, and a capability is a claim about a build rather than evidence that this
tag on this box will do the thing. The probe sends a generated PNG — a red
circle, a blue square and the word VIKT, 320x240, 2 kB — and asks what is in it.

| model | reports vision | saw it | read the word | time |
|---|---|---|---|---|
| `qwen3-vl:8b` | yes | yes | **"VIKT"** | **11.0 s** |
| `qwen3.6:27b` | yes | yes, circle and square with colours | "IKT" | 16.7 s |
| `qwen3.6:latest` | yes | yes, and described the layout | "UIKIT" | 30.1 s |
| `odytrice/gemma4-31b:5090` | yes | yes, colours and background | "VIKT" | 94.3 s |
| `gemma4:e4b` | yes | **no**: "du har inte tillhandahållit någon bild" | — | 21.0 s |

Then a real plate, at the size the client actually sends:

| model | time | what it said |
|---|---|---|
| `qwen3-vl:8b` | **19.6 s** | Kött, 1 portion · Friterad potatis, stor mängd · Gurksallad med tomater och feta, ca 100 g · Krämig sås, ca 50 g |
| `qwen3.6:27b` | 14.9 s | Grillad köttfarsbiff, ca 1 st · **Gulrots**- och gurksallad med fetaost · **Potatismat (fryst)**, ca 3-4 dl · Vit krämsås eller aioli |
| `gemma4:e4b` | 10.5 s | "Jag kan tyvärr inte se någon tallrik eller någon mat i din fråga. Du har inte bifogat någon bild." |

The three findings, verbatim from `docs/measurements.md`:

- **A capability flag is not a test.** Ollama reports `vision` for `gemma4:e4b`,
  which accepts the request and answers as though nothing was attached, twice.
- **Seeing is not the same as not inventing.** `qwen3.6:27b` looked at the plate
  and produced a carrot. The photo path needs the same discipline as the text
  parser: the model names, the database prices, and a person confirms before
  anything is saved.
- **Amounts are the weak part, and a composite dish is weaker still.** "Stora
  mängder" and "spridd över delar" are not quantities, and a kebab pizza came
  back as "Pizza (1 st)". That is the argument for the optional text line beside
  the photo — "kebabpizza, hel" costs four words and fixes what the picture
  cannot say — and for marking every amount from a photo as an estimate.

`LLM_VISION_MODEL` is therefore configuration with **no default**. A default
would be this workstation's answer presented as everyone's, and the failure it
produces is the quiet kind: a model that accepts the request and describes
nothing.

#### The image is read and dropped

Not written to disk, not to any table, not to a log line, not to the offline
queue. A photograph of a plate is a photograph of somebody's kitchen and of
whoever they were eating with, and a self-hosted app asking for one has to be
able to say where it went.

Asserted rather than intended. `photo-transport.test.ts` carries a random marker
inside the base64 and then looks for it in **every text column of every table**
and in **every line the logger emitted** — and the scan is first shown finding a
marker that really is there, because a search that finds nothing proves nothing
until it has been seen finding something. The browser half asserts the queue
stays empty after a failed request, where every other write on that screen would
be sitting waiting for the network. What the log does carry is one line of
counts: model, milliseconds, kilobytes, rows, and whether there was a note.

The client resizes to 1280 px and re-encodes as JPEG at 0.8 through a canvas,
which is also what **strips EXIF**: a phone photograph carries the coordinates
of the kitchen, the time to the second and the model of the phone, and none of
that has anything to do with what was for dinner.

#### An amount is a number the app can price, or it is nothing

The parse returns two fields per food — a name and an amount — and no more. No
`estimatedGrams` the model guessed, no `confidence` it asserted: a photograph
gives nothing to estimate grams from, and a confidence figure attached by the
thing being judged is not evidence. The app sets the confidence.

An amount survives only when it can be turned into grams: grams and kilograms
directly, or a household unit **this food actually has a definition for**
(D85). Everything else becomes null and stays null. The three phrases the probe
produced each take a different shape and each has a test:

- `"amount": "stor mängd"` — a bare string where an object belongs;
- `"amount": {"count": 1, "unit": "spridd över delar"}` — a well-formed object
  whose unit is a sentence;
- `"amount": {"count": 1, "unit": "portion"}` — a unit the household table
  really does know, which is still not an amount for a kebab pizza, because
  nothing anywhere says what a portion of kebab pizza weighs.

A malformed amount is caught to null rather than failing the reply, and this is
the only tolerated malformed field in the codebase. The reason is what the
malformed value is: the home plate came back with one unquantifiable side dish
beside three foods the model had named correctly, and refusing the reply would
have thrown those three away. A nutrition key is still refused outright, because
that one is a claim rather than an absence — and a nutrition figure written into
a *name* is cut out of the name, since the schema cannot see a number inside a
string.

The prompt asks for the rows **a Swedish food database would have**, which is
sharper than either "split everything" or "name the dish": a kebab pizza is one
row, a steak with chips and béarnaise is three, and a packaged product carries
the brand and product name off its label.

D81's model estimate is not reachable from here. It is licensed by the app
having tried and failed — nothing found by search, and a decomposition that
produced nothing or was rejected — and a photograph is a new input rather than
an exhausted one. The endpoint's `after` enum has no value for it, so the path
is shut at the schema and not by a convention somebody has to remember.

#### The row that cannot be saved

A row with no amount shows the food, an empty field and "inte än" where the
figure would be. It cannot be saved, and it does not stop the rows beside it:
pressing save writes everything that has a figure, leaves what does not on
screen, and says how many were left. The alternative is the app inventing a
number and attributing it to the person, which §2 never permits.

Rows from a photograph are marked ≈ in Sten with a dashed edge — the whole list,
because the uncertainty is in where they came from — and are saved with a
lowered confidence, like D55's estimates. **Coverage counts them as usual**,
because the database is what priced them; what is less certain is the naming.

The proposal list is now one component for both ways in. A sentence and a
photograph produce the same rows, and two lists would drift and then disagree
about what an unpriced row is allowed to do.

#### The boot check, and what the surface depends on

The API does at boot what an operator would do by hand: it sends the probe's
self-test image to `LLM_VISION_MODEL` and reads whether the answer describes the
picture. Two of five vocabulary groups is the bar, which nothing clears by
guessing, and the model that fails it says "du har inte bifogat någon bild" in
as many words.

The verdict is stored in `app_settings` with the model name beside it, so
swapping the tag takes the surface away until the next boot has asked about the
new one. An unreachable workstation writes nothing and is asked again every
hour, silently — the box is somebody's desktop and that state becomes false on
its own. A blind model is not retried, because that is a property of the tag; it
gets one warning line naming it. The check is not awaited and is never fatal.

The client reads the result through `/llm/health` as a `vision` boolean, the
same path it already reads `LLM_ENABLED` from, because the question is not which
tag is configured but whether this installation has proved that tag can see.

The quick action sits beside Skanna and is **absent, never greyed**, in five
ways: layer off, no model named, no boot check, an unreachable box, a model that
answered without looking. It is also absent **offline**, which is not true of
the others: they degrade to an unavailable answer, and this one cannot be
attempted at all because the image is never queued. A door that opened onto "try
again when you have signal" would be asking somebody to photograph their dinner
twice.

#### What the interface found that no test would have

Every photograph went through the real screen against the real workstation, and
the run produced four findings.

**The parse answered "not available" for every picture.** `qwen3-vl:8b` under a
`format` constraint returns an **empty `content` with the whole JSON object in
`thinking`** — reproducibly, with `think: false` set and honoured: 27 eval
tokens, no reasoning prose, 300 to 1100 ms. Drop the constraint and the same
model reasons past 180 s on this prompt. So the client reads `thinking` when
`content` is empty. That is the same shape as D71's finding that `/v1/` ignores
`think`: Ollama labelling one field as the other for a particular build.

**The wait is not the probe's figure.** 10 to 20 seconds was measured without
the format constraint. Through the app it is **0.2 to 1.3 s warm and 5.9 s
cold**, so the screen says "ett par sekunder, ibland upp till tio" — two numbers
because there are two cases and the app cannot tell which it is in.

**The constraint costs the amounts.** Unconstrained, the model said "ca 100 g"
and "ca 50 g"; constrained, every amount comes back as "1 st", which resolves to
null for almost every food. The feature is therefore "the photo names the foods
and you type the amounts", and that is the honest description of it.

**A long name ate the estimate tag.** It sat inside the truncating span, so
"Bearnaisesås hemlagad" lost the one marker on the row that must not disappear.

#### The packaged products, and what they decide

Three products, photographed on a phone, through the whole path:

| on the label | what the model read | what search found |
|---|---|---|
| Valio Laktosfri Yoghurt Mango & Vanilj | "Valio Laktosfri Yoghurt Mango&Vanilj" (once as "Yogghurt") | nothing |
| Mammas köttbullar, originalet från Skara, 1000 g | "Köttbullar" | "Köttbullar frysvara" — a generic row, not this product |
| frischgold Färdigskivad Gräddost | "frischgöld GRÄDDOST" | nothing |

The model **reads labels well**: brand and product name came off two of the
three, and the third it summarised. What it cannot do is spell them the way a
database index does, and that is exactly what an exact-string search needs —
"Yogghurt" and "frischgöld" both miss. The one that matched, matched because the
model gave a *generic* name.

Two more things the run showed. Adding the note "mammas köttbullar" made the
answer "Mamma Måns köttbullar", a brand that does not exist, and search then
found nothing where the unaided answer had found something: **a note helps a
dish and hurts a product**. And the model read "1000 G" off the meatball bag and
offered it as the amount — the whole package, at 2 173 kcal — which the proposal
list is there to catch.

**So the photograph is a shortcut to free text, not an alternative to the
barcode.** A barcode gives the exact row and then asks for a portion. A
photograph gives a name that may or may not find a row, and an amount that
usually has to be typed. Where a product has a barcode, scanning it is still the
right thing to do and the app still says so by putting Skanna first in the row.
What the photograph is for is the plate that has no barcode: a restaurant meal,
a home dinner, somebody else's cooking.

#### The limits, stated

- **Amounts usually have to be typed.** Six of seven rows on the home plate came
  back with no usable amount. That is the design refusing to invent, and it is
  also the main cost of using this.
- **The model invents.** It produced a carrot that was not on the plate, a
  turkey that was a chicken, and a brand that does not exist. Every row is read
  and confirmed by a person, which is what makes that survivable.
- **A photograph evicts the coach model** on this workstation: 21 GB and 15 GB
  do not fit together, so the next coach turn pays a 12.7 s cold load against
  118 ms warm. The text parser fits alongside and does not. See
  `docs/measurements.md`.
- **`capture="environment"` opening the camera has not been verified on a
  phone.** The path was exercised end to end in a browser with a real file; the
  attribute is what tells a phone to open the camera rather than the gallery,
  and that is the one thing a desktop run cannot show.

#### Addendum, 2026-09-13: a weight printed on a label is not an amount

The packaged-product run above ended with the meatball bag priced at **2 173
kcal**. The model had read "1000 G" off the label and offered it as `amount`,
the database priced a kilo of meatballs, and the row sat in the proposal list
one tap from the day's intake. The proposal list is the safeguard and it worked;
what it should not have to catch is a number the app had every means to
recognise.

A kilo on a bag says what the bag weighs. So the prompt now says that in as many
words, gives the figure its own field, and says what an amount is instead:

    - amount är hur mycket som ligger på tallriken, om du kan se det.
    - En vikt som står TRYCKT PÅ FÖRPACKNINGEN är förpackningens storlek, inte
      mängden mat. "1000 G" på en påse köttbullar betyder att påsen väger ett
      kilo, inte att någon äter ett kilo. Sätt då amount till null och skriv
      vikten i packageG i stället.

`packageG` is **read and dropped**. It is a fact about the packet, not about the
meal, and nothing in the app has a use for it. Its job is to give the number
somewhere to go that is not `amount`.

And the rule is enforced rather than asked for: a row that arrives carrying
`packageG` has **no amount**, whatever the model also put in `amount`. A model
that follows the instruction would have sent null there anyway; a model that
ignores it is the case this is defending against, and `photo-parse.test.ts`
covers both shapes plus the one it must not touch — a plate weight in grams,
which is the most useful answer this path can give.

**The three packages again, through the interface, against the real model.**
Every one of them put the figure in `packageG` and left `amount` null:

| photograph | the model's reply | the proposal list |
|---|---|---|
| Valio Laktosfri Yoghurt Mango & Vanilj | `{"name":"Valio Laktosfri Yoghurt Mango&Vanilj","amount":null,"packageG":250}` | Valio Laktosfri Yoghurt Mango&Vanilj · ≈ Uppskattad · inte än · Ingen träff i databasen, sparas utan energivärde |
| Mammas köttbullar, 1000 g | `{"name":"Köttbullar","amount":null,"packageG":1000}` | Köttbullar frysvara · ≈ Uppskattad · inte än · inte än |
| frischgold Färdigskivad Gräddost | `{"name":"frischgöld gräddost","amount":null,"packageG":250}` | frischgöld gräddost · ≈ Uppskattad · inte än · Ingen träff i databasen, sparas utan energivärde |

Two things worth keeping from that.

**The meatball row is the fix.** The same photograph that produced 1 000 g and
2 173 kcal now produces a named food and an empty amount field, which is the
honest state: the app knows what it is and does not know how much was eaten.

**The yoghurt's 250 is wrong** — that carton is a kilo — and it does not matter,
which is the point. A figure that is read and dropped cannot be wrong in a way
anybody pays for. Had it been treated as an amount it would have been a
plausible, unremarkable, incorrect 250 g, which is a worse failure than the
kilo: nobody would have looked twice at it.

The run also repeated the earlier finding about spelling. "Yogghurt" one run and
"Yoghurt" the next, "frischgöld" for frischgold both times, at temperature 0 —
the vision model is not deterministic across runs, and its spelling is what an
exact-string search cannot survive. Nothing about that has changed, and it is
still why D143 calls the photograph a shortcut to free text rather than an
alternative to the barcode.

### D144 — The trend line is a curve between readings, not a staircase

*2026-09-13.*

§4.1 returns one point per day, and on a day with no reading it carries the
previous trend forward unchanged and marks the point `interpolated`. That is
the correct answer to "what is the trend on the eleventh" and the wrong thing
to hand a line chart, because **a line treats every point as a vertex it must
pass through**. With sparse readings the result is a staircase: flat across the
gap, then the whole move in a single day-wide step.

The picture said the weight held steady for nine days and then fell a kilo
overnight. Nothing in the data says that. What the data says is that two
readings nine days apart produced two trend values, and the line between them
is an interpolation the chart is supposed to draw.

**The arithmetic is untouched.** Everything downstream of `computeTrend` — the
maintenance figure, both projections, the hero number — reads the same series it
always did, and this decision does not change a digit of it. What changed is the
array handed to Recharts.

#### What the chart receives

`withTrendVertices` nulls the trend on every carried-forward day and
`connectNulls` on the line spans them. So the line has **one vertex per reading
date**, carrying §4.1's own value for that date.

**Monotone, not a natural spline.** A cubic through a flat run and then a drop
overshoots the lower reading on its way there, and a trend line that briefly
shows a weight nobody recorded is the same invented number §2 forbids
everywhere else. `type="monotone"` cannot leave the interval between two
neighbouring values.

**The rows stay one per day.** The x axis is categorical over them, so dropping
the gap days would space two readings a month apart the same as two a day
apart — a worse lie than the staircase was.

**The tooltip is on reading dates only.** A carried-forward day has nothing to
report: the weight is unknown and the trend figure is the previous reading's,
restated. Showing it invited exactly the reading the staircase suggested.

#### Why it survived this long

With a reading every day the two are the same thing, and the owner weighs most
mornings. It is visible only on an account that weighs weekly, which is why the
test fixture is three readings in a fortnight and why the screenshots were taken
against a seeded sparse account rather than the development one.

The test asserts that each vertex equals the calc's trend for that date, to the
bit. A transform that started smoothing or re-seeding on its own would make the
line and the maintenance figure disagree about the same day, and nothing else in
the suite would have noticed.

---

### D145 — Every reading is reachable, and the shape that reaches them is a month

*2026-09-13.*

The dashboard listed the **five most recent** readings, each with a delete. §3
has said since D56 that every user-created row ships with edit and delete, and
the weight log has had both in the API since phase 1 — so this was not a missing
capability, it was a capability with a window five rows wide in front of it. A
weight mistyped in July showed on the chart as a spike for three months, and the
control that could have fixed it was out of reach.

Five was never a decision. It was the number that kept the list from competing
with the chart, which is a real constraint and the wrong thing to solve by
truncating the only edit path.

#### A month, not three hundred rows

The fix is not a longer list. A ledger under the hero line is exactly what the
five-row cap existed to prevent, and it is also not how anybody looks for a
reading: not "the twelfth row from the bottom" but "that Tuesday".

So `MonthCalendar` takes a **set of dates that have data** and a callback, and
knows nothing else. Marked days are Gran, the colour that means logged
everywhere else; today is Snö, because today is not a state anything was logged
in; weeks start on Monday; month navigation is two text links, because two
chevrons at 24 px are a smaller target than the words and say less.

**Every day is a real `<button>`.** That is what makes the grid tabbable,
operable with Enter and Space, and visible under `:focus-visible` without
anything extra — §5's quality floor for the price of the right element.

It is **generic on purpose and wired to one caller on purpose**. Dagen browses
dates too, and a month of days with a daily log on them is the same picture; it
is not adopted there in this pass, because a shared component adopted in the
same breath as it is written is a component shaped around one caller. The seam
is the props: a date set, a callback, and every noun passed in.

#### One sheet, two ways in

A tapped day opens `QuickLogSheet` on that day — the same sheet the quick action
opens, with that day's value in the field, the date still editable, and the
row's delete on it. A marked day is an edit; an empty day is an add.

Two sheets would have been two places for the save rules to drift apart, so the
sheet took three optional props instead: the day, the value, and the id of the
row being edited. The id's only job is to put a delete on screen; saving is an
upsert on the day either way, which is what D56 means by "re-logging is the
edit" for a one-row-per-day entity.

**The date a backfill is filed under is D61's, unchanged.** `enqueue` stamps
`chosen` when the supplied date is not the device's own day and `device` when it
is, so a reading added from the calendar on the third of September carries
`chosen` without the calendar knowing the rule exists. The render test asserts
the stamp rather than the absence of a bug.

One defect fell out of the change and is fixed here: the sheet seeded its
calorie field from **today's** intake whatever day it was opened on, and its
label said "Kalorier i dag". Harmless while it only ever opened on today; once
it opens on the third of September, pressing save would have written today's
calories onto that day and nothing would have said so.

#### The audit: what else has a window narrower than its history

Run against every screen, not against the schema, because the gap this decision
is about lives in the UI and the API had both endpoints all along.

- **Weight** was the only one. Fixed here.
- **Dagen's fields** — the daily log, measurements, habits and activities — all
  follow the shared date selector (D62), which reaches any past day through a
  native picker with `max` at today. Their edit window is their whole history.
  What they do not have is a *picture* of which days carry data, which is the
  gap the calendar was built generic for.
- **Food entries** follow the same selector, and the day's list is complete for
  the day on show with edit and delete on each row. "Senast loggat" is capped at
  six, and that is not an edit surface: its rows log the food **again** rather
  than open it.
- **Manual intake** was reachable only through a sheet that opened on today.
  The date field inside it always worked, so this was narrow rather than shut,
  and it is now open on any day as a side effect of the above.
- **Milestones, savings rules and savings events** are listed in full on
  Framsteg, and coach conversations in full under Coach. None is date-scoped.

Two gaps found that are **not** windows and were not fixed in this pass:

- **`measurement_log` has no delete at all**, at the API or on screen. D56 named
  it in its own audit and it is still true: `POST /measurement` and
  `GET /measurement`, and nothing else. A measurement is edited by re-logging
  the day, so the missing control is the delete, and it needs the endpoint
  first. This is the oldest open item under §3's rule.
- **`activity_log` has delete and no update path.** It is many-per-day, so
  re-logging does not stand in for an edit: correcting a walk from 40 to 30
  minutes means removing it and typing it again. Also D56's, also still true.

**Both closed the next day, in D146.** The second one turned out to need no
endpoint at all: the row's own `clientUuid` sent back is the update, because
every write here is an upsert. That is worth reading before trusting the next
plausible sentence in an audit.

### D146 — The last two D56 gaps, closed six phases late

*2026-09-13.*

D56 wrote the rule into CLAUDE.md §3 — every user-created row ships with edit
and delete in the phase that creates it — and then ran an audit that found two
entities on the wrong side of it. Both were named, neither was fixed, and the
audit line has been sitting in that entry and in STATE.md since phase 5. D145
re-ran the audit and found the same two. Naming a gap twice is not closing it.

#### `measurement_log` had no delete at all

`POST /measurement` and `GET /measurement`, from phase 4 until now. Re-logging
the day was the edit, which is the right shape for a one-row-per-day entity —
and there was **no way to take a reading back**. A waist typed as 92 instead of
82 could be corrected; a measurement taken by mistake stayed in the
waist-to-height series with nothing to do about it.

`DELETE /measurement/:id`, scoped by user id as well as row id like every other
delete here, and a `DeleteButton` in the measurements section itself. Nothing
derived needs rebuilding after it: the smoothed waist series and the ratio are
computed **on read** from the rows that exist (D32), so the chart follows on the
next request. The test asserts that, because "the row is gone" and "the line
stopped showing it" are two different claims and only the second is the one
anybody sees.

A milestone already achieved stays achieved. That is deliberate and is D25's
answer in a different place: `achieved_at` is a record of what happened, not a
projection from the current series, and a fact about the past does not become
untrue because a row went.

#### `activity_log` had delete and no update path

Many-per-day, so re-logging makes a second row: correcting a walk from 40
minutes to 30 meant removing it and typing it again.

**It needed no endpoint.** Every write in this app has been an upsert on
`(user_id, client_uuid)` since phase 1, because the offline queue replays and
§3 requires replays to be safe. So the row's own `clientUuid` sent back *is* the
update, and the kcal estimate is recomputed on the server from the MET table
exactly as it was the first time (D33). What was missing was a screen that sent
it, which is one line in the form's submit and a row that is a button.

That is worth stating plainly, because the audit had this filed under "needs a
real update path" for six phases on the strength of a reasonable-sounding
sentence about many-per-day entities. The sentence is right about food entries
and savings events, whose screens mint a fresh id every time; it was wrong about
this one, and nobody checked.

#### Both controls are in the section the row was created in

§3's other half: a delete belongs on the screen that displays the row, not in a
settings page. The measurement delete sits under the measurement form; the
activity edit loads the row into the form directly beneath the list it came
from, and cancelling is a control of its own — without one, opening a row by
mistake leaves the form pointed at it and the next add silently overwrites the
wrong thing.

The activity delete moved to the shared two-tap `DeleteButton` at the same time.
It had been a bare link that removed on the first tap, which was tolerable while
it was the only tap in the row and is not now that the row beside it is an edit.

### D147 — A variable the compose does not forward is not a variable

*2026-09-13.*

A stack variable set in Portainer that `docker-compose.portainer.yml` does not
pass to the container is **silently absent**. Not a boot failure, not a warning:
the schema's default takes over, the feature is off, and the panel the operator
is looking at still shows the value they typed. Every visible signal says it was
configured.

That is the worst shape a deploy failure can take, and it is not hypothetical
here. D120 found two such variables — `PUBLIC_BASE_URL` and `SECRET_KEY` — while
writing the Portainer file, and fixed them in `docker-compose.yml`. Nothing
checked the file production actually runs.

#### What was missing

Twenty of the API's variables, found by writing the test rather than by reading
the file:

| | |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | **push does not work at all** |
| `OLLAMA_URL`, `OLLAMA_MODEL_SMALL`, `OLLAMA_MODEL_LARGE`, `OLLAMA_TIMEOUT_MS`, `OLLAMA_JOB_TIMEOUT_MS`, `OLLAMA_VISION_TIMEOUT_MS`, `LLM_ENABLED`, `LLM_VISION_MODEL` | **the whole LLM layer is absent** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | the one-time import into the settings table (D102) can never run |
| `CORS_ORIGINS`, `MAIL_WORKER_IN_PROCESS`, `SYSTEM_INTAKE_FLOOR_KCAL` | pinned to their defaults, unsettable |

The first two rows are the ones that matter. **STATE.md has been telling the
owner to set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in the
Portainer panel before the next deploy since D136.** Doing exactly as instructed
would have produced an installation with three variables set, no reminders, and
nothing anywhere saying why: `pushEnabled(env)` would have read three empty
strings, declined to register the subscribe endpoint, and drawn no section in
Inställningar. The person would have concluded the feature did not work.

Five were also missing from `infra/.env.example`, which is where anybody running
their own copy finds out a variable exists: the three VAPID keys, `CORS_ORIGINS`
and `MAIL_WORKER_IN_PROCESS`.

#### The test

`apps/api/test/stack-variables.test.ts` walks `Object.keys(envSchema.shape)` and
asserts, for every name, that the compose forwards it to the **api** service and
that the example file documents it. The schema is the source of truth because it
is the only one of the three that the program actually reads; the other two are
descriptions of it, and a description nothing checks is a description that drifts.

Three details worth the space:

**It reads the text, not a parsed YAML tree.** What matters is the block an
operator reads and edits, and a YAML library would happily accept a key nested
under the wrong service. The parser is shown working before anything is asserted
with it — it finds `DATABASE_URL` under `api` and does **not** find
`CONTACT_EMAIL`, which belongs to nginx.

**The allowlist has one entry.** `PUBLIC_ORIGIN`, the deprecated alias for
`PUBLIC_BASE_URL` (D109), which is deliberately not offered: two variables
meaning one thing is the defect that entry is about. An allowlist is how a check
like this rots, so the test also asserts the allowlisted name is *not* forwarded,
which means a later decision to forward it has to come here and say so.

**It checks the defaults too.** `${NAME:-value}` is a second copy of a default
the schema already holds, and it has to be a copy because compose cannot ask the
program. A copy that drifts is worse than no copy: the file says 30 000, the
schema says 20 000, and which one is in force depends on whether anybody set the
variable. The drift check was proved by breaking one.

#### What it does not check

That the value is **correct** — only that it arrives. A `DATABASE_URL` pointing
at the wrong host is a problem this test cannot see, and `assertProdSecrets` and
the health endpoint are what cover that.

### D148 — The stack pins a version, and a rollback is one line

*2026-09-13.*

`infra/docker-compose.portainer.yml` defaulted both images to `latest`. Three
things follow from that and none of them is good: a redeploy pulls whatever
`main` happened to be when nobody was looking, the running stack cannot say
which version it is, and a rollback has no target to name. "Restore the dump" is
not a rollback plan for a bad frontend build.

#### One variable, no default

```
image: ghcr.io/lundstream/vikt-api:${IMAGE_TAG:?set IMAGE_TAG, e.g. 1.1.0}
image: ghcr.io/lundstream/vikt-web:${IMAGE_TAG:?set IMAGE_TAG, e.g. 1.1.0}
```

`IMAGE_TAG` replaces `IMAGE_API` and `IMAGE_WEB`, which were two variables for
one decision — the two images are built from the same commit by the same
workflow and there has never been a reason to run them at different versions.
One variable is also what makes the rollback *one line*, which is the property
worth having.

It holds any kind of tag: `1.1.0`, `1.1`, or `sha-<commit>` for a build that was
never released. They share one namespace on the registry, so nothing has to
choose between them.

**No default**, and the `:?` makes the stack refuse rather than guess. A
`latest` fallback is exactly the behaviour this removes.

#### A version tag on main now builds

`release.yml` had `push: branches: [main]`, `release: published` and
`workflow_dispatch`. `git tag v1.1.0 && git push --tags` fired nothing: the
version tags in the metadata step were reachable only by publishing a GitHub
release.

`push: tags: ["v*.*.*"]` is added, and the runbook still says to cut a version
with `gh release create` — because a tag push shares the `paths-ignore` written
for branch pushes and a tag adds no commits for a path filter to look at, while
the release event has no filter near it. One command does both, so the belt and
the braces cost nothing.

#### Whether an older image runs against a newer schema

Asked and answered rather than hedged, because "usually works, but it is not a
promise" is what the runbook used to say and that is not something anybody can
act on at the moment they need to.

**Twenty-nine of the thirty migrations are additive.** No `DROP TABLE`, no
rename, no type change, and every added column carries a default — so an older
image's inserts still satisfy every `NOT NULL`, and its selects name their own
columns, which means a column added later is simply not selected.

**One is not.** `0023_backup_s3` drops three `backup_settings` columns, as a
deliberate exception its own header explains: they were added by
`0022_backup_smb`, which has never run outside development, so no production
database has ever held a value in them.

Both sit inside the first release's set, so a rollback from any future version
to any earlier one crosses only additive migrations. The full statement, with
the one case that does cross 0023, is in INFRA.md under "Versions, images and
rolling back".

**If a future migration is not additive, the rollback is the dump.** An image
that expects a dropped column fails when somebody opens the screen that reads
it — not at startup, and nowhere the health check looks — which is why that case
has to be planned before the deploy rather than discovered after it.

#### Addendum, 2026-09-13: the rollback target did not exist

This entry said a rollback is editing `IMAGE_TAG`, which is true and was not
sufficient. **The images production runs have never been in a registry.** They
were built on the workstation and `docker load`ed onto the host (D120), so they
carry no `RepoDigest` at all and `ghcr.io/lundstream/vikt-api:v1.0` answered
nothing. The one line to edit had nowhere to point.

So the runbook gains a **step 0**, before the backup: tag the commit, push the
running images to GHCR under `v1.0`, read the digest back — it exists only once
the registry has computed it at push time — and then *pull the tag* to prove it.
A rollback that has not been pulled once is a sentence in a document.

Two things that step turned up, both of which would have surfaced at the pull
rather than at the plan:

- **The GHCR packages are private although the repository is public.** Package
  visibility does not follow repository visibility. Checked: an anonymous token
  request for `lundstream/vikt-api` answers `UNAUTHORIZED`.
- **`d11c2fe` is not in this repository.** It is a commit in `vikt-old`, whose
  history the public repo does not share, so the tag went there. Done:
  `refs/tags/v1.0 -> d11c2fe848…`.

And the version numbering moves with it. The build running in production **is**
v1.0, so the next deploy is **v1.1.0** rather than v1.0.0. Calling the new build
1.0 would leave the thing that has actually been serving for months with no
version at all, which is precisely how it came to have no rollback target.

### D149 — The deploy is a runbook, and the log says what it did

*2026-09-13.*

`STATE.md`'s "Inför nästa deploy" had grown into four sections of facts —
variables, migrations, manual steps, news copy — with no order between them. It
answered "what is true about the next deploy" and not "what do I do, and in what
order, and how do I know it worked". Those are different documents and only the
second is useful with a browser open at Portainer.

So `INFRA.md` carries **"Deploying a version, in order"**: eight numbered steps
from the backup to the rollback. It is in that file rather than in `STATE.md`
because it is about *this installation*, which is the rule that created INFRA.md
in the first place (D119). `STATE.md` keeps one thing and points at the rest.

The two ordering constraints are marked as constraints rather than left as
sequence. The backup is first because it is the only step that cannot be redone
afterwards, and it is not done until `restore-check.sh` has read it back: a dump
that has never been restored is a hope. The variables are second because an
image that does not know a variable ignores it, so setting one early is free and
setting one late renders `__CONTACT_EMAIL__` on a public page.

#### The migrator names what it applied

Step 6 is "read the API log", and it could not be written as it stands, because
the log did not say enough to check anything against.

`migrate.ts` printed `Migrations applied from <folder>` whether it had applied
nine migrations or none. On a deploy that is exactly the distinction worth
having: "nine applied, thirty recorded" is a schema where the new image expects
it, and "none to apply" on a deploy that should have run nine is a container
that started against the wrong database.

It now counts `drizzle.__drizzle_migrations` before and after and names each one
from the journal:

```
Migration applied: 0024_push
...
Migrations: 9 applied, 30 recorded in total
```

The names come from `meta/_journal.json` and the count says how far down it this
database is; the two are in the same order because the migrator walks the
journal. Proved against a scratch database created and dropped for the purpose,
which printed all thirty, and against the development database, which printed
`none to apply, 30 already recorded`.

#### What the log must show, written down

The runbook lists the four lines that are not the migrations, with **when each
one is absent**, because absence is the ambiguous case and every one of them has
a silent-success reading that is wrong:

- the **SMTP import** says nothing when `SMTP_*` are empty, which is the
  intended state (D102), and logs an *error* when `SMTP_*` is set without
  `SECRET_KEY`;
- the **VAPID check** says nothing on every ordinary boot, and something only on
  the first one and on a changed pair (D136);
- the **vision check** says nothing when it could not reach Ollama, and retries
  hourly without saying so (D143). Silence there is not success.

A runbook that said "check the log looks fine" would be worth nothing. The value
is in saying which silences are expected.

### D150 — An edit is not a second opinion, and a conflict has two answers

*2026-09-13.*

Editing 24 August from 110,0 to 110,1 through the month calendar produced
**"Samma dag från två enheter"** under Inställningar, and a queued row whose
"Försök igen" could never succeed. One device, one reading, one person changing
their own number.

Nothing was wrong with the rule. `weight_log` is unique on
`(user_id, local_date)`, and D41 says a queued write must not silently replace a
day another device wrote, because it was composed before that day existed. The
server applied that correctly. What was wrong is that **the request could not
say what it was**: the edit sheet enqueued a *create* with a fresh
`clientUuid`, so an edit and a second device's opinion arrived as the same bytes
and the server had nothing to tell them apart by.

So the fix is the model, not the message. A message can only be as true as the
request it describes.

#### Two operations, because there are two things

- **create** — there is a reading for this day. Unchanged, and still refused
  from the queue when the day is taken (D41).
- **update** — this row is wrong. It carries the row's `id` and
  `baselineWeightKg`, **the value the client had on screen when the sheet
  opened**, and goes to `PUT /weight/:id`.

The server applies an update while the row still holds that baseline, whether it
came from the queue or not. A queued edit replaying against an unchanged row is
the edit arriving late, not a collision, and that is the assertion the old model
could not make.

Three details that are decisions rather than plumbing:

**The baseline is the value, not a version column or a timestamp.** What matters
to the person is whether the number they were looking at is still stored. A row
rewritten to the same weight by another device is not a question worth asking.

**It is captured when the sheet opens, in a ref.** Reading the prop at submit
would pick up a background refetch that landed while somebody was typing —
exactly the change the baseline exists to notice.

**A row that has vanished is usually not a deletion.** A live write from another
device *replaces* the day: `deleteWeightForDayExcept` removes the old uuid and
inserts a new one. So the id an edit holds disappears in precisely the case the
person most needs told about. A bare 404 would say "that reading does not exist"
about a day that plainly has one, so a missing row with an occupied day is
`changed_since` and only an empty day is a 404.

Moving a reading onto a day that already has one keeps D41's own code and
message. That is the remaining same-day clash, and now it is the **only** thing
that produces that sentence: the page is true again because the model is.

#### A conflict is a question, so it has two answers

The section offered one control: "Behåll den som redan finns". That is the shape
of a dialog where the other answer is really "go away", and it is not what D41
promises — "nothing is discarded, the user chooses in the inspector" reads
oddly next to a single button that discards.

Two filled buttons of the same tier, neither styled as the way out:

- **Behåll den sparade** drops the waiting write and settles the question;
- **Använd den väntande** sends it **live**, without `fromQueue`. That is the
  whole point of the resolution: D41 refuses a queued write for an occupied day
  because it was composed before that day existed, and once a person has looked
  at both and chosen, it is a decision made now.

Either one leaves exactly one row, which `(user_id, local_date)` guarantees and
which is what makes the choice safe to offer.

**A conflicted queue row shows the same two choices**, not "Försök igen".
Retrying a conflict sends identical bytes to an identical rule and gets an
identical answer; the control could never work, and offering it made the page
look like the fault was the network's. The inspector lists the mutation and the
section above lists the question, and they are the same conflict seen from two
places, so either one settles it.

The conflict row also records **which kind** it is, so an edit whose row moved
does not get told two devices wrote the day.

#### Exercised

Through the calendar, against the development API, at 360 px and desktop: 25
August edited from 90,1 to 90,2, the server holding 90,2 afterwards, and
Inställningar reading **"Allt är skickat"** with no conflict and nothing queued.

Then a real conflict, made the way one happens: the browser put offline, a
reading logged for an empty 24 August through the calendar so it sat in the
queue, another device writing that day while it waited, and the queue drained.
One question, both readings shown, two buttons, and the queue row carrying the
same two. Settling it with the waiting reading left **one row at 91,5**.

### D151 — The build says what it is, and the source is offered where people are

*2026-09-13.*

Two things that had never been said out loud anywhere a person could read them:
which version is running, and where the source is.

#### The version is a property of the image, not a setting

`APP_VERSION` and `APP_COMMIT` are **Docker build arguments**, set by
`release.yml` from the tag and the commit, becoming `ENV` in the runtime stage.
They are deliberately **not** in `env.ts`, and the distinction is the whole
point: everything in the environment schema is a choice an operator makes, and a
deployment that could claim to be a version it is not would make the version
worth nothing at the moment somebody needs it. Keeping them out also keeps
D147's stack-variable guard honest — no allowlist entry, because they are not
stack variables.

`release.yml` derives the version from the ref rather than trusting
`github.ref_name`, which is the branch on a branch push: `main` is not a
version. A build with no tag says `dev`.

**A development run says `dev` and the sha.** `buildInfo` falls back to reading
`.git/HEAD` and the ref it names — files, not a `git` subprocess, because this
is called on a public endpoint and a process spawn per request is not a thing to
add for a footer. A container has no `.git`, which is the correct answer there:
the build argument is what speaks for an image, and it always wins over the
checkout.

#### One source, three readers

`/api/health` carries `version` and `commit`, beside the modes and for the same
reason D94 put those there: an operator checking a deployment should see its
shape with one curl, and it discloses nothing an anonymous visitor could not
read off a public repository.

The boot log's **first line** is `vikt 1.1.0 (a1b2c3d)`. First rather than
tidy-first: a log read from the top gives the version before the migrations that
version applied, so every line under it can be read against the build that wrote
it. The footer in Inställningar and the line under the Administration heading
read the same endpoint through one query key, so the three cannot drift into
three answers.

#### The source, offered where somebody signed in can see it

AGPL §13 obliges an offer of the source to anybody who interacts with the
program over a network. The landing footer has carried the link since D106 —
and **somebody signed in never sees that footer**. The app is where they are.

So the foot of Inställningar carries the version and five text links: the source,
Nyheter, `/integritet`, `/villkor` and the licence. In Sten, nothing an accent,
nothing a button: it is reference, not an action (D134). `/integritet` also
states the offer in words rather than in passing, names the licence and links
the repository, and says where the running version is shown.

Exercised at 360 px and desktop against the development API: the footer renders
`Version dev · 107321a` with all five links resolving, and `/integritet` reads
"Källkoden är öppen och finns att hämta … Koden till den här installationen
finns på github.com/lundstream/vikt."

### D152 — One scrim, and the sheet has no edge of its own

*2026-09-13.*

Four components each carried their own backdrop: `bg-ink/40` on three sheets,
`bg-ink/70` on the celebration. Four places for a number to drift, and one of
them had already been wrong — the celebration once shipped a **fully transparent
backdrop** because `bg-[var(--ink)]/70` emitted no rule at all, and nothing said
so until somebody looked at it.

`.scrim` is one class: the colour, the blur, and what happens when somebody has
asked for less transparency. Position stays with the component, because whether
it is `absolute` inside a fixed wrapper or `fixed` itself is layout, and mixing
the two in the class means one of them quietly loses to a utility.

#### The scrim is the dark Natt in both themes

`--natt` is **re-pointed** in the light theme: there it is Papper, the page
colour. A scrim built from `var(--natt)` would therefore have brightened a light
page instead of dimming it, which is the sort of thing that looks like a
rendering fault and is actually a token doing what it was told.

So `--scrim` is written out as the dark Natt in both blocks, and only the alpha
differs: **0.72 dark, 0.45 light**. Lighter on a light theme because the page
underneath is already bright and the sheet on top of it is not; higher on a dark
one because the sheet and the page are closer together there and the scrim has
to do more to say which is in front. The blur is **10 px in both**, because the
blur is what separates the layers and the tint is what dims them.

`prefers-reduced-transparency` drops the blur entirely and raises the opacity to
0.88 and 0.78. Entirely rather than reduced: a small blur is the same effect
asking to be noticed less, and somebody who has asked for less translucency has
asked for the separation to come from somewhere else.

#### The Is line was a focus ring on the dialog

`Sheet` focused the panel itself, a `tabindex="-1"` container. Chromium matches
`:focus-visible` on a programmatically focused element with a negative tabindex,
and in the dark theme this app's focus ring is `--data`, which is Is. So an
Is-coloured line appeared around the whole sheet — correct CSS applied to the
wrong element, on a screen where Is means *a raw reading*.

Focus goes to the **first field** now. That is also where somebody is going
anyway: every sheet in this app opens onto a form. The container keeps its
`tabIndex` as the fallback for a sheet with nothing focusable in it, which is
what keeps focus inside the dialog either way, and it can no longer draw a ring.

The panel's `border-edge` is gone with it. A sheet is Skymning standing on a
dimmed, blurred page; the scrim is the separation, and a hairline on top of that
is a second answer to a question already answered.

Shot in both themes at 360 px and desktop. Dark: scrim
`rgba(15, 20, 24, 0.72)`, `blur(10px)`, focus on `#ms-label`, no border and no
ring on the panel. Light: the same with `0.45`.

The reduced-transparency branch was emulated rather than read off the
stylesheet, because "the CSS says so" is how a rule ends up shipping behind a
query the browser spells differently. With
`prefers-reduced-transparency: reduce` emulated, the blur is `none` and the
opacity is `0.88` in dark and `0.78` in light, in both cases with `matchMedia`
confirming the page agreed it was in that state.

### D153 — A deleted row is a question, not a refusal

*2026-09-13.*

D150 gave an edit its own queue operation and three outcomes, and then treated
one of them as a dead end. A queued `weight-update` whose row had been deleted
came back 404, fell into the generic 4xx branch, and was marked `failed`. The
page then offered the two controls a refusal gets: **"Försök igen"**, which
sends the identical PUT to the identical absent row and will do so forever, and
**"Kasta"**, which throws away a reading somebody took and typed.

Neither is an answer, and the obvious second answer was sitting right there. The
server answers 404 only when the row is gone **and** the day is empty — a gone
row on an occupied day is `changed_since`, because a live write replaces the day
rather than updating the row — so in this one case *nothing on the server
disagrees with the waiting reading*. There is simply nothing there. Putting it
back is a plain create for a free day.

So it becomes the conflict's shape with one reading instead of two: `row_gone`,
recorded as a question, resolved by the same two functions the other two
collisions use. "Lägg till igen" is `applyQueuedReading`, which already strips
`id` and `baselineWeightKg` and posts live; both of those name a row that does
not exist, and sending either would address it.

**It is not called a conflict on screen**, because it is not one. The queued row
says "Raden är borttagen" rather than "Krockar med en annan enhet", which would
name a device that had nothing to do with it, and the comparison shows one side
rather than a "Sparad på servern" line over an empty object rendering "Okänd
post". The section heading moved too: "Samma dag från två enheter" was true of
one of the three cases and false of the rest, so the heading and its note say
what all three have in common — something you logged could not be sent as it
was, and both it and the choice are still here — and each row says which it is.

Only an update can reach this. Every other kind posts to a collection, where a
404 is a routing fault and a question about which reading to keep would be
nonsense, so the branch is keyed on the kind and a 404 on a create is still a
refusal.

#### Two labels that were never written

The inspector reads ``t(`queue.kind.${row.kind}`)`` through a cast, so the
compiler checks nothing, and `weight-update` and `habit-check` had been added
with their endpoints and never with their strings. The queue listed
`queue.kind.weight-update` to anybody who opened it while an edit was waiting,
which is exactly the screen this change sends them to. Both written, and a guard
added over `ENDPOINTS`, which is the runtime list of every kind there is.

#### Exercised with two browsers

Two Edge processes with separate profiles, because two tabs share an IndexedDB
and would share the queue. A reading logged for 8 September through the calendar
at 88,4; the first browser put offline and the same day edited to 88,9, which
queued as `weight-update`, pending; the second browser deleting that reading,
leaving the day empty; the first brought back online and drained.

One question, in both places, with **"Släng den"** and **"Lägg till igen"** and
no retry anywhere. "Lägg till igen" left one reading at 88,9 on 8 September, the
queue clean and the question gone. Shot at 360 px and desktop.

One thing the interface showed that the tests could not: **a navigation while
offline lands on the browser's error page, where the origin is gone and
IndexedDB is denied**. That is a property of the probe rather than of the app —
the app itself never navigates there — but it is why the offline half of this
exercise stays on one page and drives the calendar rather than reloading it.

### D154 — A swipe between sections, and the five times it must not fire

*2026-09-13.*

On a phone the four sections live in a bar at the bottom, which means moving to
the one beside the current page is aiming at a 72 px target with the hand that is
also holding the phone. A horizontal swipe is the gesture every other app on the
device already uses for this, it needs no label, and it costs nothing to
somebody who never discovers it.

The interesting half is not the gesture. It is **when not to fire**, because a
page of this app is full of things that are also horizontal, and firing on one
of them is worse than not having the gesture at all: the person loses their
place *and* the thing they were actually doing.

#### The five guards

**Within 24 px of either edge, nothing happens.** Both iOS and Android put their
own back gesture there, and a touch that starts in that strip belongs to the
operating system. This one is not theoretical: the live probe dragged from
x = 8 and the *browser* went back a history entry while the app's own track
never moved. That is the guard working, and it is exactly what would have
fought the app if the strip were not reserved.

**A touch that starts on the weight graph, on a range input, or inside anything
that scrolls sideways is left alone.** The third is the general rule the first
two are instances of: a sideways drag on something that can scroll sideways
already means something. The chart is marked rather than detected, because a
Recharts surface does not scroll and there is nothing about it in the DOM that
says "the horizontal axis is mine" — it is a fact about what the thing *is*.

**The gesture claims the touch only once horizontal movement clearly dominates
vertical**, by half again, and only after 12 px. A page that scrolls is what a
finger is usually doing and a swipe is the rare case, so the rare case has to
prove itself. Once a touch has been read as a scroll it stays one for the rest
of its life rather than flipping halfway down the page.

**One finger.** Two is a pinch.

**Below `sm` only**, which is where the bar it is a shortcut for exists.

#### What it does when it does fire

The page follows the finger, one transform on one wrapper. On release it
completes past a quarter of the screen, or on a flick — 0.5 px/ms with a 48 px
floor, so a twitch is not a flick — and otherwise springs back over 200 ms. Past
the first section or the last, the page still moves a quarter as far and nothing
happens on release: the resistance says so *before* the release rather than
after it.

A completed swipe **navigates immediately** and the incoming section starts at
`width + handoff`, where the handoff is where the finger let go. That is what
makes it continuous: the new page picks up exactly where the old one was rather
than a full screen away. The alternative, sliding the outgoing page off first
and only then navigating, puts 140 ms between the decision and anything
happening — and the same code serves a **tap in the navigation**, where a delay
before the page changes is simply lag.

So a tap and a swipe produce the same movement, which is the point of having one
at all: one way of changing section, two ways of asking for it. The direction
comes from the order, not from the gesture, and a destination with no place in
the order (anything in the Mer sheet) slides forward, because a slide has to go
somewhere.

**The four in the bar, not every destination.** Swiping to a place the bar does
not draw would leave nothing marked as current and no way to tell where you had
ended up.

**Below `sm` only, the slide as well as the gesture.** The slide exists to make
a completed swipe continuous, so on a screen that cannot be swiped it would be
motion added to a navigation nobody asked to change. The shell'''s two shapes are
a layout switch (D115) rather than two apps, so this is one line rather than two
conditions that could drift apart.

**`prefers-reduced-motion` removes all of it and keeps the navigation.** Not a
shorter slide: a small animation is the same animation asking to be noticed
less. The page does not follow the finger either, because that is movement too;
the gesture is still recognised and still changes section.

#### Two things that would have broken other screens

**The transform is removed, not set to identity.** A transform makes an element
the containing block for every `position: fixed` descendant, and this app's
sheets are fixed and live inside the page. Leaving `translate3d(0,0,0)` behind
would have pinned every sheet to the content column instead of the viewport, on
every screen, permanently after the first swipe. It comes off on `transitionend`
along with `will-change`.

**`overflow-x: clip`, not `hidden`.** The content has to be cut off at both
edges while it slides. `hidden` would also force `overflow-y` to `auto`, turning
the content column into a scroll container and changing what scrolls on every
screen in the app to fix an axis nothing scrolls on.

`touch-action: pan-y` would have been simpler than a non-passive `touchmove`
listener and is wrong for the same kind of reason: it applies to everything
underneath, so it would break precisely the horizontally scrolling things the
guards exist to protect.

#### Exercised

Twenty-two tests over synthetic touch events, one per guard and one per
threshold. Then live, in headless mobile emulation at 360 px with real
`Input.dispatchTouchEvent` touches, which is the part jsdom cannot answer: the
gesture completes forwards and backwards, a short slow drag springs back and
leaves no transform behind, a drag from the edge strip does nothing while the
browser goes back, a drag starting on the trend line does nothing, a mostly
downward drag does nothing, a tap in the bar runs the same 200 ms slide, and
with `prefers-reduced-motion` emulated the section still changes and nothing
moves. Mid-gesture at 360 px is shot: the page 132 px left, the vacated strip
the page colour, the bar still marking the section you have not left yet.

The real phone is listed in STATE.md as waiting on the owner. A headless browser
can dispatch a touch; it cannot tell you whether the thumb that lives on the
left edge of a phone triggers this by accident all day.

### D155 — The coach gets the data, and two rules about what it may do with it

*2026-09-13.*

Asked what somebody was eating, the coach answered that it only saw summaries.
That was **true**, and it was the app's fault rather than the model's: the sheet
carried a trend, a rate, a maintenance figure and a macro mean, and a person
asking "vad tror du om mitt upplägg" is asking about food, drink, movement and
sleep, none of which were in it.

#### The sheet

Every domain, over **7 and 28 days**, because one window alone invites the wrong
reading of the other: a good week inside a bad month, or a month's average
hiding the week it is about. Intake against measured maintenance with its
coverage; each macro against the person's own target with the number of logged
days under it; fibre only where it is tracked at all; alcohol units and sober
days; activity sessions and minutes; steps; sleep hours; energy and mood;
habits with their streaks; measurements and their smoothed change; and the
**names** of what was eaten in the last seven days, per day, names only.

The names are the one place this loosens D139's "aggregates, never rows", and
the loosening is narrow and deliberate. A list of foods is not a food log: no
amounts, no times, no macros per item, no note. What it buys is the difference
between a coach that can say something about somebody's eating and one that
correctly says it cannot.

**Nothing is recomputed.** Every figure comes through the service or the shared
calc function that already produces it for a screen — `dayMacros`,
`buildActivityIndex`, `smoothedChange`, `coverageOver`, `currentStreak`. A coach
with its own maintenance figure would eventually disagree with the dashboard in
front of somebody looking at both.

**An empty domain says so with the data as subject, never `0`.** "0 pass" claims
somebody sat still for a week; what is true is that nothing was logged. This is
D140's addendum applied to the sheet the prompt is about, and it is held by a
test that greps for `0 pass`, `0 minuter`, `0 steg` and the rest as whole
figures.

#### One way to write a number

`num(value, unit, decimals)` formats with the shared Swedish formatter **and**
registers the figure in the guard's traceable set, in one call. It is the only
way a number reaches the text, so the rule "every figure in the sheet is one a
reply may quote" is structural rather than remembered — the previous sheet did
the two halves in separate statements and could therefore do one of them.

A test runs the reply guard over the sheet's own sentences. On the first run it
found one figure that had been written as a literal: **"vilket är 1 procent av
kroppsvikten"**, in a line that had been there since D139. A reply repeating that
sentence would have been refused for stating a number the app had not supplied —
the worst kind of false refusal, because the app put the number there.

Ten units now, not four: kcal, kg, kg/week, percent, grams, minutes, steps,
hours, standard drinks, cm, counts, and the 1 to 5 ratings. Each vouches only
for itself, so "140 g" and "140 kcal" cannot stand in for each other. The
figure pattern gained the unit words with a lookahead rather than a word
boundary, because `%` is not a word character and "140 grader" must not match
the `g` in it.

#### Two rules, and one of them is also a check

Added to COACH_RULES, tone independent, verbatim in every profile:

**Praise is allowed, tied to a fact.** "Sju loggade dagar av sju, det är hela
veckan" is praise about something; praise with nothing behind it is the thing
said to everybody.

**At most two suggestions, each an option.** "du kan", "om du vill", "ett
alternativ är" — never "du måste", "du ska", "du bör". A direction may be named,
such as more protein or more movement or more sleep, never a figure the person
has not set as a target themselves.

That second one is also a **words-level check**, and it has to be, because the
question that produced this whole pass ends "Något jag bör tänka på?" — the
question hands the model the forbidden word, and an accommodating model uses the
words it is given. The patterns need a modal **and** a person for it to be
addressed to: `ska` is one of the commonest words in Swedish, and refusing every
sentence with it in would refuse "det ska bli intressant att se nästa vecka".

One exemption: a sentence naming care. "Du bör ta det med vården" is the
sentence D139 built a whole detection path to produce, and refusing the model
for arriving at it independently would be the check working against its own
purpose.

**Two series may sit side by side, never joined by a cause.** The brief for this
asked the coach to connect two series only through a relation Samband had
already computed — and Samband has computed none, on purpose. D34 is explicit
and the schema says so in as many words: no r, no fitted line, no verdict,
because every pair is one person's self-report over a few weeks with obvious
third causes. So the sheet carries what Samband actually has, which is which
pairs it plots and how many days line up, and the rule is written against that:
the coach may say the app draws those two together and may state both facts, and
may never say one caused the other.

#### What the live run changed

**A false refusal, found in the warm tone.** The reply

> "Du har loggat mat två dagar den här veckan, med gryta och havregrynsgröt som
> exempel, medan rörelse och steg inte är ifyllda än."

was refused as blame. It is a true sentence about what was logged followed by a
separate clause about what the app does not have, with the data as its subject —
exactly what the rules ask for. The old patterns let the person, the logging verb
and the negation come from anywhere in the sentence; commas and semicolons stop
the match now, so the negation has to belong to the clause the person is in.

**A breadth rule, because all three tones answered from the weight alone.** With
the sheet in front of them and the question asking about the whole picture,
every tone talked about the trend and nothing else. So: a broad question is
answered from several domains, with a short sentence each about food, alcohol,
movement and sleep in so far as they are in the sheet — and the two-to-four
sentence limit is relaxed to six for that case, in one place rather than edited
into three tone blocks that would then disagree. Length for breadth is about
answering the question, not about how it sounds, so it belongs in the shared
rules.

#### The size, measured

3 296 prompt tokens for the worst realistic turn: the system prompt, six past
turns and the question. The variant is loaded with **`num_ctx` 65 536**, so the
turn uses 5.3 percent of the window and leaves 62 066 tokens. `docs/measurements.md`
carries the table and the 2.92 characters per token it also produced.

The 9 000 character budget is therefore not about the model. It is about keeping
the sheet small enough to be read: a sheet three times this size would fit and
would be worse.

#### The three tones, verbatim

The question, in all three, against `qwen3.6:27b` on the development account:

> Vad tror du om mitt upplägg, vad jag äter, hur viktnedgången ser ut? Något jag
> bör tänka på?

**Torr:**

> Trendvikten har sjunkit 1,1 kg på fyra veckor, vilket ligger nära den
> planerade takten. Matloggen är sparsam just nu med bara två dagar ifyllda
> denna vecka, medan intaget de senaste fyra veckorna i snitt landat kring
> 2 246 kcal per loggad dag. Rörelse och steg är inte registrerade denna vecka,
> men under månaden har det blivit fem pass och ett genomsnitt på 9 400 steg när
> uppgifterna finns. Sömnen ligger stabilt kring sju timmar med goda värden för
> både energi och humör. Du kan fylla i mer mat eller rörelse om du vill se hur
> det påverkar bilderna, eller låta det vara som det är.

**Peppig:**

> Trendvikten har sjunkit 1,1 kg på sista månaden och midjan minskat något,
> vilket är ett tydligt tecken på framåtrotation. Matloggningen täcker bara en av
> de senaste sju dagarna, så intaget är inte ifyllt än för övrig vecka. Rörelse
> och steg räknas heller inte in just nu eftersom ingen aktivitet eller
> stegantal är loggat de senaste dagarna. Du kan lägga till mat om du vill se hur
> det står till med kalorierna, eller så kan du börja logga rörelse för att få en
> tydligare bild av utgiften.

**Saklig:**

> Trendvikten har minskat 1,1 kg de senaste 28 dagarna, vilket motsvarar en
> veckotakt på 0,27 kg. Måltavlan är 83,5 kg med en planerad takt på 0,25 kg i
> veckan, och trenden ligger därmed nära den satta målet.
>
> Under de senaste sju dagarna har mat loggats endast två dagar, medan alkohol,
> rörelse och steg inte är ifyllda för samma period. Under 28-dagarsperioden har
> intaget i snitt varit 2 246 kcal per loggad dag på 71 procent av dagarna, med
> ett proteinsnitt som överstiger målet men kolhydrater och fett som ligger under
> respektive mål.
>
> Rörelse är loggad med fem pass totalt under månaden, medan stegantalet i snitt
> landat på 9 400 per dag när det är ifyllt. Sömnen har legat på i genomsnitt
> 7,3 timmar, energi på 3,7 av 5 och humör på 3,9 av 5 baserat på 14 dagar med
> data.
>
> Underhållsnivån är ännu inte räknad fram eftersom appen behöver fler dagar med
> både vikt och matloggar för att göra en uppskattning. Du kan fylla i mer
> rörelse eller sömn om du vill, eller logga mat de dagar det saknas för att få
> en tydligare bild av intaget.

Every sentence of all three passed the guard. Every suggestion is an option and
none of them says "du bör", which is the thing the question was inviting.

**What is honest to say about the coverage.** Food, movement and sleep are in
all three, on every roll. **Alcohol is reliably in `saklig` and drops out of the
two character tones**, and the reason is visible in the sheet: this account has
no alcohol in the last seven days and two standard drinks in twenty-eight, and
the tones that are capped at five or six sentences drop the domain with least in
it. That is arguably the right call rather than a defect, and it is not
something a prompt line fixed — three more lines of instruction moved it for one
roll and not the next. Recorded as it is rather than re-rolled until it read
well.

The neutral tone's first paragraph also contains "den satta målet", which is
wrong Swedish. That is the model, not the app: nothing in the pipeline corrects
grammar, and a check that did would be editing the coach rather than checking
it.

#### Addendum, 2026-09-13: alcohol when there is something to say about it

The observation above — that the two character tones drop alcohol — was made on
an account with **two** standard drinks in twenty-eight days and none in the last
seven. That left the question it looked like it answered still open: does the
coach speak to alcohol when there is something to speak to, or does it not speak
to alcohol?

`seed-alcohol-fixture.ts` settles it. Twenty-eight days, every one logged, with
drink on the days a normal week has it: **44 standard drinks across 12 days, 16
of them sober**, and 11 units in the last seven. Deliberately not a heavy
drinker — a fixture that is alarming tests the coach's restraint rather than its
coverage, and the restraint is already covered.

**The first run of it was not a fair test and was re-seeded.** It had no food
entries, so the meal-names section said nothing was logged, and a reply capped
at six sentences had one fewer domain competing for room. A fixture that makes
the answer easier is not a test. Three meals a day for the last seven days were
added and the whole thing run again; what follows is the second run.

The same question, verbatim, in all three tones:

> Vad tror du om mitt upplägg, vad jag äter, hur viktnedgången ser ut? Något jag
> bör tänka på?

**Torr:**

> Trendvikten har sjunkit 0,6 kg under de senaste fyra veckorna. Intaget ligger
> i snitt 178 kcal under din beräknade underhållsnivå just nu. Du har loggat mat
> alla dagar och vägningarna är på plats varje dag.
>
> Alkoholen hamnar på 11 standardglas de senaste sju dagarna, med fyra nyktra
> dagar blandat in. Rörelsen består av sex pass på sammanlagt 270 minuter under
> samma period. Stegantalet ligger runt 9 100 per dag och sömnen genomsnittligt
> på 7,1 timmar.
>
> Du kan fundera på att justera intaget om takten känns för långsam. Ett annat
> alternativ är att behålla nivån men öka rörelsen något. Appen visar inga
> samband mellan dessa variabler, den plottar bara vad som loggats.

**Peppig:**

> Trendvikten har sjunkit 0,6 kg de senaste fyra veckorna, vilket motsvarar en
> stabil takt. Du har loggat mat varje dag under hela perioden, och intaget
> landar i snitt lite under din beräknade underhållsnivå. Rörelsen ser bra ut
> med sex pass på sju dagar, och stegantalet ligger kring 9 100 per dag. Sömnen
> är stabil runt sju timmar, medan energin hamnar på 3,4 av 5 och humöret på
> 4,0. Alkoholintaget är uppgivet för alla dagar, med fyra nyktra dagar den
> senaste veckan. Du kan överväga att justera antalet alkoholglas om du vill se
> hur det påverkar energinivån. Ett annat alternativ är att behålla nuvarande
> rörelsemängd och fokusera på sömnkvaliteten för att stötta återhämtningen.

**Saklig:**

> Trendvikten har minskat 0,6 kg över de senaste 28 dagarna, vilket motsvarar en
> veckotakt på 0,14 kg. Matintaget ligger i snitt cirka 170 kcal under den
> beräknade underhållsnivån, och loggningen är fullständig för hela perioden.
> Rörelse och sömn är registrerade dagligen, medan intaget av alkohol varierar
> med fyra nyktra dagar de senaste sju. Det finns ingen aktiv plan eller
> inställda makromål i appen just nu. Du kan fundera på att aktivera en plan för
> att få fram mål, eller behålla det nuvarande upplägget om tempot passar dig.

**Every tone reached alcohol**, every sentence passed the guard, every figure is
one the sheet supplied, and no suggestion names a target the person has not set.
Nothing needed fixing: the sheet ordering and the tone blocks are untouched, and
COACH_RULES was not amended, which is what the brief asked for if a tone had
dropped it.

So the earlier observation was about **thin data, not about alcohol**. A tone
capped at six sentences drops the domain with least in it, and when alcohol is
not that domain it is not dropped. That is the right behaviour and it is now
demonstrated rather than assumed.

Torr's last sentence is worth keeping as evidence of the Samband rule working
without being asked: *"Appen visar inga samband mellan dessa variabler, den
plottar bara vad som loggats."*

#### One thing in that run that is not clean

Peppig wrote:

> Du kan överväga att justera antalet alkoholglas om du vill se hur det påverkar
> energinivån.

The phrasing is an option, not an instruction, so the words-level check passes
it — and it presupposes that alcohol **affects** energy, which is a causal link
between two series. The rules forbid exactly that, and the fixture makes the
temptation strong, because it was seeded so drinking days have less sleep and
lower energy.

It is soft: an invitation to look rather than a claim of fact. It is still the
thing the rule is about.

**Left as found rather than patched**, for the reason D155 gives about the
prescribing check: the rule against causal claims has no mechanical check, only
prompt text, and the honest response to discovering that is to record it rather
than to add a guard in the same hour on one example. If it recurs, the shape of
the fix is the one the instruction rule already has — a words-level check for
"påverkar", "beror på", "leder till" and their neighbours, tested in both
directions so that stating two facts side by side still passes.

#### Addendum, 2026-09-16: "om", not "hur", and what each area means

Two lines added to `COACH_RULES`, tone independent, so every profile carries
them verbatim, and `coach-tones.test.ts` asserts both reach all three tones.

1. **"Om", not "hur".** The coach invites looking at *whether* something shows,
   never at *how* one thing affects another, unless the sheet shows that
   Samband computed it, and Samband computes nothing (D34, D166). The rule
   carries two examples: the allowed shape, "om du vill kan du titta på om
   energin ser annorlunda ut de veckor du dricker mindre", and Peppig's sentence
   from the addendum above as the forbidden one.
2. **What each area means for the goal, in one sentence.** General knowledge
   about food, movement and sleep is allowed for that sentence, marked as
   general ("i regel", "för de flesta") and carrying no figure of its own. Thin
   data is named as thin first. Figures are still only the sheet's, and options
   are still at most two. For macros the reply says whether they matter for the
   goal and why.

**No words-level causal check was added.** The rule has prompt text and two
examples, and nothing mechanical behind it. That is the position this entry took
on 2026-09-13 and it has not changed: a guard written against one sentence is a
guard against that sentence.

The same question as above, verbatim, in all three tones, on 2026-09-16 against
data as of 2026-09-15, through `coach-probe.ts`. Replies are copied from the
probe's output, not retyped.

> Vad tror du om mitt upplägg, vad jag äter, hur viktnedgången ser ut? Något jag
> bör tänka på?

#### The development account

**Torr** (qwen3.6:27b, 16.8 s, 7 sentences, all passed the guard):

> Trendvikten har gått ner 1,0 kg på 28 dagar, vilket ligger nära den planerade takten. Målen för protein, kolhydrater och fett är inte ifyllda än, eftersom en stor del av energin saknar uppgifter om makron. Rörelsen är inte ifylld de senaste sju dagarna, men stegen har legat på 9 640 i snitt under månaden. Sömnen ligger på 7,4 timmar och humöret på 3,9 av 5, båda från 13 dagar. För de flesta hjälper regelbunden loggning att hålla koll på intaget, och protein spelar ofta roll för att behålla muskler när vikten minskar. Du kan fylla i mer mat om du vill få en tydligare bild av makrona. Ett alternativ är att notera rörelse de dagar du rör på dig.

**Peppig** (qwen3.6:27b, 4.3 s, 6 sentences, all passed the guard):

> Trendvikten har gått ner 1,0 kg på 28 dagar, vilket ligger nära den planerade takten. Intaget är inte ifyllt för de flesta av de senaste dagarna, och det betyder att underhållsnivån ännu inte kan räknas fram. Rörelsen är inte loggad denna vecka, men över månaden har du 5 pass och snittar cirka 9640 steg på dagarna då det finns data. I regel hjälper regelbunden rörelse de flesta att behålla muskelmassa när vikten minskar. Sömnen ligger på ett snitt på 7,4 timmar, vilket i regel gynnar återhämtningen för de flesta. Om du vill kan du titta på om energin ser annorlunda ut de veckor du dricker mindre alkohol, eller om det finns mönster mellan intag och trendförändring under fliken Samband.

**Saklig** (qwen3.6:27b, 5.0 s, 8 sentences, all passed the guard):

> Trendvikten har minskat med 1,0 kg under de senaste 28 dagarna, vilket motsvarar den planerade takten. Viktloggen innehåller 12 av 28 dagar, medan matintaget är registrerat på 19 dagar, varav många uppgifter saknar fullständig makroinformation.
>
> Under veckan har endast tre dagar loggats för mat, och rörelse samt stegantal är inte ifyllda ännu. De senaste måltiderna inkluderar havregrynsgröt, filmjölk, kvarg med bär samt måltider hos anhöriga och vänner. Alkoholintaget är lågt med två standardglas på en månad, och sömnen ligger i snitt på 7,4 timmar när den är registrerad.
>
> Det saknas idag underhållsnivå eftersom det krävs fler dagar med både vikt- och matloggning för att appen ska kunna beräkna den. I regel hjälper en stabil kostvanan och regelbunden rörelse de flesta att behålla muskelmassa när vikten minskar. Om du vill kan du komplettera veckans loggning eller titta på om energin ser annorliden ut de dagar du rör dig mer.

#### The alcohol fixture

**Torr** (qwen3.6:27b, 5.1 s, 9 sentences, all passed the guard):

> Trendvikten har minskat 0,6 kg under de senaste fyra veckorna. Matloggningen täcker alla dagar och intaget ligger i snitt cirka 175 kcal under din beräknade underhållsnivå. Du tränar regelbundet med sju pass per vecka och sover i genomsnitt 7,1 timmar. Alkoholkonsumtionen är uppgiven för samtliga dagar, med fyra nyktra dagar den senaste veckan.
>
> För de flesta leder ett moderat kaloriunderskott kombinerat med styrketräning till att muskelmassa bevaras bättre under viktnedgång. Alkohol innehåller energi som inte bidrar till näringstillförseln på samma sätt som mat, vilket kan påverka hur kroppen hanterar underskottet. I regel är sömn viktigt för återhämtning efter fysisk aktivitet.
>
> Om du vill kan du titta på om energinivåerna ser annorlunda ut de veckor du dricker mindre alkohol. Ett alternativ är att fylla i dina egna makromål så att appen kan visa hur ditt intag av protein, kolhydrater och fett förhåller sig till dem.

**Peppig** (qwen3.6:27b, 4.6 s, 7 sentences, all passed the guard):

> Det är roligt att se att du har loggat varje dag i fyra veckor, vilket ger en väldigt tydlig bild av läget. Trendvikten har gått ner 0,6 kg under perioden, vilket motsvarar en takt på 0,14 kg i veckan.
>
> Ditt intag ligger i snitt lite under din beräknade underhållsnivå, och du äter regelbundet lax, kyckling och rotfrukter. Du tränar också flitigt med sju pass i veckan och sover i snitt 7,1 timmar per natt. För de flesta bidrar tillräckligt med sömn till bättre återhämtning efter träning, även om appen inte räknar samband mellan dessa uppgifter.
>
> Eftersom det inte finns någon aktiv plan just nu saknas också specifika makromål att jämföra mot. Om du vill kan du titta på om energin ser annorlunda ut de veckor du dricker mindre alkohol, eller om du känner för det kan du testa att lägga upp en vanan som passar in i din vardag.

**Saklig** (qwen3.6:27b, 5.6 s, 8 sentences, all passed the guard):

> Trendvikten har minskat med 0,6 kg över 28 dagar, vilket motsvarar en takt på 0,14 kg i veckan. Intaget ligger i genomsnitt 176 kcal under den adaptiva underhållsnivån de senaste sju dagarna, och loggningen är komplett för hela perioden.
>
> Matloggen visar upprepade måltider med lax, kyckling, rotfrukter och havregryn, men makromål saknas eftersom ingen aktiv plan finns ställd in. Alkoholkonsumtionen ligger på 11 standardglas de senaste sju dagarna, medan rörelsen omfattar 315 minuter fördelat på sju pass. Sömnen genomsnittas till 7,1 timmar per natt, med energinivå 3,4 av 5 och humöret 4,0 av 5.
>
> En stabil viktminskning i regel kräver ett konsekvent kaloriunderskott, vilket ditt intag visar jämfört med underhållsnivån. Alkohol kan påverka fettförbränningen, och om du vill kan du titta på hur energin ser ut de veckor alkoholkonsumtionen varierar. Rörelsen är regelbunden, och för de flesta bidrar styrketräning eller muskelaktivering till att behålla muskelmassa när vikten går ner.

#### What came back, plainly

**The "hur" sentence went away, and the "hur" shape did not entirely.** None of
the six replies invites somebody to change something "om du vill se hur det
påverkar" anything, which was the sentence the rule was written against. But:

- Saklig on the alcohol fixture wrote "om du vill kan du titta på **hur** energin
  ser ut de veckor alkoholkonsumtionen varierar". That invites looking at how
  energy looks, not at how alcohol affects it, so it is softer than the original.
  It is still "hur" where the rule asks for "om".
- Two replies on the alcohol fixture state a general causal claim **without
  marking it as general**. Torr wrote that alcohol "kan påverka hur kroppen
  hanterar underskottet", and Saklig wrote "Alkohol kan påverka
  fettförbränningen". Neither joins two of the person's own series, which is
  what the Samband rule is about, but both are the kind of sentence the meaning
  rule says has to carry "i regel" or "för de flesta".

**The macro requirement was met once in six.** Only Torr on the development
account said whether macros matter for the goal and why: protein "spelar ofta
roll för att behålla muskler när vikten minskar". Peppig and Saklig on the
development account say nothing about what macros mean. On the alcohol fixture,
which has no active plan and so no macro targets, all three tones say the targets
are missing, and Torr suggests setting them, but none says whether macros matter
for losing weight. The rule asks for exactly that and the model mostly did not do
it.

**The allowed example became a template.** Four of the six replies end on some
version of "titta på om energin ser annorlunda ut de veckor du dricker mindre",
including Peppig on the development account, which has two standard drinks in a
month. An example in a prompt is read as the answer as well as the shape.

**What held.** Every sentence in all six passed the guard; every figure is one
the sheet supplied; no reply prescribed; general knowledge was marked with "i
regel" or "för de flesta" in most of the sentences that used it; and every tone
covered more than one area.

**Left as found.** Tuning the prompt against six replies is the same mistake as
a guard written against one sentence. If the unmarked causal sentence or the
missing macro sentence recur, the fix for the first is the words-level check
this entry has described since 2026-09-13; the second probably wants the macro
sentence placed in the sheet's macro block, beside the targets, where the model
reads it with the figures, rather than in a rule it reads before them.

#### Addendum, 2026-09-17: the interpretation moved into the sheet, and the six ran again

The entry above ends by saying what to do if the missing meaning sentence
recurred: put it **in the sheet's own blocks, beside the figures, rather than in
a rule the model reads before them**. It recurred, so that is what D171 does, and
these are the same six cases run again against the same model with the same
question.

**The interpretation is in all six replies now**, against one of six before. The
counts are sentences carrying one of the sheet's general markers, out of the
sentences in the reply:

| Account | Tone | Marked | Sentences | Model |
|---|---|---|---|---|
| the development account | Torr | 4 | 10 | qwen3.6:27b, 51557 ms, 993 chars |
| the development account | Peppig | 1 | 4 | qwen3.6:27b, 3376 ms, 567 chars |
| the development account | Saklig | 2 | 5 | qwen3.6:27b, 5072 ms, 899 chars |
| the alcohol fixture | Torr | 5 | 6 | qwen3.6:27b, 4542 ms, 778 chars |
| the alcohol fixture | Peppig | 5 | 8 | qwen3.6:27b, 4974 ms, 958 chars |
| the alcohol fixture | Saklig | 5 | 7 | qwen3.6:27b, 5874 ms, 1129 chars |

**One sentence was refused, by the check this pass added**, which is the first
time the causal rule has been enforced rather than requested:

```
REFUSE [causal: påverkar] Om du vill kan du titta på om energin ser annorlunda ut de veckor du dricker mindre, eller fundera på att lägga in mer protein i matloggen för att se hur det påverkar snittet.
```

That is the shape D155 named on 2026-09-13 and the prompt has forbidden since:
an invitation to change something in order to see what it does to something
else. It carries no general marker, so it is a claim about this person's data,
and nothing in the app computed it. The cost is real and worth stating: in the
live path a refused sentence means **that reply is not shown at all**, so the
reader of that one turn got a refusal instead of an answer.

The replies, verbatim.

**The development account, Torr.**

> Trendvikten har gått ner 1,0 kg på 28 dagar, vilket är 0,25 kg i veckan. En trend som går ner betyder i regel att energin under perioden legat under det kroppen gjort av med.
> 
> Matintaget är ifyllt på 18 av 28 dagar, men snittet blir osäkert när de dagar som saknas kan ligga var som helst. Alkohol har inte fyllts i på någon av de senaste sju dagarna, och utan uppgift står den i regel utanför energin.
> 
> Rörelse är inte loggad den senaste veckan, och rörelse som inte loggas står i regel utanför både energin och sammanställningen här. Steg har ifyllts på 12 dagar med ett snitt på 9 870 per dag.
> 
> Sömnen ligger på 7,5 timmar i snitt från 12 dagar, och humöret på 4,0 av 5. Midjan har ökat 0,6 cm på 28 dagar, och mått rör sig i regel långsammare än vikten.
> 
> Om du vill kan du titta på om energin ser annorlunda ut de veckor du dricker mindre, eller om intaget och trendförändringen syns mot varandra under Samband. Appen ritar dem mot varandra men räknar inget samband och påstår ingen orsak.

**The development account, Peppig.**

> Trendvikten har gått ner 1,0 kg på 28 dagar, vilket betyder i regel att energin under perioden legat under det kroppen gjort av med. Det är bara två dagar som har mat loggade de senaste sju dagarna, så snittet för intaget är osäkert eftersom de dagar som saknas kan ligga var som helst. Alkoholuppgiften är inte ifylld på någon av dagarna, och rörelse är inte loggad alls under denna period. Om du vill kan du titta på om energin ser annorlunda ut de veckor du dricker mindre, eller fundera på att lägga in mer protein i matloggen för att se hur det påverkar snittet.

**The development account, Saklig.**

> Trendvikten har minskat med 1,0 kg på 28 dagar, vilket motsvarar den planerade takten och i regel tyder på att energin legat under det kroppen gjort av med. Matintaget är loggat för två av de senaste sju dagarna, varvid filmjölk, havregrynsgröt, middag hos vänner och kvarg noterats, medan intaget för övriga dagar saknas och därmed inte ingår i beräkningarna. Alkohol har ifyllts på en av de 28 dagarna med två standardglas totalt, och rörelse är loggad som fem pass under perioden medan stegantalet visar ett snitt på 9 870 från tolv dagar. Sömnen ligger på ett genomsnittligt värde på 7,5 timmar från tolv ifyllda dagar, och midjemåttet har ökat något trots viktnedgången, vilket är ovanligt då mått i regel rör sig långsammare än vikten. Du kan titta på om sömn eller energi ser annorlunda ut de veckor du loggar mer mat, eller om du vill fylla i fler dagar för att få en säkrare underhållsnivå.

**The alcohol fixture, Torr.**

> Trendvikten har gått ner 0,6 kg på 28 dagar, vilket betyder i regel att energin under perioden legat under det kroppen gjort av med. Intaget har legat i snitt 190 kcal under underhållsnivån de senaste sju dagarna, och ett snitt under underhållsnivån ger i regel en nedgång över tid. Du äter rotfruktsgratäng, kycklingfilé, havregrynsgröt, grekisk yoghurt och laxfilé med potatis, men inga mängder eller kalorier per rätt finns här. Alkohol har legat på 9,0 standardglas de senaste sju dagarna, och alkohol bidrar i regel med energi utan att mätta. Rörelsen ligger på 270 minuter totalt under veckan, och rörelse bidrar i regel mindre till energin än maten gör. Sömnen har legat på ett snitt på 7,0 timmar, och jämn sömn gör det i regel lättare att orka med både mat och rörelse.

**The alcohol fixture, Peppig.**

> Trendvikten har sjunkit 0,6 kg på de senaste 28 dagarna, vilket i regel betyder att energin legat under det kroppen gjort av med. Intaget ligger i snitt drygt hundra kaloriunder underhållsnivån, och storleken på den skillnaden avgjer oftast takten för nedgången. Du har loggat mat sex av sju dagar de senaste veckan, medan intaget är ofyllt idag. Alkoholintaget ligger på nio glas de senaste sju dagarna, och eftersom alkohol bidrar med energi utan att mätta ligger den energin oftast utöver det som loggas som mat. Rörelsen består av sex pass och cirka 9 000 steg per dag, vilket i regel bidrar mer till hur kroppen mår än till själva energibalansen. Sömnen ligger på sju timmar i snitt, och jämn sömn gör det i regel lättare att orka med både mat och rörelse. Utan en aktiv plan finns inga makromål härleda, så du kan titta på om du vill justera något där. Om du vill kan du också fundera på om du vill lägga upp vanor för att få mer struktur i loggningen.

**The alcohol fixture, Saklig.**

> Trendvikten har minskat med 0,6 kg över 28 dagar, vilket i regel innebär att energin legat under det kroppen gjort av med. Intaget ligger i snitt 166 kcal under den adaptiva underhållsnivån på 2 540 kcal, och en skillnad av den storleken ger i regel en nedgång över tid där takten avgörs av gapet. De senaste sju dagarna har maten bestått av rotfruktsgratäng, kycklingfilé, havregrynsgröt, grekisk yoghurt och laxfilé med potatis, men inga makromål är ställda eftersom det inte finns någon aktiv plan. Alkoholintaget ligger på 9,0 standardglas de senaste sju dagarna, och alkohol bidrar i regel med energi utan att mätta, varvid den energin oftast ligger utöver det som loggas som mat. Rörelsen omfattar 6 pass under veckan och snittet ligger på 9 167 steg per dag, och rörelse bidrar i regel mindre till energibalansen än maten gör men mer till hur kroppen mår. Sömnen ligger på ett snitt på 7,0 timmar, och jämn sömn gör det i regel lättare att orka med både mat och rörelse. Om du vill kan du titta på om energin ser annorliden ut de veckor du dricker mindre alkohol, eller överväga att sätta en plan för att få fram makromål.

**What is different, read against the run above.** Every reply opens on the
trend and then says what a falling trend means, in the sheet's own words. The
alcohol fixture's three all reach alcohol, movement and sleep with the meaning
attached to each, which is the thing the old rule asked for and got once. The
development account's Peppig reply is the thinnest, with one marked sentence out
of four, and it is also the one that was refused.

**What the model still adds.** Saklig on the development account writes "vilket
är ovanligt" about a waist that grew while the weight fell, which is a small
interpretation of its own wrapped around the sheet's line. The same reply says
the rate "motsvarar den planerade takten", which is true of the figures in front
of it but is not a sentence the sheet wrote. Neither is refused by anything here,
and neither is recorded as solved: the rule says convey the sheet's
interpretation and add none, and a model that adds a clause is a model that
added a clause.

**Model typos, left as found**: "kaloriunder" and "avgjer" in Peppig on the
fixture, "annorliden" in Saklig. They are the model's, in a reply nobody edits,
and recording them is the point of a verbatim record.


### D156 — Where the image comes from is a variable, because this installation has used both

*2026-09-13.*

The 1.1.0 deploy began by reading what production actually runs, and the answer
was not what the runbook assumed. **The deployed stack file was not the file in
this repository.** Portainer was running a 91-line compose that hardcoded

```yaml
api:    image: vikt-api:d11c2fe
nginx:  image: vikt-web:d11c2fe
```

while `infra/docker-compose.portainer.yml` is 213 lines and pulls
`ghcr.io/lundstream/vikt-{api,web}:${IMAGE_TAG}`. So step 5 of the runbook —
"set `IMAGE_TAG`, Update the stack, Re-pull image" — **could not have worked**:
the deployed file never reads `IMAGE_TAG`, and setting it would have done
nothing at all while the panel showed the value that had been typed. That is the
exact failure shape D147's guard exists to prevent, one level up: the guard
checks that the *repository's* compose forwards what the API reads, and nothing
checked that the host was running the repository's compose.

#### Two paths, one of them undocumented

This installation has deployed both ways. `release.yml` builds and pushes to
GHCR, and the runbook is written for pulling from there. But production got here
by being **built on the workstation and `docker load`ed onto the host** (D120) —
which is why the running images report `RepoDigests: []`, why no `v1.0` exists
in any registry, and why the rollback plan was a sentence rather than a plan.

Only the registry path was written down. The path actually used was folklore.

#### A prefix, not a second file

`IMAGE_REPO` defaults to `ghcr.io/lundstream/` and is set to `local/` when the
images were built on a workstation:

```yaml
image: ${IMAGE_REPO:-ghcr.io/lundstream/}vikt-api:${IMAGE_TAG:?set IMAGE_TAG, e.g. 1.1.0}
```

A prefix rather than a flag, and one file rather than two, because a second
compose file for local deploys is precisely how the deployed stack came to be a
different file from the one in the repository. The two paths now differ in one
string and nothing else: same tag, same variables, same file, same guard.

The default is the registry, so the ordinary deploy needs no new variable and
only the unusual one has to say so.

#### The guard would have passed by finding nothing

`stack-variables.test.ts` asserted the image lines by matching the literal
`ghcr.io/lundstream/vikt-`, then checking the matches. With the registry behind
a variable that substring no longer appears, so the filter would have returned
an empty array and every assertion over it would have held vacuously — a green
test proving nothing, which is worse than a red one.

It matches on the image *name* now, asserts the count explicitly, and has a new
case holding that the registry is still the default. A filter feeding a loop
needs its length asserted, or it is not a test.

### D157 — A green test that asserted the bug

*2026-09-13, during the 1.1.0 deploy.*

The stack was updated, the images were right, every variable was set, and the
API crash-looped. The reason, in its own words:

```
Refusing to start. Fix the environment:
  - CONTACT_EMAIL is not set, and LANDING_ENABLED or REQUEST_ENABLED is true.
```

`CONTACT_EMAIL` **was** set. It was in Portainer, spelled correctly, visible in
the panel, and it had reached the nginx container. It had never reached the API,
because `docker-compose.portainer.yml` forwarded it to `nginx` and not to `api`.

That is D147's failure mode exactly — a variable the compose does not forward is
silently absent — and D147 built a test to prevent it. The test ran. It passed.

#### The test asserted the defect

`stack-variables.test.ts` parses the **api service's** environment block
specifically, which is the right design. To prove the parser was not simply
returning every name in the file, it asserted that one variable found elsewhere
was absent from the api block. The variable it picked was `CONTACT_EMAIL`:

```ts
// Not the nginx service's own, which sits in a different environment block.
expect(forwarded.has("CONTACT_EMAIL")).toBe(false);
```

So the guard against "the API does not get what it needs" contained a line
stating that the API does not get `CONTACT_EMAIL`, and was green for as long as
that was true. Fixing the compose turned the guard red, which is the first
useful thing it did here.

**A test pins the behaviour somebody believed at the time.** The belief was that
`CONTACT_EMAIL` is nginx's, because that is where it is substituted into the
page (D121). It is also read by `assertProdSecrets` at boot, which is a hundred
lines away in a different package, and nothing connected the two.

The sanity assertion now uses `OPERATOR`, which really is nginx's alone: it goes
into the built page and nothing on the server reads it.

#### Two holes behind the one defect

**`CONTACT_EMAIL` is not in `envSchema`.** The guard's main loop walks the schema
and checks each variable is forwarded and documented; anything read straight off
`process.env` is invisible to it. There is now an explicit short list of those,
checked the same way, because the cost of missing one is the API not starting.

**It was never in `.env.example` as a settable line.** It appeared only inside a
comment about `REQUEST_ENABLED`. The new check found that within a minute of
being written: an operator copying the example would never have set it, which is
the same outage arriving by a different route.

#### What it cost, and what it did not

Production was down for about four minutes, between the first stack update and
the corrected one. Nothing was lost: the migrator runs before the environment
check, so all nine migrations had already applied on the crash-looping boot, and
the row counts afterwards matched the backup exactly, 95 weight readings
included.

The backup taken in step 1 was never needed, which is the outcome that justifies
taking it rather than the one that excuses skipping it next time.

#### The deploy itself

Built on the workstation and loaded onto the host (D156), because the GHCR
packages are private and making them public is the owner's click. `local/`
prefix, `1.1.0`, `APP_VERSION` and `APP_COMMIT` baked in as D151 requires.
`/api/health` reports `1.1.0` and `62dde4f` from outside, the modes line reads
`landing=on request=off mail=on llm=on`, the vision self-test passed in 6.5 s,
and the previous images are tagged `local/vikt-{api,web}:d11c2fe` on the host so
a rollback is one variable.

#### Addendum, same day: how the fix reached production, and how it reached git

Worth recording precisely, because the order was not the usual one and the
summary "pushed straight to main" is not quite what happened.

**The fix reached the running system before it reached git at all.** With the
API crash-looping, the line was added to `infra/docker-compose.portainer.yml` on
the workstation and pushed to Portainer through the stack API. Production was
healthy again before anything was committed. The commit came afterwards, as the
record of a change that was already live.

**Two commits then reached `main` by fast-forward, with no pull request**:
`62dde4f`, which made the deploy possible at all, and `0a546a7`, this entry and
its fix. Both were authored on `dev` first and `main` was moved to them.

§7 says `main` receives merges **only through a pull request**. That was not
followed here, and the reason it was right at the time is narrow:

- production was down, and the change was one line in a file that is not
  application code;
- the repository has one committer, so a pull request adds a round trip and no
  second pair of eyes. Its value here is the record and the CI gate, and CI ran
  on `dev` for the same commits;
- the alternative was leaving the site down for the length of the round trip,
  to satisfy a rule whose purpose is to stop unreviewed code reaching
  production — and the code was already in production.

**The rule stands.** This was an outage, not a precedent, and the shape of the
exception is worth being explicit about: it applies when production is already
broken, the change is infrastructure rather than application code, and the fix
is live before the commit. Ordinary work, including everything in this session,
goes `dev` → pull request → `main`.

**`dev` and `main` carry the identical commits.** Both are at `0a546a7`;
`git rev-parse` on each returns the same sha. There is no work on `main` that
`dev` does not have, which is the property the branching rule exists to
protect and the one an emergency is most likely to break.

#### The negative control is derived now, not chosen

The assertion that made this outage possible has been replaced rather than
corrected. Naming `OPERATOR` by hand instead of `CONTACT_EMAIL` would have left
the same hand able to pick wrong again.

`nginxOnly()` computes the control: every variable in the **nginx** service's
environment block that `envSchema` does not declare and that is not on the short
`READ_OUTSIDE_SCHEMA` list. Today that derives `OPERATOR`, `REPO_URL` and
`SUPPORT_URL`, and the test asserts the set is **non-empty** before asserting
anything with it, because a control that derives nothing proves nothing.

Shown to bite rather than assumed to: forwarding `OPERATOR` to the api service
fails the guard with

```
OPERATOR reaches nginx and is not in the schema, so it should not be in the
api block: expected true to be false
```

and removing it again returns 111 passing. A variable that moves from nginx-only
to shared now has exactly one correct way to be recorded, which is to add it to
`READ_OUTSIDE_SCHEMA` or to the schema, and the guard fails until it is.

### D158 — No step that asks for a password

*2026-09-13.*

The 1.1.0 deploy was driven by a Portainer password pasted into a session. The
session is a transcript, so the password is burned and has to be rotated. That
is the **second** time the same credential has been rotated for the same reason:
the first was D120's, given during the original deployment work.

Twice is a pattern, and the pattern is not carelessness. It is that the runbook
had a step that needed a password, so somebody produced one, and the only place
to put it was the conversation. A rule saying "do not paste secrets" does not
survive a step that cannot proceed without one.

**So the step is gone.** `PORTAINER_TOKEN` is read from the environment, and
`scripts/portainer.mjs` is the only path from this repository to Portainer. With
the variable unset it prints the variable name and exits **2** — not 1, so a
caller can tell "not configured" from "the request failed" — and there is no
interactive fallback, no flag that takes a credential, and no call to the
password-exchange endpoint at all. There is nothing to type a password into.

`X-API-Key` rather than a bearer JWT, for a reason beyond convenience: obtaining
a JWT means sending a username and password, so a JWT-based path has the problem
built into it. An access token is issued once, used directly, and revoked on its
own without changing anybody's password.

#### What the guard actually checks

`secrets-hygiene.test.ts` has two halves and the second is the one worth having.

It **scans** the committed scripts, workflows and infra files for a password
path: the password-exchange endpoint, a `Password` field in a request body,
`read -s`, `Get-Credential`, a prompt naming a secret, and the old
`PORTAINER_PASSWORD` variable. That half is ordinary.

It also **runs the helper** with the variable unset, a five second timeout and
an empty stdin, and asserts it exited 2 rather than waiting. A script that
prompted would block or read EOF and carry on; either shows up here as a
failure. Asserting the refusal by reading the source would only prove the source
says so.

Writing it caught its own first offender immediately: the helper's header
comment explained that it does not call `/api/auth`, and spelling the path out
tripped the scan. The comment was reworded rather than the guard loosened. **A
guard a comment can talk its way around is not a guard**, and the alternative —
an exception for "mentions, not uses" — is the beginning of an allowlist.

#### What this does not buy

Portainer 2.33 Community Edition has two roles, administrator and standard user.
The least role that can redeploy the `vikt` stack is a standard user with access
to the `local` environment and to the stack, and such a user can still reach the
Docker API proxy for that environment, which is most of what an administrator
can do to containers on it. There is no "may redeploy this stack and nothing
else" in CE.

Recorded rather than glossed, because the honest gain here is narrower than
"least privilege": the token is **revocable on its own**, and it removes the
step where a secret gets typed into something that is recording.

#### Addendum, 2026-09-15: the environment is never listed, and a server can echo the token

The rule grew four clauses, each of them a way a secret leaves a process without
anybody deciding to leak it: listing the environment (`Get-ChildItem env:`,
`env`, `printenv`), writing a secret to a file (`Set-Content`, `Out-File`, `tee`,
`>`, `writeFile`), echoing or logging its value, and — found by writing the test
rather than by reading the code — **printing something a server sent back**.

**The echo leak was real.** `scripts/portainer.mjs` prints response bodies on
`get` and up to 400 characters of any error page. `secrets-echo.test.ts` runs it
with a dummy token against a local server that reflects `X-API-Key` into every
response, and against the script as it was the token came out three ways: a
reflected success on stdout, an echoed body on stdout, and an error page on
stderr. A proxy that echoes request headers into an error page is an ordinary
thing to meet, and the token would have gone into whatever was recording. Every
print now passes through `redact()`, which replaces the token with `<redacted>`
rather than suppressing the line, and a request that never reaches a server is
caught so its message is redacted too. Five of five pass.

The test checks three places after every run — stdout, stderr, and every file
under the working, temp and home directories the helper was given — and first
asserts the token really was sent, so a helper that failed before the request
cannot pass by saying nothing.

**The static patterns are tested both ways**, against lines they must catch and
lines they must leave alone, so the guard is shown to bite without the
repository ever containing an offender. Their first run over the committed files
still found five:

- **three false positives**, `createLlmClient(env)` in three API scripts. The
  env-command pattern had treated a bare `(` as a shell separator; it takes
  `$(` and a backtick now, and applies only to shell, PowerShell and YAML files,
  because in TypeScript `env` is an ordinary identifier and a shell-shaped
  pattern will keep finding shell-looking shapes in a language that is not
  shell. The line that tripped it is now one of the innocent lines;
- **two true shapes**, the fixture seeders printing `${PASSWORD}`. A committed
  development password is not a secret, and the lines were reworded anyway
  rather than the pattern given an exception, for the reason the first half of
  this entry gives about comments: an exception is the start of an allowlist.

**A secret in a scratch file counts.** The 1.1.0 deploy captured the VAPID pair
into `vapid.txt` in the session scratchpad, which is the "written to a file"
clause exactly. It was the only file there holding a secret value, and it was
deleted when the clause was written. `apps/api/src/scripts/vapid.ts` still prints
a generated pair by design, because installing it is its job; it belongs in a
terminal nobody is recording, which is now said where the rule is.

### D159 — The retention job would have deleted the rollback dump

*2026-09-13.*

`backup.sh` prunes old dumps by age:

```sh
find "$BACKUP_DIR" -name 'vikt-*.dump' -mtime "+$RETAIN_DAYS" -delete
```

Two properties of that line, neither intended: `find` **recurses**, and the
match is on **name only**. So anything named `vikt-*.dump` anywhere under
`/var/backups/vikt`, including in a subdirectory somebody made deliberately to
keep something, was on a thirty day timer.

That was found while deciding where to put the dump taken before 1.1.0. A
release's rollback dump has to survive for as long as that release is the one
running, which is by definition longer than a rotation window — and the job that
exists to protect backups would have deleted it, silently, a month in. The
failure would have surfaced at the only moment it matters.

`-maxdepth 1` on both prunes and on the count that reports what is kept. The
script now only ever deletes the dumps it made itself, in the directory it made
them in, and `releases/` is the convention for the ones that are kept on
purpose.

**A count that lies is worse than no count**, so the `REMAINING` line got
`-maxdepth 1` too. Without it the script would have reported release dumps as
part of the rotation window, so a run that had pruned everything it made would
still print a reassuring number.

#### Where the dump is

`/var/backups/vikt/releases/pre-1.1.0-62dde4f.dump` is the intended path, and
INFRA.md carries the checksum and the contents. It is **not there yet**: moving
it needs host access, the Portainer password was rotated in the same hour it was
taken, and the token that replaces it (D158) is Fredrik's to create. Until then
the only copy is on the workstation under gitignored `scratch/`, which is
recorded rather than left to be discovered.

Verified twice by restoring, once from the original and once from the copy:
38 tables, 3 402 rows, 95 weight readings, `pg_restore` exit 0. Checksumming a
copy proves the bytes; restoring it proves the bytes are a database.

#### Addendum, 2026-09-15: on the host, restored, and the premise it rested on

The dump is at `/var/backups/vikt/releases/pre-1.1.0-62dde4f.dump`, sha256 equal
after the copy, and `restore-check.sh` ran against it with exit 0: the derived
figures for the account with the most readings match the live database exactly.
The workstation copy is deleted.

Putting it there showed that **the host has none of the D96 setup** — no
`/srv/vikt/infra`, no `backup.sh`, no cron line, no `/var/backups/vikt` until
this created it. That is correct after D103, which moved the schedule into the
app. What is not correct is that the app's schedule was never configured either:
`backup_settings` has no row and `backup_runs` has none. Production has never
taken a backup that somebody did not start by hand, which is the exact gap D103
was written to close, reopened one step later at "set the destination".

`restore-check.sh` assumes a shell on the host with Docker and a compose file
beside it. None of that exists, so the unmodified script ran inside the
production Postgres container with `COMPOSE` pointed at a two-line shim that
drops `-f FILE exec -T postgres` and runs the rest in place. Recorded because a
restore check that needs a machine nobody has is a check nobody runs.

### D160 — Ask the registry the question the deploy will ask

*2026-09-13.*

The 1.1.0 deploy stopped on a private package. The repository was public, the
images were built and pushed, the workflow was green, and the Docker host could
not pull any of it — because a package on GHCR has **its own visibility**,
separate from the repository's, and it defaults to private.

Nothing between the push and the deploy had asked whether anybody could pull the
result. The workflow could not have noticed: `docker/login-action` authenticates
the job, so every request it makes succeeds regardless of visibility. A green
release proved the images existed, not that they were reachable.

#### The check

After the push, `release.yml` asks for an **anonymous** pull token and fetches
the manifest with it. No credential, deliberately going around the login the job
already has, because the question is what an unauthenticated Docker host sees.

A private package fails at the **token endpoint** with 401 rather than at the
manifest, so both are checked and either one fails the release. The error
message names the package and the exact place to change it, because the person
reading it at that moment is trying to deploy.

Shown to work in both directions before it was committed: the two real packages
pass, and a repository that cannot be read anonymously returns 403 at the token
endpoint and fails the check.

#### What public actually looks like

Proved three ways, and they agree:

| | `release.yml` pushed | anonymous manifest | anonymous `docker pull` |
|---|---|---|---|
| `vikt-api:v1.1.0` | `sha256:93020ecf…8373` | `sha256:93020ecf…8373` | `sha256:93020ecf…8373` |
| `vikt-web:v1.1.0` | `sha256:b9365eb1…7c1c` | `sha256:b9365eb1…7c1c` | `sha256:b9365eb1…7c1c` |

The pull was done after `docker logout ghcr.io`, with no auth entry for the
registry in the Docker config, which is the state the production host is in.

#### One thing worth knowing about these images

`v1.1.0` in the registry was built from `0a546a7`. **The images actually running
in production were built on the workstation from `62dde4f`**, one commit
earlier. No application code differs between them — `0a546a7` changed a compose
file, a test, `.env.example` and this file — but `APP_COMMIT` is baked in, so
deploying the registry image would change what `/api/health` reports without
changing what the app does.

Recorded because a digest that does not match the running container is the kind
of thing that costs an hour during an incident, and the answer is boring.

### D161 — The verdict goes in a file, and the cause was not what I said it was

*2026-09-13.*

`shoot2.mjs` takes forty screenshots and checks each one. Run in the background
with its stdout piped, it produced all forty images and **none** of its forty
verdict lines, so a sweep that had genuinely checked every screen could not
prove it had checked anything.

The reaction at the time was to write `overflow.mjs`, a second script asking the
same questions without taking the pictures. That worked and was the wrong shape:
two scripts asking one question will eventually disagree, and the one that is
cheaper to run is the one that gets trusted.

#### The diagnosis was wrong

I recorded the cause as `process.exit(0)` truncating a buffered pipe, in
`STATE.md` and in a commit message. **`shoot2.mjs` contains no `process.exit`.**
It ends at `ws.close()` and lets the event loop drain.

That was written from a plausible mechanism rather than from the file, and it
survived because it explained the symptom and nobody checked it against the
source. Both places are corrected. The real cause of the lost pipe is still not
established, and saying so is the honest end of it: what is established is that
stdout was empty, exit was 0, and the images were all there.

The fix does not depend on knowing. **The verdict is written to `verdict.txt` in
the output directory, one line per screen, appended as each is taken.** A file
survives a lost pipe whatever lost it.

#### Three properties worth the space

**The exit code is read back from the file**, not computed from a counter. That
is the difference between "this run believes it passed" and "the record on disk
says it passed": a line that never reached the file is not counted, which is the
right answer, because an unrecorded check is not a check.

**Appended as it goes**, so a run that dies half way through still leaves what
it established. The summary line is written last, so its absence reads as "this
did not finish" rather than as a pass.

**`process.exitCode` rather than `process.exit()`** — the mechanism I wrongly
blamed is a real one, and worth not introducing while fixing something else.

#### What the sweep checks now

Overflow and blankness, folded in from the deleted script, plus the swipe track
(D154). Blankness is judged on rendered text length rather than on the image,
because a screenshot of a white page and one of a still-loading page are the
same bytes to look at and different things to find.

All of it is asked in **one** `Runtime.evaluate` rather than four, so the
numbers describe the same paint. Four round trips let the page settle between
them, which is how a measurement ends up describing a state no screenshot was
taken of.

### D162 — Four duplicate blocks were the rule actually in force

*2026-09-13.*

`apps/web/src/styles/index.css` contained **five** `.select` blocks. Four of
them were copies of each other, and the fifth — the first in the file — was the
one somebody had written on purpose.

CSS takes the last declaration of equal specificity, so **the duplicates won**.
Every deliberate property of `.select` had been silently overridden since the
first commit of this repository, and the file read as though it had not.

#### What was actually being rendered

Measured on `/app/admin?vy=backup` through the browser, before and after, rather
than reasoned about:

| | before, duplicates winning | after |
|---|---|---|
| border radius | `6px` (`rounded-md`) | `8px` (`rounded-lg`), matching `.field` |
| surface, dark | `#0F1418` Natt, the **page** colour | `#16232B` Skymning, the card colour |
| padding | `8px` | `10px` |
| font size | `16px` (`text-base`) | `15px` (`text-body`) |
| chevron, light theme | `#6B7B82` | `#5c6b72` |

The surviving block's own comment says it matches `.field` "exactly apart from
the chevron", and it did not: a select sat on the page colour while every other
control sat on the card colour, which is the rule `.field`'s comment states in
the paragraph above it.

The last row is the clearest defect. The duplicate carried **one** hardcoded
chevron colour for both themes, so the light theme was drawing the dark theme's
grey. The intended block has a light colour and a `.dark .select` override, and
that override survived only because its specificity is higher than the
duplicates'.

**So this is not a tidy-up, and the brief's expectation that the rendering would
be unchanged is not what happened.** Removing dead duplicates usually changes
nothing; removing live ones changes four things, and all four move towards what
the file says it intends.

#### Where they came from, and where they did not

Both the intended block and the four copies arrive in `d313a34`, the initial
commit of this repository, which was imported from the old one. The duplication
is an artefact of that import.

That is **not** the same question as the one that prompted this. During one
session the count went 5 to 6, and later 5 to 11, with no command touching the
file. Four reproductions, each checked with `git diff` afterwards:

| | result |
|---|---|
| kill the dev server by port, clear `.vite`, start it again | unchanged |
| `pnpm build` | unchanged |
| the full screenshot sweep, forty screens | unchanged |
| `pnpm --filter web test`, which runs postcss and Tailwind over this exact file | unchanged |

Searched as well: no `writeFile`, `appendFile` or `createWriteStream` anywhere in
the repository's own code, no Vite plugin that writes (both `configureServer`
hooks are middleware), no `predev` or `postinstall`, no codegen, no `.vscode`,
no watcher dependency, and no git filter or `.gitattributes` rule that could
rewrite CSS.

**The writer was not found, and that is recorded as observed rather than
solved.** What is known: the increments happened only inside an editor-hosted
session, never in response to anything reproducible from a shell. The remaining
explanation is something outside the repository holding a stale buffer, which
cannot be tested from here.

#### The guard

`stylelint` with exactly one rule, `no-duplicate-selectors`, wired into
`pnpm lint` so it runs in the pre-commit hook and in CI.

One rule rather than a preset, deliberately. A style preset on a Tailwind
stylesheet spends its time objecting to `@apply` and to conventions this project
has already decided, and that noise is how a linter comes to be switched off.

Shown to bite before it was trusted: against the file as it was, it reports all
eight duplicate selectors with the line each was first used at, and exits 2.
Against the file as it is, it exits 0.

---

### D163 — The files that reach production outside an image have a checksum now

*2026-09-15.*

Everything this installation runs arrives in an image, with a tag and a digest,
except two files: `infra/backup.sh` and `infra/restore-check.sh`, which run from
the Docker host. They had no update path, and nothing said which version was
there.

#### The premise was wrong, in the worse direction

The brief for this said the host "still runs the version that deletes the
rollback dump at 30 days", so the `-maxdepth 1` fix from D159 needed to reach it.
It did not, because **the host ran no version**. `node scripts/host-scripts.mjs
check`, run before anything was changed:

```
MISSING  backup.sh         repository 97c01ed7…a701de   host missing
MISSING  restore-check.sh  repository 9b3eb71e…8363ab8   host missing
cron     not installed (/etc/cron.d/vikt-backup)
```

No `/srv/vikt`, no cron entry. D103 had moved scheduling into the app, and the
app's schedule has never been configured, so production had no backup of any
kind (STATE.md). D159's fix was real and was written for a host copy that did not
exist; the rollback dump was never on a timer.

#### What was built

`scripts/host-scripts.mjs`, on top of `scripts/portainer.mjs`:

- **`check`** compares the sha256 of the committed blob at `HEAD` with the host's
  copy in `/srv/vikt/infra`, read through a throwaway container from the
  `postgres:16-alpine` digest the stack already runs. Exit 1 on missing or
  different, and it says which.
- **`install`** writes the committed blobs there through Docker's archive
  endpoint, `root`, mode `755`, then runs `check`.
- **Committed blob, never working tree.** 162 tracked files have CRLF working
  copies on the workstation, `backup.sh` among them. A CRLF copy on the host is
  a "bad interpreter" error, and its checksum would never match a correct
  install.

After `install` from `23fd109`, both `equal`:
`backup.sh 02548ca5…9c03634`, `restore-check.sh 12d9f64e…d8d3fe1`.

`portainer.mjs` gained a raw `request()`, so the token is still read in one
place, and exported `out`/`err` so a second script prints through the same
redactor. Its CLI now runs only when it is the invoked file: imported, it shared
`argv` with the importer, and `host-scripts.mjs check` would also have run
`portainer.mjs check`.

#### The scripts could not have run there anyway

Both reached Postgres only through `docker compose -f $HERE/docker-compose.yml`.
A Portainer host keeps the stack file inside Portainer, and the repository's
Portainer compose file cannot be parsed without every stack variable set. So the
fallback `docs/backup.md` promised for "when the app is the thing that is broken"
had no invocation that worked on this host. Without a compose file beside them
they now use `docker exec -i ${POSTGRES_CONTAINER:-vikt-postgres-1}`.
`host-scripts.test.ts` runs both from a directory with no compose file and a
stand-in `docker` on PATH, and asserts every call went to the container by name.

**Not exercised on the host.** Running the installed copy from `/srv/vikt/infra`
needs a container that `chroot`s into the host root, and the session's permission
policy refused it. That is correct for the policy to ask about and is left to the
owner. The script body, with the compose call shimmed, did run against production
the same day (D159 addendum).

#### The cron line is reported and never installed

It is not a sync. With the app's scheduler as the design (D103), the line starts
a second nightly dump that is unencrypted and sits on the host next to what it
protects. That can be the right fallback and it is a decision about users' data,
so `check` says `not installed` with the reason, and `check --require-cron` exists
for the day somebody decides to add it.

---

### D164 — A deploy is a command that asks its questions first

*2026-09-15.*

Every deploy of this installation so far was a person in Portainer's variables
panel. Each way that goes wrong has already happened once: a tag set against a
stack file that did not read it (D156), a password typed into a recorded session
(D158), and `IMAGE_REPO` left at `local/` from the deploy before, which the
next deploy would have inherited without anything on the panel saying so.

`scripts/stack.mjs` replaces the panel for the ordinary case.

- **`plan <version>`** reads the stack and changes nothing. It answers, in
  order: does the stack file read `IMAGE_TAG` and `IMAGE_REPO`; is it the
  release's `infra/docker-compose.portainer.yml`; is any variable the release
  requires unset, and does the release read any the running file did not; what
  `IMAGE_REPO` and `IMAGE_TAG` go from and to; are both images anonymously
  pullable from GHCR (D160's two questions), or present on the host for a
  `--repo local/` build; and what is running now. Anything wrong is a
  `blocked:` line and exit 1.
- **`deploy <version>`** is the plan and then stops. **`--yes`** sends one
  stack update: every variable back with its value untouched and in its order,
  `IMAGE_REPO` and `IMAGE_TAG` set, the stack file kept, `pullImage: true`,
  `prune: false`. Then it waits for the API to be on the new image and healthy
  and nginx on the new image. It prints the API log lines INFRA.md step 6 reads,
  and ends `deployed x.y.z`, or prints the rollback command and exits 1.
- **A stack file that differs from the release's** is a blocker until the
  operator says `--release-file` or `--keep-file`. Replacing it silently would
  undo a deliberate local edit; keeping it silently is how D156 happened.

#### The secrets it has to hold

Portainer returns every stack variable's value in every stack response, and the
update must send them all back or they are cleared. So this script necessarily
has `SECRET_KEY`, `SESSION_SECRET`, the database password and the VAPID private
key in memory. What it may not do is print them: **names only, and values only
for `IMAGE_REPO` and `IMAGE_TAG`**, the two it owns. Log output passes through
`portainer.mjs`'s redactor and a line filter.

`stack-deploy.test.ts` stands up a Portainer and a registry locally, has the
stack return random dummy values for those four, and fails if any of them or the
token reaches stdout or stderr on a plan, a refused deploy or a completed one.
The same fake asserts the update body: all variables unchanged but two, pull on,
prune off, file kept, and no update sent on a missing tag, a stack file that
does not read `IMAGE_TAG`, a differing file without a flag, or no `--yes`.

`portainer.mjs` gained `request()` for callers that need a raw response, so
the token is still read and attached in one place.

#### What has run against production, and what has not

`plan 1.1.0`, read only, on 2026-09-15: stack file reads both variables and
equals the file at `v1.1.0`; 26 variables set, none required and unset, none
new; `IMAGE_REPO local/ -> ghcr.io/lundstream/`; both 1.1.0 images anonymously
pullable; api healthy on `local/vikt-api:1.1.0`; nothing blocks.

**`deploy --yes` has not run against production.** The owner deploys 1.1.1, and
that is its first real run. The panel stays documented as the fallback.

---

### D165 — Search says where it is, and a typo inside a long name is still a match

*2026-09-15.*

#### The premise, corrected first

The brief asked for a `pg_trgm` migration. **`pg_trgm` has been installed since
0004**, which also built a trigram index on the name and matched typos with
`similarity(name, query) > 0.3`. What was missing was not the extension but the
kind of similarity, and a fold.

Measured on the development catalogue (2 809 rows) before anything changed:

| query | against | whole-name similarity | word similarity | word similarity, folded |
|---|---|---|---|---|
| Yogghurt | Yoghurt naturell fett 3% berikad | 0.18 | 0.70 | 0.70 |
| frischgöld | brand Frischgold, name Gräddost | 0.00 | 0.00 | 1.00 |
| köttbullar mammas | Köttbullar frysvara | 0.41 | 0.61 | 0.61 |

A whole-name score punishes a long name for being long, so a misspelt word inside
one never clears 0.3; "Yogghurt" found one yoghurt of dozens. And ö and o share
no trigram, so a letter spelled differently on a keyboard than on a label scores
nothing at all.

#### The matching

**Migration 0030** adds one generated column, `search_name`: brand and name,
lower-cased, with `åäöéèêëüáàâïîôç` folded to `aaoeeeeuaaaiioc`, and one trigram
index on it. `lower` and `translate` are immutable, so no extension is needed
beyond 0004's. The same letters are written in `src/lib/search-fold.ts` for the
query side, and a test reads the migration to hold the two together and asks the
database to fold a sample to prove they agree.

The query matches in four ways, and the two thresholds are the cutoff:

- the Swedish `tsvector`, for stems;
- **every query word present, in any order**, as a substring of `search_name`;
- `search_name % q`, whole similarity above **0.3**, for a misspelt short name;
- `q <% search_name`, word similarity at or above **0.6**, for a misspelt word
  in a long one.

Both thresholds are pg_trgm's own defaults, chosen because they are the defaults
and not tuned to this catalogue, so they cannot have been fitted to the examples
that motivated them.

**The ranking no longer depends on word order.** An exact name counts for one
word; for several, every word present and no other word counts the same, so
"köttbullar mammas" and "mammas köttbullar" put the same row first. The prefix
bonus applies only to a single word, and the old brand-and-name phrase bonus is
replaced by the every-word one. LIKE wildcards in the query are escaped, which
the old `ILIKE '%' || q || '%'` did not do.

**Cost: none measurable.** Local search was 13 to 18 ms median before and 13 to
19 ms after, query by query within the run-to-run spread (docs/measurements.md,
"Local food search"). At this table size the planner scans, and the index is for
when the cache grows.

#### Search in two parts

`GET /food/search` takes `source=local|remote|all`. **Local** is the cache alone,
never the network, and says whether it has already answered (`enough`).
**Remote** is the food databases alone, under an eight-second deadline raced
against the adapters rather than trusted to them, because a rate limiter can
queue a request before its fetch sees the signal. **All** is both, as before,
and is the default, so nothing that predates the split changes.

Mat asks local first and shows its rows at once, then asks remote unless local
had answered, and appends what comes back without repeating a row. One line
under the list says where it is:

- "Söker", then "Söker i livsmedelsdatabasen" or "Söker vidare i
  livsmedelsdatabasen" when there are already rows, **in Sten** while anything
  is still running;
- on a timeout, on the server or in the browser at twelve seconds, the local
  rows stay and the line says the database did not answer in time;
- a source that was unavailable says so, with the server's sentence;
- **"Inget hittat" only when every source has answered empty.** Not while one
  is running, not after a timeout, not when a source was unavailable, because
  it is a claim about all of them.

The unavailable notice lost its dash (§5) on the way.

#### Exercised

Through the interface on the development account at 360 px and desktop:
"Yogghurt" showed the local yoghurts, then "Söker vidare i livsmedelsdatabasen"
in Sten with the list at eighteen rows, and the line cleared at about 300 ms.
"zzzqqqx" showed "Söker i livsmedelsdatabasen" and then "Inget hittat för
”zzzqqqx”." once the database had answered. **The local "Söker" state was never
caught on screen**: the cache answered inside the 60 ms sampling interval, so
that state is covered by the render test and not by an observation.

#### The role a migration needs, verified in production's image

Every migration, 0000 to 0030, was applied to fresh databases in
`postgres:16-alpine@sha256:cf78e767…`, the digest the stack runs (16.15):

- as the image's `POSTGRES_USER`, which the image makes a superuser, and which is
  how production's `vikt` role was made: **31 applied**;
- as `vikt_owner`, **not** superuser, no CREATEDB, owning only its database:
  **31 applied**. `pg_trgm` was created and owned by that role, because it is a
  trusted extension on PostgreSQL 13 and later.

So what a migration here needs is **ownership of the database**, not superuser.
Recorded in INFRA.md under "Migrating the database".

---

### D166 — Intake against trend change, one point per week, and the one line D34 now allows

*2026-09-15.*

#### What was wrong with the pane

It put a seven-day mean of intake beside a seven-day change in the trend on
**every day**. Each point shared six days with its neighbour, so a week of
eating was drawn as seven overlapping dots, and the change was measured over the
same seven days as the intake although the trend lags the scale by about nine
days at a daily cadence (D36). Most of what it plotted as a week's change
belonged to the week before.

#### What it is now

- **One point per whole calendar week, Monday to Sunday.** A week in progress is
  not a week. A week needs §4.2's coverage, six of seven days with intake, and
  its mean is taken over the logged days. Weeks that fall short are counted and
  shown as dropped, never averaged over seven.
- **The change is shifted by the lag** at the cadence this person actually
  weighs in (`trendLagDays`: 9 days daily, 6 weekly), and measured the §4.2 way:
  between the first and last reading inside the shifted week, over the days
  between them, stated in kg per week. A week whose shifted end is still in the
  future has not been answered yet and has no point.
- **Nothing until four whole weeks.** Below that the pane says "Inte än. N av 4
  hela veckor." rather than a day count that would promise a chart two days
  away when it is two weeks away.
- **One dashed line, in Sten: 7 × (intake − maintenance) / 7700 kg per week**,
  drawn only when maintenance is **measured** (`source: "adaptive"`). A line from
  the formula's figure would be a guess about this body wearing a measurement's
  clothes. The info text under the chart says what the lag is, what the line is,
  what a point above or below it means, and why a week near a change in intake
  sits off it.

`calc/weekly-intake.ts` does the arithmetic, the service assembles it, and the
coach's sheet names the pane in weeks.

#### Reopening D34, on purpose

D34 said this screen draws no line, and that a change adding one "has to reopen
the decision rather than drift past it". This is that reopening, asked for in
the brief, and it changes less than it looks:

- **Still no statistic.** No r, no slope, no fit, nothing computed from the
  points. The line is arithmetic on the maintenance figure and 7700 kcal per kg,
  and it would be the same line on an empty chart. The response carries its two
  inputs (`reference: { maintenanceKcal, kcalPerKg }`), and the API test that
  bans a field named after a coefficient, a slope or a trend line still passes.
- **The enforcement is tighter than it was.** D34 claimed a fourth guard, "no
  `<Line>` in `Correlations.tsx`", that existed only as a comment.
  `samband-weeks.test.tsx` now reads the source: no `<Line>`, no line on a
  `Scatter`, exactly one `ReferenceLine`, and it is built from
  `expectedChangeKgPerWeek(x, reference.maintenanceKcal)`.
- Sleep against energy and movement against sweat are untouched.

#### What the lag shift does and does not do, measured

A probe before the test was written, on a synthetic body that loses and gains
exactly what 7700 kcal per kg says from a maintenance of 2 500, weighed daily:

| week | off the line, unshifted | off the line, shifted 9 days |
|---|---|---|
| right after a change in intake | 0.32 to 0.59 kg/week | 0.13 to 0.23 |
| two weeks into a level | 0.08 to 0.14 | 0.04 to 0.06 |
| the last week before the next change | 0.04 to 0.07 | **0.16 to 0.34** |

**The shift does not undo the trend's smoothing, it moves it.** An exponential
average does not delay a week's change so much as smear it over the following
ten days, and no shift undoes a smear. Where intake has held for longer than the
lag, points land within 0.08 kg per week of the line, which the test asserts on
six-week levels. Right after a change the shift roughly halves the miss, and in
the week before the next change it makes the miss worse, because its span
reaches into the new level. Both halves are pinned in `weekly-intake.test.ts`,
so the first test is not read later as a claim about every week, and the note on
screen says the weeks nearest a change sit off the line while the trend catches
up.

**Not done, and the owner's call:** the smoothing can be inverted exactly (for a
daily series the weight is `trend[t] + (1 − α)/α × (trend[t] − trend[t−1])`), which
would put every synthetic week on the line. On real data it multiplies the
scale's day-to-day noise by about ten, which is the noise the trend exists to
remove. The brief asked for a lag correction, and that is what shipped.

#### Exercised

On `samband@example.test`, seeded by `apps/api/src/scripts/seed-samband-fixture.ts`
with a body that obeys 7700 kcal per kg over six weeks at 2 000 kcal and six at
2 800: **12 weekly points, the dashed line drawn, maintenance measured at 2 514
kcal against the 2 500 the body obeys.** On screen the settled weeks sit on the
line at about −0.45 and +0.27 kg per week, and the weeks right after the change
sit between, as the note says. 360 px and desktop, no overflow.

**The development account does not say "inte än", and the brief expected it
to.** It has **11 whole weeks** with six or more logged days, and 3 more dropped
for too few, so the pane draws. What it does not draw is the line: its
maintenance is not measured (68 % coverage over 28 days), and the note says so.
Its weekly means sit within 2 084 to 2 088 kcal, so the eleven points form a
column rather than a cloud, which is what that account's logging is.

The API test builds the same kind of body through the database (84 days at a
constant 2 000 kcal against 2 500): maintenance measured within 60 kcal of the
truth, every point on a Monday, and the last three weeks within 0.08 kg per week
of the line.

---

### D167 — One row per day, and a real spreadsheet of it

*2026-09-16.*

#### The table

Data gains a third tab, **Dagar**: one row per day with the date, weight, trend,
intake with its coverage, protein, carbohydrate, fat and fibre, alcohol, activity
minutes, steps, sleep, energy, mood, waist, maintenance as of that day with its
source, and intake minus maintenance. Seventeen columns, sortable by any of them,
newest first.

**Every figure comes from the calc that already owns it.** `buildDayTable` in
`calc/day-table.ts` adds no formula: the trend is §4.1's, the macros and their
"minst" are `dayMacros` (D55), and **maintenance as of each day is
`estimateTdee` run with that day as `asOf`**, which is exactly the figure and
source the dashboard showed on that day. A test checks the table's last row
against `/api/insights` for today. The API serves the rows; the screen prints
them with the shared formatter, so nothing is recomputed in the browser.

- **Intake coverage** is the share of the day's logged energy that came from
  entries carrying any macro at all. It is shown only below 100 %, in Sten, and it
  is null on a day with no food entries rather than zero.
- **An empty cell is a figure that is not filled in**, never a zero and never a
  dash (§5, which also forbids the dash the shared formatter prints for a
  non-finite value).
- **Manual intake wins over food entries for its day**, in the macros exactly as
  in the intake (`resolveMacros`, D44), so a manual day's macros are that one
  entry. The first draft of the Excel test logged food on a manual day, found
  the protein cell empty, and the app was right.
- **It scrolls sideways in its own region**, labelled and focusable, with the
  date column sticky, so on a phone the table moves and the page does not.
- **The trend column is plain text, not Lingon.** The first version drew it in
  the trend colour, and `colour-meaning.test.ts` refused it: §5 gives Lingon to
  the trend line and the wordmark, and a figure in a table is neither.

#### The Excel file

`GET /api/export/xlsx` writes a real Office Open XML workbook with **`exceljs`,
pinned to exactly 4.4.0**: the day table as the first sheet, then one sheet per
exported table.

**Numbers are numbers and dates are dates.** This is the decision worth writing
down, because the brief asked for "decimal comma" and there are two ways to give
it. A text cell reading "86,9" shows a comma and cannot be summed, sorted or
charted, which is the reason anybody wants a spreadsheet instead of a CSV. So
every figure is a number with a number format, and **Excel draws the decimal
separator from the reader's locale**: a comma on a Swedish machine. Dates are
Excel dates with a date format, built at UTC midnight so no timezone moves them a
day.

**"Minst" is a number format.** A partial macro is written as its known grams
with the format `"minst "0`: the cell reads "minst 30" and its value is 30, so
the sheet says what the table says and still adds up. The first version put the
format on every incomplete cell, including days with nothing logged, which gave
397 formatted empty cells on the development account; it is only on a cell with a
figure now, which gave 8, the same 8 the screen shows.

**The raw sheets are typed from the database, not guessed from the values.**
`information_schema.columns` says which columns are numeric, date, timestamp,
boolean or JSON, so a name that happens to be digits stays text and a `numeric`
that Drizzle returns as a string becomes a number.

**Swedish names live in one place**, `packages/shared/src/export-names.ts`, used
by the workbook's tabs and headers and by the CSV list on screen. A column with no
Swedish name keeps its database name, and the round-trip test refuses exactly that,
so a column added to an exported table cannot reach a workbook unnamed.

In memory rather than streamed: a personal account is a few thousand rows, and
the streaming writer cannot size a column after its rows are written.

#### Beside the CSV and JSON, which were not beside anything

Account deletion's hint said "en JSON-fil med hela kontot och CSV per tabell".
**No screen offered the CSV at all**; the endpoint existed and nothing linked to
it. So Inställningar gains **Ta med din data**, with Excel, the JSON file, and a
link per table for CSV with its Swedish name, and the hint is true.

A render test of an unrelated screen found the first version of that section
taking **all of Inställningar down**: it trusted the table list's shape, and a
stub answering without `tables` made `.map` throw. It draws the list only when
the answer really is one.

#### Verified

- **Tests:** the calc (8), the endpoint (5, including today's maintenance equal to
  the dashboard's), the workbook in `export-roundtrip.test.ts` (it is a zip; the
  first sheet equals `/api/day-table` cell by cell as numbers and dates; a partial
  macro is a number with the "minst" format and an empty cell has neither; every
  exported row is in its sheet under a Swedish header; another account's rows are
  absent), and the table's render (sorting, nulls last, "minst" in Sten, empty
  cells, the scrolling region).
- **Through the interface**, on the development account at 360 px and desktop:
  90 rows and 17 columns, the region scrolling 781 px sideways with **no page
  overflow**, weight sorting ascending with `aria-sort`, 8 "minst" cells, and the
  export section with Excel, JSON and 21 CSV links. The workbook downloaded
  through the page's own session, 71 248 bytes, opened and compared with the
  table fetched beside it: **2 014 cells, 0 mismatched**, 22 sheets, the first
  "Dagar".

---

### D168 — The backup leaves the container, and the app reads one back

**The scheduled backup had never written a byte anywhere that survives the
container, and no backup this app has ever taken had been read back.** Two
halves of one gap, closed together.

#### The mount

The compose mounted a named volume, `vikt_backups`, at `/backups`. The API runs
as uid 1000 and a named volume's mountpoint is created owned by root, so the
process could not write it. The destination the app had actually been given was
`/var/backups/vikt`, which is not mounted at all: a path inside the container's
own filesystem, also not writable by uid 1000. That is where production's
`EACCES` came from, and it is the failure mode where every individual part looks
right.

So `/backups` is now a **bind mount from the host**, required:

```yaml
- ${BACKUP_HOST_DIR:?set BACKUP_HOST_DIR to a host directory owned by uid 1000, e.g. /var/backups/vikt/app}:/backups
```

`:?` rather than a default, so a stack deployed without it **fails instead of
running with no backups**. The host side is three commands in INFRA.md and
`.env.example`: create the directory, `chown 1000:1000`, `chmod 700`. Its own
directory under `/var/backups/vikt`, because that directory holds the release
rollback dumps as root and should keep holding them as root.
`stack-variables.test.ts` holds all of it: a required bind at `/backups`, no
named volume there and none declared, and every `${VAR}` the api service's
volumes read documented in `.env.example`.

#### The restore check

A backup nobody has restored is a hope (`docs/backup.md` has said so since D96,
about the shell script's dumps, which were checked; the app's encrypted ones
never were). `runRestoreCheck` takes the newest `vikt-*.dump.enc` in the backup
directory, decrypts it with `SECRET_KEY`, creates a scratch database with a
generated name, `pg_restore`s into it, compares it with the live database, drops
the scratch database whatever happened, and records one `restore_checks` row
whatever happened.

**It never writes to the live database.** Putting a backup back is still a
command somebody types; this only proves the command would have something to
work with.

`judgeRestore` is deliberately **not** an equality check. The dump is older than
the comparison, so the live database has gained rows since, and a check that
failed on that would fail every night. What it refuses is structural: a table
the live database has and the restore does not, no migrations at all, **more**
migrations than the running schema (a dump newer than the code), a restore with
the schema and no rows, and no weight readings when the live database has some.
Fewer migrations than live is fine: the API migrates a restored dump on start.

It runs **monthly, after a scheduled backup**, rather than on a clock of its
own, so the file it reads is the newest one there is. From a command it is
`pnpm --filter api restore-check [file]` or, on the Docker host,
`docker exec vikt-api-1 node dist/restore-check.js` — the container already has
`pg_restore`, the key, the database and the mount, so the host needs nothing but
`docker`. It reads directories only: with an S3 destination it records a failed
row saying to download a file and run it on that, because there is no
`getObject` here to pretend otherwise.

Administration, Backup gains **Senaste återställningstest**, in Sten in every
state, "Inte än" until one has run. A check older than 35 days says so **in a
sentence**, not in colour: it is information about when, and §5 gives warnings
no colour. Thirty-five rather than thirty, so a check that ran late because the
backup ran late is not called old, while a schedule that has stopped is.

#### What runs where, decided

Production's nightly backup is the app's scheduled, encrypted one to the bound
host directory. `infra/backup.sh` stays the **manual pre-deploy** dump, the one
that restores without the app or its key. **No cron line is installed**: a
second, unencrypted nightly copy of everybody's data, on the host beside the
database it protects and pruned on a different clock, is not a backup strategy.
It is a decision now rather than an omission, written into INFRA.md and
`docs/backup.md`.

#### The screen's sentences were also wrong

The destination help said S3 was "ännu inte implementerat och sparas inte",
which stopped being true at D133, and offered `/var/backups/vikt` as the
example: the exact path that fails. Both rewritten, along with the API's 422
message that called the S3 secret a "share password".

#### Verified

- **Tests:** `restore-verdict.test.ts` (14: the file format decrypts, a wrong
  key and a truncated file and a not-a-backup file are each refused with their
  own reason, the due rule, and every judgement above), the compose guards in
  `stack-variables.test.ts`, and the suites around them. The api suite is 990
  passing, the web suite 381.
- **Exercised for real, against the development database**, by building the API
  image from this tree and running it with the dev database and
  `scratch/backups` bound at `/backups` — because the workstation has no
  `pg_dump`, and because that is the arrangement production will have. It
  applied `0031_restore_checks` on the way up (1 applied, 32 recorded), and
  `id` inside it is uid 1000 writing the bound host directory, which is the
  thing that failed in production.
- The destination `/backups` and a time were set **through the screen**. The
  scheduler then took a backup by itself: `vikt-20260915T232635Z.dump.enc`,
  336 112 bytes, on the host side of the mount. Thirty-seven seconds later the
  check it triggers ran: **ok, 46 tables, 3 912 rows, 32 migrations**. Then the
  same thing from the host's command, `docker exec … node dist/restore-check.js`,
  exit 0, a second row with trigger `command` and the same counts. Afterwards:
  **zero** `vikt_restorecheck%` databases left on the server.

---

### D169 — A release builds once, and the log says which build it is

Three things about deploying that were wrong in the same direction: something
ran that should not, something was missing from what an operator reads, and
something printed noise that looks like an error and is not.

#### The release workflow ran twice and failed once, every time

`gh release create` pushes a tag to `main` and publishes a release. With
`branches: ["main"]` beside `tags: ["v*.*.*"]` in the trigger, that started
**two** runs of `release.yml` on the same commit, and the branch one failed by
construction: a build with no tag calls itself `dev` (D151), and the step that
proves the image is anonymously pullable (D160) then asked GHCR for a tag named
`dev`, which nothing publishes. `anonymous manifest fetch for
lundstream/vikt-web:dev returned 404`, next to a green run of the identical
commit. The last pair was `35031311942` beside `35031311925`, for 1.1.1.

**Tags, not branches.** Nothing here has ever deployed an untagged `main` build:
the stack pins `IMAGE_TAG` and the runbook cuts versions with `gh release
create`. So the branch trigger is gone rather than the check being loosened. Two
consequences handled with it: `latest` was `enable={{is_default_branch}}`, which
could never be true again, and now follows releases, which is what the name
always implied; and the `paths-ignore` written for branch pushes went too, since
a tag adds no commits for a path filter to look at.

**The proof asks about a tag that exists.** `sha-<commit>` comes from
`type=sha,format=long` and is published by every run whatever started it, so
that is what is fetched anonymously, rather than a version string that is `dev`
outside a release. `apps/api/test/release-workflow.test.ts` holds the trigger,
the proof's tag, and `latest`'s condition.

#### The log did not say which build it was

The version has been baked into the image since D151 and reported by
`/api/health`. The one place it was missing was the log, which is what INFRA.md
step 6 tells an operator to read while a deploy comes up — so the runbook's list
of lines could not answer its own first question: **is this the new image, or
did the pull quietly do nothing?**

The API now writes `api build` with the version and the short commit as the
first line after it binds, and `scripts/stack.mjs` includes it in the excerpt it
prints.

**Two documents had been saying it already.** STATE.md has described the version
as sitting "as the first line of the boot log" since D151, and the runbook reads
step 6 as a list of lines to compare against. Both were describing a line that
was never written: the version reached `/api/health` and the footer of
Inställningar and stopped there. This is the same class of thing D160 found in
the registry and D163 found on the host, and it is worth naming as a class:
**a document can assert a behaviour into existence in everybody's head and
nowhere else**, and the fix is never to soften the document. That excerpt is described in the script as "the lines INFRA.md step 6
reads", and it had every line in that list except the one worth reading first.

#### The migrator opened every boot with a notice

`relation "__drizzle_migrations" already exists, skipping`, twice, on every
container start, because Drizzle's migrator issues `create ... if not exists`
and postgres-js prints Postgres notices. Silenced **at the client that emits
them**, by passing `onnotice` through `createDb`, not by filtering the output:
a grep would also hide the notice that means something. The test database has
done exactly this since it was written, with the same reason in a comment.

#### Verified

- `release-workflow.test.ts` (8) and `stack-deploy.test.ts` (7, now asserting the
  version line reaches the excerpt and that unrelated lines still do not), the
  full api suite, lint and typecheck.
- `pnpm --filter api db:migrate` against the development database prints one
  line, `Migrations: none to apply, 32 already recorded`, and no notice.
- The development API, restarted by its own watcher, logs
  `api build` with `version=dev` and the checkout's commit, which is what an
  unbuilt tree should say.

---

### D170 — A week where the eating changed is drawn as a ring

Samband's weekly pane draws a dashed line for what 7 700 kcal per kilo says a
week's intake should do (D166), and the note under it says that weeks near a
change in intake sit off the line while the trend catches up. **Which weeks
those are was left to the reader**, on a chart where being off the line is the
only thing a point can say.

So the weeks that changed are marked, and marked the way the weight graph marks
an imported reading: a **hollow ring** instead of a filled point. The same mark
for the same meaning, which is that this is a point of a different kind rather
than a worse one. No colour, no accent, no warning (§3, §5).

#### The threshold is measured, not chosen

A week is transitional when its mean intake differs from the previous week's
point by at least **400 kcal**. That number comes from the synthetic body the
weekly tests and the Samband fixture both use: six weeks at one level, six at
another, with the step between them varied, asking how far the week of the
change lands from the expected line.

| step, kcal | 100 | 200 | 300 | **400** | 500 | 600 | 800 |
|---|---|---|---|---|---|---|---|
| off the line, kg/week | 0.025 | 0.051 | 0.077 | **0.103** | 0.130 | 0.156 | 0.208 |

0,1 kg per week is where a point stops reading as on the line at this chart's
scale, and 400 is the first step past it. The fixture's own step is 800.

**Two things are deliberately not ringed**, and both are about the trend rather
than the eating:

- **the first week of any history** sits about 0.13 off the line because the
  trend is still warming up from its seed. It has no previous week to differ
  from, and calling it transitional would be a claim about eating that nothing
  supports;
- **the week before a change** is off the line too, often further than the week
  after it, because its lag-shifted span reaches into the next level. That is
  pinned by a test that predates this one, and it is a property of the shift,
  not of that week's food.

Both are what the existing note already says in words: distance from the line
near a change is the trend catching up.

#### Still no statistic (D34)

`transitional` is computed from two of the pane's own x values and changes how a
point is drawn. It adds no verdict, no coefficient and no fit, and the guard
that reads the raw payload for those words still passes. The note that explains
the rings appears **only when a ring is drawn**, and it names the same constant
the calc uses rather than a number retyped into the copy.

#### Verified

- `weekly-intake.test.ts` (15): 300 kcal is not marked and lands inside 0,1 kg;
  400 is marked and lands outside it; the fixture's six-and-six body produces
  **exactly one** ring, on the week the intake moved, and that week is genuinely
  off the line; the first point is never one; a body whose intake never moves
  produces none.
- `correlations.test.ts` (12) for the flag on the wire, `samband-weeks.test.tsx`
  for the note appearing with a ring and staying away without one, the web suite
  (383) and a workspace typecheck.
- **Through the interface**, on `samband@example.test` at desktop and 360 px:
  twelve weeks, **eleven filled points and one ring**, the ring note naming
  400 kcal, and no page overflow at 360.

---

### D171 — The app writes what a number means, and the coach conveys it

D155 added a rule to the prompt: for every area the coach raises, say in one
sentence what it means for the person's goal, marked as general when it is
general. Across six live replies **it did so once**, and the entry recorded that
without tuning the prompt around it, saying what to do if it recurred. It
recurred.

#### The sentence is the app's now

`coach-meaning.ts` holds a closed set of interpretations, keyed by domain and by
the state that domain is in, and every domain block of the sheet ends with a
`Vad det betyder:` line chosen from it. COACH_RULES no longer asks for an
interpretation; it says to carry the sheet's and add none.

Why this works where the rule did not: the model was being asked to produce a
sentence it had no data for, at the end of a reply that was already at its
length limit, from general knowledge it was told to mark as general. Every one
of those is a reason to drop it. Reading a sentence that is already there,
in a block it is already quoting figures from, is a different task.

Each line in the set:

- **carries its own general marker** (`i regel`, `för de flesta`, `oftast`,
  `brukar`), so the claim arrives marked wherever the model puts it;
- **states no figure**, because a number typed into a fixed string would be
  quotable without being anybody's data. A test greps them for digits;
- **is about what the data means, never about conduct** (§3);
- **was reviewed once, in one file**, which is the point of a closed set: it can
  be read in a sitting by somebody deciding whether the app should say it.

The state comes off what the section just said rather than being recomputed, so
the line and the figures above it cannot disagree. Ten domains carry one: weight,
intake, protein, fibre, alcohol, movement, steps, sleep, habits and
measurements. **Carbohydrate and fat carry none**, and that is the set being
closed rather than complete: this app has no general claim about them it is
willing to make, and inventing one to fill the table would be the opposite of
reviewed.

#### The causal rule became a check

D155 put "two series may sit side by side, never joined by a cause" in the
prompt, because Samband draws pairs and computes no relation at all (D34). Live
replies broke it anyway. It is a words-level check now, beside BLAME and
INSTRUCTION: `påverkar` and `leder till` refuse a sentence **unless it carries
one of the sheet's general markers**.

The exemption is the whole design. The app's own interpretation says one thing
affects another in general, and a coach repeating it must not be refused for
doing what it was told; a sentence saying the same thing about this person's
week, unmarked, is a claim nothing computed. One marker separates them, and it
is the same list the sheet writes with, shared between the two files so they
cannot drift.

#### One thing this cost

The first draft of the measurements line read "förändringar som vågen missar".
The reply guard refused it: `missar` is a reproach word in BLAME whatever its
subject is. The guard is deliberately blunt there and the app's copy is the
cheaper thing to change, so the line was reworded. Worth recording because the
test that caught it is the one that runs the reply guard over the app's own
sentences, and this is the second time it has earned its place.

#### Verified

- `coach-meaning.test.ts` (11): every line in every state carries a marker,
  states no digit, passes the reply guard and tells nobody what they should have
  done; the causal check refuses four unmarked sentences and allows three marked
  ones; an ordinary sentence is untouched.
- `coach-sheet.test.ts` (12) holds that a busy account's sheet carries exactly
  ten such lines and that each is one of the reviewed strings.
- `coach-tones.test.ts` (19) holds the new rule verbatim in all three tones.
- The api suite: **69 files, 1 011 passing, 9 skipped**, lint and typecheck clean.
- **Six live replies**, three tones on two accounts, recorded verbatim under
  D155: the interpretation appears in **all six** (against one of six before),
  and the new check refused exactly one sentence, of exactly the shape it exists
  for.

---

### D172 — Motion carries meaning, and restraint is the style

Written **before** the landing page was rebuilt rather than after, because the
rule that arrives after the animation is a rule about somebody else's next
animation.

§5 had a full theory of colour and nothing about movement, at the moment a page
was about to be built out of movement. The gap is the same shape the colour rule
fills: without it, the question "should this move" is answered by taste, and
taste on a marketing page answers yes.

**Motion carries meaning, or it does not happen.** A line drawing itself says
the trend accumulates; a figure counting up says it was measured rather than
chosen; a point appearing says a reading arrived. Every animation has to survive
"what does this tell the reader that the finished state does not", and most
answers are "nothing", which is the right answer and means no animation.

Three binding consequences: everything that moves **stops** (no perpetual
breathing, pulsing or drifting, with one exception for a field that is the
background rather than the subject and pauses when the tab is hidden); reduced
motion gets **the final frame**, not a stripped page, because an animation
written without that is the usual way the quality floor is breached; and the
**wordmark never moves**, which the logo section has said since D86 and which is
hardest to hold on exactly this page.

**Restraint is the style.** Natt is a matte, unlit surface: no gradients, glow,
glass, neon, glitch, 3D, or parallax beyond the hero. The product is a notebook
that draws one careful line, and the page introducing it is held to the taste of
the pages that are it.

**The public pages are dark only.** The app follows the reader's theme (D117).
A marketing page that changes its mind about its own colours has nothing to say
about restraint.

**Every §5 guard applies to the landing page.** `copy-style.test.ts`,
`colour-meaning.test.ts` and `class-names.test.ts` each already have a half that
reads the landing JSX rather than the dictionary, because the page ships without
it (D99, D111). The rule is written down now so the next page cannot be built
exempt.

---

### D173 — The landing page draws the argument before it states it

Built under D172's two rules, which were written first for exactly this reason:
motion carries meaning, and restraint is the style.

**The page's own argument is that a daily weight is noise and a trend is not.**
So the page opens by drawing that: about thirty readings arrive one at a time
over 1,5 s, scattered vertically the way a scale is wrong, and then a Lingon line
draws through them over 2 s and ends in its endpoint. Only after the picture has
made the argument does the tagline say it in words. Somebody who lands here and
never scrolls has already seen the difference between this and the app that
draws a jagged daily line.

#### The sections, in order

| | what it is |
|---|---|
| header | the lockup at 20 pt, "Så funkar det" and "Källkod" as text links, "Logga in" as a filled Snö button. Sticky, and Natt at 92 % with the scrim's blur once the page has scrolled. **Nothing links to `/kod`** (D127) |
| hero | a full viewport of Natt: the drawn graph, the tagline, one sentence in Snö, the Lingon primary action, a text link to the explanation, and D127's sentence about invitations. A sparse Is field drifts behind it and pauses with the tab |
| En dagsvikt är mest brus | a figure that flickers through six mornings of the same body and settles on the trend, beside fourteen daily readings the reader draws the trend through by scrolling |
| Underhåll mäts, inte räknas | the formula's number in Sten and the measured one in Snö, both counting up once when reached, both tabular so nothing moves |
| Det du loggar | six cards, one per area, each in its own accent: Blåbär for food, Gran for the day, Honung for the pot, Is for Samband, and **no accent** for reminders and the coach, because neither is an area |
| Appen i telefonen | three framed pictures of the demo account, one to a row with a sentence beside each, turning with their own position in the viewport |
| Din data | self-hosted, AGPL, CSV, JSON and Excel, self-deletion, with the links to `/integritet` and the source |
| Om AI | one column, no accent: it reads meals and writes the week's summary, it never produces a figure, and it runs on hardware the operator controls |

**The order above is the order of the page** (D180). Om AI moved to the bottom,
below Din data: it answers a question a reader only has once they know what the
app does, and it is the one section whose subject is a component rather than a
thing the reader gets. A page that explains its language model before it has
shown its screens is a page about the model. "Så ser det ut" became "Appen i
telefonen" (D177) and "Dina data" became "Din data" (D180).

#### Where the motion rules bit

**The one three-dimensional move on the page is the phone frames**, and §5 says
no 3D anywhere. It is written down here as the exception because it is
scroll-linked, it ends flat, and it stays flat: the frames say "this is a screen
you will hold" and then get out of the way. Reduced motion renders them flat and
they never tilt at all.

**Withdrawn by D177.** The frames are photographs of framed phones now, made by
hand, and tilting a picture of a tilted thing says nothing the still one does
not. There is no 3D on the page and §5's rule stands unqualified again.

**Addendum, 2026-09-17 (D178): reinstated, and named for what it is.** The
frames turn again, about twelve degrees either way, driven by their own position
in the viewport. Three things are different from the version D177 withdrew, and
they are the reason it is allowed back:

- **It is a position, not a drawing.** The frame faces wherever it is on the
  screen, the way an object on a shelf does, so it follows the scroll in both
  directions. Everything else on this page draws, and a drawing that undraws
  itself when the reader scrolls back to re-read a sentence is the opposite of
  "everything that moves, stops". That distinction is also why this uses
  `animation-timeline: view()` and the fortnight's line does not.
- **It carries no meaning, and that is written down rather than dressed up.**
  §5 asks every animation "what does this tell the reader that the finished
  state does not", and the honest answer here is nothing. It is decoration.
  **It is the only decoration on the page and it stays the only one**: the next
  one has to displace this, not join it.
- **No shadow.** Natt is a matte, unlit surface; a turning object with a drop
  shadow is a lit one.

Measured across a frame's whole travel: +12,0°, +6,7°, 0,0°, -6,7°, -12,0°, and
`box-shadow: none` at every one. Where scroll-driven animations do not exist,
and under reduced motion, the frames stand square.

**§5 carries it now** (D179). This addendum was the only place that said so,
while §5 said "no 3D" flatly, which left the document and the code disagreeing
with the reasoning filed somewhere else. The motion subsection names the
exception, says it is decoration, and says a second would have to displace it.

**The drifting field is the other exception**, the one §5 names itself: it may
drift without an end state only because it is background rather than subject. It
is at 25 % opacity, and `landing-motion.ts` pauses it when the tab is hidden.

**Everything else stops.** The reveals run once and the observer stops watching,
because an element that re-animates every time it crosses the viewport is a page
that will not hold still while somebody reads it.

#### Two bugs the measurements found, which looking would not have

**Neither line ever drew.** Both animate `stroke-dashoffset` from the path's
length to zero, and the length was `var(--len)`, which nothing defined. An
undefined custom property makes `stroke-dasharray` compute to `none`, the offset
to `0`, and the animation then runs against a dash pattern that does not exist.
The finished frame looks exactly like the intended one, so the page looked
right in every screenshot. It was found by asking the browser what it had
attached, not by looking: `pathLength="1"` means the value is `1`.

**The scroll-driven draw was over before it started**, twice. First because
`animation-timeline: view()` on the line measures *the line's* travel through
the viewport, and a 150 px graph enters and is covered within a flick of the
wheel: the timeline now belongs to the section and the line references it by
name. Then because the `animation` shorthand sets `animation-duration` to its
initial `0s`, and a scroll-driven animation with a zero duration is finished
before it begins. `animation-duration: auto` is what fills the range. Measured
afterwards, the offset moves 0,66 to 0,21 as the reader scrolls the section,
which is the effect the section is for.

#### Colour

Lingon is in two files and both are the rule rather than an exception to it:
`TrendDrawing.tsx`, whose lines **are** trend lines, and `LandingPrimary.tsx`,
which is profile page 4's own carve-out for this page's single action.
`colour-meaning.test.ts` names both.

**Sten had to be lightened for the public bundle.** The profile's `#6B7B82`
measures 4,22:1 on Natt and **3,65:1 on Skymning**, and this page is held to
4,5:1. The public pages use `#7C8C94`, which is 5,32:1 and 4,61:1. The light
theme has always done the same thing in the other direction, with a comment in
`tokens.css` saying it is to hold 4,5:1 on Papper. **The dark theme never got
that correction, so every meta line on a card in the app is at 3,65:1 today.**
That is a finding about the app and a change to the profile's own value, so it
is recorded in STATE.md and `docs/measurements.md` rather than made here.

#### The budget, which is not met

| | gzipped |
|---|---|
| the landing chunk | 11,7 kB |
| react and react-dom | 45,9 kB |
| **everything `/` fetches** | **57,6 kB** |

The brief asked for under 40 kB. React alone is more than that, so no amount of
work on the page reaches it. What would: **stop shipping React for this page**,
by prerendering the three static public pages at build time and loading React
only for `/kod`, which is the one with a form. That is a change to the build
rather than to the page, it is the obvious next step, and it was not done in the
same pass as the page. `apps/web/scripts/check-bundle.mjs` runs in CI, holds the
page at its current weight, and names the 40 kB target in its failure message so
the gap cannot quietly become the new normal.

#### Measured

Lighthouse 12.8.2, mobile settings, against the production build:
**performance 98, accessibility 100, cumulative layout shift 0**, LCP 2,2 s,
TBT 0 ms. Accessibility was 95 before the contrast fix. Zero layout shift with
this much animation is the number worth keeping: every figure is in the markup
at its final width before it counts, the screenshots carry `width` and `height`,
and the reveals move with `transform`.

#### Addendum, 2026-09-16: the budget is two numbers, and 40 kB is backlog

**React stays on the public pages.** The page's own code is 12,4 kB gzipped;
react and react-dom are 45,9. Nothing that can be done to the page reaches 40 kB
in total, because the framework alone is more than that, and the page's code is
a quarter of the budget it is being blamed for.

So the budget is **two numbers**, which answer different questions: the page's
own code at **15 kB**, which moves when a section is added and is the honest
measure of whether the page is getting heavy, and everything `/` fetches at
**60 kB**, which is what a stranger on a phone pays. Holding only the total would
let the page's own code triple unnoticed; holding only the page's code would let
a dependency arrive unnoticed.

**Prerendering is backlog, not a plan for this pass.** Rendering the three
static public pages to HTML at build time and loading React only for `/kod`
would take the total to a few kilobytes. It is a change to the build pipeline
and to how `/integritet`, `/villkor` and `/kod` are served, it touches nginx and
the dev server, and it is not something to do in the same pass as the page's
copy. It is written here so the gap stays visible rather than becoming the new
normal.

#### Two scripts, so nothing goes stale

`scripts/landing-shots.mjs` signs into the seeded demo account and captures the
three phone screens at the frame's own size, and `scripts/share-image.mjs` crops
the owner's artwork to the 1200 x 630 share card. The old page's screenshots
were an app three passes old: the colours had moved and the dropdowns had been
fixed, and the page went on showing the version somebody last remembered to
save. A screenshot is a claim, and a claim nothing regenerates rots.

---

### D174 — A stack variable is set by the deploy, not beside it

D164 took the deploy out of the panel: `stack.mjs` reads the stack, checks what
it can check, and updates the tag without anybody typing a password. What it
could not do was set a **variable**, so the runbook still said "Portainer,
Stacks, vikt, Editor, the variables panel underneath" for anything new.

That is a second update, and therefore a second restart. Worse, it is a restart
in the wrong order: the deploy brings up the new image, which needs the new
variable, and the variable arrives afterwards. 1.2.0 makes this concrete, because
`BACKUP_HOST_DIR` is `${BACKUP_HOST_DIR:?...}` and the stack refuses to start
without it (D168).

So `--set NAME=value`, `--set-from-env NAME` and `--unset NAME`, merged into
what the stack already has and sent **in the same update** as the compose file
and the tag.

#### Three properties, and a test for each

**Nothing is dropped.** Portainer's stack update replaces the environment
wholesale: what the script sends is what the stack will have, and a name missing
from the list is deleted. `assertNothingDropped` compares the list about to be
sent with the one just read and refuses if anything the stack had has gone
without being named to `--unset`. It is a guard against a future bug in the
merge, and the failure it prevents is deleting `SECRET_KEY` and the database
password and then restarting the stack on top of the loss.

**A secret is never an argument.** A name containing SECRET, PASS, KEY or TOKEN
is refused on the command line and has to come through `--set-from-env`, which
reads it from the shell and never prints it. An argument is in the shell's
history, in the process list while it runs, and in whatever is recording the
session, which is §7's rule about why a tool reads credentials from the
environment. The refusal names the flag to use instead, and does not echo the
value it refused.

**The plan says names, never values.** `--set` on `plan` prints
`setting: BACKUP_HOST_DIR (changed)` and nothing about what it would become.
There is no list of variables whose values are safe to print: today's is a
host directory and tomorrow's is whatever somebody passes to `--set-from-env`.

`stack-deploy.test.ts` runs all of it against the stack double: the one update
carrying both the release file and the variable, the refusal, the value never
reaching the output, the plan's names-only line, `--unset` removing a variable,
and the guard refusing a list that lost one.

#### The panel stays documented

Not as the way to do it, as the fallback for when the token is not to hand. The
same reasoning as D164's: the panel is not wrong, it is just a place where the
ordering mistake above is the default rather than an accident.

---

### D175 — Sten is lighter, because the profile's value never held 4,5:1

The profile promises 4,5:1. The dark theme's Sten, `#6B7B82`, measures **4,22 on
Natt, 3,65 on Skymning and 3,22 on Dis**, and Sten is what every meta line,
every unit beside a figure and every "inte än" is set in, at 12 px. So the
promise was false everywhere it mattered most, in the theme the profile calls
the primary one.

| | old | new | Natt | Skymning | Dis |
|---|---|---|---|---|---|
| dark | `#6B7B82` | **`#85949A`** | 5,91 | 5,12 | 4,52 |
| light | `#5C6B72` | **`#55636A`** | 5,46 | 5,08 | 4,55 |

Both are the nearest value on the same hue that passes on **every** surface,
lighter in the dark theme and darker in the light one. Profile v1.5 carries
them.

#### Skymning is not the worst surface

The obvious correction is the one that fixes the card: `#7A8B92` passes Skymning
at 4,53. It still fails **Dis** at 4,00, and Dis is the raised surface that
fields and chips sit on, with `bg-field text-muted` in two components today. One
step further is `#85949A`, which passes all three, and that is the value.

The light theme needed the same treatment. It had been corrected once already,
by hand, "to hold 4,5:1 on Papper" — the same mistake in the other direction:
one surface checked and the rest assumed. On Dis it was 4,05.

#### Why nothing caught it

`docs/measurements.md` has claimed **zero contrast failures on both themes**
since D117, from an audit that walked six rendered screens. An audit of screens
reports the pairs it happens to encounter; a token is not a pair, and the pair
that fails may simply not have been on any of the six. The claim was left in
that file with its correction beside it rather than quietly edited.

`contrast.test.ts` computes it instead: every body-text token against every
surface token, in both themes, from `tokens.css` itself. Body text is Snö and
Sten (profile page 3) and is held to 4,5:1. The five accents are marks and large
figures, held to the 3:1 WCAG puts on those, plus the profile's own claim that
they clear 4,5:1 against Natt.

**One exclusion, guarded rather than assumed.** Accents are checked on the page
and on a card, not on Dis, because nothing draws one there: the light theme's Is
on Dis is 2,78:1 and would fail even 3:1. A second test reads the components and
fails if anything ever pairs an accent with `bg-field`, so the exclusion cannot
outlive the fact that justifies it.

#### What it cost

One token in each theme, and the landing page's private override from D173
deleted: the public pages inherit the corrected Sten like everything else, which
is what should have happened in the first place.

---

### D176 — Three things a screenshot showed that no test could see

Three defects, found by looking at a photograph of the running app rather than
by any suite. Each is small; what they have in common is worth more than any of
them.

#### A weight with two decimals

"↓ 4,98 kg på 90 dagar", directly under a trend weight rendered as "86,9" on the
same card. §4.1 is explicit that a weight is one decimal, and the second one
claims a precision neither the scale nor the exponential average has. The call
site said `decimals: 2`; it says `formatKg` now, and reads "↓ 4,7 kg på 90
dagar".

**The guard is an allowance rather than a ban**, because two of the three
`decimals: 2` in this codebase are right: a rate in kg per week distinguishes
0,25 from 0,30, and waist over height lives between 0,40 and 0,60. So the rule is
the one `number-formatting.test.ts` already uses for raw numbers: write
`allow-two-decimals:` above the call with a reason. A weight cannot be justified
that way, and the failure message says so.

The guard's first run failed on **the comment explaining the fix**, because the
sentence contains the words it searches for. It blanks comments before searching
now, keeping the newlines so the line numbers still point at code, and reads the
allowance from the original text. That is the second time this pass a guard has
matched prose about the thing it was looking for.

#### A violet that is not in this repository

"Ätit i dag" rendered in **#8878D0**, sampled from the screenshot. The nutrition
token is `#5FA8E6` and has been since the first commit of this tree; production
serves `#5FA8E6`; the violet is profile v1.0's Blåbär, from a bundle that
predates this repository. **Nothing in these sources produces it**, so what the
screenshot shows is a stale install rather than a defect in the code.

What *was* wrong here is that `CLAUDE.md` documented `--blabar #8C7FD1` long
after profile v1.1 moved it, which is the only place in the tree that still
asserted the violet, and is a plausible way for somebody to reintroduce it.

So the fix is the documentation, and the guard is the one that would catch the
drift next time: Blåbär is named to `colour-meaning.test.ts` the way Lingon is,
with the four files allowed to use it, a check that the day's eaten figure is
actually drawn in it, and a check that **the value CLAUDE.md documents is the
value `tokens.css` carries**. A document that disagrees with the tokens is how
this started.

#### A chip in sentence case

"≈ Uppskattad", where profile page 6's state chips are "loggat",
"uppskattning", "importerad" and "ofullständig": lower case, and a state rather
than a sentence. The estimate chip is `uppskattning` now, and its siblings
follow the same rule.

The test finds the chips **structurally**, by reading the `t("…")` calls inside
elements carrying the `tag` class, so a chip added next year is covered without
anybody remembering. Its first version parsed to the closing tag and found
nothing: the estimate chip holds a nested `<span aria-hidden>≈</span>`, so a
lazy match stops at the inner one and captures everything except the key.

#### What the three have in common

Every one was visible in a picture and invisible to 415 tests, because each is a
property of a rendered result rather than of a value: a decimal place, a
resolved colour, a capital letter. The suites assert what a function returns.
The three guards added here assert what the source is allowed to say, which is
the closest a test gets to looking.

---

### D177 — The landing page's lines are the app's own arithmetic

A second pass over the page D173 built, and one finding runs through most of it:
**the page was illustrating its own argument with things it had drawn by hand.**

#### The hero was a curve somebody sketched

`M 8 34 C 86 44, 120 96, 180 106 S 268 132, 312 128`. Four control points, chosen
because they looked like a trend, with thirty readings scattered around them by
a seeded generator. A page whose whole claim is "this app draws the trend rather
than the noise" cannot make that claim with a shape drawn to look like one, and
nothing would have noticed if §4.1 changed underneath it.

Both series are dated readings now, and the trend through each is computed by
`packages/shared`'s own EMA in `scripts/landing-fixture.mjs`, at build time, into
`fixture.generated.ts`. `landing-fixture.test.ts` recomputes both from the same
readings and fails on any vertex that has moved, and asserts the drawn path is
those vertices and contains no curve command. **The guarantee is the test, not
the comment.**

Generated rather than computed in the browser because §4.1 and its dependencies
in a bundle that exists to show a stranger one picture is the wrong trade, and
the budget below is tight.

**The cadence had to change to make the line read as a trend.** At thirty
readings across ninety days, §4.1's per-day alpha compounds over the three-day
gaps into an effective 0,27, and the line chases the noise instead of cutting
through it: the first render was visibly jagged. Every other day gives 0,19 and
a line that reads as what it is. That is the smoothing being honest about
cadence (D36), seen on a marketing page rather than in a test.

#### Scroll progress only increases

The fortnight's line was drawn by `animation-timeline: view()`, which runs
backwards when the reader scrolls up: the line undrew itself while somebody
scrolled back to re-read the paragraph beside it. A scroll timeline is the right
tool for an effect that should reverse, and this is not one.

`landing-motion.ts` computes the section's travel past the viewport's midline and
keeps the **maximum seen so far**, writes it to `--progress`, and removes its own
listener once it reaches 1. The line's dash offset and each reading's opacity are
both functions of that one number, so the readings arrive under the line rather
than waiting in a cloud for it.

Measured at four scroll positions: 0, 0, 0,769, 1,0, with 0, 0, 11 and 14 of the
fourteen readings shown; and after scrolling back to the top, still 1,0 and 14.

**One reading never appeared**, at 13 of 14, because the last dot's threshold was
exactly 1 and the comparison is strict. The positions are compressed into 0 to
0,92 now. It is the kind of defect that a picture shows and an assertion about a
number does not.

#### Addendum, 2026-09-17 (D180): the line lands

One ring in Lingon expands out of the endpoint and fades, over about half a
second, at the moment the line reaches today. Then the page holds still for
300 ms, and only then does the first word arrive.

**This is motion that carries meaning, and the meaning is the oldest one on the
page: a reading arriving.** Every dot in the hero says it thirty times while the
line is being drawn; the ring says it once more, for the reading the trend line
actually ends on, which is the one the reader would have taken this morning. The
still frame cannot say "this is today" because the endpoint is already drawn by
then, and §5's question is what the movement tells the reader that the finished
state does not.

It is not the tilt's kind of motion and does not spend that budget: **it stops.**
One run, ending at opacity 0, and nothing on the page pulses at rest. The beat of
silence after it is part of the same sentence: the picture has finished saying
its part, and the words that follow are the next one.

Under reduced motion there is no ring at all. An arrival is a thing that
happens, and when nothing is allowed to happen the reader is shown what the
sequence was going to say: a drawn line with its endpoint on it.

**One thing about how it is written, because it cost a measurement.** The fill
mode is `forwards`, not `both`. `both` includes the backwards fill, which
applies the first keyframe *during the delay*, so the ring sat at nine tenths
opacity from the first paint, two and a half seconds before the line reached it,
and the `opacity: 0` rule on the element could not win against it. The page
looked right in every screenshot taken after three seconds.

#### Everything else

- **The endpoint arrives when the line reaches it.** It was timed 3400 ms against
  a line that finishes at 3500, which is a full stop at the end of a sentence
  still being written.
- **Natt across the whole page.** The sections alternated Natt and Skymning,
  which made the page read as bands rather than as one surface; cards stay
  Skymning, as page 6 says.
- **One container.** The page mixed `max-w-3xl` and `max-w-5xl`, so paragraphs
  changed width between sections for no reason a reader could see.
- **Units are back on the figures**, smaller and in Sten, which page 5 requires
  and the maintenance figures had lost.
- **The header carries two items**, "Källkod" and "Logga in". "Så funkar det" was
  in the header and in the hero; the header is not where somebody decides to read
  an explanation.
- **The phone pictures are made by hand** and the sweep that produced them is
  deleted. They are framed, composed images of the demo account, which a
  screenshot script cannot produce. `scripts/landing-screens.mjs` resizes them
  from 780 kB to about 180 kB each; **they go stale silently**, so the rule to
  regenerate them lives in STATE.md and in the release runbook.
- **The 3D exception is withdrawn.** D173 wrote one for the phone frames' tilt.
  The pictures are of framed phones already, and tilting a picture of a tilted
  thing says nothing the still frame does not, so §5's rule stands unqualified
  again.
- **The footer's operator sentence is dropped when there is no operator.** It
  fell back to a description, so an installation that had not set `OPERATOR`
  read "Den här installationen drivs av den som driver den här installationen":
  a sentence eating its own tail, which is worse than no sentence because it
  looks like an answer.

#### Measured again, all of it

Lighthouse 12.8.2, mobile, on the production build: **performance 98,
accessibility 100, cumulative layout shift 0**. The hero: 4 of 30 readings at
419 ms, all 30 by 2,1 s with the line a quarter drawn, the line finished by
3,2 s, the endpoint appearing only after that. Reduced motion, 900 ms after
load: every reading present, both lines drawn, progress 1. 360 px with no page
overflow, and a mid-scroll shot with the line a third drawn and five of the
fourteen readings arrived.

---

### D178 — The page draws the app's curve, and the screenshots are a command

A third pass over the landing page. D177 made both lines the app's own
arithmetic; this one makes them look like the app, and turns the one part of the
page that was still hand work into something repeatable.

#### The raw screenshots are `pnpm shots:phone`

The three phone pictures are framed by hand in a mockup tool, and D177 recorded
that as a rule to remember: take them again when Översikt, Mat or Framsteg
changes visibly. A rule to remember is a rule that will be forgotten, and the
part of the job that actually takes the time is not the framing.

So the **raw** captures are a command now. `scripts/phone-shots.mjs` renders the
three screens for the seeded demo account at 440 x 956 CSS px, device scale
factor 3, dark theme, scrolled to the top, into `docs/screens/raw/`. Framing
stays manual, because a composed picture is not a capture; everything before it
is a script.

**It asserts before it writes.** These images are a stranger's first sight of
the app, and D176 fixed three things a screenshot showed and no test could see.
A screenshot script is exactly where those come back unnoticed, so each is
checked in the DOM before the file is written: the trend delta at one decimal,
the day's kcal figure carrying the nutrition token, the estimate chip lowercase.
A failed assertion writes no file, because **a raw shot of a defect becomes a
framed picture of it**.

**And a check that never ran is a failure too.** The run ends by asking whether
each of the three was exercised anywhere, and names the ones that were not. That
is the same reason `check-skips.mjs` exists: a check that passed because its
subject was absent is silence, and this project has been caught by silence twice.

Running it found two things that had nothing to do with screenshots:

- **`seed:dev` computed its dates in UTC** while every row it writes carries a
  `localDate`, which the app reads as a local calendar date. Between midnight
  and 02:00 Stockholm the seed wrote a series whose last day was yesterday, so a
  freshly seeded account read "inget loggat i dag än" on every screen and the
  maintenance figure fell below its coverage gate. It uses the profile's own
  zone now.
- **`landing-screens.mjs` hardcoded the first set's aspect ratio**, 1419 x 2796.
  The next framed set was 1839 x 3840, which would have stretched all three
  pictures on the page with nothing to say so. The height is read out of the
  source PNG's header now, and `landing-screens.test.ts` holds the page's
  declared `width`/`height` to the files on disk, because a wrong pair there is
  layout shift on the one page whose score anybody measures.

#### The curve is the app's curve

Both lines were straight segments between daily values. On a fortnight of daily
readings that is a polyline of fourteen corners where the app draws one
continuous curve, so the page was illustrating the product with something the
product does not do.

`seeded.ts` implements the monotone cubic d3 uses and Recharts' `type="monotone"`
selects, over the same vertices, with `TrendChart.tsx`'s own stroke width, dot
radius and endpoint radius. The viewBox is 640 wide because that is roughly the
width the page draws it at, so those three numbers are the app's numbers rather
than the app's numbers times an arbitrary scale.

Monotone rather than a natural cubic for the reason the chart already gives: a
natural cubic overshoots and draws a weight nobody recorded. The test samples
every segment and fails on an overshoot, so that property is checked rather than
inherited.

#### The line is warmed up before the picture starts

§4.1 seeds the trend on the first reading: `trend[0] = weight[0]`. A line
computed over exactly the readings on screen therefore **starts on a point**, at
whatever that morning's water weight was, and spends its first week walking back
to where the body actually is. That is an artefact of where the picture was
cropped, and the page was showing it twice.

Each series is computed over more readings than it draws: sixty for the hero,
forty-two days for the fortnight, of which the last thirty and fourteen are
shown, with the line drawn from **one vertex before** the window so it enters at
the left edge rather than beginning inside the picture. There is no dot on its
start. It is what the app's own chart shows for any window of a longer history.

**The warm-up is not shipped.** An array literal cannot be tree-shaken element
by element, so the first version sent a hundred numbers to a stranger's phone
for a picture that does not contain them, and took the page to 59,6 kB of a
60 kB budget. `fixture.generated.ts` now holds the drawn window and
`fixture.source.generated.ts` the whole series; only the test imports the
second, and a test fails if anything that ships starts importing it.

#### The points and the line advance together

Thirty readings used to arrive as a cloud over 1,5 s and then have a line drawn
through them, which says the trend was fitted to the data afterwards rather than
accumulated as it came. Now each reading carries where it sits along the line,
and appears just before the line reaches its date: in the hero across the same
two seconds, in the fortnight as the scroll passes it.

**That needed two numbers, not one.** The line draws on an ease-out and covers
two fifths of its length in the first quarter of its time, so dots delayed by
their position fell behind in the middle and were overtaken by the line they
were meant to precede. `seeded.ts` inverts the easing, so each dot carries both
where the line reaches it and when. Measured: 40 % drawn at 12 of 30 readings,
73 % at 22, 90 % at 27.

#### Everything else

- **The drifting field is gone.** It was the one thing on the page with no end
  state, allowed by §5 only as background. At hero size it read as dust on the
  lens, and the graph's own readings are the noise the page is about. Nothing on
  the page runs without an end now, so nothing pauses with the tab either.
- **The hero's scatter is the fortnight's scatter**, about 0,8 kg from the
  trend. It was twice as wide, which between the two pictures said the noise
  gets smaller the longer you look at it, and the page argues the opposite.
- **The hero block is centred** and every other section is left aligned. It is
  the one section that is a single column with nothing beside it to align to.
- **"En dagsvikt är mest brus" has the rule the other sections have.** Its
  heading sat inside the first column of a two-column grid, so the rule ran
  across half the page and the section read as a card.
- **The phone pictures are one to a row**, each with a sentence beside it, sides
  alternating. At a third of the container a phone is 280 px wide and its
  content is unreadable, which makes the picture decoration.
- **README shows the same three files as the page**, so there is one
  hand-maintained set rather than two. The pair that used to be README's own
  came from the sweep D177 deleted and nothing regenerated them.

#### The sweep can see the landing page again

`shoot2.mjs` measures a page, sets the viewport to that height and captures it
whole, which keeps Recharts from re-measuring mid-shot. The landing page's hero
is `min-h-[100svh]`, so that makes the hero alone fill the capture and
everything below it falls outside: two sweeps in a row produced a landing shot
of one stretched hero and recorded "ok" against it.

The strategy is **chosen by measuring** now, not by a list of page names: the
page is measured at the nominal viewport and again at a taller one, and if its
height moved with the window it is captured with `captureBeyondViewport` at the
normal height instead. The verdict line names which was used, so a shot is never
read as proving more than it does.

---

### D179 — The page says it in words and figures, not in two pictures

A fourth pass. The through line is that the page had started **drawing the same
argument twice**, and that a page which repeats itself in pictures has made the
second picture decoration, which is the question §5 asks of any motion.

#### The second graph is gone

"En dagsvikt är mest brus" drew a trend line through fourteen daily readings,
with the same marks as the hero, driven by the reader's wheel. The hero already
shows noise and trend as a picture; this said it again, more slowly, and
required a scroll listener to say it.

The section states it in figures now, which is also the form it takes on a
bathroom scale: fourteen mornings as small tabular numbers in Sten, seven across
and two down the way a calendar shows a fortnight, and beside them the one
figure the app makes of them, in Snö. The readings land 80 ms apart when the
section is reached and the figure stops flickering on the frame the fourteenth
lands, with that timing **derived from the step** rather than typed as a round
number beside it.

**Nothing in the section responds to scroll.** The monotonic progress driver
went with the line it drove: it measured the section's travel past the midline,
kept the maximum seen so far so the line never undrew itself, and removed itself
at 1. All correct, and all in service of the second drawing.

**The check followed the claim.** A vertex test over a line the page no longer
draws would be a test of nothing, so it is a value test: the figure equals what
§4.1 says for the fourteenth morning, formatted the way the page formats it.
With three smaller ones the argument depends on: every morning is written as a
weight, the figure is the last morning's rather than some other day's, and it is
**not one of the fourteen readings**, because the whole point is that none of
them was the answer.

#### The claim arrives a word at a time

After the line has drawn: "Gör", "det", "lättare." each fade in and rise eight
pixels, 120 ms apart. No scale and no bounce, because a word that overshoots and
settles is a word performing. The full stop is part of the last word, and
`copy-style.test.ts` now holds that there is **no exclamation mark anywhere on
the page**: an exclamation mark is the punctuation of a page that is selling,
and this one is explaining.

Two things about how the guards see it. The words are written out in the JSX
rather than mapped over an array, because the copy guards read strings out of
the file and copy in a JavaScript array is copy they cannot see. And they are
single words, which `jsxStrings` drops on purpose, so the tagline is read back
out of the markup and checked as the sentence it makes, while the
exclamation-mark rule reads every text node instead of the extracted strings:
the loudest thing on a page is usually one word long.

#### The frames' tilt is in §5 now

D173's addendum has said since it was reinstated that the tilt is the one motion
on the page carrying no meaning. §5 is where the rule lives, and §5 said "no 3D"
with no qualification, so the code and the binding document disagreed and only
`DECISIONS.md` knew why. The motion subsection names it, says one piece is the
budget, and says the next animation that cannot answer §5's question **replaces
this or is not built**.

#### Two defects, both fixed at their source

**An ISO date in the interface.** The weekly review card read "Veckan från
2026-09-07". That is D26's raw number with the type changed: the value is a
`string`, so nothing that looks at types can see it, and it went out to the one
card on Översikt that a reader stops and reads.

The guard is extended by **name**, since a string is not a date to a compiler:
an interpolation of `localDate`, `weekStart`, `weekEnd`, `achievedAt` or
`startedAt` into rendered text, or into a value handed to the dictionary, fails
unless it is inside one of `lib/dates.ts`'s formatters. The first draft also
listed `day`, `from` and `to` and caught sixteen call sites that were already
correct, because those names hold something formatted a few lines earlier; one
of them was an email address. **The list has to stay short**, and that is the
reason why.

**A two-decimal weight in the sheet.** It said the trend fell "0,32 kg denna
vecka" and the coach quoted that into the same card. §4.1 gives any trend figure
one decimal, and the weekly rate was passed a `2` at each of its three call
sites.

Precision is a property of the **unit** now, in one table that both the sheet
and the traceable set read. They were two lists of numbers, and they already
disagreed: a ratio was written with two decimals and recorded with one, so a
reply quoting the sheet exactly would have been refused for quoting it. That
also gave waist-to-height its own unit, since it was filed with the 1-to-5
self-ratings because neither carries a unit word, which is what let them
disagree in the first place.

#### The pictures keep their transparency

The framed sources are phones cut out of their background. `landing-screens.mjs`
resized them through a headless page and captured it, and **a captured page is
opaque**: Chrome paints its own white behind anything transparent unless it is
told not to. The delivered files were RGB with a white rectangle baked in behind
a black phone, invisible on Natt, through three passes.

`setDefaultBackgroundColorOverride` at zero alpha keeps it, and the test reads
the files back: colour type 6, eight bits a channel, not interlaced, and the
pixel at 0,0 fully transparent. That corner is the strongest single check, since
0,0 is outside the frame on every one of them.

#### Alignment, measured rather than assumed

Every section's heading and text already sat on the same left edge, and the two
text-only sections already ran to a 65ch measure with nothing beside them. Two
smaller blocks did not: the fourteen mornings were centred in their grid cells,
so the first column did not start where its heading does, and each phone picture
was centred in its column. Both are left aligned now, except on a phone, where
the row is a single column and centring the picture is right.

#### And a score that was flickering

A Lighthouse run scored accessibility **93** with a contrast failure naming
`#c43e55`, a colour in no stylesheet: axe had sampled the primary button part
way through its fade in, so the background it measured was Lingon at 86 % over
Natt. Two runs after it scored 100.

The fade is not the finding. Natt on Lingon measures **4,58:1** against a 4,5
floor, so any compositing at all drops it under, and **nothing was holding that
pair**: the contrast guard checks text on a surface and accents drawn on one,
and this is the one place in the tree that is text *on* an accent (D99's
carve-out for this page's single action). It is held now, with the headroom
asserted as well as the floor, so a change that makes it worse while still
passing fails in a test rather than in whichever Lighthouse run happens to catch
the fade.

---

### D180 — The page reads at a talking pace, and says each thing once

The fifth pass and the last before 1.2.0. Four passes made the page true; this
one makes it legible, which turned out to be mostly about **time**.

#### The words arrive 700 ms apart, not 120

At 120 ms the three words of "Gör det lättare." read as one movement with a
stutter in it: a transition dressed up as a sentence. At 700 each word is on
screen long enough to be read before the next arrives, which is the pace
somebody says it at. The page is explaining rather than revealing, and the tempo
is part of the argument.

The gap is one custom property and the sentence's delay is a multiple of it, so
a rhythm cannot drift apart into four numbers that used to agree.

#### The line lands

When the trend reaches today, one ring in Lingon expands out of the endpoint and
fades over half a second. Then 300 ms of nothing, and only then the first word.

**This is motion that carries meaning**, and the meaning is the page's oldest
one: a reading arriving. The hero says it thirty times while the line is drawn;
the ring says it once more for the reading the line ends on, which is the one
the reader would have taken this morning. It does not spend the tilt's
decoration budget because it stops: one run, ending at opacity 0, and nothing
pulses at rest. Recorded under D177, which is where the hero's sequence lives.

The beat of silence is the other half. Without it the ring reads as a lead-in to
the words; with it, the picture has finished saying its part and the words are
the next sentence.

**It was visible from the first paint** at nine tenths opacity, for two and a
half seconds before the line reached the endpoint, because
`animation-fill-mode: both` applies the first keyframe *during the delay* and the
element's own `opacity: 0` cannot win against it. Every screenshot taken after
three seconds looked right. The measurement caught it at 145 ms.

#### "Trendvikt, inte dagsvikt" is two figures, not fourteen

D179 replaced a second graph with the fourteen readings stated as figures, seven
across and two down. That is a **table**: a reader counts it rather than taking
the point, and the point is that any one morning is noise.

So the section takes exactly the shape of the maintenance section below it,
which makes the same kind of comparison: one figure against another, in two
cards. The left cycles through the fourteen readings at 900 ms each with a short
crossfade; the right holds the trend and counts up to it once.

**The left card loops, and §5 says everything that moves stops.** It needs its
own reasoning rather than the drifting field's, because it is the subject rather
than the background: what it says has no end state. A trend settles and a line
finishes drawing; a daily weight does not, and a card that showed one reading
and stopped would make the opposite point to the one beside it. What keeps it
honest is that it runs **only while it is on screen** — measured, no change
across 2,7 s scrolled away — so a reader who has passed it pays nothing, and
neither does a hidden tab.

Under reduced motion it keeps the one reading React rendered, which is the
finished state of a thing whose whole content is that it changes.

**The count-up formatted every figure as whole.** It had only ever been pointed
at kilocalories, so 84,5 counted up and landed on "84": a weight written the way
this app never writes one, on the figure whose entire job is to be the trend. It
reads the decimals off the target now.

#### The frames turn enough to see

Twelve degrees at a perspective of 1400 px is a turn you can measure and cannot
see: at the size these are drawn the frame looked slightly crooked rather than
turned, which is the worst of both, a decoration that costs the same and says
less. Twenty-two at 900 px reads at a glance.

The extra angle needs a **flat band**. A single midpoint means the frame is
square on for one scroll position and leaning everywhere else, so the picture a
reader stops on is almost never the flat one. It holds flat from 40 % to 60 % of
its travel, about a quarter of a viewport's worth of scroll. §5 names the angle,
so §5 changed with it.

#### Din data, and Om AI last

"Dina data" reads as a list of things; "Din data" is the subject the section is
about.

Om AI moves below Din data, above the footer. It answers a question a reader
only has once they know what the app does, and it is the one section whose
subject is a component rather than something the reader gets: a page that
explains its language model before it has shown its screens is a page about the
model.

**The copy guard checks the order now, and its first version was wrong in an
instructive way.** It scanned the file for `<SectionHeading>` and got the order
the components are *defined* in, which is not the order they are rendered, so it
failed against a page that was already correct. A check that reads the wrong
thing fails and passes for the same bad reason; it reads the list out of
`<main>` and looks each component's heading up now.
