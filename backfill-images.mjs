// One-time backfill: re-host EXISTING draw images onto our own Supabase Storage so the live
// site stops hotlinking third-party operator hosts. Fixes images already broken by Cloudflare
// bot protection (e.g. Borders Competitions) and — in mode=all — pre-empts every other hotlink
// before it can break. Reuses the exact same lib/rehost.mjs the live aggregator now uses.
//
//   DRY_RUN=true (default) → report only, no writes
//   DRY_RUN=false          → upload bytes + PATCH draws.image_url  (needs SUPABASE_SERVICE_ROLE_KEY)
//   MODE=broken (default)  → only re-host images that fail to load right now (surgical)
//   MODE=all               → re-host every non-Supabase image (kills all hotlinks site-wide)
//   STATUS=active          → comma-list of draw statuses to scan (e.g. STATUS=active,draft)
//
// "Broken" means broken ON THE LIVE SITE, which loads every image through the
// images.weserv.nl proxy (src/lib/img.ts → SmartImg). Some origins return 200 to a
// direct fetch yet weserv still can't proxy them — either the origin 403s weserv's
// servers specifically (datacenter IP/UA) or weserv has policy-blocked the domain
// (phatlads.com, easylivingcompetitions.co.uk). So reachability is tested through the
// SAME weserv URL the browser requests, not a direct origin fetch.
import { rehostImage } from "./lib/rehost.mjs";
import { UA } from "./lib/parse.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const DRY_RUN = process.env.DRY_RUN !== "false";
const MODE = process.env.MODE || "broken";
const STATUS = (process.env.STATUS || "active").split(",").map((s) => s.trim()).filter(Boolean);
const READ = SERVICE_KEY || ANON;

if (!DRY_RUN && !SERVICE_KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const sb = { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY };

// Mirror src/lib/img.ts img(): the live site never loads the origin directly — it asks
// images.weserv.nl to fetch + re-encode it. Test that exact URL so "reachable" == "shows
// on the site".
const weservUrl = (url) =>
  `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=640&output=webp&q=72&we`;

async function reachable(url) {
  try {
    const r = await fetch(weservUrl(url), { headers: { "User-Agent": UA }, redirect: "follow" });
    const type = (r.headers.get("content-type") || "").toLowerCase();
    return r.ok && type.startsWith("image/");
  } catch { return false; }
}

const listUrl = `${SUPABASE_URL}/rest/v1/draws?status=in.(${STATUS.join(",")})&select=id,slug,title,image_url,operators(slug)`;
const draws = await (await fetch(listUrl, { headers: { apikey: READ, Authorization: `Bearer ${READ}` } })).json();
console.log(`${DRY_RUN ? "DRY RUN" : "LIVE"} | mode=${MODE} | status=${STATUS.join("+")} | ${draws.length} draws\n`);

let fixed = 0, missed = 0, ok = 0, ours = 0;
for (const d of draws) {
  const img = d.image_url || "";
  const opSlug = (d.operators || {}).slug || "misc";
  if (!img) { ok++; continue; }
  if (img.startsWith(SUPABASE_URL)) { ours++; continue; }
  if (MODE === "broken" && (await reachable(img))) { ok++; continue; } // currently loads fine — leave it

  if (DRY_RUN) { console.log(`  would re-host  [${opSlug}] ${d.title.slice(0, 48)}`); fixed++; continue; }
  try {
    const res = await rehostImage(img, opSlug, d.slug, sb);
    if (!res.changed) { missed++; console.log(`  ⚠️ unreachable, kept origin  [${opSlug}] ${d.title.slice(0, 44)}`); continue; }
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/draws?id=eq.${d.id}`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: res.url }),
    });
    if (pr.ok) { fixed++; console.log(`  ✅ [${res.via}] ${d.title.slice(0, 48)}`); }
    else { missed++; console.log(`  ! PATCH ${pr.status} for ${d.slug}`); }
  } catch (e) { missed++; console.log(`  ! ${d.slug}: ${(e.message || "").slice(0, 70)}`); }
}
console.log(`\n==== ${DRY_RUN ? "would re-host" : "re-hosted"} ${fixed} · ${missed} still-unreachable · ${ok} fine/empty · ${ours} already ours ====`);
