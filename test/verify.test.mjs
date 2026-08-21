import { test, expect, describe } from "bun:test";
import { verifyAgainstStored, ukDayKey, summarise, relistDecision, correctionDecision } from "../lib/verify.mjs";

const NOW = new Date("2026-08-19T10:00:00Z");
const SOON = "2026-08-30T20:00:00+01:00";

// A clean, internally-consistent car draw: passes fieldFlags (car pool £0.99 × 20000 = £19,800).
const base = {
  title: "Win This 2025 BMW M2 + £2,000 Cash!",
  grand_prize: "2025 BMW M2",
  category: "car-draws",
  ticket_price: 0.99,
  total_entries: 20000,
  draw_date: SOON,
  image_url: "https://ilnegxrsalmzpljotgpe.supabase.co/storage/v1/object/public/draw-images/x/y.webp",
  entry_url: "https://7daysperformance.co.uk/product/win-bmw-m2-210826",
  description: "A well formed description that is comfortably over twenty characters long.",
};
const stored = { ...base, prize_description: base.description };
const ok = (over = {}) => verifyAgainstStored(stored, { ...base, ...over }, { now: NOW, imageOk: true });

describe("verifyAgainstStored — publishes only when two observations agree", () => {
  test("identical re-observation with a good image publishes", () => {
    const v = ok();
    expect(v.publish).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.hasDrift).toBe(false);
  });

  test("a changed ticket price holds and names the drift", () => {
    const v = ok({ ticket_price: 1.99 });
    expect(v.publish).toBe(false);
    expect(v.reasons.join(" ")).toContain("ticket_price");
    expect(v.drift.ticket_price).toEqual([0.99, 1.99]);
  });

  test("price comparison is to 2dp, so float noise is not drift", () => {
    expect(ok({ ticket_price: 0.99000000001 }).publish).toBe(true);
  });

  // The apiStock-as-cap misfeature: "N in stock" is tickets REMAINING and drops daily.
  // Such rows must never publish, and the reason must say why.
  test("a moving total_entries holds — a cap does not move", () => {
    const v = ok({ total_entries: 19850 });
    expect(v.publish).toBe(false);
    expect(v.reasons.join(" ")).toContain("stock counter");
    expect(v.drift.total_entries).toEqual([20000, 19850]);
  });

  test("a different draw day holds", () => {
    const v = ok({ draw_date: "2026-08-31T20:00:00+01:00" });
    expect(v.publish).toBe(false);
    expect(v.reasons.join(" ")).toContain("draw_date");
  });

  // Operators nudge 8:45pm vs 9pm without it meaning anything.
  test("a different clock time on the SAME UK day still publishes", () => {
    expect(ok({ draw_date: "2026-08-30T21:45:00+01:00" }).publish).toBe(true);
  });

  test("a draw closing within the lead window holds", () => {
    const v = ok({ draw_date: "2026-08-19T10:30:00Z" });
    expect(v.publish).toBe(false);
    expect(v.reasons.join(" ")).toContain("closes too soon");
  });

  test("an already-closed draw holds", () => {
    expect(ok({ draw_date: "2026-08-18T20:00:00+01:00" }).publish).toBe(false);
  });
});

describe("verifyAgainstStored — title comparison", () => {
  test("entity/emoji/whitespace churn is not drift", () => {
    expect(ok({ title: "Win This 2025 BMW M2 + £2,000 Cash!  " }).publish).toBe(true);
    expect(ok({ title: "🚗 Win This 2025 BMW M2 + £2,000 Cash!" }).publish).toBe(true);
  });
  test("an appended suffix is containment, not drift", () => {
    expect(ok({ title: "Win This 2025 BMW M2 + £2,000 Cash! - AUTO DRAW" }).publish).toBe(true);
  });
  test("a genuinely different prize holds", () => {
    const v = ok({ title: "Win This Audi RS5 Performance", grand_prize: "Audi RS5" });
    expect(v.publish).toBe(false);
    expect(v.reasons.join(" ")).toContain("title changed");
  });
});

