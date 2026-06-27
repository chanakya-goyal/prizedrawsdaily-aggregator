// Apply the grand-prize vision-QA results: PATCH grand_prize + category, and mark ended draws.
// Conservative: low-confidence results are NOT auto-applied (listed for manual review instead).
//   RESULTS=/path/to/results.json  DRY_RUN=true|false
const URL = "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN !== "false";
const FILE = process.env.RESULTS;
if (!FILE) { console.error("need RESULTS=/path/to/results.json"); process.exit(1); }
if (!DRY && !KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const catId = Object.fromEntries((await (await fetch(`${URL}/rest/v1/categories?select=slug,id`, { headers: H })).json()).map((c) => [c.slug, c.id]));

const raw = await Bun.file(FILE).json();
const results = Array.isArray(raw) ? raw : (raw.results || []);
console.log(`${DRY ? "DRY RUN" : "LIVE"} — applying ${results.length} vision results\n`);

let gpFix = 0, catFix = 0, ended = 0, lowConf = [];
for (const r of results) {
  if (!r || !r.id) continue;
  const patch = {}; const notes = [];
  const conf = r.confidence || "low";
  if (r.is_live === false) { patch.status = "ended"; notes.push("→ ended (finished)"); }
  if (conf !== "low") {
    if (r.grand_prize && r.grand_prize.trim() && r.grand_prize !== r._cur_gp) { patch.grand_prize = r.grand_prize.trim(); notes.push(`prize "${(r._cur_gp || "").slice(0, 24)}" → "${r.grand_prize}"`); gpFix++; }
    if (r.category && r.category !== r._cur_cat && catId[r.category]) { patch.category_id = catId[r.category]; notes.push(`category ${r._cur_cat} → ${r.category}`); catFix++; }
  } else {
    lowConf.push(r);
  }
  if (Object.keys(patch).length) {
    if (patch.status === "ended") ended++;
    console.log(`  ${DRY ? "would" : "✅"} [${(r._title || r.id).slice(0, 34)}] ${notes.join(" · ")}  (${conf})`);
    if (!DRY) {
      const pr = await fetch(`${URL}/rest/v1/draws?id=eq.${r.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      if (!pr.ok) console.log(`     ! PATCH ${pr.status} ${(await pr.text()).slice(0, 70)}`);
    }
  }
}
console.log(`\n==== ${DRY ? "would apply" : "applied"}: ${gpFix} grand_prize · ${catFix} category · ${ended} marked ended · ${lowConf.length} low-confidence (manual) ====`);
if (lowConf.length) {
  await Bun.write(`${process.env.HOME}/Desktop/pdd-draft-low-confidence.json`, JSON.stringify(lowConf, null, 2));
  console.log("low-confidence list → ~/Desktop/pdd-draft-low-confidence.json");
  for (const r of lowConf.slice(0, 10)) console.log(`  ? [${(r._title || "").slice(0, 34)}] suggested "${r.grand_prize}" — ${(r.evidence || "").slice(0, 50)}`);
}
