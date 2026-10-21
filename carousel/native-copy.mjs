// carousel/native-copy.mjs — the WORDS of the native deck (redesign of 2026-10-11).
//
// The Sep-18 deck read like a data desk: a masthead, "TICKET CAP 299,999", a 2,095-dot grid and
// three lines of terms on every frame. The owner rejected it as too professional for people
// scrolling Instagram. The native deck looks like a person posted it: the prize photo, white
// Stories-style bubbles, an Instagram "Strong" price sticker, a countdown-style card and a
// location-style pill naming whose draw it is.
//
// Pure — no browser, no network — so every string the deck can emit is testable offline and goes
// through compliance.checkUnit before a pixel renders. Three rules shape the words:
//   1. No second person on a frame. "5 cars YOU can enter" is class A (L2.secondPerson).
//   2. No clock times ("9pm" is an americanTells hit, and a printed closing time asserts a
//      response deadline). The countdown card prints the day, never the hour.
//   3. Every slide names the operator. Meta suspended the Page on 4 Sep 2026 for impersonation
//      after captions offered prizes without saying whose draw they were (see caption.mjs).
import { cleanTitle, priceLabel, cashExtras, shortMoney, LDN } from "./format.mjs";
import { GLOBAL, catCfg } from "./config.mjs";

export const SITE = "prizedrawsdaily.co.uk";

// Noun + cover emoji per category. "motors", not "cars": car-draws also holds motorbikes, and
// "5 cars" over a deck with a Ducati on it is a false count.
export const CATEGORY_WORDS = {
  "car-draws": { noun: "motors", emoji: "🔥" },
  "cash-prizes": { noun: "cash prizes", emoji: "💷" },
  "house-draws": { noun: "homes", emoji: "🏡" },
  "tech-giveaways": { noun: "tech prizes", emoji: "📱" },
  "luxury": { noun: "luxury prizes", emoji: "✨" },
  "collectibles": { noun: "collectibles", emoji: "🃏" },
  "sports-outdoors": { noun: "sports & outdoor prizes", emoji: "⛳" },
  "home-garden": { noun: "home & garden prizes", emoji: "🌿" },
};
export const wordsFor = (slug) => CATEGORY_WORDS[slug] || { noun: "prizes", emoji: "🔥" };

// The flavour line under a hook. Light UK register, no claims, no figures, no second person.
export const FLAVOUR = ["uk be wild 😭", "that's mad 😳", "say less 👀", "lemme in 🙋", "not even joking 🤯", "oh it's on 😤"];
export const STICKER_EMOJI = ["👀", "🔥", "🤯", "😳", "💥"];
// Not a question. §10.6 predicate 3 allows a "?" only where two verified figures carry the answer,
// which is how "which would you pick?" was ruled out before — an answer that lives only in the
// reader is an engagement ask. A save prompt is useful (the closing days ARE on the slides) and
// saves are a signal Instagram weighs.
export const PROMPT = "save this for later 📌";
export const PROMPT_FIELD = "closing days are on each slide 👀";
export const FINE_PRINT = "We list draws, we don't run them. Age limits, T&Cs & free-entry routes: on each operator's site.";

// Deterministic picks: the same draw gets the same flavour on a rebuild, so a QA re-render after a
// photo swap does not reshuffle the words under the reviewer.
export function hashOf(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
}
const pick = (arr, key) => arr[hashOf(key) % arr.length];

// "a BMW M4", "an Audi RS3", "an M4", "an Xbox"; nothing for plurals, numbered or joint prizes.
export function withArticle(title) {
  const t = String(title).trim();
  const first = t.split(/\s+/)[0] || "";
  const last = t.split(/\s+/).pop() || "";
  if (/^(?:(?:a|an|the|your)\b|\d)/i.test(t) || /\s(&|and|\+)\s/i.test(t)) return t;
  if (/[a-z]s$/.test(last) && !/(ss|us|is|series|plus|pass|express)$/i.test(last)) return t;
  // An initialism or a model code is read letter by letter: "an M4", "an RS3", "an S1000RR".
  const spelled = /^[A-Z]{1,4}\d*$|^[A-Z]\d/.test(first);
  const vowelSound = spelled ? /^[AEFHILMNORSX]/.test(first)
    : /^[aeiou]/i.test(first) && !/^(uni|use|usa|eu|one)/i.test(first) || /^x/i.test(first);
  return `${vowelSound ? "an" : "a"} ${t}`;
}

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
export const CHILD_APPEAL = new Set(["Pokémon", "LEGO", "Nintendo"]);

