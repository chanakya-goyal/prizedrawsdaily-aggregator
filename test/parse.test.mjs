import { test, expect, describe } from "bun:test";
import {
  extractEntries, extractDate, inferCategory, extractPrice,
  parseJsonLd, findProductLd, pickTitleImage, load, textOf, fieldsFromHtml, normalizeUkDate,
  isGenericTitle, cleanPrizeLine, extractGrandPrize, extractPrizeSection,
} from "../lib/parse.mjs";

describe("extractEntries — veto-first, conservative", () => {
  const cases = [
    ["15000 tickets available", 15000],
    ["7,200 sold", null],
    ["3200 / 15000 sold", 15000],
    ["82% sold", null],
    ["max 5000 entries", 5000],
    ["only 250 remaining", null],
    ["win £15,000 cash", null],
    ["Total of 25,000 tickets in this draw", 25000],
    ["Just 999 entries", 999],
    ["tickets: 2000 sold of 8000", 8000],
    ["2000 sold of 8000", 8000],
    ["Tickets limited to: 12,500", 12500],
    ["a normal sentence with no numbers", null],
    ["50 entries left", null], // below plausibility floor AND vetoed
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" → ${expected}`, () => expect(extractEntries(input)).toBe(expected));
  }
  test("operator pattern override wins", () => {
    expect(extractEntries("there are 4321 spots in this comp", { entries: "(\\d+) spots" })).toBe(4321);
  });
});

describe("extractEntries — review regressions (remaining-count must not be a cap)", () => {
  const cases = [
    ["Hurry, only 800 entries left!", null],
    ["only 1,500 tickets remaining", null],
    ["just 300 entries to go", null],
    ["only 5000 tickets", 5000],          // a genuine cap (no sold/left nearby) still works
    ["from a maximum number of 1,999,999 entries", 1999999], // "maximum number of N" phrasing
    ["maximum of 25000 tickets", 25000],
    ["Visit Unit 4500 tickets sorting office", 4500], // tier-3 limitation, documented
  ];
  for (const [input, expected] of cases) test(`"${input}" → ${expected}`, () => expect(extractEntries(input)).toBe(expected));
});

describe("extractDate — review regressions (draw vs close, time placement)", () => {
  test("prefers DRAW date over CLOSE date", () =>
    expect(extractDate("Entry closes on 1st July 2026. The draw will take place 8th July 2026.")).toStartWith("2026-07-08"));
  test("falls back to close date when no draw label", () =>
    expect(extractDate("Competition closes 3rd July 2026.")).toStartWith("2026-07-03"));
  test("ignores an earlier cutoff time before the date", () =>
    expect(extractDate("Buy before 6pm. Draw 9pm on 20th July 2026.")).toBe("2026-07-20T21:00:00+01:00"));
  test("ignores 'order by' cutoff, uses draw time after date", () =>
    expect(extractDate("Order by 5pm. Draw will take place at 9pm on 20th July 2026.")).toBe("2026-07-20T21:00:00+01:00"));
  test("still handles draw time stated before the date", () =>
    expect(extractDate("drawn live 9pm on 17-06-2026")).toBe("2026-06-17T21:00:00+01:00"));
  test("rejects an out-of-range year lifted from a product code", () => {
    expect(extractDate("ref 1256-06-28 widget")).toBeNull();
    expect(extractDate("SKU 6835-06-28")).toBeNull();
  });
});

describe("parseJsonLd — review regression (@graph as object must not throw)", () => {
  test("object @graph", () => {
    const $ = load('<script type="application/ld+json">{"@graph":{"@type":"Product","name":"X","offers":{"price":"3"}}}</script>');
    const ld = findProductLd(parseJsonLd($));
    expect(ld?.name).toBe("X");
  });
  test("malformed json is skipped, not thrown", () => {
    const $ = load('<script type="application/ld+json">{bad json</script>');
    expect(() => parseJsonLd($)).not.toThrow();
  });
});

