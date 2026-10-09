# Moving draw images to Cloudinary

## Why

The Supabase Free plan gives this project **1 GB of storage**, and every API — reads,
writes, the whole site — answers **HTTP 402** once it is exceeded. The bucket has hit a
quota three times in two months:

| when | quota | what we did |
|---|---|---|
| Aug 2026 | storage size (2.43 GB of originals) | new organisation + compression |
| Sep 2026 | egress (`no-cache` uploads, weserv re-fetching) | cache-control on every upload |
| Oct 2026 | storage size again — 1,004 MB of 1,024 MB on 2026-10-09, ~14 MB/day | this |

### Root cause: stored forever, deleted never

Every ingest re-hosts the draw's photo and **nothing ever removes one**. At ~3,700 new
draws a month that is roughly 480 MB/month onto a fixed 1 GB box, so the box fills in
about two months *whatever else changes*. A fresh organisation reset the counter and kept
the habit. The fix:

- **every** photo and logo moves to Cloudinary, with a local backup of every object;
- the Supabase `draw-images` bucket is then **emptied**, so the project holds only its
  database — a fresh storage counter, not a bucket frozen at 97% and one stray write from
  a 402;
- photos of draws over for more than `RETENTION_DAYS` (**180**) are let go every day
  (`image-retention.mjs`), so Cloudinary tracks the inventory instead of the all-time total;
- `storage-watch.mjs` alarms at 70% instead of us finding out from a 402.

### Why Cloudinary, not R2

R2 is the better product (10 GB, egress free at any volume) and is already built
(`R2.md`), but Cloudflare will not enable R2 without a payment method on file and the
owner has declined to add one. Backblaze B2 needs payment history before a bucket can be
public. **Cloudinary's Free plan needs no card**: 25 credits shared between storage
(1 credit = 1 GB), bandwidth (1 GB) and transformations (1,000), with transformations and
bandwidth metered over a **rolling 30 days** (no reset on the 1st). We store ~1 GB and serve
originals only — images.weserv.nl fetches each one once and caches it. Over the limit the
account is warned, then eventually disabled (delivery included) rather than billed.

### Uploads are RAW (since 2026-10-09)

An **image** upload is metered as transformations even when nothing is transformed: the
migration night counted **18,639 transformations (18.6 of the 25 credits) for ~8,870 uploads
and 1 derived asset** — about 2 per upload, and on the meter for 30 days. So every upload is
a **raw** upload (`cloudinaryUpload`), which costs no transformation credits and is served
byte-for-byte with the same cache header and the right `image/*` content-type.

| form | URL | public_id | holds |
|---|---|---|---|
| raw | `…/raw/upload/v1/op/d.webp` | `op/d.webp` (extension kept) | every upload since 2026-10-09 |
| image | `…/image/upload/v1/op/d.webp` | `op/d` (extension = delivery format) | the 8,760 migrated photos |

Code that maps a URL to an asset uses `cloudinaryAssetOf` (both forms). Deleting a raw asset
through the image endpoint, or the reverse, answers `not_found` and removes nothing.
`migrate-images.mjs` alone still uploads image assets, so its own bookkeeping stays true.

**The database stays on Supabase.** Only the bytes move.

## What you have to do (I cannot do these)

1. Sign up at cloudinary.com (Google/GitHub, no card). Copy the **API environment
   variable** from the dashboard: `cloudinary://<api_key>:<api_secret>@<cloud_name>`.
2. Put it in **four** places. The fourth is the one that broke the August move:

| where | what |
|---|---|
| `~/pdd-aggregator/.env` | `CLOUDINARY_URL=…` and `IMAGE_PROVIDER=cloudinary` |
| GitHub secrets on this repo | `CLOUDINARY_URL`, `IMAGE_PROVIDER` — read by both scrape workflows, retention, tripwire and the storage watch |
| **the scheduled cowork routine** | it keeps its OWN env, in no repo and no `.env` (`COWORK.txt`, `manager/PROMPT.md`). Its `manager/draw-insert.mjs` / `draw-update.mjs` re-host images. Miss it and it keeps writing to Supabase — the storage watch says so within a day |
| Vercel env (site) | **not needed today**: the admin importer (`src/lib/import.functions.ts`) writes to Supabase directly, but it has never been used on this project (0 objects under `2026/`) |

## Run order

**Switch the writers FIRST.** With ~1 day of headroom, the bucket must stop growing before
anything else; the copy can take its time afterwards.

