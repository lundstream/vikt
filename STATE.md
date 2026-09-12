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

**Every pass on `dev` appends to this list, and nothing merges to `main` until it has
been read.** `main` is what production deploys from, so this is the handover: the four
things that do not travel in a git diff and cannot be inferred from one.

Cleared back to empty when a merge ships, not before.

### Nya miljövariabler

| Variabel | Vad den gör | Krävs? |
|---|---|---|
| `CONTACT_EMAIL` | Adressen `/integritet` namnger som personuppgiftsansvarig. Bygget lämnar `__CONTACT_EMAIL__` i `index.html` och `32-site-config.sh` fyller i den vid start (D121). | **Ja** när `LANDING_ENABLED` eller `REQUEST_ENABLED` är `true`. API:t vägrar starta utan den i produktion. |
| `OPERATOR` | Vem som driver installationen, i sidfoten och på `/integritet`. | Nej, men sidan blir vagare utan. |
| `REPO_URL` | Vart GitHub-länken pekar. | Nej, har ett förval. |
| `SUPPORT_URL` | Länken "Bjud på en öl". Tom betyder att länken utgår helt. | Nej. |
| `VAPID_PUBLIC_KEY` | Publik nyckel för push. Lämnas den tom finns påminnelserna inte alls: inget schemaläggs, ingen endpoint registreras och avsnittet i Inställningar ritas inte (D136). | Nej, men utan den finns inga påminnelser. |
| `VAPID_PRIVATE_KEY` | Privat nyckel för push. Hemlig som `SECRET_KEY`. API:t vägrar starta om bara den ena av nycklarna är satt. | Bara om push ska vara på. |
| `VAPID_SUBJECT` | `mailto:`-adress eller URL som push-tjänsten kontaktar om servern missköter sig. Krävs av specen. | Ja, om nycklarna är satta. |
| `REQUEST_ENABLED` | Serverar formuläret för kodförfrågan på `/kod` och registrerar endpointen det skickar till. Av betyder 404 på båda (D127). | Nej, förvalet är `false`. |

**Sätt dem innan avbilden som läser dem rullar ut.** En variabel den nuvarande
avbilden inte känner till ignoreras, så det finns inget fönster där något går sönder
av att de sätts för tidigt. Omvänd ordning ger en publik sida som visar
`__CONTACT_EMAIL__`.

### Migrationer som kommer att köras

`0024_push` lägger till tabellerna `push_subscriptions` och `reminder_sends` samt
fyra kolumner på `profiles` för de två påminnelserna. Additiv.

Inga nya migrationer i den här passagen utöver de nedan.

`0028_coach_tone` lägger till kolumnen `coach_tone` på `profiles`, med `torr` som
standard. Additiv, och standardvärdet är den röst som redan fanns.

`0027_coach` lägger till tabellerna `coach_conversations` och `coach_messages`,
samt kolumnen `dismissed_at` på `weekly_reviews`. Additiv. Samtalen kaskaderar
med kontot.

`0026_habits` lägger till tabellerna `habits` och `habit_checks`. Vanorna är
användarens egna ord, en rad per vana och dag, och båda tabellerna kaskaderar med
kontot. Additiv.

`0025_reminder_weekend` lägger till fyra kolumner till på `profiles`: en egen
på-knapp och en egen tid för helgen, per påminnelse. De fyra som redan fanns behåller
sina namn och är nu vardagstiderna. Migrationen kopierar vardagsvärdena till
helgkolumnerna, så ett konto som hade 07:00 alla dagar har kvar 07:00 alla dagar
tills någon ändrar det. Additiv.

`0022_backup_smb` lägger till `smb_host`, `smb_share` och `smb_domain` på
`backup_settings`, och `0023_backup_s3` tar bort dem igen och lägger till
`s3_endpoint`, `s3_region`, `s3_bucket` och `s3_path_style`. Båda körs vid start.

**Att 0023 tar bort kolumner är ett medvetet undantag** från regeln att
migrationer bara lägger till. Det är ofarligt just här och bara här: 0022 har
aldrig körts utanför utveckling, `main` har aldrig burit den, så ingen
produktionsdatabas har kolumnerna och ingen har ett värde i dem. Produktionen
lägger till tre kolumner och tar bort dem igen i samma uppstart.

