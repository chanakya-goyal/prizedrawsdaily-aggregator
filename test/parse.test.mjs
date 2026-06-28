import { test, expect, describe } from "bun:test";
import {
  extractEntries, extractDate, inferCategory, extractPrice, mapOperatorCategory,
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
    ["Total Entries: 5000", 5000],        // WooCommerce-Lottery labelled form (keyword:count)
    ["Total Tickets: 2,500", 2500],
    ["Max Tickets - 1000", 1000],
    ["Total number of tickets: 7500", 7500],
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
    ["57200 Max Tickets. 1500 Tickets Max Per Person", 57200], // total beats per-person cap
    ["1500 tickets max per person", null], // a per-person cap is NOT the competition total
    ["Maximum 1295 tickets per person. 12495 tickets available", 12495],
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
  // expanded merchandise coverage — previously these all fell to the cash-prizes fallback and
  // were then draft-held by fieldFlags for "category may not match prize".
  test("appliance → tech", () => expect(inferCategory({ title: "Eufy Robot Vacuum Cleaner And Mop" })).toBe("tech-giveaways"));
  test("dyson → tech", () => expect(inferCategory({ title: "Win a Dyson V15 Detect" })).toBe("tech-giveaways"));
  test("air fryer → tech", () => expect(inferCategory({ title: "Ninja Air Fryer Bundle" })).toBe("tech-giveaways"));
  test("hot tub → luxury", () => expect(inferCategory({ title: "Lay-Z-Spa Miami Hot Tub" })).toBe("luxury"));
  test("apple watch → tech not luxury", () => expect(inferCategory({ title: "Apple Watch Series 10" })).toBe("tech-giveaways"));
  test("rolex still luxury", () => expect(inferCategory({ title: "Win a Rolex Submariner" })).toBe("luxury"));
  test("gift card → cash", () => expect(inferCategory({ title: "£200 Food Gift Card" })).toBe("cash-prizes"));
  test("lego stays collectibles (before car)", () => expect(inferCategory({ title: "LEGO Technic Ferrari Daytona" })).toBe("collectibles"));
  test("Pikachu Van Gogh → collectibles, not car (the 'van' bug)", () => expect(inferCategory({ title: "ACE 10 PIKACHU VAN GOGH!" })).toBe("collectibles"));
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

describe("fieldsFromHtml — WooCommerce-Lottery plugin (labelled entries + data-enddate)", () => {
  // These operators (Collie, Easy Living, Hot Comps, Tartan, The Prize Lab) render the count
  // as "Total Entries: N" and put the close date in a data-* attr — previously both scraped null.
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Product","name":"Win £10,000 Cash","image":"https://cdn.test/cash.jpg","offers":{"price":"2.49"}}</script>
    </head><body>
      <h1>Win £10,000 Cash</h1>
      <div class="lottery-progress total-entries">Total Entries: 5000</div>
      <span class="draw-countdown" data-enddate="2026-07-15T20:00:00"></span>
    </body></html>`;
  const d = fieldsFromHtml({ html, url: "https://op.test/product/win-10k", op: { base: "https://op.test" } });
  test("entries from labelled 'Total Entries: N'", () => expect(d.total_entries).toBe(5000));
  test("date from data-enddate attribute", () => expect(d.draw_date).toStartWith("2026-07-15"));
  test("epoch-millis data-enddate also parses", () => {
    const h = `<html><body><h1>Win a Watch</h1><i data-end-date="1784145600000"></i></body></html>`;
    const r = fieldsFromHtml({ html: h, url: "https://op.test/p/watch", op: { base: "https://op.test" } });
    expect(r.draw_date).toStartWith("2026-07-15");
  });
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
  test("tab-nav label sibling ('Rules') is rejected, not returned as the prize (bigbeastie regression)", () => {
    const $ = load(`<div class="product-tabs"><ul>
      <li><a>Prize Description</a></li><li><a>Rules</a></li><li><a>FAQs</a></li>
    </ul></div>`);
    expect(extractPrizeSection($)).toBeNull();
  });
});

describe("extractGrandPrize — never returns section-label junk", () => {
  test("generic title + only a 'Rules' tab label available → keep the title", () => {
    const $ = load(`<div class="product-tabs"><ul><li><a>Prize Description</a></li><li><a>Rules</a></li></ul></div>`);
    const r = extractGrandPrize({ title: "3 x Main Winners + Instant Wins", $, opName: "Big Beastie Competitions" });
    expect(r).toEqual({ value: "3 x Main Winners + Instant Wins", source: "title" });
  });
  test("T&C / eligibility prose in a prize panel is NOT the prize (gaming-giveaways bug)", () => {
    const $ = load(`<div class="prize-description"><h3>Prize Description</h3><div>This competition is open to UK residents aged 18 or over.You can enter this competition up to 112,000 times.This competition will close at 11:59 pm on July 10th.</div></div>`);
    const r = extractGrandPrize({ title: "1p Gaming Comp + Instant Wins #6", $, opName: "Gaming Giveaways" });
    expect(r.source).toBe("title");
    expect(r.value).toBe("1p Gaming Comp + Instant Wins #6");
  });
  test("jsonld T&C prose is rejected, falls through", () => {
    const r = extractGrandPrize({ title: "Mega Daily Draw", ld: { description: "Open to UK residents aged 18 or over. Drawn live on Facebook." }, opName: "X Comps" });
    expect(r.value).not.toMatch(/residents|aged 18/i);
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

// ---- reported-bug regressions (2026-06-28): entries, category, grand_prize on real draws ----

describe("extractEntries — strict mode returns ONLY a labelled cap", () => {
  test("labelled max survives strict", () => expect(extractEntries("max 5000 entries", null, { strict: true })).toBe(5000));
  test("WooLottery 'Total Entries: N' survives strict", () => expect(extractEntries("Total Entries: 5000", null, { strict: true })).toBe(5000));
  test("progress bar is dropped in strict (no neighbour-comp leak)", () => expect(extractEntries("3200 / 15000 sold", null, { strict: true })).toBeNull());
  test("bare 'N tickets' is dropped in strict", () => expect(extractEntries("14,993 Tickets", null, { strict: true })).toBeNull());
  test("operator override still wins in strict", () => expect(extractEntries("there are 4321 spots", { entries: "(\\d+) spots" }, { strict: true })).toBe(4321));
});

describe("extractEntries — Podium 'MAX N ENTRIES' trap (real total is the progress-bar TOTAL)", () => {
  // The banner says "MAX 15000 ENTRIES" but the live bar says "SOLD: 536 TOTAL: 66000" — 66000 is
  // the real cap. The operator pattern must beat the misleading tier-1 "MAX N ENTRIES".
  const podiumPat = { entries: "TOTAL:\\s*([\\d,]{3,})" };
  test("op pattern reads the bar TOTAL, not MAX", () =>
    expect(extractEntries("MAX 15000 ENTRIES SOLD: 536 TOTAL: 66000", podiumPat)).toBe(66000));
  test("second Podium draw (30000)", () =>
    expect(extractEntries("MAX 7500 ENTRIES SOLD: 284 TOTAL: 30000", podiumPat)).toBe(30000));
});

describe("mapOperatorCategory — operator's own taxonomy wins", () => {
  test("Warhammer woo category → collectibles", () => expect(mapOperatorCategory(["Auto Draw", "Warhammer"])).toBe("collectibles"));
  test("Trading Cards → collectibles", () => expect(mapOperatorCategory(["Trading Cards"])).toBe("collectibles"));
  test("Lego → collectibles", () => expect(mapOperatorCategory(["Lego"])).toBe("collectibles"));
  test("Tech → tech-giveaways", () => expect(mapOperatorCategory(["Tech"])).toBe("tech-giveaways"));
  test("generic labels map to nothing (fall back to keyword guess)", () => {
    expect(mapOperatorCategory(["Auto Draw"])).toBeNull();
    expect(mapOperatorCategory(["Live Draws", "Competitions"])).toBeNull();
    expect(mapOperatorCategory([])).toBeNull();
    expect(mapOperatorCategory(undefined)).toBeNull();
  });
});

describe("inferCategory — Warhammer factions (no literal 'warhammer' in the title)", () => {
  test("Astra Militarum → collectibles", () => expect(inferCategory({ title: "Astra Militarum: Bundle #6" })).toBe("collectibles"));
  test("Tyranids battleforce → collectibles", () => expect(inferCategory({ title: "Tyranids: Battleforce" })).toBe("collectibles"));
  test("Horus Heresy → collectibles", () => expect(inferCategory({ title: "The Horus Heresy: Bundle #9" })).toBe("collectibles"));
  test("Disney Lorcana → collectibles", () => expect(inferCategory({ title: "Disney Lorcana: Wilds Bundle #2" })).toBe("collectibles"));
  // "40k" must NOT be a collectibles keyword — it collides with "£40k" cash prizes.
  test("£40k cash is cash, not collectibles", () => expect(inferCategory({ title: "Win £40k Tax Free Cash" })).toBe("cash-prizes"));
  test("£40,000 cash stays cash", () => expect(inferCategory({ title: "£40,000", grand_prize: "£40,000 cash" })).toBe("cash-prizes"));
});

describe("fieldsFromHtml — operator category only overrides a title signal when specific", () => {
  const mk = (title, apiCategories) => fieldsFromHtml({
    html: `<html><body><h1>${title}</h1></body></html>`, url: "https://op.test/competition/x",
    op: { base: "https://op.test", name: "Op" }, knownTitle: title, knownImage: "https://cdn.test/x.jpg",
    descriptionText: title, apiCategories, apiStock: 5000,
  });
  test("a car draw tagged only the generic 'Instant Wins' bucket stays a car draw", () =>
    expect(mk("Win a BMW M4 Competition", ["Instant Wins"]).category).toBe("car-draws"));
  test("a specific operator category (Warhammer) still wins over a non-matching title", () =>
    expect(mk("Bundle #6", ["Auto Draw", "Warhammer"]).category).toBe("collectibles"));
  test("generic cash title + generic cash bucket → cash", () =>
    expect(mk("Mystery Instant Win", ["Instant Wins"]).category).toBe("cash-prizes"));
});

describe("extractGrandPrize — reject operator lifetime/marketing stats", () => {
  test("'given away over £500,000 in prizes' is NOT this draw's prize", () => {
    const r = extractGrandPrize({
      title: "Every Ticket Wins!",
      prizeText: "Become our next big winner - we have given away over £500,000 in prizes!",
      opName: "Podium Prize",
    });
    expect(r.source).toBe("title");
    expect(r.value).toBe("Every Ticket Wins!");
  });
  test("og 'over £250,000 paid out' rejected too", () => {
    const $ = load(`<html><head><meta property="og:description" content="We have paid out over £250,000 to lucky winners!"></head><body></body></html>`);
    const r = extractGrandPrize({ title: "Mega Draw", $, opName: "X Comps" });
    expect(r.value).not.toMatch(/£250,000|paid out/i);
  });
});

describe("fieldsFromHtml — woo with API stock + categories (BigBeastie / You Could Win bugs)", () => {
  const op = { base: "https://youcouldwin.co.uk", name: "You Could Win" };
  test("no labelled cap on page → API stock count is the entries; Woo category sets collectibles", () => {
    const html = `<html><body><h1>Astra Militarum: Bundle #6</h1>
      <p>Bundle Includes: Battleforce Astra Militarum Platoon, Ciaphas Cain, Centaur RSV, Hippogriff AFV.</p></body></html>`;
    const d = fieldsFromHtml({
      html, url: "https://youcouldwin.co.uk/competition/astra-militarum-bundle-6",
      op, knownTitle: "Astra Militarum: Bundle #6", knownImage: "https://cdn.test/a.jpg", knownPrice: 5.6,
      descriptionText: "Astra Militarum: Bundle #6\nBundle Includes: Battleforce Astra Militarum Platoon, Ciaphas Cain, Centaur RSV, Hippogriff AFV.",
      apiCategories: ["Auto Draw", "Warhammer"], apiStock: 99,
    });
    expect(d.total_entries).toBe(99);
    expect(d.category).toBe("collectibles");
  });
  test("a clean labelled cap in the API description beats the API stock count", () => {
    const html = `<html><body><h1>Win £10,000 Cash</h1></body></html>`;
    const d = fieldsFromHtml({
      html, url: "https://bigbeastiecompetitions.co.uk/competition/win-10k",
      op: { base: "https://bigbeastiecompetitions.co.uk", name: "Bigbeastie Competitions" },
      knownTitle: "Win £10,000 Cash", knownImage: "https://cdn.test/c.jpg", knownPrice: 0.01,
      descriptionText: "Win £10,000 Cash. Total Entries: 5000.",
      apiCategories: ["Cash"], apiStock: 4000,
    });
    expect(d.total_entries).toBe(5000); // labelled cap, not the 4000 remaining-stock
  });
  test("the neighbour-comp leak is gone: a bare page count never overrides the API stock", () => {
    // page text carries OTHER comps' bare counts ("14,993 Tickets", "199,952 in stock") but THIS
    // comp's cap is the API stock — the noisy whole-page grab must not win.
    const html = `<html><body><h1>£222 End Prize + Instant Wins</h1>
      <aside>Another £10k End Prize 199,952 Tickets · £40,000 14,993 Tickets · Only 70 Tickets</aside></body></html>`;
    const d = fieldsFromHtml({
      html, url: "https://bigbeastiecompetitions.co.uk/competition/222-end-prize",
      op: { base: "https://bigbeastiecompetitions.co.uk", name: "Bigbeastie Competitions" },
      knownTitle: "£222 End Prize + Instant Wins", knownImage: "https://cdn.test/d.jpg", knownPrice: 0.01,
      descriptionText: "£222 End Prize + Instant Wins. Instant wins throughout!",
      apiCategories: ["Live Draws"], apiStock: 2385,
    });
    expect(d.total_entries).toBe(2385); // its own stock, not a neighbour's 199,952 / 14,993
  });
});

describe("fieldsFromHtml — Podium render path uses the operator entries pattern", () => {
  test("reads TOTAL: 66000 from the bar, not MAX 15000 ENTRIES", () => {
    const op = { base: "https://podiumprize.co.uk", name: "Podium Prize", patterns: { entries: "TOTAL:\\s*([\\d,]{3,})" } };
    const html = `<html><body><h1>Wild West Bingo!</h1>
      <p>MAX 15000 ENTRIES · VERIFIED DRAW</p><p>SOLD: 536 TOTAL: 66000</p>
      <p>Draw will take place on 19th July 2026 at 8pm.</p></body></html>`;
    const d = fieldsFromHtml({ html, url: "https://podiumprize.co.uk/competitions/wild-west-bingo", op, knownImage: "https://cdn.test/w.jpg" });
    expect(d.total_entries).toBe(66000);
  });
});