```sh
# 1. Switch every writer (GitHub secrets, the cowork routine's env, .env). From the next
#    scrape, new photos go to Cloudinary and the Supabase bucket stops growing.

# 2. Probe: one tiny upload, GET, delete — proves the key works and shows the
#    Cache-Control Cloudinary actually serves.

# 3. Rehearse on 20, then check them.
DRY_RUN=false bun migrate-images.mjs --phase=copy --limit=20
bun migrate-images.mjs --phase=verify --limit=20

# 4. Copy everything (+ the local backup, from the same download). Resumable: a re-run
#    reads anything already on disk instead of downloading it again.
bun migrate-images.mjs --phase=copy                          # dry run first: counts + MB
DRY_RUN=false bun migrate-images.mjs --phase=copy

# 5. Prove it landed: every referenced object at Cloudinary, right size, served cacheable.
bun migrate-images.mjs --phase=verify

# 6. Point the rows at it. Only rows still holding the URL we read are changed.
DRY_RUN=false bun migrate-images.mjs --phase=rewrite

# 7. Verify again, now through the rows' new URLs.
bun migrate-images.mjs --phase=verify

# 8. Read-only gate: may the bucket be emptied? Exits non-zero, naming every problem, if
#    any row still points at Supabase, or any referenced object lacks a byte-exact local
#    backup (size + sha256) or a GET-verified Cloudinary copy.
bun migrate-images.mjs --phase=empty-check

# 9. Empty the bucket — NOT automated yet. See "Emptying the bucket" below.
```

The local backup lands in `~/pdd-backups/draw-images-<date>/<key>` plus `manifest.jsonl`
(`{key, bytes, sha256, rows}` per object), ~1 GB. Objects no row references (22 today)
are backed up to disk only, never uploaded. Keep the backup until the site has run on
Cloudinary for a few weeks.

**Do not skip `verify`.** `rewrite` only repoints a row whose object it can see at the right
size, but `verify` is what proves the whole set landed before a single row changes.

**Expect the `storage-alarm` issue to stay red until the bucket is emptied**: Supabase
storage above 70% is a real risk whatever the write target.

## Emptying the bucket

`--phase=empty-check` evaluates the gate (`lib/migration.mjs` `emptyGate`, pinned by
`test/migration.test.mjs`) and prints exactly which objects could go and how many MB that
frees. **It deletes nothing.** The deletion itself — a batched delete of the gated objects
from `draw-images` only, never `carousel-slides` or `badges` — has not been written into
this repo: the agent that built this PR was stopped from authoring a bulk cloud-storage
delete, and that decision belongs to the owner. With the gate green and the backup on disk,
the owner can empty the bucket from the Supabase dashboard (Storage → draw-images → select
all → delete), or approve adding the delete step to this script.

## What happens after

- **Supabase holds only the database.** Its storage counter starts again from the
  carousel's few MB.
- **Retention, daily, after the ended-sweep.** A photo whose draws have *all* been over for
  180 days is set to `null` on its rows (the site renders the category cover and falls back
  to the site og:image) and only then deleted from Cloudinary. A key still used by a live
  draw or a logo is never touched. Migrated photos are not re-dated: a draw that ended a
  year ago has its photo let go on the first retention run after the move — intended.
- **Storage watch, daily.** Alarms at 70% of Supabase storage, on any new object in
  `draw-images` after the switch (a writer was missed), when the provider is switched on
  with credentials that do not work (every new draw would silently hotlink), and at 70% of
  Cloudinary's credits over the last 30 days. If that alarm fires, look at transformations
  first: they should stay near zero now that uploads are raw.

## Rollback

Before the bucket is emptied, nothing has been deleted: unset `IMAGE_PROVIDER` everywhere
and PATCH migrated rows back to
`https://<ref>.supabase.co/storage/v1/object/public/draw-images/<key>` — the key is
everything after `/image/upload/v1/` (or `/raw/upload/v1/`) in the Cloudinary URL. After emptying, the local
backup is the copy: re-upload from `~/pdd-backups/draw-images-<date>/` (manifest.jsonl
lists every key, its sha256 and the rows that used it).

## If a card is ever added

Switch to R2 instead: it is built and tested (`R2.md`). `migrate-images.mjs --to=r2` moves
the same selection. `lib/retention.mjs` is provider-neutral, but `image-retention.mjs`
deliberately only runs live on Cloudinary — widen that check (and its base) before relying on
retention for R2.
