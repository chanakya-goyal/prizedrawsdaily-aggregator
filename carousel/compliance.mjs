// carousel/compliance.mjs — the G5 wording gate (spec §10.6), its failure classes (§10.8) and
// the COMPLIANCE record.
//
// WHY PREDICATES AND NOT A PHRASE LIST
// `global.bannedPhrases` cannot govern a generator that is instructed to vary its wording every
// day. PDD's own archived caption shipped "better odds than most raffles you'll scroll past all
// week" — two violations, zero deny-list hits. So the deny-list is demoted to a backstop and the
// real controls are word-class and mechanic predicates, which a novel phrasing still trips.
//
// WHAT EACH CLASS DOES (§10.8)
//   A — HARD FAIL.      Non-zero exit. No PNG, no MP4, nothing uploaded, no publish.json.
//   B — DRAW DROP.      The draw is removed and a backup promoted; the deck shrinks one at a time.
//   C — SLOT COLLAPSE.  One figure does not render and its slot closes up. Named and counted.
//   D — DOWNGRADE.      Dormant: no clock ships in v1, so no run can produce one.
//
// PROVENANCE: the word classes below are design judgement derived from CAP 8.20/8.21 (must not
// exaggerate the chance of winning), 8.22 and the DMCC Act 2024 (false urgency), and 3.7
// (evidence held before publication). This is not a legal review and must not be presented as one.

export const CLASS = { A: "A", B: "B", C: "C", D: "D" };

// ── the run's verified-facts table ────────────────────────────────────────────────────────────
// Frozen at the MODEL stage. Every figure a rendered unit is allowed to claim comes from here,
// and predicate 3 counts DISTINCT KEYS, so two ticket caps never satisfy it on their own.
export function factsTable({ drawsRendered, caps = [], prices = [], daysToClose = [] }) {
  return Object.freeze({
    drawsRendered: Number(drawsRendered) || 0,
    caps: caps.map(Number).filter(Number.isFinite),
    prices: prices.map(String).filter(Boolean),
    daysToClose: daysToClose.map(Number).filter(Number.isFinite),
  });
}

const nf = new Intl.NumberFormat("en-GB");
// A figure is a MAXIMAL match, so "4,500,000" is one figure and not three.
const FIGURE_RE = /[£$]?\d[\d,]*(?:\.\d+)?[pk%]?/gi;
const norm = (s) => String(s).replace(/,/g, "").toLowerCase();

// The forms a single fact may legitimately render as. A cap prints bare on the cover (699) and
// grouped in the device (9,999), so both are its string form; a price prints exactly as
// priceLabel() rendered it.
function formsFor(facts) {
  const m = new Map();
  const add = (key, v) => { const k = norm(v); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(key); };
  add("drawsRendered", facts.drawsRendered);
  for (const c of facts.caps) { add("caps", c); add("caps", nf.format(c)); }
  for (const p of facts.prices) add("prices", p);
  for (const d of facts.daysToClose) add("daysToClose", d);
  return m;
}

// Every figure in the text, paired with the fact keys it could be. A match that resolves to no
// fact is dropped: an unevidenced number is not a figure for this purpose, it is noise.
export function figureMatches(text, facts) {
  const forms = formsFor(facts);
  const out = [];
  for (const raw of String(text).match(FIGURE_RE) || []) {
    const keys = forms.get(norm(raw));
    if (keys?.size) out.push({ raw, keys: [...keys] });
  }
  return out;
}

// "Two matches drawn from two differently-named facts" is a bipartite matching, not a set union:
// one `8` cannot be both drawsRendered and daysToClose at the same time. Sizes here are single
// digits, so a plain augmenting-path search is the whole algorithm.
export function distinctKeyCount(text, facts) {
  const matches = figureMatches(text, facts);
  const takenBy = new Map();                       // key -> match index
  const tryAssign = (i, seen) => {
    for (const k of matches[i].keys) {
      if (seen.has(k)) continue;
      seen.add(k);
      if (!takenBy.has(k) || tryAssign(takenBy.get(k), seen)) { takenBy.set(k, i); return true; }
    }
    return false;
  };
  for (let i = 0; i < matches.length; i++) tryAssign(i, new Set());
  return takenBy.size;
}

