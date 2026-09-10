# STATE.md

Updated at the end of every session. Keep it short and current, this is not a
changelog.

Per CLAUDE.md §7, the current-state section describes only what was **exercised
through the interface**. Work that exists as API only is listed under **API
without a screen** until a screen calls it.

---

## What this is

A self-hosted weight and habit tracker. One person's instance, invite-only, with
a public landing page that can be turned off. The reasoning behind every
non-obvious choice is in `DECISIONS.md`, which is the document to read before
changing anything architectural.

## Current state

**The app is something a stranger could be handed.** It says what it stores and
why, asks before storing it, lets somebody leave with everything, tells people
when it will be down, and its mail goes out.

- **Phases 0 to 6 are built and used daily**: invite-only auth, the weight log
  and trend line, adaptive TDEE and projections, the food database with barcode
  scanning and meal templates, measurements and the daily log, milestones and
  the savings pot, and the PWA with its offline queue.
- **Logging works offline** and syncs on reconnect. A local store that opens and
  will not accept a row falls through to sending directly, and says so (D118).
- **Mail is delivered** by a drainer inside the API process, and every link in
  every message is absolute and checked to be reachable (D104, D109, D113).
- **`/integritet` and `/villkor`** are real pages, and the contact address on
  them is a deployment setting rather than a constant in the source (D106,
  D121).
- **Consent is explicit and dated**, and an account can be deleted by the person
  who owns it (D107).
- **Administration** is eight tabs covering every admin endpoint, reachable only
  by an admin, with every action written to an audit log (D95, D100).
- **The theme is a choice** of system, dark or light, stored per account (D117),
  and the app offers to install itself where the platform allows (D116).

### API without a screen

Empty.

### What is not done

- **Photos** (§6 phase 7) and the self-service deletion hook that waits on them.
- **The local LLM layer** (§6 phase 8) and the coach (8b).
- **Group features** (§6 phase 9) and **device integrations** (§6 phase 10).
- **SMB and S3 backup destinations**, named in the settings and refused with a
  reason.
- **Habits and reminders, MFA, and importing from other apps** — phases 11 to 13,
  written down in CLAUDE.md §6 and not started.

## Inför nästa deploy

**Every pass on `dev` appends to this list, and nothing merges to `main` until it has
been read.** `main` is what production deploys from, so this is the handover: the four
things that do not travel in a git diff and cannot be inferred from one.

Cleared back to empty when a merge ships, not before.

### Nya miljövariabler

| Variabel | Vad den gör | Krävs? |
|---|---|---|
| `CONTACT_EMAIL` | Adressen `/integritet` namnger som personuppgiftsansvarig. Bygget lämnar `__CONTACT_EMAIL__` i `index.html` och `32-site-config.sh` fyller i den vid start (D121). | **Ja** när `LANDING_ENABLED=true`. API:t vägrar starta utan den i produktion. |
| `OPERATOR` | Vem som driver installationen, i sidfoten och på `/integritet`. | Nej, men sidan blir vagare utan. |
| `REPO_URL` | Vart GitHub-länken pekar. | Nej, har ett förval. |
| `SUPPORT_URL` | Länken "Bjud på en öl". Tom betyder att länken utgår helt. | Nej. |

**Sätt dem innan avbilden som läser dem rullar ut.** En variabel den nuvarande
avbilden inte känner till ignoreras, så det finns inget fönster där något går sönder
av att de sätts för tidigt. Omvänd ordning ger en publik sida som visar
`__CONTACT_EMAIL__`.

### Migrationer som kommer att köras

Inga. Senaste tillämpade är `0020_profile_theme`, och produktionen har alla 21.

### Manuella steg på Portainer-värden

- Sätt de fyra variablerna ovan i stacken `vikt` innan avbilden byts.
- Ta bort den kvarglömda förfrågan `human-check-probe@example.test` under
  Administration, Förfrågningar, Besvarade. Den blev kvar från verifieringen av
  människokontrollen och kan inte tas bort härifrån.

### Till Nyheter

En rad per synlig förändring, i appens register, färdig att klistra in:

- Viktgrafens skala visar jämna steg igen, och alla vägningar får plats i bilden. Den
  senaste vägningen kunde tidigare hamna utanför och ritades då inte alls.
