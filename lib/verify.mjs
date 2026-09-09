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
export function verifyAgainstStored(stored, fresh, { now = new Date(), imageOk = null, minLeadMs = 2 * 3600e3, minObservationGapMs = 0 } = {}) {
  const reasons = [];
  const drift = {};

  // 0. The two observations must be genuinely separated in TIME, not just in count.
  // The whole model assumes run N writes the row and run N+1 re-reads it a day later. Once the
  // scrape runs several times a day that stops being true by default, and a draft could be
  // published hours after first sighting by what is nearly the same fetch. manager/PROMPT.md
  // forbids the cowork routine from doing exactly this ("a same-day 'second observation'
  // collapses the one-day wait the whole gate rests on"), so an automated sweep must not do it
  // either. Defaults to 0 (off) so single-daily-run behaviour is unchanged; only the
  // higher-cadence workflow sets it.
  if (minObservationGapMs > 0 && stored.created_at) {
    const ageMs = now.getTime() - new Date(stored.created_at).getTime();
    if (Number.isFinite(ageMs) && ageMs < minObservationGapMs) {
      reasons.push(`first seen ${Math.round(ageMs / 3600e3)}h ago — needs ${Math.round(minObservationGapMs / 3600e3)}h between observations`);
    }
  }

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
  //    `hasStoredCategory` is the one place the stored row overrules the fresh read: an
  //    uncategorised draw is held until Claude judges it, and the stored category IS that
  //    judgment. Today's scrape resolving null again is expected (the rules never could
  //    classify it) and must not re-hold a row that has already been answered.
  const flags = fieldFlags(
    { ...fresh, description: fresh.description ?? stored.prize_description },
    { hasStoredCategory: !!stored.category_id },
  );
  if (flags.length) reasons.push(...flags);

  // 4. The image must be provably loadable. Deliberately stricter than the human review path:
  //    an unattended publisher cannot weigh "probably fine", and our images sit on our own
  //    storage, so anything but a clean 2xx means wait a day rather than ship a broken card.
  if (imageOk !== true) reasons.push(`image not confirmed (${imageOk === false ? "unreachable" : "unverified"})`);

  return { publish: reasons.length === 0, reasons, drift, flags, hasDrift: Object.keys(drift).length > 0 };
}

// Should a LIVE row's fields be overwritten with today's scrape?
//
// Correcting a published row is the one write that happens on a SINGLE observation: the whole
// point is that an operator who drops a ticket price or moves a draw date must not leave a
// wrong number on the public site for the rest of the comp's life, and waiting for a second
// agreeing read would put that fix a day late. But that also means the agreement test — the
// protection the publish path leans on entirely — is unavailable here.
//
// So the other half of the publish bar has to carry it: the fresh read must be deterministically
// clean (`fieldFlags`, the same rules, via verifyAgainstStored). Drift on a clean read is an
// operator changing something and is worth following onto the site. Drift on a FLAGGED read —
// a £0 price, a car draw whose pool collapsed to £40, a title that lost its text, an image URL
// that stopped being a URL — is far more likely to be the parser breaking for a day, and
// yesterday's values are already proven. Leave them alone and let the next run decide.
export function correctionDecision(stored, fresh, { now = new Date() } = {}) {
  const v = verifyAgainstStored(stored, fresh, { now, imageOk: true });
  const drift = { ...v.drift };

  // total_prize_value is DERIVED (price × entries) but stored, so it can be stale even when
  // both inputs agree with today's scrape — the row was simply written when one of them was
  // wrong. 33 gaming-giveaways rows sat live like that, e.g. "£250 Amazon Voucher" storing a
  // £3,229.38 pool for £0.99 × 3,400 = £3,366. Comparing the inputs alone never catches it,
  // so check the arithmetic itself.
  if (stored.total_prize_value != null && fresh.ticket_price != null && fresh.total_entries != null) {
    const expected = round2(fresh.ticket_price * fresh.total_entries);
    if (Math.abs(round2(stored.total_prize_value) - expected) > 0.02) {
      drift.total_prize_value = [stored.total_prize_value, expected];
    }
  }

  const fields = Object.keys(drift);
  const base = { drift, flags: v.flags, fields };
  if (!fields.length) return { correct: false, reason: "no drift", ...base };
  // A flagged read is far more likely to be the parser breaking for a day than the operator
  // changing something, and yesterday's values are already proven — so refuse, and say so.
  if (v.flags.length) return { correct: false, reason: `fresh read is flagged (${v.flags.join("; ")})`, ...base };
  return { correct: true, reason: `clean read disagrees on ${fields.join(", ")}`, ...base };
}

