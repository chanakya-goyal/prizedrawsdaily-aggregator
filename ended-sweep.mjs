// Ended-comp sweep: a draft draw whose WooCommerce/Shopify product is no longer PURCHASABLE is a
// FINISHED competition that was scraped in error (or has since closed) — it must not sit in the
// "live" draft queue. is_purchasable===false is the operator's own authoritative "ended" flag
// (is_in_stock stays true after a draw closes, so we key on is_purchasable). For shopify we use
// the absence of an available variant; for render-only operators we fall back to a "finished" text
// probe on the page. Conservative: only an explicit not-purchasable / finished signal marks ended.
//
//   DRY_RUN=true (default) → report only.  DRY_RUN=false → set status='ended' on the finished ones.
import { UA } from "./lib/parse.mjs";
const URL = "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN !== "false";
if (!DRY && !KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const READ = KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const H = { apikey: READ, Authorization: `Bearer ${READ}` };
const FINISHED_RE = /this competition has (?:now )?finished|competition (?:has )?finished|competition is (?:now )?closed|this draw has (?:now )?(?:ended|closed)/i;

const ops = await Bun.file("operators.json").json();
const opBy = Object.fromEntries(ops.map((o) => [o.slug, o]));
const draws = await (await fetch(`${URL}/rest/v1/draws?status=eq.draft&select=id,title,entry_url,draw_date,operators(slug,name)`, { headers: H })).json();
console.log(`${DRY ? "DRY RUN" : "LIVE"} — checking ${draws.length} draft draws for ended comps\n`);

const slugFromUrl = (u) => (u || "").replace(/[#?].*$/, "").replace(/\/+$/, "").split("/").pop() || "";
async function isEnded(d) {
  const op = opBy[d.operators?.slug];
  if (!op) return { ended: null, why: "operator not in config" };
  const slug = slugFromUrl(d.entry_url);
  try {
    if (op.method === "woo") {
      const r = await fetch(`${op.base}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(slug)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      const arr = await r.json();
      const p = Array.isArray(arr) ? arr[0] : null;
      if (!p) return { ended: null, why: "product not found in API" };
      if (p.is_purchasable === false) return { ended: true, why: `not purchasable (stock: ${p.stock_availability?.text || "?"})` };
      return { ended: false, why: "purchasable" };
    }
    if (op.method === "shopify") {
      const r = await fetch(`${op.base}/products/${slug}.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => null);
      const p = j?.product;
      if (!p) return { ended: null, why: "product not found" };
      const avail = (p.variants || []).some((v) => v.available);
      return { ended: !avail, why: avail ? "available" : "no available variant" };
    }
    // render / other: text probe
    const html = await (await fetch(d.entry_url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) })).text();
    return { ended: FINISHED_RE.test(html), why: FINISHED_RE.test(html) ? "page says finished" : "no finished marker" };
  } catch (e) { return { ended: null, why: `error ${(e.message || "").slice(0, 30)}` }; }
}

// bounded concurrency
let i = 0; const out = [];
async function w() { while (i < draws.length) { const d = draws[i++]; out.push({ d, ...(await isEnded(d)) }); } }
await Promise.all(Array.from({ length: 8 }, w));

const ended = out.filter((x) => x.ended === true);
const unknown = out.filter((x) => x.ended === null);
console.log(`ENDED (finished comps in the draft queue): ${ended.length}`);
for (const x of ended) console.log(`  ⛔ [${x.d.operators?.slug}] ${(x.d.title || "").slice(0, 44)} — ${x.why}`);
if (unknown.length) { console.log(`\nUNKNOWN (couldn't verify — left as-is): ${unknown.length}`); for (const x of unknown.slice(0, 12)) console.log(`  ? [${x.d.operators?.slug}] ${(x.d.title || "").slice(0, 40)} — ${x.why}`); }

if (!DRY && ended.length) {
  let n = 0;
  for (const x of ended) {
    const pr = await fetch(`${URL}/rest/v1/draws?id=eq.${x.d.id}`, { method: "PATCH", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ status: "ended" }) });
    if (pr.ok) n++; else console.log(`  ! PATCH ${pr.status} for ${x.d.id}`);
  }
  console.log(`\n✅ marked ${n} finished comps as status='ended' (removed from the live draft queue)`);
} else if (DRY) {
  console.log(`\n(dry run — re-run with DRY_RUN=false to mark these ${ended.length} as ended)`);
}
