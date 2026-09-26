# Session report, 2026-09-26: the matcher refined, and 1.4.0 in production

All four items are done. **Production runs 1.4.0** from `c6b435f`, tagged `v1.4.0`, with all thirteen steps passing. It was released only after the gate you wrote passed on every line and CI was green for that exact commit.

## 1. Two rules (`b6ea9a6`)

- **§7: watching a test fail never reaches a real host.** A check run against old code to see it fail runs with the network cut, or with every address pointing at a documentation range.
- **The `edge` exception is scoped.** It applies only to the two compose files and DECISIONS.md, where D14 lives. I scoped the test first, and it failed on every other mention:
  - two error messages in the API
  - the trust-proxy and client-ip tests
  - `infra/.env.example`
  - CLAUDE.md
  - the previous session's report

  The messages and `.env.example` now say "the `edge` subnet" and where it is pinned. The tests use `198.51.100.0/24`, with the untrusted peer at `203.0.113.7`. CLAUDE.md and the old report name the subnet without its number. A unit test holds the scope itself, and D197 records your decision.

## 2. The matcher, refined (`978945f`, D198)

**(a) Parts of a food.** In "basilikablad", "vitlöksklyftor" and "kycklingbröst" the first half is the food, and the part is a qualifier.
- A row that names the part is preferred. Only when no candidate does is the food alone taken, and `matchStrength` then says "part".
- **The part list was counted from the catalogue and the two photos:** filé, bog, bitar, bröstfilé, kotlett, lägg, blad, lår, skiva, vinge, klubba, klyfta.
- **Left out:** skin, bone and the organs. "tärning" and "pulver" are excluded from both parts and split halves, because they change what the food is. So "köttbuljongtärning" stays unmatched.
- **A compound written apart matches only with every half as a separate word.** The search can't see "nötfärs" inside "Nöt färs", so when nothing matches fully, `matchRow` also searches the split forms.
- **Your four checks against the catalogue:**
  - nötfärs → "Nöt färs rå fett 10%"
  - fetaost → no match: only dishes
  - parmesan → no match: the row is led by "Ost"
  - salladblad → no match: every "Sallad …" row is a dish

**(b) No varieties among qualifiers.** I went through the list word by word and took out:
- veg., fullkorn, smaksatt, kryddad
- the sweetening words
- the free-from variants
- provenance (hemlagad, restaurang, storhushåll)
- texture that names a kind (grovt, fylld and similar)
- blandad, mild, söt
- the marker "typ"

Kept, with the reason:
- fat, salt and alcohol levels, as measures
- "naturell" and "osötad", as the plain food
- colour

**One addition you didn't ask for, needed for "Pizza":** with "veg." gone, "Pizza" landed on "Pizza m. ost restaurang", because D72 reads only the head before "m.". I counted what the catalogue puts after " m. ": preparation media (salt 111, skinn 19, vatten 15, lag 11, olja 12, skal 6) or foods (mjölk 20, frukt 17, ost 11, köttfärs 9). So the tail must now describe the food too: qualifiers, those media, and "jod". "Kyckling kokt m. salt", "Tomat krossad konserv. m. lag" and "Salt m. jod" still match; "Pizza m. ost restaurang" and D72's own "Kyckling med curry" don't. That old test now expects the curry refused, and says why.

**(c) One answer per person.** Among the rows the rule accepts: the food this person has logged most, then the search's ranking, then a total order. The search query now ends with Livsmedelsverket first, then id. History never makes a refused row plausible.

**Tests:**
- Three of the six new pair tests fail on the ff55a74 rule. The other three are guards, which both rules pass.
- The history test fails with the history step removed, and the split test fails with the split search removed.
- Each was seen failing first.

### The table

All three columns read the same search, now in a total order, as a user with no history and no foods of their own. This rule was run three times, and every query gave the same food each time. A few rows in the older columns differ from the table you reviewed because of that setup, not because of any rule: "Ost" 354, "Präst" 277, "ägg" "Ägg kokt", and "kebabpizza" plus, at 487eb3f, "Filmjölk 3%" as no match, since those rows are the seeded account's own.

