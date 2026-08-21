// Manager / validator-QA. Deterministic field rules (extends the old run.mjs supervisor)
// + a live image check + an operator health report. The cowork/Claude routine layers
// judgment (description quality, category sanity) on top of these and owns the publish
// decision; these functions give it the deterministic backbone and let run.mjs flag
// suspicious draws to 'draft' at scrape time.
import { CATEGORIES, UA, categoryEvidence } from "./parse.mjs";


// Synchronous flags. Any flag → the draw is held as 'draft' for review (never dropped here).
// `hasStoredCategory` says the row we are re-checking already carries a category in the DB —
// see the null-category rule at the end of the function.
export function fieldFlags(draw, { hasStoredCategory = false } = {}) {
  const flags = [];
  const price = Number(draw.ticket_price), ent = Number(draw.total_entries);
  const pool = (price || 0) * (ent || 0);
  if (price > 50) flags.push(`ticket £${price} >£50?`);
  if (ent > 5_000_000) flags.push(`${ent} entries >5M?`);
  if (pool > 50_000_000) flags.push(`pool £${Math.round(pool)} >£50M?`);
  if (["car-draws", "house-draws"].includes(draw.category) && pool < 5000) flags.push(`${draw.category} pool only £${Math.round(pool)}`);
  if (!/^https?:\/\/.+/i.test(draw.image_url || "")) flags.push("missing/bad image");
  if (!/^https?:\/\/.+/i.test(draw.entry_url || "")) flags.push("bad entry_url");
  if (draw.category && !CATEGORIES.includes(draw.category)) flags.push(`bad category ${draw.category}`);
  if (!draw.description || draw.description.length < 20) flags.push("thin description");
  if (!draw.title || draw.title.trim().length < 5) flags.push("thin title");
  // Flag a category only when the prize text CONTRADICTS it — i.e. the shared rules name a
  // DIFFERENT category. Silence is not contradiction: plenty of legitimate prizes (a detailing
  // bundle, a surprise hamper, "The £2 Million Summer Clear-Out") match no keyword at all,
  // and holding those forever is what the old check did. Measured on the live draft queue,
  // this is the difference between 241 and 33 flagged rows.
  const evidence = categoryEvidence({ title: draw.title, grand_prize: draw.grand_prize, url: draw.entry_url });
  if (draw.category && evidence && evidence !== draw.category) {
    flags.push(`category '${draw.category}' contradicts the prize, which reads as '${evidence}'`);
  }
  // No evidence is a publishing blocker (Claude will judge it), but a category already
  // stamped on the stored row (claude/manual/backfill) satisfies the requirement — a fresh
  // scrape being unable to RE-derive it is expected and must not re-hold the draw forever.
  if (!draw.category && !hasStoredCategory) flags.push("no category evidence");
  return flags;
}

// Live image check. A definitive non-2xx → block (flag). A timeout/network error returns
// ok:null = "unverified, don't block" so a flaky CDN never buries a good draw.
export async function checkImage(url, { timeoutMs = 5000 } = {}) {
  if (!/^https?:\/\/.+/i.test(url || "")) return { ok: false, reason: "no url" };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let r = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA } });
    // HEAD is only an optimisation, and plenty of image CDNs refuse it outright — Dream Car
    // Giveaways' media host answers HEAD with 401 while GET on the same URL returns a
    // perfectly good 122KB JPEG. Treating any non-2xx HEAD as "unreachable" would have held
    // every one of that operator's 47 draws out of publication forever, so retry with GET on
    // ANY failure rather than a hand-maintained list of statuses.
    if (!(r.status >= 200 && r.status < 300)) {
      r = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA, Range: "bytes=0-0" } });
    }
    if (r.status >= 200 && r.status < 300) {
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      return { ok: ct === "" || /image\//.test(ct), reason: ct || "no content-type" };
    }
    return { ok: false, reason: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: null, reason: e.name === "AbortError" ? "timeout" : (e.message || "error") };
  } finally {
    clearTimeout(to);
  }
}

// Full per-draw verdict (deterministic). status='active' only if no flags.
export async function review(draw, { checkImg = true } = {}) {
  const flags = fieldFlags(draw);
  if (checkImg) {
    const img = await checkImage(draw.image_url);
    if (img.ok === false && !flags.some((f) => /image/i.test(f))) flags.push(`image unreachable (${img.reason})`);
  }
  return { status: flags.length ? "draft" : "active", flags };
}

// ---- operator health report ----
// counts: [{ slug, scraped, inserted, published, heldDraft }]; expected = slugs in this run.
export function buildHealthReport({ counts = [], expected = [] }) {
  const bySlug = Object.fromEntries(counts.map((c) => [c.slug, c]));
  const silent = expected.filter((s) => !bySlug[s] || (bySlug[s].scraped || 0) === 0);
  const totals = counts.reduce((a, c) => ({
    scraped: a.scraped + (c.scraped || 0), inserted: a.inserted + (c.inserted || 0),
    published: a.published + (c.published || 0), heldDraft: a.heldDraft + (c.heldDraft || 0),
  }), { scraped: 0, inserted: 0, published: 0, heldDraft: 0 });
  return { perOperator: counts, silentOperators: silent, totals };
}

export function reportMarkdown(report) {
  const { totals, silentOperators, perOperator } = report;
  let md = `## Aggregator health report\n\n`;
  md += `**Totals:** scraped ${totals.scraped} · inserted ${totals.inserted} · published ${totals.published} · held-draft ${totals.heldDraft}\n\n`;
  if (silentOperators.length) md += `⚠️ **Silent operators (0 draws — check selectors / blocked):** ${silentOperators.join(", ")}\n\n`;
  md += `| operator | scraped | inserted | published | draft |\n|---|---|---|---|---|\n`;
  for (const c of perOperator) md += `| ${c.slug} | ${c.scraped || 0} | ${c.inserted || 0} | ${c.published || 0} | ${c.heldDraft || 0} |\n`;
  return md;
}

// Emit the report to the GitHub Action step summary when running there; always echo to log.
export async function writeStepSummary(report) {
  const md = reportMarkdown(report);
  console.log("\n" + md);
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { await Bun.write(f, md); } catch { /* non-fatal */ } }
}
