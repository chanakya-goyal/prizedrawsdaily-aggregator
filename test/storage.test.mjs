import { expect, test, describe } from "bun:test";
import { objectPathFromUrl, classifyOrphans, PUBLIC_PREFIX } from "../lib/storage.mjs";

const creds = { supabaseUrl: "https://proj.supabase.co", bucket: "draw-images" };
const PREFIX = PUBLIC_PREFIX(creds);

describe("objectPathFromUrl", () => {
  test("extracts the path from a plain public URL", () => {
    expect(objectPathFromUrl(`${PREFIX}seven-days-perf/bmw-m2.webp`, PREFIX)).toBe("seven-days-perf/bmw-m2.webp");
  });

  test("strips a cache-busting query and hash", () => {
    expect(objectPathFromUrl(`${PREFIX}op/draw.webp?v=2`, PREFIX)).toBe("op/draw.webp");
    expect(objectPathFromUrl(`${PREFIX}op/draw.webp#x`, PREFIX)).toBe("op/draw.webp");
  });

  test("decodes percent-encoding, because uploads go through encodeURI", () => {
    // rehost.mjs / compress-images.mjs upload with encodeURI(path), so a slug containing a
    // space is stored encoded in the URL but listed RAW by the storage API. Comparing the two
    // without decoding would mark a live image as an orphan.
    expect(objectPathFromUrl(`${PREFIX}op/win%20a%20car.webp`, PREFIX)).toBe("op/win a car.webp");
  });

  test("unwraps an images.weserv.nl URL to find the nested bucket path", () => {
    const inner = encodeURIComponent(`${PREFIX}op/draw.webp`);
    expect(objectPathFromUrl(`https://images.weserv.nl/?url=${inner}&w=960`, PREFIX)).toBe("op/draw.webp");
  });

  test("unwraps weserv's scheme-less ssl: form", () => {
    const inner = encodeURIComponent("ssl:proj.supabase.co/storage/v1/object/public/draw-images/op/d.webp");
    expect(objectPathFromUrl(`https://images.weserv.nl/?url=${inner}`, PREFIX)).toBe("op/d.webp");
  });

  test("returns null for anything not in our bucket", () => {
    expect(objectPathFromUrl("https://operator.co.uk/img/car.jpg", PREFIX)).toBeNull();
    expect(objectPathFromUrl(`${creds.supabaseUrl}/storage/v1/object/public/other-bucket/a.webp`, PREFIX)).toBeNull();
  });

  test("returns null for empty, non-string and bare-prefix input", () => {
    for (const bad of ["", null, undefined, 42, {}, PREFIX]) {
      expect(objectPathFromUrl(bad, PREFIX)).toBeNull();
    }
  });
});

describe("classifyOrphans", () => {
  const DAY = 86400_000;
  const now = Date.parse("2026-08-20T00:00:00Z");
  const old = new Date(now - 30 * DAY).toISOString();
  const file = (path, created = old, size = 1000) => ({ path, created_at: created, metadata: { size } });

  test("keeps referenced objects and drops unreferenced ones", () => {
    const files = [file("op/live.webp"), file("op/dead.webp")];
    const { orphans } = classifyOrphans(files, new Set(["op/live.webp"]), { cutoffMs: 7 * DAY, now });
    expect(orphans.map((f) => f.path)).toEqual(["op/dead.webp"]);
  });

  test("keeps an ended draw's image — 'orphan' means unreferenced, never merely old", () => {
    // The bucket is deliberately not pruned by age: ended draws keep their pages and og:image.
    const files = [file("op/ended-2024.webp", new Date(now - 400 * DAY).toISOString())];
    const { orphans } = classifyOrphans(files, new Set(["op/ended-2024.webp"]), { cutoffMs: 7 * DAY, now });
    expect(orphans).toHaveLength(0);
  });

  test("spares an unreferenced object younger than the cutoff", () => {
    // Ingest uploads bytes BEFORE inserting the row that references them. A prune landing in
    // that window would delete a live image and the draw would publish with a dead URL.
    const fresh = new Date(now - 2 * DAY).toISOString();
    const { orphans, youngSkipped } = classifyOrphans([file("op/mid-ingest.webp", fresh)], new Set(), {
      cutoffMs: 7 * DAY,
      now,
    });
    expect(orphans).toHaveLength(0);
    expect(youngSkipped).toBe(1);
  });

  test("treats an object with no timestamp as old enough to reap", () => {
    const { orphans } = classifyOrphans([{ path: "op/x.webp", metadata: { size: 1 } }], new Set(), {
      cutoffMs: 7 * DAY,
      now,
    });
    expect(orphans.map((f) => f.path)).toEqual(["op/x.webp"]);
  });

  test("falls back to updated_at when created_at is absent", () => {
    const fresh = new Date(now - 1 * DAY).toISOString();
    const { orphans } = classifyOrphans([{ path: "op/x.webp", updated_at: fresh, metadata: { size: 1 } }], new Set(), {
      cutoffMs: 7 * DAY,
      now,
    });
    expect(orphans).toHaveLength(0);
  });

  test("without a cutoff, age is ignored entirely", () => {
    const fresh = new Date(now - 1 * DAY).toISOString();
    const { orphans } = classifyOrphans([file("op/x.webp", fresh)], new Set(), { now });
    expect(orphans).toHaveLength(1);
  });
});
