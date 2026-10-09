// Decide whether Supabase egress needs a human, from request counts usage-watch.mjs has read.
// Pure, so the rules are pinned in test/usage-watch.test.mjs.
//
// WHY THIS IS AN ESTIMATE. The Free plan's egress meter (5 GB/month; the org is restricted, then
// every API returns 402 when a cycle runs over) has no API: the Management API exposes request
// counts and logs, not bytes. So we count what the database itself counts — every PostgREST
// request runs one `select set_config('search_path', …)` preamble, and pg_stat_statements keeps a
// per-role call total (public.api_request_total(), sql/2026-10-09-usage-snapshots.sql) — and
// multiply by a bytes-per-request figure calibrated against the dashboard.
//
// THE DEFAULT 4,200 BYTES/REQUEST: on 2026-09-12 the dashboard's per-source breakdown showed
// PostgREST egress of 101.19 MB for the day, while the old project's counter averaged ~24.5k
// REST requests/day across 20 Aug–9 Oct (22.9k site/anon + 1.6k scraper/service_role):
// 101.19 MB / 24.5k ≈ 4.1 KB. It errs high on purpose — site PR #117 (15 Sep) cut the heavy
// operator payloads after that day, so today's requests are smaller and the alarm fires early.
// RECALIBRATE after a week of snapshots: dashboard Usage → Egress (PostgREST) for a date range,
// divided by the requests usage_snapshots recorded over the same range; set USAGE_BYTES_PER_REQUEST.
//
//   ≥ 80% of the quota projected for a month → red (the run fails, the issue opens)
//   ≥ 50%                                    → warn (the issue opens, the run stays green)
//   not installed / read failed / no rate yet → a note, never an alarm

export const DEFAULTS = Object.freeze({
  quotaBytes: 5e9, // Free plan "5 GB" — decimal, the conservative reading
  bytesPerRequest: 4200,
  warnAt: 0.5,
  redAt: 0.8,
  windowDays: 7,
});

const DAY = 864e5;
const n = (x) => Number(x) || 0;
const fmt = (x) => Math.round(x).toLocaleString("en-GB");
const GB = (b) => `${(b / 1e9).toFixed(2)} GB`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** The RPC row → a usage_snapshots row. */
export function toSnapshot(row, now = new Date()) {
  return {
    taken_at: now.toISOString(),
    rest_anon: n(row.rest_anon),
    rest_service: n(row.rest_service),
    rest_authenticated: n(row.rest_authenticated),
    storage: n(row.storage),
    stats_reset: row.stats_reset ?? null,
  };
}

const FIELDS = { anon: "rest_anon", service: "rest_service", authenticated: "rest_authenticated", storage: "storage" };

/**
 * Requests per day, per source, from snapshots (oldest first; the newest is the one just taken).
 * Only pairs inside the window count. A counter that restarted (new stats_reset, or a total that
 * went down) contributes its count since the restart over the time since the restart.
 */
