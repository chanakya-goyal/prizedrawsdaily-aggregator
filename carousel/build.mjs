// BUILD step: render the full carousel from today's selection + prize photos.
// Photo source per draw (priority): (1) a photo YOU dropped in ~/Desktop/pdd-today/
// (named 1–5 or by slug), (2) the auto-fetched photo from the draw's page
// (.fetched/{slug}/pick.txt — set by fetchimg.mjs, QA'd by Claude), (3) typographic card.
// Run: bun run carousel/build.mjs   (after plan.mjs + fetchimg.mjs)
import { renderSlides } from "./render.mjs";
import { buildCaption } from "./caption.mjs";
import { buildBriefing } from "./brief.mjs";
import { recentPosts } from "./state.mjs";
import { cleanTitle, closesLabel, cashAlt, priceLabel } from "./format.mjs";
import * as oddsCopy from "./odds-copy.mjs";
import { sceneFor } from "./scene.mjs";
import { readdir, mkdir } from "node:fs/promises";
import { workDir, catCfg, GLOBAL } from "./config.mjs";
import { valueLine, altTexts } from "./honesty.mjs";
import { minDimOk } from "./imgcheck.mjs";
import { chromium } from "playwright";
import { openEngine, normalise } from "./normalise.mjs";
import * as compliance from "./compliance.mjs";

const DIR = workDir();
const sel = JSON.parse(await Bun.file(`${DIR}/selection.json`).text());
const files = await readdir(DIR);

