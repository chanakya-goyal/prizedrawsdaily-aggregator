// Weekly patrol worklist generator (deterministic, keyless — Claude does the judging).
//   bun patrol.mjs   → patrol-worklist.json
// drift: active rows whose stored category the CURRENT rules no longer support (evidence
//        differs) — scanned for category_source='rule' OR null (legacy rows, or rows corrected
//        by tools that write category_id alone). claude/manual rows are never re-litigated;
//        everything else — rule-stamped or unstamped — is re-checkable.
// detail_sample: the half of the live catalogue whose turn it is this week (stateless
//        rotation: id-hash parity vs ISO-week parity), for price/entries/date/prize re-proof.
import { writeFileSync } from "fs";
import { inferCategory } from "./lib/parse.mjs";

export function weekParity(d = new Date()) {
  const oneJan = Date.UTC(d.getUTCFullYear(), 0, 1);
  return (Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - oneJan) / 604800000) % 2);
}
export function inSample(id, parity) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 2) === parity;
}

if (import.meta.main) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const H = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/draws?select=id,title,grand_prize,entry_url,ticket_price,total_entries,draw_date,category_source,categories(slug),operators(slug)&status=eq.active`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const drift = rows.filter((d) => d.category_source === "rule" || d.category_source == null).flatMap((d) => {
    const ev = inferCategory({ title: d.title, grand_prize: d.grand_prize });
    const stored = d.categories?.slug ?? null;
    return ev && ev !== stored ? [{ id: d.id, title: d.title, stored, evidence: ev, op: d.operators?.slug }] : [];
  });
  const parity = weekParity();
  const detail_sample = rows.filter((d) => inSample(d.id, parity)).map((d) => ({
    id: d.id, title: d.title, entry_url: d.entry_url, op: d.operators?.slug,
    ticket_price: d.ticket_price, total_entries: d.total_entries, draw_date: d.draw_date, grand_prize: d.grand_prize,
  }));
  const out = { week: parity, generated: new Date().toISOString(), counts: { active: rows.length, drift: drift.length, detail_sample: detail_sample.length }, drift, detail_sample };
  writeFileSync("patrol-worklist.json", JSON.stringify(out, null, 2));
  console.log(`patrol-worklist.json → active=${rows.length} drift=${drift.length} sample=${detail_sample.length} (week parity ${parity})`);
}