| source | query | 487eb3f (5) | ff55a74 (20) | this rule (20) | changed against ff55a74 |
|---|---|---|---|---|---|
| recipe, book | 1 pizzaboll, se sidan 110 (a cross-reference, not searched) | no match | no match | no match | |
| recipe, book | mozzarella di bufala DOP (0,39 g (50 g) mozzarella di bufala DOP, i bitar) | no match | no match | no match |  |
| recipe, book | lardo (20 g (25 g) lardo alt pancetta eller bacon, finskuren) | no match | no match | no match |  |
| recipe, book | vitlök (3 g (3,5 g) vitlök, finskivad (ca 1 vitlöksklyfta)) | Vitlök, 128 | Vitlök, 128 | Vitlök, 128 |  |
| recipe, book | färska basilikablad (3–5 färska basilikablad) | Basilika färsk, 25 | no match | Basilika färsk, 25 | **changed** |
| recipe, book | pecorino romano DOP (12 g (15 g) pecorino romano DOP, finriven) | no match | no match | no match |  |
| recipe, book | olivolja (3 g + 5 g (3 g + 7 g) olivolja) | Olivolja, 884 | Olivolja, 884 | Olivolja, 884 |  |
| recipe, screen | gula lökar (2 gula lökar) | no match | Lök gul, 39 | Lök gul, 39 |  |
| recipe, screen | vitlöksklyftor (2 vitlöksklyftor) | Vitlök, 128 | no match | Vitlök, 128 | **changed** |
| recipe, screen | nötfärs (500 g nötfärs eller hushållsfärs (ärt- och nötfärs)) | Lasagne nötfärs, 137 | no match | Nöt färs rå fett 10%, 182 | **changed** |
| recipe, screen | olja (1 msk olja) | no match | no match | no match |  |
| recipe, screen | tomatpuré (4 msk tomatpuré) | Tomat, 17 | Tomatpuré konc. konserv., 84 | Tomatpuré konc. konserv., 84 |  |
| recipe, screen | torkad timjan (1 tsk torkad timjan) | no match | no match | no match |  |
| recipe, screen | torkad rosmarin (1 tsk torkad rosmarin) | no match | no match | no match |  |
| recipe, screen | krossade tomater (1 förp krossade tomater (à 390 g)) | Tomat krossad konserv. m. lag, 22 | Tomat krossad konserv. m. lag, 22 | Tomat krossad konserv. m. lag, 22 |  |
| recipe, screen | köttbuljongtärning (1 köttbuljongtärning) | Köttbuljong ätf., 8 | no match | no match |  |
| recipe, screen | salt (salt) | Salt örtsalt, 18 | Salt m. jod, 0 | Salt m. jod, 0 |  |
| recipe, screen | peppar (peppar) | Pepparrot, 70 | no match | no match |  |
| recipe, screen | smör (6 msk smör (6 msk motsvarar ca 90 g)) | Smör Mindre, 381 | Smör fett 80%, 766 | Smör fett 80%, 766 |  |
| recipe, screen | vetemjöl (6 msk vetemjöl) | Vetemjöl, 352 | Vetemjöl, 352 | Vetemjöl, 352 |  |
| recipe, screen | mjölk (10 dl mjölk) | Mjölkchoklad, 535 | Mjölk fett 3% berikad, 60 | Mjölk fett 3% berikad, 60 |  |
| recipe, screen | riven parmesan (2 dl riven parmesan) | no match | no match | no match |  |
| recipe, screen | torkade lasagneplattor (9 torkade lasagneplattor) | no match | no match | no match |  |
| tools | mjölk | Mjölkchoklad, 535 | Mjölk fett 3% berikad, 60 | Mjölk fett 3% berikad, 60 |  |
| tools | peppar | Pepparrot, 70 | no match | no match |  |
| tools | nötfärs | Lasagne nötfärs, 137 | no match | Nöt färs rå fett 10%, 182 | **changed** |
| tools | kycklingfilé | Kycklingfilé, 100 | Kycklingfilé, 100 | Kycklingfilé, 100 |  |
| tools | fetaost | no match | no match | no match |  |
| tools | ägg | Ägg kokt, 136 | Ägg kokt, 136 | Ägg kokt, 136 |  |
| tools | spenat | Spenat färsk, 24 | Spenat färsk, 24 | Spenat färsk, 24 |  |
| tools | tomat | Tomat, 17 | Tomat, 17 | Tomat, 17 |  |
| tools | ris | no match | no match | no match |  |
| tools | kyckling | no match | Kyckling kokt m. salt, 171 | Kyckling kokt m. salt, 171 |  |
| tools | keso naturell | no match | no match | no match |  |
| tools | yoghurt | Yoghurt vanilje, 81 | Yoghurt naturell fett 10%, 109 | Yoghurt naturell fett 10%, 109 |  |
| tools | rågbröd | no match | no match | no match |  |
| tools | salt | Salt örtsalt, 18 | Salt m. jod, 0 | Salt m. jod, 0 |  |
| tools | friterad potatis | no match | no match | no match |  |
| tools | kokt potatis | Potatis kokt m. salt, 83 | Potatis kokt m. salt, 83 | Potatis kokt m. salt, 83 |  |
| tools | krämig dressing | no match | no match | no match |  |
| tools | kebabpizza | no match | no match | no match |  |
| tools | Mammas köttbullar | no match | no match | no match |  |
| tools | smör | Smör Mindre, 381 | Smör fett 80%, 766 | Smör fett 80%, 766 |  |
| tools | kaffe | Kaffe bryggt, 2 | Kaffe bryggt, 2 | Kaffe bryggt, 2 |  |
| tools | havregrynsgröt | Havregrynsgröt fullkorn, 66 | Havregrynsgröt fullkorn, 66 | no match | **changed** |
| tools | lingonsylt | Lingonsylt, 148 | Lingonsylt, 148 | Lingonsylt, 148 |  |
| tools | banan | Banan, 95 | Banan, 95 | Banan, 95 |  |
| tools | ostmacka | no match | no match | no match |  |
| tools | filmjölk | Filmjölk, 60 | Filmjölk, 60 | Filmjölk, 60 |  |
| tools | müsli | no match | no match | no match |  |
| tools | Kött | Köttfärslåda, 124 | no match | no match |  |
| tools | Gurksallad med tomater och feta | no match | no match | no match |  |
| tools | Krämig sås | no match | no match | no match |  |
| tools | Grillad köttfarsbiff | no match | no match | no match |  |
| tools | Potatismat | Barnmat potatis m. nötköttsgryta konserv., 79 | no match | no match |  |
| tools | Vit krämsås | no match | no match | no match |  |
| tools | Salladblad | Grekisk sallad m. fetaost, 77 | no match | no match |  |
| tools | Smörstekta bacon | no match | no match | no match |  |
| tools | Kycklingbröst | Kyckling bröstfilé m. skinn stekt m. salt, 187 | no match | Kyckling bröstfilé rå u. skinn, 104 | **changed** |
| tools | Tomater | Tomat, 17 | Tomat, 17 | Tomat, 17 |  |
| tools | Croutons | no match | no match | no match |  |
| tools | Ost | Ost, 354 | Ost, 354 | Ost, 354 |  |
| tools | Parmesan | no match | no match | no match |  |
| tools | Pizza | Pizza orientalisk, 208 | Pizza veg. hemlagad, 179 | no match | **changed** |
| logged ×68 | Filmjölk 3% | no match | Filmjölk fett 3% berikad, 57 | Filmjölk fett 3% berikad, 57 |  |
| logged ×10 | Kycklingfilé | Kycklingfilé, 100 | Kycklingfilé, 100 | Kycklingfilé, 100 |  |
| logged ×10 | Rotfruktsgratäng | no match | no match | no match |  |
| logged ×8 | Havregrynsgröt | Havregrynsgröt fullkorn, 66 | Havregrynsgröt fullkorn, 66 | no match | **changed** |
| logged ×8 | Laxfilé med potatis | no match | no match | no match |  |
| logged ×7 | Havrekli | Havrekli, 357 | Havrekli, 357 | Havrekli, 357 |  |
| logged ×7 | Präst | Präst, 277 | Präst, 277 | Präst, 277 |  |
| logged ×6 | Grekisk yoghurt | no match | no match | no match |  |
| logged ×5 | Banan | Banan, 95 | Banan, 95 | Banan, 95 |  |
| logged ×5 | Bregott Normalsaltat | Bregott Normalsaltat, 678 | Bregott Normalsaltat, 678 | Bregott Normalsaltat, 678 |  |
| logged ×5 | Gris skinka skivad rökt fett 1-3% | Gris skinka skivad rökt fett 1-3%, 99 | Gris skinka skivad rökt fett 1-3%, 99 | Gris skinka skivad rökt fett 1-3%, 99 |  |
| logged ×5 | Hårt bröd fullkorn råg fibrer 15,5% typ Husman | no match | no match | no match |  |
| logged ×4 | Blåbär frysvara | Blåbär frysvara, 43 | Blåbär frysvara, 43 | Blåbär frysvara, 43 |  |
| logged ×4 | Mild Kvarg - Vanilj | Mild Kvarg - Vanilj, 59 | Mild Kvarg - Vanilj, 59 | Mild Kvarg - Vanilj, 59 |  |
| logged ×4 | Ägg kokt | Ägg kokt, 136 | Ägg kokt, 136 | Ägg kokt, 136 |  |
| logged ×2 | Gräddost | Gräddost, 420 | Gräddost, 420 | Gräddost, 420 |  |
| logged ×2 | Pastagratäng Rossini m. kycklingfärs ananas paprika squash tomat purjolök | no match | no match | no match |  |
| logged ×2 | Ris avorio okokt | Ris avorio okokt, 358 | Ris avorio okokt, 358 | Ris avorio okokt, 358 |  |
| logged ×2 | Surdegs Bröd | Surdegs Bröd, 220 | Surdegs Bröd, 220 | Surdegs Bröd, 220 |  |
| logged ×1 | Amerikanske pannekaker | Amerikanske pannekaker, 295 | Amerikanske pannekaker, 295 | Amerikanske pannekaker, 295 |  |
| logged ×1 | Babybel Mini | Babybel Mini, 295 | Babybel Mini, 295 | Babybel Mini, 295 |  |
| logged ×1 | Bröd vitt typ levain | Bröd vitt typ levain, 249 | Bröd vitt typ levain, 249 | Bröd vitt typ levain, 249 |  |
| logged ×1 | DORITOS sweet chili pepper | DORITOS sweet chili pepper, 477 | DORITOS sweet chili pepper, 477 | DORITOS sweet chili pepper, 477 |  |
| logged ×1 | Doritos nacho cheese | Doritos nacho cheese, 480 | Doritos nacho cheese, 480 | Doritos nacho cheese, 480 |  |
| logged ×1 | Ferrari Salt Persika | Ferrari Salt Persika, 351 | Ferrari Salt Persika, 351 | Ferrari Salt Persika, 351 |  |
| logged ×1 | Filmjölk A-fil fett 3% berikad | Filmjölk A-fil fett 3% berikad, 60 | Filmjölk A-fil fett 3% berikad, 60 | Filmjölk A-fil fett 3% berikad, 60 |  |
| logged ×1 | Filmjölk långfil fett 3% berikad | Filmjölk långfil fett 3% berikad, 60 | Filmjölk långfil fett 3% berikad, 60 | Filmjölk långfil fett 3% berikad, 60 |  |
| logged ×1 | Fruktyoghurt fett 3,6% berikad | no match | no match | no match |  |
| logged ×1 | Gelégodis | Gelégodis, 350 | Gelégodis, 350 | Gelégodis, 350 |  |
| logged ×1 | Grillad Kyckling | Kyckling grillad m. skinn, 214 | Kyckling grillad m. skinn, 214 | Kyckling grillad m. skinn, 214 |  |

