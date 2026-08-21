// Tripwire: exits 1 (and writes tripwire.md) when the daily pipeline is BROKEN. The Aug 2026
// outage (carousel tests skipping the scrape for 10+ days) is exactly what this catches.
// tripwire.md also carries an "Operator scoreboard" section (never trips the run — advisory
// only, see that block below) for the Sunday patrol's curation pass.
// Usage (CI): SCRAPE_OUTCOME=${{ steps.scrape.outcome }} bun manager/tripwire.mjs
//
// WHY THERE ARE TWO THRESHOLDS: the original single `floor` conflated "the site is broken"
// with "we haven't hit our growth target yet". At 350 it was an aspiration, not a fault
// line — so once real inventory sat below it the job went red EVERY day (Aug 15-18 2026)
// while the scrape step itself was succeeding. An alarm that is always on carries no
// information and trains you to ignore the one day it matters. So:
//   floor  (TRIPWIRE_FLOOR)  → genuinely broken; reds the run.
//   target (TRIPWIRE_TARGET) → where we want to be; reported, stays green.
//
// `freshCount` is the signal that actually catches a silent stall: operators list new comps
// every single day (measured 24-136 new rows/day across Aug 2026), so a day with ZERO new
// rows means the scrape ran but produced nothing — the exact shape of the Aug outage, and
// invisible to a total-inventory check because auto-expire drains inventory only slowly.
const SB = process.env.SUPABASE_URL || "https://ilnegxrsalmzpljotgpe.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export function evaluateTripwire({
  activeCount,
  floor,
  scrapeOutcome,
  freshCount = null,
  minFresh = 1,
  target = null,
  expiredDrafts = null,
  byCategory = null,     // { "car-draws": 12, … } live counts
  categoryFloors = null, // { "car-draws": 10, … }
  stalledOperators = null, // [{ slug, live, daysQuiet }] — has inventory, produces nothing
  storageBytes = null,     // total bytes across all buckets (public.storage_usage RPC)
  storageQuotaBytes = 1073741824, // free plan = 1 GB
  storageWarnPct = 70,
  storageRedPct = 90,
}) {
  const reasons = [];   // → exit 1, opens/comments the tripwire issue
  const warnings = [];  // → reported in tripwire.md, run stays green

  if (scrapeOutcome !== "success") reasons.push(`scrape step outcome was '${scrapeOutcome}' (expected 'success')`);
  if (activeCount != null && activeCount < floor) reasons.push(`live inventory ${activeCount} is under the floor of ${floor}`);
  if (freshCount != null && freshCount < minFresh) {
    reasons.push(`only ${freshCount} new draw(s) in the last 24h (expected at least ${minFresh}) — the scrape ran but produced nothing`);
  }

  if (activeCount != null && target && activeCount >= floor && activeCount < target) {
    warnings.push(`live inventory ${activeCount} is below the target of ${target}`);
  }
  // Drafts that reached their draw_date while still unpublished are draws we scraped, held,
  // and then threw away. Never a build failure — but it is the number that says the publish
  // path is the bottleneck, so it belongs in front of you every day.
  if (expiredDrafts) warnings.push(`${expiredDrafts} draft(s) passed their draw date unpublished — scraped, never shown`);

  // A total-inventory check cannot see one category collapsing while another grows. Cars are
  // the sharpest case: the site sat at 5 live car draws while cash-prizes had 86, and the
  // aggregate number looked fine throughout.
  if (byCategory && categoryFloors) {
    for (const [cat, min] of Object.entries(categoryFloors)) {
      const n = byCategory[cat] || 0;
      if (n < min) warnings.push(`only ${n} live ${cat} (floor ${min})`);
    }
  }

  // "Silent operator" has always been a log line that never failed anything, so operators
  // stayed dark for months. The signal worth acting on isn't "scraped 0" — plenty of small
  // operators legitimately have nothing new — it's an operator that HAS live inventory (so it
  // worked recently) and has produced nothing for days: its parser has broken under us.
  for (const op of stalledOperators || []) {
    warnings.push(`${op.slug} has ${op.live} live draw(s) but has added nothing in ${op.daysQuiet}d — parser may have broken`);
  }

  // Storage is the one quota that takes the WHOLE PROJECT down, not just the scrape:
  // on 2026-08-19 the org was restricted with exceed_storage_size_quota and every
  // service — REST included — returned HTTP 402, so the site served empty pages.
  // Two properties make it uniquely unforgiving and justify going red well before 100%:
  //   1. Supabase bills the AVERAGE over the billing period, so a late fix cannot
  //      rescue the current cycle — the 2026-08-19 compression pass dropped live usage
  //      to 0.5 GB hours before the restriction fired anyway.
  //   2. Reducing usage does not lift a restriction. Only a plan upgrade or the next
  //      cycle's refill does. Overshooting costs weeks, not hours.
  if (storageBytes != null && storageQuotaBytes > 0) {
    const pct = (storageBytes / storageQuotaBytes) * 100;
    const gb = (b) => (b / 1073741824).toFixed(2);
    if (pct >= storageRedPct) {
      reasons.push(
        `storage at ${gb(storageBytes)} GB of ${gb(storageQuotaBytes)} GB (${pct.toFixed(0)}%) — ` +
        `past the ${storageRedPct}% red line; at 100% every service 402s and the site goes down`
      );
    } else if (pct >= storageWarnPct) {
      warnings.push(
        `storage at ${gb(storageBytes)} GB of ${gb(storageQuotaBytes)} GB (${pct.toFixed(0)}%) — ` +
        `over the ${storageWarnPct}% warn line; act this billing cycle, a late fix cannot lower the period average`
      );
    }
  }

  return { tripped: reasons.length > 0, reasons, warnings };
}

