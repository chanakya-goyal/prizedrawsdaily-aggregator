// One-off corrector for the 4 draws the owner flagged on 2026-06-28 (admin draft review).
// Each had a wrong total_entries and/or grand_prize and/or category that the keyless scraper
// could not read (image-baked prize / JS-rendered ticket bar / missing faction keyword). The
// scraper itself is now hardened (see lib/parse.mjs, gate.mjs, operators.json) so FUTURE runs
// get these right; this script repairs the rows already sitting in the draft queue.
//
//   DRY_RUN=true (default) → preview old→new.   DRY_RUN=false → apply PATCHes.
// Needs SUPABASE_SERVICE_ROLE_KEY (the anon key cannot see/patch draft rows under RLS).
const URL = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN !== "false";
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY (anon key can't read draft rows)"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const round2 = (n) => Math.round(n * 100) / 100;

// category slug → id (for the one category change: Astra → collectibles)
const catId = Object.fromEntries((await (await fetch(`${URL}/rest/v1/categories?select=slug,id`, { headers: H })).json()).map((c) => [c.slug, c.id]));

// The corrections. `match` finds the row in the draft queue; `fields` are the verified values
// read straight off the operator's live page (screenshots supplied by the owner).
const TARGETS = [
  {
    label: "Wild West Bingo (Podium)",
    match: (d) => /podiumprize\.co\.uk/.test(d.entry_url) && /wild-west-bingo/.test(d.entry_url),
    entries: 66000,                                   // bar "TOTAL: 66000" (NOT the "MAX 15000 ENTRIES" banner)
    grand_prize: "Win up to £150",                    // printed on the banner image ("WIN UP TO £150")
    category: "cash-prizes",
  },
  {
    label: "Every Ticket Wins (Podium)",
    match: (d) => /podiumprize\.co\.uk/.test(d.entry_url) && /every-ticket-wins/.test(d.entry_url),
    entries: 30000,                                   // bar "TOTAL: 30000" (NOT the "MAX 7500 ENTRIES" banner)
    grand_prize: "£15,000 in prizes — win up to £500 instantly", // banner: "£15,000 IN PRIZES", not the lifetime "£500,000" boast
    category: "cash-prizes",
  },
  {
    label: "Quick Mini (BigBeastie)",
    match: (d) => /bigbeastiecompetitions\.co\.uk/.test(d.entry_url) && /quick-mini-for-tonights/.test(d.entry_url),
    entries: 100000,                                  // bar "98895 / 100000 SOLD"
    grand_prize: "£100 of Tickets End Prize + Instant Wins",
    category: "cash-prizes",
    status: "ended",                                  // is_purchasable=false / "Out of stock" / autodraw now past → finished
  },
  {
    label: "Astra Militarum: Bundle #6 (You Could Win)",
    match: (d) => /youcouldwin\.co\.uk/.test(d.entry_url) && /astra-militarum-bundle-6/.test(d.entry_url),
    entries: 99,                                       // site "99 Tickets" (2 sold, 97 remaining)
    grand_prize: "Astra Militarum Warhammer 40,000 Battleforce Bundle",
    category: "collectibles",                          // Woo product category is literally "Warhammer"
  },
];

const drafts = await (await fetch(`${URL}/rest/v1/draws?status=eq.draft&select=id,title,grand_prize,total_entries,total_prize_value,ticket_price,entry_url,category_id,categories(slug),operators(slug)`, { headers: H })).json();
if (!Array.isArray(drafts)) { console.error("unexpected response:", JSON.stringify(drafts).slice(0, 200)); process.exit(1); }
console.log(`${DRY ? "DRY RUN" : "LIVE"} — ${drafts.length} draft draws in queue\n`);

let applied = 0, notFound = 0;
for (const t of TARGETS) {
  const d = drafts.find(t.match);
  if (!d) { notFound++; console.log(`  ⚠️  NOT FOUND in draft queue: ${t.label} (already published/ended, or different slug)`); continue; }

  const patch = {};
  const notes = [];
  if (t.entries != null && t.entries !== d.total_entries) {
    patch.total_entries = t.entries;
    // keep the scraper's convention: total_prize_value = ticket_price × entries
    const tpv = round2((Number(d.ticket_price) || 0) * t.entries);
    patch.total_prize_value = tpv;
    notes.push(`entries ${d.total_entries} → ${t.entries} (pool £${d.total_prize_value} → £${tpv})`);
  }
  if (t.grand_prize && t.grand_prize !== d.grand_prize) {
    patch.grand_prize = t.grand_prize;
    notes.push(`prize "${(d.grand_prize || "").slice(0, 30)}" → "${t.grand_prize}"`);
  }
  if (t.category && t.category !== d.categories?.slug) {
    if (!catId[t.category]) { console.log(`  ! no category id for ${t.category}`); }
    else { patch.category_id = catId[t.category]; notes.push(`category ${d.categories?.slug || "?"} → ${t.category}`); }
  }
  if (t.status) { patch.status = t.status; notes.push(`status draft → ${t.status}`); }

  if (!Object.keys(patch).length) { console.log(`  ✓ already correct: ${t.label}`); continue; }
  console.log(`  ${DRY ? "would fix" : "✅ fixed"} [${t.label}]\n      ${notes.join("\n      ")}`);
  if (!DRY) {
    const r = await fetch(`${URL}/rest/v1/draws?id=eq.${d.id}`, { method: "PATCH", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    if (!r.ok) console.log(`      ! PATCH ${r.status} ${(await r.text()).slice(0, 80)}`);
    else applied++;
  }
}
console.log(`\n==== ${DRY ? "preview only — re-run with DRY_RUN=false to apply" : `applied ${applied} patches`}${notFound ? ` · ${notFound} not found` : ""} ====`);
