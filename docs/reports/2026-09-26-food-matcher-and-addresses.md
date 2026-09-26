# Session report, 2026-09-26: the food matcher, no private addresses, 1.4.0 prepared again

All four items are done, and nothing was released. `dev` is pushed with CI green, and 1.4.0 waits for your review of the matcher's before and after, which is the table below.

## 1. Two rules in §7 (`ad85670`)

- **A red check before a production step is never read as harmless and passed.** The session either stops and reports it, or fixes the check, runs it again and gets it green before the step it guards. The 1.3.0 dry run is written in as the case: it was read correctly, but that reading was yours to make.
- **Your network addresses live in INFRA.md, never in a tracked file.** Tests and examples use RFC 5737's documentation ranges. The rule names the test from item 3.

## 2. The food matcher (`ff55a74`, D196)

**The rule, in four parts:**
1. A row is only its head, the part before "m.", "med" or a comma.
2. The head's first word must be one of the asked words, in any order. So "Lasagne nötfärs" is lasagne, and "gula lökar" reaches "Lök gul".
3. Every asked word must be in the head, as itself or inflected. An inflection is a shared stem plus an ending from a closed set, in both directions: tomat/tomater, lök/lökar, klyfta/klyftor. Anything else is another word: "mjölkchoklad", "pepparrot", and in the other direction "basilikablad" against "Basilika".
4. Every remaining word must be a qualifier, or the row is refused.

**Qualifiers were counted, not guessed.** I counted every word that follows the first word of a Livsmedelsverket name in the dev catalogue (2 606 rows). The list holds the preparation, state, measure and colour words among them that occur at least once, from "fett" (264) to "bryggt" (3). Likely-sounding words the catalogue doesn't contain are left out.

**No extra word is allowed.** My first version kept D72's one-word allowance. The table showed what that lets in: "Kyckling mage rå" (gizzard), "Ris avorio okokt" (uncooked, about three times cooked rice's energy), "Yoghurt vanilje". With the fuller qualifier list, no allowance still keeps "Kaffe bryggt" and "Smör osaltat fett ca 80%".

**Twenty candidates.** A test puts eight flavoured "Mjölk X" names ahead of plain milk in the ranking. It finds milk at twenty candidates and gives no match at five. My first version of that test passed at five too, so it wasn't testing anything; the decoys were rebuilt until it failed at five.

**Tests:** `llm-parse.test.ts` has pairs in both directions: the three live cases, the two from the function's comment, twelve compound traps from the dev catalogue, and plain foods that must match. All eight new tests fail on the old rule and pass on this one. One older fixture, "Pizza kebab" for "kebabpizza", only matched through the old prefix rule; the catalogue calls it "Kebabpizza", so the fixture does now.

### Before and after

"Before" is the rule at `487eb3f`, copied verbatim, over a five-row search. "After" is the new rule over twenty. Each cell shows the matched food and its kcal per 100 g. The queries: every row name in both recipe photos, every name in the sentence and plate tools' tests and probes, and the thirty most logged foods in the dev database, queried by their own names.

