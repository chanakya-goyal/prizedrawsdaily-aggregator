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
// Bun auto-loads .env, which already carries a working SUPABASE_SERVICE_ROLE_KEY — there is
// normally nothing to paste. Note the hardcoded `sb_publishable_h-iA9…` fallback that ten
// scripts in this repo still carry is STALE and now returns 401; it is deliberately not
// used here, so a missing key fails immediately and legibly instead of 401-ing later.
const READ = KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
if (!READ) {
  console.error("No key available. Bun loads .env automatically — check SUPABASE_SERVICE_ROLE_KEY is in ~/pdd-aggregator/.env,");
  console.error("and do NOT pass one on the command line unless you mean to override it.");
  process.exit(1);
}
const H = { apikey: READ, Authorization: `Bearer ${READ}` };
const WH = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const ops = await Bun.file("operators.json").json();
const RENDER = new Set(ops.filter((o) => o.method === "render").map((o) => o.slug));

const now = new Date().toISOString();
const res = await fetch(
  `${URL}/rest/v1/draws?select=id,title,entry_url,draw_date,operators!inner(slug)&status=eq.ended&draw_date=gte.${now}&order=draw_date.asc`,
  { headers: H },
);
const rows = await res.json();
// PostgREST answers failures with an object, not an array. Say so plainly rather than
// letting `rows.filter` throw a TypeError three lines later.
if (!Array.isArray(rows)) {
  console.error(`\nRead failed — HTTP ${res.status}.`);
  console.error(`PostgREST said: ${rows?.message || JSON.stringify(rows).slice(0, 200)}`);
  console.error(`\nIf you passed SUPABASE_SERVICE_ROLE_KEY on the command line, drop it —`);
  console.error(`.env already holds a working one and an explicit value overrides it.`);
  console.error(`Also confirm the project is still ${URL} (it was migrated once).`);
  process.exit(1);
}

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
      headers: { ...WH, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ status: "active" }),
    });
    if (pr.ok) { n++; continue; }
    const body = await pr.text();
    console.error(`  ! PATCH ${pr.status} for ${x.d.id}: ${body.slice(0, 160)}`);
    // Auth failures will fail identically for all 29 — stop rather than hammer the API
    // and print the same error 29 times.
    if (pr.status === 401 || pr.status === 403) {
      console.error(`\nThe service-role key was rejected (HTTP ${pr.status}).`);
      console.error(`Reads worked, so the project and query are fine — it is the key.`);
      console.error(`Check it is the SERVICE ROLE key for ${URL}`);
      console.error(`(the site migrated projects, so a key from the old project will 401),`);
      console.error(`and that no quotes or trailing newline came along with the paste.`);
      process.exit(1);
    }
  }
  console.log(`\n✅ restored ${n} draws to status='active'`);
} else if (DRY && restore.length) {
  console.log(`\n(dry run — re-run with DRY_RUN=false to restore these ${restore.length})`);
}
