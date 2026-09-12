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
