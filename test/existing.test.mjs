// run.mjs's start-of-run snapshot used to download every column of every draw — 9,335 rows,
// ~8 MB raw / ~2 MB on the wire, several times a day — although two thirds of them are ended
// and the routing decision reads only a handful of fields from an ended row. These pin down
// (a) which fields that is, so a future change to routeDraw cannot silently start reading a
// column the lean read no longer fetches, and (b) that the merged snapshot keeps the order and
// the full rows the old single read produced.
import { test, expect, describe } from "bun:test";
import { routeDraw } from "../lib/route.mjs";
import {
  MUTABLE_STATUSES, IDENTITY_COLUMNS, FULL_COLUMNS, mergeExisting, loadExisting,
} from "../lib/existing.mjs";

const NOW = new Date("2026-09-06T12:00:00Z");
const CAT = { "cash-prizes": "cat-cash", "car-draws": "cat-car" };
const DESC = "Enter this cash competition for the chance to win £1,000 paid straight to your bank. "
  + "Tickets are £1 each with 2,000 available, and the draw is held live once the timer ends.";
const fresh = (over = {}) => ({
  title: "Win £1,000 Cash", grand_prize: "£1,000", category: "cash-prizes", description: DESC,
  ticket_price: 1, total_entries: 2000, draw_date: "2026-09-20T20:00:00+01:00",
  image_url: "https://cdn.test/a.jpg", entry_url: "https://op.test/c/a",
  total_entries_method: "labelled-cap", figures_source_url: "https://op.test/c/a", ...over,
});
const full = (over = {}) => ({
  id: "row-1", entry_url: "https://op.test/c/a", slug: "win-1000-cash-op", status: "ended",
  title: "Win £1,000 Cash", ticket_price: 1, total_entries: 2000, total_prize_value: 2000,
  draw_date: "2026-08-20T20:00:00+01:00", image_url: "https://our.storage/a.jpg",
  prize_description: DESC, category_id: "cat-cash", category_source: "rule",
  created_at: "2026-08-01T12:00:00Z", ...over,
});
const cols = (list) => list.split(",");
const pick = (row, list) => Object.fromEntries(cols(list).filter((k) => k in row).map((k) => [k, row[k]]));

// Every field routeDraw touches on the stored row, recorded through a Proxy.
function readsOf(existing, f) {
  const seen = new Set();
  const spy = new Proxy(existing, { get(t, k) { if (typeof k === "string") seen.add(k); return t[k]; } });
  routeDraw(spy, f, { now: NOW, catMap: CAT, autoPublish: true });
  return seen;
}

// The scenarios an ended (or otherwise non-mutable) row can meet: relisted for a later date,
// re-seen with the date that already ended, re-seen with no date, a judged category, and an
// unknown status.
const NON_MUTABLE_CASES = [
  ["relisted for a later draw", full(), fresh({ draw_date: "2026-10-01T20:00:00+01:00" })],
  ["same ended date", full(), fresh({ draw_date: "2026-08-20T20:00:00+01:00" })],
  ["fresh read has no date", full(), fresh({ draw_date: null })],
  ["judged category is kept on relist", full({ category_source: "claude" }), fresh({ draw_date: "2026-10-01T20:00:00+01:00", category: "car-draws" })],
  ["stored date still ahead", full({ draw_date: "2026-09-30T20:00:00+01:00" }), fresh({ draw_date: "2026-10-01T20:00:00+01:00" })],
  ["an unknown status", full({ status: "archived" }), fresh()],
];

describe("the lean read covers everything routing reads from a non-mutable row", () => {
  for (const [name, row, f] of NON_MUTABLE_CASES) {
    test(`${name}: every field read is in IDENTITY_COLUMNS`, () => {
      const missing = [...readsOf(row, f)].filter((k) => !cols(IDENTITY_COLUMNS).includes(k));
      expect(missing).toEqual([]);
    });
    test(`${name}: the decision is identical from the lean row and the full row`, () => {
      const opts = { now: NOW, catMap: CAT, autoPublish: true };
      expect(routeDraw(pick(row, IDENTITY_COLUMNS), f, opts)).toEqual(routeDraw(row, f, opts));
    });
  }

  test("run.mjs itself only needs id + slug from a routed row (plus entry_url/slug/status for the maps)", () => {
    for (const k of ["id", "slug", "entry_url", "status"]) expect(cols(IDENTITY_COLUMNS)).toContain(k);
  });

  test("the full column list is unchanged from the single read it replaces", () => {
    expect(FULL_COLUMNS).toBe("id,entry_url,slug,status,title,ticket_price,total_entries,total_prize_value,draw_date,image_url,prize_description,category_id,category_source,created_at");
  });

  test("identity columns are a subset of the full columns", () => {
    for (const k of cols(IDENTITY_COLUMNS)) expect(cols(FULL_COLUMNS)).toContain(k);
  });

  test("only active and draft rows can still change", () => {
    expect(MUTABLE_STATUSES).toEqual(["active", "draft"]);
  });
});