| source | query | before (5 candidates) | after (20) | changed |
|---|---|---|---|---|
| recipe, book | 1 pizzaboll, se sidan 110 (a cross-reference, not searched) | no match | no match | |
| recipe, book | mozzarella di bufala DOP (0,39 g (50 g) mozzarella di bufala DOP, i bitar) | no match | no match |  |
| recipe, book | lardo (20 g (25 g) lardo alt pancetta eller bacon, finskuren) | no match | no match |  |
| recipe, book | vitlök (3 g (3,5 g) vitlök, finskivad (ca 1 vitlöksklyfta)) | Vitlök, 128 | Vitlök, 128 |  |
| recipe, book | färska basilikablad (3–5 färska basilikablad) | Basilika färsk, 25 | no match | **changed** |
| recipe, book | pecorino romano DOP (12 g (15 g) pecorino romano DOP, finriven) | no match | no match |  |
| recipe, book | olivolja (3 g + 5 g (3 g + 7 g) olivolja) | Olivolja, 884 | Olivolja, 884 |  |
| recipe, screen | gula lökar (2 gula lökar) | no match | Lök gul, 39 | **changed** |
| recipe, screen | vitlöksklyftor (2 vitlöksklyftor) | Vitlök, 128 | no match | **changed** |
| recipe, screen | nötfärs (500 g nötfärs eller hushållsfärs (ärt- och nötfärs)) | Lasagne nötfärs, 137 | no match | **changed** |
| recipe, screen | olja (1 msk olja) | no match | no match |  |
| recipe, screen | tomatpuré (4 msk tomatpuré) | Tomat, 17 | Tomatpuré konc. konserv., 84 | **changed** |
| recipe, screen | torkad timjan (1 tsk torkad timjan) | no match | no match |  |
| recipe, screen | torkad rosmarin (1 tsk torkad rosmarin) | no match | no match |  |
| recipe, screen | krossade tomater (1 förp krossade tomater (à 390 g)) | Tomat krossad konserv. m. lag, 22 | Tomat krossad konserv. m. lag, 22 |  |
| recipe, screen | köttbuljongtärning (1 köttbuljongtärning) | Köttbuljong ätf., 8 | no match | **changed** |
| recipe, screen | salt (salt) | Salt örtsalt, 18 | Salt m. jod, 0 | **changed** |
| recipe, screen | peppar (peppar) | Pepparrot, 70 | no match | **changed** |
| recipe, screen | smör (6 msk smör (6 msk motsvarar ca 90 g)) | Smör Mindre, 381 | Smör fett 80%, 766 | **changed** |
| recipe, screen | vetemjöl (6 msk vetemjöl) | Vetemjöl, 352 | Vetemjöl, 352 |  |
| recipe, screen | mjölk (10 dl mjölk) | Mjölkchoklad, 535 | Mjölk fett 3% berikad, 60 | **changed** |
| recipe, screen | riven parmesan (2 dl riven parmesan) | no match | no match |  |
| recipe, screen | torkade lasagneplattor (9 torkade lasagneplattor) | no match | no match |  |
| tools | mjölk | Mjölkchoklad, 535 | Mjölk fett 3% berikad, 60 | **changed** |
| tools | peppar | Pepparrot, 70 | no match | **changed** |
| tools | nötfärs | Lasagne nötfärs, 137 | no match | **changed** |
| tools | kycklingfilé | Kycklingfilé, 100 | Kycklingfilé, 100 |  |
| tools | fetaost | no match | no match |  |
| tools | ägg | Ägg rått, 136 | Ägg kokt, 136 | tie order |
| tools | spenat | Spenat färsk, 24 | Spenat färsk, 24 |  |
| tools | tomat | Tomat, 17 | Tomat, 17 |  |
| tools | ris | no match | no match |  |
| tools | kyckling | no match | Kyckling kokt m. salt, 171 | **changed** |
| tools | keso naturell | no match | no match |  |
| tools | yoghurt | Yoghurt vanilje, 81 | Yoghurt naturell fett 10%, 109 | **changed** |
| tools | rågbröd | no match | no match |  |
| tools | salt | Salt örtsalt, 18 | Salt m. jod, 0 | **changed** |
| tools | friterad potatis | no match | no match |  |
| tools | kokt potatis | Potatis kokt m. salt, 83 | Potatis kokt m. salt, 83 |  |
| tools | krämig dressing | no match | no match |  |
| tools | kebabpizza | Kebabpizza, 240 | Kebabpizza, 240 |  |
| tools | Mammas köttbullar | no match | no match |  |
| tools | smör | Smör Mindre, 381 | Smör fett 80%, 766 | **changed** |
| tools | kaffe | Kaffe bryggt, 2 | Kaffe bryggt, 2 |  |
| tools | havregrynsgröt | Havregrynsgröt fullkorn, 66 | Havregrynsgröt fullkorn, 66 |  |
| tools | lingonsylt | Lingonsylt, 148 | Lingonsylt, 148 |  |
| tools | banan | Banan, 95 | Banan, 95 |  |
| tools | ostmacka | no match | no match |  |
| tools | filmjölk | Filmjölk, 60 | Filmjölk, 60 |  |
| tools | müsli | no match | no match |  |
| tools | Kött | Köttfärslåda, 124 | no match | **changed** |
| tools | Gurksallad med tomater och feta | no match | no match |  |
| tools | Krämig sås | no match | no match |  |
| tools | Grillad köttfarsbiff | no match | no match |  |
| tools | Potatismat | Barnmat potatis m. nötköttsgryta konserv., 79 | no match | **changed** |
| tools | Vit krämsås | no match | no match |  |
| tools | Salladblad | Grekisk sallad m. fetaost, 77 | no match | **changed** |
| tools | Smörstekta bacon | no match | no match |  |
| tools | Kycklingbröst | Kyckling bröstfilé m. skinn stekt m. salt, 187 | no match | **changed** |
| tools | Tomater | Tomat, 17 | Tomat, 17 |  |
| tools | Croutons | no match | no match |  |
| tools | Ost | Ost, 252 | Ost, 354 | tie order |
| tools | Parmesan | no match | no match |  |
| tools | Pizza | Pizza orientalisk, 208 | Pizza veg. hemlagad, 179 | **changed** |
| logged ×68 | Filmjölk 3% | Filmjölk 3%, 56 | Filmjölk 3%, 56 |  |
| logged ×10 | Kycklingfilé | Kycklingfilé, 100 | Kycklingfilé, 100 |  |
| logged ×10 | Rotfruktsgratäng | no match | no match |  |
| logged ×8 | Havregrynsgröt | Havregrynsgröt fullkorn, 66 | Havregrynsgröt fullkorn, 66 |  |
| logged ×8 | Laxfilé med potatis | no match | no match |  |
| logged ×7 | Havrekli | Havrekli, 357 | Havrekli, 357 |  |
| logged ×7 | Präst | Präst, 277 | Präst, 384 | tie order |
| logged ×6 | Grekisk yoghurt | no match | no match |  |
| logged ×5 | Banan | Banan, 95 | Banan, 95 |  |
| logged ×5 | Bregott Normalsaltat | Bregott Normalsaltat, 678 | Bregott Normalsaltat, 678 |  |
| logged ×5 | Gris skinka skivad rökt fett 1-3% | Gris skinka skivad rökt fett 1-3%, 99 | Gris skinka skivad rökt fett 1-3%, 99 |  |
| logged ×5 | Hårt bröd fullkorn råg fibrer 15,5% typ Husman | no match | no match |  |
| logged ×4 | Blåbär frysvara | Blåbär frysvara, 43 | Blåbär frysvara, 43 |  |
| logged ×4 | Mild Kvarg - Vanilj | Mild Kvarg - Vanilj, 59 | Mild Kvarg - Vanilj, 59 |  |
| logged ×4 | Ägg kokt | Ägg kokt, 136 | Ägg kokt, 136 |  |
| logged ×2 | Gräddost | Gräddost, 422 | Gräddost, 422 |  |
| logged ×2 | Pastagratäng Rossini m. kycklingfärs ananas paprika squash tomat purjolök | no match | no match |  |
| logged ×2 | Ris avorio okokt | Ris avorio okokt, 358 | Ris avorio okokt, 358 |  |
| logged ×2 | Surdegs Bröd | Surdegs Bröd, 220 | Surdegs Bröd, 220 |  |
| logged ×1 | Amerikanske pannekaker | Amerikanske pannekaker, 295 | Amerikanske pannekaker, 295 |  |
| logged ×1 | Babybel Mini | Babybel Mini, 295 | Babybel Mini, 295 |  |
| logged ×1 | Bröd vitt typ levain | Bröd vitt typ levain, 249 | Bröd vitt typ levain, 249 |  |
| logged ×1 | DORITOS sweet chili pepper | DORITOS sweet chili pepper, 477 | DORITOS sweet chili pepper, 477 |  |
| logged ×1 | Doritos nacho cheese | Doritos nacho cheese, 480 | Doritos nacho cheese, 480 |  |
| logged ×1 | Ferrari Salt Persika | Ferrari Salt Persika, 351 | Ferrari Salt Persika, 351 |  |
| logged ×1 | Filmjölk A-fil fett 3% berikad | Filmjölk A-fil fett 3% berikad, 60 | Filmjölk A-fil fett 3% berikad, 60 |  |
| logged ×1 | Filmjölk långfil fett 3% berikad | Filmjölk långfil fett 3% berikad, 60 | Filmjölk långfil fett 3% berikad, 60 |  |
| logged ×1 | Fruktyoghurt fett 3,6% berikad | no match | no match |  |
| logged ×1 | Gelégodis | Gelégodis, 350 | Gelégodis, 350 |  |
| logged ×1 | Grillad Kyckling | Kyckling grillad m. skinn, 214 | Kyckling grillad m. skinn, 214 |  |

