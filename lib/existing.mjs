// run.mjs's start-of-run snapshot of the draws table, read in two parts so the scraper stops
// re-downloading two thirds of the table it can never change.
//
// It used to be ONE read of 14 columns across every draw: 9,335 rows, ~8 MB raw, ~2.1 MB on the
// wire per run (measured 2026-10-09), four runs a day — about 80% of the scraper's whole
// Supabase egress. But 6,268 of those rows are `ended`, and from an ended row the routing
// decision reads only id/slug/status/draw_date/category_source (relist check + category
// provenance; test/existing.test.mjs records the exact reads through a Proxy). Only `active`
// and `draft` rows are compared field by field against a fresh scrape, so only they need the
// full payload.
//
// The merged snapshot keeps the old read's order (id ascending, from the identity read), so
// the maps built from it — byUrl (last row wins on a duplicate URL), takenSlugs, knownUrls —
// come out exactly as before.

export const MUTABLE_STATUSES = ["active", "draft"];

// Everything routeDraw + run.mjs read from a row that is NOT active/draft, plus the keys the
// dedupe maps are built from.
export const IDENTITY_COLUMNS = "id,entry_url,slug,status,draw_date,category_source";

// The single read this replaces, unchanged — active/draft rows get exactly what they always did.
export const FULL_COLUMNS = "id,entry_url,slug,status,title,ticket_price,total_entries,total_prize_value,draw_date,image_url,prize_description,category_id,category_source,created_at";

const BY_ID_CHUNK = 100; // keeps the id=in.(…) URL well under any proxy's length limit

/** Identity rows in their order, each replaced by its full row when one was read. */
export function mergeExisting(identity, full) {
  const byId = new Map(full.map((r) => [r.id, r]));
  const out = identity.map((r) => byId.get(r.id) ?? r);
  // A row inserted between the two reads appears only in the full read; keep it, as the old
  // single read would have if it had started a moment later.
  const seen = new Set(identity.map((r) => r.id));
  for (const r of full) if (!seen.has(r.id)) out.push(r);
  return out;
}

/**
 * @param getAll paginated GET (path → rows), e.g. run.mjs's sbGetAll. It appends ordering.
 */
export async function loadExisting(getAll) {
  const identity = await getAll(`draws?select=${IDENTITY_COLUMNS}`);
  const full = await getAll(`draws?select=${FULL_COLUMNS}&status=in.(${MUTABLE_STATUSES.join(",")})`);
  let rows = mergeExisting(identity, full);

  // A row that turned active/draft between the two reads is mutable but lean. Routing would
  // then compare a draft against missing fields, so fetch those few in full by id.
  const fullIds = new Set(full.map((r) => r.id));
  const lean = rows.filter((r) => MUTABLE_STATUSES.includes(r.status) && !fullIds.has(r.id)).map((r) => r.id);
  if (lean.length) {
    const extra = [];
    for (let i = 0; i < lean.length; i += BY_ID_CHUNK) {
      extra.push(...await getAll(`draws?select=${FULL_COLUMNS}&id=in.(${lean.slice(i, i + BY_ID_CHUNK).join(",")})`));
    }
    const byId = new Map(extra.map((r) => [r.id, r]));
    rows = rows.map((r) => byId.get(r.id) ?? r);
  }
  return rows;
}
