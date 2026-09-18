// carousel/brief.mjs — generates the caption BRIEFING Claude writes from (spec §4.6).
// The briefing is instructions + verified facts; Claude authors the final caption.
import { GLOBAL, catCfg } from "./config.mjs";

export const hashtagsFor = (slug) => [...GLOBAL.fixedHashtags, ...catCfg(slug).hashtags].join(" ");

export function buildBriefing({ sel, drawSlides, recentOpeners = [] }) {
  const kw = sel.seoKeyword || catCfg(sel.slug).seoKeyword;
  const rows = drawSlides.map((s, i) =>
    `| ${i + 1} | ${String(s.title).replaceAll("|", "\\|")} | ${s.price || "?"} | ${s.closes || "?"} | ${s.odds || "—"} | ${s.cashAlt || "—"} |`).join("\n");
  const banned = [...GLOBAL.bannedPhrases, ...recentOpeners].map((p) => `- "${p}"`).join("\n");
  return `# Caption briefing — ${sel.name} (${new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London" })})

## Verified facts (ONLY these may be claimed)
| # | Prize | Ticket | Closes | Odds | Cash alt |
|---|-------|--------|--------|------|----------|
${rows}

## Instructions
- Hook archetype today: **${sel.archetype || "price-anchor"}** (question / price-anchor / deadline / absurd-comparison).
- FIRST sentence must contain the keyword naturally: **"${kw}"** (IG SEO), THEN the hook.
- Include ≥1 concrete, verifiable, specific detail (e.g. "a Daytona for less than a meal deal").
- Series line near the end: **we post TONIGHT'S UK DRAWS every night — follow so you don't miss yours** (follow-first, site second).
- One send-CTA, fresh wording each day (never verbatim-repeat "send this to your comp buddy").
- Comper vernacular welcome (GTD, odds, exact close times) — but ONLY when the facts table proves it.
- 🔴 **NAME THE OPERATOR ON EVERY PRIZE LINE.** Meta suspended this Page on 4 Sep 2026 for
  IMPERSONATION — "pretending a Page has a business relationship with a business" — because the
  captions listed an Apple iPad, a Land Rover and a Harley-Davidson as prizes without ever saying
  whose competition they were. Write "ROLEX Submariner · £25 · Elite Competitions", never
  "ROLEX Submariner · £25". Attribution is the fix; dropping the brand name is not.
- 🔴 **Include the independence line**: "We list draws. We run none — every one above is the
  operator's own." On Facebook put it ABOVE the prize list.
- Never imply endorsement by, or a relationship with, the prize's manufacturer. PDD has no
  relationship with Apple, Rolex, Land Rover or any brand whose product is a prize.
- End with: link in bio · 18+ · UK only
- Do NOT write "play responsibly" or any gambling wording. A prize competition sits OUTSIDE
  Gambling Act 2005 licensing, so the operative code is CAP Section 8, not 16 or 17.
- Then hashtags exactly: ${hashtagsFor(sel.slug)}

## Banned phrases (templated tells + last-14-day openers)
${banned}

Write the IG caption (≤2,200 chars) AND a fuller FB caption (with the clickable link https://prizedrawsdaily.co.uk in the body). Save the IG caption over out/CAPTION.txt AND the FB caption to out/FB_CAPTION.txt before running publish.`;
}
