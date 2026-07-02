import { test, expect } from "bun:test";
import { captureFrames } from "../capture.mjs";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";

const PAGE = `<!doctype html><html><head><style>
@keyframes slide { from { transform: translateX(0) } to { transform: translateX(500px) } }
#box { width:100px; height:100px; background:#f60; animation: slide 1s linear forwards; }
</style></head><body><div id="box"></div><script>
window.__seek = (t) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = t; } };
(async () => { for (const a of document.getAnimations()) a.pause(); window.__ready = true; })();
</script></body></html>`;

const sha = async (p) => createHash("sha256").update(Buffer.from(await Bun.file(p).arrayBuffer())).digest("hex");

test("capture is deterministic and frames differ over time", async () => {
  const a = await captureFrames(PAGE, { fps: 10, durationMs: 500, outDir: "carousel/tests/tmp/capA" });
  const b = await captureFrames(PAGE, { fps: 10, durationMs: 500, outDir: "carousel/tests/tmp/capB" });
  expect(a.frames).toBe(5);
  const fa = (await readdir(a.dir)).sort(), fb = (await readdir(b.dir)).sort();
  expect(fa).toEqual(fb);
  expect(await sha(`${a.dir}/${fa[0]}`)).toBe(await sha(`${b.dir}/${fb[0]}`));   // deterministic
  expect(await sha(`${a.dir}/${fa[0]}`)).not.toBe(await sha(`${a.dir}/${fa[4]}`)); // animation actually moves
}, 120000);