describe("verifyAgainstStored — image is required, not assumed", () => {
  test("an unreachable image holds", () => {
    const v = verifyAgainstStored(stored, base, { now: NOW, imageOk: false });
    expect(v.publish).toBe(false);
    expect(v.reasons.join(" ")).toContain("unreachable");
  });
  // Stricter than the human path on purpose: an unattended publisher cannot weigh
  // "probably fine", so an unverified image waits a day rather than shipping a broken card.
  test("an UNVERIFIED image (timeout) also holds", () => {
    const v = verifyAgainstStored(stored, base, { now: NOW, imageOk: null });
    expect(v.publish).toBe(false);
    expect(v.reasons.join(" ")).toContain("unverified");
  });
});

describe("verifyAgainstStored — fieldFlags still apply", () => {
  test("a car draw with an implausibly small pool holds even when both runs agree", () => {
    const tiny = { ...base, ticket_price: 0.01, total_entries: 600 }; // £6 pool
    const v = verifyAgainstStored({ ...tiny, prize_description: tiny.description }, tiny, { now: NOW, imageOk: true });
    expect(v.publish).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/pool/i);
  });
  test("a ticket price over the sanity ceiling holds", () => {
    const dear = { ...base, ticket_price: 75 };
    const v = verifyAgainstStored({ ...dear, prize_description: dear.description }, dear, { now: NOW, imageOk: true });
    expect(v.publish).toBe(false);
  });
  test("agreement alone cannot publish a row with a bad image url", () => {
    const bad = { ...base, image_url: "not-a-url" };
    const v = verifyAgainstStored({ ...bad, prize_description: bad.description }, bad, { now: NOW, imageOk: true });
    expect(v.publish).toBe(false);
  });
});