export function brandOf(title) {
  const t = ` ${String(title)} `.toLowerCase();
  return BRANDS.find((b) => t.includes(` ${b.toLowerCase()} `) || t.includes(` ${b.toLowerCase()}-`)) || null;
}

// "twenty. pence." — only for a pence price, where saying it out loud IS the joke.
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
export function spellPence(price) {
  const m = /^(\d{1,2})p$/.exec(String(price));
  if (!m) return null;
  const n = Number(m[1]);
  const words = n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  return `${words}. pence.`;
}

export function cashLine(ex) {
  const a = ex?.alternative, b = ex?.bonus;
  const alt = a && `${shortMoney(a.amount)} ${a.taxFree ? "tax-free " : ""}cash`;
  if (a && b) return `+ ${shortMoney(b.amount)} cash, or ${alt} instead 💷`;
  if (a) return `or ${alt} instead 💷`;
  if (b) return `+ ${shortMoney(b.amount)} cash thrown in 💷`;   // not "on top": `top` is a comparative to the gate
  return null;
}

// London calendar day only. "today"/"tomorrow", else ["wed", "23 sep"].
// Day and month names come from fixed lists, not the locale: ICU builds disagree ("23 Sep" on one
// runtime, "23 Sept" on another — CI caught it), and a card must read the same wherever it renders.
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const londonYmd = (x) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: LDN, year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(x).map((o) => [o.type, Number(o.value)]));
  return [p.year, p.month, p.day];
};
export function closesParts(iso, now = new Date()) {
  const [y, m, d] = londonYmd(new Date(iso));
  const [ny, nm, nd] = londonYmd(now);
  const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ny, nm - 1, nd)) / 86400000);
  if (diff <= 0) return ["today"];
  if (diff === 1) return ["tomorrow"];
  return [DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], `${d} ${MON[m - 1]}`];
}

const operatorOf = (d) => String(d.operators?.name || "").trim() || null;
const titleOf = (d) => cleanTitle(d.grand_prize || d.title);

// ── Claude-written overrides (out/COPY.json) ─────────────────────────────────────────────────
// The template bank is the floor. Claude may write fresher lines, but only for the FLAVOUR slots —
// the price, the cash, the closing day and the operator always come from the data. An override is
// refused (and the template line kept) if it is long, multi-line, or carries a figure that is not
// one of the figures that slide is allowed to state.
const FIGURE = /£?\d[\d,.]*\s*[pk]?/gi;
export function copyLineProblem(line, allowedFigures = []) {
  const s = String(line ?? "");
  if (!s.trim()) return "empty";
  if (s.length > 44) return `longer than 44 characters (${s.length})`;
  if (/\n/.test(s)) return "more than one line";
  if (/@/.test(s)) return "contains @ (a made-up handle can link to a stranger's account)";
  const ok = new Set(allowedFigures.map((f) => String(f).replace(/[\s,]/g, "").toLowerCase()));
  for (const f of s.match(FIGURE) || []) {
    if (!ok.has(f.replace(/[\s,]/g, "").toLowerCase())) return `figure "${f.trim()}" is not one this slide may state`;
  }
  return null;
}

