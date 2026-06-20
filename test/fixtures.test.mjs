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
    expect(CATEGORIES).toContain(d.category);
    // total_entries is either a plausible cap or null (never a sold/remaining count)
    if (d.total_entries != null) {
      expect(d.total_entries).toBeGreaterThanOrEqual(100);
      expect(d.total_entries).toBeLessThanOrEqual(10_000_000);
    }
  });
});