export function requestRates(snapshots, { windowDays = DEFAULTS.windowDays, now = null } = {}) {
  const sorted = [...snapshots].sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at));
  const last = sorted.at(-1);
  if (!last) return { rest: null, basis: "none" };
  const end = now ?? Date.parse(last.taken_at);
  const inWindow = sorted.filter((s) => Date.parse(s.taken_at) >= end - windowDays * DAY);

  if (inWindow.length < 2) {
    // First run (or a long gap): the counter's own life is the only baseline.
    const resetAt = Date.parse(last.stats_reset || "");
    const days = (Date.parse(last.taken_at) - resetAt) / DAY;
    if (!(days >= 1 / 24)) return { rest: null, basis: "none" };
    const out = { basis: "since-reset", days, resets: 0 };
    for (const [k, f] of Object.entries(FIELDS)) out[k] = n(last[f]) / days;
    out.rest = out.anon + out.service + out.authenticated;
    return out;
  }

  const sums = { anon: 0, service: 0, authenticated: 0, storage: 0 };
  let ms = 0, resets = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const prev = inWindow[i - 1], cur = inWindow[i];
    const t0 = Date.parse(prev.taken_at), t1 = Date.parse(cur.taken_at);
    const resetAt = Date.parse(cur.stats_reset || "");
    const newReset = (cur.stats_reset || null) !== (prev.stats_reset || null);
    const wentDown = Object.values(FIELDS).some((f) => n(cur[f]) < n(prev[f]));
    if (newReset || wentDown) {
      resets++;
      // Count since the restart, over the time since the restart when we know it.
      const from = newReset && resetAt > t0 && resetAt < t1 ? resetAt : t0;
      for (const [k, f] of Object.entries(FIELDS)) sums[k] += n(cur[f]);
      ms += t1 - from;
    } else {
      for (const [k, f] of Object.entries(FIELDS)) sums[k] += n(cur[f]) - n(prev[f]);
      ms += t1 - t0;
    }
  }
  const days = ms / DAY;
  if (!(days > 0)) return { rest: null, basis: "none" };
  const out = { basis: "snapshots", days, resets };
  for (const k of Object.keys(sums)) out[k] = sums[k] / days;
  out.rest = out.anon + out.service + out.authenticated;
  return out;
}

export function assessUsage({ rates = null, missing = null, error = null, bytesPerRequest = DEFAULTS.bytesPerRequest, quotaBytes = DEFAULTS.quotaBytes, warnAt = DEFAULTS.warnAt, redAt = DEFAULTS.redAt } = {}) {
  if (missing) {
    return { level: "note", lines: [`ℹ️ Supabase usage watch is not installed yet (${missing}). Paste sql/2026-10-09-usage-snapshots.sql into the Supabase SQL editor once; until then nothing is measured, and nothing alarms.`] };
  }
  if (error) return { level: "note", lines: [`⚠️ Supabase usage: could not read the request counter (${error}). Not alarming on a missing signal.`] };
  if (!rates || rates.rest == null) return { level: "note", lines: ["ℹ️ Supabase usage: not enough history for a rate yet (the counter was reset under an hour ago). The next run will have one."] };

  const monthly = rates.rest * 30 * bytesPerRequest;
  const used = monthly / quotaBytes;
  const level = used >= redAt ? "red" : used >= warnAt ? "warn" : "ok";
  const icon = { ok: "✅", warn: "🟡", red: "🔴" }[level];
  const basis = rates.basis === "since-reset"
    ? `over the ${rates.days.toFixed(1)} day(s) since the counter last reset`
    : `averaged over the last ${rates.days.toFixed(1)} day(s) of snapshots${rates.resets ? ` (${rates.resets} counter reset(s) handled)` : ""}`;
  const lines = [
    `${icon} Supabase database egress: ~${GB(monthly)} a month projected — ${pct(used)} of the ${GB(quotaBytes)} Free quota. ` +
      `${fmt(rates.rest)} API requests/day (site ${fmt(rates.anon)}, scraper ${fmt(rates.service)}${rates.authenticated ? `, signed-in ${fmt(rates.authenticated)}` : ""}) × ${fmt(bytesPerRequest)} bytes each, ${basis}.`,
  ];
  if (level !== "ok") {
    lines.push(
      `${level === "red" ? "🔴" : "🟡"} Past the ${pct(level === "red" ? redAt : warnAt)} line. Over the quota the org is restricted and every API returns 402 — the site goes down. ` +
        "Check first: is the site's edge cache serving (x-vercel-cache: HIT on repeat hits)? Did a deploy or a crawler surge multiply SSR renders? Then the Supabase dashboard's Usage → Egress for the real figure (this is an estimate).",
    );
  }
  if (rates.storage) lines.push(`ℹ️ Storage API: ${fmt(rates.storage)} requests/day (images live on Cloudinary; this should stay near zero apart from carousel slides).`);
  return { level, lines, monthlyBytes: monthly, usedFraction: used };
}
