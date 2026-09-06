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
  // stamped on the stored row — whatever its source: 'rule', 'claude' or 'manual' — satisfies
  // the requirement. A fresh scrape being unable to RE-derive it is expected (that is exactly
  // why it was judged in the first place) and must not re-hold the draw forever.
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
// Why did an operator return nothing? "Silent" used to be one undifferentiated list, so a site
// refusing our IP for a day looked identical to a parser that has been broken for months — and
// the months-broken ones hid in the noise. These are the causes worth telling apart, because
// each has a different owner: a block is infrastructure, an empty parse is our code, and an
// operator with genuinely no open competitions is neither.
export function classifySilent(status) {
  if (status === "unreachable") return "unreachable (DNS/connection failed)";
  if (status === 451) return "geo-blocked (HTTP 451 — UK-only)";
  if (status === 403) return "blocked (403 — refused our IP)";
  if (status === 503) return "blocked (503 — refused our IP)";
  if (typeof status === "number" && status >= 400) return `blocked (HTTP ${status})`;
  return "reachable — parser found nothing (our bug, or no open comps)";
}

// Probe a set of operators and label WHY each produced nothing. Shared by run.mjs (which knows
// who was silent this run) and manager/tripwire.mjs (which knows who has been silent for weeks)
// — the tripwire runs as a separate step, and under a split workflow may not even be the same
// job, so it cannot be handed run.mjs's in-memory result. One helper, two callers, one answer.
export async function probeSilentReasons(entries, { timeoutMs = 15000, concurrency = 8, fetchImpl = fetch } = {}) {
  const out = new Map();
  const queue = entries.filter((e) => e?.slug && e?.base);
  let i = 0;
  const worker = async () => {
    while (i < queue.length) {
      const { slug, base } = queue[i++];
      let status = "unreachable";
      try {
        const r = await fetchImpl(base, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        status = r.status;
        // We only want the status line. An unread body holds the socket open and keeps the
        // process alive after the script has logically finished — two dry runs sat there for
        // minutes past their final report because of exactly this.
        await r.body?.cancel().catch(() => {});
      } catch { /* leave as unreachable */ }
      out.set(slug, classifySilent(status));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  return out;
}

export function buildHealthReport({ counts = [], expected = [], funnel = null }) {
  const bySlug = Object.fromEntries(counts.map((c) => [c.slug, c]));
  const silent = expected.filter((s) => !bySlug[s] || (bySlug[s].scraped || 0) === 0);
  const totals = counts.reduce((a, c) => ({
    scraped: a.scraped + (c.scraped || 0), inserted: a.inserted + (c.inserted || 0),
    published: a.published + (c.published || 0), heldDraft: a.heldDraft + (c.heldDraft || 0),
  }), { scraped: 0, inserted: 0, published: 0, heldDraft: 0 });
  return { perOperator: counts, silentOperators: silent, totals, funnel };
}

export function reportMarkdown(report) {
  const { totals, silentOperators, perOperator, funnel } = report;
  let md = `## Aggregator health report\n\n`;
  md += `**Totals:** scraped ${totals.scraped} · inserted ${totals.inserted} · published ${totals.published} · held-draft ${totals.heldDraft}\n\n`;
  // Capture is only the first third of the pipeline. A run can scrape perfectly and still add
  // nothing to the site if the publish cap is the binding constraint — which it was: 761 drafts
  // queued against 50 publishes/day, and 210 of them reached their draw date unpublished. That
  // number was nowhere in this report, so nobody was watching it.
  if (funnel) {
    const { draftsWaiting, publishCap, publishedThisRun } = funnel;
    md += `**Publish funnel:** ${draftsWaiting} draft(s) waiting · ${publishedThisRun} published this run`
        + (publishCap != null ? ` · cap ${publishCap}/run` : "") + `\n\n`;
    if (publishCap != null && publishedThisRun >= publishCap) {
      md += `> ⚠️ The publish cap was reached — the queue is capped, not empty. Raising AUTO_PUBLISH_MAX is what adds inventory here, not more scraping.\n\n`;
    }
  }
  if (silentOperators.length) {
    // Group by cause so the reader can act. Operators whose cause we could not determine fall
    // back to the old flat list rather than being silently dropped from the report.
    const bySlug = Object.fromEntries((perOperator || []).map((c) => [c.slug, c]));
    const groups = {};
    for (const slug of silentOperators) {
      const why = bySlug[slug]?.silentReason || "cause not determined";
      (groups[why] ||= []).push(slug);
    }
    md += `⚠️ **Silent operators (0 draws) — ${silentOperators.length} total**\n\n`;
    for (const [why, slugs] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
      md += `- **${why}** (${slugs.length}): ${slugs.join(", ")}\n`;
    }
    md += `\n`;
  }
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
