// API Platform / Hydra JSON-LD — Dream Car Giveaways.
//
// WHY THIS EXISTS: dream-car-giveaways is a pure CAR operator (56 live competitions today,
// the category the site is weakest in) and it was excluded from the daily run ENTIRELY —
// `run.mjs` filters out `aiAssist` operators, and this was one, so its only path was a manual
// Claude extraction that rarely ran. It turns out no AI is needed at all: the site is backed
// by a public, keyless API Platform endpoint serving structured JSON-LD.
//
//     GET https://api.dreamcargiveaways.co.uk/competitions        (page 1)
//     → { "hydra:member": [...], "hydra:view": { "hydra:next": "/competitions?page=2" } }
//
// (The API root itself 401s — only the /competitions collection is public.)
//
// ⚠️ `regularPrice` is in PENCE as an integer: 9 means £0.09, not £9. Reading it as pounds
// would inflate every ticket price 100x and trip the >£50 sanity flag on the cheap comps
// while silently publishing wrong prices on the rest.
import { UA, normalizeUkDate, resolveCategory } from "../parse.mjs";

const MEDIA = "https://media.dreamcargiveaways.co.uk/media/transformed";

// `thumb` is a path ("/media-uploads/<id>") that 401s, and `thumbnail` is the bare id. The
// public, fetchable form is the transformed-media URL — confirmed against the og:image on the
// operator's own competition page.
export function imageUrl(r) {
  const id = r?.thumbnail || (r?.thumb || "").split("/").filter(Boolean).pop();
  return id ? `${MEDIA}/${id}?w=1280` : null;
}

export function mapCompetition(r, op) {
  const title = (r?.name || "").trim();
  const stub = r?.urlStub;
  if (!title || !stub) return null;
  const price = Number(r?.regularPrice);
  return {
    title,
    grand_prize: title, // the name IS the prize here ("Win this Carbon Vorsprung Audi RS3 …")
    grand_prize_source: "api:name",
    // category is an operator slug like car_sports / car_suv / instant_wins / other_cash.
    // Normalised to spaces so mapOperatorCategory's keyword matching sees "car sports".
    category: resolveCategory({ op, title, grand_prize: title, url: stub, apiCategories: r?.category ? [String(r.category).replace(/_/g, " ")] : [] }),
    ticket_price: Number.isFinite(price) ? Math.round(price) / 100 : null, // PENCE → pounds
    total_entries: Number.isFinite(Number(r?.numTickets)) ? Number(r.numTickets) : null,
    draw_date: r?.closeTs ? normalizeUkDate(r.closeTs) : null,
    image_url: imageUrl(r),
    entry_url: `${op.base.replace(/\/+$/, "")}/competitions/${stub}`,
    description: null,
  };
}

export const isLive = (r, now = new Date()) =>
  r?.status === "published" && r?.closeTs && new Date(r.closeTs) > now;

export async function hydraOperator(op, perOp = 300) {
  const origin = new URL(op.listApi || "https://api.dreamcargiveaways.co.uk/competitions").origin;
  let next = op.listApi || "https://api.dreamcargiveaways.co.uk/competitions";
  const rows = [];
  // Hydra paginates by handing back the next page's path; follow it rather than guessing
  // page numbers. Bounded so a malformed cursor can't loop forever.
  for (let page = 0; page < (op.maxPages || 6) && next; page++) {
    const r = await fetch(next, { headers: { "User-Agent": UA, Accept: "application/ld+json" }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.log(`  hydra API ${r.status} for ${next}`); break; }
    let body = null;
    try { body = await r.json(); } catch { console.log("  hydra API returned non-JSON"); break; }
    const members = body?.["hydra:member"];
    if (!Array.isArray(members) || !members.length) break;
    rows.push(...members);
    const nx = body?.["hydra:view"]?.["hydra:next"];
    next = nx ? (nx.startsWith("http") ? nx : `${origin}${nx}`) : null;
  }
  const now = new Date();
  const live = rows.filter((x) => isLive(x, now));
  console.log(`  ${live.length} live competitions from the API (${rows.length} scanned)`);
  return live.slice(0, perOp).map((x) => mapCompetition(x, op)).filter(Boolean);
}
