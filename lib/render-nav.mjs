// Navigation settle policy for the headless renderer.
//
// Lives in its own module (not extractor.mjs) so the test suite can exercise it without pulling
// in `playwright` — the scraper CI gate must stay offline and Chromium-free, or a failing gate
// silently skips the whole daily scrape.
//
// `networkidle` is the right settle signal for a JS-rendered catalogue, but it never fires on a
// site that holds a connection open — live-chat widgets, analytics beacons, countdown pollers.
// The operator then dies on "goto: Timeout 45000ms exceeded" having never been read at all, and
// five operators failed exactly this way in EVERY daily run we have logs for (winmore,
// ignite-comps, carp-fishing, bubbl-win, winner-winner). The page itself was usually fine; only
// the idle condition never arrived. So on the hard pass we retry with domcontentloaded before
// giving up. A genuine navigation failure (DNS, refused) still throws.
export const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 35000);
export const RENDER_TIMEOUT_HARD_MS = Number(process.env.RENDER_TIMEOUT_HARD_MS || 45000);

const isTimeout = (e) => /timeout .*exceeded|exceeded.*timeout/i.test(String(e?.message ?? e));

export async function gotoSettled(page, url, { hard = false } = {}) {
  const timeout = hard ? RENDER_TIMEOUT_HARD_MS : RENDER_TIMEOUT_MS;
  if (!hard) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    return { settled: "domcontentloaded", degraded: false };
  }
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout });
    return { settled: "networkidle", degraded: false };
  } catch (e) {
    if (!isTimeout(e)) throw e;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    return { settled: "domcontentloaded", degraded: true };
  }
}