94 queries: 22 changed by the rule, 3 by the order of equal rows.

**How to read it:**
- **Gained:**
  - "mjölk" is milk, not milk chocolate.
  - "smör" is butter at 766 kcal, not a 381 kcal spread.
  - "tomatpuré" is tomato purée, not a tomato.
  - "salt" is salt at 0, not herb salt.
  - "gula lökar" reaches "Lök gul".
  - "kyckling" reaches cooked chicken.
  - "yoghurt" reaches a plain yoghurt, not vanilla. It is the 10 % one, because the matcher doesn't choose between fat contents.
- **Refused, a wrong food turned into no match:** "peppar" (horseradish), "nötfärs" (lasagne), "köttbuljongtärning" (ready-made broth, where a stock cube is concentrate), "Kött", "Potatismat", "Salladblad", "Pizza orientalisk".
- **Lost, a right food turned into no match:** "färska basilikablad", "vitlöksklyftor" and "Kycklingbröst". Each is a compound whose first part is the food, and the rule reads a compound as another word in both directions.
- **Tie order, not the rule:** "Ost" and "Präst" are several Open Food Facts rows each (Ost from 252 to 354 kcal), and "Ägg rått" and "Ägg kokt" tie. Which one a proposal shows depends on the database's order. Both rules accept all of them, and I did not fix it.

