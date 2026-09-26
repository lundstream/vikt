# Session report, 2026-09-26: the phone test, and 1.4.1 in production

All four items are done. **Production runs 1.4.1** from `da88d0d`, tagged `v1.4.1`, with all thirteen steps passing. It was released after items 1–3 were pushed with CI green for that exact commit and the dry run came back green.

## 1. Why "En mening" said "Tolkningen är inte igång just nu" (`43ca994`, D199)

**It was none of the three explanations.** I read the logs before restarting anything:
- **Production API:** every `POST /api/llm/parse-food` between 18:17 and 18:23 UTC returned 200. The first took 8 624 ms; the next eight took 224–415 ms. There were no warnings and no errors. A refusal travels as `{ available: false, reason }` inside a 200 (D6), so the status codes alone could not tell a parse from a refusal.
- **Ollama on the workstation:** the same nine `POST /api/chat` requests, all 200. The first loaded gemma4:e4b, the text model, in 7,27 s; the rest took 215–408 ms. **The server was up, and no request timed out while a model loaded.**
- **Dev**, which runs 1.4.0's API code on this path: both of your sentences came back `unusable_output`.

**The model answered in a shape the app couldn't read.** In free JSON mode, gemma4:e4b wrote "Ett glas mjölk" as valid JSON with one food split into two objects: `{"items":[{"name":"mjölk","portion":{…}},{"estimatedGrams":250,"confidence":0.9}]}`. The reader refused it, correctly. The client, which reads every refusal as the model being away, then said "inte igång". Your 1.3.0 client read the API's answer correctly, and nothing had changed there between 1.3.0 and 1.4.0.

**The fix is at the source: the shape is now requested with a schema**, as the label and recipe readers already do. Over twenty everyday sentences:

| mode | sentences refused |
|---|---|
| free JSON, as before | 7 of 20 |
| schema | 1 of 20 |
| schema, with the reader repairing an empty unit (`{"count":1,"unit":""}` for "ett äpple" is read as "st") | 0 of 20 |

**A refusal now says what happened:** `unusable_output` shows "Tolkningen förstod inte meningen. Skriv den på ett annat sätt, eller sök upp maten själv."

**Tests:**
- The route sends the schema, not free JSON mode. That test fails on the old service.
- Production's split reply, verbatim, is still refused as unusable output.
- An empty unit is read as "st".

**Through the interface:** "ett glas mjölk" in "En mening" on Mat proposes "Mjölk fett 3% berikad", 1 glas, 250 g.

