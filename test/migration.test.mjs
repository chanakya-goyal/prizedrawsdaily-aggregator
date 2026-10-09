import { expect, test, describe } from "bun:test";
import { selectToMove, emptyGate } from "../lib/migration.mjs";

// Why this file exists: the plan is to move EVERY draw photo to Cloudinary and then empty
// the Supabase `draw-images` bucket, leaving the Supabase project with only its database.
// Emptying is the one irreversible step in the whole move, so the rule that decides whether
// it may run is a pure function, pinned here — above all "refuse while ANY row still points
// at Supabase": deleting an object a live row still loads is a broken image on the site.

const SB = "https://proj.supabase.co/storage/v1/object/public/draw-images/";
const CDN = "https://res.cloudinary.com/pdd/image/upload/v1/";
const DEAD = "https://kkuuwksgyypicnblwubs.supabase.co/storage/v1/object/public/draw-images/";

describe("selectToMove — every row on the live Supabase bucket, any status", () => {
  const opts = { sbPrefix: SB, cloudBase: CDN };

  test("active, draft AND long-ended draws all move", () => {
    const draws = [
      { id: 1, status: "active", image_url: `${SB}op/a.webp` },
      { id: 2, status: "draft", image_url: `${SB}op/b.webp` },
      { id: 3, status: "ended", draw_date: "2025-01-01T00:00:00Z", image_url: `${SB}op/c.webp` },
    ];
    const { move } = selectToMove({ draws, operators: [], ...opts });
    expect([...move.keys()].sort()).toEqual(["op/a.webp", "op/b.webp", "op/c.webp"]);
  });

  test("rows are recorded as table.id, shared keys once", () => {
    const draws = [
      { id: 1, status: "active", image_url: `${SB}op/s.webp` },
      { id: 2, status: "ended", image_url: `${SB}op/s.webp` },
    ];
    const operators = [{ id: "o1", logo_url: `${SB}operator-logos/acme.webp` }];
    const { move } = selectToMove({ draws, operators, ...opts });
    expect(move.get("op/s.webp")).toEqual(["draws.1", "draws.2"]);
    expect(move.get("operator-logos/acme.webp")).toEqual(["operators.o1"]);
  });

  test("dead-project, hotlinked and empty URLs are skipped; already-moved rows are counted", () => {
    const draws = [
      { id: 1, status: "active", image_url: `${DEAD}op/x.webp` },
      { id: 2, status: "active", image_url: "https://operator.co.uk/x.jpg" },
      { id: 3, status: "active", image_url: null },
      { id: 4, status: "active", image_url: `${CDN}op/moved.webp` },
    ];
    const r = selectToMove({ draws, operators: [], ...opts });
    expect(r.move.size).toBe(0);
    expect(r.skipped).toEqual({ dead: 1, foreign: 1, empty: 1, alreadyMoved: 1 });
    expect(r.onCloud.get("op/moved")).toEqual(["draws.4"]);
  });
});

describe("emptyGate — may the Supabase bucket be emptied?", () => {
  const sha = "a".repeat(64);
  const good = (bytes) => ({ manifestBytes: bytes, sha256: sha, diskBytes: bytes, diskSha256: sha });
  const base = () => ({
    bucket: [{ path: "op/a.webp", size: 100 }, { path: "op/orphan.webp", size: 50 }],
    backup: new Map([["op/a.webp", good(100)], ["op/orphan.webp", good(50)]]),
    stillOnSupabase: [],
    onCloud: new Map([["op/a", ["draws.1"]]]),
    cloudOk: new Map([["op/a", true]]),
  });

  test("everything backed up, moved and verified → every object is deletable", () => {
    const r = emptyGate(base());
    expect(r.refuse).toBe(false);
    expect(r.deletable.sort()).toEqual(["op/a.webp", "op/orphan.webp"]);
    expect(r.bytes).toBe(150);
  });

  test("ANY row still pointing at Supabase refuses the whole run and deletes nothing", () => {
    const r = emptyGate({ ...base(), stillOnSupabase: ["draws.77"] });
    expect(r.refuse).toBe(true);
    expect(r.deletable).toEqual([]);
    expect(r.reasons.join("\n")).toMatch(/draws\.77/);
  });

  test("a referenced key whose backup is missing refuses the run", () => {
    const g = base();
    g.backup.delete("op/a.webp");
    const r = emptyGate(g);
    expect(r.refuse).toBe(true);
    expect(r.deletable).toEqual([]);
  });

  test("a backup whose bytes or hash do not match refuses the run", () => {
    for (const bad of [
      { ...good(100), diskBytes: 99 },
      { ...good(100), manifestBytes: 99, diskBytes: 99 },
      { ...good(100), diskSha256: "b".repeat(64) },
    ]) {
      const g = base();
      g.backup.set("op/a.webp", bad);
      expect(emptyGate(g).refuse).toBe(true);
    }
  });

  test("a referenced key whose Cloudinary copy did not verify refuses the run", () => {
    const g = base();
    g.cloudOk.set("op/a", "size 99 != 100");
    const r = emptyGate(g);
    expect(r.refuse).toBe(true);
    expect(r.reasons.join("\n")).toMatch(/size 99/);
  });

  test("a referenced key never checked on Cloudinary refuses the run", () => {
    const g = base();
    g.cloudOk.delete("op/a");
    expect(emptyGate(g).refuse).toBe(true);
  });

  test("an orphan without a good backup is KEPT, but does not block the rest", () => {
    const g = base();
    g.backup.delete("op/orphan.webp");
    const r = emptyGate(g);
    expect(r.refuse).toBe(false);
    expect(r.deletable).toEqual(["op/a.webp"]);
    expect(r.kept.map((k) => k.path)).toEqual(["op/orphan.webp"]);
  });

  test("a row referencing the key by a different extension on Cloudinary still counts as referenced", () => {
    // op/x.jpg holding PNG bytes is stored on Cloudinary as op/x.png — one asset, same public_id.
    const g = base();
    g.bucket = [{ path: "op/x.jpg", size: 10 }];
    g.backup = new Map([["op/x.jpg", good(10)]]);
    g.onCloud = new Map([["op/x", ["draws.5"]]]);
    g.cloudOk = new Map();
    expect(emptyGate(g).refuse).toBe(true); // referenced, not verified → refuse
    g.cloudOk.set("op/x", true);
    expect(emptyGate(g).deletable).toEqual(["op/x.jpg"]);
  });

  test("an empty bucket is a no-op, not an error", () => {
    const r = emptyGate({ ...base(), bucket: [] });
    expect(r.refuse).toBe(false);
    expect(r.deletable).toEqual([]);
  });
});
