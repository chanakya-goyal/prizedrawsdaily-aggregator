// Fixture-locked tests for the JSON-API adapters. Frozen snapshots captured from the live
// endpoints, so these run fully OFFLINE — the CI gate (`bun run test:scraper`) must never
// need the network or Chromium, or a failing gate silently skips the whole daily scrape.
// Re-capture a fixture if an operator changes shape.
import { test, expect, describe } from "bun:test";
import { CATEGORIES } from "../lib/parse.mjs";
import { mapRaffle, unitPrice, listUrl } from "../lib/adapters/raffle-engine.mjs";
import { mapCompetition as mapHydra, imageUrl, isLive } from "../lib/adapters/hydra.mjs";
import { parseDataPage, arrayOf, mapCompetition as mapInertia } from "../lib/adapters/inertia.mjs";
import { gate } from "../gate.mjs";

// Every adapter must produce the shape fieldsFromHtml produces, or the gate/dedupe/flush
// stages downstream will quietly mishandle it.
function expectDrawShape(d) {
  expect(d).toBeTruthy();
  expect(typeof d.title).toBe("string");
  expect(d.title.length).toBeGreaterThan(0);
  expect(CATEGORIES).toContain(d.category);
  expect(d.entry_url).toMatch(/^https?:\/\//);
  expect(d.image_url === null || /^https?:\/\//.test(d.image_url)).toBe(true);
  // 0 is legitimate: 7Days runs a genuinely free daily instant-win. Rejecting free comps is
  // the gate's job (businessGate: "no/zero ticket price"), not the adapter's.
  expect(d.ticket_price === null || d.ticket_price >= 0).toBe(true);
  expect(d.total_entries === null || d.total_entries > 0).toBe(true);
  expect("grand_prize" in d && "draw_date" in d && "description" in d).toBe(true);
}

describe("raffle-engine adapter (7Days Performance / UKCC)", () => {
  const op = { slug: "seven-days-perf", name: "7Days Performance", base: "https://7daysperformance.co.uk", drawPath: "/product/{slug}" };
  const load = () => Bun.file("test/fixtures/api/seven-days-perf.raffle-draws.json").json();

  test("every fixture record maps to a valid draw shape", async () => {
    const rows = await load();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expectDrawShape(mapRaffle(r, op));
  });

  test("entry_url uses the operator's public product path, not the API path", async () => {
    const [r] = await load();
    const d = mapRaffle(r, op);
    expect(d.entry_url).toBe(`https://7daysperformance.co.uk/product/${r.slug}`);
    expect(d.entry_url).not.toContain("/api/");
  });

  // UKCC runs the identical platform; only the public URL shape differs, which is why the
  // path is config. This is the test that stops someone hardcoding /product/.
  test("the same mapper serves UKCC via drawPath alone", async () => {
    const [r] = await load();
    const ukcc = { slug: "ukcc", name: "UKCC", base: "https://ukcc.co.uk", drawPath: "/competition/{slug}" };
    expect(mapRaffle(r, ukcc).entry_url).toBe(`https://ukcc.co.uk/competition/${r.slug}`);
  });

  test("max_entries becomes the cap and end_at the draw date", async () => {
    const rows = await load();
    const withCap = rows.find((r) => r.max_entries > 0);
    const d = mapRaffle(withCap, op);
    expect(d.total_entries).toBe(withCap.max_entries);
    expect(new Date(d.draw_date).getTime()).toBe(new Date(withCap.end_at).getTime());
  });

  describe("unitPrice — prices arrive as a tiered ladder", () => {
    test("prefers the tickets_quantity===1 tier", () => {
      expect(unitPrice([{ tickets_quantity: 5, price: "1.00" }, { tickets_quantity: 1, price: "0.09" }])).toBe(0.09);
    });
    test("falls back to the cheapest per-ticket unit when no single tier exists", () => {
      expect(unitPrice([{ tickets_quantity: 10, price: "5.00" }, { tickets_quantity: 4, price: "2.40" }])).toBe(0.5);
    });
    test("null when there are no usable offers", () => {
      expect(unitPrice([])).toBe(null);
      expect(unitPrice(undefined)).toBe(null);
    });
    test("never returns the BUNDLE price as the ticket price", async () => {
      const rows = await load();
      for (const r of rows) {
        const single = (r.offers || []).find((o) => Number(o.tickets_quantity) === 1);
        if (single) expect(unitPrice(r.offers)).toBe(Number(single.price));
      }
    });
  });

  test("listUrl always excludes finished comps", () => {
    // include_finished defaults to TRUE upstream: omitting it returns 500 rows for 7Days
    // instead of 56, i.e. mostly finished competitions.
    expect(listUrl(op)).toContain("include_finished=false");
    expect(listUrl(op)).toContain("/api/v2/raffle-draws/GBP");
  });

  test("records without a title or slug are dropped, not emitted half-built", () => {
    expect(mapRaffle({ title: "", slug: "x" }, op)).toBe(null);
    expect(mapRaffle({ title: "Win a car", slug: null }, op)).toBe(null);
  });

  test("mapped car records survive the real gate", async () => {
    const rows = await load();
    const cars = rows.filter((r) => (r.category_ids || []).some((c) => /^car/.test(c)));
    const passed = cars.map((r) => gate(mapRaffle(r, op), new Date(rows[0].start_at || Date.now()))).filter((g) => g.pass);
    expect(passed.length).toBeGreaterThan(0);
  });
});

describe("hydra adapter (Dream Car Giveaways)", () => {
  const op = { slug: "dream-car-giveaways", name: "Dream Car Giveaways", base: "https://dreamcargiveaways.co.uk" };
  const load = async () => (await Bun.file("test/fixtures/api/dream-car-giveaways.hydra.json").json())["hydra:member"];

  test("every fixture record maps to a valid draw shape", async () => {
    const rows = await load();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expectDrawShape(mapHydra(r, op));
  });

  // The single most damaging mistake available in this adapter: regularPrice is an integer
  // number of PENCE. Reading 9 as £9 inflates every ticket price 100x.
  test("regularPrice is PENCE and converts to pounds", async () => {
    const rows = await load();
    for (const r of rows) expect(mapHydra(r, op).ticket_price).toBe(Math.round(r.regularPrice) / 100);
    expect(mapHydra({ name: "x", urlStub: "x", regularPrice: 9, numTickets: 100 }, op).ticket_price).toBe(0.09);
    expect(mapHydra({ name: "x", urlStub: "x", regularPrice: 199, numTickets: 100 }, op).ticket_price).toBe(1.99);
  });

  test("ticket prices stay in a believable range for a raffle", async () => {
    for (const r of await load()) {
      const p = mapHydra(r, op).ticket_price;
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(100);
    }
  });

  test("numTickets is the cap, closeTs the date, urlStub the public URL", async () => {
    const [r] = await load();
    const d = mapHydra(r, op);
    expect(d.total_entries).toBe(r.numTickets);
    expect(new Date(d.draw_date).getTime()).toBe(new Date(r.closeTs).getTime());
    expect(d.entry_url).toBe(`https://dreamcargiveaways.co.uk/competitions/${r.urlStub}`);
  });

  // `thumb` is a path that 401s and `thumbnail` is a bare id; only the transformed-media
  // host actually serves the bytes.
  test("imageUrl builds the public media URL from either field", () => {
    expect(imageUrl({ thumbnail: "abc123" })).toBe("https://media.dreamcargiveaways.co.uk/media/transformed/abc123?w=1280");
    expect(imageUrl({ thumb: "/media-uploads/abc123" })).toBe("https://media.dreamcargiveaways.co.uk/media/transformed/abc123?w=1280");
    expect(imageUrl({})).toBe(null);
  });

  test("isLive requires published status AND a future close", () => {
    const now = new Date("2026-08-19T00:00:00Z");
    expect(isLive({ status: "published", closeTs: "2026-08-25T22:00:00+01:00" }, now)).toBe(true);
    expect(isLive({ status: "published", closeTs: "2026-08-01T22:00:00+01:00" }, now)).toBe(false);
    expect(isLive({ status: "draft", closeTs: "2026-08-25T22:00:00+01:00" }, now)).toBe(false);
  });

  test("car competitions categorise as car-draws", async () => {
    const rows = await load();
    const cars = rows.filter((r) => String(r.category || "").startsWith("car"));
    if (cars.length) for (const r of cars) expect(mapHydra(r, op).category).toBe("car-draws");
  });
});

describe("inertia adapter (Dream Big Competitions)", () => {
  const op = { slug: "dream-big-competitions", name: "Dream Big Competitions", base: "https://dreambigcompetitions.com" };
  const html = () => Bun.file("test/fixtures/api/dream-big-competitions.listing.html").text();

  test("data-page parses out of the raw HTML attribute", async () => {
    const page = parseDataPage(await html());
    expect(page).toBeTruthy();
    expect(Array.isArray(page.props?.competitions?.data)).toBe(true);
    expect(page.props.competitions.data.length).toBeGreaterThan(0);
  });

  test("returns null rather than throwing on HTML with no data-page", () => {
    expect(parseDataPage("<html><body>nope</body></html>")).toBe(null);
    expect(parseDataPage("")).toBe(null);
    expect(parseDataPage(null)).toBe(null);
  });

  // Shape trap: listing pages give bare arrays, detail pages wrap them in { data: [...] }.
  test("arrayOf handles both the listing and detail shapes", () => {
    expect(arrayOf([{ name: "Cars" }])).toHaveLength(1);
    expect(arrayOf({ data: [{ name: "Cars" }] })).toHaveLength(1);
    expect(arrayOf(null)).toEqual([]);
    expect(arrayOf(undefined)).toEqual([]);
  });

  test("every live competition maps to a valid draw shape", async () => {
    const page = parseDataPage(await html());
    const rows = page.props.competitions.data.filter((r) => String(r.status).toLowerCase() === "active");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expectDrawShape(mapInertia(r, op));
  });

  test("total_tickets is the cap and the relative image path is absolutised", async () => {
    const page = parseDataPage(await html());
    const r = page.props.competitions.data[0];
    const d = mapInertia(r, op);
    expect(d.total_entries).toBe(r.total_tickets);
    expect(d.image_url.startsWith("https://dreambigcompetitions.com")).toBe(true);
  });

  // `end` is "YYYY-MM-DD HH:MM:SS" with NO timezone — London wall-clock. Getting this wrong
  // shifts every draw date by an hour in summer.
  test("the timezone-less end time is read as UK wall-clock", async () => {
    const d = mapInertia({ name: "x", slug: "x", price: "1.00", total_tickets: 1000, end: "2026-08-23 23:00:00" }, op);
    expect(d.draw_date).toContain("2026-08-23T23:00");
    expect(d.draw_date).toMatch(/\+01:00$/); // August = BST
  });

  // Regression: sale_price is "0.00" when there is NO sale. Treating it as a value zeroed
  // the ticket price on 6 of the 9 live comps, and the gate then dropped every one of them.
  test("a sale_price of 0.00 does not wipe out the real ticket price", () => {
    const d = mapInertia({ name: "x", slug: "x", price: "0.97", sale_price: "0.00", total_tickets: 59999, end: "2026-08-30 23:00:00" }, op);
    expect(d.ticket_price).toBe(0.97);
  });

  test("a genuine sale price does win when it is positive", () => {
    const d = mapInertia({ name: "x", slug: "x", price: "1.97", sale_price: "0.99", total_tickets: 100, end: "2026-08-30 23:00:00" }, op);
    expect(d.ticket_price).toBe(0.99);
  });

  test("every live competition ends up with a usable ticket price", async () => {
    const page = parseDataPage(await html());
    const rows = page.props.competitions.data.filter((r) => String(r.status).toLowerCase() === "active");
    for (const r of rows) expect(mapInertia(r, op).ticket_price).toBeGreaterThan(0);
  });

  test("this operator's car comps categorise as car-draws", async () => {
    const page = parseDataPage(await html());
    const cars = page.props.competitions.data.filter((r) => arrayOf(r.categories).some((c) => c?.name === "Cars"));
    expect(cars.length).toBeGreaterThan(0);
    // Instant-win cash comps are tagged "Cars" by this operator too, so only assert that a
    // genuinely vehicle-titled one lands in car-draws.
    const vehicle = cars.find((r) => /lexus|toyota|honda|bmw|audi|jdm/i.test(r.name));
    if (vehicle) expect(mapInertia(vehicle, op).category).toBe("car-draws");
  });
});
