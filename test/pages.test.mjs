import { expect, test, describe } from "bun:test";
import { planMirror, isSafeKey, pagesUrl, pagesKeyOf, pagesSite, pagesBase, manifestOf, HEADERS_FILE } from "../lib/pages.mjs";

// Why this file exists: publish-images.mjs REPLACES the whole Pages site on every deploy, so
// a photo the plan leaves out is a photo deleted from a live page, and a row moved before
// its file is there is a broken image. These rules decide both.

const BASE = "https://site.pages.dev/i/";
const CDN = "https://res.cloudinary.com/pdd/image/upload/v1/"; // the migrated photos
const RAW = "https://res.cloudinary.com/pdd/raw/upload/v1/"; // every upload since 2026-10-09
const cloud = { cloudName: "pdd" };
const plan = (draws, operators = []) => planMirror({ draws, operators, base: BASE, cloud });

describe("addresses", () => {
  test("photos live under /i/ on the project's own subdomain", () => {
    expect(pagesSite({})).toBe("https://prizedrawsdaily-images.pages.dev/");
    expect(pagesBase({})).toBe("https://prizedrawsdaily-images.pages.dev/i/");
    expect(pagesBase({ PAGES_PROJECT: "other" })).toBe("https://other.pages.dev/i/");
    expect(pagesBase({ PAGES_SITE: "https://other-x1y.pages.dev" })).toBe("https://other-x1y.pages.dev/i/");
  });

  test("a key round-trips through its URL, including one that needs encoding", () => {
    for (const key of ["op/d.webp", "op/a b&c.webp", "operator-logos/x.png"]) {
      expect(pagesKeyOf(pagesUrl(BASE, key), BASE)).toBe(key);
    }
    expect(pagesUrl(BASE, "op/a b.webp")).toBe(`${BASE}op/a%20b.webp`);
  });

  test("the site's own manifest is never mistaken for a photo", () => {
    expect(pagesKeyOf("https://site.pages.dev/manifest.json", BASE)).toBe(null);
  });

  test("the long cache applies to photos only, never to the manifest at the root", () => {
    expect(HEADERS_FILE.startsWith("/i/*\n")).toBe(true);
    expect(HEADERS_FILE).not.toContain("\n/*");
  });
});

describe("isSafeKey — a key becomes a file path inside the deployed folder", () => {
  test("real keys pass", () => {
    expect(isSafeKey("op/win-a-car-op.webp")).toBe(true);
    expect(isSafeKey("operator-logos/op.png")).toBe(true);
    expect(isSafeKey("rev-comps/x.avif")).toBe(true);
  });
  test("anything that could escape the folder, hide, or is not an image does not", () => {
    for (const k of ["_headers", "x.webp", "../x.webp", "op/../../x.webp", "op/.hidden.webp", "op\\x.webp", "op/x.html", "op/", "/op/x.webp", ""]) {
      expect(isSafeKey(k)).toBe(false);
    }
  });
});

