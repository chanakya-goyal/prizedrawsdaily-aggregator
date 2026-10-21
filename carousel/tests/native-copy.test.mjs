import { test, expect, describe } from "bun:test";
import {
  nativeDeck, deckStrings, nativeCaption, withArticle, spellPence, cashLine, closesParts,
  copyLineProblem, CATEGORY_WORDS, FLAVOUR, STICKER_EMOJI, PROMPT, PROMPT_FIELD, FINE_PRINT, INDEPENDENCE, TERMS,
} from "../native-copy.mjs";
import * as compliance from "../compliance.mjs";
import { ALL_SCENE_IDS } from "../scene.mjs";
import { GLOBAL } from "../config.mjs";

const NOW = new Date("2026-09-21T10:00:00+01:00");          // a Monday morning in London
const draw = (over = {}) => ({
  slug: "win-this-bmw-m4-and-3-000-or-30-000-tax-free-dream-car-giveaways-2",
  title: "Win This BMW M4 and £3,000 or £30,000 Tax-Free",
  grand_prize: "BMW M4 + £3,000 or £30,000 Tax-Free",
  ticket_price: 0.89, draw_date: "2026-09-23T21:00:00+01:00",
  operators: { name: "Dream Car Giveaways" },
  ...over,
});
const DRAWS = [
  draw(),
  draw({ slug: "tiguan", title: "Win This Volkswagen Tiguan R + £2,000 Cash!", grand_prize: "Volkswagen Tiguan R + £2,000 Cash", ticket_price: 0.2, draw_date: "2026-09-27T21:00:00+01:00", operators: { name: "7Days Performance" } }),
  draw({ slug: "civic", title: "Win This Honda Civic Type-R GT + £2,000 Cash!", grand_prize: "Honda Civic Type-R GT", ticket_price: 0.22, draw_date: "2026-09-24T21:00:00+01:00", operators: { name: "7Days Performance" } }),
  draw({ slug: "focus", title: "Win this Ford Focus RS", grand_prize: "Ford Focus RS", ticket_price: 0.99, draw_date: "2026-09-21T21:00:00+01:00", operators: { name: "The Car Competition" } }),
  draw({ slug: "silvia", title: "1995 Nissan Silvia S14 SR20DET", grand_prize: "1995 Nissan Silvia S14 SR20DET", ticket_price: 2.99, draw_date: "2026-09-22T21:00:00+01:00", operators: { name: "Storm Competitions " } }),
];
const SEL = { slug: "car-draws", date: "2026-09-21T09:00:00.000Z" };
const deckOf = (sel = SEL, draws = DRAWS, extra = {}) => nativeDeck({ sel, draws, now: NOW, photoOf: () => "data:x", ...extra });
const opts = { bannedPhrases: GLOBAL.bannedPhrases, facts: compliance.factsTable({ drawsRendered: 5, prices: ["89p", "20p", "22p", "99p", "£2.99"] }) };

describe("every string the native deck can emit passes the wording gate", () => {
  for (const slug of ALL_SCENE_IDS) {
    test(`${slug}: template copy is clean on PDD's own-voice rules`, () => {
      const deck = deckOf({ ...SEL, slug });
      for (const [i, field, text, surface] of deckStrings(deck)) {
        // the question rule too: a "?" needs two verified figures from different fact keys
        const hits = [...compliance.checkUnit(text, { ...opts, surface }), ...(surface === "asset" ? compliance.checkQuestionUnit(text, opts.facts) : [])];
        expect({ slide: i, field, text, hits }).toEqual({ slide: i, field, text, hits: [] });
      }
    });
  }
  test("every flavour line, sticker emoji and fixed line is clean on its own", () => {
    for (const s of [...FLAVOUR, ...STICKER_EMOJI, PROMPT, PROMPT_FIELD, FINE_PRINT, "swipe 👉", "follow for more 🔔", "loads more draws on 👇", "draw closes"]) {
      expect([...compliance.checkUnit(s, { ...opts, surface: "asset" }), ...compliance.checkQuestionUnit(s, opts.facts)]).toEqual([]);
    }
  });
  test("the caption is clean on the caption rules, sentence by sentence", () => {
    const deck = deckOf();
    const cap = nativeCaption({ sel: SEL, deck, draws: DRAWS });
    expect(compliance.checkUnit(cap, { ...opts, surface: "caption" })).toEqual([]);
    for (const sent of cap.split(/(?<=[.!?])\s+|\n+/)) expect(compliance.checkQuestionUnit(sent, opts.facts)).toEqual([]);
  });
});