describe("extractDate — UK formats → ISO", () => {
  test("labelled long date", () => expect(extractDate("Draw date: 1st July 2026")).toStartWith("2026-07-01"));
  test("time before date", () => expect(extractDate("drawn live 9pm on 17-06-2026")).toBe("2026-06-17T21:00:00+01:00"));
  test("iso date defaults 20:00", () => expect(extractDate("2026-07-01")).toBe("2026-07-01T20:00:00+01:00"));
  test("numeric uk day-first + pm", () => expect(extractDate("draw will take place on 23/06/2026 at 9pm")).toBe("2026-06-23T21:00:00+01:00"));
  test("24h time", () => expect(extractDate("Drawn live at 21:00 on 5th August 2026")).toBe("2026-08-05T21:00:00+01:00"));
  test("winter date uses GMT offset", () => expect(extractDate("2026-01-15")).toEndWith("+00:00"));
  test("no date → null", () => expect(extractDate("no dates here")).toBeNull());
});

describe("inferCategory", () => {
  test("car", () => expect(inferCategory({ title: "Win a BMW M4" })).toBe("car-draws"));
  test("house", () => expect(inferCategory({ title: "Win this 3-bed house" })).toBe("house-draws"));
  test("tech", () => expect(inferCategory({ title: "iPhone 16 Pro giveaway" })).toBe("tech-giveaways"));
  test("fallback cash", () => expect(inferCategory({ title: "Mystery prize" })).toBe("cash-prizes"));
});

describe("extractPrice", () => {
  test("structured wins", () => expect(extractPrice({ structuredPrice: 1.5, text: "£99" })).toBe(1.5));
  test("ld fallback", () => expect(extractPrice({ ld: { price: 2.49 }, text: "" })).toBe(2.49));
  test("regex fallback", () => expect(extractPrice({ text: "Tickets are £4.99 each" })).toBe(4.99));
  test("none", () => expect(extractPrice({ text: "free" })).toBeNull());
  test("labelled per-ticket beats the cash prize", () =>
    expect(extractPrice({ text: "WIN A LAMBO + £2,000 CASH! Entries only £0.35 MAX ENTRIES 599,999" })).toBe(0.35));
  test("cash alternative not mistaken for ticket price", () =>
    expect(extractPrice({ text: "Cash Alternative: £10,000 Entries only £0.05" })).toBe(0.05));
  test("£X per ticket", () => expect(extractPrice({ text: "just £3 per ticket" })).toBe(3));
  // Multi-ticket quantity selector default → divide the bundle total back to the unit price.
  test("selected-quantity total (X 25 TICKETS £9.75) → unit", () => expect(extractPrice({ text: "X 25 TICKETS\n£9.75\nADD TO CART" })).toBe(0.39));
  test("bundle default qty 100 (X 100 TICKETS £20.00) → unit", () => expect(extractPrice({ text: "X 100 TICKETS £20.00" })).toBe(0.2));
  test("'£10 for 20 tickets' reverse form → unit", () => expect(extractPrice({ text: "£10 for 20 tickets" })).toBe(0.5));
  test("single ticket default (X 1 TICKETS £0.39) unaffected", () => expect(extractPrice({ text: "X 1 TICKETS £0.39" })).toBe(0.39));
});

describe("JSON-LD + title/image", () => {
  const html = `<html><head>
    <meta property="og:title" content="OG Title">
    <meta property="og:image" content="https://cdn.test/og.jpg">
    <script type="application/ld+json">{"@type":"Product","name":"Win a Tesla Model 3","image":"https://cdn.test/p.jpg","offers":{"price":"2.99"}}</script>
    </head><body><h1>Heading</h1></body></html>`;
  const $ = load(html);
  const ld = findProductLd(parseJsonLd($));
  test("ld product parsed", () => { expect(ld.name).toBe("Win a Tesla Model 3"); expect(ld.price).toBe(2.99); });
  test("title prefers ld", () => expect(pickTitleImage($, ld, "https://cdn.test").title).toBe("Win a Tesla Model 3"));
  test("image prefers ld", () => expect(pickTitleImage($, ld, "https://cdn.test").image_url).toBe("https://cdn.test/p.jpg"));
});

