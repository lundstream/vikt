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
| `qwen3.6:27b` | yes | yes, circle and square with colours | "IKT" | **16.7 s** |
| `qwen3.6:latest` | yes | yes, and described the layout | "UIKIT" | 30.1 s |
| `odytrice/gemma4-31b:5090` | yes | yes, colours and background | "VIKT" | 94.3 s |
| `gemma4:e4b` | yes | **no**: "du har inte tillhandahållit någon bild" | — | 21.0 s |

`gemma4:e4b` is the finding worth keeping: it advertises `vision`, accepts the
request, and answers as though no image was attached. A flag is not a test.

The times are for a 2 kB image on an idle box. A photograph is two orders of
magnitude larger and will not be anywhere near this fast, which is why the
waiting state on the screen has to quote a measured figure rather than a hope.

**Not yet measured: a real plate.** That probe needs a photograph taken by
somebody, because a stock image is a picture a model may have been trained on,
and it is the only test that answers the question the feature depends on.

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
