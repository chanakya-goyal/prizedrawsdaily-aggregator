// carousel/native-build.mjs — the native deck's half of build.mjs (config global.template = "native").
//
// build.mjs keeps everything up to and including the class-B pass — photo choice, normalisation,
// the collage swap, the provenance and data-field drops — because none of that is about how a
// slide LOOKS. From the settled deck onward this module takes over: words (native-copy.mjs), the
// wording gate on every one of them, the render (native.mjs), and the same out/ files publish.mjs
// already reads, so the publish path does not change.
import { readdir, rm, mkdir } from "node:fs/promises";
import { nativeDeck, deckStrings, nativeCaption, PROMPT } from "./native-copy.mjs";
import { renderNative } from "./native.mjs";
import { cleanTitle, closesLabel, cashAlt, priceLabel } from "./format.mjs";
import * as oddsCopy from "./odds-copy.mjs";
import * as compliance from "./compliance.mjs";
import { GLOBAL } from "./config.mjs";
import { altTexts } from "./honesty.mjs";
import { buildBriefing } from "./brief.mjs";
import { recentPosts } from "./state.mjs";

export async function buildNative({ sel, DIR, browser, photoOf, sheet, drawsPlanned, backupsBefore, ledgerB, posterRisk = {} }) {
  const outDir = `${DIR}/out`;
  await mkdir(outDir, { recursive: true });
  const N = sel.draws.length;
  const capOf = (d) => Number(d.total_entries) || null;

  // The facts table every caption surface reads (same shape the old deck wrote, so the briefing,
  // the alt text and publish.mjs's FB fallback keep working unchanged).
  const facts = sel.draws.map((d, i) => ({
    n: i + 1, slug: d.slug,
    title: cleanTitle(d.grand_prize || d.title),
    price: priceLabel(d.ticket_price),
    cap: capOf(d),
    odds: capOf(d) ? oddsCopy.conditional(capOf(d)) : null,
    closes: closesLabel(d.draw_date),
    cashAlt: cashAlt(d.grand_prize, d.title),
    operator: d.operators?.name?.trim() || null,
  }));
  const cFacts = compliance.factsTable({
    drawsRendered: N,
    caps: facts.map((f) => f.cap).filter((x) => x != null),
    prices: facts.map((f) => f.price).filter(Boolean),
    daysToClose: sel.draws.map((d) => Math.max(1, Math.ceil((+new Date(d.draw_date) - Date.now()) / 86400000))).filter(Number.isFinite),
  });
  const opNames = facts.map((f) => f.operator).filter(Boolean);
  const gateHits = (text, surface = "asset") => [
    ...compliance.checkUnit(text, { facts: cFacts, surface, bannedPhrases: GLOBAL.bannedPhrases, operatorNames: opNames }),
    ...(surface === "title" ? [] : compliance.checkQuestionUnit(text, cFacts)),
  ];

  // Claude may write fresher FLAVOUR lines into COPY.json; anything the gate refuses falls back.
  const copy = await Bun.file(`${DIR}/COPY.json`).json().catch(() => null);
  const deck = nativeDeck({
    sel, draws: sel.draws, photoOf, copy, log: console.log,
    riskOf: (d) => ({ low: 0, medium: 1, high: 2 })[posterRisk[d.slug]] ?? 1,
    gate: (line) => gateHits(line).map((h) => h.predicate),
  });
  const caption = nativeCaption({ sel, deck, draws: sel.draws });

  // ── the wording gate: every rendered string, the caption, the alt text ─────────────────────
  const backupsUsed = backupsBefore - (sel.backups || []).length;
  const ledger = compliance.newLedger({ drawsPlanned, drawsRendered: N, backupsUsed });
  ledger.violations.push(...ledgerB.violations);
  for (const [k, v] of Object.entries(ledgerB.gate_violations)) ledger.gate_violations[k] = (ledger.gate_violations[k] || 0) + v;
  const roleOf = (i) => (i === 0 ? "cover" : i === N + 1 ? "closing" : "draw");
  for (const [i, field, text, surface] of deckStrings(deck)) {
    compliance.record(ledger, "model", `slide-${String(i + 1).padStart(2, "0")}`, roleOf(i), field, gateHits(text, surface));
  }
  for (const [j, a] of altTexts(sel, facts).entries()) compliance.record(ledger, "model", "alt.json", "alt", `alt[${j}]`, gateHits(a, "caption"));
  compliance.record(ledger, "model", "CAPTION.txt", "caption", "caption",
    compliance.checkUnit(caption, { facts: cFacts, surface: "caption", bannedPhrases: GLOBAL.bannedPhrases, operatorNames: opNames }));
  for (const s of caption.split(/(?<=[.!?])\s+|\n+/)) compliance.record(ledger, "model", "CAPTION.txt", "caption", "sentence", compliance.checkQuestionUnit(s, cFacts));
  if (N < drawsPlanned) compliance.count(ledger, "deck-shrunk", `${drawsPlanned}→${N}`);

  if (compliance.worstClass(ledger) === compliance.CLASS.A || compliance.classCCeilingBreached(ledger)) {
    await compliance.writeCompliance(outDir, ledger);
    console.error("✗ COMPLIANCE class A — refusing to render. See out/COMPLIANCE.txt\n");
    console.error(compliance.complianceText(ledger));
    return { ok: false };
  }
  if (ledger.violations.length) console.log(`  ⚠ ${ledger.violations.length} non-blocking compliance finding(s) — see out/COMPLIANCE.txt`);

  // ── render ─────────────────────────────────────────────────────────────────────────────────
  console.log(`Template: native  |  ${N + 2} slides (${N} draws)`);
  let pngs;
  try { pngs = await renderNative(deck, { browser }); }
  catch (e) { console.error(`✗ ${e.message}`); return { ok: false }; }

  // publish.mjs globs /^\d\d-.*\.png$/ — a slide left over from an earlier build of the same day
  // would ship. Clear the old frames before writing the new ones.
  for (const f of await readdir(outDir)) if (/^\d\d-.*\.png$/.test(f)) await rm(`${outDir}/${f}`);
  const names = ["cover", ...deck.prizes.map((p) => p.slug.slice(0, 40)), "closing"];
  for (const [i, png] of pngs.entries()) await Bun.write(`${outDir}/${String(i + 1).padStart(2, "0")}-${names[i]}.png`, png);

  await Bun.write(`${outDir}/alt.json`, JSON.stringify(altTexts(sel, facts), null, 2));
  await Bun.write(`${outDir}/images.json`, JSON.stringify(sheet, null, 2));
  await Bun.write(`${outDir}/facts.json`, JSON.stringify(facts, null, 2));
  ledger.stage = "model:passed";
  await compliance.writeCompliance(outDir, ledger);
  await Bun.write(`${outDir}/model.json`, JSON.stringify({
    template: "native", drawsPlanned, backupsUsed, drawsRendered: N,
    archetypeRequested: sel.archetype || null, archetypeRendered: "native",
    coverHeadline: deck.cover.copy.line.text, gateViolations: ledger.gate_violations,
  }, null, 2));
  await Bun.write(`${DIR}/selection.json`, JSON.stringify(sel, null, 2));

  let recentOpeners = [];
  try { recentOpeners = (await recentPosts(14)).map((r) => (r.caption || "").split("\n")[0]).filter(Boolean); } catch {}
  await Bun.write(`${outDir}/CAPTION_FALLBACK.txt`, caption);
  await Bun.write(`${outDir}/BRIEFING.md`, buildBriefing({ sel, drawSlides: facts, recentOpeners }) + nativeBriefing({ sel, deck }));
  console.log("\n--- CAPTION (CAPTION_FALLBACK.txt; Claude may write CAPTION.txt + COPY.json, see BRIEFING.md) ---\n" + caption);
  console.log(`\nWrote ${pngs.length} slides → ${outDir}`);
  return { ok: true, slides: pngs.length };
}