const IMG_EXT = /\.(jpe?g|png|webp)$/i;
// normalise a filename → its base: trim, drop the real image extension AND any redundant
// image extension chain ("yamaha.jpg.webp" → "yamaha", "vw.jpg.jpg" → "vw"; macOS hides
// the real ext so people append ".jpg" from the shot list). Tolerant by design.
const baseOf = (f) => f.trim().replace(IMG_EXT, "").replace(IMG_EXT, "").trim().toLowerCase();
// match a clean upload by slug OR by its 1-based rank in the shot list (e.g. "1.jpg")
const findClean = (slug, rank) => {
  const f = files.find((f) => {
    if (f.startsWith("REF-") || !IMG_EXT.test(f.trim())) return false;
    const b = baseOf(f);
    return b === slug.toLowerCase() || b === String(rank);
  });
  return f ? `${DIR}/${f}` : null;
};
async function toDataUrl(path) {
  const buf = Buffer.from(await Bun.file(path).arrayBuffer());
  const ext = path.split(".").pop().toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// CARD style: "photo" (B, default) = original photo full-frame in the card;
// "cutout" (A) = background-removed product on the branded card.
const CARD = (process.env.CARD || "photo").toLowerCase();

// auto-fetched photo for a draw (.fetched/{slug}/pick.txt → chosen candidate file)
const FETCHED = `${DIR}/.fetched`;
async function fetchedPath(slug) {
  const pick = Bun.file(`${FETCHED}/${slug}/pick.txt`);
  if (!(await pick.exists())) return null;
  const name = (await pick.text()).trim();
  const p = `${FETCHED}/${slug}/${name}`;
  return name && (await Bun.file(p).exists()) ? p : null;
}

// resolve each draw's hero source: your dropped photo > auto-fetched pick > none
const srcPath = {}; const srcKind = {};
for (let i = 0; i < sel.draws.length; i++) {
  const d = sel.draws[i];
  const mine = findClean(d.slug, i + 1);
  if (mine) { srcPath[d.slug] = mine; srcKind[d.slug] = "your photo"; continue; }
  const auto = await fetchedPath(d.slug);
  if (auto) {
    if (await minDimOk(auto, 500)) { srcPath[d.slug] = auto; srcKind[d.slug] = "auto-fetched"; }
    else console.log(`  ⚠ ${d.slug}: auto-fetched pick is under 500px — rejected (typographic fallback). Repick in .fetched/${d.slug}/pick.txt`);
  }
}
const haveSlugs = sel.draws.filter((d) => srcPath[d.slug]).map((d) => d.slug);
console.log(`Card style: ${CARD}  |  Photos: ${haveSlugs.length}/${sel.draws.length}`);
sel.draws.forEach((d, i) => console.log(`  ${i + 1}. ${d.slug.slice(0, 44).padEnd(46)} ${srcKind[d.slug] || "— typographic card"}`));

const photoData = {};
for (const s of haveSlugs) photoData[s] = await toDataUrl(srcPath[s]);

// ---- asset normalisation and the collage gate (spec §9, §5.6) --------------------------
// Every photograph that reaches a slide goes through one normaliser first: one master size, a
// trimmed border, and a conservative tone pass. The border trim is the part that earns its keep
// beyond looks — Instagram's own ranking note makes content "less visible" when it carries
// borders, and a good third of operator artwork ships inside a coloured frame.
//
// The transform is honestly modest on this inventory, because most of what operators publish is
// MARKETING ARTWORK rather than product photography. So the valuable output is not the pixels,
// it is the CLASSIFICATION: a draw whose image reads as a poster is swapped for a backup rather
// than shipped, which is the image-quality gate §5.6 asks for. The deck loses a draw it could
// not show well and gains one it can.
// ONE launch for the whole build: the normaliser and the renderer share it.
const browser = await chromium.launch();
const engine = await openEngine(browser);
const sheet = [];
const posterRisk = {};
try {
  for (const d of [...sel.draws, ...(sel.backups || [])]) {
    const src = photoData[d.slug] || d.image_url;
    if (!src) continue;
    const buf = src.startsWith("data:")
      ? Buffer.from(src.split(",")[1], "base64")
      : await (async () => { const r = await fetch(src); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; })();
    if (!buf) { sheet.push({ slug: d.slug, ok: false, reason: "fetch-failed" }); continue; }
    let n;
    try { n = await normalise(engine, buf); }
    catch (e) { sheet.push({ slug: d.slug, ok: false, reason: "normalise-threw", detail: String(e.message).slice(0, 90) }); continue; }
    if (!n.ok) { sheet.push({ slug: d.slug, ok: false, reason: n.reason, detail: n.detail }); continue; }
    photoData[d.slug] = `data:image/jpeg;base64,${n.buffer.toString("base64")}`;
    posterRisk[d.slug] = n.poster;
    sheet.push({
      slug: d.slug, ok: true, ground: n.ground, poster: n.poster,
      source: srcKind[d.slug] || "stored image_url",
      padded: n.m.padded, edgeGuard: n.guard.pass, tone: n.plan.notes,
      was: `${n.m.width}x${n.m.height}`,
    });
  }
} finally { await engine.close(); }

// The swap. A backup only replaces a draw if the backup's own image is BETTER — otherwise the
// deck would trade a known-poor image for an unknown one, and a draw the selector already
// ranked lower.
const RANK = { low: 0, medium: 1, high: 2 };
// `!onDeckAlready` is load-bearing and was missing. build.mjs REWRITES selection.json with the
// swapped deck (so publish.mjs records the draws we kept, not the ones we rejected) but left
// sel.backups untouched — so on a re-run the promoted backup is in BOTH lists and gets swapped in
// a second time. The symptom was the same prize on two slides of one deck.
const onDeckAlready = new Set(sel.draws.map((d) => d.slug));
const spare = (sel.backups || []).filter((b) =>
  !onDeckAlready.has(b.slug) && photoData[b.slug] && RANK[posterRisk[b.slug] ?? "high"] === 0);
for (let i = 0; i < sel.draws.length && spare.length; i++) {
  const d = sel.draws[i];
  if (RANK[posterRisk[d.slug] ?? "low"] < 2) continue;      // only a HIGH risk is worth a swap
  const b = spare.shift();
  console.log(`  ⇄ ${d.slug.slice(0, 40)} reads as a collage — swapped for ${b.slug.slice(0, 40)}`);
  sel.draws[i] = b;
  // A consumed backup must leave the backup list. This was dormant until class B started
  // promoting from the same list: the swap took the ASDA gift card into the deck, sel.backups
  // still offered it, and class B promoted it a SECOND time — the same prize twice on one deck,
  // which is worse than a short deck. A backup is consumed once, by whoever gets there first.
  sel.backups = (sel.backups || []).filter((x) => x.slug !== b.slug);
}
const collages = sel.draws.filter((d) => posterRisk[d.slug] === "high");
if (collages.length) console.log(`  ⚠ ${collages.length} slide(s) still carry poster-like artwork (no clean backup left): ${collages.map((d) => d.slug.slice(0, 30)).join(", ")}`);

// The swap happens here but publish.mjs re-reads selection.json, and it is publish.mjs that
// records draw_slugs into carousel_posts. Without writing the decision back, the state row would
// name the draws we REJECTED and every later report would be reading the wrong deck. Write it.
//
// ⚠ AND WRITE IT AGAIN AFTER THE CLASS-B PASS. This write is not the last word on the deck any
// more: class B runs later and can drop draws and promote backups, so on its own this recorded
// draw_slugs=8 for a deck that rendered 6 — naming two draws that never appeared. That is the
// same defect this comment already warns about, reintroduced one stage further down.
await Bun.write(`${DIR}/selection.json`, JSON.stringify(sel, null, 2));

// (mode A only) free bg-removal in an ISOLATED subprocess — the @imgly WASM model
// otherwise poisons this process so the render browser's setContent hangs.
const cutBySlug = {};
if (CARD === "cutout" && haveSlugs.length) {
  const cutDir = `${DIR}/.cuts`;
  await mkdir(cutDir, { recursive: true });
  const isFresh = async (s) => {
    if (process.env.FORCE_CUT) return false;
    const cut = Bun.file(`${cutDir}/${s}.png`);
    if (!(await cut.exists())) return false;
    return cut.lastModified >= Bun.file(srcPath[s]).lastModified;
  };
  const todo = [];
  for (const s of haveSlugs) (await isFresh(s)) ? null : todo.push(s);
  if (todo.length) {
    const manifestPath = `${cutDir}/manifest.json`;
    await Bun.write(manifestPath, JSON.stringify({
      outDir: cutDir,
      items: await Promise.all(todo.map(async (s) => ({ slug: s, src: photoData[s] }))),
    }));
    console.log(`Removing backgrounds (isolated subprocess) for ${todo.length} photo(s)…`);
    const proc = Bun.spawn(["bun", new URL("./freehero.mjs", import.meta.url).pathname, manifestPath], {
      cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit",
    });
    await proc.exited;
  } else { console.log("All cutouts cached (fresh) — skipping bg-removal."); }
  for (const s of haveSlugs) {
    if (await Bun.file(`${cutDir}/${s}.png`).exists()) cutBySlug[s] = await toDataUrl(`${cutDir}/${s}.png`);
  }
  console.log(`Cutouts ready: ${Object.keys(cutBySlug).length}/${haveSlugs.length}`);
}

// The class-B ledger, and the two counts the record needs. They are captured BEFORE any drop,
// because "8 planned, 7 rendered, 1 backup used" is the whole point of the record — reading them
// afterwards would report a full deck every time.
const drawsPlanned = sel.draws.length;
const backupsBefore = (sel.backups || []).length;
const ledgerB = compliance.newLedger({ drawsPlanned });

// ---- class B: drop the draw, promote a backup, shrink once (§10.8) -------------------
// WHY THIS IS ONE PASS AND NOT FOUR GATES
// Four mechanisms swap draws out of one deck — provenance staleness, the data-field conditions,
// title residue and image class — and a priority order between them is the wrong fix, because
// whichever runs first wins and the rest escalate. So every draw is evaluated against every
// condition in ONE pass, and promotion happens once against the resulting set: a draw failing
// three conditions consumes one backup, not three.
//
// Detection without this was a LOG, not a gate. It matters on the first real run: a live
// car-draws deck carried "YOUR CHOICE: WIN A TESLA MODEL 3…", which is an operator's own title
// putting the second person next to an odds word — class B by §10.6's carve-out, and it would
// otherwise have rendered at hero size on a published slide.
const DRAWS_MIN = 4;                       // §5.11's floor; config.test asserts drawsPerDeck >= 4
const STALE_MS = 48 * 3600e3;              // §10.4's window, the same one select.mjs queries on
const T4_GLYPHS = 9;                       // §3.5's figure budget — a 10-glyph cap has no slot

// Conditions are returned in §10.8's fixed order (provenance → data fields → title residue →
// image class) so the record is stable and diffable rather than reordering run to run.
function classBFailures(d) {
  const out = [];
  const checkedAt = d.figures_checked_at ? +new Date(d.figures_checked_at) : NaN;
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > STALE_MS) out.push("provenance-stale");
  if (!d.entry_url) out.push("entry_url-null");
  if (!Number.isFinite(+new Date(d.draw_date))) out.push("draw_date-unparseable");
  if (!(Number(d.ticket_price) > 0)) out.push("ticket_price-missing");
  if (!cleanTitle(d.grand_prize || d.title || "")) out.push("prize-name-empty");
  const cap = Number(d.total_entries);
  if (Number.isFinite(cap) && String(Math.round(cap)).length > T4_GLYPHS) out.push("cap-over-T4");
  // The operator's title, on the title surface: second person is exempt (they really do write
  // "Build Your Own PC") but "your" beside an odds word is not.
  if (compliance.checkUnit(d.grand_prize || d.title || "", { surface: "title" }).length) out.push("title-second-person-odds");
  if (posterRisk[d.slug] === "high") out.push("image-collage");
  return out;
}

