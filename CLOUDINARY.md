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
the habit. The fix is a lifecycle, not a bigger box:

- only the images the site still needs move (`lib/retention.mjs` `selectNecessary`);
- photos of draws over for more than `RETENTION_DAYS` (30) are let go every day
  (`image-retention.mjs`), so storage tracks the *live* inventory, not the all-time total;
- `storage-watch.mjs` alarms at 70% instead of us finding out from a 402.

### Why Cloudinary, not R2

R2 is the better product (10 GB, egress free at any volume) and is already built
(`R2.md`), but Cloudflare will not enable R2 without a payment method on file and the
owner has declined to add one. Backblaze B2 needs payment history before a bucket can be
public. **Cloudinary's Free plan needs no card**: 25 credits a month shared between
storage (1 credit = 1 GB), bandwidth (1 GB) and transformations (1,000). We store ~0.7 GB
and serve originals only — images.weserv.nl fetches each one once and caches it — so we
use a few credits. When the limit is hit the account stops serving rather than billing.

**The database stays on Supabase.** Only the bytes move.

## What you have to do (I cannot do these)

1. Sign up at cloudinary.com (Google/GitHub, no card). Copy the **API environment
   variable** from the dashboard: `cloudinary://<api_key>:<api_secret>@<cloud_name>`.
2. Put it in **four** places. The fourth is the one that broke the August move:

| where | what |
|---|---|
| `~/pdd-aggregator/.env` | `CLOUDINARY_URL=…` (and later `IMAGE_PROVIDER=cloudinary`) |
| GitHub secrets on this repo | `CLOUDINARY_URL`, `IMAGE_PROVIDER` — read by both scrape workflows, retention, tripwire and the storage watch |
| **the scheduled cowork routine** | it keeps its OWN env, in no repo and no `.env` (`COWORK.txt`, `manager/PROMPT.md`). Its `manager/draw-insert.mjs` / `draw-update.mjs` re-host images. Miss it and it keeps writing to Supabase — the storage watch will say so within a day |
| Vercel env (site) | **not needed today**: the admin importer (`src/lib/import.functions.ts`) writes to Supabase directly, but it has never been used on this project (0 objects under `2026/`) |

## Run order

**Switch the writers FIRST.** With ~1 day of headroom, the bucket must stop growing before
anything else; the copy can take its time afterwards.

```sh
# 0. Rehearse the selection (read-only, works without credentials)
bun migrate-images.mjs --phase=copy --to=cloudinary

# 1. Switch every writer: GitHub secrets IMAGE_PROVIDER=cloudinary + CLOUDINARY_URL,
#    the cowork routine's env, and .env. From the next scrape, new photos go to Cloudinary.

# 2. Copy what matters. Rehearse on 20 first.
DRY_RUN=false bun migrate-images.mjs --phase=copy --limit=20
bun migrate-images.mjs --phase=verify --limit=20
DRY_RUN=false bun migrate-images.mjs --phase=copy          # resumable — re-run if interrupted

# 3. Prove it landed (exits non-zero unless every selected image is there, right-sized,
#    and served as a cacheable image over a public GET).
bun migrate-images.mjs --phase=verify

# 4. Point the rows at it. Only rows still holding the URL we read are changed.
DRY_RUN=false bun migrate-images.mjs --phase=rewrite
```

**Do not skip `verify`.** `rewrite` only repoints a row whose object it can see at the right
size, but `verify` is what proves the whole set landed before a single row changes.

**Expect the `storage-alarm` issue to stay red for up to 48h after step 1**: it judges a
frozen Supabase bucket by "anything written in the last 48h", and pre-switch uploads take
that long to age out. It closes itself.

## What happens after

- **Supabase becomes a frozen archive.** Nothing is deleted from it. Draws that ended more
  than 30 days ago keep pointing there and keep their photos. Reclaiming that space is a
  separate, later, deliberate decision.
- **Retention, daily, after the ended-sweep.** A photo whose draws have *all* been over for
  30 days is repointed to its Supabase original if one exists, else to `null` (the site
  renders the category cover and falls back to the site og:image), and only then deleted
  from Cloudinary. A key still used by a live draw or a logo is never touched.
- **Storage watch, daily.** Alarms at 70% of Cloudinary's monthly credits, on any new
  object in the frozen Supabase bucket (a writer was missed), and when the provider is
  switched on with credentials that do not work (every new draw would silently hotlink).

## Rollback

Nothing is deleted during the move. Unset `IMAGE_PROVIDER` everywhere (new photos go back
to Supabase — which is full, so only as a stop-gap), and PATCH migrated rows back to
`https://<ref>.supabase.co/storage/v1/object/public/draw-images/<key>` — the key is
everything after `/image/upload/v1/` in the Cloudinary URL.

## If a card is ever added

Switch to R2 instead: it is built and tested (`R2.md`). `migrate-images.mjs --to=r2` moves
the same selection. `lib/retention.mjs` is provider-neutral, but `image-retention.mjs`
deliberately only runs live on Cloudinary — widen that check (and its base) before relying on
retention for R2.
