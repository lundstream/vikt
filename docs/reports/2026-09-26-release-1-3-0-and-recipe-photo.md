# Session report, 2026-09-26: 1.3.0 released, the release block, the recipe photo

All six items are done. **Production runs 1.3.0** from `392b618`, tagged `v1.3.0`, with all thirteen release steps passing. On `dev`, the release block (D194) and the recipe photo (D195) are built for 1.4.0 and not deployed. CI is green on `626dbf6`, the last code commit.

## Before the release

1. **§7** (`a8d360b`): recurring error classes one to nine above class ten, the unnumbered candidate class, the two time rules, and the rule that the session report is a file. This is the first such file.
2. **The 1.3 post and the harness** (`7a6bfda`):
   - The photo sentence now ends "och visas bara för dig, om du inte delar måltiden."
   - The harness lives in `scripts/harness/`, run with `pnpm harness:sweep` and `pnpm harness:hero`. Credentials come from the environment or `.env`; none are in a tracked file.
   - The sweep from its new place: 45 of 45.
3. **The deletion path, through the interface** (`392b618`): 30 of 30. Two throwaway accounts were made from administrator invites.
   - The author set a display name and shared a meal with a photo. The reader saved a copy, logged it once from Mat and reported the original.
   - The author then deleted their account, with the password and the address typed out.
   - Afterwards:
     - the share was gone from the reader's "Delade måltider"
     - the copy stayed, with its photo loading from the reader's own folder and "från Raderakocken"
     - the reader's day was unchanged, row for row
     - the report went with the meal, as D192 says (`meal_reports` cascades)
     - the author's photo folder was gone
   - The reader was then deleted the same way, and neither account can sign in. I ran the exercise twice, the second time after the fix below, so **four** throwaway accounts were created and all four deleted. Nothing else was deleted.
   - **Found: "1 foton" and "1 matrader" on the deletion sheet.** This is class two: `plural()` existed and these call sites went around it. Every sentence that opens with its count now goes through `plural()`, and `i18n.test.ts` fails one that does not. I watched that test fail on the old call before it passed.
   - **A render test had pinned the error.** It expected "1 rader utan träff" and now expects "1 rad".

## The release (item 4)

**Before the command:**
- `/var/lib/vikt/media` is a directory, owned 1000:1000, mode 700. The release user is uid 1000 and in the `docker` group.
- The workstation's Ollama lists `qwen3-vl:8b` and answered `{"svar": "ja"}` in 8 tokens. The production host reaches it.
- `host-scripts.mjs`:
  - `check`: both scripts differed from HEAD.
  - `install`: wrote both.
  - `check` again: both equal to `392b618`.
  - The cron line was not installed (D103).

**The dry run stopped at step 9, and it should not have.** The plan was what item 4 asked for: `setting: MEDIA_HOST_DIR (new)`, and "required by the release and not set: none". Its only `blocked:` lines were the two `:1.3.0` images answering 404. Those cannot exist during a dry run, which skips the tag and the build and then asks for them. I started the real run on that reading. It passed step 9 cleanly, and the dry run is now fixed (D194, below).

| step | evidence |
|---|---|
| 1 workstation | `VIKT_HOST` set, `PORTAINER_TOKEN` set, gh authenticated |
| 2 tree | clean, on `dev`, pushed, at `392b618` |
| 3 CI | success for `392b618` |
| 4 backup | `vikt-20260926T133431Z.dump`, 320K, with `media-20260926T133431Z.tar.gz` beside it (111 bytes, the empty photo directory) |
| 5 restore | `daily_log 73, food_entries 310, plans 2, users 4, weight_log 108`, restored copy and live database agree |
| 6 main | fast-forwarded 19 commits to `392b618` |
| 7 tag | `v1.3.0` on `392b618` |
| 8 workflow | run `36245630030` green |
| 9 plan | nothing blocks this deploy; `setting: MEDIA_HOST_DIR (new)`; `IMAGE_TAG 1.2.1 -> 1.3.0` |
| 10 deploy | both containers on the new image, API healthy, `the vision model can see` |
| 11 API log | `version 1.3.0, commit 392b618`; `Migrations: 4 applied, 36 recorded in total` (0032 to 0035); VAPID key unchanged |
| 12 outside | `/api/health` 200, `/` 200, and `/app/` 200 afterwards |
| 13 Nyheter | published "Vikt 1.3", 1676 characters, not mailed |

