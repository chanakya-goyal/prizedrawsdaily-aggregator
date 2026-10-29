import { test, expect, describe } from "bun:test";
import { relistIndex, relistKey, normTitle } from "../lib/relist-match.mjs";
import { permalinkKey } from "../lib/liveness.mjs";

const OP = "op-1";
const row = (over = {}) => ({
  id: "r1", operator_id: OP, status: "active", title: "Choose Your Paradise, £2500 Cruise/Holiday or £2000",
  ticket_price: 0.99, draw_date: "2026-10-30T19:00:00+00:00", entry_url: "https://x.co.uk/product/old/", created_at: "2026-10-01T00:00:00Z", ...over,
});
const fresh = (over = {}) => ({ title: "Choose Your Paradise, £2500 Cruise/Holiday or £2000", ticket_price: 0.99, draw_date: "2026-10-30T19:00:00+00:00", entry_url: "https://x.co.uk/product/new/", ...over });
const none = new Set();
const idx = (rows) => relistIndex(rows, permalinkKey);

describe("relist match: same operator + title + date + price under a new URL", () => {
  test("matches the stored row", () => {
    expect(idx([row()]).match(OP, fresh(), none)?.id).toBe("r1");
  });
  test("title is compared normalised (case, punctuation, emoji, dashes)", () => {
    const m = idx([row({ title: "INSTANT WIN – READERS PARADISE 📖" })]);
    expect(m.match(OP, fresh({ title: "Instant Win - Readers Paradise" }), none)?.id).toBe("r1");
    expect(normTitle("A-B c!")).toBe("abc");
  });
  test("date written with another offset is the same instant", () => {
    expect(idx([row()]).match(OP, fresh({ draw_date: "2026-10-30T20:00:00+01:00" }), none)?.id).toBe("r1");
  });
  test("draft rows match too", () => {
    expect(idx([row({ status: "draft" })]).match(OP, fresh(), none)?.id).toBe("r1");
  });
});

describe("genuinely different draws stay separate", () => {
  test("#24 vs #25", () => {
    const m = idx([row({ title: "Win a Rolex #24" })]);
    expect(m.match(OP, fresh({ title: "Win a Rolex #25" }), none)).toBeNull();
  });
  test("different close date", () => {
    expect(idx([row()]).match(OP, fresh({ draw_date: "2026-11-06T19:00:00+00:00" }), none)).toBeNull();
  });
  test("different ticket price", () => {
    expect(idx([row()]).match(OP, fresh({ ticket_price: 1.99 }), none)).toBeNull();
  });
  test("different operator", () => {
    expect(idx([row()]).match("op-2", fresh(), none)).toBeNull();
  });
  test("ended and rejected rows are never matched", () => {
    expect(idx([row({ status: "ended" })]).match(OP, fresh(), none)).toBeNull();
    expect(idx([row({ status: "rejected" })]).match(OP, fresh(), none)).toBeNull();
  });
  test("missing date or price never matches", () => {
    expect(relistKey(OP, fresh({ draw_date: null }))).toBeNull();
    expect(relistKey(OP, fresh({ ticket_price: null }))).toBeNull();
    expect(idx([row({ draw_date: null })]).match(OP, fresh({ draw_date: null }), none)).toBeNull();
  });
  test("the stored URL is still listed by the operator: two products, both kept", () => {
    const listed = new Set([permalinkKey("https://x.co.uk/product/old/")]);
    expect(idx([row()]).match(OP, fresh(), listed)).toBeNull();
  });
  test("the same URL is the ordinary byUrl path, not a re-list", () => {
    expect(idx([row()]).match(OP, fresh({ entry_url: "https://x.co.uk/product/old" }), none)).toBeNull();
  });
});

describe("one stored row is adopted once", () => {
  test("oldest first, then consumed", () => {
    const a = row({ id: "a", created_at: "2026-10-01T00:00:00Z", entry_url: "https://x.co.uk/a/" });
    const b = row({ id: "b", created_at: "2026-10-05T00:00:00Z", entry_url: "https://x.co.uk/b/" });
    const m = idx([b, a]);
    const first = m.match(OP, fresh(), none);
    expect(first.id).toBe("a");
    m.consume(first);
    expect(m.match(OP, fresh({ entry_url: "https://x.co.uk/c/" }), none).id).toBe("b");
  });
});
