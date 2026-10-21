// carousel/native-reel-copy.mjs — the WORDS of the native Reel (2026-10-21).
//
// Why a Reel, and why this shape: the 21 Oct audit (46 posts, live Graph API) found Reels were
// the only format Instagram showed to non-followers (median reach 115 vs 4–11 for stills), but
// 80–92% of viewers swiped away inside 2–3 seconds. Those Reels opened on a list of five prizes.
// This one opens on ONE prize: its price, said as a claim, in the first half-second.
//
// Pure — no browser, no network — so every string is testable offline and goes through the same
// compliance gate as the deck (no "you", no clock times, no superlatives, no "?" without two
// verified figures, the operator named on the frame).
import { cleanTitle, priceLabel, cashExtras, shortMoney } from "./format.mjs";
import { hashOf, withArticle, closesParts, cashLine, SITE, FINE_PRINT, wordsFor } from "./native-copy.mjs";
import { GLOBAL, catCfg } from "./config.mjs";

const titleOf = (d) => cleanTitle(d.grand_prize || d.title);
const operatorOf = (d) => String(d.operators?.name || "").trim() || null;
const isPence = (label) => /^\d{1,2}p$/.test(label);

// Brands a viewer self-identifies with ("Subaru people"). A prize whose title names none of these
// simply never gets the identity hook — a guessed brand would be a false statement on screen.
export const BRANDS = [
  "Alfa Romeo", "Aston Martin", "Land Rover", "Range Rover", "Louis Vuitton", "Audemars Piguet", "Patek Philippe",
  "Tag Heuer", "Van Cleef", "Harley-Davidson", "Mercedes", "Porsche", "Ferrari", "Lamborghini", "McLaren", "Bentley",
  "BMW", "Audi", "VW", "Volkswagen", "Ford", "Subaru", "Nissan", "Toyota", "Honda", "Mazda", "Mini", "Jeep", "Tesla",
  "Volvo", "Skoda", "Seat", "Cupra", "Kia", "Hyundai", "Vauxhall", "Renault", "Peugeot", "Suzuki", "Ducati",
  "Kawasaki", "Yamaha", "Triumph", "Rolex", "Omega", "Breitling", "Cartier", "Tudor", "Hermes", "Chanel", "Dior",
  "Gucci", "Apple", "iPhone", "MacBook", "PlayStation", "Xbox", "Nintendo", "Samsung", "Dyson", "Pokémon", "LEGO",
];
// Child-appeal brands never lead a Reel (compliance audit, 21 Oct: a paid draw led by LEGO/Pokémon).
const CHILD_APPEAL = new Set(["Pokémon", "LEGO", "Nintendo"]);

export function brandOf(title) {
  const t = ` ${String(title)} `.toLowerCase();
  return BRANDS.find((b) => t.includes(` ${b.toLowerCase()} `) || t.includes(` ${b.toLowerCase()}-`)) || null;
}

// The prize name as a hook may say it: the WHOLE name when it is three words or fewer, else null.
// Never a truncation: "VW Golf R Line" cut to "VW Golf R" names a different car (caught on the
// first render, 21 Oct). A pattern that needs the name simply does not apply to a long one.
export function shortTitle(title, maxWords = 3) {
  const w = String(title).trim().split(/\s+/).filter(Boolean);
  return w.length && w.length <= maxWords ? w.join(" ") : null;
}

// ── which prize leads ─────────────────────────────────────────────────────────────────────────
// The cheapest ticket in the deck, because the price IS the hook ("3p"). `total_prize_value` is not
// used: for many operators it is ticket price × cap, not what the prize is worth. Ties go to the
// cleaner photograph, then the later close (more runway for a viewer who sees the Reel tomorrow).
// Child-appeal prizes and prizes with no named operator are never heroes.
export function pickHeroes(draws, { riskOf = () => 1, count = 2 } = {}) {
  const ok = draws.filter((d) => operatorOf(d) && Number(d.ticket_price) > 0 && !CHILD_APPEAL.has(brandOf(titleOf(d))));
  const sorted = [...ok].sort((a, b) =>
    Number(a.ticket_price) - Number(b.ticket_price) || riskOf(a) - riskOf(b) || +new Date(b.draw_date) - +new Date(a.draw_date));
  // Two Reels a day should not both be the same operator's draws.
  const out = [];
  for (const d of sorted) {
    if (out.length >= count) break;
    if (out.some((h) => operatorOf(h) === operatorOf(d)) && sorted.length > count) continue;
    out.push(d);
  }
  for (const d of sorted) if (out.length < count && !out.includes(d)) out.push(d);
  return out;
}

