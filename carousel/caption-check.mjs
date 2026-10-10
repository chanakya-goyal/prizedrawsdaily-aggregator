// carousel/caption-check.mjs — the wording gate on the captions someone WROTE.
//
//   bun carousel/caption-check.mjs     (exit 0 = clean, 1 = class A: do not publish)
//
// build.mjs gates every string IT composes, including CAPTION_FALLBACK.txt. But the captions that
// usually ship are CAPTION.txt and FB_CAPTION.txt, written by Claude from BRIEFING.md after the
// build — and until now nothing checked them. DAILY.md said a bad caption "is a class-A failure at
// publish"; it was not. publish.mjs now calls this before uploading anything, so an unattended run
// cannot ship a caption the gate would have refused had build.mjs written it.
import * as compliance from "./compliance.mjs";
import { GLOBAL, workDir } from "./config.mjs";

const SENTENCES = /(?<=[.!?])\s+|\n+/;

// Caption rules: second person only near an odds token, plus every L2 predicate, the banned
// phrases, and the two-figure rule on any sentence with a "?".
export function captionFindings(text, { facts, operatorNames = [] } = {}) {
  const out = compliance.checkUnit(text, { facts, surface: "caption", bannedPhrases: GLOBAL.bannedPhrases, operatorNames });
  for (const s of String(text).split(SENTENCES)) out.push(...compliance.checkQuestionUnit(s, facts));
  return out;
}

// The run's verified facts, rebuilt from what build.mjs wrote (facts.json) and the settled
// selection (draw dates, for days-to-close).
export function factsFor({ facts = [], draws = [], now = Date.now() }) {
  return compliance.factsTable({
    drawsRendered: facts.length,
    caps: facts.map((f) => f.cap).filter((x) => x != null),
    prices: facts.map((f) => f.price).filter(Boolean),
    daysToClose: draws.map((d) => Math.max(1, Math.ceil((+new Date(d.draw_date) - now) / 86400000))).filter(Number.isFinite),
  });
}

export async function checkCaptionFiles(dir = workDir()) {
  const out = `${dir}/out`;
  const facts = await Bun.file(`${out}/facts.json`).json().catch(() => []);
  const sel = await Bun.file(`${dir}/selection.json`).json().catch(() => ({ draws: [] }));
  const table = factsFor({ facts, draws: sel.draws || [] });
  const operatorNames = facts.map((f) => f.operator).filter(Boolean);
  const findings = [];
  for (const file of ["CAPTION.txt", "FB_CAPTION.txt", "CAPTION_FALLBACK.txt"]) {
    const text = (await Bun.file(`${out}/${file}`).text().catch(() => "")).trim();
    if (!text) continue;
    for (const f of captionFindings(text, { facts: table, operatorNames })) findings.push({ file, ...f });
  }
  return { findings, classA: findings.some((f) => f.class === compliance.CLASS.A) };
}

export const findingsText = (findings) =>
  findings.map((f) => `  ${f.class}  ${f.file}  ${f.predicate}: ${String(f.detail).slice(0, 140)}`).join("\n");

if (import.meta.main) {
  const { findings, classA } = await checkCaptionFiles();
  if (!findings.length) { console.log("✓ captions clean"); process.exit(0); }
  console.log(findingsText(findings));
  if (classA) { console.error("✗ class A in a caption — do not publish. Rewrite the line, then re-run."); process.exit(1); }
  console.log("⚠ non-blocking findings only");
}
