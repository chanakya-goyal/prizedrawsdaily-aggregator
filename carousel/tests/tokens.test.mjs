import { test, expect, describe } from "bun:test";
import { TOKENS, tokenCss, px } from "../tokens.mjs";

// §3.7's seventh constraint, as a test. Every var(--x) in an emitted stylesheet must resolve to
// a property that actually exists, asserted at build time beside the no-double-definition check.
//
// This caught a real regression the moment it was written. --font-display lived only in the
// LEGACY :root block; when that block was deleted — correctly, because its 32 consumers had all
// been migrated — the display font silently fell back to the generic stack. Nothing threw,
// nothing failed, and every other test still passed, because an undefined custom property on an
// inherited property just inherits. That is the exact failure mode the constraint exists for,
// and it is why the check is a test rather than a convention.

const CSS = await Bun.file(new URL("../styles.css", import.meta.url)).text();
const refs = (css) => new Set([...css.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map((m) => m[1]));
const withFallback = (css) => new Set([...css.matchAll(/var\((--[A-Za-z0-9-]+)\s*,/g)].map((m) => m[1]));

describe("every token a stylesheet consumes is defined", () => {
  test("styles.css has no unresolved var() without a fallback", () => {
    const missing = [...refs(CSS)].filter((r) => !(r in TOKENS) && !withFallback(CSS).has(r));
    expect(missing).toEqual([]);
  });
  test("the display, text, figure and chrome faces are all defined", () => {
    // A missing face degrades to the next family in the stack, silently, and the frame still
    // renders — just in the wrong typeface.
    for (const f of ["--font-display", "--font-text", "--font-figure", "--font-chrome"]) {
      expect(TOKENS[f], f).toBeTruthy();
    }
  });
});

describe("the stylesheet no longer declares or scrapes anything", () => {
  test("styles.css declares no :root of its own", () => {
    // Tokens are injected from here; a second declaration would mean two sources of truth, and
    // across two lifted blocks the last one wins silently.
    expect(CSS).not.toMatch(/(?:^|\n)\s*:root\s*\{/);
  });
  test("no [data-theme] survives anywhere in it", () => {
    // Per-category identity is STRUCTURE and comes from scene.mjs. A theme block could only ever
    // carry colour, and only to the surfaces that scraped it.
    expect(CSS).not.toContain("data-theme");
  });
  test("the particle skeletons are gone", () => {
    for (const p of ["p-embers", "p-golddust", "p-fireflies", "p-holo"]) expect(CSS).not.toContain(p);
  });
});

describe("no property is defined twice", () => {
  test("tokenCss() emits each name exactly once", () => {
    const names = [...tokenCss().matchAll(/(--[A-Za-z0-9-]+):/g)].map((m) => m[1]);
    expect(names.length).toBe(new Set(names).size);
    expect(names.length).toBe(Object.keys(TOKENS).length);
  });
});

describe("the type scale", () => {
  test("nothing renders below 34px", () => {
    // The old deck put 18 of its 28 type sizes at 46px or under, which is about 7px in the
    // profile grid. This is the floor that replaced them.
    const steps = Object.entries(TOKENS).filter(([k]) => /^--fs-/.test(k)).map(([, v]) => parseFloat(v));
    expect(steps.length).toBe(9);
    expect(Math.min(...steps)).toBe(34);
    expect(Math.max(...steps)).toBe(150);
  });
  test("px() parses a value and refuses one that is not a length", () => {
    expect(px("--gutter")).toBe(65);
    expect(px("--fs-hero")).toBe(150);
    expect(() => px("--ink")).toThrow(/not a px value/);
  });
  test("the gutter is 65px everywhere, and 70 is retired", () => {
    expect(TOKENS["--gutter"]).toBe("65px");
  });
});