{
  const failing = new Map();
  for (const d of sel.draws) { const f = classBFailures(d); if (f.length) failing.set(d.slug, f); }
  if (failing.size) {
    // A backup is only a candidate if it is clean AND not already on the deck. The second half is
    // not paranoia: the collage swap above draws from the same list, so without it a promoted
    // backup can duplicate a prize already rendered.
    const onDeck = new Set(sel.draws.map((d) => d.slug));
    const pool = [...(sel.backups || [])].filter((b) => !onDeck.has(b.slug) && !classBFailures(b).length);
    const kept = [];
    const used = new Set();
    for (const d of sel.draws) {
      const f = failing.get(d.slug);
      if (!f) { kept.push(d); used.add(d.slug); continue; }
      let sub = null;
      while (pool.length && !sub) { const c = pool.shift(); if (!used.has(c.slug)) sub = c; }
      compliance.record(ledgerB, "model", `draw:${d.slug}`, "draw", "class-B",
        [{ predicate: "B.drawDropped", class: compliance.CLASS.B, detail: `${d.slug} — ${f.join(", ")}${sub ? ` → promoted ${sub.slug}` : " → deck shrinks (no clean backup)"}` }]);
      console.log(`  \u26a0 class B: ${d.slug} dropped (${f.join(", ")})${sub ? ` \u2192 promoted ${sub.slug}` : " \u2192 deck shrinks"}`);
      if (sub) { kept.push(sub); used.add(sub.slug); }
    }
    // A duplicate prize on a published deck is the one outcome worse than a short one, so it is
    // asserted rather than trusted to the logic above.
    const slugs = kept.map((d) => d.slug);
    if (new Set(slugs).size !== slugs.length) {
      console.error(`\u2717 COMPLIANCE class A \u2014 duplicate draw on the deck: ${slugs.join(", ")}`);
      await browser.close();
      process.exit(1);
    }
    // Class-B exhaustion does NOT escalate straight to class A. A seven-draw deck of clean draws
    // is strictly better than no post; class A fires only below §5.11's floor.
    if (kept.length < DRAWS_MIN) {
      console.error(`\u2717 COMPLIANCE class A \u2014 deck-underfilled: ${kept.length} of ${DRAWS_MIN} after class-B drops`);
      await browser.close();
      process.exit(1);
    }
    sel.draws = kept;
    sel.backups = pool;
    // The deck is only settled NOW. publish.mjs reads this file for draw_slugs, so a stale copy
    // would put the dropped draws into carousel_posts and every later report would read the
    // wrong deck — with draws_rendered disagreeing with draw_slugs.length in the same row.
    await Bun.write(`${DIR}/selection.json`, JSON.stringify(sel, null, 2));
  }
}