// ── the hook (first frame, ≤ 6 words) ─────────────────────────────────────────────────────────
// Patterns scored with the ig-hook rubric (21 Oct): not-a-typo 22/25, price-contrast 21/25,
// identity 20/25, cash-choice 17/25. A pattern only applies where the data makes it TRUE.
export const HOOKS = {
  typo: (h) => (isPence(h.price) ? `not a typo. ${h.price}.` : null),
  contrast: (h) => (h.short ? `${h.price}. for ${withArticle(h.short)}.` : null),
  identity: (h) => (h.brand ? `${h.brand} people, look 👀` : null),
  cash: (h) => (h.cashAlt && h.short ? `${h.short} or ${shortMoney(h.cashAlt)} cash` : null),
};
const words = (s) => String(s).replace(/[^\p{L}\p{N}£.\s-]/gu, "").trim().split(/\s+/).filter(Boolean).length;

export function hookFor(d, date, { gate = () => [] } = {}) {
  const title = titleOf(d);
  const h = {
    price: priceLabel(d.ticket_price),
    short: shortTitle(title),
    brand: brandOf(title),
    cashAlt: cashExtras(d.grand_prize, d.title).alternative?.amount || null,
  };
  const order = Object.keys(HOOKS);
  const start = hashOf(`${d.slug}|${date}`) % order.length;
  for (let i = 0; i < order.length; i++) {
    const key = order[(start + i) % order.length];
    const line = HOOKS[key](h);
    if (!line || words(line) > 6 || gate(line).length) continue;
    return { key, line };
  }
  // nothing applied (a long name, a pound price, no brand): the price alone, which is always true
  return { key: "price", line: `${h.price} a ticket 👀` };
}

// ── the Reel model ────────────────────────────────────────────────────────────────────────────
// Every string carries the surface it is judged on: `own` = PDD's voice, `title` = the operator's
// prize name. `strip` removes an operator-owned name from the own-voice check.
export function reelModel({ d, sel, photo, now = new Date(), gate = () => [] }) {
  const title = titleOf(d);
  const price = priceLabel(d.ticket_price);
  const op = operatorOf(d);
  const hook = hookFor(d, sel.date, { gate });
  const cash = cashLine(cashExtras(d.grand_prize, d.title));
  return {
    slug: d.slug, hookKey: hook.key, photo, title, price,
    closes: closesParts(d.draw_date, now),
    tone: hashOf(d.slug) % 2 ? "pink" : "yellow",
    copy: {
      hook: { text: hook.line, surface: "own", strip: hook.key === "contrast" || hook.key === "cash" ? title : null },
      price: { text: price, surface: "own" },
      lead: { text: `for ${withArticle(title)}`, surface: "own", strip: title },
      title: { text: title, surface: "title" },
      cash: cash ? { text: cash, surface: "own" } : null,
      closesLabel: { text: "draw closes", surface: "own" },
      operator: { text: `via ${op}`, surface: "own", strip: op },
      more: { text: "loads more draws on 👇", surface: "own" },
      site: { text: SITE, surface: "own" },
      fine: { text: FINE_PRINT, surface: "own" },
    },
  };
}

export function reelStrings(m) {
  return Object.entries(m.copy).filter(([, v]) => v?.text).map(([field, v]) =>
    [field, v.strip ? v.text.replace(v.strip, "").trim() : v.text, v.surface === "title" ? "title" : "asset"]);
}

// ── the caption ───────────────────────────────────────────────────────────────────────────────
// Line 1 repeats the hook's fact as a sentence (the caption preview is two lines). The operator is
// named on the prize line (the 4 Sep impersonation lesson). The "one for the X lot" line points the
// post at a kind of person without asking anyone to share, tag or send: Meta's engagement-bait
// rules target the ask, and the FB Page was warned on 28 Jun. No em dashes.
export const INDEPENDENCE = "We list draws. We run none. This one is the operator's own.";
export const TERMS = "Age limits and free-entry routes: in the operator's own terms.";

export function reelCaption({ sel, m, d, now = new Date(), adLabel = false }) {
  const brand = brandOf(m.title);
  const head = `${m.price} for ${withArticle(m.title)} 👀`;
  const prize = [m.title, m.price, `ends ${closesParts(d.draw_date, now).join(" ")}`, `via ${operatorOf(d)}`].join(" · ");
  const cash = m.copy.cash ? m.copy.cash.text : null;
  const who = brand ? `one for the ${brand} lot` : null;
  const tags = [...GLOBAL.fixedHashtags, ...catCfg(sel.slug).hashtags].join(" ");
  return [
    (adLabel ? "Ad · " : "") + head,
    "",
    prize,
    cash,
    who,
    "",
    `more ${wordsFor(sel.slug).noun} closing soon on ${SITE}, link in bio`,
    "",
    INDEPENDENCE,
    TERMS,
    "",
    tags,
  ].filter((l) => l !== null).join("\n");
}
