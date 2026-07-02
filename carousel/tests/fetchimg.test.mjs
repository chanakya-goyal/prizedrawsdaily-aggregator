import { test, expect } from "bun:test";
import { upgradeUrl } from "../fetchimg.mjs";

test("strips WordPress/Woo -WxH thumbnail suffix (DCG 2026-07-02 incident)", () => {
  expect(upgradeUrl("https://dreamcargiveaways.co.uk/wp-content/uploads/2026/06/disco-150x100.jpg"))
    .toBe("https://dreamcargiveaways.co.uk/wp-content/uploads/2026/06/disco.jpg");
});

test("upgrades Shopify width param", () => {
  const u = upgradeUrl("https://cdn.shopify.com/s/files/1/x/prize.jpg?width=300");
  expect(u).toContain("width=1600");
});

test("leaves clean URLs alone", () => {
  expect(upgradeUrl("https://example.com/photo.jpg")).toBe("https://example.com/photo.jpg");
});