// No-guess publishing: an uncategorised draw is held as a draft until the cowork Claude routine
// stamps it. The next day's scrape re-reads the same page and resolves null AGAIN — the rules
// still can't classify it, which is why Claude had to. The stored row is the record of that
// decision, so the publish bar has to consult it or the stamp can never take effect.
describe("verifyAgainstStored — a stamped category survives a fresh null read", () => {
  test("a draft the DB has a category for publishes even when today's scrape can't re-derive one", () => {
    const v = verifyAgainstStored(
      { ...stored, category_id: "11111111-1111-1111-1111-111111111111" },
      { ...base, category: null },
      { now: NOW, imageOk: true },
    );
    expect(v.publish).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  test("an unstamped draft with no category is held, and the hold names the missing evidence", () => {
    const v = verifyAgainstStored(stored, { ...base, category: null }, { now: NOW, imageOk: true });
    expect(v.publish).toBe(false);
    expect(v.reasons).toContain("no category evidence");
  });
});

// Correcting a LIVE row is the only write that lands on the public site from ONE observation,
// so it gets no agreement test — which makes fieldFlags the only thing between a one-day
// misparse and a wrong price on a published card.
describe("correctionDecision — a flagged read never overwrites a live row", () => {
  const live = { ...stored, status: "active" };
  const decide = (over) => correctionDecision(live, { ...base, ...over }, { now: NOW });

  test("a clean read that disagrees corrects the row and names the fields", () => {
    const c = decide({ ticket_price: 1.49 });
    expect(c.correct).toBe(true);
    expect(c.fields).toEqual(["ticket_price"]);
    expect(c.flags).toEqual([]);
  });

  test("no drift is not a correction", () => {
    const c = decide({});
    expect(c.correct).toBe(false);
    expect(c.reason).toBe("no drift");
  });

  // The failure this guard exists for: the price parse breaks and reads £0.01, which is drift,
  // so the old code wrote it straight onto the live card. £0.01 × 20000 = a £200 "car draw".
  test("a misparsed price that collapses a car draw's pool is refused", () => {
    const c = decide({ ticket_price: 0.01 });
    expect(c.correct).toBe(false);
    expect(c.reason).toMatch(/flagged/);
    expect(c.flags.join(" ")).toMatch(/pool/i);
  });

  test("a fresh read whose image url stopped being a url is refused", () => {
    const c = decide({ image_url: "/wp-content/uploads/placeholder.png", ticket_price: 1.49 });
    expect(c.correct).toBe(false);
    expect(c.flags.join(" ")).toContain("image");
  });

  test("an absurd ticket price is refused rather than published as a correction", () => {
    expect(decide({ ticket_price: 750 }).correct).toBe(false);
  });

  // The scraper only attaches a template description on INSERT, so a live correction usually
  // arrives with no description at all; the stored one has to stand in or every correction
  // would be refused as "thin description".
  test("the stored description stands in for a fresh read that has none", () => {
    const { description, ...noDesc } = { ...base, draw_date: "2026-09-02T20:00:00+01:00" };
    const c = correctionDecision(live, noDesc, { now: NOW });
    expect(c.correct).toBe(true);
    expect(c.fields).toEqual(["draw_date"]);
  });
});

describe("ukDayKey", () => {
  test("resolves to the UK calendar day, not the viewer's", () => {
    expect(ukDayKey("2026-08-30T20:00:00+01:00")).toBe("2026-08-30");
    // 23:30 UTC in August is 00:30 the NEXT day in London (BST) — the UK day is what counts.
    expect(ukDayKey("2026-08-30T23:30:00Z")).toBe("2026-08-31");
  });
  test("null for unparseable input", () => {
    expect(ukDayKey("not a date")).toBe(null);
    expect(ukDayKey(null)).toBe(null);
  });
});

describe("summarise", () => {
  test("counts publishes, holds, and tallies reasons without their values", () => {
    const s = summarise([
      { publish: true, reasons: [] },
      { publish: false, reasons: ["ticket_price 0.25 → 0.5"] },
      { publish: false, reasons: ["ticket_price 1 → 2", "image not confirmed (unreachable)"] },
    ]);
    expect(s.published).toBe(1);
    expect(s.held).toBe(2);
    expect(s.heldReasons["ticket_price"]).toBe(2);
    expect(s.heldReasons["image not confirmed"]).toBe(1);
  });
});

// run.mjs is a top-level-await script that talks to Supabase on import, so its env parsing
// cannot be exercised by importing it. The one flag worth pinning anyway is the publish
// switch: if its default ever goes back to opt-OUT, every local/cowork invocation holding the
// service key publishes to the live site as a side effect. Assert the source, precisely.
describe("auto-publish is opt-in, and only the daily Action opts in", () => {
  test("run.mjs treats AUTO_PUBLISH as off unless it is explicitly \"true\"", async () => {
    const src = await Bun.file("run.mjs").text();
    expect(src).toContain('const AUTO_PUBLISH = process.env.AUTO_PUBLISH === "true";');
    expect(src).not.toContain('process.env.AUTO_PUBLISH !== "false"');
  });
  test("the daily workflow sets AUTO_PUBLISH explicitly", async () => {
    const yml = await Bun.file(".github/workflows/aggregate.yml").text();
    expect(yml).toMatch(/^\s*AUTO_PUBLISH:\s*"true"\s*$/m);
  });
});

describe("relistDecision — recurring competitions must be able to come back", () => {
  const NOW2 = new Date("2026-08-19T10:00:00Z");
  const ended = (drawDate) => ({ status: "ended", draw_date: drawDate });

  // Operators relist the SAME product URL for the next round, and ended-sweep closes a comp
  // as soon as it stops being purchasable — which is also what sold-out-awaiting-draw looks
  // like. run.mjs refuses to re-insert a seen entry_url, so both were permanent losses.
  test("an ended draw relisted for a later date revives", () => {
    const r = relistDecision(ended("2026-08-10T20:00:00+01:00"), { draw_date: "2026-08-26T20:00:00+01:00" }, NOW2);
    expect(r.revive).toBe(true);
  });

  test("a still-future stored draw is not a relist — it just sold out", () => {
    const r = relistDecision(ended("2026-08-25T20:00:00+01:00"), { draw_date: "2026-08-26T20:00:00+01:00" }, NOW2);
    expect(r.revive).toBe(false);
    expect(r.reason).toContain("has not run yet");
  });

  test("a fresh date in the past never revives", () => {
    expect(relistDecision(ended("2026-08-10T20:00:00+01:00"), { draw_date: "2026-08-12T20:00:00+01:00" }, NOW2).revive).toBe(false);
  });

  test("the same date again is a stale read, not a new round", () => {
    expect(relistDecision(ended("2026-08-10T20:00:00+01:00"), { draw_date: "2026-08-10T20:00:00+01:00" }, NOW2).revive).toBe(false);
  });

  test("active and draft rows are untouched by this path", () => {
    for (const status of ["active", "draft"]) {
      expect(relistDecision({ status, draw_date: "2026-08-10T20:00:00+01:00" }, { draw_date: "2026-08-26T20:00:00+01:00" }, NOW2).revive).toBe(false);
    }
  });

  test("missing dates on either side are safe", () => {
    expect(relistDecision(ended(null), { draw_date: "2026-08-26T20:00:00+01:00" }, NOW2).revive).toBe(false);
    expect(relistDecision(ended("2026-08-10T20:00:00+01:00"), { draw_date: null }, NOW2).revive).toBe(false);
    expect(relistDecision(null, null, NOW2).revive).toBe(false);
  });
});

describe("correctionDecision — a stale derived pool must self-heal", () => {
  const NOW3 = new Date("2026-08-19T10:00:00Z");
  const live = {
    status: "active", title: "£250 Amazon Voucher + Instant Wins #41", grand_prize: "£250 Amazon Voucher",
    category: "cash-prizes", ticket_price: 0.99, total_entries: 3400, total_prize_value: 3229.38,
    draw_date: "2026-09-01T20:00:00+01:00",
    image_url: "https://ilnegxrsalmzpljotgpe.supabase.co/x.webp",
    entry_url: "https://x.co.uk/product/a", prize_description: "A description over twenty characters long.",
  };
  const fresh = { ...live, total_prize_value: undefined, description: live.prize_description };

  // The inputs agree with today's scrape, so comparing them alone never notices; the row was
  // simply written when one of them was wrong. 33 live rows sat like this.
  test("a pool that disagrees with price × entries is corrected even when both inputs agree", () => {
    const c = correctionDecision(live, fresh, { now: NOW3 });
    expect(c.correct).toBe(true);
    expect(c.fields).toContain("total_prize_value");
    expect(c.drift.total_prize_value[1]).toBe(3366);
  });

  test("a pool that already matches is left alone", () => {
    const c = correctionDecision({ ...live, total_prize_value: 3366 }, fresh, { now: NOW3 });
    expect(c.correct).toBe(false);
    expect(c.reason).toBe("no drift");
  });

  test("a flagged fresh read is refused rather than written over a proven row", () => {
    const broken = { ...fresh, ticket_price: 0.99, total_entries: 3400, image_url: "not-a-url" };
    const c = correctionDecision(live, broken, { now: NOW3 });
    expect(c.correct).toBe(false);
    expect(c.reason).toContain("flagged");
  });
});

describe("correctionDecision — a pool-only drift must not rewrite the whole row", () => {
  const NOW4 = new Date("2026-08-19T10:00:00Z");
  const base4 = {
    status: "active", title: "Win This 2025 BMW M2", grand_prize: "2025 BMW M2", category: "car-draws",
    ticket_price: 0.99, total_entries: 20000, total_prize_value: 19800,
    draw_date: "2026-09-01T20:00:00+01:00",
    image_url: "https://ilnegxrsalmzpljotgpe.supabase.co/x.webp",
    entry_url: "https://x.co.uk/product/a", prize_description: "A description over twenty characters long.",
  };
  const fresh4 = { ...base4, description: base4.prize_description };

  // run.mjs patches only `total_prize_value` when that is the sole field in `fields` — the
  // caller relies on this being exact, so pin it.
  test("a stale pool is reported as the ONLY changed field", () => {
    const c = correctionDecision({ ...base4, total_prize_value: 17000 }, fresh4, { now: NOW4 });
    expect(c.correct).toBe(true);
    expect(c.fields).toEqual(["total_prize_value"]);
  });

  test("a real price change reports the input field too, so the full patch applies", () => {
    const c = correctionDecision(base4, { ...fresh4, ticket_price: 1.99 }, { now: NOW4 });
    expect(c.correct).toBe(true);
    expect(c.fields).toContain("ticket_price");
    expect(c.fields.some((f) => f !== "total_prize_value")).toBe(true);
  });

  test("a missing stored pool is not invented as drift", () => {
    const c = correctionDecision({ ...base4, total_prize_value: null }, fresh4, { now: NOW4 });
    expect(c.fields).not.toContain("total_prize_value");
  });
});
