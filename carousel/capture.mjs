// carousel/capture.mjs — deterministic WAAPI seek-and-capture (spec §4.4).
// One chromium.launch per call; frames streamed to disk at deviceScaleFactor 1.
import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";

export async function captureFrames(html, { fps = 30, durationMs, outDir, width = 1080, height = 1920 }) {
  const started = Date.now();
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("window.__ready === true", { timeout: 25000 }).catch(() => {
      throw new Error("capture: page never became ready (fonts/images failed) — refusing to render a degraded reel");
    });
    const frameMs = 1000 / fps;
    const frames = Math.round(durationMs / frameMs);
    for (let i = 0; i < frames; i++) {
      if (Date.now() - started > 5 * 60000) throw new Error(`capture: exceeded 5-minute budget at frame ${i}/${frames}`);
      await page.evaluate((t) => window.__seek(t), Math.round(i * frameMs));
      await page.screenshot({ path: `${outDir}/f${String(i + 1).padStart(5, "0")}.png`, timeout: 15000, animations: "allow" });
    }
    return { frames, dir: outDir };
  } finally {
    await browser.close();
  }
}
