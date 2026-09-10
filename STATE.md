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
| `CONTACT_EMAIL` | Adressen `/integritet` namnger som personuppgiftsansvarig. Bygget lämnar `__CONTACT_EMAIL__` i `index.html` och `32-site-config.sh` fyller i den vid start (D121). | **Ja** när `LANDING_ENABLED` eller `REQUEST_ENABLED` är `true`. API:t vägrar starta utan den i produktion. |
| `OPERATOR` | Vem som driver installationen, i sidfoten och på `/integritet`. | Nej, men sidan blir vagare utan. |
| `REPO_URL` | Vart GitHub-länken pekar. | Nej, har ett förval. |
| `SUPPORT_URL` | Länken "Bjud på en öl". Tom betyder att länken utgår helt. | Nej. |
| `REQUEST_ENABLED` | Serverar formuläret för kodförfrågan på `/kod` och registrerar endpointen det skickar till. Av betyder 404 på båda (D127). | Nej, förvalet är `false`. |

**Sätt dem innan avbilden som läser dem rullar ut.** En variabel den nuvarande
avbilden inte känner till ignoreras, så det finns inget fönster där något går sönder
av att de sätts för tidigt. Omvänd ordning ger en publik sida som visar
`__CONTACT_EMAIL__`.

### Migrationer som kommer att köras

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

## On `dev`, not yet on `main`

Production deploys from `main` (CLAUDE.md §7), so this list is the difference
between what is built and what is running. 17 commits:

| | |
|---|---|
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

**Blocked, not skipped:** removing the probe request
`human-check-probe@example.test` needs the production database, and the
Portainer password was rotated after the deployment pass. It is under
Administration, Förfrågningar, Besvarade, "Ta bort".

## Verified

**1312 tests**: 478 shared, 239 web, 595 api. Lint clean, all three packages
typecheck, both bundles build, and the placeholder guard passes.

The API suite is also run with `SECRET_KEY` unset, which is what CI has. That is
not a nicety: three of this pass's tests passed on the workstation and failed in
CI, because saving a share password is refused where there is no key to store it
under, and the workstation's `.env` had one. They supply their own key now.

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
  shown and the test-connection button beside Spara.

No horizontal overflow on any of the eighteen shots, and nothing blank.

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