// Should an ENDED row come back to life?
//
// Operators relist the same product URL for the next round of a recurring competition, and
// ended-sweep marks a comp ended as soon as it stops being purchasable — which is also what a
// sold-out-awaiting-draw comp looks like. Because run.mjs refuses to re-insert any entry_url
// it has already seen, both cases were permanent: the URL could never return to the site.
//
// Reviving requires positive evidence that this is a NEW round, not a stale read: the stored
// draw has already passed, and the operator is now advertising a future date. Anything else
// leaves the row alone. It returns as `draft`, so it still has to earn publication through
// the normal two-observation agreement.
export function relistDecision(stored, fresh, now = new Date()) {
  if (stored?.status !== "ended") return { revive: false, reason: "not an ended row" };
  const storedAt = stored.draw_date ? new Date(stored.draw_date) : null;
  const freshAt = fresh?.draw_date ? new Date(fresh.draw_date) : null;
  if (!freshAt || isNaN(freshAt.getTime())) return { revive: false, reason: "no fresh draw date" };
  if (freshAt <= now) return { revive: false, reason: "fresh date is not in the future" };
  if (!storedAt || isNaN(storedAt.getTime())) return { revive: false, reason: "stored row has no date to compare" };
  if (storedAt > now) return { revive: false, reason: "stored draw has not run yet" };
  if (freshAt <= storedAt) return { revive: false, reason: "fresh date is not later than the one that ended" };
  return { revive: true, reason: "relisted for a later draw" };
}

