// Splitting the operator roster across PARALLEL jobs.
//
// Not to be confused with BATCHES in run.mjs, which is the opposite trade: `dayOfYear % BATCHES`
// scrapes 1/N of the roster each day and cycles, so an operator is read every N days. That buys
// runtime by giving up freshness — the wrong direction when the goal is more live draws.
//
// Sharding keeps every operator scraped every day and buys runtime with concurrency instead:
// N jobs run at once, each taking 1/N of the roster. Measured 2026-09-06 the render sweep costs
// ~0.84 min/operator and the JSON sweep ~0.35, so a 300-operator roster projects to ~101 min of
// render (against a 150 min job cap) and ~63 min of JSON (against 60) — the JSON sweep runs out
// of clock first, and sharding is what buys it back.
//
// THE PROPERTY THAT MATTERS is that the shards form a PARTITION: every operator lands in exactly
// one shard, never zero. An operator silently in no shard is never scraped again and the only
// symptom is one more name on the silent list — the same failure mode as a method no workflow
// claims. test/shard.test.mjs asserts the partition for every count from 1 to 16.

// Round-robin by index rather than contiguous slices: adjacent entries in operators.json tend to
// be added together and to look alike (same platform, similar size), so contiguous slices
// concentrate the expensive ones in one shard while another finishes early.
export function shardOf(items, index, count) {
  const n = Math.max(1, Math.floor(count) || 1);
  const i = Math.min(Math.max(0, Math.floor(index) || 0), n - 1);
  if (n === 1) return [...items];
  return items.filter((_, k) => k % n === i);
}

// Parse the pair together so an invalid combination cannot half-apply. An out-of-range index is
// clamped rather than thrown: failing the process would take out a scrape over a typo in a
// workflow file, and a clamped shard still scrapes real operators.
export function shardConfig(env = process.env) {
  const count = Math.max(1, Number(env.SHARD_COUNT || 1) || 1);
  const index = Math.min(Math.max(0, Number(env.SHARD_INDEX || 0) || 0), count - 1);
  return { index, count };
}

// AUTO_PUBLISH_MAX is a per-PROCESS counter, so N shards running at once would each publish up
// to the full cap and the day's real ceiling would be N times what was budgeted. Divide it, and
// keep at least 1 so a large shard count cannot silently switch publishing off entirely.
export function shardedPublishCap(max, count) {
  const n = Math.max(1, Math.floor(count) || 1);
  if (!Number.isFinite(max) || max <= 0) return max;
  return Math.max(1, Math.floor(max / n));
}

// Rotate the roster so the front of the list is not always the same operators.
//
// Everything that runs out mid-run — the publish cap, RUN_DEADLINE_MIN, MAX_PAGES — is spent
// in roster order, and operators.json order never changes. That turns "we ran out" into a
// permanent exclusion for whoever sits at the back, rather than a fair share of a scarce
// resource. Rotating by run makes the shortfall land on a different tail each time.
//
// Pure and deterministic: the same offset always produces the same order, so a run is still
// reproducible from its inputs.
export function rotateRoster(items, offset = 0) {
  const n = items.length;
  if (n < 2) return items.slice();
  const k = ((Math.trunc(offset) % n) + n) % n; // safe for negative / non-integer input
  return items.slice(k).concat(items.slice(0, k));
}

// Advance once per run rather than once per day: the JSON sweep runs three times a day, so a
// day-based offset would give all three runs the same front of the list and change nothing.
export function rosterOffset(now = new Date(), windowMs = 8 * 3600 * 1000) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) return 0;
  return Math.floor(t / windowMs);
}