`0021_request_mail` lägger till kolumnen `request_mail` på `profiles`, med
`DEFAULT true`. Den är additiv och körs av API-containerns entrypoint vid start,
som alla andra. Ingen befintlig rad ändras, och en avbild som inte känner till
kolumnen bryr sig inte om att den finns.

### Manuella steg på Portainer-värden

- Sätt variablerna ovan i stacken `vikt` innan avbilden byts.
- **Generera VAPID-nycklar en gång per installation** med `pnpm --filter api vapid`
  och lägg dem i stackens miljö. Byts paret senare slutar alla befintliga
  prenumerationer fungera, tyst, så gör det en gång. Utan nycklar finns
  påminnelserna inte, och det är ett giltigt läge.
- **Påminnelserna kräver en enda API-instans**, precis som mejlkön (D104). Två
  processer sveper två gånger. Dubbla notiser går inte att få, det förhindrar
  unikindexet, men arbetet görs två gånger.
- **Backupmålet är nu antingen en katalog eller en S3-hink.** Att skriva till en
  Windows-utdelning direkt finns inte längre: biblioteken talar NTLMv1 som dagens
  servrar nekar (D132, D133). Vill du använda NAS:en, montera utdelningen på värden
  och bind-montera katalogen in i api-containern, se README. Vill du använda S3,
  eller NAS:ens egen S3-tjänst, fyll i adress, hink, nyckel och hemlighet under
  Administration, Backup och tryck "Testa anslutningen" innan du litar på schemat.
- **`REQUEST_ENABLED` behöver inte sättas.** Utan den är formuläret borta, vilket är
  det avsedda läget. Sätt den till `true` bara om du vill kunna skicka adressen
  `/kod` till någon. Ingenting länkar dit.
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
- Tryck på en loggad rad i Mat för att se protein, kolhydrater, fett och fiber för
  just den raden, hur mycket det var och varifrån siffrorna kommer. Ändra, ta bort
  och "Logga i dag" ligger numera där, i den öppnade raden.
- Framsteg är omstuvad: potten och nykterhetsräknaren ligger ovanför listorna, och
  milstolpar och sparregler är hopfällda med antal bredvid rubriken. Tryck för att
  fälla ut. "Lägg till milstolpe" och "Ny sparregel" öppnar ett formulär i ett eget
  fönster i stället för att stå framme hela tiden.
- Formuläret för att be om en inbjudningskod ligger inte längre på startsidan. Det
  har flyttat till en egen adress som inget länkar till, och den är avstängd om
  inte den som driftar servern slår på den. Startsidan säger i stället att appen
  kräver en inbjudan och att den som vill kan köra en egen kopia.
- Nyheter kan nu innehålla rubriker, fetstil, punktlistor, numrerade listor och
  länkar. Det gäller både i appen och i mejlet. Den som skriver ett meddelande ser
  hur det kommer att se ut innan det sparas.
- Den som administrerar får ett mejl när någon ber om en inbjudningskod, och en prick
  vid Administration så länge något väntar på svar. Mejlet kan stängas av under
  Inställningar. Pricken och listan finns kvar oavsett.
- Backupen kan skrivas direkt till en Windows-utdelning. Server, utdelning, mapp,
  användarnamn och lösenord ställs in under Administration, Backup, och lösenordet
  lagras krypterat. Knappen "Testa anslutningen" skriver en liten fil och tar bort
  den igen, så att man ser att det fungerar innan nattens körning.
- Backupen skrivs till en S3-hink i stället för till en Windows-utdelning. Adress,
  hink, mapp, nyckel och hemlighet ställs in under Administration, Backup, och
  hemligheten lagras krypterat. Fungerar mot AWS, Backblaze, MinIO och de flesta
  NAS-lådors egen S3-tjänst.
- Knapparna har tre former i stället för fyra. Allt som gör något är en fylld knapp,
  allt som bara tar dig därifrån (Avbryt, Tillbaka) är en textlänk, och det som
  kostar något är fortfarande Honung. Den tunna konturknappen är borta.
- På Mat ligger Skanna, Skriv in själv, Skriv vad du åt och Vad kan jag laga nu på en
  rad, som runda snabbval med etikett under, i stället för som knappar utspridda på
  sidan. De två som behöver en språkmodell försvinner som förut när den är avstängd.