// Should a row whose close date has passed but which is STILL PURCHASABLE have its date fixed?
//
// This is relistDecision's mirror image. relistDecision asks "has an ended row come back to
// life"; this asks "has a live row simply had its date move". Measured 2026-08-30, 397 of 759
// `status=active` rows had a draw_date already in the past — 52% of the live inventory — and
// nothing was correcting them. ended-sweep reported the cohort and nominated run.mjs as owner
// (ended-sweep.mjs:143), but run.mjs structurally cannot reach these rows: render rows are
// only discovered by crawling the operator's listing and a past-date comp is no longer linked
// there; woo rows fall outside the `after=` window and the page caps. The sweep reaches rows
// by entry_url, so the sweep is the right owner.
//
// THE THREE SAFETY PROPERTIES, in the order they matter:
//
// 1. A PAST DATE IS NEVER, ON ITS OWN, A REASON TO END A DRAW. Only the operator's own
//    purchasability flag is. This is ended-sweep's existing doctrine — strong signals
//    (Woo is_purchasable, Shopify variant availability) act, weak signals (text probes)
//    report — applied to a second decision. Blanket-ending these 397 would destroy the
//    cohort that matters most: comps the operator extended and people can still enter.
//
// 2. AN EXTENSION REQUIRES TWO INDEPENDENT AGREEMENTS: still purchasable AND a strictly
//    later future date. One alone is not evidence. This is the same two-observation
//    philosophy the rest of this module is built on.
//
// 3. CONFIDENCE IS GRADED BY SOURCE. Render operators expose no purchasability flag, so
//    their evidence is `!saysFinished(html)` plus a parsed date — genuinely weaker than a
//    Woo boolean. Those verdicts are stamped `medium` and the apply script's
//    MIN_CONFIDENCE=high default excludes them until a human opts in.
//
// Returns { action: "end" | "extend" | "hold", reason, to?, confidence }.
// Note what it never returns: there is no "publish" or "unpublish" action. This function
// owns draw_date and nothing else — ended-sweep owns status. One writer per transition.
export function staleDateDecision(stored, evidence = {}, now = new Date()) {
  const { purchasable = null, freshDate = null, reachable = true, source = null } = evidence;
  // Confidence grades the EVIDENCE, not the verdict. woo, shopify and api all read the
  // operator's own live set — Woo's is_purchasable, Shopify's variant availability, and the
  // api adapters' include_finished=false feeds are equally authoritative. render offers only a
  // text heuristic over a page we fetched ourselves. Anything else has no evidence at all and
  // must never be able to authorise a write by looking confident.
  const STRONG = new Set(["woo", "shopify", "api"]);
  const confidence = STRONG.has(source) ? "high" : source === "render" ? "medium" : "low";

  // No evidence at all — a row we could not read is a row we must not touch. Checked first
  // so an unreachable page can never fall through to a date comparison against a stale parse.
  if (!reachable) return { action: "hold", reason: "unreachable — no evidence", confidence };
  if (purchasable === null) return { action: "hold", reason: "purchasability unknown — no evidence", confidence };

  // The operator's own authoritative flag. This is the one signal strong enough to end a draw.
  if (purchasable === false) return { action: "end", reason: "not purchasable — operator has closed it", confidence };

  // Still purchasable from here on: the competition is live, so the DATE is what is wrong.
  const freshAt = freshDate ? new Date(freshDate) : null;
  if (!freshAt || isNaN(freshAt.getTime())) {
    return { action: "hold", reason: "still purchasable but no future date readable", confidence };
  }
  if (freshAt <= now) {
    return { action: "hold", reason: "still purchasable but the advertised date has also passed", confidence };
  }
  const storedAt = stored?.draw_date ? new Date(stored.draw_date) : null;
  if (storedAt && !isNaN(storedAt.getTime()) && freshAt <= storedAt) {
    return { action: "hold", reason: "advertised date is not later than the stored one", confidence };
  }
  return { action: "extend", to: freshAt.toISOString(), reason: "still purchasable and now advertising a later date", confidence };
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

// A DRAFT whose own advertised close date has passed and which was never published.
//
// staleDateDecision above refuses to end anything without the operator's own purchasability
// flag, and for a LIVE row that is right: pulling a running competition off the site on a bad
// date parse is visible damage. A draft is not on the site and never was, so the asymmetry does
// not apply — and keeping it costs a permanently stuck queue entry that makes "drafts waiting"
// a meaningless number. Measured 9 Sep 2026: 277 of 883 drafts (31%) had already passed their
// own draw date, the oldest 30 days back.
//
// Reversible by design: if the operator relists that URL for a later date, routeDraw's relist
// branch (lib/route.mjs) revives the ended row rather than inserting a duplicate.
export function deadDraftDecision(row, now = new Date()) {
  if (row?.status !== "draft") {
    return { end: false, reason: "not a draft — a live row may only be ended on the operator's own evidence" };
  }
  const at = row?.draw_date ? new Date(row.draw_date) : null;
  if (!at || isNaN(at.getTime())) return { end: false, reason: "no readable draw date" };
  if (at.getTime() >= now.getTime()) return { end: false, reason: "still enterable" };
  const days = Math.floor((now.getTime() - at.getTime()) / 864e5);
  return { end: true, reason: `draft never published and its draw date passed ${days}d ago` };
}

// Which publish candidate should spend the next unit of the cap.
//
// The cap used to be spent first-come over a FIXED roster order (operators.json file order,
// never shuffled), which made it a whitelist rather than a budget: whoever was scraped first
// consumed it, every run, forever. Measured 9 Sep 2026 on the JSON sweep — first half of the
// roster held 361 live draws, last half 155, with the SAME number of drafts dying in the queue.
// click-competitions sits at position 58/59 with 26 dead drafts and 0 live, while its own log
// lines read "verified — publishing" every single run. 142 rows in one run were held on
// "run publish cap reached".
//
// Urgency is the honest priority: a draw closing tomorrow is worth more than one closing in
// three weeks, because skipping the near one kills it. Rows without a date sort last — they
// cannot be urgent and must never displace a dated row.
export function byPublishUrgency(a, b) {
  const at = a?.row?.draw_date ? Date.parse(a.row.draw_date) : NaN;
  const bt = b?.row?.draw_date ? Date.parse(b.row.draw_date) : NaN;
  const av = Number.isFinite(at), bv = Number.isFinite(bt);
  if (av && bv) return at - bt;
  if (av) return -1;
  if (bv) return 1;
  return 0;
}
