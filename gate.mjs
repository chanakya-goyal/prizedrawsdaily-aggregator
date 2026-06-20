// Deterministic gating between the field scraper and the manager.
// Three layered, pure gates run at scrape time:
//   requiredGate → skip draws missing a hard-required field (owner's "only add complete draws")
//   schemaGate   → mirror the website zod so direct PostgREST writes never get rejected
//   businessGate → window / closed / min-entries (ported from extractor.evaluate)
// SKIP = drop the draw entirely (missing required / business fail). DRAFT (decided by the
// supervisor downstream) = present-but-suspicious, held for review.
import { CATEGORIES, WINDOW_DAYS } from "./lib/parse.mjs";

export const REQUIRED_FIELDS = (process.env.REQUIRED_FIELDS ||
  "title,ticket_price,total_entries,draw_date,image_url,entry_url")
  .split(",").map((s) => s.trim()).filter(Boolean);

const isUrl = (u, max = 500) => typeof u === "string" && /^https?:\/\/.+/i.test(u) && u.length <= max;
const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const round2 = (n) => Math.round(n * 100) / 100;

// 1) Presence — operator_id is guaranteed separately by run.mjs's opMap check.
export function requiredGate(draw, fields = REQUIRED_FIELDS) {
  const missing = [];
  for (const f of fields) {
    const v = draw[f];
    if (f === "ticket_price") { if (!(isNum(v) && v >= 0)) missing.push(f); }
    else if (f === "total_entries") { if (!(isNum(v) && v > 0)) missing.push(f); }
    else if (f === "draw_date") { if (!v || isNaN(new Date(v).getTime())) missing.push(f); }
    else if (f === "image_url" || f === "entry_url") { if (!isUrl(v)) missing.push(f); }
    else if (f === "title") { if (!v || !String(v).trim()) missing.push(f); }
    else if (v == null || v === "") missing.push(f);
  }
  return { ok: missing.length === 0, missing };
}

// 2) Validity — mirrors src/lib/import.functions.ts drawInputSchema. Lengths truncate
//    (safe); invalid URLs / out-of-range numbers are violations → skip.
export function schemaGate(draw) {
  const violations = [];
  const out = { ...draw };
  out.title = (out.title || "").toString().trim().slice(0, 200);
  if (!out.title) violations.push("title empty");
  if (out.description && out.description.length > 2000) out.description = out.description.slice(0, 2000);
  if (out.grand_prize && out.grand_prize.length > 500) out.grand_prize = out.grand_prize.slice(0, 500);
  if (out.image_url && !isUrl(out.image_url)) violations.push("bad image_url");
  if (out.entry_url && !isUrl(out.entry_url)) violations.push("bad entry_url");
  if (out.ticket_price != null) {
    if (!isNum(out.ticket_price) || out.ticket_price < 0 || out.ticket_price > 1_000_000) violations.push("ticket_price out of range");
    else out.ticket_price = round2(out.ticket_price);
  }
  if (out.total_entries != null) {
    if (!isNum(out.total_entries) || out.total_entries < 0 || out.total_entries > 100_000_000) violations.push("total_entries out of range");
    else out.total_entries = Math.round(out.total_entries);
  }
  if (out.category && !CATEGORIES.includes(out.category)) out.category = null; // category_id will be null
  return { ok: violations.length === 0, violations, draw: out };
}

// 3) Business rules — window / closed / min credible entries (collectibles excepted).
export function businessGate(draw, now = new Date()) {
  const reasons = [];
  const windowEnd = new Date(now.getTime() + WINDOW_DAYS * 864e5);
  const collectible = /pok[eé]mon|\bpsa\b|\bcard\b|holo|gem ?mint|ace ?10|\btcg\b|graded|\bslab\b|funko/i.test(`${draw.title} ${draw.grand_prize}`);
  const minEntries = collectible ? 50 : 500;
  if (!(draw.ticket_price > 0)) reasons.push("no/zero ticket price");
  if (!(draw.total_entries > 0)) reasons.push("no total entries");
  else if (draw.total_entries < minEntries) reasons.push(`only ${draw.total_entries} entries — non-standard draw`);
  if (!draw.draw_date) reasons.push("no draw date");
  else {
    const dt = new Date(draw.draw_date);
    if (isNaN(dt.getTime())) reasons.push("bad date");
    else if (dt < now) reasons.push("already closed");
    else if (dt > windowEnd) reasons.push(`ends >${WINDOW_DAYS}d away`);
  }
  return { ok: reasons.length === 0, reasons };
}

// Combined: returns the cleaned draw + whether it passes all three. On failure, `stage`
// and `reasons` say why (for logging the skip).
export function gate(draw, now = new Date(), fields = REQUIRED_FIELDS) {
  const req = requiredGate(draw, fields);
  if (!req.ok) return { pass: false, stage: "required", reasons: req.missing.map((f) => `missing ${f}`), draw };
  const sch = schemaGate(draw);
  if (!sch.ok) return { pass: false, stage: "schema", reasons: sch.violations, draw: sch.draw };
  const biz = businessGate(sch.draw, now);
  if (!biz.ok) return { pass: false, stage: "business", reasons: biz.reasons, draw: sch.draw };
  return { pass: true, stage: "ok", reasons: [], draw: sch.draw };
}
