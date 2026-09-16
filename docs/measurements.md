# Measurements

Numbers this project has actually taken, and the conditions they were taken
under. Nothing here is an estimate or a target.

The landing page quotes the tap counts below, and
`apps/web/test/landing-figures.test.ts` reads this file to check that it still
does. If the fast path changes and the page does not, the suite fails and the
message says the page is claiming something that was true last month — which is
the only way a marketing number stays honest.

---

## The landing page, second pass

Same conditions as the first pass: Lighthouse 12.8.2, headless Chrome, **mobile
settings**, against the production build over https. 2026-09-16, after D177.

| | first pass | second pass |
|---|---|---|
| performance | 98 | **98** |
| accessibility | 100 | **100** |
| cumulative layout shift | 0 | **0** |
| largest contentful paint | 2,2 s | 2,2 s |
| total blocking time | 0 ms | 0 ms |

### What the page loads, against two budgets

| | gzipped | budget |
|---|---|---|
| the landing chunk: the page, its motion, its fixture | **12,4 kB** | 15 kB |
| everything `/` fetches | **58,3 kB** | 60 kB |

Two numbers rather than one (D173's addendum): the page's own code is what moves
when a section is added, and the total is what a stranger pays. React is 45,9 kB
of the total and is a decision rather than a number anybody can edit down.

### The hero, sampled on the page's own clock

| at | readings shown | line | endpoint |
|---|---|---|---|
| 419 ms | 4 of 30 | not started | hidden |
| 976 ms | 15 of 30 | not started | hidden |
| 1 534 ms | 27 of 30 | not started | hidden |
| 2 095 ms | 30 of 30 | a quarter drawn | hidden |
| 2 655 ms | 30 of 30 | four fifths | hidden |
| 3 216 ms | 30 of 30 | all but a trace | hidden |
| 3 776 ms | 30 of 30 | **drawn** | **appearing** |

The endpoint was timed at 3 400 ms against a line that finishes at 3 500, so it
arrived before the line reached it. It is 3 500 now, and the table is what
"after" looks like.

### The fortnight, at four scroll positions

| the section's top at | progress | readings shown |
|---|---|---|
| 0,9 of the viewport | 0 | 0 of 14 |
| 0,6 | 0 | 0 of 14 |
| 0,35 | **0,769** | 11 of 14 |
| 0,1 | **1,0** | **14 of 14** |
| back at the top | **1,0** | 14 of 14 |

The last row is the point: progress is the maximum seen so far, so scrolling back
up leaves the line drawn. It was `animation-timeline: view()`, which runs
backwards by design.

**It read 13 of 14 before D177**: the last reading's threshold was exactly 1 and
never crossed. The thresholds are compressed into 0 to 0,92 now.

### Reduced motion

Captured 900 ms after load with `prefers-reduced-motion: reduce` emulated: 30 of
30 hero readings present, both lines drawn, the endpoint at full opacity,
progress 1 and all fourteen readings shown. The finished page, at once.

---

## The landing page, rebuilt

Lighthouse 12.8.2 in headless Chrome, **mobile settings** (the default preset:
Moto G Power emulation, 4x CPU throttling, simulated slow 4G), against the
production build served by `vite preview` over https. 2026-09-17.

| | |
|---|---|
| performance | **98** |
| accessibility | **100** |
| largest contentful paint | 2,2 s |
| cumulative layout shift | **0** |
| total blocking time | 0 ms |
| speed index | 1,7 s |

Zero layout shift is the one worth saying twice. The page animates a great deal
and shifts nothing: every figure is in the markup at its final width before the
count-up starts, the phone screenshots carry `width` and `height`, and the
reveals move 12 px with `transform` rather than with layout.

Accessibility was **95 before the contrast fix below** and is 100 after it.

### What the page loads

Measured on the build, gzipped, by `apps/web/scripts/check-bundle.mjs`, which
runs in CI:

| | gzipped |
|---|---|
| the landing chunk: the page, its motion, its fixture | 11,7 kB |
| the vendor chunk: react and react-dom | 45,9 kB |
| **everything `/` fetches** | **57,6 kB** |

The brief asked for under 40 kB. **It is not met, and cannot be while the page
ships React**: the framework alone is more than the whole budget, and the page's
own code is a quarter of it. The way there is to stop shipping React for this
page at all, which is a build change rather than a page change (D173). The CI
check holds the page at its current weight and names the 40 kB target in its
failure message so the gap stays visible.

### Contrast, dark theme

Measured with the WCAG formula against the theme's own surfaces:

| foreground | on Natt `#0F1418` | on Skymning `#16232B` |
|---|---|---|
| Sten `#6B7B82`, the profile's value | 4,22:1 | **3,65:1** |
| Sten `#7C8C94`, the public pages' value | 5,32:1 | 4,61:1 |

**The profile's Sten does not hold 4,5:1 on either dark surface.** The light
theme has known this since it was written: `tokens.css` darkens Sten to
`#5c6b72` there with a comment saying it is to hold 4,5:1 on Papper. The dark
theme never got the same correction, so every meta line and every "inte än" on a
card in the app is at 3,65:1 today.

The public bundle lightens it to `#7C8C94` (D173), because this brief holds the
landing page to 4,5:1 and Lighthouse docked it for exactly those elements. The
app is unchanged: the same correction there is a change to the profile's own
value, and that is the owner's call rather than a side effect of a landing page.

---

## The fast path

Production build, 360x740, 4x CPU throttling, ~80 ms latency on 1.6 Mbps, on the
bundle whose asset hash was confirmed served before any number was taken.
Measuring on a dev server measures the dev server.

| | two passes ago | last pass | now (in-app) | now (wall) |
|---|---|---|---|---|
| repeat food, cold open to logged | 2 taps, 102 ms | 2 taps, 59 ms | **2 taps, 47 ms** | 50 ms |
| saved meal, cold open to logged | 1 tap, 183 ms | 1 tap, 176 ms | **1 tap, 146 ms** | 149 ms |

*In-app* is measured inside the page, from the click to the confirmation
appearing, and is the honest latency. *Wall* is measured from Node around the
whole call and still carries one CDP round trip, which is what the oldest
figures included, so compare that column with the leftmost one. The columns are
kept because the harness changed once, and numbers should not silently improve
by a change of method.

**The tap counts are what the landing page quotes, and they have not moved.**
Two taps to repeat something, one to log a saved meal, through four passes.

Re-measured after the pass that folded Framsteg's lists, moved the request form
off the landing page, put Markdown in announcements and added the SMB backup
destination. None of that is on this path — it is the food screen's "Senast
loggat" and its saved meals, both untouched — but that is a reason to expect no
change rather than a reason not to look. Both figures came out faster, which on
an unchanged path is the machine and the run, not an improvement to claim.

---

## The day's own pass

Same conditions as the fast path: production build, 360x740, 4x CPU throttling,
~80 ms latency on 1.6 Mbps. Measured when the habit checklist landed (D137),
three runs each, median reported.

| | taps | in-app |
|---|---|---|
| four ratings, then save | 5 | **161 ms** |
| four ratings, three habits ticked, then save | 8 | **160 ms** |

No figure existed for this path before, so the comparison is the two rows above:
the same screen on the same build, with and without the ticks. Three habits cost
**three taps and no measurable time**. Each tick is its own write and does not
block the save, and the spread across runs (146 to 169 ms) is wider than the
difference between the rows, so the right reading is "unchanged" rather than
"faster".

---

## Can the models on the workstation see

Asked before anything was built on the answer, with the probe that is now
`pnpm --filter api probe:vision`, against `OLLAMA_URL` on the LAN. Ollama reports a `vision` capability for four
of the models installed here, and a capability is a claim about a build rather
than evidence that this tag on this box will do the thing.

The image is a generated PNG with a red circle, a blue square and the word VIKT
in it: 320x240, 2 kB. It cannot tell you whether a model can read a plate. It
tells you whether the `images` field reaches the model at all, which is the
difference between "ignored the picture" and "looked and guessed badly".

| model | reports vision | saw it | read the word | time |
|---|---|---|---|---|
| `qwen3-vl:8b` | yes | yes | **"VIKT"** | **11.0 s** |
| `qwen3.6:27b` | yes | yes, circle and square with colours | "IKT" | 16.7 s |
| `qwen3.6:latest` | yes | yes, and described the layout | "UIKIT" | 30.1 s |
| `odytrice/gemma4-31b:5090` | yes | yes, colours and background | "VIKT" | 94.3 s |
| `gemma4:e4b` | yes | **no**: "du har inte tillhandahållit någon bild" | — | 21.0 s |

`qwen3-vl:8b` was pulled for this comparison and is the only model that is both
the fastest and the most accurate reader: 11 s, and the word right, against 94 s
for the other model that read it. Eight billion parameters against twenty-seven
and thirty-one, which is the expected shape for a model built for pictures
rather than a general one that also accepts them.

`gemma4:e4b` is the finding worth keeping: it advertises `vision`, accepts the
request, and answers as though no image was attached. A flag is not a test.

The times are for a 2 kB image on an idle box. A photograph is two orders of
magnitude larger and will not be anywhere near this fast, which is why the
waiting state on the screen has to quote a measured figure rather than a hope.

### And then a real plate

Six photographs taken on a phone, resized to 1280 px on the long edge and
re-encoded as JPEG at 0.8 — the size the client will actually send, so the
timings are the ones a person will wait. 3-11 MB became 77-211 kB.

**The home plate**: a grilled steak, a dollop of béarnaise, thick chips, and a
salad of cucumber, cherry tomato and feta. 104 kB.

| model | time | what it said |
|---|---|---|
| `qwen3-vl:8b` | **19.6 s** | Kött, 1 portion · Friterad potatis, stor mängd · Gurksallad med tomater och feta, ca 100 g · Krämig sås, ca 50 g |
| `qwen3.6:27b` | 14.9 s | Grillad köttfarsbiff, ca 1 st · **Gulrots**- och gurksallad med fetaost, ca ½ cup · **Potatismat (fryst)**, ca 3-4 dl · Vit krämsås eller aioli, ca 2-3 msk |
| `gemma4:e4b` | 10.5 s | "Jag kan tyvärr inte se någon tallrik eller någon mat i din fråga. Du har inte bifogat någon bild." |

`qwen3-vl:8b` named all four things on the plate and put a plausible amount on
each. `qwen3.6:27b` **sees but invents**: there is no carrot, the chips are not
frozen, and "potatismat" is not a word. `gemma4:e4b` denies having been sent
anything, exactly as it did with the generated image. `odytrice/gemma4-31b:5090`
was not re-run on a photograph: it took 94 s on a 2 kB image, and nothing it
could say would make a minute and a half acceptable on a screen somebody is
waiting at.

Two more, both `qwen3-vl:8b`:

| photo | time | what it said |
|---|---|---|
| Caesar salad, 211 kB | **10.0 s** | Salladblad: stora mängder · Smörstekta bacon: 3-4 bitar · Kycklingbröst: 3-4 skivor · Tomater: 2-3 st · Croutons: 5-6 bitar · Ost (t.ex. Parmesan): stora mängder · Krämig dressing: spridd över delar |
| Kebab pizza, 209 kB | **13.1 s** | Pizza (1 st) |

#### What this decides

**The model is `qwen3-vl:8b`**, and the wait to quote on screen is **10 to 20
seconds** for a 1280 px photograph on an idle box.

Three things the probe settled that a paragraph could not:

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

### What a photograph costs the model that was already loaded

One GPU, and now three models that want it. Measured through `/api/ps` on the
workstation, with the probe printing what was resident before and after each
call.

| resident before | after a photograph | verdict |
|---|---|---|
| `gemma4:e4b` 4 GB (the text parser) | `gemma4:e4b` 4 GB + `qwen3-vl:8b` 15 GB | both stay |
| `qwen3.6:27b` 21 GB (the coach) | `qwen3-vl:8b` 15 GB alone | the coach is evicted |

**The text parser survives a photograph.** Four gigabytes and fifteen fit
together, and a text parse immediately after a photo answered in **85 ms** —
the same warm figure as before it. Somebody photographing dinner and then
typing a second item pays nothing for the first.

**The coach does not.** Twenty-one gigabytes and fifteen do not fit, so a photo
evicts the conversation model. The next coach turn then pays a cold load:
**12.7 s to the first token, against 118 to 181 ms warm.** The coach streams
(D139), so what this costs is the wait before the first sentence appears, once,
and only for a turn that directly follows a photograph.

Not worth designing around, for two reasons. It is a self-hosted box with one
user in front of it, so the sequence photo-then-immediately-chat is rare; and the
alternative — keeping all three resident — is a hardware decision, not a code
one. It is worth **knowing**, because "the coach felt slow that once" is
otherwise an unexplainable observation, and this is the explanation.

---

## Local food search

Taken 2026-09-15 with `apps/api/src/scripts/measure-search.ts`, against the
development database: PostgreSQL 16.14 on musl, **2 809** rows in `food_items`,
on the workstation. Local search only (`searchFoodItems`), never the adapters,
so these are the database's figures and not Open Food Facts'. Three warm-up runs
per query, then twenty-five; median and 90th percentile.

**Before** is the query as 0004 left it: whole-name trigram similarity above
0.3, and substring matches on name, brand and brand-and-name. **After** is D165:
the folded `search_name` from migration 0030, every word in any order, word
similarity at 0.6, and one trigram index serving all of it.

| query | before, median / p90 | after, median / p90 | first result before | first three after |
|---|---|---|---|---|
| banan | 13.8 / 15.0 ms | 13.5 / 15.1 ms | Banan | Banan, Banan torkad, Banan kokbanan |
| kvarg | 14.2 / 15.2 ms | 14.0 / 15.4 ms | Lindhahls Kvarg | Lindhahls Kvarg, Nestle Kvarg, Lindahls Kvarg |
| ägg | 13.2 / 14.7 ms | 12.7 / 13.8 ms | Ägg kokt | Ägg rått, Ägg kokt, Ägg stekt |
| lindahls kvarg | 17.0 / 17.9 ms | 16.5 / 17.9 ms | Nestlé Lindahls Kvarg | Lindahls Kvarg, Lindahls Kvarg, Lindahls Pro+ Kvarg Vanilj |
| Yogghurt | 13.3 / 14.9 ms | 14.2 / 15.6 ms | Yoghurt vanilje, **and nothing else** | Yoghurt vanilje, Yoghurt naturell fett 10%, Yoghurt mild vanilj fett 2% |
| frischgöld | 14.5 / 18.0 ms | 14.6 / 16.9 ms | Frischgold Gräddost | Frischgold Gräddost |
| köttbullar mammas | 17.0 / 19.2 ms | 19.3 / 21.5 ms | Köttbullar frysvara | Köttbullar frysvara, Köttbullar nöt stekta, Köttbullar gris stekta |
| mammas köttbullar | 17.9 / 18.8 ms | 17.1 / 18.5 ms | Köttbullar frysvara | the same three |
| zzzqqq | 14.4 / 15.2 ms | 13.9 / 14.5 ms | nothing | nothing |

**Time: unchanged.** Every query is within a millisecond or two of its before
figure in either direction, and the spread between runs of one query is about
that wide, so the honest reading is "no measurable cost" rather than faster or
slower. At this table size the planner scans rather than using either index, so
the index is paid for at write time and earns its keep only as the cache grows.

**What came back: better where it was wrong.** "Yogghurt" found one yoghurt and
now finds them all. The development catalogue has no Mammas product, so the
word-order pair shows only that both orders agree; the fixture in
`food-search.test.ts` has one and asserts it comes first either way.
"frischgöld" already reached Frischgold here through the brand-and-name
substring on a short name; the fixture test asserts it through the fold.

---

## The human check

ALTCHA proof of work (D112), solved in the browser. Measured with the real
solver on the development workstation:

| `maxnumber` | median solve |
|---|---|
| 10 000 | 133 ms |
| 20 000 | 162 ms |
| 50 000 | 466 ms |

20 000 is what ships. A phone is a few times slower again, which keeps an honest
attempt around half a second inside a submit somebody has already pressed.

End to end through the page at 360 px, from pressing the button to the
confirmation appearing: **264 ms**.

---

## Contrast and focus

**The "zero failures" below was wrong, and it is left here with its correction
rather than edited into looking right.**

Audited programmatically across six screens on **both themes** after the theme
setting landed (D117): **zero** contrast failures against WCAG AA, and a visible
focus ring on all 186 interactive elements.

What that audit could not see is that it walked rendered screens: it reported
the pairs it happened to find, and a token is not a pair. Computed from the
tokens themselves (D175, `apps/web/test/contrast.test.ts`), Sten failed on every
dark surface it is used on:

| Sten | on Natt | on Skymning | on Dis |
|---|---|---|---|
| `#6B7B82`, the profile's value, dark theme | 4,22 | **3,65** | **3,22** |
| `#85949A`, from D175 | 5,91 | 5,12 | 4,52 |
| `#5C6B72`, the old light-theme value | 4,86 | 4,51 | **4,05** |
| `#55636A`, from D175 | 5,46 | 5,08 | 4,55 |

Two things worth keeping from that table. **Skymning is not the worst surface,
Dis is**, so the obvious correction to `#7A8B92` would have passed the card and
still failed the field at 4,00. And the light theme had already been corrected
once by hand, to hold 4,5:1 **on Papper**, which is the same mistake in the
other direction: one surface checked, the others assumed.

The accents are unchanged and are held to what the profile claims of them:
4,5:1 against Natt in the dark theme, and 3:1 as marks on the page and on a
card. The light theme's Is is **2,78:1 on Dis**, which is why the guard checks
that nothing draws an accent on a Dis surface rather than assuming nothing
does.

---

## What a coach turn costs, with the data sheet

Taken 2026-09-13 with `apps/api/src/scripts/coach-size.ts`, against the real
`qwen3.6:27b` on the workstation, on the development account. The script asks
Ollama rather than counting characters: `prompt_eval_count` is the model's own
answer for the turn it was given, and `/api/ps` reports the context the variant
was actually loaded with.

The turn measured is the worst realistic one: the system prompt, **six** past
turns at the length this model writes, and the question.

| | chars | tokens |
|---|---|---|
| the data sheet alone | 2 938 | — |
| the whole system prompt | 6 881 | — |
| the whole turn | 9 613 | **3 296** |
| the reply | — | 174 |

**2.92 characters per token** on Swedish, which is the figure to reach for when
estimating the next thing rather than measuring it. (The 3.4 the context budget
was written against was an estimate; this is the measurement, and it is worse,
so the budget is conservative in the right direction.)

**`num_ctx` is 65 536**, reported by `/api/ps` for the loaded model. Ollama
0.33.2 takes it from the model rather than the old 4 096 default, and
`qwen3.6:27b` declares 262 144. So one turn uses **5.3 percent** of the window
and leaves **62 066 tokens** of margin.

The `CONTEXT_CHAR_BUDGET` of 9 000 characters is therefore not about the model
at all — it is about keeping the sheet small enough to be read. A sheet three
times this size would still fit and would be worse.

Before the data sheet (D155) the block was a dozen aggregates at about 1 100
characters. The new one is 2 938 on the same account and is held under 9 000 by
a test on a synthetic account with four weeks in every domain.
