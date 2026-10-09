# Decisions — pdd-aggregator

**Owner:** the PR that makes the choice · **Edit trigger:** a PR makes a contested or
irreversible call a future reader would otherwise undo
**Do NOT put here:** how things work (that is `CLAUDE.md` / `README.md`), traps that
repeat (`../pdd-seo-tools/docs/LESSONS.md`), or anything reversible and obvious.

Append-only. Each entry: what was decided, what was rejected, the evidence, and
**the trigger that would reverse it** — because a decision with no reversal condition
is a superstition.

This repo writes to the live database on a schedule with nobody watching, so the
entries below are mostly about what the pipeline is **forbidden** to do.

---

## Standing law · A past `draw_date` alone never ends a draw.

**Decided:** `staleDateDecision()` (`lib/verify.mjs`) may only end a row on the
operator's own evidence:

```
!reachable            → hold   (no evidence)
purchasable === null  → hold   (no evidence)
purchasable === false → END    (the operator has closed it)
purchasable && a later date is readable and newer than stored → EXTEND
```

**Rejected:** the obvious "the date has passed, so it is over".

**Evidence:** operators extend draws routinely, and 615 rows (44% of `status='active'`)
carry a past `draw_date` at any moment. Of those, the sweep's own dry run finds **~210
are still purchasable** — live, enterable draws. Blanket-ending on date would have
un-published every one of them. The asymmetry was breached once, on PR #40, caught in
review, and the first live run had to be rolled back; `deadDraftDecision()` carries that
note.

**Reverses if:** never on the principle. The evidence sources may improve — see the next
entry.

**Corollary — one writer per transition.** `ended-sweep.mjs` owns `status`; anything
correcting dates owns `draw_date`. Two writers on one column is how a fix and a sweep
undo each other nightly.

---

## Standing law · Absence from a feed is not evidence.

**Decided:** every adapter reports how many of *our stored rows* it matched, and a
non-match authorises nothing.

**Rejected:** treating "not in today's product feed" as "this competition finished".

**Evidence:** an operator changing their URL scheme, adding a WAF, or paginating
differently makes every row vanish from the feed at once. Without this rule that reads
as "every competition finished today" and the sweep ends the operator's entire
inventory. Related: PR #39 — 420 draws/day were being blamed on the parser when a WAF
was refusing the page. **Never score a block as "the site is down".**

**Reverses if:** never.

---

## 2026-09 · `api` adapters produce no liveness evidence, and that is a known gap.

**Decided:** the `raffle-engine` / `hydra` / `inertia` adapters answer only "in the live
feed / not in the live feed", and per the rule above that means they authorise nothing.
**406 stale rows therefore sit on `hold` indefinitely** — the largest single verdict
bucket.

**Rejected:** relaxing the evidence rule for these adapters to drain the backlog.

**Evidence:** relaxing it would re-introduce exactly the failure the standing law exists
to prevent, on the adapters least able to distinguish a WAF from a finished draw.

**The fix, when it comes:** a direct per-URL probe fallback for rows the feed does not
match, so they get a real `purchasable` answer instead of an indefinite hold. That is
additive evidence, not a weakened rule.

**Reverses if:** the probe lands. Until then, the backlog is the honest cost of not
guessing.

---

## Standing law · `prize_value` is written NULL by every insert path.

**Decided:** `run.mjs:413` and `manager/draw-insert.mjs:114` both hardcode
`prize_value: null`. Never backfill it.

**Rejected:** deriving it from the prize text or the operator's advertised RRP.

**Evidence:** an operator's RRP is a marketing number. Publishing an unverifiable
valuation beside gate-enforced odds makes the guess and the measurement look alike.
Full reasoning in `../prizedrawsdaily/DECISIONS.md`.

**Reverses if:** an independently verifiable valuation source exists and can be
attributed on the page.

---

## Standing law · `total_entries` is a required field, so odds coverage is 100%.

**Decided:** `gate.mjs` `REQUIRED_FIELDS` includes `total_entries`. A draw missing it is
**dropped, not drafted**.

**Rejected:** listing draws without a published cap and estimating, or hiding, the odds.

**Evidence:** the site's one real differentiator is that every published odd traces to
the operator's own published cap — not that it publishes odds at all (competitors do
that too; compwatch.co.uk also publishes live tickets-sold, which we do not). What we
have is that the number is never estimated. That property only holds if the gate is
absolute. `lib/parse.mjs:135-175` protects it further with a VETO regex that kills any
number near `sold|remaining|left|used|gone|claimed`, so a "% sold" progress bar can
never become a cap.