describe("the deck says what the data says", () => {
  const deck = deckOf();
  test("cover counts what renders, and 'this week' only when every draw closes inside 7 days", () => {
    expect(deck.cover.copy.line.text).toBe("5 motors up for grabs this week");
    expect(deck.cover.copy.sticker.text).toBe("from 20p");
    const late = deckOf(SEL, [...DRAWS.slice(0, 4), draw({ slug: "late", draw_date: "2026-10-09T21:00:00+01:00" })]);
    expect(late.cover.copy.line.text).toBe("5 motors up for grabs");
  });
  test("a bonus reads 'thrown in', an alternative reads 'instead', and TAX-FREE only when stated", () => {
    const by = Object.fromEntries(deck.prizes.map((p) => [p.slug, p.copy.cash?.text ?? null]));
    expect(by.tiguan).toBe("+ £2k cash thrown in 💷");
    expect(by[DRAWS[0].slug]).toBe("+ £3k cash, or £30k tax-free cash instead 💷");
    expect(by.focus).toBeNull();
  });
  test("every prize slide names its operator, never as an @handle", () => {
    for (const p of deck.prizes) {
      expect(p.copy.operator.text).toMatch(/^via \S/);
      expect(p.copy.operator.text).not.toContain("@");
    }
    expect(deck.prizes.find((p) => p.slug === "silvia").copy.operator.text).toBe("via Storm Competitions");
  });
  test("closing day is a London calendar day and never a clock time", () => {
    expect(closesParts("2026-09-21T21:00:00+01:00", NOW)).toEqual(["today"]);
    expect(closesParts("2026-09-22T21:00:00+01:00", NOW)).toEqual(["tomorrow"]);
    expect(closesParts("2026-09-23T21:00:00+01:00", NOW)).toEqual(["wed", "23 sep"]);
    // 23:30 UTC on 30 Sep is already 1 Oct in London (BST) — the London calendar decides
    expect(closesParts("2026-09-30T23:30:00Z", NOW)).toEqual(["thu", "1 oct"]);
    expect(closesParts("2026-12-25T12:00:00Z", NOW)).toEqual(["fri", "25 dec"]);
    for (const p of deck.prizes) expect(p.closes.join(" ")).not.toMatch(/\d{1,2}(:\d\d)?\s*[ap]m/i);
  });
  test("price-first and title-first alternate, and pence prices are said out loud", () => {
    expect(deck.prizes.map((p) => p.variant)).toEqual(["price-first", "title-first", "price-first", "title-first", "price-first"]);
    expect(deck.prizes[1].copy.flavour.text).toBe("twenty. pence.");
    expect(deck.prizes[0].copy.lead.text).toBe("for a BMW M4");
  });
  test("cover and end slide showcase the cleanest photos first; prize slides keep deck order", () => {
    const risk = { tiguan: 0, civic: 0, focus: 2 };
    const d = deckOf(SEL, DRAWS, { photoOf: (x) => x.slug, riskOf: (x) => risk[x.slug] ?? 1 });
    expect(d.cover.photos).toEqual(["tiguan", "civic", DRAWS[0].slug]);
    expect(d.end.photo).toBe("tiguan");
    expect(d.prizes.map((p) => p.slug)).toEqual(DRAWS.map((x) => x.slug));
  });
  test("a rebuild says the same words (deterministic picks)", () => {
    expect(JSON.stringify(deckOf())).toBe(JSON.stringify(deckOf()));
  });
});

describe("helpers", () => {
  test("withArticle", () => {
    expect(withArticle("BMW M4")).toBe("a BMW M4");
    expect(withArticle("Audi RS3")).toBe("an Audi RS3");
    expect(withArticle("M4 Competition")).toBe("an M4 Competition");
    expect(withArticle("iPhone 17 Pro")).toBe("an iPhone 17 Pro");
    expect(withArticle("Xbox Series X")).toBe("an Xbox Series X");
    expect(withArticle("Honda Civic Type-R GT")).toBe("a Honda Civic Type-R GT");
    expect(withArticle("Uniqlo Voucher")).toBe("a Uniqlo Voucher");
    expect(withArticle("Pokémon Cards")).toBe("Pokémon Cards");
    expect(withArticle("1995 Nissan Silvia")).toBe("1995 Nissan Silvia");
    expect(withArticle("Porsche 718 & Defender 90")).toBe("Porsche 718 & Defender 90");
    expect(withArticle("Ford Focus RS")).toBe("a Ford Focus RS");
  });
  test("spellPence", () => {
    expect(spellPence("20p")).toBe("twenty. pence.");
    expect(spellPence("1p")).toBe("one. pence.");
    expect(spellPence("99p")).toBe("ninety-nine. pence.");
    expect(spellPence("£2.99")).toBeNull();
  });
  test("cashLine", () => {
    expect(cashLine({ alternative: null, bonus: null })).toBeNull();
    expect(cashLine({ alternative: { amount: 22500, taxFree: false }, bonus: null })).toBe("or £22.5k cash instead 💷");
  });
  test("every configured category has words", () => {
    for (const slug of ALL_SCENE_IDS) expect(CATEGORY_WORDS[slug]?.noun).toBeTruthy();
  });
});

