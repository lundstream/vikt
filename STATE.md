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

## Inför nästa deploy

**The deploy is a runbook, and it is in `INFRA.md` under "Deploying a version, in
order".** Nine steps now, starting at **step 0: make `v1.0` a rollback target
that exists**. Then back up and prove the backup restores, set every new
variable, merge and cut the version, wait for `release`, pin `IMAGE_TAG` and
redeploy, read the named lines out of the API log, check it from a phone on
mobile data, and roll back by editing one line.

**The build running in production is `v1.0`, and the next deploy is `v1.1.0`.**
That build was never tagged when it shipped, which meant the compose could pin a
version the registry had never heard of: the images were `docker load`ed onto
the host and have never been in GHCR at all. Step 0 gives them a name in git and
in the registry and then pulls the tag back, because a rollback that has not
been pulled once is a sentence rather than a plan.

**Two findings from writing it**, both of which would have surfaced at the worst
moment: the GHCR packages are still **private** although the repository is
public, so the stack would fail at the pull; and `d11c2fe` is a commit in
`vikt-old`, not in this repository, so the git tag had to go there. The tag is
made.

It lives there rather than here because it is about **this installation** and
this file is public (D119). What stays here is the one thing that has to be
pasted into the app rather than typed at a host.

**Every pass on `dev` still appends to this section**, and nothing merges to
`main` until it has been read. Anything operational that a pass discovers goes
into the runbook; anything a user will see goes into the news post below.

### Till Nyheter

**Färdig text, klistra in som den är** under Administration, Meddelanden. Den
täcker allt som syns sedan den version som körs i produktion i dag. Inga tankstreck
(§5), och registret är appens eget: du, inte "användaren".

<details>
<summary>Nyhetstexten</summary>

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

Hela Coach finns bara om AI-lagret är påslaget på den här installationen.

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

