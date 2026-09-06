# Local top-up run — covering the operators GitHub can't reach

## Why this exists

The daily Action runs on GitHub's Azure runners. Around 18 operators' firewalls refuse those
datacenter IPs outright — the run log says `woo API 403` for a URL that serves a full catalogue
to any ordinary home broadband connection. A few more (Nitrous returns HTTP **451**, Jammy and
Raffle Master return 503 from live London servers) only accept UK visitors.

Two things this is **not**:

* **Not a FlareSolverr problem.** FlareSolverr solves Cloudflare's JavaScript challenge but
  keeps the same IP. Nine of the silent operators already have it enabled and still return zero.
* **Not fixed by a free UK cloud VM.** Oracle/AWS/Azure free tiers all hand you a *datacenter*
  IP, which is precisely what these WAFs reject. It would rescue the three UK-gated sites and
  leave all eighteen Woo ones exactly as broken.

Your home connection is residential, so it passes both tests. That is the whole trick.

## Running it

```bash
cd ~/pdd-aggregator

bun topup.mjs --list              # who CI missed, and which this machine can reach
bun topup.mjs                     # dry run — show what would be captured, write nothing
bun topup.mjs --write             # insert the draws (as draft)
bun topup.mjs --write --publish   # also publish the drafts a second scrape agrees with
```

It reads the **last completed** Action run, pulls the blocked/silent operators straight out of
that log, drops the ones this machine also can't reach, and runs the survivors through the
ordinary pipeline — same adapters, same quality gate, same rules.

## What it will and won't do

* Without `--publish`, draws land as **`draft`**, exactly as from CI.
* With `--publish`, drafts go live **only where an independent re-read agrees with the stored
  row** (`lib/verify.mjs`) — the same bar the daily Action applies. The check is not bypassed: a
  row that has drifted, lost its date, or stopped being purchasable stays a draft. This flag
  exists because CI can never make that second observation for these operators, so without it
  their drafts stay drafts permanently.
* `--publish` also turns on `CORRECT_LIVE`, refreshing stored fields on live rows. These
  operators' draws are otherwise never re-read, and a stale `draw_date` hides a running comp.
* The operator list is **not hardcoded**. It is re-derived from the newest run every time, so as
  sites start or stop blocking us the list follows automatically — no maintenance.
* It is safe to run repeatedly. Dedup is by `entry_url`, so re-runs refresh rather than duplicate.

## When to run it

After the daily Action finishes (it starts 07:00 UTC and takes about 45–60 minutes), so it has a
fresh run to read. Roughly once a day is plenty; skipping days only delays new draws.

## The limitation to remember

This depends on your Mac being awake and online. If these operators start earning real traffic,
the permanent fix is a **UK residential proxy** wired into `lib/fetcher.mjs` and the
`chromium.launch` in `run.mjs` — that covers the datacenter block and the UK gate at once, and
runs unattended in CI. Until then, this is the free version of the same thing.