describe("planMirror", () => {
  test("a public Cloudinary photo is copied and its row moved", () => {
    const r = plan([{ id: 1, status: "active", image_url: `${RAW}op/d.webp` }]);
    expect(r.want.get("op/d.webp")).toEqual({ from: "cloudinary", url: `${RAW}op/d.webp`, form: "raw" });
    expect(r.repoint).toEqual([{ table: "draws", column: "image_url", id: 1, old: `${RAW}op/d.webp`, key: "op/d.webp" }]);
  });

  test("ended draws are public pages too, so they move", () => {
    const r = plan([{ id: 1, status: "ended", image_url: `${CDN}op/d.webp` }]);
    expect(r.repoint.length).toBe(1);
  });

  test("a DRAFT stays on Cloudinary: not public, and re-uploaded by the scraper each run", () => {
    const r = plan([{ id: 1, status: "draft", image_url: `${RAW}op/d.webp` }]);
    expect(r.want.size).toBe(0);
    expect(r.repoint.length).toBe(0);
    expect(r.drafts).toBe(1);
  });

  test("a row already on Pages keeps its file in the next deployment, whatever its status", () => {
    // The deploy replaces the site: leaving this out would delete a live photo.
    const r = plan([
      { id: 1, status: "active", image_url: `${BASE}op/a.webp` },
      { id: 2, status: "draft", image_url: `${BASE}op/b.webp` },
    ]);
    expect([...r.want.keys()].sort()).toEqual(["op/a.webp", "op/b.webp"]);
    expect(r.want.get("op/a.webp").from).toBe("pages");
    expect(r.repoint.length).toBe(0);
  });

  test("fresh bytes on Cloudinary beat the copy on Pages for the same key", () => {
    // The scraper only writes a Cloudinary URL right after uploading new bytes (a relist).
    const r = plan([
      { id: 1, status: "ended", image_url: `${BASE}op/d.webp` },
      { id: 2, status: "active", image_url: `${RAW}op/d.webp` },
    ]);
    expect(r.want.get("op/d.webp").from).toBe("cloudinary");
    expect(r.repoint.map((m) => m.id)).toEqual([2]);
  });

  test("between the two Cloudinary forms of one key, raw (newer) wins in either order", () => {
    for (const draws of [
      [{ id: 1, status: "active", image_url: `${CDN}op/d.webp` }, { id: 2, status: "active", image_url: `${RAW}op/d.webp` }],
      [{ id: 2, status: "active", image_url: `${RAW}op/d.webp` }, { id: 1, status: "active", image_url: `${CDN}op/d.webp` }],
    ]) {
      const r = plan(draws);
      expect(r.want.get("op/d.webp").form).toBe("raw");
      expect(r.repoint.length).toBe(2); // both rows end up on the one Pages file
    }
  });

  test("operator logos move too", () => {
    const r = plan([], [{ id: 7, logo_url: `${RAW}operator-logos/op.webp` }]);
    expect(r.repoint).toEqual([{ table: "operators", column: "logo_url", id: 7, old: `${RAW}operator-logos/op.webp`, key: "operator-logos/op.webp" }]);
  });

  test("an operator's own URL, a null and a weserv-wrapped Pages URL are handled", () => {
    const wrapped = `https://images.weserv.nl/?url=${encodeURIComponent(`${BASE}op/w.webp`)}&w=640`;
    const r = plan([
      { id: 1, status: "active", image_url: "https://operator.example/x.jpg" },
      { id: 2, status: "active", image_url: null },
      { id: 3, status: "active", image_url: wrapped },
    ]);
    expect([...r.want.keys()]).toEqual(["op/w.webp"]);
    expect(r.repoint.length).toBe(0);
  });

  test("an unsafe key is never written and its row never moved", () => {
    const r = plan([{ id: 1, status: "active", image_url: `${RAW}../escape.webp` }]);
    expect(r.want.size).toBe(0);
    expect(r.repoint.length).toBe(0);
    expect(r.unsafe.length).toBe(1);
  });

  test("with no Cloudinary config only the Pages rows count", () => {
    const r = planMirror({ draws: [{ id: 1, status: "active", image_url: `${RAW}op/d.webp` }, { id: 2, status: "active", image_url: `${BASE}op/e.webp` }], base: BASE, cloud: null });
    expect([...r.want.keys()]).toEqual(["op/e.webp"]);
  });
});

describe("manifestOf", () => {
  test("is order-independent, so an unchanged set is recognised and not redeployed", () => {
    const a = manifestOf([["b/2.webp", { sha256: "2", bytes: 2 }], ["a/1.webp", { sha256: "1", bytes: 1 }]]);
    const b = manifestOf(new Map([["a/1.webp", { sha256: "1", bytes: 1 }], ["b/2.webp", { sha256: "2", bytes: 2 }]]));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
