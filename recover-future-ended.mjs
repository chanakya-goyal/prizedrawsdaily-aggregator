// One-off recovery for draws that ended-sweep expired on the raw-HTML bug.
//
// THE BUG (fixed 2026-08-26 in lib/liveness.mjs + ended-sweep.mjs): the sweep ran
// `FINISHED_RE.test(html)` against the unparsed page body. wc-lottery ships an i18n string
// bundle inside a <script> on every page it renders — live or finished — and that bundle
// contains the literal "This competition has finished". Every draw on those operators
// therefore matched and was expired. Reproduced live on island-competitions (closes
// 2026-08-28) and game-changing-giveaways (closes 2026-08-30): raw HTML matches, visible
// text does not.
//
// SCOPE — deliberately narrow. Only draws that are ALL of:
//   1. status='ended'
//   2. draw_date still in the FUTURE (a past-dated draw is legitimately over)
//   3. on a `render` operator — the text-probe path, the only one that was broken
//   4. re-probed NOW and saysFinished() returns false
//
// Woo/Shopify victims are NOT touched. Those were expired by `is_purchasable=false` or an
// unavailable variant, which is the operator's own authoritative flag: a draw can sell out
// before its draw_date and that expiry is correct. Recovering them would republish
// competitions nobody can enter.
//
//   DRY_RUN=true (default) → report only.
//   DRY_RUN=false + SUPABASE_SERVICE_ROLE_KEY → restore status='active'.
import { UA } from "./lib/parse.mjs";
import { saysFinished } from "./lib/liveness.mjs";

const URL = "https://ilnegxrsalmzpljotgpe.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN !== "false";
if (!DRY && !KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const READ = KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const H = { apikey: READ, Authorization: `Bearer ${READ}` };

const ops = await Bun.file("operators.json").json();
const RENDER = new Set(ops.filter((o) => o.method === "render").map((o) => o.slug));

const now = new Date().toISOString();
const rows = await (await fetch(
  `${URL}/rest/v1/draws?select=id,title,entry_url,draw_date,operators!inner(slug)&status=eq.ended&draw_date=gte.${now}&order=draw_date.asc`,
  { headers: H },
)).json();

const candidates = rows.filter((d) => RENDER.has(d.operators?.slug));
const skipped = rows.filter((d) => !RENDER.has(d.operators?.slug));
console.log(`${DRY ? "DRY RUN" : "LIVE"} — ${rows.length} ended draws with a future close date`);
console.log(`  ${candidates.length} on render operators (re-probing these)`);
console.log(`  ${skipped.length} on woo/shopify — NOT touched, their expiry flag is authoritative\n`);

// Same bounded concurrency as ended-sweep.
let i = 0;
const out = [];
async function w() {
  while (i < candidates.length) {
    const d = candidates[i++];
    try {
      const html = await (await fetch(d.entry_url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) })).text();
      out.push({ d, live: !saysFinished(html), why: saysFinished(html) ? "page really does say finished" : "no finished marker in visible text" });
    } catch (e) {
      out.push({ d, live: false, why: `unreachable (${(e.message || "").slice(0, 30)}) — left ended` });
    }
  }
}
await Promise.all(Array.from({ length: 8 }, w));

const restore = out.filter((x) => x.live);
const leave = out.filter((x) => !x.live);

console.log(`RESTORE to active: ${restore.length}`);
for (const x of restore) console.log(`  ✅ [${x.d.operators?.slug}] ${(x.d.title || "").slice(0, 46)} — closes ${String(x.d.draw_date).slice(0, 10)}`);
if (leave.length) {
  console.log(`\nLEAVE ended: ${leave.length}`);
  for (const x of leave) console.log(`  ⛔ [${x.d.operators?.slug}] ${(x.d.title || "").slice(0, 40)} — ${x.why}`);
}

if (!DRY && restore.length) {
  let n = 0;
  for (const x of restore) {
    const pr = await fetch(`${URL}/rest/v1/draws?id=eq.${x.d.id}`, {
      method: "PATCH",
      headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ status: "active" }),
    });
    if (pr.ok) n++; else console.log(`  ! PATCH ${pr.status} for ${x.d.id}`);
  }
  console.log(`\n✅ restored ${n} draws to status='active'`);
} else if (DRY && restore.length) {
  console.log(`\n(dry run — re-run with DRY_RUN=false to restore these ${restore.length})`);
}