**Reverses if:** never, while odds are presented as fact.

**Cost, accepted knowingly:** real draws are dropped when an operator does not publish a
cap. That is the right trade.

---

## 2026-09-10 · `tripwire.md` is generated and says so.

**Decided:** `manager/tripwire.mjs` stamps
`<!-- GENERATED — do not edit -->` at the top of every write.

**Evidence:** it is the most accurate document in the fleet — it reported the 615
stale-active rows before anyone noticed them — precisely because it is rewritten daily.
A hand-edit is silently lost on the next run and the person who made it never finds out.

**Note:** the file is **gitignored** (`.gitignore:43`), so no CI rule can enforce the
header — it is a run artifact that only ever exists on a runner or a working copy. The
header is therefore a message to whoever opens it, not a gate. That is also why
`ci-checks.mjs` in `pdd-seo-tools` checks only *tracked, repo-local* generated docs.

**Reverses if:** the file stops being regenerated, at which point it should be deleted
rather than maintained.

---

## 2026-09-12 · Every Storage upload carries a long-lived `Cache-Control`.

**Decided:** all uploads go through `uploadHeaders()` (`lib/storage.mjs`), which sets
`cache-control: public, max-age=31536000`. A body-carrying write to Storage that
hand-rolls its own headers is a test failure (`test/storage.test.mjs`).

**Rejected:** leaving it to each call site. Three sites (`lib/rehost.mjs`,
`compress-images.mjs`, `carousel/publish.mjs`) each built their own header object and
**all three** omitted cache-control. This is not a thing people remember.

**Evidence:** an upload with no cache-control header is stored by Supabase as
`cacheControl: "no-cache"`. On 2026-09-12 that was **100% of the bucket** — 5,397
objects, 596 MB, not one exception. The site renders every image through
images.weserv.nl, and weserv honours the origin:

| origin `cache-control` | weserv          | consequence                              |
|------------------------|-----------------|------------------------------------------|
| `no-cache` (ours)      | `BYPASS`        | re-downloads the **full-size original** from Supabase on **every impression** |
| `public, max-age=…`    | `MISS` (storable) | downloads once                         |

So a 205 KB original was re-fetched from Supabase every time anyone loaded a card
showing its 76 KB thumbnail. 596 MB of stored images produced **6.37 GB of egress**
against a 5 GB free-tier limit — 12.7x the size of the entire bucket — and put the org
over quota with restriction scheduled for 12 Oct 2026. Storage was never the problem:
file storage sat at 0.40/1 GB the whole time.

**Verified before shipping, not assumed:** a probe object uploaded with the header
served `public, max-age=31536000` on GET and flipped weserv from BYPASS to MISS.

**Trap this cost us once:** `curl -I` (HEAD) against Supabase Storage reports
`no-cache` even for a correctly-cached object — only a **GET** shows the true header.
The first read of this incident was nearly abandoned on that false signal. Always
verify a Storage cache header with GET.

