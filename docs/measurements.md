# Measurements

Numbers this project has actually taken, and the conditions they were taken
under. Nothing here is an estimate or a target.

The landing page quotes the tap counts below, and
`apps/web/test/landing-figures.test.ts` reads this file to check that it still
does. If the fast path changes and the page does not, the suite fails and the
message says the page is claiming something that was true last month — which is
the only way a marketing number stays honest.

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

Asked before anything was built on the answer, with `scripts/probe-vision.mjs`
against `OLLAMA_URL` on the LAN. Ollama reports a `vision` capability for four
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

Audited programmatically across six screens on **both themes** after the theme
setting landed (D117): **zero** contrast failures against WCAG AA, and a visible
focus ring on all 186 interactive elements.