async function count(query) {
  try {
    const r = await fetch(`${SB}/rest/v1/${query}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "count=exact", Range: "0-0" },
      signal: AbortSignal.timeout(30000),
    });
    const n = Number((r.headers.get("content-range") || "/0").split("/")[1]);
    return Number.isNaN(n) ? null : n;
  } catch { return null; } // a count we can't read must not itself break the run
}

async function rows(query, { all = false } = {}) {
  try {
    if (!all) {
      const r = await fetch(`${SB}/rest/v1/${query}`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    }
    // `all: true` pages via Range headers instead of trusting a `limit=` query param — this
    // project hard-caps every REST response at 1000 rows regardless of `limit=` (confirmed
    // 2026-08-21: a 60-day draws window alone is 2800 rows), so a query expected to exceed
    // that must page through it explicitly or silently lose rows past the cap.
    const out = [];
    for (let from = 0; ; from += 1000) {
      const r = await fetch(`${SB}/rest/v1/${query}`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` },
        signal: AbortSignal.timeout(30000),
      });
      const page = await r.json();
      if (!Array.isArray(page)) break; // an error body (bad column, etc.) — fail open, keep what we have
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  } catch { return []; } // no data → those alarms simply don't fire; never break the run
}

const tally = (list, key) => list.reduce((acc, r) => { const k = key(r); if (k) acc[k] = (acc[k] || 0) + 1; return acc; }, {});

// Total bytes across all buckets, via the public.storage_usage() RPC.
// storage.objects isn't exposed through PostgREST, and walking the Storage API
// costs one call per operator folder — this is a single query. Returns null on
// any failure so a missing signal never reds the run by itself.
async function storageBytes() {
  try {
    const r = await fetch(`${SB}/rest/v1/rpc/storage_usage`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j)) return null;
    return j.reduce((sum, b) => sum + Number(b.bytes || 0), 0);
  } catch { return null; }
}