describe("Claude-written overrides (COPY.json) are bounded", () => {
  test("a clean override is used", () => {
    const d = deckOf(SEL, DRAWS, { copy: { date: SEL.date, cover: "5 motors, all from 20p 👀", flavour: { tiguan: "it's actually 20p 😭" } } });
    expect(d.cover.copy.line.text).toBe("5 motors, all from 20p 👀");
    expect(d.prizes[1].copy.flavour.text).toBe("it's actually 20p 😭");
  });
  test("a line the wording gate refuses is refused here too, never failing the run", () => {
    const logs = [];
    const d = deckOf(SEL, DRAWS, { copy: { date: SEL.date, prompt: "which would you pick?" }, gate: (l) => compliance.checkQuestionUnit(l, opts.facts).map((h) => h.predicate), log: (m) => logs.push(m) });
    expect(d.end.copy.prompt.text).toBe(PROMPT);
    expect(logs[0]).toMatch(/wording gate/);
  });
  test("a figure the slide cannot evidence is refused and the template line kept", () => {
    const logs = [];
    const d = deckOf(SEL, DRAWS, { copy: { date: SEL.date, cover: "win £50,000 today", flavour: { tiguan: "only £5 a go 😭" } }, log: (m) => logs.push(m) });
    expect(d.cover.copy.line.text).toBe("5 motors up for grabs this week");
    expect(d.prizes[1].copy.flavour.text).toBe("twenty. pence.");
    expect(logs.length).toBe(2);
  });
  test("yesterday's COPY.json is ignored", () => {
    const d = deckOf(SEL, DRAWS, { copy: { date: "2026-09-20T09:00:00.000Z", cover: "5 motors 👀" } });
    expect(d.cover.copy.line.text).toBe("5 motors up for grabs this week");
  });
  test("copyLineProblem", () => {
    expect(copyLineProblem("say less 👀")).toBeNull();
    expect(copyLineProblem("ask @dreamcars")).toMatch(/@/);
    expect(copyLineProblem("x".repeat(45))).toMatch(/longer/);
    expect(copyLineProblem("only 89p 😳", ["89p"])).toBeNull();
    expect(copyLineProblem("only 79p 😳", ["89p"])).toMatch(/figure/);
  });
});

test("caption: one line per prize naming its operator, plus the independence line and terms", () => {
  const deck = deckOf();
  const cap = nativeCaption({ sel: SEL, deck, draws: DRAWS });
  for (const d of DRAWS) expect(cap).toContain(d.operators.name.trim());
  expect(cap).toContain(INDEPENDENCE);
  expect(cap).toContain(TERMS);
  const tags = cap.trim().split("\n").pop().split(" ");
  expect(tags.length).toBe(5);
});

test("caption line 1 leads with the cheapest ticket, dates every close, and drops the save ask (21 Oct audit)", async () => {
  const { captionDay, isAd } = await import("../native-copy.mjs");
  const deck = deckOf();
  const cap = nativeCaption({ sel: SEL, deck, draws: DRAWS, now: NOW });
  expect(cap.split("\n")[0]).toBe("20p for a Volkswagen Tiguan R, via 7Days Performance 🔥");
  expect(cap).not.toMatch(/save this/i);
  expect(cap).not.toMatch(/—/);
  expect(cap).not.toMatch(/\bends tomorrow\b/);
  expect(cap).toContain("one for the Volkswagen lot");
  expect(captionDay("2026-09-22T21:00:00+01:00", NOW)).toBe("tue 22 sep");
  expect(isAd(DRAWS)).toBe(false);
  const ad = DRAWS.map((d, i) => (i ? d : { ...d, operators: { ...d.operators, affiliate_url: "https://op.example/?ref=pdd" } }));
  expect(isAd(ad)).toBe(true);
  expect(nativeCaption({ sel: SEL, deck, draws: ad, now: NOW }).startsWith("Ad · ")).toBe(true);
});
