// Is a £0 draw TRULY free to enter? (owner decision 2026-10-14: truly free only.)
// Pure, no I/O. It fails closed: any catch phrase, or a £0 with no free wording at all (which is
// what an unread or glitched price looks like), means "not free", and the gate drops the draw.
// Order matters only for the reported reason; the first phrase found is the one named.
const CONDITIONS = [
  /\bspend\s*£/i,
  /\bspent\b/i,
  /\bmust have (?:spent|purchased|bought|entered a paid)/i,
  /\bwith any (?:order|purchase)\b/i,
  /\bpurchase required\b/i,
  /\bwhen you (?:buy|purchase)\b/i,
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
const FREE_WORDING = /\bfree\b|\bno cost\b|\bcosts? nothing\b/i;

const plain = (s) => String(s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

export function freeCheck(draw) {
  if (draw?.ticket_price !== 0) return { free: false, reason: "not a £0 draw" };
  const text = [draw.title, draw.grand_prize, draw.description, draw.free_text].filter(Boolean).map(plain).join(" \n ");
  for (const re of CONDITIONS) {
    const m = text.match(re);
    if (m) return { free: false, reason: `free but conditional: ${m[0].toLowerCase().replace(/\s+/g, " ")}` };
  }
  if (!FREE_WORDING.test(text)) return { free: false, reason: "£0 with no free wording" };
  return { free: true, reason: "free to enter" };
}
