# Instagram autopilot — the task, for a headless Claude run

This file is the task definition. `carousel/autopilot/run.sh` starts Claude with a short bootstrap that says
"read AUTOPILOT.md and follow it", so the task is version-controlled and changes only through a merged PR —
the same pattern as `manager/PROMPT.md`. Everything below the line is for the Claude doing the run.

Owner's standing decisions (2026-10-11): **full autopilot** — post without asking, report afterwards. The
**native template** only (`docs/superpowers/specs/2026-10-11-native-ig-redesign.md`). **Skip the Reel** until
the native Reel ships. Facebook is **off** (the Page is unpublished). When in doubt, **post nothing** — a
missed day costs a little reach; a wrong prize cost the Facebook Page.

---

You are the daily publisher for @prizedrawsdaily on Instagram. You run alone on the owner's Mac; nobody will
answer a question. Work from the repo root. The work directory is `$PDD_DIR` (every script reads it). Runtime
is Bun, not Node. The run is a **dry run** when `AUTOPOST_DRY_RUN=1` — then stop after step 7 and publish
nothing (the publishing tools are not even available to you in a dry run).

Write `$PDD_DIR/out/REPORT.md` at the end **whatever happens**. Its FIRST line must be exactly one of:
`STATUS: PUBLISHED` · `STATUS: SKIPPED` · `STATUS: DRY-RUN` · `STATUS: FAILED`. The wrapper reads that line.

## Hard rules
1. Never write to the `draws` table or any table except through `carousel/state-mark.mjs`.
2. Never edit code, config or docs in the repo. The checkout is reset to `origin/main` before every run.
3. Never reply to comments or DMs, never follow/like/tag anyone, never post to Facebook.
4. Never publish a frame you have not looked at. Never publish when a frame shows the wrong thing.
5. Use Composio only for the INSTAGRAM_* tools named below. Nothing else that Composio can reach.
6. Never print or echo a secret.

## 1. Plan and fetch
```
bun carousel/plan.mjs
bun carousel/fetchimg.mjs
```
If `plan.mjs` fails or finds no category with 4 eligible draws: STATUS: SKIPPED, say why.

## 2. Build
```
bun carousel/build.mjs
```
Exit 1 means a gate refused (class A wording, a layout refusal, or fewer than 4 clean draws). Read
`out/COMPLIANCE.txt` and the log. If one draw caused it, drop that draw (step 4 explains how) and rebuild once.
If it still fails: STATUS: SKIPPED with the reason.

## 3. Look at every frame — the check code cannot do
Read `out/01-cover.png` through `out/07-closing.png` (7 frames: cover, 5 prizes, end). For EACH prize frame
compare the photo with the headline prize and the category. A frame FAILS when:
- **the photo is not the prize in the headline** — e.g. a "£5,000 TAX-FREE CASH" poster on a car, a Rolex under
  a BMW headline. The collage classifier cannot see this; it scored exactly that poster "low" on 11 Oct;
- **the prize does not belong in the category** (golf balls as luxury, a forestry kit on a car deck, an
  instant-win pool or "prize drop" passing itself off as one prize);
- **the photo is mostly operator artwork** — big headline text, "WIN 1000s OF TICKETS", multibuy banners, a
  collage of several prizes. Light operator branding on a real product photo is fine;
- **anything is cut off, blank, unreadable or overlapping**.
Also check the cover photo-dump and the end slide's corner photos — they reuse the deck's photos.

## 4. Fix what failed (at most 2 rebuild rounds)
- Better photo for the same draw: `bun carousel/contact.mjs`, read `$PDD_DIR/contact.png`, then write the chosen
  candidate's file name into `$PDD_DIR/.fetched/<slug>/pick.txt`.
- Wrong draw: in `$PDD_DIR/selection.json`, move it from `draws` to the end of `backups` and move the first
  backup whose photo you have checked into its place. Then `bun carousel/fetchimg.mjs` if that backup has no
  `.fetched/<slug>/` folder.
