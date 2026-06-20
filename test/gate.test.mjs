import { test, expect, describe } from "bun:test";
import { requiredGate, schemaGate, businessGate, gate } from "../gate.mjs";

const soon = new Date(Date.now() + 7 * 864e5).toISOString();
const past = new Date(Date.now() - 864e5).toISOString();
const farOff = new Date(Date.now() + 60 * 864e5).toISOString();

const good = () => ({
  title: "Win a BMW", grand_prize: "BMW M4", category: "car-draws",
  ticket_price: 4.99, total_entries: 10000, draw_date: soon,
  image_url: "https://cdn.test/x.jpg", entry_url: "https://op.test/p/1", description: "x".repeat(40),
});

describe("requiredGate", () => {
  test("complete passes", () => expect(requiredGate(good()).ok).toBe(true));
  test("missing entries", () => { const d = good(); d.total_entries = null; expect(requiredGate(d).missing).toContain("total_entries"); });
  test("missing date", () => { const d = good(); d.draw_date = null; expect(requiredGate(d).missing).toContain("draw_date"); });
  test("bad image url", () => { const d = good(); d.image_url = "not-a-url"; expect(requiredGate(d).missing).toContain("image_url"); });
  test("zero entries fails", () => { const d = good(); d.total_entries = 0; expect(requiredGate(d).ok).toBe(false); });
  test("free price (0) is present", () => { const d = good(); d.ticket_price = 0; expect(requiredGate(d).missing).not.toContain("ticket_price"); });
});

describe("schemaGate", () => {
  test("truncates long title", () => { const d = good(); d.title = "a".repeat(300); expect(schemaGate(d).draw.title.length).toBe(200); });
  test("truncates long description", () => { const d = good(); d.description = "a".repeat(5000); expect(schemaGate(d).draw.description.length).toBe(2000); });
  test("rounds price", () => { const d = good(); d.ticket_price = 4.999; expect(schemaGate(d).draw.ticket_price).toBe(5); });
  test("rounds entries to int", () => { const d = good(); d.total_entries = 100.7; expect(schemaGate(d).draw.total_entries).toBe(101); });
  test("price overflow is violation", () => { const d = good(); d.ticket_price = 2_000_000; expect(schemaGate(d).ok).toBe(false); });
  test("bad category cleared to null", () => { const d = good(); d.category = "nonsense"; expect(schemaGate(d).draw.category).toBeNull(); });
});

describe("businessGate", () => {
  test("good in-window passes", () => expect(businessGate(good()).ok).toBe(true));
  test("past date fails", () => { const d = good(); d.draw_date = past; expect(businessGate(d).reasons).toContain("already closed"); });
  test("too far out fails", () => { const d = good(); d.draw_date = farOff; expect(businessGate(d).ok).toBe(false); });
  test("sub-threshold entries fails", () => { const d = good(); d.total_entries = 100; expect(businessGate(d).ok).toBe(false); });
  test("collectible small print run allowed", () => {
    const d = good(); d.title = "PSA 10 Pokemon Charizard"; d.grand_prize = "Pokémon card"; d.total_entries = 80; d.category = "luxury";
    expect(businessGate(d).ok).toBe(true);
  });
});

describe("gate (combined)", () => {
  test("passes and returns cleaned draw", () => { const r = gate(good()); expect(r.pass).toBe(true); expect(r.stage).toBe("ok"); });
  test("required failure short-circuits", () => { const d = good(); d.draw_date = null; const r = gate(d); expect(r.pass).toBe(false); expect(r.stage).toBe("required"); });
  test("business failure after schema", () => { const d = good(); d.draw_date = past; const r = gate(d); expect(r.stage).toBe("business"); });
});
