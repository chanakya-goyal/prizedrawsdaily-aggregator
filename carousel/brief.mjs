// carousel/brief.mjs — generates the caption BRIEFING Claude writes from (spec §4.6).
// The briefing is instructions + verified facts; Claude authors the final caption.
import { GLOBAL, catCfg } from "./config.mjs";

export const hashtagsFor = (slug) => [...GLOBAL.fixedHashtags, ...catCfg(slug).hashtags].join(" ");

export function buildBriefing({ sel, drawSlides, recentOpeners = [] }) {
  const kw = sel.seoKeyword || catCfg(sel.slug).seoKeyword;
  const rows = drawSlides.map((s, i) =>
    `| ${i + 1} | ${String(s.title).replaceAll("|", "\\|")} | ${s.price || "?"} | ${s.closes || "?"} | ${s.odds || "—"} | ${s.cashAlt || "—"} |`).join("\n");
  const banned = [...GLOBAL.bannedPhrases, ...recentOpeners].map((p) => `- "${p}"`).join("\n");
  // The run's verified-facts KEYS, printed because §10.6 predicate 3 counts distinct keys and a
  // caption author who cannot see the keys cannot satisfy it except by luck.
  const drawsRendered = drawSlides.length;
  const caps = drawSlides.map((s) => s.cap).filter((x) => x != null).join(", ") || "none recorded";
  const prices = [...new Set(drawSlides.map((s) => s.price).filter(Boolean))].join(", ") || "none recorded";
  const daysToClose = [...new Set(drawSlides.map((s) => s.closes).filter(Boolean))].join(", ") || "none recorded";
  return `# Caption briefing — ${sel.name} (${new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London" })})

## Verified facts (ONLY these may be claimed)
| # | Prize | Ticket | Closes | Odds | Cash alt |
|---|-------|--------|--------|------|----------|
${rows}

## Instructions
- Hook archetype today: **${sel.archetype || "price-anchor"}** (question / price-anchor / deadline / absurd-comparison).
- FIRST sentence must contain the keyword naturally: **"${kw}"** (IG SEO), THEN the hook.
- Include ≥1 concrete, verifiable, specific detail (e.g. "a Daytona for less than a meal deal").
- Series line near the end: **follow so the next set of draws reaches you** (follow-first, site second).
- 🔴 **State NO posting frequency.** Never "every night", "daily", "nightly", "24/7". §10.4's
  evidence window is 48 HOURS and the run is not guaranteed to happen — a cadence claim is
  therefore unevidenced under CAP 3.7. This is the fourth place the same claim has had to be
  removed, so it is now a machine-checked predicate ("cadenceOrCoverage"), not advice.
- 🔴 **No ask directed at the reader's social graph.** No "share", "send", "tag", "comment",
  "vote", "react", "double tap" as an imperative. A novel phrasing of the same ask still fails
  the predicate, so do not reword it — omit it.
- Comper vernacular welcome (GTD, odds, exact close times) — but ONLY when the facts table proves it.
- 🔴 **NAME THE OPERATOR ON EVERY PRIZE LINE.** Meta suspended this Page on 4 Sep 2026 for
  IMPERSONATION — "pretending a Page has a business relationship with a business" — because the
  captions listed an Apple iPad, a Land Rover and a Harley-Davidson as prizes without ever saying
  whose competition they were. Write "ROLEX Submariner · £25 · Elite Competitions", never
  "ROLEX Submariner · £25". Attribution is the fix; dropping the brand name is not.
- 🔴 **Include the independence line**: "We list draws. We run none — each one above is the
  operator's own." On Facebook put it ABOVE the prize list. EACH, not "every": an exhaustiveness
  claim unbound by a figure is class A (§10.6 cadenceOrCoverage).
- Never imply endorsement by, or a relationship with, the prize's manufacturer. PDD has no
  relationship with Apple, Rolex, Land Rover or any brand whose product is a prize.
- End with: link in bio
- Do NOT write "18+" or "UK only". The age limit is the operator's and lives in their terms;
  PDD stores no territory field, so "UK only" is unevidenced. Point at the terms instead.
- Do NOT write "play responsibly" or any gambling wording. A prize competition sits OUTSIDE
  Gambling Act 2005 licensing, so the operative code is CAP Section 8, not 16 or 17.
- Then hashtags exactly: ${hashtagsFor(sel.slug)}

## The two-figure rule for questions (§10.6 predicate 3) — read this before writing any "?"
A caption sentence containing a QUESTION MARK must carry at least TWO figures drawn from two
DIFFERENTLY-NAMED facts in the table above. Two ticket caps do not satisfy it; a cap and a ticket
price do. The fact keys are:
  drawsRendered = ${drawsRendered}
  caps          = ${caps}
  prices        = ${prices}
  daysToClose   = ${daysToClose}
Word-numbers ("THREE", "EIGHT") never count as figures. The rule exists because a permissible
question is one whose answer is in the post; an impermissible one is a question whose answer is
only in the reader. PDD's own archived caption shipped "Which would you pick?" — zero figures,
class A. If you cannot put two figures in the sentence, do not ask the question.

## Banned phrases (templated tells + last-14-day openers)
${banned}

Write the IG caption (≤2,200 chars) AND a fuller FB caption (with the clickable link https://prizedrawsdaily.co.uk in the body). Save the IG caption over out/CAPTION.txt AND the FB caption to out/FB_CAPTION.txt before running publish.`;
}
