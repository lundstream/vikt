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

**Phase 14, Måltider, 2026-09-26: exercised through the interface on the
development server**, item by item, each with its own verdict file. Released as
`1.3.0` on 2026-09-26 (below, "Production runs 1.3.0").

- **Måltider, the entity** (D186). The one saved meal in the development
  database ("Frukost", logged 36 times as a template) came through `0032` as a
  meal of one portion with its row, showed in Mat and logged in one tap with
  its name on the row. 5 of 5.
- **The section** (D187), reached from Mer and from the top of Mat: a meal of
  two portions made in the sheet from two searched foods, shown with its
  running figure per portion, saved, reopened, set to three portions, the
  figure following. "Vad kan jag laga?" is here and gone from Mat. Shot at
  360 px and desktop. 18 of 18.
- **Logging from Mat** (D189): a meal of four portions made, 1,5 portions
  logged from the row at the top of Mat (225 g and 112,5 g, three eighths of
  each row), the day reading "Kycklinggryta · 1,5 portioner" with its rows
  beneath and its total counted, one logged row edited from 225 to 200 g and
  still in its meal, the meal itself unchanged and its logging counted once.
  Shot at 360 px and desktop. 17 of 17.
- **The label photo** (D190), with the real vision model: the quark cup, a
  phone JPEG tagged as turned, read exactly as printed through "Skriv in
  själv"; every figure confirmed; saved as the person's own food with "från
  etikett" and no estimate marker, opening the portion sheet. The sideways foil
  bag misread (fat 94 for 9,4) and refused in words with the save disabled. The
  rotated fixture came back upright in Chrome, 32 by 64, with no EXIF. 23 of 23.
  The barcode attachment and the next scan finding the food are held by the API
  suite; a headless browser has no camera to scan with.
- **Meal photos** (D191): a 3 MB phone photo with EXIF added in the sheet,
  shown in the sheet and the list at 960 by 1 280, stored under the user's
  folder with no EXIF, carried by the zip export beside the JSON and the CSVs,
  refused without a session. 15 of 15. The app's backup and the restore check
  need `pg_dump`, which this workstation lacks: the archive is held by the API
  suite here and by the CI-only live S3 run, green on `e9ec03c`.
- **Sharing** (D192), across two accounts: a display name set in Profil, a
  meal shared after the confirmation and marked "delad", seen by the other
  account under Delade måltider with its photo and "från Testkocken" and no
  e-mail, logged at one portion (which copied it, photo included, and wrote the
  day from the copy), reported; Administration, Anmälningar, listed it and
  stopped sharing it; the reader's copy stayed. 32 of 32.
- **Sharing, the deletion path** (D192), 2026-09-26, with two throwaway
  accounts made for it from administrator invites: the author shared a meal
  with a photo, the reader saved a copy, logged it once and reported the
  original, and the author deleted their account from Inställningar with the
  password and the address typed out. The share left the reader's "Delade
  måltider"; the copy stayed with its photo and "från Raderakocken"; the
  reader's day was unchanged row for row; the report went with the meal. The
  reader was then deleted the same way and neither could sign in. 30 of 30,
  run twice, the second time after the fix below. Nothing else was deleted.
  It found "1 foton" and "1 matrader" on the deletion sheet: every sentence
  that opens with its count now goes through `plural()`, held by
  `i18n.test.ts`.
- **Small items**: the tagline's words 500 ms apart, measured (`docs/
  measurements.md`, seventh pass); the raw phone screenshots taken again with
  the current date format, 3 of 3; §7 names error class ten and the release
  rule.
- **After 1.3.0, the recipe photo** (D195), 2026-09-26, on the development
  server with the real vision model. The probe first: five prompts, three runs
  per photograph; the cookbook page read with every row and both amount sets
  as printed, 3 of 3, once the model was asked for lines alone. Then through
  the meal sheet: the cookbook page (seven rows beside their printed lines,
  the choice between sets asked once, "kontrollera mot sidan" on the mozzarella
  row only, the range and the cross-reference left, "Receptet: 1 PIZZA" with
  "inte än" beside an empty portion field) saved as a meal of one portion; the
  screen photo (sixteen rows, no question, printed weights winning, "4
  portioner" filling the count) saved as a meal of four. 22 of 22. Rows that
  could not be added now stay in the list: 7 of 7. The list at both widths
  after moving the chip to its own line: 10 of 11, the eleventh my own check
  being stricter than the list's truncation of long names. Shot at 360 px and
  desktop.
- **The release block** (D194) is held by `release.test.ts`, each new case seen
  failing before it passed; it has no screen.
- **The matcher, in the flow a person uses** (D196), 2026-09-26: both recipe
  photos again through the meal sheet with the real model. The cookbook page:
  "Vitlök" and "Olivolja" matched as themselves, basil leaves now no match (a
  compound), "kontrollera mot sidan" still on the mozzarella row only; saved as
  "Pecorinopizza". The screen photo: "mjölk" is "Mjölk fett 3% berikad",
  "smör" "Smör fett 80%", "gula lökar" "Lök gul", "tomatpuré" "Tomatpuré konc.
  konserv.", and "peppar" and "nötfärs" no match where they were horseradish and
  lasagne; "4 portioner" filled the count; saved as "Lasagne med ostsås" of four
  portions. 19 of 19, no sideways scroll at either width. Both lists shot row by
  row at 360 px and desktop, every row whole in a shot: 5 of 5.
- **The matcher refined, and the 1.4.0 gate** (D198), 2026-09-26: both recipe
  photos through the meal sheet again with the real model. The cookbook page:
  basil leaves "Basilika färsk", "Vitlök" and "Olivolja" as themselves; saved as
  "Pizza med pecorino". The screen photo: "nötfärs" "Nöt färs rå fett 10%" at
  500 g, "köttbuljongtärning" and "peppar" no match, milk, butter, tomato purée,
  salt and "Lök gul" as before; the model read the garlic line as "2
  vitlökskyftar", which matches nothing; saved as "Lasagne med ostsås 1.4". 15
  of 15, both lists whole in their shots at 360 px and desktop. The matcher's
  gate lines, 14 of 14, are in the session report.
- **No private address in a tracked file** (D197) has no screen: the helper's
  refusal and release step 1 are held by tests, and the address test failed on
  `scripts/portainer.mjs:35` before it passed.
- **The sentence tool, after 1.4.0** (D199), 2026-09-26: "ett glas mjölk"
  typed into "En mening" on Mat with the real model is read and proposes
  "Mjölk fett 3% berikad", 1 glas, 250 g, 149 kcal; the same sentence and the
  entrecote sentence the owner's phone was refused on are read through the dev
  API. Shot at 360 px and desktop.
- **Välj bild** (D200), 2026-09-26, with the real models, at 360 px and
  desktop: the plate photo given a picked JPEG and read into rows; the label
  photo given a picked JPEG and transcribed; the recipe photo given a PNG
  screenshot of a recipe page, five rows, "4 portioner" filling the count, the
  amounts the catalogue cannot convert typed in, saved as "Pannkakor från
  skärmbild" of four portions; a text file named `.png` answered with "Bilden
  gick inte att läsa. Ta en ny." in the sheet; the meal's own photo input
  without `capture`. 30 of 30.
- **The meal photo's line** (D201): "Bara du ser det, om du inte delar
  måltiden." in the sheet at 360 px and desktop, 4 of 4.
- **The closing sweep, 2026-09-26, after the 1.4.1 release**: `pnpm
  harness:sweep` over every finished screen at 360 px and desktop, **45 of 45**
  with the sign-in; both landing rows `landing-ok=sentence15/meta13/gap64`,
  6 796 px at 360 and 5 206 at desktop, unchanged. CI green on `dev` at
  `6d5d409`.

- **Phases 0 to 6 are built and used daily**: invite-only auth, the weight log
  and trend line, adaptive TDEE and projections, the food database with barcode
  scanning and meal templates, measurements and the daily log, milestones and
  the savings pot, and the PWA with its offline queue.
- **The trend line is a curve between readings** (D144). §4.1 still returns one
  point per day and still carries the trend forward on a day with no reading; the
  chart now takes a vertex per reading and draws a monotone curve between them,
  which is what it always looked like on a daily series and never on a weekly one.
- **Every reading is editable, through a month calendar** (D145). "alla vägningar"
  under the readings list opens a month with the logged days marked; tapping one
  opens the sheet on that day with its value and a delete, and tapping an empty day
  adds a reading filed under it.
- **A photograph of a meal** (D143): the model names the foods, the database prices
  them, a person confirms every row, and the picture is read and dropped. Amounts
  mostly arrive empty and are typed; a weight printed on a package is refused as an
  amount outright.
- **The app says which build it is** (D151). The version and short commit sit at
  the foot of Inställningar with links to the source, Nyheter, /integritet,
  /villkor and the licence, under the Administration heading, and as the first
  line of the boot log. They are build arguments baked into the image, not
  settings, so a deployment cannot claim to be a version it is not.
- **Editing a reading is an update, not a second reading** (D150). The calendar's
  edit sheet sends the row's id and the value it opened with, so the server can
  tell an edit arriving late from two devices disagreeing about a day. A real
  conflict now offers two equal answers, keep the saved one or use the waiting
  one, in the conflict list and on the queued row alike.
- **One scrim behind every sheet** (D152). Natt at high opacity with a 10 px
  blur in both themes, lighter in the light one, from a single token; somebody
  who has asked for less transparency gets opacity alone. The Is-coloured line
  around the milestone sheet was a focus ring on the dialog container: focus goes
  to the first field now and the sheet's own border is gone, because a sheet is
  Skymning on a dimmed page and needs no edge.
- **A `<select>` looks like every other control again** (D162). Four duplicate
  `.select` blocks sat after the intended one and, being last, were the rule
  actually in force: the wrong radius, the page colour instead of the card
  colour, the wrong padding and size, and the dark theme's chevron drawn on the
  light theme. `stylelint` fails the build on a duplicate selector now.
- **A table of days, and the whole account as a real spreadsheet** (D167).
  Data, Dagar: one row per day with seventeen columns from weight and trend to
  maintenance as of that day with its source and intake minus it, sortable, in
  its own sideways-scrolling region. Inställningar, Ta med din data: Excel (the
  day table first, a sheet per table, Swedish headers, numbers as numbers, dates
  as dates, "minst" as a number format), the JSON file, and CSV per table, which
  no screen had offered before. Exercised on the development account at 360 px
  and desktop: 90 rows, no page overflow, and the downloaded workbook matching
  the table in 2 014 of 2 014 cells.
- **Three defects a screenshot showed** (D176). A trend delta rendered
  "↓ 4,98 kg" where §4.1 says one decimal, and reads "↓ 4,7 kg på 90 dagar"
  now; the estimate chip is "≈ uppskattning" in the profile's own word and
  case; and the violet "Ätit i dag" figure in the demo screenshot is **#8878D0,
  which exists nowhere in this tree** and is profile v1.0's Blåbär from a stale
  install. The token is and always was `#5FA8E6`. What was wrong here was
  CLAUDE.md, which documented the violet, and a guard now holds the documented
  value to the one the stylesheet carries.
- **Secondary text is readable** (D175). Sten was below AA on every dark
  surface it is used on, worst on Dis at 3,22:1, while the profile promised
  4,5:1. It is `#85949A` in the dark theme and `#55636A` in the light one now,
  and a guard computes every body-text token against every surface in both
  themes from the tokens themselves, because the audit that reported "zero
  failures" walked screens and a token is not a pair.
- **A release is one command, and it has never been run to the end** (D182).
  `node scripts/release.mjs <version>` runs the eleven steps INFRA.md writes
  out, prints what each found, and stops at the first bad answer with nothing
  after it attempted. 32 tests hold it, including every step failed in turn and
  the plan step run against a live Portainer double. **Run for 1.2.0 it stops at
  step 1**: `VIKT_HOST` is not set and this workstation has never had SSH to the
  host. Production is on `1.1.1`.
- **The landing page is centred, still, and the ring is whole** (D181). The
  hero's viewBox is padded by the ring's reach, so the ring at the endpoint
  renders as a ring rather than an arc opening leftwards, which it had been
  every time. The trend card holds 84,5 from the first frame and the daily card
  swaps outright at 900 ms; the daily figure is Sten and the trend is Snö, the
  maintenance section's own pairing. Every heading and paragraph is centred with
  the reading measure kept, the cards left aligned inside. Measured again:
  **performance 98, accessibility 100, zero layout shift**, 12,8 kB of 15 and
  58,8 of 60.
- **The landing page reads at a talking pace** (D180). The line draws, lands in
  one Lingon ring at the endpoint, holds still for a beat, and then "Gör",
  "det", "lättare." arrive 700 ms apart. "Trendvikt, inte dagsvikt" is two
  cards in the maintenance section's own shape: a daily weight cycling through
  the fixture's fourteen readings beside the one trend they make, and the
  cycling stops while the card is off screen. The phone frames turn 22 degrees
  rather than 12 and hold flat through a band at the centre, so the turn reads
  at a glance. Om AI moved below Din data, at the bottom. Measured again:
  **performance 98, accessibility 100, zero layout shift**, 12,8 kB of 15 and
  58,8 of 60.