## 3. Your addresses in tracked files (`c224343`, D197)

- **`PORTAINER_URL` is now required:**
  - `scripts/portainer.mjs` refuses without it, naming the variable and INFRA.md, exit 2. It checks the token first.
  - Release step 1 stops on it.
  - INFRA.md, which is local, names it and holds the value.
- **Test addresses moved to documentation ranges.** `release.test.ts` and the trust-proxy tests use RFC 5737 addresses now. The trust-proxy prefix-length check moved to `192.0.2.0/25` against `192.0.2.200`.
- **`no-private-addresses.test.ts` reads every tracked file.** It fails on any RFC 1918 address, naming file and line. I ran it first on the tree as it stood, and it failed on `scripts/portainer.mjs:35`, `release.test.ts:230` and six trust-proxy examples before passing. Its own samples are built from numbers, so it doesn't flag itself.
- **One range is allowed: `172.31.240.0/24`.** That is the product's own `edge` Docker subnet from D14, pinned in both compose files and nobody's network. It is written down as an exception for you to judge.
- **One request reached your Portainer.** To see the new helper test fail, I ran it against the old script. The old script sent one request with a dummy key to its built-in default host; the request failed, and nothing else was sent.
- The published history is not rewritten.

## 4. 1.4.0 prepared again (`54e0e16`)

- **Both recipe photos went through the meal sheet with the new matcher and the real model: 19 of 19.**
  - Cookbook page: "Vitlök" and "Olivolja" matched as themselves, basil leaves are now no match, and "kontrollera mot sidan" is still on the mozzarella row only. Saved as "Pecorinopizza".
  - Screen photo: milk, butter, "Lök gul" and tomato purée as above, "peppar" and "nötfärs" no match, and "4 portioner" filled the count. Saved as "Lasagne med ostsås".
- **Both lists were shot at 360 px and desktop.** The sheet scrolls inside itself, so I shot row by row, with every row whole in some shot: 5 of 5.
- **STATE.md's 1.4.0 section:**
  - Better matching in the sentence, plate photo and recipe photo.
  - A Nyheter paragraph, "Bättre träffar".
  - No `release` block, because nothing is to be set.
  - `PORTAINER_URL` on the workstation.
- STATE.md's current state records what was exercised.

## For you

- **Review the matcher table above before 1.4.0 is released.**
- **Set `PORTAINER_URL` on the workstation before the release.** INFRA.md, "The Portainer token", has the value and the command. It is not set now, and the release will stop at step 1 until it is.
- **Decide on the `edge` subnet exception** in the address test (D197).
- **Rows with the same name tie in search**, so "Ost" can show 252 or 354 kcal. That belongs to search, not to the matcher, and is not fixed.

## Closing sweep

```
ok   landing 360 height=6796 capture=beyond-viewport charts=0 nav=0 overflow=0px text=3757 track="" landing-ok=sentence15/meta13/gap64
ok   landing desktop height=5206 capture=beyond-viewport charts=0 nav=0 overflow=0px text=3757 track="" landing-ok=sentence15/meta13/gap64
summary checks=45/45 failed=0 complete=true
```
