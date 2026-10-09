// Daily Supabase egress alarm: read the API request counter, record a snapshot, project a
// month of egress, and say in plain English whether a human is needed. Writes usage-watch.md
// (the issue body the workflow posts under the `usage-alarm` label).
//
// WHY: the old project's org went over its 5 GB egress quota in Sep and again in Oct 2026, and
// both times the first signal was the dashboard — then a grace period, then 402 on every API.
// Nothing in the pipeline watched egress, because Supabase has no egress API on the Free plan.
// This watches the closest thing the database itself records. Rules: lib/usage-watch.mjs.
//
//   bun usage-watch.mjs           # exit 0 ok · 2 warn (≥50%) · 1 red (≥80%) · 3 no signal
//   USAGE_BYTES_PER_REQUEST=4200  # calibration (lib/usage-watch.mjs says how to recalibrate)
//   USAGE_EGRESS_QUOTA_BYTES=5e9  # Free plan
//   USAGE_WARN_AT=0.5 USAGE_RED_AT=0.8
//
// Needs sql/2026-10-09-usage-snapshots.sql applied once. Without it — or when the counter cannot
// be read — this prints a note and exits 3 ("no signal"): never an alarm, and never a reason for
// the workflow to close an alarm that is already open. Its only write is one usage_snapshots row.
import { requestRates, assessUsage, toSnapshot, DEFAULTS } from "./lib/usage-watch.mjs";

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error("✗ needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const num = (v, d) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const opts = {
  bytesPerRequest: num(process.env.USAGE_BYTES_PER_REQUEST, DEFAULTS.bytesPerRequest),
  quotaBytes: num(process.env.USAGE_EGRESS_QUOTA_BYTES, DEFAULTS.quotaBytes),
  warnAt: num(process.env.USAGE_WARN_AT, DEFAULTS.warnAt),
  redAt: num(process.env.USAGE_RED_AT, DEFAULTS.redAt),
};

// PostgREST answers "no such function/table" with these codes (or a 404). Anything else is a
// real failure, reported but not alarmed on.
const NOT_INSTALLED = new Set(["PGRST202", "PGRST205", "42883", "42P01"]);
async function call(path, init = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) }, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const code = body?.code;
    const err = new Error(`HTTP ${r.status}${code ? ` ${code}` : ""}${body?.message ? `: ${String(body.message).slice(0, 100)}` : ""}`);
    err.notInstalled = r.status === 404 || NOT_INSTALLED.has(code);
    throw err;
  }
  return body;
}

let result, measured = [];
try {
  const rows = await call("rpc/api_request_total", { method: "POST", body: "{}" });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw Object.assign(new Error("api_request_total() returned no row"), { notInstalled: false });
  const snap = toSnapshot(row);
  await call("usage_snapshots", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(snap) });
  const since = new Date(Date.now() - (DEFAULTS.windowDays + 1) * 864e5).toISOString();
  const history = await call(`usage_snapshots?select=*&taken_at=gte.${encodeURIComponent(since)}&order=taken_at.asc`);
  const rates = requestRates(history);
  result = assessUsage({ rates, ...opts });
  measured = [
    `- counter now: site ${snap.rest_anon}, scraper ${snap.rest_service}, signed-in ${snap.rest_authenticated}, storage ${snap.storage} (since reset ${snap.stats_reset ?? "?"})`,
    `- snapshots in the window: ${history.length}; rate basis: ${rates.basis}`,
    `- bytes/request ${opts.bytesPerRequest} · quota ${opts.quotaBytes} · warn ${opts.warnAt} · red ${opts.redAt}`,
  ];
} catch (e) {
  result = e.notInstalled ? assessUsage({ missing: e.message }) : assessUsage({ error: (e.message || String(e)).slice(0, 160) });
}

const body = [
  `## Supabase usage — ${new Date().toISOString().slice(0, 10)}`,
  "",
  ...result.lines.map((l) => `- ${l}`),
  "",
  ...(measured.length ? ["<details><summary>Measurements</summary>", "", ...measured, "", "</details>"] : []),
].join("\n");

await Bun.write("usage-watch.md", body + "\n");
console.log(body);
process.exit({ red: 1, warn: 2, note: 3 }[result.level] ?? 0);
