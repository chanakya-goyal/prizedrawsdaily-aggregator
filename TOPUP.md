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

It reads the **last completed run of both aggregator workflows** — `aggregate-json.yml` and
`aggregate.yml` — pulls the blocked/silent operators straight out of those logs, drops the ones
this machine also can't reach, and runs the survivors through the ordinary pipeline: same
adapters, same quality gate, same rules.

Both workflows matter. The scrape is split, and `woo API 403` — the signal this whole tool keys
off — now appears only in the JSON sweep. Reading the render sweep alone would find nothing.

## What it will and won't do

* Without `--publish`, draws land as **`draft`**, exactly as from CI.
* With `--publish`, drafts go live **only where an independent re-read agrees with the stored
  row** (`lib/verify.mjs`) — the same bar the daily Action applies. The check is not bypassed: a
  row that has drifted, lost its date, or stopped being purchasable stays a draft. This flag
  exists because CI can never make that second observation for these operators, so without it
  their drafts stay drafts permanently.
* `CORRECT_LIVE` is on for **every** run, not just `--publish`, so a `--write` refreshes stored
  fields on live rows too. These operators' draws are otherwise never re-read, and a stale
  `draw_date` hides a running comp.
* `--publish` applies an 18h `MIN_OBSERVATION_GAP_MS`, so running this twice in one sitting
  cannot let the second run act as the "second observation" for drafts the first just wrote.
* The operator list is **not hardcoded**. It is re-derived from the newest run every time, so as
  sites start or stop blocking us the list follows automatically — no maintenance.
* It is safe to run repeatedly. Dedup is by `entry_url`, so re-runs refresh rather than duplicate.

## When to run it

After an Action has finished, so there is a fresh log to read. The JSON sweep runs at 01:00,
13:00 and 19:00 UTC and takes minutes; the render sweep starts 07:00 UTC and takes about 45–60.
Any time after ~08:15 UTC reads a fresh copy of both. Roughly once a day is plenty; skipping days
only delays new draws.

## The limitation to remember

This depends on your Mac being awake and online. If these operators start earning real traffic,
the permanent fix is a **UK residential proxy** wired into `lib/fetcher.mjs` and the
`chromium.launch` in `run.mjs` — that covers the datacenter block and the UK gate at once, and
runs unattended in CI. Until then, this is the free version of the same thing.
