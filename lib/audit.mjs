// Does a LIVE row still match the operator's page?
//
// run.mjs corrects live rows, but only the ones it re-reads, and it reaches rows by crawling
// the operator's LISTING. Anything that has fallen off that listing — past its date, or beyond
// the per-operator cap — is never looked at again. Measured 2026-09-06: 973 active rows, 359
// refreshed by the day's two scrapes, so ~614 live rows carried whatever they were written with
// and nothing in the pipeline would ever notice if that was wrong.
//
// The sweep already reads every one of those rows to decide whether the comp has ended, and it
// already parses the page. This turns that same read into a correctness check, at no extra
// network cost.
//
// THE TRAP THIS MODULE EXISTS TO AVOID
// -----------------------------------
// Comparing stored against a fresh read is only sound when the fresh read is AS AUTHORITATIVE as
// the one that produced the stored value. It usually is not. Ingest reads a woo product's cap
// from the product PAGE; the sweep only holds the API payload, where the cap does not appear. A
// naive comparison would therefore see `total_entries: 5000 → null` on every woo row and
// "correct" the whole catalogue to null. That single mistake would be worse than everything
// this is meant to catch.
//
// So a field is compared ONLY where the sweep's source answers it at ingest authority, and every
// other field is carried over from the stored row so it compares equal and cannot manufacture
// drift. `comparableFields` is that whitelist, and it is deliberately small.
import { correctionDecision } from "./verify.mjs";

// source → the fields that source can answer as well as ingest did.
//
//  render  the sweep runs the SAME fieldsFromHtml over the SAME product page that ingest used,
//          so every field is directly comparable.
//  woo     the Store API carries the authoritative price (it is what the customer is charged)
//          but not the entry cap, and its text is a subset of the product page ingest parses —
//          so price only. Cap and date on woo rows are run.mjs's job, and it reaches them: the
//          JSON sweep re-reads each operator's whole live catalogue at PER_OP_API=60.
//  shopify the /products.json list feed carries availability and nothing else we store.
//  api     adapter-shaped; the sweep holds no per-field payload.
export function comparableFields(source) {
  if (source === "render") return new Set(["ticket_price", "total_entries", "draw_date", "title"]);
  if (source === "woo") return new Set(["ticket_price"]);
  return new Set();
}

export const COMPARABLE_KEYS = ["ticket_price", "total_entries", "draw_date", "title"];

// Build the object correctionDecision compares against: genuinely-fresh values for the
// comparable fields, stored values for everything else. Carrying the stored value over is what
// stops an unanswerable field from reading as drift.
//
// The non-comparable half matters just as much, and less obviously. correctionDecision runs
// fieldFlags over this object and REFUSES to write when anything is flagged — and fieldFlags
// inspects image_url and entry_url, which the sweep's woo payload does not carry at all. Left
// as-is, every woo row would flag "missing/bad image; bad entry_url", every audit verdict would
// come back `review`, and the whole feature would quietly do nothing while looking healthy.
// These come from the stored row because the flags are meant to describe the ROW being judged,
// not the completeness of the sweep's partial read.
export function mergeForComparison(stored, fresh, comparable) {
  const out = {
    ...fresh,
    image_url: fresh?.image_url ?? stored.image_url,
    entry_url: fresh?.entry_url ?? stored.entry_url,
    // Only ever read to compute flags; verifyAgainstStored falls back to it too.
    description: fresh?.description ?? stored.prize_description,
  };
  for (const key of COMPARABLE_KEYS) {
    if (!comparable.has(key) || out[key] == null) out[key] = stored[key];
  }
  return out;
}

// A page that refused us is not a page that changed. A WAF challenge or block interstitial
// parses perfectly happily — it has a <title>, it has text — and the first live measurement of
// this audit proposed renaming a real competition to "Sorry, you have been blocked". Any read
// carrying one of these is discarded whole, not field by field: nothing on such a page is ours.
const BLOCKED_TITLE = /sorry,? you have been blocked|attention required|just a moment|access denied|are you a robot|checking your browser|cloudflare|403 forbidden|error 10\d\d/i;
export function readLooksBlocked(fresh) {
  return !!fresh && typeof fresh.title === "string" && BLOCKED_TITLE.test(fresh.title);
}

// Which of the comparable fields may be WRITTEN automatically.
//
// This is narrower than `comparableFields` on purpose, and the gap between them is the whole
// lesson of the first live run. Auditing 956 live rows proposed 9 corrections; every one came
// from `render` and every one was wrong:
//   * a Cloudflare interstitial became a new title
//   * five draw_dates moved BACKWARDS into the past, which would have deleted those comps from
//     a site that lists on `draw_date >= now`
//   * three entry caps "moved" — 63,300 to 1,233 — which is a sold counter being read as a cap,
//     precisely what hard rule R1 exists to forbid
// Zero came from `woo`, where the price is a structured API field rather than a text parse, and
// 333 rows matched exactly. So the line is drawn at PROVENANCE, not at field name: a value the
// operator states in a machine-readable field may be written; a value we inferred from prose may
// only be reported. Render rows are therefore report-only until a parse carries its provenance.
export function correctableFields(source) {
  if (source === "woo") return new Set(["ticket_price", "total_prize_value"]);
  return new Set();
}