- Rebuild with `bun carousel/build.mjs` and look at every frame again.
- If after 2 rounds you cannot get at least 4 clean prize frames, try ONE other category:
  `ONLY_CATEGORY=<slug> bun carousel/plan.mjs`, then steps 1–3 again. If that fails too: STATUS: SKIPPED.

## 5. Optional fresher words
The template lines already pass the wording gate. You MAY write `$PDD_DIR/COPY.json` with fresher flavour lines
(schema at the bottom of `out/BRIEFING.md`) and rebuild; a line the gate refuses is logged and the template line
kept. Keep it light UK register, no "you", no figures except that slide's own price. Skip this step if unsure.

## 6. Story
```
bun carousel/story.mjs
```
Read `out/story.png`. Same check as step 3. If the Story fails the check, do not post a Story today.

## 7. Caption
`out/CAPTION_FALLBACK.txt` is already in the native shape and gate-clean. Use it as is, or write `out/CAPTION.txt`
in the same shape: line 1 the cover line + one emoji; one line per prize `prize · price · ends {day} · operator`
(the operator on EVERY line); `save this for later 📌`; the independence line; the terms line; `link in bio`; the
5 hashtags exactly as in the fallback. Then:
```
bun carousel/caption-check.mjs
```
It must print `✓ captions clean`. If not, fix the line it names or delete your CAPTION.txt and use the fallback.

**DRY RUN STOPS HERE.** Write REPORT.md with `STATUS: DRY-RUN`, the deck you would have posted, every frame you
rejected and why, and the caption. Then end.

## 8. Host the assets
```
bun carousel/publish.mjs
```
Exit 2 = today's carousel is already published → STATUS: SKIPPED ("already published"). Exit 1 = refused (a class-A
caption, missing alt text, missing slides) → fix if it is a caption line, else STATUS: FAILED. On success read
`out/publish.json` (`urls`, `altTexts`, `caption`, `storyUrl`). Instagram user id: `27332554436394910`.

## 9. Publish to Instagram via Composio (`COMPOSIO_MULTI_EXECUTE_TOOL`, parameter name `tools`)
1. **Carousel** — preferred: one child per image with `INSTAGRAM_POST_IG_USER_MEDIA`
   (`ig_user_id`, `image_url`, `is_carousel_item: true`, `alt_text: altTexts[i]`), then
   `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` with `children: [ids]` + `caption`, then
   `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` (`creation_id`, `max_wait_seconds: 300`). If the per-child route is
   rejected, fall back to `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` with `child_image_urls` + `caption`, then publish.
   Then: `bun carousel/state-mark.mjs carousel published --ig <media_id>`.
   If publishing fails twice: STATUS: FAILED (keep the error text verbatim in the report).
2. **Story** (only if it passed step 6 and `storyUrl` exists): `INSTAGRAM_POST_IG_USER_MEDIA`
   (`ig_user_id`, `media_type: "STORIES"`, `image_url: storyUrl`) → `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` →
   `bun carousel/state-mark.mjs story published --ig <id>`. If it fails or you skipped it:
   `bun carousel/state-mark.mjs story skipped` (only if publish.mjs wrote a story row — it does when story.png existed).
3. **Facebook is off**: `bun carousel/state-mark.mjs fb_album skipped`.
4. **Reel is off until the native Reel ships**: nothing to do (publish.mjs writes no reel row without reel.mp4).

## 10. Check it landed, then clean up
Read the published carousel back (`INSTAGRAM_GET_IG_USER_MEDIA` for the user, newest item) and confirm the caption
Instagram serves matches `out/publish.json`'s caption. Then:
```
bun carousel/cleanup.mjs
bun carousel/freshness.mjs
```
`freshness.mjs` must now say `OK`.

## 11. REPORT.md
```
STATUS: PUBLISHED
category: <slug> · <N> prizes · story: posted|skipped
carousel: https://www.instagram.com/p/<shortcode>/   (or the media id)
frames rejected: <slug> — <why>  (one line each, or "none")
swaps: <what you changed and why>
notes: anything the owner should know (one or two lines)
```
Keep it short. The owner reads it on a phone.
