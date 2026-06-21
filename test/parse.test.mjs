import { test, expect, describe } from "bun:test";
import {
  extractEntries, extractDate, inferCategory, extractPrice,
  parseJsonLd, findProductLd, pickTitleImage, load, textOf, fieldsFromHtml, normalizeUkDate,
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

describe("normalizeUkDate", () => {
  test("date-only gets 20:00", () => expect(normalizeUkDate("2026-07-01")).toBe("2026-07-01T20:00:00+01:00"));
  test("passes through nullish", () => expect(normalizeUkDate(null)).toBeNull());
});

describe("textOf strips markup", () => {
  test("removes scripts/tags", () => expect(textOf("<script>x</script><p>Hello&nbsp;world</p>")).toBe("Hello world"));
});
