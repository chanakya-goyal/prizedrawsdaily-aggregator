import { test, expect } from "bun:test";
import { dimsFromBuffer } from "../imgcheck.mjs";

// 1×1 PNG (smallest valid) — base64 of a real 1×1 transparent PNG
const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("dimsFromBuffer reads PNG dimensions", () => {
  expect(dimsFromBuffer(PNG1)).toEqual({ w: 1, h: 1 });
});

test("garbage buffer returns null (fails open to the render gate)", () => {
  expect(dimsFromBuffer(Buffer.alloc(64))).toBeNull();
});