// ---- deck assembly -------------------------------------------------------------------
// Ten slides: cover, count, one per remaining draw, closing. Every count on the frame is
// derived from what ACTUALLY RENDERED, never from config.drawsPerDeck — on a degraded run a
// cover reading "of the eight" is a false checkable claim, which is the one kind of error the
// cover's proof line exists to rule out.
const heroOf = (slug) => CARD === "cutout" ? cutBySlug[slug] : photoData[slug];
const N = sel.draws.length;
const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" }).toUpperCase();
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "each operator's own site"; } };
const soonOf = (d) => d && (new Date(d) - Date.now()) < 48 * 3600e3;
const todayOf = (d) => d && fmtDay(d) === fmtDay(new Date().toISOString());
const capOf = (d) => Number(d.total_entries) || null;

// THE READ-AT STAMP IS NEVER APPROXIMATED. It renders from the oldest stored observation across
// the deck, or not at all — a false provenance claim is worse than no claim, which is why there
// is no "now()" fallback here.
const checked = sel.draws.map((d) => d.figures_checked_at).filter(Boolean).sort();
const stamp = checked.length
  ? oddsCopy.stampShort(new Date(checked[0]).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }))
  : null;
if (!stamp) console.log("  ⚠ no figures_checked_at on any draw — the read-at stamp will not render (Stage 0 not applied?)");