- **The landing page says it once, in a picture and then in words** (D179).
  The hero draws the trend through thirty readings and then the claim arrives a
  word at a time, "Gör", "det", "lättare.", 120 ms apart. "En dagsvikt är mest
  brus" no longer draws a second graph of the same argument: it states the
  fourteen mornings as figures, seven across and two down, with the one figure
  the app makes of them beside it, and **nothing in the section responds to
  scroll**. The three phone pictures keep their transparency now, which they had
  been losing to a headless capture for three passes, and the rows carry the
  profile's own two type sizes. Measured again: **Lighthouse performance 98,
  accessibility 100, zero layout shift**, 12,8 kB of a 15 kB budget and 58,7 of
  60. One run in three scored accessibility 93 on a contrast failure that was
  axe sampling the primary button mid-fade; the pair it circles has 0,08 of
  headroom and is held by a test now.
- **The landing page's lines are the app's own arithmetic** (D173, D177).
  Thirty readings arrive, a trend line draws through them, and only then does
  the page say "gör det lättare" in words; seven sections after it, one
  scroll-driven, where the reader draws a trend through a fortnight of daily
  weights with the wheel. **Both lines are computed by `packages/shared`'s EMA**
  over dated fixtures at build time, and a test recomputes every vertex, because
  the hero used to be a cubic somebody sketched to look like a trend. Scroll
  progress is the maximum seen so far, so scrolling back up leaves the line
  drawn: nothing on the page animates in reverse. Measured again on the
  production build at mobile settings: **Lighthouse performance 98, accessibility
  100, zero layout shift**, the page's own code 12,4 kB gzipped of a 15 kB
  budget and 58,3 kB of 60 in total. Shot at 360 px and desktop, with a
  reduced-motion pass that renders the finished page at once and a mid-scroll
  shot with the line a third drawn and five of fourteen readings arrived.
- **The landing page's three phone pictures are made by hand, and nothing in CI
  notices when they go stale** (D177). `docs/screens/{oversikt,mat,framsteg}-portrait.png`
  are composed, framed shots of the demo account taken by the owner;
  `scripts/landing-screens.mjs` only resizes them into `public/screens/`. The
  sweep that used to generate them is deleted, because a raw capture is not a
  framed picture. **So they must be taken again whenever Översikt, Mat or
  Framsteg changes in a way a stranger would see**, and that is step 2b of the
  release runbook as well as this line.

  **README's three screenshots came from that same deleted sweep** and are now
  hand-maintained too: `docs/screens/{oversikt,mat,framsteg}.png`, which nothing
  regenerates. They are current as of the sweep that last ran, and the same rule
  applies to them. Pointing README at the framed portraits instead would leave
  one set rather than two, and is worth doing next time README is touched.
- **The backup leaves the container, and the app reads one back** (D168).
  `/backups` is a required bind mount from a host directory (`BACKUP_HOST_DIR`)
  instead of a named volume the API's uid 1000 could not write, which is where
  production's `EACCES` came from. A restore check decrypts the newest dump with
  `SECRET_KEY`, restores it into a scratch database, compares it with the live
  one, drops it again and records the result; it runs monthly after a scheduled
  backup and from `docker exec vikt-api-1 node dist/restore-check.js`.
  Administration, Backup shows **Senaste återställningstest** in Sten, "Inte än"
  before the first, and calls a test older than 35 days old in words, not colour.
  Exercised by running this tree's API image against the development database
  with the directory bound in: the schedule wrote
  `vikt-20260915T232635Z.dump.enc` (336 112 bytes) and the check that followed it
  read it back, **ok, 46 tables, 3 912 rows, 32 migrations**, with the same
  result from the command and no scratch database left behind. Shot at 360 px
  (no page overflow) and desktop.
- **A release builds once, and the log says which build it is** (D169).
  `release.yml` triggers on a tag, a published release and a manual run, not on
  a push to `main`, which started a second run of the same commit that failed
  every time by asking the registry for a tag named `dev`. The anonymous-pull
  proof now asks about `sha-<commit>`, which every run publishes, and `latest`
  follows releases. The API logs `api build` with the version and commit as its
  first line, and `stack.mjs` prints it, so INFRA.md step 6 can answer whether
  the pull replaced anything. The migrator's `already exists, skipping` notice
  is off at the client that emits it, so a boot log starts with the migration
  names instead of two lines that read like a fault.
- **A week where the eating changed is a ring on Samband** (D170). The weekly
  pane keeps its approximate line and now says which weeks the line is not
  really about: a week whose mean intake moved by at least 400 kcal from the
  previous week's point is drawn hollow, the way an imported reading is in the
  weight graph, with a note that appears only when there is a ring to explain.
  The threshold is measured rather than chosen, on the same synthetic body the
  fixture uses: 400 kcal is where the week of a change first lands more than
  0,1 kg from the line. Exercised on `samband@example.test` at 360 px and
  desktop: twelve weeks, eleven filled points and one ring, no page overflow.
- **The app writes what a number means, and the coach conveys it** (D171). Every
  domain block of the coach's sheet ends with a `Vad det betyder:` line from a
  closed, reviewed set, chosen by the state that domain is in; COACH_RULES says
  to carry it and add none. The rule used to ask the model to write that
  sentence and it did so in one live reply of six. Rerun against the same model
  with the same question, **the interpretation is in all six**. Saying one thing
  affects another is a words-level check now, exempt only for a sentence
  carrying the sheet's own general marker, and it refused exactly one live
  sentence, of the shape the prompt has forbidden since D155.