if (import.meta.path === Bun.main) {
  const floor = Number(process.env.TRIPWIRE_FLOOR || 150);
  const target = Number(process.env.TRIPWIRE_TARGET || 350);
  const minFresh = Number(process.env.TRIPWIRE_MIN_FRESH || 1);
  const scrapeOutcome = process.env.SCRAPE_OUTCOME || "unknown";
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const nowIso = new Date().toISOString();

  const QUIET_DAYS = Number(process.env.TRIPWIRE_QUIET_DAYS || 5);
  const quietSince = new Date(Date.now() - QUIET_DAYS * 864e5).toISOString();
  const CATEGORY_FLOORS = JSON.parse(process.env.TRIPWIRE_CATEGORY_FLOORS || '{"car-draws":10}');

  const [activeCount, freshCount, expiredDrafts, liveRows, recentRows, storeBytes, operatorRoster, historyRows, blockedDraftsCount] = await Promise.all([
    count("draws?select=id&status=eq.active"),
    count(`draws?select=id&created_at=gte.${since}`),
    count(`draws?select=id&status=eq.draft&draw_date=lt.${nowIso}`),
    rows("draws?select=operators(slug),categories(slug)&status=eq.active&limit=2000"),
    rows(`draws?select=operators(slug)&created_at=gte.${quietSince}&limit=2000`),
    storageBytes(),
    // Operator scoreboard (below): the DB `operators` table is the authoritative roster (99
    // rows measured 2026-08-21) — NOT operators.json (94: a scraper-config subset. A handful of
    // DB operators, e.g. Raffle House / Elite Competitions, are demand-side placeholders never
    // yet wired into the scraper, so they'd be invisible if the roster came from the local file).
    rows("operators?select=slug,name,rating"),
    // Full draw history (unfiltered by status or time), paged via `all: true` — powers the
    // scoreboard's "added 30d"/"newest" columns. Needs real pagination, not just a wider
    // `limit=`: the 60-day window alone is 2800 rows against this project's 1000-row hard cap
    // (measured 2026-08-21), so a single request would silently corrupt exactly the two numbers
    // this section exists to report, right around the 60-day PRUNE boundary that matters most.
    rows("draws?select=created_at,operators(slug)", { all: true }),
    // Category coverage: rows the scraper refused to guess at all (step 2b's pool, same filter
    // it uses) — a single cheap count request, not the drafts themselves.
    count("draws?select=id&status=eq.draft&category_id=is.null"),
  ]);

  // An operator we deliberately switched off will always look "stalled" — warning about it
  // every day is the same noise problem the fixed floor had.
  const disabled = new Set(
    (await Bun.file("operators.json").json().catch(() => []))
      .filter((o) => o.enabled === false).map((o) => o.slug),
  );

  const byCategory = tally(liveRows, (r) => r.categories?.slug);
  // Optional — only exists after a Sunday patrol run (S1). Read-only, and its coverage line
  // below is silently omitted when the file is missing (no patrol has run yet, or it's a
  // weekday checkout with no worklist committed).
  const patrol = await Bun.file("patrol-worklist.json").json().catch(() => null);
  const liveByOp = tally(liveRows, (r) => r.operators?.slug);
  const recentByOp = tally(recentRows, (r) => r.operators?.slug);
  const stalledOperators = Object.entries(liveByOp)
    .filter(([slug, live]) => live >= 3 && !recentByOp[slug] && !disabled.has(slug))
    .map(([slug, live]) => ({ slug, live, daysQuiet: QUIET_DAYS }))
    .sort((a, b) => b.live - a.live);

  // Operator scoreboard (weekly patrol §7 — curation sprint's data source, not its verdict).
  // "added 30d"/"newest" come from `historyRows` (ALL statuses — a row that later ended still
  // counts as evidence the operator is alive); "live" reuses `liveByOp` above, no extra fetch.
  // PRUNE_STALE_MS (60d) mirrors the design doc's prune rule (§15); an operator with NO row
  // ever (newest = null) is treated as maximally stale, not skipped — it's the sharpest signal here.
  const THIRTY_D_AGO = new Date(Date.now() - 30 * 864e5).toISOString();
  const PRUNE_STALE_MS = 60 * 864e5;
  const addedByOp = tally(historyRows.filter((r) => r.created_at >= THIRTY_D_AGO), (r) => r.operators?.slug);
  const newestByOp = historyRows.reduce((acc, r) => {
    const slug = r.operators?.slug;
    if (slug && r.created_at && (!acc[slug] || r.created_at > acc[slug])) acc[slug] = r.created_at;
    return acc;
  }, {});
  const queuePending = (await Bun.file("discovery/queue.json").json().catch(() => [])).length;

  const scoreboardRows = operatorRoster
    .map((op) => {
      const live = liveByOp[op.slug] || 0;
      const newest = newestByOp[op.slug] || null;
      const stale = newest == null || Date.now() - new Date(newest).getTime() > PRUNE_STALE_MS;
      return {
        name: (op.name || op.slug).trim(),
        live,
        added: addedByOp[op.slug] || 0,
        newest: newest ? newest.slice(0, 10) : "never",
        rating: op.rating != null ? Number(op.rating).toFixed(1) : "—",
        flag: live === 0 && stale ? "PRUNE?" : "",
      };
    })
    .sort((a, b) => (a.flag ? 0 : 1) - (b.flag ? 0 : 1) || b.live - a.live || a.name.localeCompare(b.name));

  const scoreboard = [
    "## Operator scoreboard",
    "",
    "| operator | live | added 30d | newest | rating | flag |",
    "|---|---|---|---|---|---|",
    ...scoreboardRows.map((r) => `| ${r.name} | ${r.live} | ${r.added} | ${r.newest} | ${r.rating} | ${r.flag} |`),
    "",
    "`PRUNE?` = live 0 and no draw added in 60+ days (or never produced one). This table is a "
      + "worklist, not a verdict — final removal still needs the GSC check from the curation sprint.",
    `\`ADD-QUEUE\`: ${queuePending} candidate operator(s) pending in \`discovery/queue.json\`, awaiting curation review.`,
  ].join("\n");

  // Category snapshot + coverage: how the live catalogue splits by category, how many drafts
  // are stuck behind the classification gate (step 2b's pool), and — Sundays only — how big
  // this week's patrol detail sample is. None of this trips the run; it's the same "advisory,
  // for the curation pass" spirit as the operator scoreboard above.
  const categorySnapshot = [
    "## Category distribution",
    "",
    ...Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([slug, n]) => `- ${slug}: ${n}`),
    "",
    `drafts awaiting classification: ${blockedDraftsCount ?? "unknown"}`,
    ...(patrol?.counts?.detail_sample != null
      ? [`patrol: this week's detail sample = ${patrol.counts.detail_sample} rows (~half the live catalogue; full re-verify ≈ every 2 weeks)`]
      : []),
  ].join("\n");

  const { tripped, reasons, warnings } = evaluateTripwire({
    activeCount, floor, scrapeOutcome, freshCount, minFresh, target, expiredDrafts,
    byCategory, categoryFloors: CATEGORY_FLOORS, stalledOperators,
    storageBytes: storeBytes,
    storageQuotaBytes: Number(process.env.STORAGE_QUOTA_BYTES || 1073741824),
    storageWarnPct: Number(process.env.STORAGE_WARN_PCT || 70),
    storageRedPct: Number(process.env.STORAGE_RED_PCT || 90),
  });

  const body = [
    `## ${tripped ? "🔴" : "🟢"} Aggregator tripwire — ${new Date().toISOString().slice(0, 10)}`,
    "",
    ...(reasons.length ? ["**Broken:**", ...reasons.map((x) => `- ${x}`), ""] : []),
    ...(warnings.length ? ["**Watch:**", ...warnings.map((x) => `- ${x}`), ""] : []),
    `Active draws: **${activeCount ?? "unknown"}** (floor ${floor}, target ${target}) · `
      + `new in 24h: **${freshCount ?? "unknown"}** · scrape outcome: **${scrapeOutcome}**`,
    "",
    "Check the run's coverage-report step summary for the per-operator picture.",
  ].join("\n");
  await Bun.write("tripwire.md", `${body}\n\n${categorySnapshot}\n\n${scoreboard}\n`);

  const pruneCount = scoreboardRows.filter((r) => r.flag === "PRUNE?").length;
  console.log(`scoreboard: ${operatorRoster.length} operators (${pruneCount} flagged PRUNE?), ${queuePending} pending in discovery queue`);
  console.log(`category coverage: ${Object.keys(byCategory).length} categories live, ${blockedDraftsCount ?? "unknown"} drafts awaiting classification`);

  for (const w of warnings) console.log(`⚠️  ${w}`);
  if (tripped) { console.error(reasons.join("; ")); process.exit(1); }
  console.log(`tripwire ok — active ${activeCount}, ${freshCount} new in 24h, scrape ${scrapeOutcome}`);
}
