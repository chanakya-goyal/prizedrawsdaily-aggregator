// Inventory Integrity Index (III): one number for "does the database say true things about
// what a visitor can actually enter". Read-only, never writes.
//
// WHY THIS EXISTS, and why it is not just another line in tripwire.mjs: tripwire answers
// "is the pipeline broken RIGHT NOW" and reds the run. This answers "how much of what we
// store is trustworthy", which is a slope, not a cliff — it should be visible every day and
// should never fail a build. Measured 2026-08-30, before any of the Section 1 fixes:
// 397 of 759 `status=active` rows had a draw_date already in the past, ended-sweep had never
// read past row 1000 of its own scope, and the render ingest path applied no finished-comp
// check at all. Each of those is invisible in isolation and each one inflates the same
// number — the count of draws we tell people they can enter.
//
// The index is deliberately weighted toward AGREEMENT (30) over coverage (20) because a
// disagreement between `status` and `draw_date` is a claim we are making to a visitor,
// whereas an unswept row is only a claim we have not got round to checking.
//
// Usage: bun manager/inventory-scorecard.mjs            # markdown
//        JSON=true bun manager/inventory-scorecard.mjs  # machine-readable
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_PUBLISHABLE_KEY for read).

const SB = process.env.SUPABASE_URL || "https://ilnegxrsalmzpljotgpe.supabase.co";

/**
 * Pure scoring arithmetic — no I/O, so the weights and the clamping are testable offline.
 *
 * Every metric is a ratio in [0,1] and contributes `weight * ratio`. A metric whose inputs
 * are unavailable (null) is EXCLUDED from both the numerator and the denominator rather than
 * scored as zero: a count we could not read must not look like a count that came back bad.
 * That is the same rule tripwire's `count()` follows when it swallows a fetch error.
 */
export function scoreInventory({
  active,          // status=active, any date
  enterable,       // status=active AND draw_date >= now
  staleActive,     // status=active AND draw_date < now
  futureEnded,     // status=ended AND draw_date >= now
  sweptRows = null,     // rows ended-sweep actually read last run
  sweepScope = null,    // rows it was scoped to read
  holds = null,         // stale-date verdicts that produced no action (B3+B4)
  verdictTotal = null,  // how many rows the stale-date report covered — its OWN denominator
  tripwireActive = null,// what the alarm reported as live
  guardedPaths = null,  // ingest paths applying a finished-comp check
  totalPaths = null,    // ingest paths in use
  deadAssets = null,    // active draws pointing at the suspended storage project
} = {}) {
  const ratio = (num, den) => (den > 0 ? Math.max(0, Math.min(1, num / den)) : null);

  const metrics = [
    {
      key: "status_date_agreement",
      label: "Status/date agreement",
      weight: 30,
      // rows whose status and date agree, over every row making a liveness claim.
      // The disagreeing rows are exactly staleActive (says live, isn't) + futureEnded
      // (says finished, isn't), and the denominator is every active or ended row.
      value: active == null || staleActive == null || futureEnded == null
        ? null
        : ratio(active - staleActive, active + futureEnded),
      detail: `${staleActive ?? "?"} stale-active + ${futureEnded ?? "?"} future-ended out of ${(active ?? 0) + (futureEnded ?? 0)}`,
    },
    {
      key: "sweep_coverage",
      label: "Sweep coverage",
      weight: 20,
      value: ratio(sweptRows, sweepScope),
      detail: sweptRows == null ? "not measured — run ended-sweep first" : `${sweptRows} of ${sweepScope} in scope`,
    },
    {
      key: "verdict_coverage",
      label: "Verdict coverage",
      weight: 15,
      // `holds == null` means no report existed, which is NOT the same as "every row was
      // held" — scoring it 0 would have made an unmeasured metric look like a failed one.
      //
      // The denominator is the REPORT's own total, not staleActive. The two differ: the sweep
      // covers active+draft while staleActive counts active only, so using staleActive gave
      // "469 of 422 held" — a ratio above 1 that clamped to a meaningless 0%.
      value: holds == null || !verdictTotal ? null : ratio(verdictTotal - holds, verdictTotal),
      detail: holds == null ? "not measured — no stale-date-report.json" : `${holds} of ${verdictTotal} held without an actionable verdict`,
    },
    {
      key: "alarm_truth",
      label: "Alarm truth",
      weight: 15,
      // How far the alarm's "live inventory" sits from the enterable truth. An alarm that
      // over-reports by 110% is not 'slightly wrong', it is reporting a different quantity.
      value: tripwireActive == null || !enterable ? null : Math.max(0, 1 - Math.abs(tripwireActive - enterable) / enterable),
      detail: tripwireActive == null ? "not measured" : `alarm says ${tripwireActive}, enterable is ${enterable}`,
    },
    {
      key: "ingest_liveness_guard",
      label: "Ingest liveness guard",
      weight: 10,
      value: ratio(guardedPaths, totalPaths),
      detail: guardedPaths == null ? "not measured" : `${guardedPaths} of ${totalPaths} ingest paths check for a finished comp`,
    },
    {
      key: "asset_integrity",
      label: "Asset integrity",
      weight: 10,
      value: enterable ? ratio(enterable - (deadAssets ?? 0), enterable) : null,
      detail: `${deadAssets ?? "?"} enterable draw(s) point at the suspended storage project`,
    },
  ];

  const scored = metrics.filter((m) => m.value != null);
  const availableWeight = scored.reduce((s, m) => s + m.weight, 0);
  const earned = scored.reduce((s, m) => s + m.weight * m.value, 0);

  return {
    score: availableWeight > 0 ? Math.round((earned / availableWeight) * 100) : null,
    availableWeight,
    metrics,
  };
}

