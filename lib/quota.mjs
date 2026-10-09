// The guardian's rules: given every free limit's reading and its recent history, say how close
// each is, how fast it is moving, and whether a human is needed. quota-watch.mjs measures; this
// decides; test/quota.test.mjs pins it.
//
// WHY ONE GUARDIAN: every outage so far was a free limit that filled with nobody looking:
// Supabase storage (Aug and Oct 2026), Supabase egress (Sep and Oct), and Cloudinary credits
// nearly (Oct). Each alarm was added after its own incident and watched only a percentage, so
// a limit filling fast from a low level was invisible until it was nearly full. This watches
// all of them in one table, with a forecast:
//
//   red   ≥ 90% used, or forecast to fill within 7 days     → the run fails, the issue opens
//   warn  ≥ 80% used, or forecast to fill within 21 days    → the issue opens, the run stays green
//   ok    otherwise
//   note  the reading failed or is not set up: reported, never an alarm
//
// A metric can override its thresholds (the egress estimate warns at 50%), or opt out of
// forecasting (a figure that is already a projection, or a cache that evicts by itself).

export const DEFAULTS = Object.freeze({ warnShare: 0.8, redShare: 0.9, warnDays: 21, redDays: 7, windowDays: 7 });
const DAY = 864e5;
const RANK = { ok: 0, note: 0, warn: 1, red: 2 };

/**
 * Change per day over the last `windowDays`, by least squares over the daily readings
 * (oldest first, `{ day: "YYYY-MM-DD", value }`). Null until the readings span a day.
 */
export function perDay(history, { windowDays = DEFAULTS.windowDays } = {}) {
  const pts = history.map((h) => ({ t: Date.parse(`${h.day}T00:00:00Z`) / DAY, v: Number(h.value) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  const end = pts.at(-1).t;
  const w = pts.filter((p) => p.t >= end - windowDays);
  if (w.length < 2 || w.at(-1).t - w[0].t < 1) return null;
  const mt = w.reduce((a, p) => a + p.t, 0) / w.length;
  const mv = w.reduce((a, p) => a + p.v, 0) / w.length;
  const num = w.reduce((a, p) => a + (p.t - mt) * (p.v - mv), 0);
  const den = w.reduce((a, p) => a + (p.t - mt) ** 2, 0);
  return den ? num / den : null;
}

/** Days until `limit` at `rate` per day. Infinity when flat or shrinking. */
export function daysLeft(value, limit, rate) {
  if (!(rate > 0)) return Infinity;
  return Math.max(0, (limit - value) / rate);
}

const fmtValue = (v, unit) => {
  if (unit === "bytes") return v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : `${(v / 1e6).toFixed(0)} MB`;
  if (unit === "credits") return `${Number(v).toFixed(2)}`;
  return Math.round(v).toLocaleString("en-GB");
};

/**
 * metrics: [{ key, label, value, limit, unit, history?, forecast? = true, warnShare?, redShare?,
 *             note?, error?, hint? }]
 * Returns { level, rows, lines } — rows are what the report table shows.
 */
export function assessQuotas(metrics, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rows = [];
  let level = "ok";
  for (const m of metrics) {
    if (m.error || m.note || !(m.limit > 0) || !Number.isFinite(Number(m.value))) {
      rows.push({ key: m.key, label: m.label, level: "note", used: null, text: m.error ? `could not read (${m.error})` : (m.note || "no reading") });
      continue;
    }
    const share = m.value / m.limit;
    const rate = m.forecast === false ? null : perDay(m.history || [], o);
    const left = rate == null ? Infinity : daysLeft(m.value, m.limit, rate);
    const warnShare = m.warnShare ?? o.warnShare;
    const redShare = m.redShare ?? o.redShare;
    const lv = share >= redShare || left <= o.redDays ? "red" : share >= warnShare || left <= o.warnDays ? "warn" : "ok";
    if (RANK[lv] > RANK[level]) level = lv;
    rows.push({
      key: m.key, label: m.label, level: lv, used: share,
      value: fmtValue(m.value, m.unit), limit: fmtValue(m.limit, m.unit),
      change: rate == null ? (m.forecast === false ? "—" : "learning") : `${rate >= 0 ? "+" : ""}${fmtValue(rate, m.unit)}/day`,
      left: rate == null || left === Infinity ? "—" : `${Math.floor(left)} days`,
      hint: lv === "ok" ? "" : m.hint || "",
    });
  }
  const icon = { ok: "✅", warn: "🟡", red: "🔴", note: "⚪" };
  const lines = [
    "| | Limit | Used | % | Change | Full in |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => r.used == null
      ? `| ${icon.note} | ${r.label} | ${r.text} | | | |`
      : `| ${icon[r.level]} | ${r.label} | ${r.value} of ${r.limit} | ${(r.used * 100).toFixed(1)}% | ${r.change} | ${r.left} |`),
  ];
  const actions = rows.filter((r) => r.hint).map((r) => `- ${icon[r.level]} **${r.label}**: ${r.hint}`);
  return { level, rows, lines: actions.length ? [...lines, "", ...actions] : lines };
}
