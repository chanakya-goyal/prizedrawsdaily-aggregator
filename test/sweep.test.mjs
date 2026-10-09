import { expect, test, describe } from "bun:test";
import { planCloudinarySweep, SWEEP_MIN_AGE_MS } from "../lib/sweep.mjs";

// Why this file exists: the sweep DELETES files, and the only copies of a live draft's photo
// are on Cloudinary. Too eager and a live photo breaks; too timid and dead copies fill the
// account's storage credits. Each rule is pinned here.

const now = Date.parse("2026-10-10T12:00:00Z");
const old = new Date(now - 7 * 864e5).toISOString();
const fresh = new Date(now - 3600e3).toISOString();
const cloud = { cloudName: "pdd" };
const BASE = "https://site.pages.dev/i/";
const CDN = "https://res.cloudinary.com/pdd/image/upload/v1/";
const RAW = "https://res.cloudinary.com/pdd/raw/upload/v1/";

const asset = (resourceType, publicId, { createdAt = old, bytes = 100 } = {}) => {
  const path = resourceType === "raw" ? publicId : `${publicId}.webp`;
  return [`${resourceType}:${publicId}`, { resourceType, publicId, format: "webp", bytes, path, createdAt }];
};
const plan = (assets, draws, operators = []) =>
  planCloudinarySweep({ inventory: new Map(assets), draws, operators, base: BASE, cloud, now });
const removed = (r) => r.remove.map((a) => `${a.resourceType}:${a.publicId}`).sort();

describe("planCloudinarySweep", () => {
  test("the copy of a DEAD draw's photo served from Pages goes", () => {
    const r = plan([asset("raw", "op/dead.webp")], [{ status: "ended", image_url: `${BASE}op/dead.webp` }]);
    expect(removed(r)).toEqual(["raw:op/dead.webp"]);
  });

  test("the copy of a LIVE draw's photo served from Pages stays, in both forms", () => {
    const r = plan([asset("raw", "op/live.webp"), asset("image", "op/live")], [{ status: "active", image_url: `${BASE}op/live.webp` }]);
    expect(r.remove.length).toBe(0);
    expect(r.kept).toBe(2);
  });

  test("a draft's photo (only on Cloudinary) stays", () => {
    const r = plan([asset("raw", "op/draft.webp")], [{ status: "draft", image_url: `${RAW}op/draft.webp` }]);
    expect(r.remove.length).toBe(0);
  });

  test("a DEAD row still pointing straight at Cloudinary keeps its file until retention nulls it", () => {
    // Deleting first would leave that row pointing at a missing photo.
    const r = plan([asset("image", "op/x")], [{ status: "ended", image_url: `${CDN}op/x.webp` }]);
    expect(r.remove.length).toBe(0);
  });

  test("the migrated twin (.avif and .webp share one image asset) stays while either is live", () => {
    const r = plan([asset("image", "rev/car")], [
      { status: "ended", image_url: `${BASE}rev/car.webp` },
      { status: "active", image_url: `${BASE}rev/car.avif` },
    ]);
    expect(r.remove.length).toBe(0);
  });

  test("an operator logo is never swept", () => {
    const r = plan([asset("raw", "operator-logos/op.webp")], [], [{ logo_url: `${BASE}operator-logos/op.webp` }]);
    expect(r.remove.length).toBe(0);
  });

  test("a file no row points at goes once it is older than 48 hours", () => {
    const r = plan([asset("raw", "op/orphan.webp")], [{ status: "active", image_url: `${BASE}op/other.webp` }]);
    expect(removed(r)).toEqual(["raw:op/orphan.webp"]);
  });

  test("a file uploaded in the last 48 hours stays, even with no row yet", () => {
    // The scrape uploads before it writes the row.
    const r = plan([asset("raw", "op/new.webp", { createdAt: fresh })], []);
    expect(r.remove.length).toBe(0);
    expect(r.young).toBe(1);
    expect(SWEEP_MIN_AGE_MS).toBe(48 * 3600e3);
  });

  test("a file whose age is unknown stays", () => {
    const r = plan([asset("raw", "op/undated.webp", { createdAt: null })], []);
    expect(r.remove.length).toBe(0);
  });

  test("bytes add up for the report", () => {
    const r = plan([asset("raw", "a/1.webp", { bytes: 10 }), asset("raw", "a/2.webp", { bytes: 32 })], []);
    expect(r.bytes).toBe(42);
  });
});
