// Fetch live draws closing within N days and pick the strongest category.
import { GLOBAL, catCfg, drawsPerDeck } from "./config.mjs";
import { withRetry, fetchOk } from "./util.mjs";
const SUPABASE_URL = process.env.SUPABASE_URL || GLOBAL.supabaseUrl;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || GLOBAL.supabasePublishableKey;

// minDays = a runway floor: never feature a draw closing sooner than this (so a post
// stays relevant and followers have time to enter). days = the upper bound.
// 48 hours, not 24. The browser sweep runs 07:00 UTC daily and the carousel builds
// mid-afternoon, so the normal age of a figure at build time is around 8h. A 24h ceiling
// rejects every operator whose page refused a read ONCE, and on this inventory a single miss is
// the normal condition rather than the edge; 48h tolerates one miss and nothing more.
const FRESHNESS_H = 48;

export async function fetchEndingSoon(days = 7, minDays = 0, { requireProvenance = true } = {}) {
  const from = new Date(Date.now() + minDays * 86400000).toISOString();
  const end = new Date(Date.now() + days * 86400000).toISOString();
  const u = new URL(SUPABASE_URL + "/rest/v1/draws");
  // `operators(rating)` feeds the draw slide's Trust Score chip; the three provenance columns
  // feed the read-at stamp and the eligibility predicate below. They are selected only when
  // provenance is required, so a caller that opts out does not hit a 400 on a pre-migration DB.
  u.searchParams.set("select",
    "slug,title,grand_prize,prize_description,image_url,ticket_price,total_prize_value,total_entries,draw_date,entry_url,categories(slug,name),operators(name,rating)"
    + (requireProvenance ? ",figures_checked_at,figures_source_url,total_entries_method,free_entry_route" : ""));
  u.searchParams.set("status", "eq.active");
  u.searchParams.append("draw_date", "gte." + from);
  u.searchParams.append("draw_date", "lte." + end);
  u.searchParams.set("image_url", "not.is.null");
  // PROVENANCE IS A SELECTION PREDICATE, NOT A RENDER GATE, and that is the decisive move.
  // The carousel renders an odds figure derived from total_entries: a published objective claim
  // about a named third party, which CAP 3.7 wants evidence for BEFORE publication. Checked at
  // render time, every answer costs something — drop the draw and the deck runs short, keep it
  // and the claim is unevidenced. Checked HERE, a draw without fresh methodful provenance is
  // simply never picked: it cannot be dropped later, cannot collapse a slot, cannot consume a
  // backup. Exactly the shape `image_url=not.is.null` above already has.
  //
  // bare-count is excluded deliberately. It is extractEntries' tier-3 unlabelled grab, and on a
  // multi-competition listing page it is how a draw once scraped a stranger's ticket count.
  if (requireProvenance) {
    u.searchParams.set("figures_checked_at", "gte." + new Date(Date.now() - FRESHNESS_H * 3600e3).toISOString());
    u.searchParams.set("total_entries_method", "in.(operator-pattern,labelled-cap,derived-sum,progress-bar,agent-read,manual)");
  }
  u.searchParams.set("order", "draw_date.asc");
  u.searchParams.set("limit", "300");
  let r;
  try {
    r = await withRetry(() => fetchOk(u, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } }, "supabase draws"), { label: "fetchEndingSoon" });
  } catch (e) {
    // PostgREST answers an unknown column with a 400, so this is what "Stage 0 has not been
    // applied yet" looks like from here. Say so by name instead of reporting an empty inventory.
    if (requireProvenance && /figures_checked_at|total_entries_method|42703|PGRST/i.test(String(e.message))) {
      throw new Error(
        "the figures-provenance columns do not exist yet — run migrations/0001-figures-provenance.sql "
        + "against the live database.\nUntil then the odds figure cannot be evidenced, and an "
        + "unevidenced odds figure is the one thing this deck must not publish.\n  underlying: "
        + String(e.message).slice(0, 200));
    }
    throw e;
  }
  return await r.json();
}

// Score each category: needs enough draws to fill the carousel, weighted by visual fit,
// tiebroken by total prize value. Requires >=3 draws unless nothing else qualifies.
export function pickBestCategory(draws, n = 5, onlySlug = null, opts = {}) {
  const { excludeSlugs = new Set(), avoidCategory = null } = opts;
  const by = {};
  for (const d of draws) {
    if (excludeSlugs.has(d.slug)) continue;
    // An unrecognised slug used to be bucketed as the literal string "other", and because
    // catCfg merged a fallback it got a real weight and could win a deck. It now resolves to a
    // visualWeight of 0, so the bucket survives for reporting and can never be selected.
    const s = d.categories?.slug || "other";
    if (onlySlug && s !== onlySlug) continue;
    (by[s] ||= []).push(d);
  }
  let best = null;
  for (const [slug, list] of Object.entries(by)) {
    const w = catCfg(slug).visualWeight;
    const value = list.reduce((a, d) => a + (Number(d.total_prize_value) || 0), 0);
    // THE ADEQUACY BAR IS THE DECK SIZE, NOT THREE. It read `>= Math.min(3, n)`, so a category
    // with three draws cleared the bar for a deck of eight and `slice(0, n)` then returned
    // short — which means no deck-size floor this project has ever specified was enforced in
    // code. The `enough * 1e12` term dominates the score outright, so an inadequate category
    // could also win on adequacy alone whatever its weight.
    const enough = list.length >= n ? 1 : 0;
    let score = enough * 1e12 + w * Math.min(list.length, n) * 1e9 + value;
    if (slug === avoidCategory) score *= 0.5; // soft penalty: rotate categories, don't ban
    if (!best || score > best.score) best = { slug, score, list };
  }
  if (!best) return null;
  return {
    slug: best.slug, name: best.list[0].categories?.name || best.slug, count: best.list.length,
    draws: best.list.slice(0, n),
    pool: best.list, // full ordered category list (for backups / swaps)
  };
}
