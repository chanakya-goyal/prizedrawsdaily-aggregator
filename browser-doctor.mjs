// Can this machine render an operator page at all? Usage: bun browser-doctor.mjs [url]
//
// WHY THIS EXISTS. In the cloud routine sandbox on 2026-09-09 every Playwright navigation died
// with `net::ERR_CONNECTION_RESET` while plain `curl` to the SAME url returned HTTP 200. The
// routine spent six turns hand-writing a render script, adding a proxy to it, and retrying,
// then gave up and swapped its sample rows — a correct fallback, but the diagnosis never got
// written down, so the next run would have started from zero.
//
// This prints, in one command, every fact needed to tell the three candidate causes apart:
//   * proxy not being used        → curl ok, chromium reset, no proxy in the env
//   * proxy present but refusing  → ERR_TUNNEL_CONNECTION_FAILED / ERR_PROXY_*
//   * egress genuinely blocked    → both curl and chromium fail
// Report its output verbatim rather than describing it.
import { chromium } from "playwright";
import { chromiumLaunchOptions, proxyFromEnv, redactProxyUrl } from "./lib/browser.mjs";
import { UA } from "./lib/parse.mjs";

const url = process.argv[2] || "https://example.com/";
const proxy = proxyFromEnv();

// Everything printed here is meant to be pasted verbatim into the QA report (see
// manager/PROMPT.md step 0), which is then pushed as a notification — so a proxy URL carrying
// credentials must be masked on the way out, not trusted to be credential-free.
console.log("── environment ─────────────────────────────────────────────");
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]) {
  console.log(`  ${k.padEnd(12)} ${process.env[k] ? redactProxyUrl(process.env[k]) : "(unset)"}`);
}
console.log(`  resolved proxy for chromium: ${proxy
  ? `${proxy.server}${proxy.username ? "  (credentials present, withheld)" : ""}${proxy.bypass ? `  bypass=${proxy.bypass}` : ""}`
  : "none — chromium will connect directly"}`);

console.log("\n── control: fetch() / curl path ────────────────────────────");
// Bun's fetch honours the proxy env vars, exactly as curl does. If this succeeds and chromium
// does not, the network is fine and the browser is the problem.
try {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
  console.log(`  fetch  → HTTP ${r.status}, ${(await r.text()).length} bytes`);
} catch (e) {
  console.log(`  fetch  → FAILED: ${(e.message || "").split("\n")[0].slice(0, 120)}`);
}

console.log("\n── chromium ────────────────────────────────────────────────");
let browser = null;
try {
  browser = await chromium.launch(chromiumLaunchOptions({ headless: true, args: ["--disable-blink-features=AutomationControlled"] }));
  console.log(`  launched ok (playwright ${(await import("playwright/package.json", { with: { type: "json" } })).default.version})`);
  const page = await (await browser.newContext({ userAgent: UA })).newPage();
  const res = await page.goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });
  console.log(`  goto   → HTTP ${res ? res.status() : "no response"}, ${(await page.content()).length} bytes`);
  console.log("\n  ✅ chromium can reach the web from here.");
} catch (e) {
  const msg = (e.message || "").split("\n")[0];
  console.log(`  goto   → FAILED: ${msg.slice(0, 160)}`);
  // The real answer on 2026-09-09, found the first time this ran in the cloud routine sandbox:
  // not the network at all. `bun install` pulls playwright 1.61.0, which wants chromium build
  // 1228, while the sandbox image ships 1194 (dated 31 Mar). Playwright says so plainly in its
  // launch error, so classify it rather than filing it under "unclassified" — the remedy is one
  // command and belongs next to the symptom.
  const hint = /Executable doesn't exist|Looks like Playwright.*was just installed or updated|browserType\.launch.*ENOENT/i.test(msg)
    ? "the browser binary playwright expects is not installed here (version skew between the playwright package and the image's pre-installed build). Remedy: `bunx playwright install chromium` — or, durably, add that to the environment's setup script. Do NOT point executablePath at an older pre-installed build: a run tried that and got ERR_CONNECTION_RESET from the stale binary."
    : /ERR_(TUNNEL_CONNECTION_FAILED|PROXY)/.test(msg)
    ? "the proxy is being used but refused the tunnel — check its allowlist/auth"
    : /ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/.test(msg)
      ? (proxy
        ? "chromium was given a proxy and STILL reset — the reset is downstream of the proxy, not a missing proxy"
        : "no proxy is set and the connection was reset — if fetch() above succeeded, set HTTPS_PROXY so chromium uses the same route fetch did")
      : /ERR_CERT/.test(msg)
        ? "TLS interception — the proxy's CA is not trusted by chromium"
        : "unclassified; paste this output into the report rather than summarising it";
  console.log(`\n  ❌ diagnosis: ${hint}`);
} finally { await browser?.close(); }