**The model server:** Ollama on the workstation is the instance a session started from its shell at 13:20. Its parent process has exited and Ollama kept running, so it was not stopped with the shell. The condition for the §7 rule (started from a session's shell *and* stopped with it) did not occur, so I did not add the rule.

**How it should run:** as it normally does, from Ollama's own shortcut in the user's Startup folder. That starts it at login, as the logged-in user, independent of any terminal. The next reboot or login puts it back that way.

**Not changed:** the plate photo still uses free JSON mode. It has not been seen failing this way, and a schema for it needs its own probe on the vision model.

## 2. Välj bild (`43c00fb`, D200)

**Each photo tool now has two actions side by side:** the camera, as before, and "Välj bild", which has no `capture` and opens the gallery or files. That covers the plate photo, the recipe photo and the label photo.
- **One shared control, `PhotoInputs`**, so the three can't drift apart.
- **Both actions go through `preparePhoto`**: resized and re-encoded as JPEG in the phone, which drops location and camera data. A PNG screenshot takes the same path.
- **An undecodable file** gets "Bilden gick inte att läsa. Ta en ny." in the sheet, never an error page.
- **The meal's own photo already opened the gallery**, so it's unchanged.
- **The recipe intro now says** a screenshot of a recipe on the web works, and often best.

**Found by exercising it:** a screenshot's yield read "4 portioner · 30 min", and the portion count stayed empty. A count followed by a separator now fills it. "4 portioner pizza", with no separator, still doesn't.

**Through the interface, 30 of 30**, at 360 px and desktop, with the real models:
- **Plate photo:** a picked JPEG was read into rows.
- **Label photo:** a picked JPEG was transcribed.
- **Recipe photo:** a PNG screenshot of a recipe page gave five rows. That page was made for the test: a pancake recipe in my own words. "4 portioner" filled the count, I typed in the amounts the catalogue can't convert, and it saved as a meal of four portions.
- **Unreadable file:** a text file named `.png` got the unreadable message.
- **The meal's own photo:** its input has no `capture`.

**Tests:**
- The camera input has `capture` and the gallery input doesn't.
- No component but `PhotoInputs` writes `capture`, and all three tools use it. Both checks fail on the old plate photo. A first version of the `capture` check read `image/*` as the start of a comment and deleted the line it was looking for, so I fixed it and saw it fail properly.
- `parseYield` accepts a separator, and that test fails on the old function.

## 3. The meal photo's line (`f7111da`, D201)

- **The line now reads** "Bara du ser det, om du inte delar måltiden.", which is the privacy page's own promise.
- **It was the only one that disagreed.** I searched every string and page for a promise about who sees a photo: the privacy page, the sharing sheet, the notes on the photo tools that say the image is not stored, and the landing page.
- **A test now fails on any photo promise without the exception.** It fails on the old line.
- **In the sheet:** 4 of 4 at 360 px and desktop.

## 4. 1.4.1 in production

**Before the command:**
- CI was green for `da88d0d`.
- **Every model production uses answered** `{"svar": "ja"}`:
  - gemma4:e4b, the sentence tool: 156 ms
  - qwen3.6:27b, the coach: 27,6 s, including loading
  - qwen3-vl:8b, the photos: 11,4 s, including loading

  The first two are the defaults and aren't set in the stack. The third is `LLM_VISION_MODEL`, read from the stack by name alone.
- The production host reaches Ollama, and the host scripts are equal to `da88d0d`.
- **The dry run was green**, exit 0, and now ends "1.4.1 is not live".

| step | evidence |
|---|---|
| 1 workstation | `VIKT_HOST`, `PORTAINER_TOKEN`, `PORTAINER_URL` set, gh authenticated |
| 2 tree | clean, on `dev`, pushed, at `da88d0d` |
| 3 CI | success for `da88d0d` |
| 4 backup | `vikt-20260926T185624Z.dump`, 328K, and `media-20260926T185624Z.tar.gz`, 121 KB, which now holds the first meal photo in production |
| 5 restore | `daily_log 73, food_entries 313, plans 2, users 4, weight_log 108`, restored copy and live database agree |
| 6 main | fast-forwarded 6 commits to `da88d0d` |
| 7 tag | `v1.4.1` on `da88d0d` |
| 8 workflow | run `36264308998` green |
| 9 plan | nothing blocks this deploy; `IMAGE_TAG 1.4.0 -> 1.4.1`, no variable set |
| 10 deploy | both containers on the new image, the API healthy, `the vision model can see` in 1 710 ms |
| 11 API log | `version 1.4.1, commit da88d0d`; `Migrations: none to apply, 36 already recorded`; VAPID key unchanged |
| 12 outside | `/api/health` 200, `/` 200, `/app/` 200 |
| 13 Nyheter | published "Vikt 1.4.1" as `354abaf8-0df7-4441-9c73-ccdffaf3385f`, 839 characters, not mailed |

**Lighthouse was not run.** No landing page file changed between 1.4.0 and 1.4.1.

**STATE.md:** production runs 1.4.1 with its commit and tag, and "Inför nästa deploy" starts over. Rollback is `stack.mjs deploy 1.4.0 --keep-file --yes`, since no migration ran.

## For you, on the phone

I didn't sign in to production. To check:

1. **Reload first:** tap the "En ny version finns" banner, so the phone runs 1.4.1.
2. **Mat, "En mening":** "ett glas mjölk" should propose milk, about 250 g.
3. **Måltider, Ny måltid, "Recept från foto":** "Välj bild" should open the gallery, and a screenshot of a recipe from the web should be read into rows.
4. **A meal's sheet:** under the photo it should say "Bara du ser det, om du inte delar måltiden."
5. **Nyheter:** "Vikt 1.4.1" should be at the top.

## Closing sweep

```
ok   landing 360 height=6796 capture=beyond-viewport charts=0 nav=0 overflow=0px text=3757 track="" landing-ok=sentence15/meta13/gap64
ok   landing desktop height=5206 capture=beyond-viewport charts=0 nav=0 overflow=0px text=3757 track="" landing-ok=sentence15/meta13/gap64
summary checks=45/45 failed=0 complete=true
```