// Appended to BRIEFING.md: the native deck's voice, and the one file Claude may write to change
// on-slide words. The template lines are already gate-clean, so COPY.json is optional.
function nativeBriefing({ sel, deck }) {
  const flav = deck.prizes.map((p) => `  "${p.slug}": "${p.copy.flavour.text}"`).join(",\n");
  return `

---

## NATIVE DECK (global.template = "native") — what changed
The slides look like a person posted them: prize photo, white Stories bubbles, a "Strong" price
sticker, a countdown card and a "via {operator}" pill. The CAPTION should match: short, lowercase,
one emoji at most per line. Shape that works (CAPTION_FALLBACK.txt already follows it):
  line 1: the cover line + one emoji
  one line per prize: prize · price · ends {day} · operator   (the operator on EVERY line)
  "${PROMPT}"
  the independence line, the terms line, link in bio, the 5 hashtags.
Never a "?" unless two verified figures from different fact keys sit in the same sentence.

## Optional: fresher on-slide lines → ${"`"}COPY.json${"`"} in the work dir, then re-run build.mjs
Only the FLAVOUR slots are yours; the price, cash, closing day and operator always come from the
data. Each line ≤ 44 chars, one line, no "@", no "you/your", no figure except that slide's own price
(the cover may use the draw count and the from-price). A refused line is logged and the template
line kept — an override can never fail the run.
{
  "date": "${sel.date}",
  "cover": "${deck.cover.copy.line.text}",
  "flavour": {
${flav}
  },
  "prompt": "${PROMPT}"
}
`;
}
