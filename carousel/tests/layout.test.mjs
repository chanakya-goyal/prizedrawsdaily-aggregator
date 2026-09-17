import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { chromium } from "playwright";
import { buildHtml, ODDS_PAD } from "../render.mjs";

// Four overlaps shipped in the first build of the loud treatment, and every one was invisible in
// review and obvious on the render: the photo well over the text stack, the closes chip over the
// operator lockup, the press stamp through the slide counter, the stamp over the chip. They were
// found by MEASURING rects in a real browser, so that is what guards them.
//
// The stack overlap is the instructive one. The odds block's vertical padding was hardcoded in
// the renderer's height reservation AND in the stylesheet, the two disagreed by 10px, and the
// photo well overran the lockup by exactly the difference. Geometry catches that class of bug;
// asserting markup never would.
//
// EVERY FIXTURE IS MEASURED ONCE, in beforeAll, and the tests are pure assertions over the
// cached rects. The first version measured per test and was flaky: each buildHtml inlines ~1.5MB
// of base64 woff2, and doing that eighteen times blew through Bun's 5s default per-test timeout
// whenever the rest of the suite was competing for the machine. A geometry gate that goes red
// for reasons unrelated to geometry is a gate somebody switches off.

const band = ["CLOSES THU 18 SEP · £1.99 A TICKET", "Enter · terms · example.com", "Free-entry route and age limits: in those terms."];
const base = { stamp: "READ 09:04", n: 3, total: 10, operator: "Example Competitions Ltd", rating: "4.2", band };
// A 1x1 transparent GIF. The layout is what is under test; a network fetch would make these
// tests fail for reasons that have nothing to do with geometry.
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const SELECTORS = [".photo", ".closes-chip", ".stack", ".col", ".lockup", ".prize", ".oddsblock",
                   ".counter", ".stamp", ".masthead", ".band", ".grid", ".legend", ".board", ".headline"];

const FIXTURES = {
  "draw/two-line": { ...base, type: "draw", title: "12 DOZEN BRIDGESTONE TOUR B RXS GOLF BALLS", cap: 9999, photo: PIXEL, soon: true, closesChip: "CLOSES THU 18 SEP", stampWord: "CLOSES TODAY" },
  "draw/one-line": { ...base, type: "draw", title: "Rolex Daytona", cap: 699, photo: PIXEL, soon: true, closesChip: "CLOSES THU 18 SEP", stampWord: "CLOSES TODAY" },
  "count/99":      { ...base, type: "count", n: 2, index: 1, drawsRendered: 8, title: "SHOT SCOPE LM1 LAUNCH MONITOR", cap: 99 },
  "count/699":     { ...base, type: "count", n: 2, index: 1, drawsRendered: 8, title: "SHOT SCOPE LM1 LAUNCH MONITOR", cap: 699 },
  "count/1440":    { ...base, type: "count", n: 2, index: 1, drawsRendered: 8, title: "SHOT SCOPE LM1 LAUNCH MONITOR", cap: 1440 },
  "count/9999":    { ...base, type: "count", n: 2, index: 1, drawsRendered: 8, title: "SHOT SCOPE LM1 LAUNCH MONITOR", cap: 9999 },
  "count/4.5m":    { ...base, type: "count", n: 2, index: 1, drawsRendered: 8, title: "SHOT SCOPE LM1 LAUNCH MONITOR", cap: 4500000 },
  "cover":         { ...base, type: "cover", dateline: "THU 18 SEP 2026 · READ 09:04", headline: "8 DRAWS. HOW MANY TICKETS?", proof: ["a", "b"], board: [{ prize: "Rolex Daytona", closes: "THU 18 SEP" }, { more: "+5 more inside" }] },
  "closing":       { ...base, type: "closing" },
};

const R = {};            // fixture name -> { selector -> rect }
let extras = {};         // fixture name -> extra measurements

// The <style> blocks carry ~1.5MB of base64 woff2, and setContent re-parses all of it on every
// call. Nine fixtures meant thirteen megabytes of stylesheet parsing, which is what pushed this
// file past its timeout whenever another test file spawned a subprocess. So: set the document
// ONCE, then swap only <body> for each subsequent fixture. The fonts parse a single time and the
// measurements are identical, because the stylesheet is the same object throughout.
const bodyOf = (html) => {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/);
  return m ? m[1] : html;
};
const roleOf = (html) => (html.match(/data-pdd-role="([^"]+)"/) || [, ""])[1];

