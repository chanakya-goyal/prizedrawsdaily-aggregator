// Tripwire: exits 1 (and writes tripwire.md) when the daily pipeline is BROKEN. The Aug 2026
// outage (carousel tests skipping the scrape for 10+ days) is exactly what this catches.
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
const SB = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
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

async function rows(query) {
  try {
    const r = await fetch(`${SB}/rest/v1/${query}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; } // no data → those alarms simply don't fire; never break the run
}

const tally = (list, key) => list.reduce((acc, r) => { const k = key(r); if (k) acc[k] = (acc[k] || 0) + 1; return acc; }, {});

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

  const [activeCount, freshCount, expiredDrafts, liveRows, recentRows] = await Promise.all([
    count("draws?select=id&status=eq.active"),
    count(`draws?select=id&created_at=gte.${since}`),
    count(`draws?select=id&status=eq.draft&draw_date=lt.${nowIso}`),
    rows("draws?select=operators(slug),categories(slug)&status=eq.active&limit=2000"),
    rows(`draws?select=operators(slug)&created_at=gte.${quietSince}&limit=2000`),
  ]);

  // An operator we deliberately switched off will always look "stalled" — warning about it
  // every day is the same noise problem the fixed floor had.
  const disabled = new Set(
    (await Bun.file("operators.json").json().catch(() => []))
      .filter((o) => o.enabled === false).map((o) => o.slug),
  );

  const byCategory = tally(liveRows, (r) => r.categories?.slug);
  const liveByOp = tally(liveRows, (r) => r.operators?.slug);
  const recentByOp = tally(recentRows, (r) => r.operators?.slug);
  const stalledOperators = Object.entries(liveByOp)
    .filter(([slug, live]) => live >= 3 && !recentByOp[slug] && !disabled.has(slug))
    .map(([slug, live]) => ({ slug, live, daysQuiet: QUIET_DAYS }))
    .sort((a, b) => b.live - a.live);

  const { tripped, reasons, warnings } = evaluateTripwire({
    activeCount, floor, scrapeOutcome, freshCount, minFresh, target, expiredDrafts,
    byCategory, categoryFloors: CATEGORY_FLOORS, stalledOperators,
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
  await Bun.write("tripwire.md", body);

  for (const w of warnings) console.log(`⚠️  ${w}`);
  if (tripped) { console.error(reasons.join("; ")); process.exit(1); }
  console.log(`tripwire ok — active ${activeCount}, ${freshCount} new in 24h, scrape ${scrapeOutcome}`);
}
