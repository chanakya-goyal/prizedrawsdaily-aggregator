import { test, expect } from "bun:test";
import { buildHtml } from "../render.mjs";

const draw = { type: "draw", n: 1, title: "Rolex Daytona", price: "£4.97", closes: "CLOSES TONIGHT", slug: "x" };

test("buildHtml embeds theme + particle classes", () => {
  const html = buildHtml(draw, "luxury", { type: "golddust", count: 5 });
  expect(html).toContain('data-theme="luxury"');
  expect(html).toContain("p-golddust");
  expect(html).not.toContain("techfloor");
});

test("particles none renders no field", () => {
  const html = buildHtml(draw, "luxury", { type: "none", count: 0 });
  expect(html).not.toContain("p-none");
});

test("compliance footer always present", () => {
  for (const s of [draw, { type: "cta" }, { type: "intro", hook: "WIN LUXURY", count: 5, endLine: "X", thumbs: [] }]) {
    expect(buildHtml(s, "default", { type: "embers", count: 3 })).toContain("18+ · UK ONLY · PLAY RESPONSIBLY");
  }
});