**Not `immutable`:** these keys are upserted in place (`compress-images.mjs` rewrites
the same path; a re-ingest can replace a draw's photo), so a client that chooses to
revalidate must still be able to pick up replaced bytes.

**Reverses if:** images stop being served through a shared proxy AND move to a host
whose egress is free, at which point the TTL stops being load-bearing — not before.

### Backfilling it: two cheaper routes were tested and BOTH FAIL. Do not retry them.

Supabase has no metadata-only update, so fixing the ~5,400 existing objects means
re-uploading the bytes — one download each. Before accepting that cost, both zero-egress
shortcuts were tried against the live bucket on 2026-09-12:

1. **Patching `storage.objects.metadata->>'cacheControl'` in Postgres.** The row updates and
   reads back correctly, but the **served header never changes** — the serving layer does not
   read that row. `backfill-cache-control.mjs` originally did this; its own verify step caught
   it, rolled the probe back and refused to continue, which is why the guard exists.
2. **`POST /storage/v1/object/copy` with a `cache-control` header and `copyMetadata:false`.**
   Returns 200 and creates the object with `cacheControl:"no-cache"` regardless.

Only a normal upload carrying the header works. So the backfill is scoped by what actually
costs egress — images on **live** draws (1,580 obj / ~179 MB) carry nearly all the benefit,
versus 595 MB for every referenced object; 34 orphans are never fetched and are skipped
entirely.

### Two measurement traps, both of which produced a false conclusion in-session

- **HEAD lies.** `curl -I` against Supabase Storage reports `no-cache` even for a correctly
  cached object. Only a GET shows the true header.
- **The CDN ignores the query string when building its cache key.** A `?bust=` param does NOT
  force a fresh response: a freshly re-uploaded object keeps serving the OLD header with
  `cf-cache-status: HIT` for roughly **15-30 seconds** before the CDN revalidates. Verifying
  immediately after an upload reports a false failure — `servedCacheControl()` polls for this
  reason. The object's stored metadata is correct the instant the upload returns; only the
  edge lags.

---

## 2026-10-09 · Draw photos live on Cloudinary, the Supabase bucket is emptied, and photos have a lifecycle.

**Decided:** new photos are written to Cloudinary (`IMAGE_PROVIDER=cloudinary`). **Every**
photo and logo on the live Supabase bucket is copied there, any status, with a byte-exact
local backup taken from the same download (`migrate-images.mjs`). Once every row points at
Cloudinary and every copy verifies, the Supabase `draw-images` bucket is **emptied**, so the
Supabase project holds only its database (gate: `lib/migration.mjs` `emptyGate`). Every day,
after the ended-sweep, a photo whose draws have **all** been over for `RETENTION_DAYS` (180)
is set to null (the category cover) and then deleted from Cloudinary.

**Why empty the bucket rather than freeze it:** a frozen bucket at 97% of its quota is one
stray write — a missed cowork routine, the admin importer, a manual upload — from a 402 on
every API, site included. An empty one restarts the storage counter from the carousel's few
MB, and the plain 70% storage alarm means something again.

**Why 180 days:** on Cloudinary storage is ~1 credit/GB of 25 free a month, so there is no
pressure to remove photos early and ended draws should keep them for months. The lifecycle
only has to exist; without one the account just fills more slowly.

**Root cause it answers — stored forever, deleted never.** Three quota incidents in two
months (Aug storage, Sep egress, Oct storage again: 1,004 MB of 1,024 MB on 2026-10-09 at
~14 MB/day) came from one habit: every ingest stores a photo and nothing removes one. On a
fixed-size free bucket that fills in ~2 months regardless of anything else. A new
organisation reset the counter and kept the habit — a third one would do the same.

**Rejected:**
- *R2* — the better product, built and tested (`R2.md`, #52), but Cloudflare will not enable
  it without a payment method and the owner declined to add one.
- *Backblaze B2* — 10 GB free, but a first **public** bucket requires payment history or a
  card fee.
- *Moving only the "necessary" photos and freezing the rest on Supabase* — the first version
  of this PR. Rejected by the owner on review: it leaves the 97%-full bucket as a standing
  hazard (above).
- *A new Supabase organisation/project for a fresh quota* — the Free plan caps **two free
  projects across all organisations**, the old dead project (`kkuuwksgyypicnblwubs`) still
  holds a slot and must not be deleted (~390 ended draws' only images, `pg_cron` job), and a
  new project means moving the whole database — every PostgREST/auth call site, every key,
  the cowork routine — to fix what is only a storage problem. It also resets the same clock.
  (The database DID later move to a new organisation, `pgsbumozdiqxvcdgjjdz`, but for a
  different reason: the old org's egress grace period ends 2026-10-13, after which every API
  402s. Photos still go to Cloudinary, never to the new project.)

**Guards that make it stick:** `emptyGate` refuses — deleting nothing — while any row still
points at Supabase or any referenced object lacks a byte-exact backup or a verified copy;
`storage-watch.mjs` (70% Supabase storage; any new object in `draw-images` after the switch;
"provider on, credentials broken"; 70% of Cloudinary credits); the workflows test that pins
both sweeps to the same provider; and `sameObject()` so rehost cannot delete the webp it has
just uploaded (on Cloudinary *image* assets `x.jpg` and `x.webp` are one asset — uploads are
raw since the next decision, where they are two).

**Not automated:** the bulk delete that empties the bucket. `--phase=empty-check` evaluates
the gate read-only; the delete itself waits on the owner's explicit go-ahead.

**Reverses if:** a payment method goes on the Cloudflare account → move to R2 (10 GB, egress
free; `migrate-images.mjs --to=r2`). Or Cloudinary usage sits above 70% of monthly credits
for two consecutive months → shorten `RETENTION_DAYS` before anything else.

---

## 2026-10-09 · Every Cloudinary upload is a RAW upload.

**Decided:** `cloudinaryUpload` posts to `/raw/upload` with the bucket key as the public_id,
extension included, and new rows point at `https://res.cloudinary.com/<cloud>/raw/upload/v1/<key>`.
The 8,760 photos migrated that night stay image assets on `/image/upload/v1/` (public_id
without the extension). Every reader that maps a URL back to an asset goes through
`cloudinaryAssetOf`, which knows both forms; `publicBases()` lists both; retention deletes
each asset through its own resource type; `cloudinaryInventory()` lists both.

**Why:** the first day on Cloudinary used 80% of the Free plan's 25 credits. The usage API on
2026-10-09: **18,639 transformations (18.64 credits)** against ~8,870 uploads and **1 derived
asset** — we never asked for a transformation, so the uploads themselves were metered, about
**2 per image upload**. Cloudinary meters transformations and bandwidth over a **rolling 30
days** (no reset on the 1st), so that one night stays on the meter until about 8 Nov. At
~130–170 new photos a day, image uploads alone would add ~9 credits a month on top — over the
limit within about two weeks, and an account left over its limit is eventually disabled,
delivery included. A raw upload costs no transformation credits.

**What raw gives up:** nothing we use. Cloudinary serves a raw file byte-for-byte; we never
used its transformations (images.weserv.nl resizes). Probed 2026-10-09: a raw `.webp` serves
`content-type: image/webp` with `public, no-transform, immutable, max-age=2592000` — the same
cache header as the image assets — and weserv resizes it.

**Guards:** `test/cloudinary.test.mjs` pins the `/raw/upload` endpoint and the
extension-keeping public_id in the multipart body that goes over the wire, both URL forms in
`publicBases`/`cloudinaryAssetOf`/`sameObject`, and per-type delete endpoints;
`test/retention.test.mjs` pins a mixed inventory deleting each asset through its own type.
`storage-watch.mjs` alarms at 70% of credits and now says "last 30 days", not "this month".

**Not done:** re-uploading the 8,760 migrated image assets as raw. Their transformations are
already counted; re-uploading would only add storage churn. They age out with retention.

**Reverses if:** Cloudinary stops counting image uploads as transformations, or we need a
Cloudinary-side transformation (an image asset is then the only option for that file).

## 2026-10-09 · Supabase egress is watched through the API request counter, not a usage API.

**Decided:** `usage-watch.mjs` runs daily in the render workflow. It reads
`public.api_request_total()` (sql/2026-10-09-usage-snapshots.sql, applied once by hand in the
SQL editor), which sums pg_stat_statements calls of PostgREST's per-request
`select set_config('search_path', …)` preamble by role (anon = the site, service_role = the
scraper, authenticated = signed-in users) plus the Storage API's preamble. It keeps one row a
day in `public.usage_snapshots`, turns consecutive snapshots into requests/day, and projects a
month at a calibrated bytes per request. 50% of the 5 GB quota opens a `usage-alarm` issue
and leaves the run green; 80% turns it red. No install yet, or a failed read, is "no signal":
never an alarm, and never a reason to close one.

**Why:** the old org went over its egress quota in Sep and again in Oct 2026; after a grace
period every API returns 402 and the site goes down. Both times the dashboard was the first
signal. The Management API has request counts and logs but no egress figure (checked against
its OpenAPI on 2026-10-09), and a personal access token carries the owner's full account
privileges, which is too much to leave in CI for a counter. The database's own counter needs
nothing new: the scraper's existing service_role key reads it through a function that
returns counts only, never query text.

**Calibration:** 4,200 bytes/request by default. On 2026-09-12 the dashboard's per-source
breakdown showed 101.19 MB of PostgREST egress in a day; the old project's counter averaged
~24.5k REST requests/day over 20 Aug–9 Oct (1,144,347 anon + 81,348 service_role calls). That
day predates site PR #117's payload cut, so the figure errs high and the alarm fires early.
Recalibrate with a week of snapshots against the dashboard (lib/usage-watch.mjs says how) and
set `USAGE_BYTES_PER_REQUEST`.

**Also decided, same PR:** run.mjs reads ended rows lean. Full columns only for active/draft
(the only rows routing compares field by field); ended rows get
id/entry_url/slug/status/draw_date/category_source. Measured on the live table (9,335 rows,
6,268 ended): 2,083 KB → 1,284 KB on the wire per run. The identity read still covers EVERY
row, although an ended-only identity read would save another ~230 KB: with two disjoint
reads, a row that flips status between them is in neither, and a missing row looks brand new
and is inserted twice. `test/existing.test.mjs` records, through a Proxy, every field routing
reads from a non-mutable row and fails if one falls outside the lean column list.

**Reverses if:** Supabase ships an egress figure in the Management API (read it directly), or
pg_stat_statements stops recording the PostgREST preamble (the counter reads 0; the
watch would then report no traffic, which the first week's calibration would expose).