Backupen skrivs numera till en katalog eller till en S3-hink, och hemligheten lagras
krypterat. Knappen "Testa anslutningen" skriver en liten fil och tar bort den igen,
så att du ser att det fungerar innan nattens körning.
```

</details>

## On `dev`, not yet on `main`

Production deploys from `main` (CLAUDE.md §7), so this list is the difference
between what is built and what is running. 61 commits, plus the one this
pass is about to add:

| | |
|---|---|
| `a1343b8` | A weight printed on a label is not an amount |
| `591e57d` | Every reading is reachable, through a month rather than a longer list |
| `f804643` | The trend line is a curve between readings, not a staircase |
| `05ad7c1` | STATE: the screenshot sweep this pass, and what it covered |
| `c5a722b` | Photo logging, item 6: the record |
| `10fddf1` | Photo logging, item 7: what the interface found, and three fixes it caused |
| `2283468` | Photo logging, item 5: the probe is a maintained script, and what a photo costs |
| `41438b9` | Photo logging, item 4: the surface, and proving the model can see |
| `c277d0a` | Photo logging, item 3: one proposal list, and a row that cannot be saved |
| `4142b7c` | Photo logging, item 2: what a photograph is allowed to say |
| `1172842` | Photo logging, item 1: the picture goes and does not stay |
| `0a970b0` | A model does see a plate, and it is qwen3-vl:8b |
| `225918e` | Probe whether any model here can actually see, before building on it |
| `2125306` | Notice at boot that the VAPID pair changed |
| `1faaab0` | 403 keeps the push subscription, because the fault is usually ours |
| `2af8dd7` | Record the pass: the skip guard's own line, and what is on dev |
| `6da0adf` | Sentence case for option buttons, and why two dead push rows survived |
| `9cb04bf` | Absent data has the data as its subject, in every tone |
| `c35da79` | A guard for skipped tests, and an inventory of the rest |
| `3011e79` | Record the pass: what CI ran and what is on dev |
| `d70794b` | Peppig on a bad week, the nine CI only tests, and lowercase tone labels |
| `6e78363` | Exercise the Sunday sweep, and make a written week cost one lookup |
| `ee4e696` | One habit, one form: the reminder is offered where the habit is made |
| `44b708a` | Record the tone pass: what CI ran and what is on dev |
| `3239a2e` | Three coach tones, the Sunday job, and two limits said out loud |
| `48a33d1` | Record the coach pass: what CI ran and what is on dev |
| `a511cb9` | Coach chat, phase 8b |
| `da310ea` | Pin every third-party image by digest |
| `feba0d0` | Record the weekend pass: what CI ran and where MinIO lives now |
| `efe56a1` | Pull MinIO from quay.io, since Docker Hub now refuses it |
| `8528155` | The habit checklist, the second half of Phase 11 |
| `5964645` | Each reminder gets a weekday time and a weekend one |
| `2900709` | Reminders: the push foundation and the two that pay for it |
| `e575b51` | Entry points on Mat become quick actions, and the guard learns the third way |
| `8fbe283` | Record the pass: S3, three button tiers, and what CI now proves |
| `7c3d682` | Give the S3 run tests a database pg_dump can reach |
| `ca8c17d` | Three button tiers, and the outline one is not among them |
| `e791bca` | Start MinIO as a step, not a service container |
| `00d2f8e` | Back up to S3, and reach a Windows share by mounting it on the host |
| `4426cf1` | A backup destination can no longer take the API down |
| `5876ea8` | Graphic profile v1.3 supersedes v1.2 |
| `f02717d` | Correct the deploy handover |
| `428429a` | Verify the pass through the interface, and fix what that turned up |
| `ffb4176` | Back up to an SMB share, by speaking it rather than mounting it |
| `72cd0c0` | Tell the admin a request arrived, and let them turn that off |
| `db1f18d` | Announcements take a small Markdown subset, parsed not sanitised |
| `37b85c8` | Asking for a code becomes its own deployment mode, at /kod |
| `a601b3a` | Framsteg leads with the figures and folds the setup away |
| `8a80a78` | Enable react-hooks lint rules, and fix what they found |
| `b6cb9bd` | Record items 1 and 2, and what the brief still has open |
| `1b4806d` | A logged row opens onto its macros, amount and source |
| `ea18cc5` | Copy a past day's food forward to today |
| `443f3ac` | Restart dev when needed, and hand the deploy over in writing |
| `200ae48` | Record what is on dev and not on main |
| `0f823e0` | One primary, one secondary, and Honung for what costs something |
| `b83a1d9` | Write the reminder design into Phase 11, and bounce handling into the backlog |
| `e864f6a` | Say why a macro mean is withheld, and dismiss the search on a pick |
| `25a173f` | The weight axis is a ruler again, and holds every reading |
| `36d6f9a` | Work happens on dev; main receives merges only |

**Merging is a deploy**, and "Inför nästa deploy" above is the handover. `main`
takes these through a pull request when the owner decides to update production,
not when the suite goes green.

### Before the next redeploy

`tailwind.config.js` changed, adding the `on-reward` colour. Tailwind resolves
its config at boot, so a development server that has been up since before that
commit serves the old one and reports `text-on-reward` as a class that does not
exist. §7 now carries the rule, including that `pkill -f vite` does nothing on
Windows and the kill has to be by port.

## Still open from the briefs

**Finished on `dev` this pass.** Each was a numbered item and each is whole:

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

**Waiting on the owner, for the camera half of photo logging (D143):**

The whole path is exercised and recorded above — the resize, the post, the
model, the proposal list — but through a browser handed a file, because that is
what a desktop can do. The one thing it cannot show is
`capture="environment"`: the attribute that tells a phone to open the **camera**
rather than the gallery. Open Mat on the phone, press Fotografera maten, and say
whether the camera opens straight away. If it opens the picture gallery instead,
that is the finding and it is a one-line change.

**Blocked, not skipped:****Blocked, not skipped:** removing the probe request
`human-check-probe@example.test` needs the production database, and the
Portainer password was rotated after the deployment pass. It is under
Administration, Förfrågningar, Besvarade, "Ta bort".

## Verified

**1713 tests**: 494 shared, 321 web, 898 api. **Nine more run in CI**, and they
are the same nine every time: the S3 destination's live suite in
`backup-s3-live.test.ts`, which needs a real S3 server and `pg_dump`. CI starts
MinIO and sets `S3_TEST_ENDPOINT`; a workstation has neither, so they skip here
and the run says so in a line naming them. The file also asserts that where the
endpoint *is* configured nothing is half-skipped, so a CI box that lost
`pg_dump` fails rather than quietly covering less (§7). Lint clean, all three packages
typecheck, both bundles build, and the placeholder guard passes.

**In CI the api suite runs 730 with none skipped**, and that is now checked
rather than read: `pnpm test:skips` reported "1493 tests reported, none skipped
outside the allowlist (the live S3 suite ran)" on this commit, which is the number that
matters: the nine S3 tests execute against a real MinIO with default settings
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

**Exercised through the interface**, at 360 px and at 1280 px, on the production
build served by `vite preview`:

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
- **The scrim and the sheet's edge, in both themes** (D152): the milestone sheet
  opened at 360 px and desktop in dark and in light. Dark reports
  `rgba(15, 20, 24, 0.72)` with `blur(10px)`, light the same blur at `0.45`, and
  in both the focus sits on `#ms-label`, the first field, with no ring and no
  border on the panel. Before this pass the ring was on the panel itself, in Is,
  on a screen where Is means a raw reading;
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
photo sheet, the month calendar and Dagen's two new controls were shot
separately, because they need a real photograph, a disclosure opened or a row
logged first, and none of that belongs in a screenshot sweep.

Measurements, and the conditions they were taken under, are in
`docs/measurements.md`. The landing page's tap figures are pinned to that file
by a test, so a fast path that changes without the page changing fails the
suite.

### Before the next CI run

**MinIO comes from quay.io now**, pinned by digest like everything else (D138).
`minio/minio` on Docker Hub answers "pull access denied" as of 2026-09-11, and
Bitnami's image withdrew its `latest` tag before that. If that step fails again,
check whether the registry moved before reading the diff.

## The guards, and what runs them

Every guard this project's documents name, the file that implements it, and the
CI step that runs it. A guard needs both to be on this list: one that exists but
nothing runs is not a guard, and a line here without a file is a claim.

The list was written by checking each one rather than by remembering it, after
"in CI the api suite runs with none skipped" turned out to be a sentence
somebody had read off a log with nothing behind it.

| What it holds | File | CI step |
|---|---|---|
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