- Coachen har tre tonlägen som du väljer under Coach: Torr, Peppig och Saklig.
  Valet gäller både veckans sammanfattning och chatten. Saklig har ingen
  personlighet alls och heter då bara Coachen.
- Veckans sammanfattning skrivs numera av sig själv på söndagskvällen, klockan
  20:00 i din egen tidszon. Har veckan färre än fyra loggade dagar skrivs ingen
  alls, och då dyker inget kort upp på Översikt heller.
- Under Mer finns Coach: en sida där Bengt sammanfattar veckan och svarar på frågor
  om hur det går. Han utgår bara från dina egna siffror, hittar aldrig på några nya
  och ändrar ingenting: loggar och planer sköter du själv. Svaret skrivs ut medan
  det blir till.
- Är veckans sammanfattning ny visas den överst på Översikt, en gång, med "Läs hela"
  till Coach. Trycker du "Tack, läst" försvinner den på alla dina enheter.
- Samtalen sparas på ditt konto, visas bara för dig och används inte till något
  annat. Du kan ta bort ett samtal i taget eller allihop, och de följer med i
  exporten.
- Frågor om medicin, sjukdom och graviditet svarar han inte på, utan hänvisar till
  vården i en mening.
- Hela Coach finns bara om AI-lagret är påslaget på den här installationen.
- Dagen har en egen checklista. Skriv in det du vill göra varje dag, med eller utan
  ikon, och bocka av med ett tryck. Ett tryck till tar bort bocken. Under varje vana
  står hur många dagar i rad du har den, och en dag du inte fyllde i listan alls
  räknas som okänd i stället för som missad.
- Varje vana kan ha en egen påminnelse, och den sätter du direkt när du skapar
  vanan: samma tider för vardag och helg som de andra påminnelserna, avstängda tills
  du slår på dem. Den hoppas över om du redan bockat av vanan den dagen, och under
  Inställningar, Påminnelser står vilka vanor som har en.
- Tar du bort en vana får du välja: behåll dagarna du redan bockat av, eller ta bort
  dem också. Vad som händer står innan du bekräftar.
- Två påminnelser går att slå på under Inställningar: en på morgonen om att väga sig
  och en på kvällen om att fylla i dagen. Var och en har en tid för vardagar och en för
  helgen, med var sin knapp, så morgonpåminnelsen kan vara 07:00 i veckan och 09:00 på
  lördag och söndag, eller avstängd då. Alla fyra är avstängda tills du slår på dem.
  Vilka dagar som är helg räknas i din egen tidszon. Morgonens hoppas över om du redan vägt dig,
  kvällens om dagen redan är ifylld. Push fungerar i webbläsaren på Android och på
  iPhone bara när appen är installerad på hemskärmen, vilket står bredvid knappen.

## On `dev`, not yet on `main`

Production deploys from `main` (CLAUDE.md §7), so this list is the difference
between what is built and what is running. 43 commits, plus the one this
pass is about to add:

| | |
|---|---|
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

**Blocked, not skipped:****Blocked, not skipped:** removing the probe request
`human-check-probe@example.test` needs the production database, and the
Portainer password was rotated after the deployment pass. It is under
Administration, Förfrågningar, Besvarade, "Ta bort".

## Verified

**1477 tests**: 494 shared, 269 web, 714 api. **Nine more run in CI**, and they
are the same nine every time: the S3 destination's live suite in
`backup-s3-live.test.ts`, which needs a real S3 server and `pg_dump`. CI starts
MinIO and sets `S3_TEST_ENDPOINT`; a workstation has neither, so they skip here
and the run says so in a line naming them. The file also asserts that where the
endpoint *is* configured nothing is half-skipped, so a CI box that lost
`pg_dump` fails rather than quietly covering less (§7). Lint clean, all three packages
typecheck, both bundles build, and the placeholder guard passes.

**In CI the api suite runs 723 with none skipped**, and that is now checked
rather than read: `pnpm test:skips` reported "1486 tests reported, none skipped
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

No horizontal overflow on any of the eighteen shots, and nothing blank.

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
| A rejected push subscription is removed and a transient failure is not (D136) | `apps/api/src/lib/push.ts`, `apps/api/test/push-removal.test.ts` | Test |

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
