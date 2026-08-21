import { test, expect, describe } from "bun:test";
import { fieldsFromHtml, CATEGORIES } from "../lib/parse.mjs";

// Fixture-locked test: runs the real wooOperator assembly path over a frozen rev-comps
// snapshot (captured via `bun capture.mjs rev-comps`). Asserts structural correctness so
// a parser regression fails offline. Re-capture the fixture if the site changes shape.
describe("rev-comps woo fixture", () => {
  const op = { slug: "rev-comps", base: "https://www.revcomps.com", method: "woo" };

  test("first product parses into a sane draw shape", async () => {
    const products = await Bun.file("test/fixtures/woo/rev-comps.products.json").json();
    const html = await Bun.file("test/fixtures/woo/rev-comps.product.html").text();
    const p = products[0];
    const minor = p.prices?.currency_minor_unit ?? 2;
    const knownPrice = p.prices?.price != null ? Number((Number(p.prices.price) / 10 ** minor).toFixed(2)) : null;
    const apiDesc = `${p.name || ""}\n${p.short_description || ""}\n${p.description || ""}`;
    const d = fieldsFromHtml({ html, url: p.permalink, op, knownTitle: p.name, knownImage: p.images?.[0]?.src, knownPrice, descriptionText: apiDesc });

    expect(d.title).toBeTruthy();
    expect(d.title).not.toContain("&#");          // entities decoded
    expect(d.entry_url).toBe(p.permalink);
    expect(d.image_url).toMatch(/^https?:\/\//);
    expect(d.ticket_price).toBeGreaterThan(0);
    // This fixture's first product ("£50 RevComps Credit") names no operator category in the
    // test call and its title carries no keyword evidence under either the old or new rules —
    // it only ever "matched" cash-prizes via the fallback Task 6 deletes. null is now correct.
    expect(d.category === null || CATEGORIES.includes(d.category)).toBe(true);
    // total_entries is either a plausible cap or null (never a sold/remaining count)
    if (d.total_entries != null) {
      expect(d.total_entries).toBeGreaterThanOrEqual(100);
      expect(d.total_entries).toBeLessThanOrEqual(10_000_000);
    }
  });
});

// Fixture-locked: waffle-competitions runs the lty (lottery-for-woocommerce) plugin, which
// publishes "44 Tickets Sold" + "256 remaining" but never the cap. Their sum IS the exact
// cap (progress bar confirms 44/300 = 14.67%) — a derived total that keeps the sold-count
// veto intact. Captured 2026-08-14 via `bun capture.mjs waffle-competitions`.
describe("waffle-competitions woo fixture (lty sold+remaining cap)", () => {
  const op = { slug: "waffle-competitions", base: "https://wafflecompetitions.com", method: "woo" };

  test("cap derives from sold+remaining; date comes from the lty countdown attr", async () => {
    const products = await Bun.file("test/fixtures/woo/waffle-competitions.products.json").json();
    const html = await Bun.file("test/fixtures/woo/waffle-competitions.product.html").text();
    const p = products[0];
    const minor = p.prices?.currency_minor_unit ?? 2;
    const knownPrice = p.prices?.price != null ? Number((Number(p.prices.price) / 10 ** minor).toFixed(2)) : null;
    const d = fieldsFromHtml({ html, url: p.permalink, op, knownTitle: p.name, knownImage: p.images?.[0]?.src, knownPrice,
      descriptionText: `${p.name || ""}\n${p.short_description || ""}\n${p.description || ""}` });
    expect(d.total_entries).toBe(300);              // 44 sold + 256 remaining
    expect(d.draw_date).toBeTruthy();               // lty data-time attr
    expect(d.ticket_price).toBe(0);                 // this fixture product is free-entry — businessGate routes it out; the lty cap/date extraction is what's under test
  });
});