// A predicate must see the RENDERED TEXT, never the markup. This is not tidiness: build.mjs wraps
// every figure in the proof line in <b> tags so the renderer can set it in the one place emphasis
// is authorised, which turns "Lowest ticket cap of the 8: 920." into
// "Lowest ticket cap of the <b>8</b>: <b>920</b>." — and hides the `of the 8` SCOPE TOKEN that is
// the only thing making that comparative lawful. The gate then fails the one permitted comparative
// in the whole system, on every run. Found by running the gate end to end rather than in a test.
export const plainText = (s) => String(s ?? "")
  .replace(/<[^>]*>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\s+/g, " ").trim();

const sentences = (s) => String(s).split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
const hit = (name, cls, detail) => ({ predicate: name, class: cls, detail });

// ── word-class predicates ─────────────────────────────────────────────────────────────────────

// PDD's own voice never needs the second person. "YOUR ODDS AT THE CAP" is false for every viewer
// not holding exactly one ticket and undefined for a viewer holding none; under CAP 8.21 it also
// implies the reader is already entered.
const SECOND_PERSON = /\b(you|your|yours|you're|youre|u|yer)\b/i;
export const secondPerson = (s) => SECOND_PERSON.test(s);

// An operator's own prize title is exempt — they really do write "Build Your Own PC" — but a title
// that puts the second person next to an odds word drops the draw rather than the phrase.
const TITLE_ODDS = /\byour\b.{0,30}\b(odds|chance|win|ticket)\b/i;
export const titleSecondPersonOdds = (t) => TITLE_ODDS.test(String(t));

const COMPARATIVE = /\b(best|better|worst|shortest|longest|lowest|highest|greatest|top|cheapest|biggest|smallest|easiest|likeliest)\b/i;
// A CLOSED set. "of the N" is the only scope token that carries a figure, which is why the one
// permitted comparative in the whole system ("Lowest ticket cap of the 8") uses it.
const SCOPE_OK = /\b(here|on this card|in this post|of the \d+)\b/i;
const ODDS_TOKEN = /\bodds\b|\b1 in\b|\bchance/i;
const SCOPE_UNBOUNDED = /\b(today|tonight|anywhere|in the uk|ever|of the day|right now|all week)\b/i;

export function unboundedComparative(s) {
  const t = String(s);
  if (COMPARATIVE.test(t) && !SCOPE_OK.test(t)) return true;
  // The second arm: a bounded comparative is still a breach if it sits beside an odds token and
  // an unbounded scope. "Shortest odds of the 8 anywhere in the UK" satisfies SCOPE_OK and is
  // still a claim over a universe PDD has never enumerated.
  const c = t.match(COMPARATIVE);
  if (c && SCOPE_UNBOUNDED.test(t)) {
    const i = t.toLowerCase().indexOf(c[0].toLowerCase());
    if (ODDS_TOKEN.test(t.slice(Math.max(0, i - 40), i + c[0].length + 40))) return true;
  }
  return false;
}

// The defect this closes has now been logged four times: config's "every night · 7pm UK", the
// closing slide's "checked and dated daily", the Reel strapline's "CHECKED DAILY" and the caption
// briefing's "we post TONIGHT'S UK DRAWS every night". §10.4's evidence window is 48 HOURS,
// which is the evidence that contradicts all four.
const CADENCE = /\b(daily|always|nightly|24\/7|round the clock)\b/i;
const EXHAUSTIVE = /\b(every|all)\b/i;

// ONE carve-out, and it is a name rather than a claim: PDD is called "Prize Draws Daily". The
// word `daily` inside its own registered name asserts no frequency — but "checked daily" three
// words later still does, so the brand tokens are removed before the class is tested rather than
// the class being relaxed. This is the only reason cadenceOrCoverage is not a bare regex, and it
// was found by the conformance gate firing on PDD's own alt text.
const BRAND = /\bprize\s+draws\s+daily\b|\bprizedrawsdaily\b/gi;
export const stripBrand = (s) => String(s).replace(BRAND, "PDD");

export function cadenceOrCoverage(s, facts) {
  if (CADENCE.test(stripBrand(s))) return true;      // no other carve-out, ever
  // `every`/`all` are permitted only where a figure from the facts table binds them in the same
  // sentence — "all 8", "every one of the 8". `each` is deliberately NOT in the class: it
  // distributes over a named set and asserts no frequency or exhaustiveness.
  for (const sent of sentences(s)) {
    if (!EXHAUSTIVE.test(sent)) continue;
    if (!facts || distinctKeyCount(sent, facts) < 1) return true;
  }
  return false;
}

// ── mechanic predicates ───────────────────────────────────────────────────────────────────────

// 1. No imperative directed at the reader's social graph. Checked on the LEADING verb, so a novel
//    phrasing of the same ask still fails and rewording is not an escape.
const SOCIAL_VERB = /^(share|shares|sharing|send|sends|sending|tag|tags|tagging|comment|comments|commenting|vote|votes|voting|react|reacts|reacting|repost|reposts|reposting|dm|dms)\b/i;
export function socialGraphImperative(s) {
  for (const sent of sentences(s)) {
    const lead = sent.replace(/^[^\p{L}\p{N}]+/u, "");
    if (SOCIAL_VERB.test(lead) || /^double[-\s]?tap\b/i.test(lead)) return true;
  }
  return false;
}

// 2. No numbered reference without its referent named in the same sentence. A carousel caption
//    that indexes a slide the viewer has not reached is an unresolvable reference.
const INDEX_PHRASE = /\b(?:number|no\.|slide|option|pick)\s*\d+\b|\bthe (?:first|second|third|fourth|fifth|last) one\b/i;
const REFERENT = /\b(draw|draws|prize|prizes|ticket|tickets|watch|car|cash|house|home|hamper|bundle|giveaway|competition|operator)\b/i;
export function danglingIndex(s) {
  for (const sent of sentences(s)) if (INDEX_PHRASE.test(sent) && !REFERENT.test(sent)) return true;
  return false;
}

// 3. The two-figure test, evidence-unit scoped. Fires on any unit whose text CONTAINS "?" —
//    contains, not ends with, so a headline cannot evade it by trailing a full stop. §7.10's
//    principle made machine-checkable: a permissible question is one whose answer is in the post.
//    No string is exempt for being allow-listed; an exemption keyed on "emitted by oddsCopy" would
//    auto-exempt every future entry, which is how a gate rots.
export function twoFigureTest(unit, facts) {
  const s = plainText(unit);
  if (!s.includes("?")) return false;
  return distinctKeyCount(s, facts) < 2;
}

// ── the deny-list backstop and the register bans ──────────────────────────────────────────────
export function bannedPhraseHit(s, phrases = []) {
  const t = String(s).toLowerCase();
  return phrases.filter((p) => p && new RegExp(`\\b${String(p).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
}

// "X tickets left" can never be true in PDD's data: sold and remaining counts are vetoed at parse
// time, so PDD holds no remaining-ticket figure at all. This ban is provable from the data model.
const URGENCY = /\b(last chance|final tickets?|selling fast|almost gone|nearly sold out|ending soon|going fast|tickets? left|tickets? remaining)\b/i;
export const falseUrgency = (s) => URGENCY.test(s);

// PDD is NOT under CAP Section 16 (Gambling) or 17 (Lotteries) — a prize competition sits outside
// Gambling Act 2005 licensing. Gambling furniture is therefore inaccurate AND re-categorises PDD
// in the viewer's mind. "odds" itself stays: it is the proposition.
const GAMBLING = /\b(play responsibly|begambleaware|gambleaware|gamble|gambling|bet|betting|stake|stakes|punt|odds-on|jackpot|sweepstakes?|lottery|lotteries)\b/i;
export function gamblingFurniture(s, operatorNames = []) {
  const t = String(s);
  const m = t.match(GAMBLING);
  if (!m) return false;
  // "lottery" is permitted inside an operator's registered name, and only there.
  const lower = t.toLowerCase();
  for (const name of operatorNames) {
    const n = String(name).toLowerCase();
    if (!n) continue;
    const at = lower.indexOf(n);
    if (at >= 0 && lower.indexOf(m[0].toLowerCase()) >= at && lower.indexOf(m[0].toLowerCase()) < at + n.length) return false;
  }
  return true;
}

// Not a code rule — the UK/US register teardown. Enforced for brand consistency.
const AMERICAN = /\$\d|\bwin big\b|!{2,}|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b/i;
export const americanTells = (s) => AMERICAN.test(s);

// Captions are conversational and assets are not, so the second person survives in caption prose
// ("follow so the next set reaches you") but never near an odds token. The distinction is the
// PROXIMITY, not the surface.
const ODDS_PROX = /\bodds\b|\b1 in\b|\bchance\b|\bticket cap\b|\bwin\b/gi;
export function captionProximity(s) {
  const t = String(s);
  for (const m of t.matchAll(ODDS_PROX)) {
    const w = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
    if (SECOND_PERSON.test(w)) return true;
  }
  return false;
}

// ── the unit check ────────────────────────────────────────────────────────────────────────────
// `surface` decides only which second-person rule applies. Everything else is uniform, because a
// claim does not become truer for being in a caption.
//   asset   — a rendered string in PDD's own voice. Second person is class A outright.
//   caption — caption, FB caption or alt text. Second person via the proximity rule only.
//   title   — an operator's prize title. Second person exempt; the odds pattern is class B.
export function checkUnit(text, { facts, surface = "asset", bannedPhrases = [], operatorNames = [] } = {}) {
  const out = [];
  const s = plainText(text);
  if (!s) return out;

  if (surface === "title") {
    if (titleSecondPersonOdds(s)) out.push(hit("L2.titleSecondPersonOdds", CLASS.B, s));
    return out;
  }
  if (surface === "asset" && secondPerson(s)) out.push(hit("L2.secondPerson", CLASS.A, s));
  if (surface === "caption" && captionProximity(s)) out.push(hit("L2.secondPersonNearOdds", CLASS.A, s));
  if (unboundedComparative(s)) out.push(hit("L2.unboundedComparative", CLASS.A, s));
  if (cadenceOrCoverage(s, facts)) out.push(hit("L2.cadenceOrCoverage", CLASS.A, s));
  if (socialGraphImperative(s)) out.push(hit("L2.socialGraphImperative", CLASS.A, s));
  if (danglingIndex(s)) out.push(hit("L2.danglingIndex", CLASS.A, s));
  if (falseUrgency(s)) out.push(hit("L2.falseUrgency", CLASS.A, s));
  if (gamblingFurniture(s, operatorNames)) out.push(hit("L2.gamblingFurniture", CLASS.A, s));
  if (americanTells(s)) out.push(hit("L2.americanTells", CLASS.A, s));
  const banned = bannedPhraseHit(s, bannedPhrases);
  if (banned.length) out.push(hit("L4.bannedPhrases", CLASS.A, banned.join(", ")));
  return out;
}

// The two-figure test is unit-scoped rather than string-scoped, so it is called separately with
// the unit the surface actually presents: for a cover headline that is headline + proof line,
// because the proof line is a mandatory block rendered directly beneath it.
export function checkQuestionUnit(unit, facts) {
  return twoFigureTest(unit, facts) ? [hit("L2.twoFigureTest", CLASS.A, String(unit))] : [];
}

// ── the record (§10.8) ────────────────────────────────────────────────────────────────────────
// Written on PASS as well as fail, so a run with the gates disabled is distinguishable from a run
// that passed them. A gate whose only output is an exit code gets switched off the first time it
// is inconvenient.
export const PREDICATE_NAMES = [
  "L2.secondPerson", "L2.secondPersonNearOdds", "L2.titleSecondPersonOdds", "L2.unboundedComparative",
  "L2.cadenceOrCoverage", "L2.socialGraphImperative", "L2.danglingIndex", "L2.twoFigureTest",
  "L2.falseUrgency", "L2.gamblingFurniture", "L2.americanTells", "L4.bannedPhrases",
];

export function newLedger({ drawsPlanned = 0, drawsRendered = 0, backupsUsed = 0, poolTruncated = false } = {}) {
  return {
    stage: "model",
    drawsPlanned, drawsRendered, backupsUsed, poolTruncated,
    violations: [],
    counted: [],                                            // §10.8's non-failure records
    gate_violations: Object.fromEntries(PREDICATE_NAMES.map((n) => [n, 0])),
  };
}

export function record(ledger, stage, asset, role, field, findings) {
  for (const f of findings) {
    ledger.violations.push({ stage, asset, role, field, ...f });
    if (f.predicate in ledger.gate_violations) ledger.gate_violations[f.predicate] += 1;
  }
  return ledger;
}

// Not failures. Counted so that a degraded deck is legible afterwards rather than a mystery.
export function count(ledger, kind, detail) {
  ledger.counted.push({ kind, detail });
  return ledger;
}

export const worstClass = (l) => [CLASS.A, CLASS.B, CLASS.C, CLASS.D].find((c) => l.violations.some((v) => v.class === c)) || null;

// §10.8's class-C ceiling is a PROPORTION, not a count: collapsed > floor(0.4 × drawsRendered)
// escalates to class A. At the old five-draw deck that is "escalate at three", which is
// arithmetically what the fixed rule said — so this generalises it rather than recalibrating it.
export function classCCeilingBreached(l) {
  const collapsed = l.violations.filter((v) => v.class === CLASS.C).length;
  return collapsed > Math.floor(0.4 * (l.drawsRendered || 0));
}

export function complianceText(l) {
  const L = [
    `PrizeDrawsDaily — compliance record (§10.8)`,
    `stage=${l.stage}  drawsPlanned=${l.drawsPlanned}  drawsRendered=${l.drawsRendered}  backupsUsed=${l.backupsUsed}  poolTruncated=${l.poolTruncated}`,
    `verdict=${worstClass(l) ? "FAIL class " + worstClass(l) : "PASS"}`,
    "",
  ];
  if (l.violations.length) {
    L.push("VIOLATIONS");
    for (const v of l.violations) L.push(`  [${v.class}] ${v.predicate}  stage=${v.stage} asset=${v.asset} role=${v.role} field=${v.field}\n        ${String(v.detail).slice(0, 240)}`);
    L.push("");
  }
  if (l.counted.length) {
    L.push("COUNTED (not failures)");
    for (const c of l.counted) L.push(`  ${c.kind}: ${c.detail}`);
    L.push("");
  }
  const fired = Object.entries(l.gate_violations).filter(([, n]) => n > 0);
  L.push(`predicates fired: ${fired.length ? fired.map(([k, n]) => `${k}=${n}`).join(" ") : "none"}`);
  return L.join("\n") + "\n";
}

export async function writeCompliance(outDir, ledger) {
  await Bun.write(`${outDir}/COMPLIANCE.json`, JSON.stringify(ledger, null, 2));
  await Bun.write(`${outDir}/COMPLIANCE.txt`, complianceText(ledger));
  return ledger;
}