**Lighthouse, once, on the production landing page:**
- Scores: performance 98, accessibility 100, best practices 100, SEO 100.
- Timings: largest contentful paint 1,8 s, layout shift 0, blocking time 0 ms.
- Speed index 3,7 s, against 1,7 s on the local preview build in September. This run crossed the real network and TLS.

STATE.md records production at 1.3.0 with its commit and tag.

## After the release, on `dev`

5. **The release block** (`b417005`, D194).
   - **What it reads:** `release.mjs` takes stack variables from the one ```` ```release ```` block under "Inför nästa deploy", and nothing else. `NAME=value` is set as a value; a name alone is a secret, passed with `--set-from-env`.
   - **What stops it:** no block means no variables. Two blocks, an unclosed block, a fence that nearly says `release`, a name twice, or a line it cannot read stop the command before step 1. The unreadable line is named by its number and never quoted.
   - **The dry run:** it now accepts exactly the two 404 lines for its own version's images. Anything else still blocks.
   - **Tests:** ten new ones, including the backtick case and prose, inline code and a by-hand command being ignored. I put four of the old behaviours back one at a time, and each failed its test.
   - **Documents:** INFRA.md (local only), §7 and STATE.md say the same.
6. **The recipe photo** (`626dbf6`, D195).
   - **The probe:** five prompts, three runs per photo. Asked to split rows into fields, the model read every figure right and filed them in the wrong fields. Asked for lines alone, it returned the cookbook page's seven rows and both amount sets as printed, 3 of 3. The gate passed, and the model's rows, with what it got wrong, are in D195 without the book's running text.
   - **Who splits and counts:** the app splits the lines, in `shared/recipe-photo.ts` under test. The app also counts the amount sets from those lines, because the model's own answer to "are there two sets" was wrong in all four prompts that asked it. The model still returns both amounts and never chooses between them.
   - **Exercised with both photos to two saved meals:** 22 of 22.
     - Cookbook page: the set choice asked once, "kontrollera mot sidan" on the mozzarella row only, 0,39 in its field, the range empty with "inte än", and "Receptet: 1 PIZZA" beside an empty portion field.
     - Screen photo: 16 rows, printed weights 390 and 90, and "4 portioner" filling the count.
   - **Found and fixed:**
     - After "Lägg till", the meal sheet closed the tool. Rows it could not add disappeared unseen, for the sentence and plate tools too. They stay now: 7 of 7.
     - At 360 px the check chip squeezed a long name to "m.".
     - An unmatched row said "sparas utan energivärde", which is untrue in the meal sheet.
     - Rechecked at both widths: 10 of 11. The eleventh was my own check, asking for a long name in full where the list truncates every long name by design.
   - STATE.md names the next deploy `1.4.0`, with a Nyheter draft.

## For you

- **Check three things in production.** I did not sign in there.
  - Administration › Backup › "Kör nu" once: the run line should end in "0 foton".
  - On a phone, Mat should show the saved meals at the top, each with "kcal per portion".
  - Nyheter should show "Vikt 1.3" at the top.
- **The shared food matcher picks wrong foods.** It took "Mjölkchoklad" for "mjölk", "Pepparrot" for "peppar" and "Lasagne nötfärs" for "nötfärs", and every tool uses it. The printed line beside each recipe row makes this visible, but the matcher itself is not fixed.
- **Two LAN addresses reached the public history.** My 1.3.0 record in `829daf5` put them in STATE.md. They are removed in this commit but remain in that commit. They are private addresses and no secret, and I did not rewrite history.
- **One deviation from the brief.** The brief had the model report that it saw two amount sets. Its reports were unreliable, so the app counts the sets from the lines the model returned.

Nothing of the six items remains.

## Closing sweep

```
ok   landing 360 height=6796 capture=beyond-viewport charts=0 nav=0 overflow=0px text=3757 track="" landing-ok=sentence15/meta13/gap64
ok   landing desktop height=5206 capture=beyond-viewport charts=0 nav=0 overflow=0px text=3757 track="" landing-ok=sentence15/meta13/gap64
summary checks=45/45 failed=0 complete=true
```
