// Reading "who did CI fail to reach?" back out of a GitHub Actions run log.
//
// topup.mjs keys entirely off these two signals, and both are fragile in the same way: they
// parse text that another file formats. When the health report started grouping silent
// operators by cause, the single-line regex that had read them went from matching to matching
// nothing — silently, with topup reporting zero silent operators and doing nothing. That is
// exactly the failure a pure, tested function prevents, so the parsing lives here rather than
// inline in the script.
//
// `gh run view --log` prefixes EVERY line with "job\tstep\ttimestamp ", so nothing here may
// anchor to the start of a line.

// Operators whose JSON endpoint refused the runner outright, named by hostname in the log.
export function blockedHosts(log) {
  const hosts = new Set();
  for (const m of String(log).matchAll(/woo API 403 for https?:\/\/(?:www\.)?([^\s/]+)/g)) hosts.add(m[1]);
  return [...hosts];
}

// Operator display names that the render path gave up on after retrying.
export function blockedNames(log) {
  const names = new Set();
  for (const m of String(log).matchAll(/── (.+?) \((?:render|woo|shopify|api)\) ──[\s\S]{0,200}?⛔ blocked after retry/g)) names.add(m[1]);
  return [...names];
}

// Slugs the health report listed as silent (0 draws). Understands both report shapes:
//   flat  (pre 2026-09): **Silent operators (0 draws — check selectors / blocked):** a, b
//   grouped (current)  : **Silent operators (0 draws) — 51 total**
//                        - **blocked (403 — refused our IP)** (12): a, b
// `isKnown` filters to slugs we actually have config for, so a stray word can never become one.
export function silentSlugs(log, isKnown = () => true) {
  const found = new Set();
  const add = (csv) => { for (const s of String(csv).split(",")) { const t = s.trim(); if (t && isKnown(t)) found.add(t); } };
  const text = String(log);
  for (const m of text.matchAll(/Silent operators \(0 draws[^)]*\):\*\*([^\n]+)/g)) add(m[1]);
  for (const m of text.matchAll(/Silent operators \(0 draws\)[^\n]*\n([\s\S]{0,6000}?)(?:\n[^\n]*\| operator \||$)/g)) {
    for (const b of m[1].matchAll(/-\s+\*\*[^*\n]+\*\*\s*\(\d+\):\s*([^\n]+)/g)) add(b[1]);
  }
  return [...found];
}