94 queries: 8 changed against ff55a74; 0 gave different foods across three runs.

The development database's own user, where history or its own foods give a different food:

| query | no history | the seeded user |
|---|---|---|
| kebabpizza | no match | Kebabpizza, 240 |
| filmjölk | Filmjölk, 60 | Filmjölk 3%, 56 |
| Filmjölk 3% | Filmjölk fett 3% berikad, 57 | Filmjölk 3%, 56 |

**The reading, row by row.** Eight rows changed against ff55a74:
- **"färska basilikablad"**: no match → "Basilika färsk". The blad isn't in the row.
- **"vitlöksklyftor"**: no match → "Vitlök".
- **"nötfärs"**, as a recipe row and as a tools query: no match → "Nöt färs rå fett 10%", found through the split search.
- **"Kycklingbröst"**: no match → "Kyckling bröstfilé rå u. skinn".
- **"havregrynsgröt"**, as a tools query and as the logged "Havregrynsgröt": "Havregrynsgröt fullkorn" → no match. **A loss**: "fullkorn" is a variety. The only other shared porridge row, "Havregrynsgröt kokt m. mjölk", is made with milk, which is a food. The two plain "Havregrynsgröt" rows belong to another dev account.
- **"Pizza"**: "Pizza veg. hemlagad" → no match.