describe("mergeExisting", () => {
  const lean = (id, status, extra = {}) => ({ id, entry_url: `https://op.test/${id}`, slug: `s-${id}`, status, draw_date: null, category_source: null, ...extra });
  test("keeps the identity read's order and swaps in the full row for mutable statuses", () => {
    const ident = [lean("a", "ended"), lean("b", "active"), lean("c", "ended"), lean("d", "draft")];
    const fulls = [full({ id: "d", status: "draft" }), full({ id: "b", status: "active" })];
    const out = mergeExisting(ident, fulls);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(out[1]).toBe(fulls[1]);
    expect(out[3]).toBe(fulls[0]);
    expect(out[0]).toEqual(ident[0]);
  });
  test("a full row inserted between the two reads is still included", () => {
    const out = mergeExisting([lean("a", "ended")], [full({ id: "z", status: "draft" })]);
    expect(out.map((r) => r.id)).toEqual(["a", "z"]);
  });
});

describe("loadExisting", () => {
  // A fake paginated getter over an in-memory table that honours select= and the two filters
  // loadExisting uses, so the test exercises the real query strings.
  function fakeGetAll(table) {
    const calls = [];
    const getAll = async (path) => {
      calls.push(path);
      const q = new URLSearchParams(path.split("?")[1]);
      let rows = table;
      const st = q.get("status");
      if (st?.startsWith("in.(")) { const set = st.slice(4, -1).split(","); rows = rows.filter((r) => set.includes(r.status)); }
      const id = q.get("id");
      if (id?.startsWith("in.(")) { const set = id.slice(4, -1).split(","); rows = rows.filter((r) => set.includes(r.id)); }
      return rows.map((r) => pick(r, q.get("select")));
    };
    return { getAll, calls };
  }
  const table = [
    full({ id: "a", status: "ended" }),
    full({ id: "b", status: "active", entry_url: "https://op.test/b" }),
    full({ id: "c", status: "draft", entry_url: "https://op.test/c" }),
    full({ id: "d", status: "ended", entry_url: "https://op.test/d" }),
  ];

  test("returns exactly what the single full read returned for active/draft rows, lean rows otherwise", async () => {
    const { getAll } = fakeGetAll(table);
    const out = await loadExisting(getAll);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(out[1]).toEqual(pick(table[1], FULL_COLUMNS));
    expect(out[2]).toEqual(pick(table[2], FULL_COLUMNS));
    expect(out[0]).toEqual(pick(table[0], IDENTITY_COLUMNS));
  });

  test("asks for full columns only for mutable statuses", async () => {
    const { getAll, calls } = fakeGetAll(table);
    await loadExisting(getAll);
    expect(calls[0]).toBe(`draws?select=${IDENTITY_COLUMNS}`);
    expect(calls[1]).toBe(`draws?select=${FULL_COLUMNS}&status=in.(active,draft)`);
    expect(calls.length).toBe(2);
  });

  test("a row that became draft between the two reads is fetched in full by id", async () => {
    // The identity read sees 'd' as draft, but the full read ran while it was still ended, so
    // it never came back in full. Routing a draft against missing fields would misjudge it.
    const before = fakeGetAll(table);
    const after = fakeGetAll(table.map((r) => (r.id === "d" ? { ...r, status: "draft" } : r)));
    const calls = [];
    const getAll = (path) => {
      calls.push(path);
      return path.includes("status=in.") ? before.getAll(path) : after.getAll(path);
    };
    const out = await loadExisting(getAll);
    const d = out.find((r) => r.id === "d");
    expect(d).toEqual({ ...pick(table[3], FULL_COLUMNS), status: "draft" });
    expect(calls).toContain(`draws?select=${FULL_COLUMNS}&id=in.(d)`);
  });
});