/**
 * The four gates. A red gate means the section is not done regardless of the score — each one
 * is a statement that cannot be traded off against a good number elsewhere.
 */
export function evaluateGates({ sweptRows, sweepScope, testsPass, unbackedBranches, deadKeyRefs }) {
  return [
    {
      key: "sweep_read_everything",
      label: "Sweep read everything in scope",
      pass: sweptRows != null && sweepScope != null && sweptRows >= sweepScope,
      detail: sweptRows == null ? "not measured" : `${sweptRows} / ${sweepScope}`,
    },
    { key: "tests_green", label: "test:scraper green", pass: testsPass === true, detail: String(testsPass ?? "not measured") },
    { key: "branch_truth", label: "No merged branch reads as open work", pass: unbackedBranches === 0, detail: `${unbackedBranches ?? "?"} unbacked` },
    { key: "no_dead_key", label: "No dead publishable-key fallback", pass: deadKeyRefs === 0, detail: `${deadKeyRefs ?? "?"} references` },
  ];
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
  if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY or SUPABASE_PUBLISHABLE_KEY"); process.exit(1); }

  const count = async (query) => {
    try {
      const r = await fetch(`${SB}/rest/v1/${query}`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "count=exact", Range: "0-0" },
        signal: AbortSignal.timeout(30000),
      });
      const n = Number((r.headers.get("content-range") || "/0").split("/")[1]);
      return Number.isNaN(n) ? null : n;
    } catch { return null; }
  };

  const now = new Date().toISOString();
  const [active, enterable, staleActive, futureEnded, deadAssets] = await Promise.all([
    count("draws?select=id&status=eq.active"),
    count(`draws?select=id&status=eq.active&draw_date=gte.${now}`),
    count(`draws?select=id&status=eq.active&draw_date=lt.${now}`),
    count(`draws?select=id&status=eq.ended&draw_date=gte.${now}`),
    count(`draws?select=id&status=eq.active&image_url=like.*kkuuwksgyypicnblwubs*`),
  ]);

  // Optional inputs, read from artifacts other steps leave behind. Absent → the metric is
  // excluded rather than scored zero, so a partial run still produces an honest number.
  const readJson = async (p) => Bun.file(p).json().catch(() => null);
  const sweep = await readJson("sweep-scope.json");     // written by ended-sweep (PR 2)
  const stale = await readJson("stale-date-report.json"); // written by ended-sweep (PR 4)

  const { score, availableWeight, metrics } = scoreInventory({
    active, enterable, staleActive, futureEnded, deadAssets,
    sweptRows: sweep?.swept ?? null,
    sweepScope: sweep?.scope ?? null,
    holds: stale ? stale.verdicts?.filter?.((v) => v.action === "hold").length ?? null : null,
    verdictTotal: stale?.total ?? null,
    tripwireActive: enterable, // post-PR-1 the alarm reads the guarded count by construction
    guardedPaths: 3, totalPaths: 4, // woo, shopify, api guarded; render is not (PR 3)
  });

  if (process.env.JSON === "true") {
    console.log(JSON.stringify({ generatedAt: now, score, availableWeight, metrics }, null, 2));
  } else {
    const pct = (m) => (m.value == null ? "—" : `${Math.round(m.value * 100)}%`);
    console.log([
      `## Inventory Integrity Index: **${score ?? "unknown"}/100**`,
      availableWeight < 100 ? `\n_Scored on ${availableWeight} of 100 available weight — the rest could not be measured this run._` : "",
      "",
      "| Metric | Weight | Score | Detail |",
      "|---|---|---|---|",
      ...metrics.map((m) => `| ${m.label} | ${m.weight} | ${pct(m)} | ${m.detail} |`),
      "",
      `Enterable: **${enterable ?? "?"}** · stale-dated active: **${staleActive ?? "?"}** · future-dated ended: **${futureEnded ?? "?"}**`,
    ].join("\n"));
  }
}