The other 86 rows are the same food as at ff55a74.

## 3. The gate, one line per row

For a user with no history:
- ok: "färska basilikablad" is a basil row: Basilika färsk
- ok: "vitlöksklyftor" is Vitlök
- ok: "Kycklingbröst" is a chicken breast row: Kyckling bröstfilé rå u. skinn
- ok: "köttbuljongtärning" is no match
- ok: "peppar" is no match. The catalogue has no plain pepper row, and it is not horseradish.
- ok: "nötfärs" is a plain beef mince row: Nöt färs rå fett 10%. The catalogue has three plain rows.
- ok: "Salladblad" is no match, not a dish
- ok: "Pizza" is no match
- ok: "mjölk" is Mjölk fett 3% berikad, as at ff55a74
- ok: "smör" is Smör fett 80%, as at ff55a74
- ok: "tomatpuré" is Tomatpuré konc. konserv., as at ff55a74
- ok: "salt" is Salt m. jod, as at ff55a74
- ok: "gula lökar" is Lök gul, as at ff55a74
- ok: all 94 queries give the same food on three runs in a row
- ok: both recipe photos through the meal sheet with the real model, 15 of 15, both lists whole in their shots at 360 px and desktop

  In the sheet:
  - Cookbook page: basil, "Vitlök", "Olivolja". Saved as "Pizza med pecorino".
  - Screen photo: "Nöt färs rå fett 10%" at 500 g, "köttbuljongtärning" and "peppar" no match, and milk, butter, purée, salt and "Lök gul" as before. Saved as "Lasagne med ostsås 1.4".
  - One row is the model's reading, not the matcher: it transcribed the garlic line as "2 vitlökskyftar", which matches nothing.

