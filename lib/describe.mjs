// Deterministic baseline description — runs at scrape time, NO AI.
// Guarantees every draft has a >=20-char, per-draw-unique blurb so the supervisor's
// "thin description" check passes and nothing is empty before the cowork/Claude routine
// rewrites it to original copy. Uniqueness comes from interpolating this draw's own
// fields; the frame is chosen deterministically by hash(slug) so the text is stable
// across re-runs (no churn) yet two different draws don't read identically.

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function ukLongDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
}
function gbp(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return `£${n.toFixed(2).replace(/\.00$/, "")}`;
}

export function templateDescription(draw) {
  const prize = (draw.grand_prize || draw.title || "this prize").toString().trim();
  const price = gbp(draw.ticket_price);
  const when = ukLongDate(draw.draw_date);
  const frames = [
    `Win ${prize} in this UK prize draw.${price ? ` Tickets start from just ${price}.` : ""}${when ? ` The winner is drawn on ${when}.` : ""}`,
    `Fancy winning ${prize}?${price ? ` Entries are ${price} each` : ""}${when ? `, with the draw taking place on ${when}` : ""}. Enter before the tickets sell out.`,
    `Up for grabs: ${prize}.${price ? ` Grab your tickets from ${price}` : ""}${when ? ` ahead of the live draw on ${when}` : ""}.`,
    `Here's your chance to win ${prize}.${price ? ` With tickets from ${price},` : ""}${when ? ` the winner is announced on ${when}.` : " don't miss out — enter today."}`,
  ];
  const key = (draw.slug || draw.title || prize).toString();
  return frames[hashStr(key) % frames.length];
}
