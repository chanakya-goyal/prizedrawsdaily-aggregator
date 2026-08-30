import { test, expect, describe } from "bun:test";
import { renderLivenessMode } from "../extractor.mjs";
import { saysFinished } from "../lib/liveness.mjs";

// The render path is 40 of 94 operators and had NO ingest-time finished check at all — the
// other three paths (woo is_purchasable, shopify variant availability, api adapters) were all
// guarded. These tests pin the mode selector and, more importantly, pin the wc-lottery
// non-regression: the guard must not resurrect the bug that expired 42 draws in ~38 minutes.

describe("renderLivenessMode", () => {
  test("defaults to report — evidence before enforcement", () => {
    expect(renderLivenessMode({})).toBe("report");
  });

  test("accepts the three real modes", () => {
    expect(renderLivenessMode({ RENDER_LIVENESS: "off" })).toBe("off");
    expect(renderLivenessMode({ RENDER_LIVENESS: "report" })).toBe("report");
    expect(renderLivenessMode({ RENDER_LIVENESS: "enforce" })).toBe("enforce");
  });

  test("is case-insensitive", () => {
    expect(renderLivenessMode({ RENDER_LIVENESS: "ENFORCE" })).toBe("enforce");
  });

  // A typo must not silently disable the guard, and must not silently start dropping rows
  // either. Falling back to the reporting default is the only safe reading.
  test("an unrecognised value falls back to report, never to off or enforce", () => {
    expect(renderLivenessMode({ RENDER_LIVENESS: "enfroce" })).toBe("report");
    expect(renderLivenessMode({ RENDER_LIVENESS: "" })).toBe("report");
  });
});

describe("the guard must not resurrect the wc-lottery bug", () => {
  // Measured 2026-08-26: wc-lottery ships its i18n string bundle inside a <script> on EVERY
  // page it renders, live or not. Testing the raw HTML matched every draw on 40 operators and
  // expired 42 of them within ~38 minutes, with draw_dates still in the future.
  const LIVE_WC_LOTTERY = `<!doctype html><html><head>
    <script id="wc-lottery-i18n" type="application/json">
      {"sold_out":"Sold out","finished":"This competition has finished"}
    </script></head>
    <body><h1>Win a Range Rover Sport</h1><p>Only 4,000 tickets. Entry from £4.00.</p>
    <button>Add to basket</button></body></html>`;

  const GENUINELY_FINISHED = `<!doctype html><html><head>
    <script id="wc-lottery-i18n" type="application/json">
      {"sold_out":"Sold out","finished":"This competition has finished"}
    </script></head>
    <body><h1>Win a Range Rover Sport</h1>
    <p class="notice">This competition has finished. The winner was drawn on Friday.</p>
    </body></html>`;

  test("a live wc-lottery page is NOT treated as finished", () => {
    expect(saysFinished(LIVE_WC_LOTTERY)).toBe(false);
  });

  test("the same page with a VISIBLE finished notice IS treated as finished", () => {
    expect(saysFinished(GENUINELY_FINISHED)).toBe(true);
  });

  // The guard passes `d.html`, never `d.text`. saysFinished does its own <template>/<noscript>
  // stripping and that stripping is the whole point — handing it pre-stripped text would
  // change what it sees.
  test("template and noscript content is still ignored", () => {
    expect(saysFinished(`<body><template><p>This competition has finished</p></template>
      <h1>Win a Rolex</h1></body>`)).toBe(false);
    expect(saysFinished(`<body><noscript>This draw has ended</noscript>
      <h1>Win a Rolex</h1></body>`)).toBe(false);
  });
});