// ── the deck model ───────────────────────────────────────────────────────────────────────────
// Each slide carries `copy`: the strings it renders, keyed by field, with the gate surface each is
// judged on — `own` (PDD's voice: the full predicate set) or `title` (the operator's prize name).
// `gate(line)` returns the wording-gate predicates a Claude-written line trips (build.mjs passes
// compliance.checkUnit + checkQuestionUnit with the run's facts); a tripped line is refused and the
// template line kept, so an override can never be the thing that fails a run.
// `riskOf(d)` is the collage score build.mjs already measured (0 clean … 2 poster). The cover and
// the end slide SHOWCASE photos, so they take the cleanest first; prize slides keep deck order.
export function nativeDeck({ sel, draws, photoOf = () => null, now = new Date(), copy = null, log = () => {}, gate = () => [], riskOf = () => 1 }) {
  const N = draws.length;
  const showcase = draws.map((d, i) => [d, i]).sort((a, b) => riskOf(a[0]) - riskOf(b[0]) || a[1] - b[1]).map(([d]) => d);
  const { noun, emoji } = wordsFor(sel.slug);
  const prices = draws.map((d) => Number(d.ticket_price)).filter((p) => p > 0);
  const fromPrice = prices.length ? priceLabel(Math.min(...prices)) : null;
  const latest = Math.max(...draws.map((d) => +new Date(d.draw_date)).filter(Number.isFinite));
  const thisWeek = Number.isFinite(latest) && latest - now.getTime() <= 7 * 86400e3;
  const useCopy = copy && (!copy.date || copy.date === sel.date) ? copy : null;
  if (copy && !useCopy) log(`  ⚠ COPY.json is for ${copy.date}, not today's selection — ignored`);

  const override = (line, allowed, where) => {
    if (line == null) return null;
    const p = copyLineProblem(line, allowed) || (gate(line).length ? `wording gate: ${gate(line).join(", ")}` : null);
    if (p) { log(`  ⚠ COPY.json ${where} refused: ${p} — keeping the template line`); return null; }
    return line;
  };

  const coverLine = override(useCopy?.cover, [N, fromPrice], "cover")
    || `${N} ${noun} up for grabs${thisWeek ? " this week" : ""}`;
  const cover = {
    type: "cover",
    photos: showcase.map((d) => photoOf(d)).filter(Boolean).slice(0, 3),
    emoji,
    copy: {
      line: { text: coverLine, surface: "own" },
      sticker: fromPrice ? { text: `from ${fromPrice}`, surface: "own" } : null,
      swipe: { text: "swipe 👉", surface: "own" },
    },
  };

  const prizes = draws.map((d, i) => {
    const title = titleOf(d);
    const price = priceLabel(d.ticket_price);
    const variant = i % 2 === 0 ? "price-first" : "title-first";
    const flavour = override(useCopy?.flavour?.[d.slug], [price], `flavour[${d.slug}]`)
      || (variant === "title-first" && spellPence(price)) || pick(FLAVOUR, `${d.slug}|${sel.date}`);
    const lead = variant === "price-first" ? `for ${withArticle(title)}` : `${withArticle(title)} for…`;
    return {
      type: "prize", slug: d.slug, variant,
      photo: photoOf(d),
      emoji: pick(STICKER_EMOJI, d.slug),
      closes: closesParts(d.draw_date, now),
      tone: variant === "price-first" ? "yellow" : "pink",
      title,
      copy: {
        // The lead line carries the operator's prize name inside PDD's own words, so it is judged
        // twice: the frame around the name on PDD's rules, the name itself on the title rules.
        lead: { text: lead, surface: "own", strip: title },
        title: { text: title, surface: "title" },
        price: { text: price, surface: "own" },
        flavour: { text: flavour, surface: "own" },
        cash: cashLine(cashExtras(d.grand_prize, d.title)) ? { text: cashLine(cashExtras(d.grand_prize, d.title)), surface: "own" } : null,
        closesLabel: { text: "draw closes", surface: "own" },
        operator: operatorOf(d) ? { text: `via ${operatorOf(d)}`, surface: "own", strip: operatorOf(d) } : null,
      },
    };
  });

  const end = {
    type: "end",
    photo: photoOf(showcase[0]),
    corners: showcase.slice(1, 3).map((d) => photoOf(d)).filter(Boolean),
    copy: {
      more: { text: "loads more draws on 👇", surface: "own" },
      site: { text: SITE, surface: "own" },
      prompt: { text: override(useCopy?.prompt, [], "prompt") || PROMPT, surface: "own" },
      field: { text: PROMPT_FIELD, surface: "own" },
      follow: { text: "follow for more 🔔", surface: "own" },
      fine: { text: FINE_PRINT, surface: "own" },
    },
  };
  return { cover, prizes, end, N, fromPrice, thisWeek };
}