// Slide 2 carries the LOWEST ticket cap in the deck, not the soonest close. It is the one slide
// that carries the full dot grid, and the grid is only countable below the ceiling — so the
// draw with the shortest cap is the one where the device does its best work.
const capped = sel.draws.filter((d) => capOf(d));
if (!capped.length) throw new Error("no draw in the selection carries a ticket cap — the odds device cannot render, refusing to build");
const countDraw = capped.reduce((a, b) => (capOf(a) <= capOf(b) ? a : b));
const rest = sel.draws.filter((d) => d !== countDraw);

const prices = sel.draws.map((d) => Number(d.ticket_price)).filter((p) => isFinite(p) && p > 0);
const fromPrice = prices.length ? priceLabel(Math.min(...prices)) : null;
const lowestCap = Math.min(...capped.map(capOf));
const maxDate = Math.max(...sel.draws.map((d) => +new Date(d.draw_date)).filter(isFinite));
const closesWithinDays = Math.max(1, Math.ceil((maxDate - Date.now()) / 86400000));

const deckBand = oddsCopy.bandLines({ role: "cover", drawsRendered: N, fromPrice: fromPrice || "n/a" });
const drawBand = (d) => oddsCopy.bandLines({
  role: "draw",
  closesText: closesLabel(d.draw_date),
  price: priceLabel(d.ticket_price) || "n/a",
  host: hostOf(d.entry_url),
  freeEntryRoute: d.free_entry_route || "unknown",
});

const lockupOf = (d) => ({
  operator: d.operators?.name || null,
  // The Trust Score is PDD's own assessment, so the chip says "PDD" and renders as ink on paper
  // rather than in a verdict colour. One decimal: the stored spread is 3.0-4.8.
  rating: Number.isFinite(Number(d.operators?.rating)) ? Number(d.operators.rating).toFixed(1) : null,
});

const now = new Date();
const dateline = [
  now.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", year: "numeric" }).toUpperCase().replace(/,/g, ""),
  stamp,
].filter(Boolean).join(" \u00b7 ");

// The modal closing day across the deck, and how many draws actually close on it — the deadline
// arm's own evidence. Computed from draw_date in Europe/London, the same zone closesLabel() uses.
const dayTok = (iso) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short" }).toUpperCase();
const dayTally = sel.draws.reduce((m, d) => {
  const k = Number.isFinite(+new Date(d.draw_date)) ? dayTok(d.draw_date) : null;
  if (k) m.set(k, (m.get(k) || 0) + 1);
  return m;
}, new Map());
const [modalDay, modalCount] = [...dayTally.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];

const headlineFacts = {
  drawsRendered: N, fromPrice: fromPrice || "n/a",
  cashAlt: cashAlt(countDraw.grand_prize, countDraw.prize_description),
  price: priceLabel(countDraw.ticket_price),
  day: modalDay, closingCount: modalCount,
};
const renderedArm = oddsCopy.headlineArm(sel.archetype, headlineFacts);
if (!renderedArm.startsWith(sel.archetype.split(":")[0])) {
  // §10.8 counts the substitution rather than letting it be silent: a hand-read of the log must
  // show that a price-anchor day was REQUESTED as something else.
  console.log(`  \u26a0 archetype substituted: ${sel.archetype}\u2192${renderedArm}`);
}

const coverSlide = {
  type: "cover", stamp, dateline,
  headline: oddsCopy.headline(sel.archetype, headlineFacts),
  // Figures wrapped so the renderer can set them in the one place green is authorised.
  proof: oddsCopy.proofLine({ drawsRendered: N, closesWithinDays, lowestCap })
    .map((l) => l.replace(/([\d,]+)/g, "<b>$1</b>")),
  band: deckBand,
  board: [
    ...sel.draws.slice(0, 3).map((d) => ({
      prize: cleanTitle(d.grand_prize || d.title),
      closes: fmtDay(d.draw_date),
      soon: soonOf(d.draw_date),
    })),
    N >= 5 ? { more: `+${N - 3} more inside` } : null,
  ].filter(Boolean),
};

