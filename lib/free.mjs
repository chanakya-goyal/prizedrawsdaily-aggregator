// Is a £0 draw TRULY free to enter? (owner decision 2026-10-14: truly free only.)
// Pure, no I/O. It fails closed: any catch phrase, or a £0 with no free wording at all (which is
// what an unread or glitched price looks like), means "not free", and the gate drops the draw.
// Order matters only for the reported reason; the first phrase found is the one named.
const CONDITIONS = [
  /\bspend\s*(?:over\s+|more than\s+|at least\s+|a minimum of\s+)?£/i,
  /\bspent\b/i,
  /\bmust have (?:spent|purchased|bought|entered a paid)/i,
  /\bwith any (?:order|purchase)\b/i,
  /(?<!\bno\s+)\bpurchase required\b/i, // "No purchase required" is free wording
  /\bfirst (?:order|purchase|deposit)\b/i,
  /\bnew customers? only\b/i,
  /\bwhen you (?:buy|purchase)\b/i,
  /\bbuy (?:any|a|one|at least one) (?:ticket|entry|entries|comp)/i,
  /\bdeposit/i,
  /\bticket[\s-]?holders?\b/i,
  /\bsubscri(?:ber|bers|ption)\b/i,
  /\bmembers?[\s-]+only\b/i,
  /\bvip\b/i,
  /\bloyalty\b/i,
  /\bclub members?\b/i,
  /\bactive players?\b/i,
  /\bpoints\b/i,
  /\binstant[\s-]?win/i,
  /\bspins?\b/i,
  /\bscratch/i,
  /\bwheel\b/i,
];
// Free wording counts only in the draw's OWN title / prize name. Descriptions on paid UK comps
// nearly all say "free postal entry", so reading them for wording would let a paid draw whose
// price was misread as 0 through as "free" (review 2026-10-15). Phrases that say free about
// something other than entry are removed first.
const FREE_WORDING = /\bfree\b|\bno cost\b|\bcosts? nothing\b/i;
const NOT_ENTRY_FREE = /\btax[\s-]free\b|\bfree (?:delivery|shipping|postage|postal entry|entry route|postal route)\b/gi;

const ENTITIES = { nbsp: " ", pound: "£", amp: "&", quot: '"', apos: "'", ndash: "–", mdash: "—" };
const plain = (s) => String(s)
  .replace(/<[^>]*>/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
  .replace(/\s+/g, " ");

export function freeCheck(draw) {
  if (draw?.ticket_price !== 0) return { free: false, reason: "not a £0 draw" };
  const text = [draw.title, draw.grand_prize, draw.description, draw.free_text].filter(Boolean).map(plain).join(" \n ");
  for (const re of CONDITIONS) {
    const m = text.match(re);
    if (m) return { free: false, reason: `free but conditional: ${m[0].toLowerCase().replace(/\s+/g, " ")}` };
  }
  const own = [draw.title, draw.grand_prize].filter(Boolean).map(plain).join(" \n ").replace(NOT_ENTRY_FREE, " ");
  if (!FREE_WORDING.test(own)) return { free: false, reason: "£0 with no free wording" };
  return { free: true, reason: "free to enter" };
}