- **An incomplete sum says "minst", at every span** (D55, addendum 2026-09-15).
  Below the coverage gate a macro is the known sum after "minst", in Sten, with
  the share of the food carrying it on the line under it: on Översikt's day card
  in both views, on Mat's new macro line under the day's kcal, and in the coach's
  sheet over 7 and 28 days. A week is the mean of its logged days' known grams,
  so a partial day counts instead of hiding the week. Nothing is shown only when
  no logged food carries the value. Exercised on the development account with a
  partial day (two food rows added on 2026-09-15, "Kvarg med bär" and "Middag
  hos vänner"), shot at 360 px and desktop.
- **The coach has two rules about what it may mean** (D155, addendum
  2026-09-16): invite looking at whether something shows, never at how one thing
  affects another, and say in one sentence what each area means for the goal,
  marked as general when it is general. Run live in all three tones on the
  development account and the alcohol fixture, replies recorded verbatim. **The
  "se hur det påverkar" sentence did not return. The macro sentence the rule asks
  for appeared in one reply of six**, and two replies on the fixture made an
  unmarked general claim that alcohol "kan påverka" something. Recorded, not
  tuned; still no words-level causal check.
- **Samband puts intake against trend change one week at a time** (D166). One
  point per whole Monday-to-Sunday week with six logged days, the trend change
  shifted by its lag and stated per week, nothing until four whole weeks ("Inte
  än" and the count), and a dashed line in Sten for what 7 700 kcal per kilo says
  the week should do, only when maintenance is measured. The line is arithmetic,
  not a fit, and D34 was reopened for exactly that. Exercised at 360 px and
  desktop on `samband@example.test` (a seeded body that obeys the arithmetic:
  12 weeks, the line drawn, settled weeks on it) and on the development account,
  which has 11 whole weeks and therefore **draws points, not "inte än"**, with
  no line because its maintenance is not measured.
- **Food search says where it is, and forgives a typo inside a long name**
  (D165). Mat shows the saved rows at once, says "Söker vidare i
  livsmedelsdatabasen" in Sten while the database is asked, appends what it
  finds, keeps the saved rows on a timeout, and says "Inget hittat" only after
  every source answered. Matching folds å, ä and ö and uses word similarity, so
  "Yogghurt" finds the yoghurts and word order does not change the first row.
  Migration 0030. Exercised on the development account at 360 px and desktop;
  the local "Söker" state was faster than the sampling and was not seen.
- **The coach sees the data, not a summary of it** (D155). Intake against
  measured maintenance, each macro against the person's own target, alcohol,
  movement, steps, sleep, energy, mood, habits and measurements, all over 7 and
  28 days, plus the names of what was eaten in the last week. It may praise what
  the data shows, offer at most two suggestions phrased as options, and never
  join two series with a cause, because Samband computes no coefficient to lean
  on. A domain with nothing in it says so with the data as the subject.
- **A swipe moves between sections on a phone** (D154). The page follows the
  finger and completes past a quarter of the screen or on a flick, and a tap in
  the bar runs the same slide. It stays out of five cases: the 24 px the
  operating system's own back gesture owns, the weight graph, a range input,
  anything that scrolls sideways, and any touch where horizontal movement does
  not clearly beat vertical. Reduced motion removes the movement and keeps the
  navigation.
- **A queued edit whose reading was deleted does not die** (D153). The server
  answers 404 only when the row is gone and the day is empty, so nothing on the
  server disagrees with the waiting reading: the queue item becomes a question
  with two answers, put it back or throw it away, instead of a refusal offering
  a retry that could never succeed.
- **Nothing user-created is create-only** (D146). A measurement can be taken
  back, and an activity can be amended in the form it was typed into, which were
  the last two entities on the wrong side of §3's rule.
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
- **Two reminders arrive as push notifications**, each with a weekday time and a
  weekend one, in the account's own timezone, skipped when the thing has already
  been done and never sent twice for a day (D136). Absent entirely without VAPID
  keys.
- **A coach page under Mer** (D139): the weekly review and a chat that answers
  from the account's own aggregates, streamed, with every figure in the reply
  checked against the numbers the app actually holds before it reaches the
  screen. Absent entirely when the LLM layer is off.
- **Three tones for it** (D140), chosen on the same page and applied to the chat
  and the review alike: torr, peppig and saklig. Every tone gets the same rules
  block verbatim and the same ten-line fact sheet about what the app does.
- **The review writes itself on Sunday evening** (D141), at 20:00 in the
  account's own timezone, and only for a week carrying at least four logged
  days.
- **A habit checklist on Dagen** (D137): the user's own words, an optional icon from
  a closed set, an order, one tap to tick and one to untick, a streak per habit, and
  an optional reminder per habit in the same two-time shape. Removing a habit keeps
  its history unless the history is removed on purpose.

### API without a screen

Empty.

### The edit-window audit (D145)

§3 says every user-created row ships with edit and delete. The gap this pass
closed was not a missing endpoint but a **window**: the weight log had both in
the API since phase 1 and five rows of reach on screen. Run against every
screen, because that is where this failure lives.

| Entity | Reach | Verdict |
|---|---|---|
| Weight readings | the last five, now the whole history through the calendar | **was narrow, fixed this pass** |
| Daily log, measurements, habits, activities | the shared date selector (D62) reaches any past day | whole history |
| Food entries | the same selector; the day's list is complete, each row edits and deletes | whole history |
| Manual intake | the quick sheet, which opened on today only and now opens on any day | was narrow, fixed as a side effect |
| Milestones, savings rules, savings events, coach conversations | listed in full, not date-scoped | whole history |

"Senast loggat" on Mat is capped at six and is **not** an edit surface: its rows
log the food again rather than open it. The day's own list underneath is
complete.

**Nothing is left open under §3's rule.** The audit's two remaining gaps —
`measurement_log` with no delete at all, and `activity_log` with delete and no
update path — were closed the pass after it found them (D146). `measurement_log`
got `DELETE /measurement/:id` and a control under its own form;
`activity_log`'s edit needed no endpoint, because every write here has been an
upsert on `(user_id, client_uuid)` since phase 1 and the row's own id sent back
*is* the update. `food_items` created by hand is the one entity with neither,
deliberately and for the reasons D56 states.

One smaller thing seen while auditing and left alone: the quick sheet's calorie
hint still says "Matloggning kommer senare", which stopped being true in
phase 3.

### What is not done

- **Photos** (§6 phase 7), the oldest unbuilt item, and the self-service deletion
  hook that waits on them.
- **Group features** (§6 phase 9) and **device integrations** (§6 phase 10).
- **MFA and importing from other apps** — phases 12 and 13, written down in
  CLAUDE.md §6 and not started.
- **The rest of phase 8**: the recipe generator and the free-text parser are
  built, and so is the coach (8b). What is left in that phase is the milestone
  messages the persona was also meant to deliver.

## Production runs 1.4.1

**Deployed 2026-09-26 from `da88d0d`, tagged `v1.4.1`**, by `node scripts/release.mjs
1.4.1`. All thirteen steps ran. What the owner found on a phone the evening
1.4.0 went out: the sentence tool read again (D199), "Välj bild" in every photo
tool (D200), and the meal photo's privacy line (D201).

**Before the command**, each read rather than assumed:

- **CI green for `da88d0d`**, the exact commit, before the command started.
- **Every model production uses answers** on the workstation's Ollama, each
  asked a question under a JSON schema and each answering `{"svar": "ja"}`:
  gemma4:e4b, the sentence tool (156 ms); qwen3.6:27b, the coach (27,6 s, with
  loading); qwen3-vl:8b, the photos (11,4 s, with loading). The first two are
  the defaults, not set in the stack; the third is `LLM_VISION_MODEL`, read
  from the stack by name. The production host reaches Ollama (200).
- **The host scripts** equal to `da88d0d`; `VIKT_HOST`, `PORTAINER_TOKEN` and
  `PORTAINER_URL` present.
- **The dry run, green**, exit 0, ending "every check passed and nothing was
  changed. 1.4.1 is not live."

| step | evidence |
|---|---|
| 1 workstation | `VIKT_HOST`, `PORTAINER_TOKEN`, `PORTAINER_URL` set, gh authenticated |
| 2 tree | clean, on `dev`, pushed, at `da88d0d` |
| 3 CI | success for `da88d0d` |
| 4 backup | `/var/backups/vikt/vikt-20260926T185624Z.dump`, 328K; beside it `media-20260926T185624Z.tar.gz`, 121 KB, now holding the first meal photo production has |
| 5 restore | `daily_log 73, food_entries 313, plans 2, users 4, weight_log 108`, restored copy and live database agree |
| 6 main | fast-forwarded 6 commits to `da88d0d` |
| 7 tag | `v1.4.1` on `da88d0d` |
| 8 workflow | run `36264308998` (release, `v1.4.1`) green |
| 9 plan | nothing blocks this deploy; `IMAGE_TAG 1.4.0 -> 1.4.1`, no variable set |
| 10 deploy | both containers on the new image, the API healthy; `the vision model can see` in 1 710 ms |
| 11 API log | `version 1.4.1, commit da88d0d`; **`Migrations: none to apply, 36 already recorded`**; VAPID silent, so the key is unchanged |
| 12 outside | `https://vikt.lundstream.net/api/health` 200, `/` 200; and `/app/` 200, read after |
| 13 Nyheter | **`published "Vikt 1.4.1" as 354abaf8-0df7-4441-9c73-ccdffaf3385f, 839 characters, not mailed`** |

**Lighthouse was not run**: no landing page file changed between 1.4.0 and
1.4.1 (§7).

**Not yet confirmed through the interface in production**, because this
session does not sign in there. For Fredrik, on the phone:

- **Reload first**: the "En ny version finns" banner, so the phone runs 1.4.1
  and not a cached 1.3.0 or 1.4.0.
- Mat, "En mening": **"ett glas mjölk"** proposes milk, about 250 g.
- Måltider, Ny måltid, "Recept från foto": **"Välj bild"** beside the camera
  opens the gallery; a screenshot of a recipe from the web is read into rows.
- A meal's sheet: under the photo, "Bara du ser det, om du inte delar
  måltiden."
- Nyheter: "Vikt 1.4.1" at the top.

**Rollback**: no migration ran, so `node scripts/stack.mjs deploy 1.4.0
--keep-file --yes` brings 1.4.0 back on the same data; the dump from step 4 is
there if anything else is needed.

#### What 1.4.1 changed

| | what a user sees |
|---|---|
| **The sentence is read** (D199) | "Ett glas mjölk" said "Tolkningen är inte igång just nu" while the model had answered every time, in a shape the app could not read. The shape is now asked for with a schema: over twenty everyday sentences, refusals went from seven to none. A sentence the model still cannot turn into foods says "Tolkningen förstod inte meningen", not that it is not running |
| **Välj bild** (D200) | the plate photo, the recipe photo and the label photo each have "Välj bild" beside the camera, for a picture already on the phone; it is resized and stripped of location and time in the phone like a new one |
| **Screenshots of recipes** (D200) | the recipe photo's intro says a screenshot works, and often best; a yield printed as "4 portioner · 30 min" fills the portion count |
| **The meal photo's line** (D201) | "Bara du ser det, om du inte delar måltiden.", the privacy page's own promise, where it said only "Bara du ser det." |


---

## Production ran 1.4.0 before it

**Deployed 2026-09-26 from `c6b435f`, tagged `v1.4.0`**, by `node scripts/release.mjs
1.4.0`. All thirteen steps ran. The recipe photo (D195), the matcher every
proposing tool uses (D196, D198) and the release command's fixes (D194, D197),
after the gate the owner wrote in advance had passed on every line.

**Before the command**, each read rather than assumed:

- **`PORTAINER_URL`**, now required (D197): set in the workstation's
  environment, checked by presence only, and step 1 said so.
- **The vision model**: the workstation's Ollama lists `qwen3-vl:8b` and
  answered `{"svar": "ja"}` in 8 tokens; the production host reaches it.
- **The host scripts**: `backup.sh` and `restore-check.sh` equal to `c6b435f`.
- **CI green for `c6b435f`**, the exact commit, before the command started.
- **The dry run, green**: every step ok, exit 0, step 9 reading the two
  unbuilt `:1.4.0` images as expected (D194). Its last line said "1.4.0 is
  live", which a dry run never is; fixed on `dev` afterwards, with a test.

| step | evidence |
|---|---|
| 1 workstation | `VIKT_HOST` set, `PORTAINER_TOKEN` set, `PORTAINER_URL` set, gh authenticated |
| 2 tree | clean, on `dev`, pushed, at `c6b435f` |
| 3 CI | success for `c6b435f` |
| 4 backup | `/var/backups/vikt/vikt-20260926T173433Z.dump`, 324K; beside it `media-20260926T173433Z.tar.gz`, 111 bytes, one entry: the photo directory, still empty |
| 5 restore | `daily_log 73, food_entries 310, plans 2, users 4, weight_log 108`, restored copy and live database agree |
| 6 main | fast-forwarded 12 commits to `c6b435f` |
| 7 tag | `v1.4.0` on `c6b435f` |
| 8 workflow | run `36259517211` (release, `v1.4.0`) green |
| 9 plan | nothing blocks this deploy; `IMAGE_TAG 1.3.0 -> 1.4.0`, no `setting:` line, because this release sets no variable |
| 10 deploy | both containers on the new image, the API healthy; `the vision model can see` in 1 310 ms |
| 11 API log | `version 1.4.0, commit c6b435f`; **`Migrations: none to apply, 36 already recorded`**; VAPID silent, so the key is unchanged; `vision: the vision model can see` |
| 12 outside | `https://vikt.lundstream.net/api/health` 200, `/` 200; and `/app/` 200 with `<title>Vikt</title>`, read after |
| 13 Nyheter | **`published "Vikt 1.4" as 23e25343-48c9-4b94-afd6-f09afe3e883a, 1216 characters, not mailed`** |

**Lighthouse once, on the production landing page** afterwards: 12.8.2, mobile
preset, performance **98**, accessibility **100**, best practices **100**, SEO
**100**; largest contentful paint 1,8 s, blocking time 0 ms, speed index 3,9 s,
layout shift 0,017, one container. No landing code changed between 1.3.0 and
1.4.0, where the shift was 0; one run over the real network, inside
Lighthouse's "good".

**Not yet confirmed through the interface in production**, because this
session does not sign in there. For Fredrik:

- Nyheter: "Vikt 1.4" at the top, with "Recept från foto", "Rader som inte kom
  med ligger kvar" and "Bättre träffar".
- **A real recipe on a phone**: Måltider, Ny måltid, "Recept från foto",
  photograph a recipe's ingredient list. Each row shows its printed line; a
  yield in portions fills the count; add the rows and save the meal.
- Mat, "En mening": "ett glas mjölk" proposes milk, not milk chocolate.

**Rollback**: no migration ran, so `node scripts/stack.mjs deploy 1.3.0
--keep-file --yes` brings 1.3.0 back on the same data. The dump from step 4 is
there if anything else is needed (docs/backup.md, "Restoring").

#### What 1.4.0 changed

| | what a user sees |
|---|---|
| **Recept från foto** (D195) | a new way in the meal sheet: photograph a recipe's ingredient list, in a book, on a card or on a screen, and its rows join the list with the printed line beside each. A yield in portions fills the count; a book with two amount sets asks once which to use; a row whose sets disagree says "kontrollera mot sidan"; a row with no amount says "inte än" and waits |
| **Rows that were not added stay** (D195) | in the meal sheet, rows from a sentence, a photo or a recipe that have no amount yet or no match stay in the list after "Lägg till", where before they disappeared |
| **Better matching** (D196, D198) | in every tool that proposes foods, the sentence, the plate photo and the recipe photo: the food named, not a longer word that starts with it and not a variety or a dish. "mjölk" is milk, not milk chocolate; "gula lökar" reach "Lök gul"; basil leaves reach basil, garlic cloves garlic, a chicken breast a breast row; "nötfärs" reaches plain beef mince, which the catalogue writes as two words. A bare "pizza" or "peppar" is no match rather than a guess, and the person searches. Among foods that fit, the one this person has logged most, and the same food every time they ask |


---

## Production ran 1.3.0 before that

**Deployed 2026-09-26 from `392b618`, tagged `v1.3.0`**, by `node scripts/release.mjs
1.3.0`. All thirteen steps ran. Phase 14, Måltider, with the label photo, meal
photos and sharing (D186 to D192).

**Before the command**, each read rather than assumed:

- **The photo directory**, over SSH: `/var/lib/vikt/media` exists, a directory,
  owned `1000:1000`, mode `700`. The release user is uid 1000 and in the
  `docker` group, which is what `backup.sh` needs to archive it.
- **The vision model**: Ollama on the workstation lists `qwen3-vl:8b`, and
  answered a question under a JSON schema with `{"svar": "ja"}` in 8 tokens (in
  `thinking`, which the client reads when `content` is empty, as D190
  recorded). The production host reaches it: `/api/tags` 200 from there.
- **The host scripts**: `host-scripts.mjs check` found `backup.sh` and
  `restore-check.sh` different from HEAD, `install` wrote both, and `check`
  read both equal to `392b618`. The cron line stays uninstalled (D103).
- **The dry run stopped at step 9, and it should not have.** The plan was what
  it should be (`setting: MEDIA_HOST_DIR (new)`, "required by the release and
  not set: none") and its only `blocked:` lines were the two `:1.3.0` images,
  which cannot exist before step 7 tags the release and step 8 builds it: a
  dry run skips both and then asks for their result. The real run was started
  on that reading, because nothing else was blocked and step 9 asks again after
  step 8. Fixed on `dev` afterwards: a dry run now expects exactly those two
  lines (D194).

| step | evidence |
|---|---|
| 1 workstation | `VIKT_HOST` set, `PORTAINER_TOKEN` set, gh authenticated |
| 2 tree | clean, on `dev`, pushed, at `392b618` |
| 3 CI | success for `392b618` |
| 4 backup | `/var/backups/vikt/vikt-20260926T133431Z.dump`, 320K; beside it `media-20260926T133431Z.tar.gz`, 111 bytes, one entry: the photo directory, empty, as production had no photos yet |
| 5 restore | `daily_log 73, food_entries 310, plans 2, users 4, weight_log 108`, restored copy and live database agree |
| 6 main | fast-forwarded 19 commits to `392b618` |
| 7 tag | `v1.3.0` on `392b618` |
| 8 workflow | run `36245630030` (release, `v1.3.0`) green |
| 9 plan | nothing blocks this deploy; **`setting: MEDIA_HOST_DIR (new)`**; `IMAGE_TAG 1.2.1 -> 1.3.0` |
| 10 deploy | both containers on the new image, the API healthy; `llm=on` (the workstation's Ollama), `the vision model can see` in 1 597 ms |
| 11 API log | `version 1.3.0, commit 392b618`; **`Migrations: 4 applied, 36 recorded in total`** (`0032_meals`, `0033_label_photo`, `0034_media_backup`, `0035_meal_sharing`); VAPID silent, so the key is unchanged; `vision: the vision model can see` |
| 12 outside | `https://vikt.lundstream.net/api/health` 200, `/` 200; and `/app/` 200 with `<title>Vikt</title>`, read after |
| 13 Nyheter | **`published "Vikt 1.3" as 0d85a6d2-dcbf-430a-bc27-42bad8e33e48, 1676 characters, not mailed`**, with the photo sentence ending "och visas bara för dig, om du inte delar måltiden." |

**Lighthouse once, on the production landing page** afterwards: 12.8.2, mobile
preset, performance **98**, accessibility **100**, best practices **100**, SEO
**100**; largest contentful paint 1,8 s, layout shift 0, blocking time 0 ms,
speed index 3,7 s. The speed index was 1,7 s on the local preview build
(2026-09-17); this one crossed the real network and TLS.

**Not yet confirmed through the interface in production**, because this
session does not sign in there. For Fredrik, signed in as the administrator:

- Administration, Backup, "Kör nu" once: the run line should end in "0 foton".
- On a phone, Mat: the saved meals at the top, each with "kcal per portion".
- Nyheter: "Vikt 1.3" at the top.

**Rollback** is `vikt-20260926T133431Z.dump` restored (docs/backup.md,
"Restoring"; D186) and then `node scripts/stack.mjs deploy 1.2.1 --keep-file
--yes`. Meals, photos, label foods and shares made since are lost with it; the
photo directory can stay, 1.2.1 does not read it.

#### What 1.3.0 changed

| | what a user sees |
|---|---|
| **Måltider** (D186, D187) | the dishes you cook, with a portion count and figures per portion, in their own section reached from Mer and from the top of Mat. Built with search, barcode, a sentence or a plate photo; edited and removed from the same sheet. "Vad kan jag laga?" lives here now |
| **Logging a meal** (D189) | the most used meals at the top of Mat; one tap, a portion field (1, decimals allowed), and the day reads "Kycklinggryta · 1,5 portioner" with its rows underneath, each still editable. Later edits to the meal change no logged day |
| **Your saved meals come with you** (D186) | every "Sparad måltid" becomes a meal of one portion, with everything it had |
| **The label photo** (D190) | when a barcode finds nothing, or from "Skriv in själv": photograph the nutrition table, check each figure beside the photo, and it becomes your own food, "från etikett", found by the next scan of that barcode. Figures that do not add up cannot be saved |
| **A photo on a meal** (D191) | one each, kept on the server in your own folder, in the export and in the backups |
| **Sharing** (D192) | with a display name set in Profil, a meal can be shared with everyone on this installation. "Delade måltider" lists them; saving or logging one makes it your own copy. Reports go to Administration, Anmälningar |
| **Export** (D191) | "Allt, med foton, som zip" under Inställningar |
| **One is singular** (D192) | "1 foto", "1 matrad", "1 rad loggad", "Spara 1 rad": every count that opens a sentence, and the ones inside a sentence that can be one, where the deletion sheet said "1 foton" |

Not in 1.3.0: **import from a photo of a recipe** (item 8 of the Phase 14
brief), carried under "Inför nästa deploy".


---

## Production ran 1.2.1 earlier

**Deployed 2026-09-17 from `bc06167`**, by `node scripts/release.mjs 1.2.1`.
**All thirteen steps ran**, which had never happened before.

| step | evidence |
|---|---|
| 1 workstation | `VIKT_HOST` set, `PORTAINER_TOKEN` set, gh authenticated, STATE.md names `bc06167` |
| 2 tree | clean, on `dev`, pushed, releasing `bc06167` |
| 3 CI | success for `bc06167` |
| 4 backup | `/var/backups/vikt/vikt-20260917T220025Z.dump`, 308K |
| 5 restore | `daily_log 66, food_entries 247, plans 2, users 4, weight_log 99`, restored copy and live database agree |
| 6 main | at `bc06167` |
| 7 tag | `v1.2.1` |
| 8 workflow | run `35278864241` success |
| 9 plan | nothing blocks this deploy; `IMAGE_TAG 1.2.0 -> 1.2.1`, **no `setting:` line**, because this release needs no variable |
| 10 deploy | both containers on the new image, the API healthy |
| 11 API log | `version 1.2.1, commit bc06167`; **`Migrations: none to apply, 32 already recorded`**; VAPID silent, so the key is unchanged; `the vision model can see` |
| 12 outside | `https://vikt.lundstream.net/api/health` 200, `/` 200 |
| 13 Nyheter | **`published "Vikt 1.2" as eab68bfd-66d0-40c7-b2a6-ace7eeaca944, 2133 characters, not mailed`** |

**Confirmed in production afterwards, through the interface.** `/app/nyheter`
shows "Vikt 1.2" at the top, dated torsdag 17 september, with its sections
rendered from the Markdown subset (D128): Mat och makron, Data, Samband,
Coachen, Läsbarhet, Rättat, Startsidan. `/` shows eight sections in order with
**Gratis** between "Appen i telefonen" and "Din data", two paragraphs, beginning
"Det finns ingen betalversion."

**The closing sweep, 2026-09-17**: `shoot2.mjs` over every finished screen at
360 px and desktop, **40 of 40, none failed**, both landing rows reading
`landing-ok=sentence15/meta13/gap64`. The page is 6 796 px tall at 360 and
5 206 at desktop, up from 6 402 and 4 925, which is the Gratis section (D184).
CI green on `dev` throughout.

#### What it took, after 1.2.0

Two more findings, both in the tooling and both now held by a test:

- **A release with no migrations still prints a migrations line** (D183, ninth).
  `migrate.ts` has two sentences and the check matched one of them, so it
  quietly required every release to carry a migration. 1.2.1 carries none.
- **A named commit needs a run that was allowed to finish**, and the tip stops
  being a safe target once the tag exists. Both are written up under "Inför
  nästa deploy" as the rule they produced.

---

## Production ran 1.2.0 earlier

**Deployed 2026-09-17 from `a21224c`**, twelve of thirteen steps. The thirteenth
could not run: the image had no `dist/news-publish.js`, because the script was
written after the build's entry list and `tsx` is a dev dependency a production
image does not carry (D183). That is what 1.2.1 fixed, and why 1.2's release
notes reached readers a day late.

It took seven attempts and **every failure was in the tooling, not the app**
(D183): six checks answering a question next to the one they were asked, and one
script that could only run where it was not.

The closing sweep for it: 40 of 40 at 360 px and desktop, none failed.

---

## Inför nästa deploy

**Nothing is prepared yet.** Production runs `1.4.1` (above), released from
`da88d0d`; everything on `dev` after that commit goes into the next deploy,
which takes a number here, with its handover, once there is something to
release.

#### How the next release is told what to set

**Stack variables go in one block in this section**, fenced with the info
string `release`, one a line: `NAME=value`, or a secret's name alone, whose
value then comes from the workstation's environment and is never written here.
`release.mjs` reads that block and nothing else, so the sentences around it can
mention `--set` without setting anything. **There is no block yet, so the next
release sets no variables.** Two blocks, or a line that is neither form, stop
the command before step 1 (D194).

#### On `dev` since 1.4.1

Nothing yet.

**Known, and not changed**: the plate photo still asks the vision model in
free JSON mode, the mode that failed the sentence tool (D199). It has not been
seen failing this way; a schema for it needs its own probe on the vision model.

**Every pass on `dev` appends to this section**, and nothing merges to `main`
until it has been read.

### Till Nyheter

**Färdig text, klistra in som den är** under Administration, Meddelanden. Inga
tankstreck (§5), och registret är appens eget: du, inte "användaren".

<details>
<summary>1.4.1</summary>

```markdown
## Vikt 1.4.1

**Välj en bild.** Fotot av tallriken, receptet och näringsdeklarationen kan nu
också hämtas ur bilderna i telefonen, inte bara tas med kameran. Välj bild
ligger bredvid kameraknappen. Bilden förminskas och rensas från plats och tid i
telefonen, precis som ett nytt foto.

**Skärmbilder av recept.** Hittar du ett recept på webben kan du ta en
skärmbild och välja den, och det blir ofta bäst: inga ränder och ingen
avskuren spalt. Står det hur många portioner receptet räcker till fylls
antalet i, även när tiden står på samma rad.

**En mening förstås.** Skriver du vad du ätit, som "ett glas mjölk", tolkas det
nu som det ska. Förstår tolkningen ändå inte meningen säger den det, i stället
för att säga att den inte är igång.

**Fotot på en måltid.** Texten under fotot säger nu det som gäller: bara du ser
det, om du inte delar måltiden.
```

</details>

<details>
<summary>1.4.0</summary>

```markdown
## Vikt 1.4

**Recept från foto.** När du gör en måltid kan du fotografera
ingredienslistan i ett recept, i en kokbok, på ett kort eller på en skärm.
Raderna skrivs av och hamnar i samma lista som när du skriver en mening, och
bredvid varje rad står det som var tryckt, så att du kan jämföra. Står det hur
många portioner receptet räcker till fylls antalet i. Har kokboken två mängder
på varje rad väljer du vilken du vill använda, och en rad där mängderna inte
stämmer med de andra märks "kontrollera mot sidan". En rad utan mängd, som salt
och peppar, väntar på dig i stället för att få en gissad siffra. Bilden sparas
inte.

**Rader som inte kom med ligger kvar.** Lägger du till rader i en måltid från
en mening, ett foto eller ett recept, ligger de som saknar mängd eller träff kvar
i listan tills du fyller i dem eller tar bort dem.

**Bättre träffar.** När en mening, ett foto eller ett recept föreslår mat letar
appen efter just det du skrev. Mjölk blir mjölk och inte mjölkchoklad, gula
lökar hittar gul lök, basilikablad hittar basilika och nötfärs hittar nötfärs.
Står det bara pizza föreslås ingen särskild pizza, för det vore en gissning, och
du söker själv. Har du loggat en vara förut är det den som föreslås igen.
```

</details>

<details>
<summary>1.3.0</summary>

```markdown
## Vikt 1.3

**Måltider.** Rätter du lagar ofta har en egen plats, under Mer och överst på
Mat. En måltid har ett namn, hur många portioner den räcker till och
ingredienserna, som du lägger till med sökning, streckkod, en mening eller ett
foto av tallriken. Varje måltid visar kalorier och makron per portion. Dina
sparade måltider finns redan där, som måltider på en portion. "Vad kan jag
laga?" har flyttat hit.

**Logga en måltid.** Överst på Mat ligger de måltider du loggar oftast. Tryck
på en, skriv hur många portioner du åt, en och en halv går bra, och logga.
Dagen visar måltiden med raderna under, och varje rad går att ändra som
vanligt. Ändrar du måltiden senare ändras inga dagar du redan loggat.

**Fotografera etiketten.** Hittar streckkoden ingenting, eller vill du skriva
in något själv, kan du fotografera näringsdeklarationen på förpackningen.
Siffrorna skrivs av från bilden, och du jämför var och en med fotot innan
något sparas. Stämmer de inte med varandra säger appen det, och du rättar
dem mot förpackningen. Varan sparas som din egen, märkt "från etikett", och
nästa gång du skannar den hittas den direkt. Bilden sparas inte.

**Foto på måltiden.** En måltid kan ha ett foto. Det förminskas i telefonen,
rensas från plats och tid och visas bara för dig, om du inte delar måltiden.

**Dela en måltid.** Anger du ett visningsnamn under Profil kan du dela en
måltid med alla som har konto här, aldrig med någon utanför. Andras delade
måltider ligger under Delade måltider. Sparar eller loggar du en blir den en
kopia som är din, och den ändras inte när den som delade den ändrar sin.

**Ta med allt.** Under Inställningar finns nu hela kontot som en zip, med
fotona.
```

</details>

<details>
<summary>1.2.1</summary>

**The post is for 1.2 rather than for 1.2.1.** What a reader got is everything
1.2.0 brought; 1.2.1 is the release that manages to announce it, plus one
section on a page they may never have opened. A post headed "1.2.1" would be
announcing a patch number to people who never saw 1.2.0 arrive.

```markdown
## Vikt 1.2

**Mat och makron.** En summa som bygger på mat där uppgiften saknas står som
"minst" i stället för att se komplett ut, och under den står hur stor del av
energin som faktiskt har uppgiften. Sökningen hittar dig även när du stavar fel
inuti ett långt namn, och säger när den letar vidare i livsmedelsdatabasen.

**Data.** Under Data finns Dagar: en rad per dag med vikt, trend, intag,
makron, alkohol, rörelse, steg, sömn, energi, humör, midja och den uppmätta
underhållsnivån den dagen. Sortera på vilken kolumn du vill. Under
Inställningar kan du nu ta med dig allt som en Excel-fil, som JSON, eller som
en CSV-fil per tabell.

**Samband.** Intag mot trendförändring ritas en hel vecka i taget i stället för
en gång per dag, med en streckad linje för vad 7 700 kcal per kilo säger att
veckan borde ge. Veckor där snittintaget ändrats mycket ritas som ringar, för
då hinner trendvikten inte med.

**Coachen.** För varje område den tar upp säger den vad området betyder för
ditt mål, med appens egna ord och märkt som allmänt när det är allmänt. Den
hittar fortfarande aldrig på en siffra.

**Läsbarhet.** Den gråa texten, alltså etiketter, enheter och förklaringar, har
blivit ljusare i mörkt tema och mörkare i ljust. Den ligger nu över gränsen för
läsbar kontrast överallt där den används, i stället för bara på de flesta
ställen.

**Rättat.** Skillnaden på Översikt står med en decimal, som alla andra vikter i
appen, i stället för två. Märkningen för uppskattat värde står med liten
begynnelsebokstav, som appens övriga märkningar. Veckosammanfattningen säger
vilken dag veckan började med ord, till exempel "måndag 7 september", i stället
för 2026-09-07, och viktförändringen i den står med en decimal som alla andra
vikter. Sammanfattningar som redan är skrivna ändras inte, men nästa gör det.

**Startsidan** är ombyggd. Kurvan där är ritad av appens egen uträkning och med
samma mjuka kurva som din egen graf, inte en bild någon har ritat för hand. Den
visar också skillnaden mellan en dagsvikt och en trendvikt med två siffror i
stället för ett andra diagram. Inget av det du har loggat påverkas, och inga
siffror räknas om.
```

</details>

<details>
<summary>1.1.1</summary>

```markdown
## Version 1.1.1

Listorna du väljer ur ser ut som textfälten igen. De har samma rundade hörn,
samma luft runt texten och samma textstorlek, och i mörkt tema ligger de på
kortets färg i stället för på sidans bakgrund. I ljust tema har pilen i listan
fått rätt grå nyans. Inget annat ändras, och inga siffror räknas om.
```

</details>

<details>
<summary>1.1.0, om den inte redan är publicerad</summary>

```markdown
Det här är en stor uppdatering. Nedan står allt som syns, skärm för skärm.
Inget av det du har loggat påverkas, och inga siffror räknas om.

## Översikt

Viktgrafen ritar en kurva mellan vägningarna i stället för en trappa. Väger du dig
varje dag ser den likadan ut som förut. Väger du dig en gång i veckan låg linjen
förut stilla hela veckan och föll sedan allt på en dag, vilket inte var vad som
hade hänt. Siffrorna är oförändrade. Linjen slutar numera vid den senaste
vägningen i stället för att fortsätta rakt fram till i dag.

Skalan visar jämna steg igen, och alla vägningar får plats i bilden. Den senaste
kunde tidigare hamna utanför och ritades då inte alls. Rutan som visas när du
trycker på grafen har samma antal decimaler som siffran ovanför.

**Alla vägningar går att ändra, inte bara de fem senaste.** Under listan finns
"alla vägningar", som öppnar en månadskalender där dagarna med en vägning är
markerade. Tryck på en av dem för att ändra eller ta bort den, eller på en tom dag
för att fylla i en vägning du missade.

Saknas ett makrovärde står det numera varför: ingenting loggat, eller för få dagar
med uppgifter om just det makrot. Fibervärden saknas oftare än de andra i öppna
matdatabaser.

## Mat

**Du kan fotografera maten i stället för att skriva vad du åt.** Bilden skickas
till modellen på arbetsstationen, som säger vilka livsmedel den ser. Kalorierna
kommer som alltid från livsmedelsdatabasen, och ingenting sparas förrän du har läst
raderna och tryckt spara.

**Bilden sparas aldrig.** Inte på servern, inte i loggen, inte i telefonen. Den
läses en gång och kastas, och platsen och tidpunkten som kameran lägger i filen
tas bort innan den skickas. Går det inte att skicka är bilden borta och du får ta
en ny.

Mängderna är det bilden är sämst på. Oftast står det "inte än" i mängdrutan och du
får fylla i själv, och en rad utan mängd går inte att spara. Raderna är märkta som
uppskattade. Har maten en streckkod är Skanna fortfarande det som ger rätt produkt.
Fotot är till för tallriken som inte har någon.

Skanna, Fotografera maten, Skriv in själv, Skriv vad du åt och Vad kan jag laga
ligger nu på en rad, som runda snabbval med etikett under, i stället för som knappar
utspridda på sidan. De som behöver en språkmodell försvinner när den är avstängd.

Tryck på en loggad rad för att se protein, kolhydrater, fett och fiber för just den
raden, hur mycket det var och varifrån siffrorna kommer. Ändra, ta bort och
"Logga i dag" ligger numera där, i den öppnade raden.

Tittar du på en tidigare dag kan du logga en rad, eller hela dagen, på dagens datum.
"Igen" under Senast loggat fyller fortfarande i dagen du tittar på. Att välja en
träff i matsökningen stänger träfflistan.

## Dagen

**Dagen har en egen checklista.** Skriv in det du vill göra varje dag, med eller
utan ikon, och bocka av med ett tryck. Ett tryck till tar bort bocken. Under varje
vana står hur många dagar i rad du har den, och en dag du inte fyllde i listan alls
räknas som okänd i stället för som missad. Tar du bort en vana får du välja om
dagarna du redan bockat av ska följa med.

Varje vana kan ha en egen påminnelse, och den sätter du direkt när du skapar vanan.

Loggar du en träning kan du trycka på raden för att ändra den i stället för att ta
bort den och skriva in den igen. Måtten går att ta bort, inte bara skriva över.

## Coach

Under Mer finns Coach: en sida där veckan sammanfattas och där du kan ställa frågor
om hur det går. Svaret bygger bara på dina egna siffror, hittar aldrig på några nya
och ändrar ingenting. Loggar och planer sköter du själv. Svaret skrivs ut medan det
blir till.

Du väljer ton under Coach: Torr, Peppig eller Saklig. Valet gäller både
sammanfattningen och chatten. Saklig har ingen personlighet alls.

Veckans sammanfattning skrivs av sig själv på söndagskvällen, klockan 20:00 i din
egen tidszon. Har veckan färre än fyra loggade dagar skrivs ingen alls. Är den ny
visas den överst på Översikt, en gång, med "Läs hela" till Coach. Trycker du
"Tack, läst" försvinner den på alla dina enheter.

Samtalen sparas på ditt konto, visas bara för dig och används inte till något annat.
Du kan ta bort ett samtal i taget eller allihop, och de följer med i exporten.
Frågor om medicin, sjukdom och graviditet besvaras inte, utan hänvisas till vården
i en mening.

**Coachen ser numera dina uppgifter, inte bara en sammanfattning av dem.** Den
har intaget mot din uppmätta underhållsnivå och hur stor del av dagarna som är
loggade, varje makro mot ditt eget mål och hur många dagar som legat under det,
alkohol och nyktra dagar, träningspass och minuter, steg, sömn, energi och humör,
vanor med streck, och måtten och hur de ändrats. Allt räknat över både sju och
tjugoåtta dagar. Den ser också namnen på det du ätit den senaste veckan, bara
namnen: inga mängder, inga kalorier och inga makron per maträtt. Frågar du brett,
om upplägget eller om hur det går, svarar den från flera av områdena i stället för
bara från vikten.

Vad den får och inte får göra med dem. Den får berömma det siffrorna visar, så länge
berömmet hänger på en uppgift som faktiskt står där. Den får ge högst två förslag
i ett svar, och ett förslag är alltid ett alternativ: "du kan", "om du vill", "ett
alternativ är". Aldrig "du måste", "du ska" eller "du bör". Den namnger en
riktning, som mer protein, mer rörelse eller mer sömn, aldrig en siffra du inte
själv har satt som mål.

Två serier sätts bredvid varandra, aldrig som orsak och verkan. Appen räknar inga
samband, och sidan Samband finns just för att du ska få titta på punkterna själv
och dra dina egna slutsatser.

Ett område du inte fyllt i sägs vara just det, inte noll. "Ingen rörelse är
loggad" i stället för "0 pass", eftersom noll är en mätning och det här är en
lucka.

Hela Coach finns bara om AI-lagret är påslaget på den här installationen.

## På telefonen

**Du kan svepa mellan sidorna.** Ett svep åt vänster eller höger på Översikt,
Dagen, Mat och Framsteg tar dig till nästa eller föregående, och sidan följer
fingret medan du drar. Släpper du för tidigt glider den tillbaka. Att trycka i
menyn längst ner ger samma rörelse.

Svepet håller sig undan där det ska. De yttersta två centimetrarna längs
kanterna tillhör telefonens egen bakåtgest. Viktgrafen, serierna under Data och
allt annat som går att dra i sidled äger sitt eget drag. Och ett drag som mest
går uppåt eller nedåt är fortfarande en scroll, inte ett svep.

Har du bett telefonen om mindre rörelse byter sidorna som vanligt, utan
animation.

## Påminnelser

Två påminnelser går att slå på under Inställningar: en på morgonen om att väga sig
och en på kvällen om att fylla i dagen. Var och en har en tid för vardagar och en
för helgen, med var sin knapp, så morgonpåminnelsen kan vara 07:00 i veckan och
09:00 på lördag och söndag, eller avstängd då. Alla fyra är avstängda tills du slår
på dem. Vilka dagar som är helg räknas i din egen tidszon.

Morgonens hoppas över om du redan vägt dig, kvällens om dagen redan är ifylld.

Push fungerar i webbläsaren på Android. På iPhone fungerar det bara när appen är
installerad på hemskärmen, vilket står bredvid knappen.

## Runt omkring

Framsteg är omstuvad: potten och nykterhetsräknaren ligger ovanför listorna, och
milstolpar och sparregler är hopfällda med antal bredvid rubriken. "Lägg till
milstolpe" och "Ny sparregel" öppnar ett formulär i ett eget fönster i stället för
att stå framme hela tiden.

Knapparna har tre former i stället för fyra. Allt som gör något är en fylld knapp,
allt som bara tar dig därifrån är en textlänk, och det som kostar något har en egen
färg. Att radera ett konto kräver att adressen skrivs in.

Nyheter kan innehålla rubriker, fetstil, punktlistor, numrerade listor och länkar,
både i appen och i mejlet.

Formuläret för att be om en inbjudningskod ligger inte längre på startsidan. Det har
flyttat till en egen adress som inget länkar till, och den är avstängd om inte den
som driftar servern slår på den.

Ändrar du en vägning utan nät, och samma vägning hinner tas bort någon annanstans
innan din ändring kommer fram, försvinner inte det du skrev. Under Inställningar
får du välja: lägg tillbaka vägningen på den dagen, eller släng den. Samma två
svar som när två enheter har skrivit samma dag, fast med en vägning i stället för
två att välja mellan.

Bakom varje ruta som öppnas över sidan ligger sidan numera mörkare och lite
suddig, i båda teman, och rutan har ingen egen kantlinje. Markören hamnar direkt i
det första fältet när rutan öppnas.

Backupen skrivs numera till en katalog eller till en S3-hink, och hemligheten lagras
krypterat. Knappen "Testa anslutningen" skriver en liten fil och tar bort den igen,
så att du ser att det fungerar innan nattens körning.
```

</details>

## On `dev`, not yet on `main`

Production deploys from `main` (CLAUDE.md §7), so this list is the difference
between what is built and what is running. **`main` is `da88d0d`, the `v1.4.1`
tag, and production runs it.** Everything on `dev` after it goes into the next
deploy:

| | |
|---|---|
| (this record) | The session's report |
| `6d5d409` | Production runs 1.4.1, and all thirteen steps ran |

### Before the next redeploy

`tailwind.config.js` changed, adding the `on-reward` colour. Tailwind resolves
its config at boot, so a development server that has been up since before that
commit serves the old one and reports `text-on-reward` as a class that does not
exist. §7 now carries the rule, including that `pkill -f vite` does nothing on
Windows and the kill has to be by port.

## Still open from the briefs

### The 2026-09-26 brief: Phase 14, Måltider, and 1.3.0

Eight items of nine done, each exercised through the interface and recorded
(D185 to D193). **Open:**

- **Item 8, import from a photo of a recipe: built after 1.3.0** (D195) and
  deployed in `1.4.0`.
- **The three framed phone portraits** are Fredrik's: the raw screenshots in
  `docs/screens/raw/` carry the current date format; reframe them, replace the
  three portraits, and `node scripts/landing-screens.mjs` picks them up.
- **`1.3.0` is deployed** (2026-09-26, "Production ran 1.3.0 before it").
  What is left of it is Fredrik's three checks in production, listed there.

### The 2026-09-26 release brief: the matcher refined, and 1.4.0

**All four items done**: §7's two rules and the `edge` exception scoped (D197),
the matcher's three refinements (D198), the gate passed on every line, and
`1.4.0` deployed with all thirteen steps ("Production runs 1.4.0"). **Open:**
Fredrik's checks in production, listed there, including one real recipe photo
through Måltider on a phone.



### The 2026-09-26 evening brief: the phone test, and 1.4.1

All four items done: D199, D200 and D201 on `dev`, and `1.4.1` deployed with
all thirteen steps ("Production runs 1.4.1"). **Open:** Fredrik's checks in
production, listed there, "ett glas mjölk" after a reload first among them.
### The second landing brief: the page's polish, Sten, and three defects

**All four items are done on `dev`**, and nothing inside one was left half
finished. What each one was and what it turned into is D177 (the page), D175
(Sten) and D176 (the three defects); the 1.2.0 preparation above carries the
rest.

**One requirement was met by deviating from the value the brief named.** The
brief asked for the nearest Sten passing 4,5:1 **on Skymning**. Skymning is not
the worst surface Sten sits on: Dis is, and a value chosen against Skymning
still fails there. The token is chosen against Dis instead, so it passes
everywhere rather than on the surface that was measured (D175).

### The 2026-09-17 brief: the landing page, the variables, the release

All three items are done on `dev`. **One requirement inside item 1 is not met and
is not going to be met by this page**, so it is written here rather than left in
a commit message:

- **The landing bundle is 58,3 kB of JavaScript gzipped, against the 40 kB the
  brief asked for.** 45,9 kB of that is react and react-dom, so the page's own
  code is a quarter of the budget and no amount of work on it reaches the
  number. What does: prerender the three static public pages at build time and
  load React only for `/kod`, the one with a form. That is a change to the build
  pipeline and it was not made in the same pass as the page.

  **The second pass settled how this is held** (D177, D173's addendum): two
  budgets rather than one, the page's own code at **15 kB** and everything `/`
  fetches at **60 kB**, both asserted by `apps/web/scripts/check-bundle.mjs`.
  Prerendering is backlog, written down so the gap stays visible rather than
  becoming the new normal.

### The 2026-09-15 brief: all eleven done

Items 1 to 8 landed that pass; 9 (the day table and the Excel export, D167), 10
(the landing page, which the 2026-09-17 brief replaced with a rebuild rather
than a copy fix, D173) and 11 (this section, for 1.2.0) landed after it.

**Finished on `dev` the pass before.** Each was a numbered item and each is whole:

- **Rules of hooks** is enabled and error-level, `exhaustive-deps` is a warning,
  and the three things it found are fixed. It was never installed, which is why
  a `useState` below an early return reached runtime last pass.
- **Framsteg** leads with the header card and the pot, and folds its two lists
  behind counted disclosures with the create forms in sheets (D126).
- **`/kod` behind `REQUEST_ENABLED`**, off by default, documented as a
  deployment mode beside `LANDING_ENABLED`, with the hero line replaced and
  `/integritet` updated (D127).
- **Markdown in announcements**: a small subset, parsed rather than sanitised,
  rendered in the app, the HTML mail and the plain-text part, with a preview in
  the editor and the copy guards run over the output (D128).
- **Mail to the admin on an access request**, with a dot on the admin entry
  while anything is pending and a per-admin opt-out that is on by default
  (D129).
- **Backup to an SMB share**, spoken from Node rather than mounted, with the
  credentials encrypted at rest and a test-connection button that writes and
  deletes a probe file (D130).

**Found while verifying, and fixed** (D131): `/kod` was a 404 in the dev and
preview servers because their nginx mirror had not been updated, and then it
existed unconditionally because the SPA fallback answers any unknown path. Both
now honour the flag. The preview server was also truncating every static
response, because the app-name substitution shortens the body and the
`Content-Length` sirv had already sent was too large; pages sat at
`readyState: "loading"` forever.

**Waiting on the owner, for the phone half of the reminders (D136):**

The desktop round trip is done and recorded above. What cannot be done from
here is the device that matters:

1. Install the app on the phone from the home screen. On iOS a reminder cannot
   arrive at all until it is installed; on Android the browser is enough.
2. Open Inställningar, Påminnelser, and allow notifications.
3. Press "Skicka en testnotis" and confirm it arrives on the phone.
4. Leave "Påminn mig att väga mig" on overnight and confirm the 07:00 one
   arrives the next morning, before weighing in, and that it does **not** arrive
   on a morning where the weight was already logged.

**Report the device and the Chrome version** with the result, so this section
can record what it was verified on rather than that it was verified.

**Waiting on the owner, for the real phone half of the section swipe (D154):**

Everything above was done in mobile emulation with dispatched touches, and that
answers whether the gesture works. It cannot answer the only question that
matters afterwards, which is whether it gets in the way:

1. Open the app on the phone and swipe between Översikt, Dagen, Mat and
   Framsteg, both directions, a few times each.
2. Scroll each of those screens normally for a minute without meaning to swipe.
   **Report any section that changed when you did not ask for it.**
3. Drag sideways across the trend line on Översikt, and across a series on Data.
   Neither should move the page.
4. Start a drag from the very left edge, the way a thumb rests. The phone's own
   back gesture should happen and the app should not move.
5. If the phone is set to reduce motion, confirm the sections still change and
   nothing slides.

**Report the phone and the browser** with the result, so this section can record
what it was verified on rather than that it was verified.

**Waiting on the owner, for the camera half of photo logging (D143):**

The whole path is exercised and recorded above — the resize, the post, the
model, the proposal list — but through a browser handed a file, because that is
what a desktop can do. The one thing it cannot show is
`capture="environment"`: the attribute that tells a phone to open the **camera**
rather than the gallery. Open Mat on the phone, press Fotografera maten, and say
whether the camera opens straight away. If it opens the picture gallery instead,
that is the finding and it is a one-line change.

**Blocked, not skipped:** removing the probe request
`human-check-probe@example.test` needs the production database, and the
Portainer password was rotated after the deployment pass. It is under
Administration, Förfrågningar, Besvarade, "Ta bort".

## Verified

**1963 tests**, counted on 2026-09-16 after the landing page's second pass:
522 shared, 422 web, 1019 api. **Nine more run in CI**, and they
are the same nine every time: the S3 destination's live suite in
`backup-s3-live.test.ts`, which needs a real S3 server and `pg_dump`. CI starts
MinIO and sets `S3_TEST_ENDPOINT`; a workstation has neither, so they skip here
and the run says so in a line naming them. The file also asserts that where the
endpoint *is* configured nothing is half-skipped, so a CI box that lost
`pg_dump` fails rather than quietly covering less (§7). Lint clean, all three packages
typecheck, both bundles build, and the placeholder guard passes.

**In CI the api suite runs 1028 with none skipped**, and that is checked rather
than read: `pnpm test:skips` reads the reports and names anything skipped outside
the allowlist. What matters is the nine: the nine S3 tests execute against a real MinIO with default settings
rather than skipping. Locally they skip unless `S3_TEST_ENDPOINT` is set, and
say so. The suite is also run with `SECRET_KEY` unset and under `TZ=UTC`, both
of which have caught tests that passed only on this workstation.

**Push, verified end to end on the desktop.** Edge 152 headless against the
production build: the browser subscribed to a real push service
(`wns2-db5p.notify.windows.com` — Edge uses WNS where Chrome uses FCM), the
server signed the message with its VAPID key, and the notification arrived with
the right title, body and tag. `POST /api/push/test` reported
`{"devices":1,"sent":1,"removed":0}` and the service worker's own handler showed
it. The scheduler was also run against the development database: at 07:00
Stockholm it finds the account, and at 08:00 it finds nobody, which is the
late-is-worse-than-never rule outside a test harness.

**Still open, and only the owner can close it** (see the section below).

**The full sweep, 2026-09-17, after the sixth landing pass**: `shoot2.mjs` over
every finished screen at 360 px and desktop against the development server,
**40 of 40, none failed**, verdict in the set's `verdict.txt`. CI green on `dev`
for `9c6080b`.

**The sweep asks the landing page two questions nothing else could** (D181).
Both are relationships between elements rather than properties of one, which is
why neither a token test nor a screenshot had caught them: the sentence beside a
phone picture against a page paragraph, and the gap before the footer against
the gap between two sections. Both landing rows now read
`landing-ok=sentence15/meta13/gap64` — 15 px against a 15 px paragraph, 13 px
one step below it, and 64 px of footer gap against 64 px of section padding.

**Exercised through the interface on 2026-09-17**, the sixth landing pass
(D181), against the **production build** served by `vite preview`:

- **The ring, mid-flight**, which is the only state it has: at 0,70 opacity its
  box is 937 to 951 px inside an SVG box of 297 to 969, so it is whole on the
  right, the top and the bottom. It had been clipped at the right edge on every
  run since it was written, and no screenshot of the finished page could have
  shown that, because by then the ring is gone;
- **the two cards**: the trend reads 84,5 from the first sample and never
  changes, the daily steps 84,6 to 84,4 to 84,6 at 900 ms and stops while it is
  off screen, unchanged over 2,7 s. The daily figure is Sten
  `rgb(133, 148, 154)` and the trend is Snö `rgb(237, 241, 242)`, which is the
  maintenance section's own pairing read off the page;
- **alignment**: twenty-three headings and paragraphs outside the cards, none of
  them left aligned;
- **a phone frame** at seven positions: +22,0°, +9,8°, 0,0°, 0,0°, 0,0°, -9,8°,
  -22,0°, `box-shadow: none` at every one;
- **reduced motion**: the ring `display: none`, the line drawn, all three words
  present, the frames square, the daily card holding one reading;
- **Lighthouse at mobile settings**: performance 98, accessibility 100, zero
  layout shift, with no audit failing.

**Exercised as a command, not through a screen**: `node scripts/release.mjs
1.2.0`, which stopped at step 1 of 13 with `VIKT_HOST is not set` and attempted
nothing after it. That is the whole of what it did, and it is the evidence that
the stopping works outside its own tests. Everything below step 1 is held by
`release.test.ts`: every step failed in turn, each asserting both the stop and
that nothing belonging to a later step was asked, plus the plan step run against
a live Portainer double.

**The full sweep, 2026-09-16, after the landing page's second pass**:
`shoot2.mjs` over every finished screen at 360 px and desktop against the
development server, **40 of 40, none failed** (signed in, no horizontal overflow,
no blank screen, no transform left on the section track), verdict in the set's
`verdict.txt`. CI green on `dev` for `fe76d1f`, the head of this pass.

**The sweep's two landing rows prove less than the others, and it is the
method.** The hero is `min-h-[100svh]`, and `shoot2.mjs` measures a page at a
normal viewport and then re-navigates with the viewport set to that whole height
so charts measure once against what is captured. On this one page that makes the
hero alone as tall as the capture, and everything below it falls outside the
image. The rows are still worth their `overflow=0` and `text=2804` — the copy is
all in the document at both widths — but the page's own evidence is the
measurement pass below, taken at a real viewport and scrolled.

**The full sweep, 2026-09-16, after item 8**: `shoot2.mjs` over every finished
screen at 360 px and desktop against the development server, **40 of 40, none
failed** (signed in, no horizontal overflow, no blank screen, no transform left
on the section track), verdict in the set's `verdict.txt`. CI green on `dev`
for every commit this pass, the last being `5a61902`.

**Exercised through the interface on 2026-09-16**, the landing page's second
pass (D177), against the **production build** served by `vite preview`:

- **The hero, sampled on the page's own clock**: 4 of 30 readings at 419 ms, all
  30 by 2,1 s with the line a quarter drawn, the line finished by 3,2 s, and the
  **endpoint appearing only after that**. It used to arrive at 3 400 ms against a
  line that finishes at 3 500;
- **the scroll-driven section at four positions**: progress 0, 0, 0,769 and
  1,0, with 0, 0, 11 and **14 of 14** readings shown. It read 13 of 14 before
  this pass, because the last dot's threshold was exactly 1 and the comparison
  is strict, which no assertion about a number would have found;
- **and then back to the top**: progress stays 1,0 and all fourteen readings
  stay. Nothing on the page animates in reverse now;
- **a mid-scroll shot on a fresh load**: the line a third drawn with five of the
  fourteen readings arrived, so the readings really do appear under the line
  rather than waiting in a cloud for it;
- **reduced motion**, emulated, 900 ms after load: 30 of 30 hero readings, both
  lines drawn, the endpoint at full opacity, progress 1, 14 of 14. The finished
  page at once;
- **Lighthouse at mobile settings**: performance 98, accessibility 100, zero
  layout shift, and the two budgets met at 12,4 kB of 15 and 58,3 of 60;
- **the footer with `SUPPORT_URL` set**, because it is empty on `dev` and an
  absent link there proves nothing: five links, the last being "Bjud på en öl"
  to `https://buymeacoffee.com/lundstream`, and the operator sentence naming
  Lundstream rather than describing itself;
- **360 px and desktop**, full page, `scrollWidth` equal to `clientWidth`.

**Also seen in the sweep's own images**, which is where the three defects came
from in the first place: Översikt reads **"↓ 4,7 kg på 90 dagar"** at one
decimal, its trend weight is "86,9" with a smaller Sten "kg", and Mat's saved
favourite carries **"≈ uppskattning"** in lowercase.

**Exercised through the interface on 2026-09-17**, the rebuilt landing page
(D173), against the **production build** served by `vite preview` rather than a
development server:

- **The hero sequence, sampled over time** rather than looked at: 14 of 30
  readings present at 0,9 s, all 30 by 2,3 s with the line at 69 % undrawn, the
  line complete by 3,5 s, the tagline fading in after it. That sampling is what
  found that **neither line ever drew**: the dash length was an undefined custom
  property, so `stroke-dasharray` computed to `none` and the finished frame
  looked exactly like the intended one;
- **the scroll-driven section**, measured at four scroll positions: the stroke
  offset moves 0,66 to 0,21 as the reader scrolls, so the trend really is drawn
  by the wheel. A mid-scroll shot with the line half drawn is the proof;
- **reduced motion**, emulated: captured 900 ms after load with the tagline at
  opacity 1, both lines drawn, the drift animation `none`, and every reveal
  already in place. The finished page at once, not a stripped one;
- **360 px and desktop**, full page, with `scrollWidth` equal to `clientWidth` at
  360;
- **Lighthouse at mobile settings**: performance 98, accessibility 100, zero
  layout shift. Accessibility was 95 until Sten was lightened for the public
  bundle, which is the contrast finding recorded above;
- **the three phone screenshots** were regenerated from the seeded demo account
  by `scripts/landing-shots.mjs`, and the share card by
  `scripts/share-image.mjs` from the owner's artwork.

**Exercised through the interface on 2026-09-16 and 17**, at 360 px and desktop,
on the development server, driven through Chrome over CDP:

- **The restore check on Administration, Backup** (D168), against the API image
  built from this tree and run with the development database and a host
  directory bound at `/backups`, because the workstation has no `pg_dump` and
  because that is the arrangement production will have. Migration
  `0031_restore_checks` applied on the way up (1 applied, 32 recorded), `id`
  inside the container is uid 1000 writing the bound directory, and the
  destination and a time were set **on the screen**. The scheduler then wrote
  `vikt-20260915T232635Z.dump.enc`, 336 112 bytes, on the host side of the
  mount, and the check it triggers read it back: **ok, 46 tables, 3 912 rows, 32
  migrations**, then the same from `docker exec … node dist/restore-check.js`,
  exit 0, and **zero** `vikt_restorecheck%` databases left behind. The screen
  reads "Senaste återställningstest: tisdag 15 september, gick att läsa in: 46
  tabeller, 3 912 rader", in Sten (`rgb(107, 123, 130)`), with no page overflow
  at 360 px;
- **Samband's rings** (D170) on `samband@example.test`: twelve weekly points,
  **eleven filled and one hollow**, the ring on the week the intake moved, the
  note naming the same 400 kcal the calc uses, and `scrollWidth` equal to
  `clientWidth` at 360 px. The pane's two scatter groups are visibly different
  marks: one `fill` set, one `fill="none"`;
- **The coach, live, in three tones on two accounts** (D171), through
  `coach-probe.ts` against `qwen3.6:27b` on the LAN: all six replies are in D155
  verbatim. The sheet's interpretation appears in **all six** (4, 1, 2, 5, 5 and
  5 marked sentences out of 10, 4, 5, 6, 8 and 7), against one of six before,
  and the new causal check refused exactly one sentence, of exactly the shape
  the prompt has forbidden since D155.

**One thing this pass did not exercise**, because it has no interface: the
release workflow's trigger change (D169). What it has instead is
`release-workflow.test.ts` over the committed file and the two runs it was
diagnosed from, `35031311942` (branch, failed) beside `35031311925` (tag, green).
The first real proof is the next release, and the runbook says so.

**Exercised through the interface on 2026-09-15 and 16**, at 360 px and desktop,
on the **development server**, not a production build. Driven through Edge over
CDP, with each screen's measurements written to a verdict file beside its
screenshots:

- **"Minst" on a partial day** (D55): the development account with two food rows
  added, one carrying protein, carbohydrate and fat and one carrying nothing.
  Översikt in both views and Mat: every partial figure "minst" in Sten
  (`#6B7B82`), the share on the line under it (39 % for the day, 41 % for the
  week), fibre "Inte än" with "Ingen mat du loggat i dag har uppgift om fiber."
  No overflow;
- **Search on Mat** (D165): "Yogghurt" showed the saved yoghurts, then "Söker
  vidare i livsmedelsdatabasen" in Sten with the list at eighteen rows, clearing
  at about 300 ms; "zzzqqqx" showed "Söker i livsmedelsdatabasen" and then
  "Inget hittat för ”zzzqqqx”." once the database had answered. The local
  "Söker" state was faster than the 60 ms sampling and was **not seen**;
- **Samband per week** (D166): `samband@example.test` with 12 weekly points, the
  dashed line drawn and maintenance measured at 2 514 kcal against the 2 500 the
  seeded body obeys; the development account with 11 whole weeks, 3 dropped, and
  no line because its maintenance is not measured. **Not "inte än"**, which the
  brief expected for that account;
- **The coach, live, in three tones on two accounts** (D155, addendum
  2026-09-16), through `coach-probe.ts` against `qwen3.6:27b`: the replies are in
  D155 verbatim, every sentence passed the guard, and the macro sentence the new
  rule asks for appeared in one of six.

**Exercised through the interface** the pass before, at 360 px and at 1280 px,
on the production build served by `vite preview`:

- the landing page, with one action and the sentence that replaced the second
  button;
- `/kod` with `REQUEST_ENABLED` on, and the same path returning **404** with it
  off;
- Framsteg with both lists folded and with both open;
- Mat on a past day, with a row expanded: the estimate marker on the collapsed
  line, the macros with "Inte än" where the entry carries no fibre, and the
  copy-forward action inside the disclosure;
- Nyheter with a formatted post: two heading levels, bold, a bullet list and a
  link, rendered as elements rather than as characters;
- Administration, Förfrågningar and Backup, the latter with the share fields
  shown and the test-connection button beside Spara;
- **A `<select>`, measured before and after the duplicates were removed**
  (D162), on Administration, Backup, at 360 px in both themes. The rendering
  **changed**, which is the finding: radius 6 px to 8 px, the dark surface from
  Natt to Skymning, padding 8 px to 10 px, size 16 px to 15 px, and the light
  theme's chevron from the dark grey `#6B7B82` to its own `#5c6b72`. Removing
  dead duplicates changes nothing; these were live;
- **Alcohol in the coach against a thick account** (D155 addendum), on a fixture
  with 44 standard drinks across 12 of 28 days and 11 in the last week: all
  three tones reached alcohol, every sentence passed the guard, and no
  suggestion named a target the person had not set. The first fixture had no
  meals and was re-seeded, because an empty food section leaves one fewer domain
  competing for room in a six sentence reply and makes the answer easier;
- **The coach on the whole picture, in all three tones** (D155), against the
  real model on the LAN: "Vad tror du om mitt upplägg, vad jag äter, hur
  viktnedgången ser ut? Något jag bör tänka på?" All three replies are in D155
  verbatim, every sentence passed the guard, and every suggestion is an option
  rather than an instruction, which is the thing the question was inviting. Food,
  movement and sleep are in all three on every roll; alcohol is reliably in the
  neutral tone and drops out of the two character tones, which is recorded as it
  is rather than re-rolled, because this account has two standard drinks in a
  month and none in the week. Two things the live run found and fixed: a **false
  refusal**, where a true sentence about what was logged was read as blame
  because the negation in a later clause counted, and every tone answering a
  broad question from the weight trend alone with the whole sheet in front of
  it. The turn costs 3 296 tokens against a `num_ctx` of 65 536, measured with
  `coach-size.ts` and recorded in `docs/measurements.md`;
- **The section swipe, with real touches in mobile emulation** (D154): 360 px,
  `Input.dispatchTouchEvent` rather than dispatched objects, so the browser's own
  hit testing decides where the touch lands. Forward and back both complete; a
  short slow drag springs back and leaves no transform behind; a drag from
  x = 8 does nothing while the **browser** goes back a history entry, which is
  the edge guard earning its place rather than a hypothesis about it; a drag
  starting on the trend line does nothing; a mostly downward drag does nothing;
  a tap in the bar runs the same 200 ms slide; and with `prefers-reduced-motion`
  emulated the section still changes and nothing moves. Mid-gesture shot at
  360 px: the page 132 px left, the vacated strip the page colour, the bar still
  marking the section not yet left. No horizontal overflow at rest;
- **A queued edit meeting a deleted reading, through two browsers** (D153):
  separate Edge profiles, because two tabs share an IndexedDB and would share
  the queue. 88,4 logged for 8 September through the calendar; the first browser
  put offline and the same day edited to 88,9, which queued as `weight-update`,
  pending; the second browser deleting that reading, leaving the day empty; the
  first brought back online and drained. One question, in the section and on the
  queued row alike, with "Släng den" and "Lägg till igen" and no retry anywhere.
  "Lägg till igen" left one reading at 88,9, the queue clean and the question
  gone, and the fixture was left as it was found. Shot at 360 px and desktop.
  The queued row also named itself: before this it read
  `queue.kind.weight-update`, its own lookup key, because two kinds had been
  added with their endpoints and never with their strings;
- **The scrim and the sheet's edge, in both themes** (D152): the milestone sheet
  opened at 360 px and desktop in dark and in light. Dark reports
  `rgba(15, 20, 24, 0.72)` with `blur(10px)`, light the same blur at `0.45`, and
  in both the focus sits on `#ms-label`, the first field, with no ring and no
  border on the panel. Before this pass the ring was on the panel itself, in Is,
  on a screen where Is means a raw reading. The reduced-transparency branch was
  emulated rather than read off the stylesheet: the blur goes to `none` and the
  opacity to `0.88` dark and `0.78` light, with `matchMedia` confirming the page
  agreed it was in that state;
- **The version footer and the source offer** (D151): Inställningar at 360 px and
  desktop showing "Version dev · 107321a" with all five links resolving, and
  /integritet carrying the AGPL offer in words with the repository linked. The
  API reports the same pair on `/api/health`, which is where the boot log's own
  first line gets it;
- **Editing 25 August through the calendar** (D150): 90,1 to 90,2 at 360 px and
  desktop, the server holding 90,2 afterwards and Inställningar reading "Allt är
  skickat" with no conflict and nothing queued. That is the defect's absence;
  before this pass the same edit produced "Samma dag från två enheter" and a
  queued row whose retry could not succeed;
- **A real same-day conflict, made the way one happens** (D150): the browser put
  offline, a reading logged for an empty 24 August through the calendar, another
  device writing that day while it waited, then the queue drained. One question
  with both readings and two buttons, the queued row carrying the same two rather
  than "Försök igen", and settling it with the waiting reading left one row at
  91,5;
- **Dagen's two new controls, against the development API** (D146): a walk
  logged, then its row tapped to load it back into the form beneath, the
  duration changed from 40 to 30 and saved — one row afterwards, not two, with
  the kcal figure recomputed by the server. The measurement delete armed under
  its own form and read "Ta bort?" before it would fire. Both at 360 px and
  desktop;
- **The trend line on a sparse account, before and after** (D144): a seeded
  account, `gles@example.test` in the **development** database with the
  `SEED_PASSWORD` password, weighing about once a week over ninety days. It
  exists because the development account weighs most mornings and the staircase
  is invisible at that cadence; delete it whenever. Shot at 360 px and
  desktop on either side of the change. Before, a staircase: flat for nine days
  and then a kilo in one step. After, a monotone curve through the reading
  dates, with the raw dots exactly where they were. The same fixture on the
  development account, which weighs most mornings, is unchanged, which is why
  this survived as long as it did;
- **The month calendar, against the same sparse account** (D145): "alla
  vägningar" under the readings list opens September with the thirteen logged
  days in Gran and today carrying its own ring without one, because nothing was
  weighed on it. Tapping the second of September opened the sheet on that day
  with 90,3 in the field, "Ändra vägningen" as the heading and "Ta bort" beside
  the save. October is not offered, because it has not happened. The calorie
  field's label follows the day: opening a past day said "Kalorier i dag" over a
  field that would have written today's figure onto it, which is fixed;
- **The three packaged products again, after the label rule** (D143 addendum):
  every one of them now puts the printed weight in `packageG` and leaves the
  amount empty. The meatball bag that offered 1 000 g at 2 173 kcal offers a
  named food and an empty field;
- **Photographing a meal, end to end against the real workstation** (D143): five
  photographs taken on the owner's phone, resized in the browser, posted to
  `qwen3-vl:8b` on the LAN and priced by the development database. The quick
  action was present because the boot check had sent the self-test image and
  recorded `{"model":"qwen3-vl:8b","sees":true}`; the waiting line, the proposal
  list and a row with no amount were shot at 360 px and desktop. Four things
  only the interface could show: the parse answered "not available" for every
  picture until the client learned to read Ollama's `thinking` field, the wait
  is 0.2 to 1.3 s warm rather than the probe's 10 to 20, a long food name pushed
  the estimate tag out of its truncating span, and the note field's placeholder
  rendered as a typed value. All four fixed. The hourly rate limit also fired
  for real at the twenty-first photograph, which is the first time it has been
  seen outside a test;
- **The VAPID key watch, against the development database**: the first run wrote
  the key down, the second said nothing, a run with a mispasted key reported one
  affected subscription and the warning naming it, and a run with the real key
  restored the record. Booting the API afterwards logged nothing about VAPID,
  which is the right amount to say when nothing has changed, and no subscription
  was touched at any point;
- **The coach on a bad week again, after the absence rule** (D140's second
  addendum), against the real model: every tone now puts the data first ("Inget
  intag är loggat under perioden"), none makes the person the subject of a
  missing figure, and nothing was refused. The tone selector reads Torr, Peppig
  and Saklig again, matching the theme row beside it;
- **A habit created with its reminder in one pass** (D142), at 360 px and at
  1280 px: the create sheet now carries the same reminder controls as the edit
  sheet, and the one it wrote produced a real notification through WNS,
  "Kom ihåg: Dricka vatten 11:25", on a browser that had subscribed in this
  session. The two stale endpoints from earlier sessions were removed first,
  because the first attempt proved nothing: the browser had never subscribed and
  the send went to endpoints nobody was listening on. After ticking the habit, a
  sweep inside the same window reported `considered: 2, sent: 0, skipped: 2`.
  Inställningar names the habit that reminds and points at Dagen;
- **The three tones on a bad week and on a question with a number in it**
  (D140's addendum), against the real model: a fixture account with a rising
  28-day trend, one turn per tone and three rolls of Peppig, none of which
  cheered, consoled or ignored the trend. "Borde jag sikta på 1 900 kcal om
  dagen?" was declined by all three without any of them repeating the figure, so
  no prescribing-phrase check was added: it would have been written against a
  failure that did not happen;
- **The Sunday sweep, against the development database and the real model**
  (D141), with the instant injected. A fixture account in `Pacific/Auckland` was
  seeded so the sweep could be exercised without writing reviews for anybody
  else: its Sunday evening is Sunday morning in Stockholm. Swept as of its
  Sunday 20:05, the sweep wrote one review in 2.8 s and one generation; swept
  again fifteen minutes later, inside the same window, it wrote nothing, made
  **no generation and three queries**, one of them the `weekly_reviews` lookup
  that answered the question. A week carrying three logged days produced
  `quiet: 1`, no row and no card. On Översikt the card appeared with the sweep's
  own text, "Läs hela" led to Coach where the review sits with the others, and
  "Tack, läst" removed it and it stayed removed after a reload, because the
  dismissal is a row rather than a browser preference;
- Coach at 360 px and at 1280 px with the tone selector, against the **real model
  on the LAN**: one turn per tone, every sentence of all three passing the guard,
  and the 800 kcal question asked again in each tone. None of them repeated the
  false claim about the app that D139 recorded, which is what the fact sheet was
  for. One live refusal, in the neutral tone, was the check being wrong rather
  than the model: it quoted the question's own figure back;
- Coach at 360 px and at 1280 px, against the **real model on the LAN**: the
  week's summary written from the account's own aggregates, four questions asked
  and answered, and the medical one answered by the app without the model being
  called. Every figure in every reply was one the context supplied. Two defects
  were found by looking at the screen rather than by a test: the conversation
  list reported zero messages for every row (a correlated subquery that counted
  nothing), and a sentence with two links in it had a space before each comma;
- Översikt at 360 px and at 1280 px with the review card above the trend figure,
  clamped to three lines, with "Läs hela" and "Tack, läst" and no accent colour;
- Dagen at 360 px and at 1280 px with a checklist of three, written through the
  screen rather than seeded: one habit added from the empty state's suggestions and
  two typed into the editor, one of them with an icon. All three ticked, one
  unticked and ticked again, and `GET /api/day` then reported the unticked one as
  `checked: false, answered: true` — a day answered rather than a day nobody was
  there for, which is what the streak reads differently. Streaks and ticks survived
  a reload. No horizontal overflow;
- Inställningar at 360 px with the two reminders: each one shows a weekday time
  and a weekend time side by side under its name, with the day labels above them.
  Driven through the controls rather than seeded — 07:00 typed into the weigh
  reminder's weekday field and 09:30 into its weekend field, 21:00 into the
  evening one's weekday field, and the evening weekend switch left off — and
  `GET /api/me` then reported exactly those four values in their own columns, with
  the screen showing them again after a reload. No horizontal overflow.

`shoot2.mjs` was then run across every screen at both widths: twenty screens,
forty shots, **no horizontal overflow on any of them and nothing blank**. The
photo sheet, the month calendar, Dagen's two new controls and the milestone
sheet were shot separately, because they need a real photograph, a disclosure
opened, a row logged or a sheet opened first, and none of that belongs in a
screenshot sweep.

**The verdict was taken separately from the pictures that time**, by a second
script, `overflow.mjs`: run in the background with stdout piped, `shoot2`
produced the forty files and none of the forty lines, and a sweep whose
assertion is lost proved nothing. The separate probe found **0 of 40 with
horizontal overflow, 0 blank, and `transform` empty on every one of them** —
that last being D154's containing-block rule checked on the real pages rather
than argued from the code.

**The reason given here for the lost output was wrong**, and is corrected in
D161. `shoot2.mjs` contained no `process.exit(0)`; the claim was written from a
plausible cause rather than from the file, and repeated into a commit message.
What replaced both scripts is a sweep that writes each verdict to `verdict.txt`
beside the screenshots as it goes and derives its exit code by reading that file
back, so the answer survives whatever happens to the pipe. `overflow.mjs` is
deleted: two scripts asking one question is how they come to disagree.

Measurements, and the conditions they were taken under, are in
`docs/measurements.md`. The landing page's tap figures are pinned to that file
by a test, so a fast path that changes without the page changing fails the
suite.

### Waiting on the owner: production has never taken a scheduled backup

Found on 2026-09-15 while putting the rollback dump on the host, and more
urgent than anything else in this file.

- `backup_settings` has **no row**: no destination and no schedule.
- `backup_runs` has **no rows**: not one backup has ever run, scheduled or by
  hand through the app.
- **The destination it was given could not have worked** (D168). The compose
  mounted a named volume at `/backups`, whose mountpoint belongs to root while
  the API runs as uid 1000, and the path configured in the app,
  `/var/backups/vikt`, was not mounted at all: a directory inside the container,
  also unwritable, and gone with the container. 1.2.0 replaces the volume with a
  required bind mount from the host, so a stack with nowhere to write **fails to
  deploy** instead of failing every night at three.
- The host had no `backup.sh`, no cron line and no systemd timer, which is
  correct since D103 moved scheduling into the app — but it means nothing else
  is covering for it. That stays deliberate (D168): the app's encrypted nightly
  run is the backup, `backup.sh` is the manual pre-deploy dump, and no cron line
  is installed.
- **`backup.sh` and `restore-check.sh` are on the host now** (D163), equal by
  sha256 to the repository, and runnable without a compose file. **They have no
  schedule.** Adding the cron line in INFRA.md, "Host-side scripts", gives a
  second, unencrypted nightly dump on the host; that is your call, as is the
  first run of either from `/srv/vikt/infra`, which this session's permission
  policy refused. `node scripts/host-scripts.mjs check` says where they stand.

The only backup of production that exists is the pre-1.1.0 dump taken by hand on
13 September, now at `/var/backups/vikt/releases/pre-1.1.0-62dde4f.dump` and
verified by restoring it.

**Three commands on the Docker host, then one screen.** The directory has to
exist and belong to uid 1000 before the stack starts:

```sh
sudo mkdir -p /var/backups/vikt/app
sudo chown 1000:1000 /var/backups/vikt/app
sudo chmod 700 /var/backups/vikt/app
```

Then set `BACKUP_HOST_DIR=/var/backups/vikt/app` in the stack's variables (1.2.0
refuses to deploy without it), and in **Administration, Backup** set the
destination to `/backups` and a time. That is still a decision about where every
user's data goes and who holds the `SECRET_KEY` that decrypts it, so it is
yours; what has changed is that the path now leads somewhere. Press "Kör nu"
once and check that a row appears under the runs. Within a month the screen will
also say whether that backup could be read back, and
`docker exec vikt-api-1 node dist/restore-check.js` answers it on demand.

The Portainer token exists (D158) and `node scripts/portainer.mjs check` works.
It authenticates as `admin (role 1)` rather than the standard user INFRA.md
recommends: fine for the runbook, more power than it needs.

### Before the next CI run

**MinIO comes from quay.io now**, pinned by digest like everything else (D138).
`minio/minio` on Docker Hub answers "pull access denied" as of 2026-09-11, and
Bitnami's image withdrew its `latest` tag before that. If that step fails again,
check whether the registry moved before reading the diff.

### For the graphic profile's next version

**It needs a landing page section.** The profile (v1.4) covers the app: colour
as information, the type scale, the logo and where the lockup goes. The landing
page is now a designed surface with rules of its own that live only in
`CLAUDE.md` §5 and D173, and the two documents should not disagree by silence.
What the next version should say:

- **the page's largest text is words, not a number.** Page 5 says the largest
  text on a screen is always a figure, and that is right inside the app and
  wrong on a page whose job is one sentence. The tagline is the exception;
- **Lingon on the page** is the trend drawing and the single primary action,
  which page 4 already carves out for the action and should extend to the
  drawing, because a trend line is what Lingon means;
- **motion**, which the profile does not mention at all: what may move, that it
  stops, and that the wordmark never does (D172);
- **the phone frames**, their tilt, and that it flattens;
- **Sten on dark surfaces**, below.

### Sten holds 4,5:1 now, in both themes (D175)

Was open for the owner to decide; decided and done. The profile's `#6B7B82`
measured **4,22 on Natt, 3,65 on Skymning and 3,22 on Dis**, and Sten is what
every meta line and every "inte än" is set in.

| | old | new |
|---|---|---|
| dark | `#6B7B82` | **`#85949A`** |
| light | `#5C6B72` | **`#55636A`** |

Both are the nearest value on the same hue that passes on every surface.
**Skymning was not the worst surface, Dis was**, so the obvious correction to
`#7A8B92` would have passed the card and still failed the field. The landing
page's private override from D173 is deleted, and `contrast.test.ts` computes
every body-text token against every surface in both themes from `tokens.css`.

**Profile v1.5 needs these two values**, together with the landing section
below.

## The guards, and what runs them

Every guard this project's documents name, the file that implements it, and the
CI step that runs it. A guard needs both to be on this list: one that exists but
nothing runs is not a guard, and a line here without a file is a claim.

The list was written by checking each one rather than by remembering it, after
"in CI the api suite runs with none skipped" turned out to be a sentence
somebody had read off a log with nothing behind it.

| What it holds | File | CI step |
|---|---|---|
| No duplicate selector in the stylesheet, because the last of equal specificity is the one in force (D162) | `.stylelintrc.json` | Lint |
| Nothing committed asks for or carries a credential, and the Portainer helper refuses rather than prompts (§7, D158) | `apps/api/test/secrets-hygiene.test.ts` | Test |
| Every variable the API reads reaches the api service, with the negative control derived rather than named (D147, D157) | `apps/api/test/stack-variables.test.ts` | Test |
| Lingon belongs to the trend line and the wordmark, and nothing else gets an accent it has not earned (§5) | `apps/web/test/colour-meaning.test.ts` | Test |
| No en or em dashes, no shouted words, no doubled spaces, in the register and in JSX (§5) | `apps/web/test/copy-style.test.ts` | Test |
| Every class name resolves, nothing shouts through CSS, and Honung is only used where something costs (§5) | `apps/web/test/class-names.test.ts` | Test |
| Every key the app asks for exists, and none is left behind unused | `apps/web/test/i18n.test.ts` | Test |
| The two navigation surfaces list the same places, and every signed-in route is reachable (D115) | `apps/web/test/render/navigation.test.tsx` | Test |
| The landing page's tap figures still match `docs/measurements.md` | `apps/web/test/landing-figures.test.ts` | Test |
| The correlation view computes no statistic, and its response carries none (D34) | `packages/shared/src/calc/correlate.test.ts`, `apps/api/test/correlations.test.ts` | Test |
| Services take `userId` first, so an unscoped read is a lint error rather than a leak (§3, D15) | `eslint-rules/user-id-first-param.js` | Lint |
| Derived data has one owner, so two paths cannot write the same number (D44) | `eslint-rules/derived-data-owner.js` | Lint |
| No test is skipped or left as a todo outside one named file (§7) | `scripts/check-skips.mjs` | No skipped tests |
| No `__PLACEHOLDER__` survives into the built bundles (D98) | `apps/web/scripts/check-placeholders.mjs` | Check the build for unsubstituted placeholders |
| Every package typechecks under `strict` | `tsconfig.json` per package | Typecheck |
| The coach never makes a person the subject of a missing figure (D140) | `apps/api/src/llm/coach-guard.ts`, `apps/api/test/coach.test.ts` | Test |
| Only 404 and 410 remove a push subscription; 403 and transient failures keep it (D136) | `apps/api/src/lib/push.ts`, `apps/api/test/push-removal.test.ts` | Test |
| A changed VAPID pair is noticed at boot and warned about, not acted on (D136) | `apps/api/src/lib/vapid-watch.ts`, `apps/api/test/vapid-watch.test.ts` | Test |
| A photographed meal is never written to disk, to a table, to a log line or to the queue (D143) | `apps/api/test/photo-transport.test.ts`, `apps/web/test/render/photo-entry.test.tsx` | Test |
| An amount from a photograph is a number the app can price, or it is null (D143) | `apps/api/src/services/llm.service.ts`, `apps/api/test/photo-parse.test.ts` | Test |
| The photo surface exists only where a model has been shown to see (D143) | `apps/api/src/lib/vision-watch.ts`, `apps/api/test/vision-watch.test.ts`, `apps/web/test/render/food-ways.test.tsx` | Test |
| A weight printed on a package is never an amount (D143, amended) | `apps/api/src/services/llm.service.ts`, `apps/api/test/photo-parse.test.ts` | Test |
| The chart's trend vertices are the calc's own values, one per reading (D144) | `apps/web/src/lib/trend-series.ts`, `apps/web/test/trend-series.test.ts` | Test |
| The Portainer stack pins a version rather than `latest`, and both images move together (D148) | `infra/docker-compose.portainer.yml`, `apps/api/test/stack-variables.test.ts` | Test |
| Every variable the API's env schema knows is forwarded by the Portainer compose and documented in .env.example (D147) | `apps/api/test/stack-variables.test.ts` | Test |
| The version the config path reports is the one the build argument set (D151) | `apps/api/src/lib/build-info.ts`, `apps/api/test/build-info.test.ts` | Test |
| An edit is an update to its row, and only two creates for one day are a same-day conflict (D150) | `apps/api/test/weight-update.test.ts`, `apps/web/test/weight-edit-queue.test.ts` | Test |
| Every user-created row has an edit and a delete on the screen that shows it (D56, D146) | `apps/api/test/daily.test.ts`, `apps/web/test/render/day-edit-remove.test.tsx` | Test |
| Every reading is reachable and editable, not the last five (D145) | `apps/web/src/components/MonthCalendar.tsx`, `apps/web/test/render/weight-calendar.test.tsx`, `apps/web/test/month-calendar.test.ts` | Test |

**Removed from the list rather than footnoted:** nothing this pass. The one
entry that would have been removed is the guard STATE.md used to claim about
skipped tests, which did not exist; it is on the list now because it does.

## Known gotchas carried into this project

**A Docker Hub tag is not a stable reference.** It is a name the publisher can
repoint or withdraw, and this project lost two images to that in one week, both
surfacing as a red build on a branch that had touched no infrastructure. Every
third-party image here is pinned by digest (D138), and a digest changes only in
a commit that says so, after the new image has been pulled and started locally.
`docker buildx imagetools inspect <image>:<tag>` prints the index digest to pin.

The long list lives at the bottom of `DECISIONS.md` where each one has its
reasoning. The three that catch people most often:

- **`useTestApp` registers Vitest hooks, so it must run at file level.** Calling
  it inside a test registers hooks that never run.
- **Secure-context APIs do not exist over http on a LAN IP.** Three times now:
  `crypto.randomUUID`, the camera, and `BarcodeDetector`. See
  `docs/secure-context.md`.
- **Measuring page-load performance on the dev server measures the dev server.**