describe("fieldsFromHtml end-to-end (synthetic woo-style page)", () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Product","name":"Win a Range Rover Sport","image":"https://cdn.test/rr.jpg","offers":{"price":"4.99"}}</script>
    </head><body>
      <h1>Win a Range Rover Sport</h1>
      <p>Only 20,000 tickets available in this competition.</p>
      <p>Live draw will take place on 30th July 2026 at 8pm.</p>
    </body></html>`;
  const d = fieldsFromHtml({ html, url: "https://op.test/product/range-rover", op: { base: "https://op.test" } });
  test("title", () => expect(d.title).toBe("Win a Range Rover Sport"));
  test("price", () => expect(d.ticket_price).toBe(4.99));
  test("entries", () => expect(d.total_entries).toBe(20000));
  test("date", () => expect(d.draw_date).toBe("2026-07-30T20:00:00+01:00"));
  test("category inferred", () => expect(d.category).toBe("car-draws"));
  test("image", () => expect(d.image_url).toBe("https://cdn.test/rr.jpg"));
  test("entry_url stamped", () => expect(d.entry_url).toBe("https://op.test/product/range-rover"));
});

describe("isGenericTitle — only slogans that name no prize are generic", () => {
  const op = "Daydream Draws";
  const generic = [
    ["DAYDREAM DAILY DRAW – PRIZE EVERYTIME", op],
    ["Site Credit Madness", "Some Comps"],
    ["Mystery Prize", "Some Comps"],
    ["Daily Instant Win", "Some Comps"],
    ["Spin the Wheel", "Some Comps"],
    ["Daydream Draws", op],          // title is just the operator name
    ["Weekly Prize Draw", "Lucky Co"],
  ];
  const specific = [
    ["Win a BMW M4", "Cars Co"],
    ["£200 Tax Free Cash", op],                                   // a £ amount is a real prize
    ["RATTAN DINING SET", "UKCC"],                                // ordinary product, no slogan
    ["ONLY FANS SHARK FLEX BREEZE INSTANT WIN", op],             // names a prize despite "instant win"
    ["£50 RANDOM TICKET BUNDLE + INSTANT WINS #7", op],
    ["WIN A £125 MUDDYNESS CHILDREN'S OUTDOOR KITCHEN", op],
    ["Rolex DateJust 41", "Lux Co"],
  ];
  for (const [t, n] of generic) test(`generic: "${t}"`, () => expect(isGenericTitle(t, n)).toBe(true));
  for (const [t, n] of specific) test(`specific: "${t}"`, () => expect(isGenericTitle(t, n)).toBe(false));
});

describe("cleanPrizeLine — first headline, boilerplate trimmed", () => {
  test("daydream short_description → prize headline only", () =>
    expect(cleanPrizeLine("£50 Credit End Prize + Every Entry With A Prize Instantly Guaranteed draw regardless of sales – we never rollover here! Auto Draw Competition at the time of the competition end"))
      .toBe("£50 Credit End Prize + Every Entry With A Prize Instantly"));
  test("trims trailing full stop", () => expect(cleanPrizeLine("A brand new iPhone 16 Pro Max.")).toBe("A brand new iPhone 16 Pro Max"));
  test("null in → null out", () => expect(cleanPrizeLine(null)).toBeNull());
  test("too short → null", () => expect(cleanPrizeLine("£")).toBeNull());
  test("caps very long copy", () => expect(cleanPrizeLine("x".repeat(300)).length).toBeLessThanOrEqual(160));
});

describe("extractGrandPrize — generic title upgraded, specific title kept", () => {
  test("generic title + API short_description → real prize (source api)", () => {
    const r = extractGrandPrize({
      title: "DAYDREAM DAILY DRAW – PRIZE EVERYTIME",
      prizeText: "£50 Credit End Prize + Every Entry With A Prize Instantly Guaranteed draw regardless.",
      opName: "Daydream Draws",
    });
    expect(r.value).toBe("£50 Credit End Prize + Every Entry With A Prize Instantly");
    expect(r.source).toBe("api");
  });
  test("specific title is kept even when a long description exists", () => {
    const r = extractGrandPrize({
      title: "Win a BMW M4",
      prizeText: "The lucky winner drives away in a brand new BMW M4 Competition worth over £85,000.",
      opName: "Cars Co",
    });
    expect(r).toEqual({ value: "Win a BMW M4", source: "title" });
  });
  test("generic title falls back to JSON-LD description when no API text", () => {
    const r = extractGrandPrize({ title: "Mystery Prize", ld: { description: "A brand new iPhone 16 Pro Max." }, opName: "X Comps" });
    expect(r.value).toBe("A brand new iPhone 16 Pro Max");
    expect(r.source).toBe("jsonld");
  });
  test("nothing better than a generic title → keep the title", () =>
    expect(extractGrandPrize({ title: "Mystery Prize", opName: "X Comps" })).toEqual({ value: "Mystery Prize", source: "title" }));
  test("a candidate that is itself a pure slogan is rejected", () => {
    const r = extractGrandPrize({ title: "Daily Draw", prizeText: "Win every time in this prize draw!", opName: "X" });
    expect(r).toEqual({ value: "Daily Draw", source: "title" });
  });
});

describe("extractPrizeSection — 'Prize Description' panel (incl. accordion)", () => {
  test("Bootstrap accordion: heading targets a collapse panel by id", () => {
    const $ = load(`<div>
      <h2 class="mb-0"><button data-bs-target="#p1" aria-controls="p1">Prize Description</button></h2>
      <div id="p1"><p>£50 Credit End Prize + Every Entry With A Prize Instantly</p><p>Guaranteed draw regardless.</p></div>
    </div>`);
    expect(extractPrizeSection($)).toBe("£50 Credit End Prize + Every Entry With A Prize Instantly");
  });
  test("plain heading followed by a paragraph", () => {
    const $ = load(`<div><h3>What you could win</h3><p>A 7-night luxury Maldives holiday for two.</p></div>`);
    expect(extractPrizeSection($)).toBe("A 7-night luxury Maldives holiday for two");
  });
});

describe("fieldsFromHtml — grand_prize end-to-end (the reported Daydream bug)", () => {
  const base = "https://daydreamdraws.co.uk";
  const html = `<html><head><meta property="og:title" content="DAYDREAM DAILY DRAW – PRIZE EVERYTIME"></head>
    <body><h1>DAYDREAM DAILY DRAW – PRIZE EVERYTIME</h1>
    <p>Only 500 tickets available.</p><p>Draw will take place on 28th July 2026 at 8pm.</p></body></html>`;
  test("generic slogan title → real prize from API short_description", () => {
    const d = fieldsFromHtml({
      html, url: `${base}/competition/daydream-daily-draw-prize-everytime`,
      op: { base, name: "Daydream Draws" },
      knownTitle: "DAYDREAM DAILY DRAW – PRIZE EVERYTIME", knownImage: `${base}/x.jpg`, knownPrice: 1.99,
      prizeText: "£50 Credit End Prize + Every Entry With A Prize Instantly Guaranteed draw regardless. Auto Draw Competition",
    });
    expect(d.title).toBe("DAYDREAM DAILY DRAW – PRIZE EVERYTIME"); // title unchanged
    expect(d.grand_prize).toBe("£50 Credit End Prize + Every Entry With A Prize Instantly");
    expect(d.grand_prize_source).toBe("api");
  });
  test("specific title is NOT overwritten by its rambling short_description", () => {
    const d = fieldsFromHtml({
      html, url: `${base}/competition/muddyness-kitchen`,
      op: { base, name: "Daydream Draws" },
      knownTitle: "WIN A £125 MUDDYNESS CHILDREN'S OUTDOOR KITCHEN", knownImage: `${base}/m.jpg`, knownPrice: 0.99,
      prizeText: "DAYDREAM DRAWS LOVES LOCAL. This time we shine the spotlight on Muddyness, a fantastic local business...",
    });
    expect(d.grand_prize).toBe("WIN A £125 MUDDYNESS CHILDREN'S OUTDOOR KITCHEN");
    expect(d.grand_prize_source).toBe("title");
  });
});

describe("normalizeUkDate", () => {
  test("date-only gets 20:00", () => expect(normalizeUkDate("2026-07-01")).toBe("2026-07-01T20:00:00+01:00"));
  test("passes through nullish", () => expect(normalizeUkDate(null)).toBeNull());
});

describe("textOf strips markup", () => {
  test("removes scripts/tags", () => expect(textOf("<script>x</script><p>Hello&nbsp;world</p>")).toBe("Hello world"));
});