beforeAll(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  let first = true;
  for (const [name, slide] of Object.entries(FIXTURES)) {
    const html = buildHtml(slide, "sports-outdoors");
    if (first) {
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60000 });
      first = false;
    } else {
      await page.evaluate(({ body, role }) => {
        document.body.setAttribute("data-pdd-role", role);
        window.__ready = false;
        document.body.innerHTML = body;
        // innerHTML does not execute <script>, so re-run the readiness probe by hand.
        const w = (im) => (!im || im.complete) ? null : new Promise((r) => { im.onload = r; im.onerror = r; });
        return Promise.all([...document.images].map(w).filter(Boolean))
          .then(() => document.fonts.ready).then(() => { window.__ready = true; });
      }, { body: bodyOf(html), role: roleOf(html) });
    }
    await page.waitForFunction("window.__ready === true", { timeout: 30000 });
    const got = await page.evaluate((sels) => {
      const out = { rects: {}, objectFit: null, bandOverflow: [], boardOverflow: [] };
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const b = el.getBoundingClientRect();
        out.rects[sel] = { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
      }
      const img = document.querySelector(".photo img");
      if (img) out.objectFit = getComputedStyle(img).objectFit;
      out.bandOverflow = [...document.querySelectorAll(".band .l")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent.slice(0, 40));
      out.boardOverflow = [...document.querySelectorAll(".board .pz")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent.slice(0, 40));
      return out;
    }, SELECTORS);
    R[name] = got.rects;
    extras[name] = got;
  }
  await browser.close();
}, 180000);

const overlaps = (a, b) => !!a && !!b && !(a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left);
const PAIRS = [[".photo", ".stack"], [".closes-chip", ".lockup"], [".stamp", ".counter"],
               [".stamp", ".closes-chip"], [".lockup", ".oddsblock"], [".prize", ".oddsblock"],
               [".masthead", ".photo"], [".oddsblock", ".band"], [".masthead", ".col"],
               [".col", ".band"], [".headline", ".board"], [".counter", ".board"]];

describe("nothing overlaps anything, on any slide", () => {
  for (const name of Object.keys(FIXTURES)) {
    test(name, () => {
      const bad = PAIRS.filter(([a, b]) => overlaps(R[name][a], R[name][b])).map(([a, b]) => `${a}/${b}`);
      expect(bad).toEqual([]);
    });
  }
});

describe("every column closes inside the 1050px well", () => {
  for (const name of Object.keys(FIXTURES)) {
    test(name, () => {
      const c = R[name][".col"] || R[name][".stack"] || R[name][".closing"];
      if (!c) return;
      expect(c.top).toBeGreaterThanOrEqual(132);
      expect(c.bottom).toBeLessThanOrEqual(1182);
    });
  }
});

describe("standing chrome is identical on every slide", () => {
  for (const name of Object.keys(FIXTURES)) {
    test(name, () => {
      expect(R[name][".masthead"]).toMatchObject({ top: 0, bottom: 132, left: 0, right: 1080 });
      expect(R[name][".band"]).toMatchObject({ top: 1182, bottom: 1350, left: 0, right: 1080 });
    });
  }
});

describe("measured fit — nothing is allowed to run off its track", () => {
  for (const name of Object.keys(FIXTURES)) {
    test(`${name}: conditions band stays inside 950px`, () => {
      // The band is the CAP 8.17 significant-conditions surface. It is never shrunk and a legal
      // line is never truncated, so an overflow means a required condition left the frame.
      expect(extras[name].bandOverflow).toEqual([]);
    });
  }
  test("the board's prize column truncates rather than overflowing", () => {
    expect(extras["cover"].boardOverflow).toEqual([]);
  });
});

describe("the odds device", () => {
  test("the block reserves exactly the height it paints", () => {
    // The whole reason --odds-pad is one constant read from both sides.
    const b = R["draw/two-line"][".oddsblock"];
    expect(Math.round(b.bottom - b.top)).toBe(240 + ODDS_PAD * 2);
  });
  test("the count slide withholds the rail block — the grid is its hero there", () => {
    expect(R["count/699"][".oddsblock"]).toBeUndefined();
    expect(R["count/699"][".grid"]).toBeDefined();
  });
  for (const name of ["count/99", "count/699", "count/1440", "count/9999", "count/4.5m"]) {
    test(`${name}: the grid stays inside the content well`, () => {
      const g = R[name][".grid"];
      expect(g.left).toBeGreaterThanOrEqual(65);
      expect(Math.round(g.right)).toBeLessThanOrEqual(960);
    });
  }
});

describe("the photograph", () => {
  test("shows the whole prize rather than a crop of it", () => {
    // `cover` on a ~1.7:1 well cropped square operator assets down to a patch of background —
    // a golf trolley rendered as white space.
    expect(extras["draw/two-line"].objectFit).toBe("contain");
  });
  for (const name of ["draw/two-line", "draw/one-line"]) {
    test(`${name}: the well never falls below its 500px floor`, () => {
      const p = R[name][".photo"];
      expect(p.bottom - p.top).toBeGreaterThanOrEqual(500);
    });
  }
});