- Grafens ruta visar samma antal decimaler som siffran ovanför.
- Saknas ett makrovärde står det numera varför: ingenting loggat, eller för få dagar
  med uppgifter om just det makrot. Fibervärden saknas oftare än de andra i öppna
  matdatabaser.
- Att välja en träff i matsökningen stänger träfflistan.
- Åtgärder som kostar något, som att radera ett konto eller ändra mejlservern, har fått
  en egen färg. Att radera ett konto kräver att adressen skrivs in.
- När du tittar på en tidigare dag i Mat kan du logga en rad, eller hela dagen, på
  dagens datum. "Igen" under Senast loggat fyller fortfarande i dagen du tittar på.

## On `dev`, not yet on `main`

Production deploys from `main` (CLAUDE.md §7), so this list is the difference
between what is built and what is running. Five commits:

| | |
|---|---|
| `36d6f9a` | Work happens on dev; main receives merges only |
| `25a173f` | The weight axis is a ruler again, and holds every reading (D122) |
| `e864f6a` | Say why a macro mean is withheld, and dismiss the search on a pick (D122) |
| `b83a1d9` | The reminder design into Phase 11, bounce handling into the backlog |
| `0f823e0` | One primary, one secondary, and Honung for what costs something (D123) |

CI green on `dev`:
[34508734187](https://github.com/lundstream/vikt/actions/runs/34508734187).

**Merging is a deploy.** `main` takes these through a pull request when the owner
decides to update production, not when the suite goes green.

### Before the next redeploy

Unchanged from INFRA.md and still outstanding: `CONTACT_EMAIL`, `OPERATOR`,
`REPO_URL` and `SUPPORT_URL` have to exist on the Portainer stack **before** the
image that reads them ships (D121). The API refuses to boot in production with a
landing page and no contact address, which is deliberate — a public privacy page
naming nobody is not lawful to run.

**`tailwind.config.js` changed** in `0f823e0`, adding the `on-reward` colour.
Tailwind resolves its config at boot, so the development server needs a restart
before that class exists; a green build proves nothing about a running dev
server.

## Still open from the 10 September brief

Started and finished: the branching rule, both chart defects, the macro reason
line, dismissing the food search on a pick, the button audit with the Honung
tier and its guard, the Phase 11 reminder design, the bounce-handling backlog
entry, and the "med ett tryck" copy fix.

**Not started**, and each is a pass of its own rather than a loose end:

- **Copy a past day forward** (1d): a per-row "Logga i dag" and a whole-day
  version, writing with today's `local_date` and `dateSource: "device"` per D61,
  with Senast loggat keeping its backfill behaviour and the two labels made
  obviously different.
- **Expandable food rows** (2): macros, amount, source and estimate marker
  inside the row, with edit, delete and the copy-forward action, one open at a
  time.
- **Framsteg** (3): the two forms into modals, existing milestones and savings
  rules behind counted disclosures, the page leading with how it is going.
- **`/kod` behind `REQUEST_ENABLED`** (6b), with the hero line replaced and
  `/integritet` updated.
- **Markdown in announcements** (6c), rendered sanitised in three places with a
  preview in the editor.
- **Mail to the admin on an access request** (6d), with an unread marker and a
  per-admin opt-out.
- **SMB backup** (6e), over the protocol from Node rather than a mount.

**Blocked, not skipped:** removing the probe request
`human-check-probe@example.test` (6g) needs the production database, and the
Portainer password was rotated after the deployment pass. It is under
Administration, Förfrågningar, Besvarade, "Ta bort".

## Verified

**1229 tests**: 464 shared, 195 web, 570 api. Lint clean, all three packages
typecheck, both bundles build, and the placeholder guard passes.

Measurements, and the conditions they were taken under, are in
`docs/measurements.md`. The landing page's tap figures are pinned to that file
by a test, so a fast path that changes without the page changing fails the
suite.

## Known gotchas carried into this project

The long list lives at the bottom of `DECISIONS.md` where each one has its
reasoning. The three that catch people most often:

- **`useTestApp` registers Vitest hooks, so it must run at file level.** Calling
  it inside a test registers hooks that never run.
- **Secure-context APIs do not exist over http on a LAN IP.** Three times now:
  `crypto.randomUUID`, the camera, and `BarcodeDetector`. See
  `docs/secure-context.md`.
- **Measuring page-load performance on the dev server measures the dev server.**