const countSlide = {
  type: "count", stamp, n: 2, total: N + 2,
  index: sel.draws.indexOf(countDraw) + 1, drawsRendered: N,
  title: cleanTitle(countDraw.grand_prize || countDraw.title),
  cap: capOf(countDraw), ...lockupOf(countDraw),
  soon: soonOf(countDraw.draw_date), band: drawBand(countDraw),
};

const drawSlides = rest.map((d, i) => ({
  type: "draw", stamp, n: i + 3, total: N + 2,
  title: cleanTitle(d.grand_prize || d.title),
  // Photo priority: a photograph you dropped in the work dir, then fetchimg's QA'd pick, then
  // the draw's own stored image_url. That last one is not a consolation prize — it is already
  // re-hosted on our storage and it is what the website shows for the same draw, so the deck
  // and the site agree. Without it a build that skipped fetchimg rendered an empty white well,
  // which looks like a broken slide and passes every check that only counts elements.
  cap: capOf(d), photo: heroOf(d.slug) || d.image_url || null,
  ...lockupOf(d),
  soon: soonOf(d.draw_date),
  closesChip: soonOf(d.draw_date) ? closesLabel(d.draw_date) : null,
  // The press stamp only renders on a claim that is true today.
  stampWord: todayOf(d.draw_date) ? "CLOSES TODAY" : null,
  band: drawBand(d),
  slug: d.slug,
}));

const slides = [coverSlide, countSlide, ...drawSlides, { type: "closing", stamp, band: deckBand }];

// ONE facts table, derived from the selection rather than from the render slides. The slides
// carry what the FRAME needs and nothing else; the caption, the briefing and the alt text need
// the draw's own data. Deriving the second from the first is how the caption silently lost
// every ticket price and the briefing filled its table with "?" — both read as working output,
// which is the worst kind of broken.
//
// It also covers all N draws in selection order. The render slides cannot: slide 2 pulls the
// lowest-cap draw out of sequence, so a list built from drawSlides is one draw short.
const facts = sel.draws.map((d, i) => ({
  n: i + 1,
  slug: d.slug,
  title: cleanTitle(d.grand_prize || d.title),
  price: priceLabel(d.ticket_price),
  cap: capOf(d),
  // Composed by oddsCopy, never here. The briefing is what the caption author reads, so the
  // string it shows them has to be the permitted one — a second hand-rolled form in this file is
  // exactly how a banned phrasing reaches a caption (§10.6a L1).
  odds: capOf(d) ? oddsCopy.conditional(capOf(d)) : null,
  closes: closesLabel(d.draw_date),
  cashAlt: cashAlt(d.grand_prize, d.prize_description),
  operator: d.operators?.name || null,
}));
const missing = drawSlides.filter((s) => !s.photo);
if (missing.length) console.log(`  \u26a0 ${missing.length} draw slide(s) have no photograph: ${missing.map((s) => s.slug).join(", ")}`);

// The fallback caption is composed HERE, above the gate, rather than after the render. It is not
// a draft: CAPTION_FALLBACK.txt is what publish.mjs ships when the model supplies no CAPTION.txt,
// so it is a shipping surface and the gate has to see it. Composing it after the record was
// written would have left the one caption that publishes unattended as the one caption nothing
// checked.
const caption = buildCaption(sel.name, sel.slug, facts, sel.seoKeyword);

// ── the MODEL stage of the wording gate (§10.1, §10.6) ────────────────────────────────────────
// It runs HERE, before renderSlides, because §10.8 class A means "no PNG or MP4 written, nothing
// uploaded, no publish.json". A gate that ran after the render would leave a directory of assets
// that must be REMEMBERED as unpublishable, which is exactly the state the write-ahead row exists
// to avoid.
const backupsUsed = backupsBefore - (sel.backups || []).length;
const ledger = compliance.newLedger({ drawsPlanned, drawsRendered: N, backupsUsed });
// The class-B pass ran before this ledger could exist (it decides what N even is), so its
// findings are carried over rather than recorded twice.
ledger.violations.push(...ledgerB.violations);
for (const [k, v] of Object.entries(ledgerB.gate_violations)) ledger.gate_violations[k] = (ledger.gate_violations[k] || 0) + v;
const cFacts = compliance.factsTable({
  drawsRendered: N,
  caps: facts.map((f) => f.cap).filter((x) => x != null),
  prices: facts.map((f) => f.price).filter(Boolean),
  daysToClose: sel.draws.map((d) => Math.max(1, Math.ceil((+new Date(d.draw_date) - Date.now()) / 86400000))).filter(Number.isFinite),
});
const opNames = facts.map((f) => f.operator).filter(Boolean);
const check = (asset, role, field, text, surface = "asset") =>
  compliance.record(ledger, "model", asset, role, field,
    compliance.checkUnit(text, { facts: cFacts, surface, bannedPhrases: GLOBAL.bannedPhrases, operatorNames: opNames }));

