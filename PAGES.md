# Draw photos are served from Cloudflare Pages

**Since 2026-10-10.** Cloudinary still *receives* every photo the scraper re-hosts.
`publish-images.mjs` copies every **public** photo onto a Cloudflare Pages site and points
the row at the copy:

```
https://prizedrawsdaily-images.pages.dev/i/<operator>/<draw>.webp
```

## Why

Cloudinary's free plan has 25 credits, metered over a rolling 30 days, and **delivered
bytes cost credits**. Two things download the whole stored photo:

- **weserv cache misses.** Each width × crop × Cloudflare data centre is a separate miss.
- **Crawlers** fetching `og:image` and the JSON-LD `image`, which point straight at the
  host. They can't go through weserv: its robots.txt blocks Google from proxied URLs.

| measured (2026-10-09, first day on Cloudinary) | |
|---|---|
| bandwidth | ~0.7 GB/day, peaks ~1.3 GB/day |
| size of each request | ~134 KB, i.e. every request is a full photo |
| credits already used | 20.1 of 25 (18.6 from the migration, on the meter until ~8 Nov) |

At that rate the account runs out in about a week. Over the limit, Cloudinary warns and then
disables the account, and re-enabling it creates an empty one.

A Pages site serves static files with **no bandwidth meter**, needs **no card**, and allows
commercial use. The free plan's limits that matter are **20,000 files per deployment** and
**25 MiB per file**.

## How a run works

`publish-images.mjs` runs after every scrape (`.github/workflows/publish-images.yml`). Runs
queue, never overlap.

1. Read `manifest.json` from the site. It lists every deployed key with its sha256 and size.
2. Plan from the database (`lib/pages.mjs`):
   - Every row already on Pages keeps its file.
   - Every public row still on Cloudinary is copied over and moved.
   - **Drafts stay on Cloudinary.** They aren't public, and the scraper re-uploads a draft's
     photo on every run. A draft moves once it's published.
3. Stage the files in `.pages-images/public/i`. Each file comes from the first place that
   has the right bytes:
   - the Actions cache, used only if its hash matches the manifest;
   - the Pages site itself (no meter);
   - the local backup (`SEED_DIR`, first run only);
   - Cloudinary: metered, capped by `MAX_CLOUDINARY`, and only for photos it newly received.
4. Refuse to deploy if a photo that rows already use would disappear, or if the set is past
   19,500 files.
5. Deploy with `wrangler pages deploy`. Wait until the site serves the new manifest, then
   spot-check 25 moved photos for status and size.
6. Move the rows. Each update is guarded by `url=eq.<what we read>`, so a row the scrape
   rewrote in the meantime is left alone.

**Any failure before step 6 leaves every row where it was, still loading from Cloudinary.**
The workflow opens a `pages-alarm` issue and closes it on the next clean run.

**Retention** (`image-retention.mjs`, 180 days after a draw ends) nulls expired rows on Pages
too. The next deploy leaves those photos out.

## Owner setup (once)

1. **Cloudflare** → My Profile → API Tokens → Create Custom Token, with permission
   **Account · Cloudflare Pages · Edit**.
2. Add two repo secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Until both
   exist, the workflow exits green and does nothing.
3. Run the first copy from a machine that has the backup, so the 8,000+ migrated photos are
   read from disk, not downloaded from Cloudinary:

   ```
   SEED_DIR=~/pdd-backups/draw-images-2026-10-09 bun publish-images.mjs
   ```

   Run it with `DRY_RUN=true` first. It plans and stages without deploying or writing a row.

If Cloudflare gives the project a different subdomain (name taken), the script refuses to
write rows until `PAGES_SITE` is set to the real address.

## Rolling back

The Cloudinary copies are never deleted by this flow. To go back, point rows from the Pages
base to Cloudinary: the raw form `res.cloudinary.com/<cloud>/raw/upload/v1/<key>` for photos
uploaded since 2026-10-09, the image form for the migrated ones. Then disable the workflow.
