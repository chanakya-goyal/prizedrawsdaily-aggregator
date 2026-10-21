// carousel/autopilot/status.mjs — the small decisions run.sh needs, kept in Bun so they are testable.
//
//   bun carousel/autopilot/status.mjs window           exit 0 inside the UK posting window
//   bun carousel/autopilot/status.mjs published-today  exit 0 when today's carousel row is published
//   bun carousel/autopilot/status.mjs report <file>    prints PUBLISHED|SKIPPED|DRY-RUN|FAILED (or nothing)
import { getPost, todayLondon } from "../state.mjs";

export const STATUSES = ["PUBLISHED", "SKIPPED", "DRY-RUN", "FAILED"];

// The first line of REPORT.md, exactly "STATUS: X". Anything else is unreadable — the wrapper treats
// unreadable as FAILED, because a run that cannot say what it did must not read as fine.
export function reportStatus(text) {
  const first = String(text ?? "").split("\n")[0].trim();
  const m = /^STATUS:\s*([A-Z-]+)$/.exec(first);
  return m && STATUSES.includes(m[1]) ? m[1] : null;
}

// launchd fires at 16:45 and 17:45 IST: 12:15 / 13:15 UK in summer, 11:15 / 12:15 in winter. The
// window opens at 12:00 UK so the lunchtime post lands at 12:15 in both seasons (the second firing
// finds it published and stops). If the Mac was asleep, launchd runs the missed job on wake; the
// window keeps a catch-up inside UK waking hours, and anything later waits for tomorrow.
export function ukHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(now));
}
export const inWindow = (now = new Date(), from = 12, to = 20) => { const h = ukHour(now); return h >= from && h < to; };

if (import.meta.main) {
  const [cmd, arg] = Bun.argv.slice(2);
  if (cmd === "window") process.exit(inWindow() ? 0 : 1);
  if (cmd === "published-today") {
    try { process.exit((await getPost(todayLondon(), "carousel"))?.status === "published" ? 0 : 1); }
    catch (e) { console.error(`published-today: state unreadable — ${e.message}`); process.exit(2); }
  }
  if (cmd === "report") {
    const s = reportStatus(await Bun.file(arg).text().catch(() => ""));
    if (s) console.log(s);
    process.exit(0);
  }
  console.error("usage: status.mjs window | published-today | report <file>");
  process.exit(64);
}