// WHICH FIELDS ARE COPY, stated explicitly rather than inferred from "is it a string".
//
// The first version of this loop checked every string field on every slide, and the end-to-end run
// showed why that is wrong: it fed base64 data URIs and URL slugs through predicates written for
// prose, and a long enough base64 blob contains a bare `u` and a `$`-digit pair by chance alone.
// Seven of the nine hard failures on the first real run were image data. An explicit map is also
// auditable in a way "every string" is not — and any field in NEITHER list is COUNTED below, so a
// new copy field cannot silently escape the gate the way it could escape a hand-written list.
const OWN_VOICE = new Set([                 // PDD's own voice: the full predicate set applies
  "headline", "dateline", "stamp", "eyebrow", "figure", "conditional", "annotation",
  "kicker", "sub", "subline", "note", "counter", "proof", "band", "legend", "closes", "label",
  "closesChip",   // a rendered closing-date chip; it reached this list because the counter below
                  // named it on the first end-to-end run, which is what the counter is for
]);
const OPERATOR_TITLE = new Set(["title", "prize", "cashAlt"]);   // theirs, not ours — title rules only
const NOT_COPY = new Set([                  // never prose: no predicate can say anything useful
  "type", "slug", "photo", "image", "img", "src", "n", "index", "role", "scene", "operator",
  "rating", "host", "price", "entryUrl", "url", "board", "tok", "style",
]);
const unclassified = new Set();

for (const [i, s] of slides.entries()) {
  const role = s.type;
  const asset = `slide-${String(i + 1).padStart(2, "0")}`;
  for (const [field, val] of Object.entries(s)) {
    const strs = typeof val === "string" ? [[field, val]]
      : Array.isArray(val) ? val.flatMap((x, j) => (typeof x === "string" ? [[`${field}[${j}]`, x]] : []))
      : [];
    if (!strs.length) continue;
    if (NOT_COPY.has(field)) continue;
    // An operator's own prize title is judged on the title rules: they really do write
    // "Build Your Own PC", and "ULTIMATE PRIZE EVERY TIME" is a product name, not PDD claiming a
    // cadence. A title putting the second person next to an odds word drops that DRAW (class B).
    const surface = OPERATOR_TITLE.has(field) ? "title" : "asset";
    if (!OWN_VOICE.has(field) && !OPERATOR_TITLE.has(field)) { unclassified.add(field); continue; }
    for (const [f, v] of strs) check(asset, role, f, v, surface);
  }
}
// Visible, so the map cannot rot into silence as the slide models grow.
if (unclassified.size) compliance.count(ledger, "unclassified-field", [...unclassified].sort().join(", "));
// An operator's own prize title is judged on the title rules, not PDD's own-voice rules: they
// really do write "Build Your Own PC". A title putting the second person next to an odds word
// drops that draw (class B) rather than failing the run.
for (const f of facts) check(`draw:${f.slug}`, "title", "title", f.title || "", "title");

// The cover's unit for the two-figure test is headline + proof line, because the proof line is a
// mandatory block rendered directly beneath it. Checking the headline alone would hard-fail the
// question archetype on every legitimate run — roughly 91 days a year.
compliance.record(ledger, "model", "slide-01", "cover", "headline+proof",
  compliance.checkQuestionUnit([coverSlide.headline, ...oddsCopy.proofLine({ drawsRendered: N, closesWithinDays, lowestCap })].join(" "), cFacts));