// action:
//   ok      the page agrees with what the site is showing
//   correct a CLEAN fresh read disagrees — patch the row (same bar run.mjs applies)
//   review  a disagreement we cannot safely act on, because the fresh read is itself flagged.
//           Never written. A flagged read is more likely a broken parse than a changed page,
//           so acting on it would remove or rewrite a good row — the false positive that costs
//           inventory and shakes trust in the data. It is reported for the weekly routine.
//   skip    nothing comparable, or the row could not be read at all. We never act on the
//           absence of evidence; that rule is why this pipeline has not expired live comps.
export function auditDecision(stored, fresh, evidence = {}, { now = new Date() } = {}) {
  if (!evidence.reachable) return { action: "skip", reason: "not reachable", fields: [] };
  if (readLooksBlocked(fresh)) return { action: "skip", reason: "read is a block/challenge page, not the product", fields: [] };
  const comparable = comparableFields(evidence.source);
  if (!comparable.size) return { action: "skip", reason: `no comparable fields for source '${evidence.source ?? "?"}'`, fields: [] };
  // A source that answered NOTHING is a failed read wearing a successful one's clothes.
  if (![...comparable].some((k) => fresh?.[k] != null)) {
    return { action: "skip", reason: "read returned no comparable values", fields: [] };
  }

  const merged = mergeForComparison(stored, fresh, comparable);
  const decision = correctionDecision(stored, merged, { now });
  // Only ever report drift on fields we were allowed to compare. correctionDecision also
  // derives total_prize_value from price × cap, which is legitimate here: it is arithmetic over
  // values we already agree with, and a stale pool is exactly the kind of quiet wrongness this
  // is for.
  const fields = decision.fields.filter((f) => comparable.has(f) || f === "total_prize_value");
  if (!fields.length) return { action: "ok", reason: "matches the page", fields: [], drift: {} };
  const drift = Object.fromEntries(fields.map((f) => [f, decision.drift[f]]));
  if (!decision.correct) return { action: "review", reason: decision.reason, fields, drift };
  // Clean disagreement, but only a structurally-sourced field may be written unattended.
  const correctable = correctableFields(evidence.source);
  const notWritable = fields.filter((f) => !correctable.has(f));
  if (notWritable.length) {
    return { action: "review", reason: `inferred from page text, not a structured field (${notWritable.join(", ")})`, fields, drift };
  }
  return { action: "correct", reason: decision.reason, fields, drift };
}

// The patch to send. Mirrors run.mjs's correction write exactly: pool always, the rest only when
// something other than the pool moved, and never image_url — the stored image is a proven-
// reachable URL on our own storage and is not why we are here.
export function auditPatch(stored, fresh, fields, comparable) {
  const merged = mergeForComparison(stored, fresh, comparable);
  const row = {};
  if (fields.includes("total_prize_value")) {
    row.total_prize_value = Math.min(Math.round((merged.ticket_price || 0) * (merged.total_entries || 0) * 100) / 100, 1_000_000_000);
  }
  for (const f of COMPARABLE_KEYS) {
    if (fields.includes(f)) row[f] = merged[f];
  }
  // Keep the derived pool consistent with any input we just moved, even if the arithmetic
  // check did not fire on its own.
  if (fields.some((f) => f === "ticket_price" || f === "total_entries")) {
    row.total_prize_value = Math.min(Math.round((merged.ticket_price || 0) * (merged.total_entries || 0) * 100) / 100, 1_000_000_000);
  }
  return row;
}

// Should the audit actually WRITE? This is the most dangerous decision in the pipeline — it
// patches rows the public is reading — so it is a pure function with tests rather than an inline
// condition nobody can exercise.
//
// Four independent things must all hold. Any one of them false means write nothing:
//   mode === "apply"   writing is opt-in; "report" (the default, and what both workflows set)
//                      verifies and touches nothing
//   !dry               DRY_RUN is honoured here exactly as it is for the ended writes
//   count > 0          nothing to do
//   count <= max       a ceiling. Many live rows disagreeing at once is a PARSER change, not
//                      hundreds of operators changing their prices on the same morning, and the
//                      right response to that is to stop and shout rather than rewrite the
//                      catalogue on one bad read.
export function shouldApplyAudit({ mode, dry, count, max }) {
  if (String(mode).toLowerCase() !== "apply") return { apply: false, reason: "report mode — set AUDIT=apply to write" };
  if (dry) return { apply: false, reason: "dry run" };
  if (!count) return { apply: false, reason: "nothing to correct" };
  if (count > max) return { apply: false, reason: `${count} corrections exceeds AUDIT_MAX=${max} — this many live rows disagreeing at once is a parser change, not an operator change` };
  return { apply: true, reason: `applying ${count} correction(s)` };
}
