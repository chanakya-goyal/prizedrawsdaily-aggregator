import { test, expect, describe } from "bun:test";
import {
  sniff, imageDims, discoverFromHtml, judge, rankCandidates, needsWork, squareLogoUrl,
  writeRefusal, parsePicks, contactSheet, MIN_SIDE,
} from "../lib/logos.mjs";

// Minimal headers: just enough bytes for the dimension parsers.
const png = (w, h) => { const b = new Uint8Array(600); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const v = new DataView(b.buffer); v.setUint32(16, w); v.setUint32(20, h); return b; };
const gif = (w, h) => { const b = new Uint8Array(600); b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); const v = new DataView(b.buffer); v.setUint16(6, w, true); v.setUint16(8, h, true); return b; };
const jpeg = (w, h) => { const b = new Uint8Array(600); b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08]); const v = new DataView(b.buffer); v.setUint16(13, h); v.setUint16(15, w); return b; };
const ico = (w, h) => { const b = new Uint8Array(600); b.set([0, 0, 1, 0, 1, 0, w % 256, h % 256]); return b; };
const webpX = (w, h) => { const b = new Uint8Array(600); b.set([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8X")]); const s = (o, n) => { b[o] = n & 255; b[o + 1] = (n >> 8) & 255; b[o + 2] = (n >> 16) & 255; }; s(24, w - 1); s(27, h - 1); return b; };
const svg = (vb) => new TextEncoder().encode(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"></svg>`);
const probe = (source, w, h, extra = {}) => ({ url: `https://x.test/${source}-${w}x${h}.png`, source, ok: true, bytes: 4000, dims: { kind: "png", w, h }, ...extra });

describe("sniff + imageDims", () => {
  test("reads png, gif, jpeg, ico, webp and svg sizes", () => {
    expect(imageDims(png(180, 180))).toMatchObject({ kind: "png", w: 180, h: 180 });
    expect(imageDims(gif(200, 100))).toMatchObject({ kind: "gif", w: 200, h: 100 });
    expect(imageDims(jpeg(640, 320))).toMatchObject({ kind: "jpeg", w: 640, h: 320 });
    expect(imageDims(ico(0, 0))).toMatchObject({ kind: "ico", w: 256, h: 256 }); // 0 byte = 256
    expect(imageDims(ico(32, 32))).toMatchObject({ kind: "ico", w: 32, h: 32 });
    expect(imageDims(webpX(300, 150))).toMatchObject({ kind: "webp", w: 300, h: 150 });
    expect(imageDims(svg("0 0 400 100"))).toMatchObject({ kind: "svg", svg: true, w: 400, h: 100 });
  });
  test("an HTML error page served with a 200 is not an image", () => {
    expect(sniff(new TextEncoder().encode("<!doctype html><title>Just a moment</title>"))).toBeNull();
    expect(imageDims(new TextEncoder().encode("<html></html>"))).toBeNull();
  });
});

describe("judge", () => {
  test("rejects favicons; keeps a 100px app icon as soft, 112px+ as sharp", () => {
    expect(judge(probe("icon", 32, 32)).keep).toBe(false);
    expect(judge(probe("icon", 95, 95)).keep).toBe(false);
    expect(judge(probe("icon", 100, 100))).toMatchObject({ keep: true, sharp: false });
    expect(judge(probe("icon", MIN_SIDE, MIN_SIDE))).toMatchObject({ keep: true, sharp: true });
  });
  test("a wide wordmark needs a 224px long side and a 48px short side", () => {
    expect(judge(probe("og-image", 370, 110)).keep).toBe(true);
    expect(judge(probe("img-logo", 200, 60)).keep).toBe(false);
    expect(judge(probe("img-logo", 300, 40)).keep).toBe(false);
  });
  test("rejects banners wider than 4:1 but keeps a wide wordmark as not-square", () => {
    expect(judge(probe("og-image", 1200, 200)).keep).toBe(false);
    const v = judge(probe("img-logo", 600, 200));
    expect(v.keep).toBe(true);
    expect(v.square).toBe(false);
  });
  test("tiny files and failed fetches are rejected", () => {
    expect(judge({ ...probe("icon", 200, 200), bytes: 100 }).keep).toBe(false);
    expect(judge({ ok: false, why: "HTTP 403" }).why).toBe("HTTP 403");
  });
  test("an SVG is kept at any size unless it is a banner", () => {
    expect(judge({ url: "u", source: "img-logo", ok: true, bytes: 900, dims: { kind: "svg", svg: true, w: 50, h: 50 } }).keep).toBe(true);
    expect(judge({ url: "u", source: "img-logo", ok: true, bytes: 900, dims: { kind: "svg", svg: true, w: 1000, h: 100 } }).keep).toBe(false);
  });
  test("an image whose size cannot be read is kept, ranked after measured squares", () => {
    const unk = { url: "u", source: "current", ok: true, bytes: 5000, dims: { kind: "avif", w: null, h: null } };
    expect(judge(unk)).toMatchObject({ keep: true, square: false, unknown: true });
    expect(rankCandidates([unk, probe("icon-service", 256, 256)])[0].source).toBe("icon-service");
    expect(rankCandidates([unk, probe("og-image", 1640, 856)])[0].source).toBe("current");
  });
  test("an owner override is trusted even when small", () => {
    expect(judge(probe("override", 64, 64)).keep).toBe(true);
  });
});

describe("rankCandidates", () => {
  test("square beats wide, then source order, then size", () => {
    const ranked = rankCandidates([
      probe("og-image", 1200, 630),
      probe("img-logo", 600, 200),
      probe("icon-service", 256, 256),
      probe("apple-touch-icon", 180, 180),
      probe("icon", 16, 16),
    ]);
    expect(ranked.map((r) => r.source)).toEqual(["apple-touch-icon", "icon-service", "img-logo", "og-image"]);
  });
  test("override always wins", () => {
    expect(rankCandidates([probe("apple-touch-icon", 512, 512), probe("override", 300, 100)])[0].source).toBe("override");
  });
  test("a sharp square from a weaker source beats a soft square", () => {
    expect(rankCandidates([probe("apple-touch-icon", 100, 100), probe("icon-service", 256, 256)])[0].source).toBe("icon-service");
  });
  test("bigger wins between two squares from the same source", () => {
    expect(rankCandidates([probe("icon", 128, 128), probe("icon", 192, 192)])[0].dims.w).toBe(192);
  });
});

describe("needsWork", () => {
  const bases = ["https://prizedrawsdaily-images.pages.dev/i/"];
  test("missing and broken always need work", () => {
    expect(needsWork({ logo_url: null }, bases, null)).toBe("missing");
    expect(needsWork({ logo_url: "https://a.test/x.png" }, bases, { ok: false, why: "HTTP 404" })).toBe("HTTP 404");
  });
  test("hotlinks need work only with REHOST_ALL", () => {
    const row = { logo_url: "https://encrypted-tbn0.gstatic.com/images?q=tbn:abc" };
    expect(needsWork(row, bases, { ok: true })).toBeNull();
    expect(needsWork(row, bases, { ok: true }, { rehostAll: true })).toBe("hotlink encrypted-tbn0.gstatic.com");
  });
  test("our own logo is left alone unless it is weak", () => {
    const row = { logo_url: "https://prizedrawsdaily-images.pages.dev/i/operator-logos/jammy.webp" };
    expect(needsWork(row, bases, { ok: true }, { rehostAll: true })).toBeNull();
    expect(needsWork(row, bases, { ok: true, weak: "too small 32x32" }, { rehostAll: true })).toBe("weak too small 32x32");
  });
});

describe("discoverFromHtml", () => {
  const html = `<link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
<link href="/fav.png" rel="icon"><img class="site-logo" src="logo.svg"><img src="/img/visa-logo.png">
<meta property="og:image" content="https://cdn.test/og.jpg">`;
  const c = discoverFromHtml(html, "https://op.test/home/");
  test("finds each kind, resolves relative URLs, and drops payment strips", () => {
    expect(c).toContainEqual({ url: "https://op.test/apple.png", source: "apple-touch-icon" });
    expect(c).toContainEqual({ url: "https://op.test/home/logo.svg", source: "img-logo" });
    expect(c).toContainEqual({ url: "https://op.test/fav.png", source: "icon" });
    expect(c).toContainEqual({ url: "https://cdn.test/og.jpg", source: "og-image" });
    expect(c.some((x) => /visa/.test(x.url))).toBe(false);
  });
  test("adds well-known paths and icon services even for a bot-walled page", () => {
    const empty = discoverFromHtml("", "https://op.test/");
    expect(empty.map((x) => x.source)).toEqual(["well-known", "well-known", "icon-service", "icon-service"]);
  });
});

describe("squareLogoUrl", () => {
  test("pads to a transparent square, never crops", () => {
    const u = squareLogoUrl("https://op.test/a b.png?x=1&y=2");
    expect(u).toContain("fit=contain");
    expect(u).toContain("w=256&h=256");
    expect(u).toContain("cbg=transparent");
    expect(u).toContain(encodeURIComponent("op.test/a b.png?x=1&y=2"));
    expect(squareLogoUrl("data:image/png;base64,xx")).toBeNull();
  });
});

describe("writeRefusal", () => {
  const ok = { DRY_RUN: "false", IMAGE_PROVIDER: "cloudinary", SUPABASE_SERVICE_ROLE_KEY: "k", ONLY: "winwink" };
  test("a dry run is always allowed", () => expect(writeRefusal({})).toBeNull());
  test("a write without IMAGE_PROVIDER is refused (default is the frozen Supabase bucket)", () => {
    expect(writeRefusal({ ...ok, IMAGE_PROVIDER: undefined })).toMatch(/IMAGE_PROVIDER/);
    expect(writeRefusal({ ...ok, IMAGE_PROVIDER: "supabase" })).toMatch(/IMAGE_PROVIDER/);
  });
  test("a blind bulk write is refused", () => expect(writeRefusal({ ...ok, ONLY: undefined })).toMatch(/ONLY|PICKS/));
  test("LOGO_URL needs exactly one slug", () => expect(writeRefusal({ ...ok, ONLY: "a,b", LOGO_URL: "https://x" })).toMatch(/LOGO_URL/));
  test("a write needs the service key", () => expect(writeRefusal({ ...ok, SUPABASE_SERVICE_ROLE_KEY: "" })).toMatch(/SERVICE_ROLE/));
  test("the safe write passes", () => {
    expect(writeRefusal(ok)).toBeNull();
    expect(writeRefusal({ ...ok, ONLY: undefined, PICKS: "out/p.json", IMAGE_PROVIDER: "r2" })).toBeNull();
  });
});

describe("parsePicks + contactSheet", () => {
  test("comment keys are skipped and bad URLs reported", () => {
    const { picks, bad } = parsePicks(JSON.stringify({ _note: "x", a: "https://a.test/l.png", b: "nope" }));
    expect(picks).toEqual({ a: "https://a.test/l.png" });
    expect(bad).toEqual(["b"]);
  });
  test("the sheet escapes names and shows a miss plainly", () => {
    const html = contactSheet([{ slug: "x", name: "<b>X</b>", why: "missing", current: null, pick: null, rejected: "icon: too small" }], { date: "2026-10-23" });
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(html).toContain("no usable logo found");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
});

describe("monthly-logos.yml", () => {
  test("the scheduled job can never write", async () => {
    const y = await Bun.file(new URL("../.github/workflows/monthly-logos.yml", import.meta.url)).text();
    expect(y).toMatch(/DRY_RUN:\s*"true"/);
    expect(y).not.toMatch(/DRY_RUN:\s*"?false/);
    expect(y).not.toMatch(/IMAGE_PROVIDER:/);
    expect(y).not.toMatch(/continue-on-error/);
  });
});