// Every string a deck renders, flattened for the gate: [slideIndex, field, text, surface].
// `strip` removes an operator-owned name from PDD's own-voice check (it is checked on its own).
export function deckStrings(deck) {
  const out = [];
  const slides = [deck.cover, ...deck.prizes, deck.end];
  slides.forEach((s, i) => {
    for (const [field, v] of Object.entries(s.copy)) {
      if (!v?.text) continue;
      const text = v.strip ? v.text.replace(v.strip, "").trim() : v.text;
      out.push([i, field, text, v.surface === "title" ? "title" : "asset"]);
    }
  });
  return out;
}

// ── the caption ───────────────────────────────────────────────────────────────────────────────
// Short and scannable. Every prize line still names the operator (the impersonation lesson), and
// the independence line and the terms pointer travel with the caption because a caption is read
// without its images in notifications and shares.
// No em dash (21 Oct audit: one sat in every autopilot caption).
export const INDEPENDENCE = "We list draws. We run none. Each one above is the operator's own.";
export const TERMS = "Age limits and free-entry routes: in each operator's own terms.";

// The day a caption names, always as a date: a caption is read after the day it posts, and
// "ends tomorrow" read on Thursday about a Wednesday post is wrong (21 Oct audit).
export function captionDay(iso, now = new Date()) {
  const p = closesParts(iso, now);
  if (p[0] !== "tomorrow") return p.join(" ");
  const next = closesParts(iso, new Date(now.getTime() - 86400000));
  return next.join(" ");
}

// Any featured operator with a live affiliate link makes the post an ad (ASA/CAP: obviously
// identifiable). Read from the operator row the selection already carries.
export const isAd = (draws) => draws.some((d) => /^https?:\/\//.test(String(d.operators?.affiliate_url || "")));

// Line 1 is the caption preview, so it carries the most striking fact of the deck: the cheapest
// ticket and its prize, with its operator like every prize line (21 Oct audit: the old "5 motors up for grabs" opener never earned a save,
// and the best price-vs-prize gap sat on line 5). "save this for later" earned 0 saves in 46 posts,
// so it is gone; a "one for the X lot" line points the post at a kind of person without asking
// anyone to share, tag or send (Meta's engagement-bait rules target the ask).
export function nativeCaption({ sel, deck, draws, now = new Date() }) {
  const lead = [...draws].sort((a, b) => Number(a.ticket_price) - Number(b.ticket_price))[0];
  const { noun, emoji } = wordsFor(sel.slug);
  const head = lead
    ? `${priceLabel(lead.ticket_price)} for ${withArticle(titleOf(lead))}, via ${operatorOf(lead)} ${emoji}\n+ more ${noun} below, all closing soon`
    : `${deck.cover.copy.line.text} ${emoji}`;
  const lines = draws.map((d) => {
    const ex = cashExtras(d.grand_prize, d.title);
    const cash = ex.alternative ? ` (or ${shortMoney(ex.alternative.amount)} cash)` : "";
    return [`${titleOf(d)}${cash}`, priceLabel(d.ticket_price), `ends ${captionDay(d.draw_date, now)}`, operatorOf(d)]
      .filter(Boolean).join(" · ");
  });
  const brand = lead && brandOf(titleOf(lead));
  const who = brand && !CHILD_APPEAL.has(brand) ? `one for the ${brand} lot\n\n` : "";
  const tags = [...GLOBAL.fixedHashtags, ...catCfg(sel.slug).hashtags].join(" ");
  return `${isAd(draws) ? "Ad · " : ""}${head}\n\n${lines.join("\n")}\n\n${who}${INDEPENDENCE}\n${TERMS}\nlink in bio\n\n${tags}`;
}
