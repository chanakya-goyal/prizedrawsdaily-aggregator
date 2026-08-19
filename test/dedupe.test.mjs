import { test, expect, describe } from "bun:test";
import { dedupe } from "../extractor.mjs";

const draw = (title, url, over = {}) => ({ title, entry_url: url, total_entries: 1000, draw_date: "2026-09-01T20:00:00+01:00", ticket_price: 1, ...over });

describe("dedupe keys on entry_url, not the title", () => {
  // The regression this replaces: keying on a 45-char title prefix collapsed 100 live
  // products to 34 at the-car-competition, losing five separate live "Win £250 Site Credit"
  // competitions that differ only in their URL.
  test("identical titles at different URLs are all kept", () => {
    const rows = [5, 6, 7, 8, 9].map((n) => draw("Win £250 Site Credit", `https://x.co.uk/competition/250sc-${n}/`));
    expect(dedupe(rows)).toHaveLength(5);
  });

  test("the same URL twice collapses to one", () => {
    const rows = [draw("Win a BMW", "https://x.co.uk/p/bmw/"), draw("Win a BMW", "https://x.co.uk/p/bmw/")];
    expect(dedupe(rows)).toHaveLength(1);
  });

  test("trailing slash, query and case are the same URL", () => {
    const rows = [
      draw("Win a BMW", "https://x.co.uk/p/bmw"),
      draw("Win a BMW", "https://x.co.uk/p/bmw/"),
      draw("Win a BMW", "https://x.co.uk/p/bmw/?utm_source=fb"),
    ];
    expect(dedupe(rows)).toHaveLength(1);
  });

  test("on a collision the more complete row wins", () => {
    const thin = draw("Win a BMW", "https://x.co.uk/p/bmw/", { total_entries: null, draw_date: null });
    const full = draw("Win a BMW", "https://x.co.uk/p/bmw/");
    expect(dedupe([thin, full])[0].total_entries).toBe(1000);
    expect(dedupe([full, thin])[0].total_entries).toBe(1000);
  });

  test("drops are reported so the loss is never silent again", () => {
    const dropped = [];
    dedupe([draw("A", "https://x.co.uk/p/a/"), draw("A", "https://x.co.uk/p/a/")], { onDrop: (d) => dropped.push(d) });
    expect(dropped).toHaveLength(1);
  });

  test("rows with no URL fall back to the title", () => {
    const rows = [draw("Win a BMW", null), draw("Win a BMW", null), draw("Win an Audi", null)];
    expect(dedupe(rows)).toHaveLength(2);
  });

  test("rows with neither URL nor title are discarded", () => {
    expect(dedupe([draw("", null)])).toHaveLength(0);
  });
});