// The caption and the alt text are the generated surfaces, judged on the caption rules: second
// person survives in prose but never within 60 characters of an odds token.
for (const [j, a] of altTexts(sel, facts).entries()) check("alt.json", "alt", `alt[${j}]`, a, "caption");
check("CAPTION.txt", "caption", "caption", caption, "caption");
for (const s of String(caption).split(/(?<=[.!?])\s+|\n+/)) {
  compliance.record(ledger, "model", "CAPTION.txt", "caption", "sentence", compliance.checkQuestionUnit(s, cFacts));
}
if (renderedArm !== `${sel.archetype}:long` && renderedArm !== "question:only") {
  compliance.count(ledger, "archetype-substituted", `${sel.archetype}\u2192${renderedArm}`);
}
if (N < sel.draws.length) compliance.count(ledger, "deck-shrunk", `${sel.draws.length}\u2192${N}`);

const worst = compliance.worstClass(ledger);
if (worst === compliance.CLASS.A || compliance.classCCeilingBreached(ledger)) {
  // Written even on failure — especially on failure. The record is the work item.
  await mkdir(`${DIR}/out`, { recursive: true });
  await compliance.writeCompliance(`${DIR}/out`, ledger);
  await browser.close();
  console.error("\u2717 COMPLIANCE class A \u2014 refusing to render. See out/COMPLIANCE.txt\n");
  console.error(compliance.complianceText(ledger));
  process.exit(1);
}
if (ledger.violations.length) {
  console.log(`  \u26a0 ${ledger.violations.length} non-blocking compliance finding(s) \u2014 see out/COMPLIANCE.txt`);
}

console.log(`Category: ${sel.slug}  |  scene: ${sceneFor(sel.slug).title}  |  ${slides.length} slides (${N} draws)`);
const pngs = await renderSlides(slides, sel.slug, { browser });
await browser.close();
const outDir = `${DIR}/out`;
await mkdir(outDir, { recursive: true });
const slideName = (i) => i === 0 ? "cover" : i === 1 ? "count" : i === slides.length - 1 ? "closing" : drawSlides[i - 2].slug.slice(0, 40);
for (let i = 0; i < pngs.length; i++) await Bun.write(`${outDir}/${String(i + 1).padStart(2, "0")}-${slideName(i)}.png`, pngs[i]);
await Bun.write(`${outDir}/alt.json`, JSON.stringify(altTexts(sel, facts), null, 2));
// One row per asset considered, so the accept/reject decisions are reviewable rather than
// buried in a log line. This is the operator-facing half of §9.
await Bun.write(`${outDir}/images.json`, JSON.stringify(sheet, null, 2));
// The facts the copy is built from, published so publish.mjs does not recompute prize titles
// with a SECOND cleaner. It did, and the two disagreed, which would have put different prize
// names on Instagram and Facebook for the same draw.
await Bun.write(`${outDir}/facts.json`, JSON.stringify(facts, null, 2));
// Written on PASS as well as fail, so a run with the gates disabled is distinguishable from a run
// that passed them. A gate whose only output is an exit code gets switched off the first time it
// is inconvenient, and this pipeline already has that switch in AUTO_PUBLISH.
ledger.stage = "model:passed";
await compliance.writeCompliance(outDir, ledger);
// The model facts publish.mjs cannot recompute without re-deriving the headline with a SECOND
// generator — which is the same mistake that once put different prize names on Instagram and
// Facebook for the same draw. `requested` vs `rendered` are both stored because §10.6a's
// fallbacks mean they legitimately differ, and a substituted post credited to the requested arm
// is a corrupted experiment.
await Bun.write(`${outDir}/model.json`, JSON.stringify({
  // The count BEFORE any class-B drop. Reading sel.draws here would report a full deck on a
  // degraded run, which is the series corruption draws_rendered exists to make visible.
  drawsPlanned,
  backupsUsed,
  drawsRendered: N,
  archetypeRequested: sel.archetype || null,
  archetypeRendered: renderedArm,
  coverHeadline: coverSlide.headline,
  gateViolations: ledger.gate_violations,
}, null, 2));

let recentOpeners = [];
try { recentOpeners = (await recentPosts(14)).map((r) => (r.caption || "").split("\n")[0]).filter(Boolean); } catch {}
await Bun.write(`${outDir}/CAPTION_FALLBACK.txt`, caption);
await Bun.write(`${outDir}/BRIEFING.md`, buildBriefing({ sel, drawSlides: facts, recentOpeners }));
console.log("\n--- FALLBACK CAPTION (written to CAPTION_FALLBACK.txt; Claude: write CAPTION.txt + FB_CAPTION.txt from BRIEFING.md) ---\n" + caption);
console.log(`\nWrote ${pngs.length} slides → ${outDir}`);
