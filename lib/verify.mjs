// Publish verification — the deterministic gate between "scraped" and "shown on the site".
//
// THE PROBLEM IT SOLVES: every row the scraper writes lands as `draft`, and the only
// draft→active path was a human/Claude routine. It stopped keeping up, so on 2026-08-19
// there were 283 future-dated drafts against 215 live draws, and 79 more had already reached
// their draw date while still invisible — scraped, held, thrown away. Meanwhile the site
// showed 5 car draws while 25 sat in the queue.
//
// THE RULE: a draft publishes when a SECOND INDEPENDENT OBSERVATION agrees with it.
// The daily run already re-scrapes every operator, so run N writes the row and run N+1
// re-reads the same URL from the operator. If both readings agree on the numbers that
// matter, that is two separate fetches, parsed separately, on different days, reaching the
// same answer — far stronger evidence than trusting one scrape, and it costs no extra
// requests. A first sighting is never enough; a new draw waits one run.
//
// WHY AGREEMENT IS THE RIGHT TEST HERE: it catches drift, transient markup, a neighbouring
// competition's number leaking into a regex, and a counter mistaken for a cap. It does NOT
// catch a systematic parse error that reproduces identically — so `fieldFlags` (the
// range/consistency rules in lib/manager.mjs) still has to pass as well.
//
// A useful side effect: `total_entries` sometimes comes from the API's "N in stock" value,
// which is tickets REMAINING, not the cap. A real cap does not move; a stock counter drops
// every day. Those rows therefore never agree and never publish — and the hold reason names
// the drift, which is exactly the diagnostic needed to fix the parser.
import { fieldFlags } from "./manager.mjs";

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// The user-visible fact about a draw is the day it is drawn, in UK time. Operators nudge the
// clock time (8:45pm vs 9pm) without it meaning anything, so compare the calendar day.
export function ukDayKey(value) {
  // Guard the falsy cases explicitly: `new Date(null)` is epoch 0, not an Invalid Date, so a
  // missing draw_date would otherwise compare equal to another missing one as "1970-01-01".
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // YYYY-MM-DD
}

// Titles pick up entity escapes, emoji and whitespace churn between runs. Compare on letters
// and digits only; allow containment so a suffix like " - AUTO DRAW" appearing isn't drift.
const normTitle = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function titlesAgree(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// Pure. `stored` = the draft row as it sits in the DB; `fresh` = what we just scraped for the
// same entry_url. `imageOk` is checkImage()'s tri-state, resolved by the caller (true / false
// / null=unverified). Returns the publish decision plus the fields that moved, so the caller
// can refresh the row when it holds.
export function verifyAgainstStored(stored, fresh, { now = new Date(), imageOk = null, minLeadMs = 2 * 3600e3 } = {}) {
  const reasons = [];
  const drift = {};

  // 1. The numbers must agree across the two observations.
  if (round2(stored.ticket_price) !== round2(fresh.ticket_price)) {
    drift.ticket_price = [stored.ticket_price, fresh.ticket_price];
    reasons.push(`ticket_price ${stored.ticket_price} → ${fresh.ticket_price}`);
  }
  if (Number(stored.total_entries) !== Number(fresh.total_entries)) {
    drift.total_entries = [stored.total_entries, fresh.total_entries];
    reasons.push(`total_entries ${stored.total_entries} → ${fresh.total_entries} (a cap does not move — likely a stock counter)`);
  }
  const sDay = ukDayKey(stored.draw_date), fDay = ukDayKey(fresh.draw_date);
  if (!sDay || !fDay) {
    reasons.push("unparseable draw_date");
  } else if (sDay !== fDay) {
    drift.draw_date = [stored.draw_date, fresh.draw_date];
    reasons.push(`draw_date ${sDay} → ${fDay}`);
  }
  if (!titlesAgree(stored.title, fresh.title)) {
    drift.title = [stored.title, fresh.title];
    reasons.push("title changed");
  }

  // 2. It must still be worth showing: closed or closing within the hour is not a live draw.
  const dt = new Date(fresh.draw_date);
  if (isNaN(dt.getTime())) reasons.push("bad fresh draw_date");
  else if (dt.getTime() - now.getTime() < minLeadMs) reasons.push("closes too soon to publish");

  // 3. The deterministic range/consistency rules must be clean. Reused wholesale rather than
  //    reimplemented, so the publish bar can never drift from the scrape-time bar.
  const flags = fieldFlags({ ...fresh, description: fresh.description ?? stored.prize_description });
  if (flags.length) reasons.push(...flags);

  // 4. The image must be provably loadable. Deliberately stricter than the human review path:
  //    an unattended publisher cannot weigh "probably fine", and our images sit on our own
  //    storage, so anything but a clean 2xx means wait a day rather than ship a broken card.
  if (imageOk !== true) reasons.push(`image not confirmed (${imageOk === false ? "unreachable" : "unverified"})`);

  return { publish: reasons.length === 0, reasons, drift, hasDrift: Object.keys(drift).length > 0 };
}

// Roll a batch of verdicts into the one-line summary the run report needs.
export function summarise(verdicts) {
  const held = {};
  for (const v of verdicts) {
    if (v.publish) continue;
    for (const r of v.reasons) {
      // Collapse "ticket_price 0.25 → 0.5" to "ticket_price" so the tally stays readable.
      const key = r.replace(/\s+[\d.]+\s*→.*$/, "").replace(/\s*\(.*\)$/, "").trim();
      held[key] = (held[key] || 0) + 1;
    }
  }
  return {
    published: verdicts.filter((v) => v.publish).length,
    held: verdicts.filter((v) => !v.publish).length,
    heldReasons: Object.fromEntries(Object.entries(held).sort((a, b) => b[1] - a[1])),
  };
}