## 4. 1.4.0 in production

**Before the command:**
- `PORTAINER_URL` was set, and step 1 said so.
- Ollama on the workstation answered with qwen3-vl:8b (`{"svar": "ja"}`), and the host reaches it.
- Both host scripts equal `c6b435f`.
- CI was green for `c6b435f`.
- **The dry run was green**, exit 0, with step 9 reading the two unbuilt images as expected. Its last line said "1.4.0 is live", which a dry run never is. That's fixed afterwards in `3fe7f05`, with a test that fails on the old script.

| step | evidence |
|---|---|
| 1 workstation | `VIKT_HOST`, `PORTAINER_TOKEN`, `PORTAINER_URL` set, gh authenticated |
| 2 tree | clean, on `dev`, pushed, at `c6b435f` |
| 3 CI | success for `c6b435f` |
| 4 backup | `vikt-20260926T173433Z.dump`, 324K, and `media-20260926T173433Z.tar.gz` (the empty photo directory) |
| 5 restore | `daily_log 73, food_entries 310, plans 2, users 4, weight_log 108`, restored copy and live database agree |
| 6 main | fast-forwarded 12 commits to `c6b435f` |
| 7 tag | `v1.4.0` on `c6b435f` |
| 8 workflow | run `36259517211` green |
| 9 plan | nothing blocks this deploy; `IMAGE_TAG 1.3.0 -> 1.4.0`, no variable set |
| 10 deploy | both containers on the new image, API healthy, `the vision model can see` in 1 310 ms |
| 11 API log | `version 1.4.0, commit c6b435f`; `Migrations: none to apply, 36 already recorded`; VAPID key unchanged |
| 12 outside | `/api/health` 200, `/` 200, `/app/` 200 |
| 13 Nyheter | published "Vikt 1.4" as `23e25343-48c9-4b94-afd6-f09afe3e883a`, 1216 characters, not mailed |

**Lighthouse on the production landing page:**
- Scores: performance 98, accessibility 100, best practices 100, SEO 100.
- Timings: LCP 1,8 s, blocking time 0 ms, speed index 3,9 s.
- Layout shift 0,017 on one container, against 0 at 1.3.0. No landing code changed between the two releases; this was one run over the real network, inside "good".

**STATE.md:**
- Production runs 1.4.0 with its commit and tag.
- "Inför nästa deploy" starts over.
- Rollback needs no dump: no migration ran, so `stack.mjs deploy 1.3.0 --keep-file --yes` alone brings 1.3.0 back.

## For you

- **Checks in production.** I did not sign in there.
  - Nyheter shows "Vikt 1.4" at the top.
  - **A real recipe photo on a phone**: Måltider, Ny måltid, "Recept från foto". Each row should show its printed line, a yield in portions should fill the count, and the meal should save.
  - Mat, "En mening": "ett glas mjölk" should propose milk, not milk chocolate.
- **The tail rule** after "m." is my addition beyond your three refinements, and it changes D72's "Kyckling med curry" from match to refused. Worth a look.
- **I kept "naturell", "osötad" and the salt levels as qualifiers**, reading them as the plain food and as measures. Say if you'd rather they go.
- **"havregrynsgröt" is now no match** in this catalogue. That's the loss above.

## Closing sweep

```
ok   landing 360 height=6796 capture=beyond-viewport charts=0 nav=0 overflow=0px text=3757 track="" landing-ok=sentence15/meta13/gap64
ok   landing desktop height=5206 capture=beyond-viewport charts=0 nav=0 overflow=0px text=3757 track="" landing-ok=sentence15/meta13/gap64
summary checks=45/45 failed=0 complete=true
```
