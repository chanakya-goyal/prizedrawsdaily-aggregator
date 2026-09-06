// Which of the five things do we do with this scraped draw?
//
// run.mjs:243-400 held every insert / publish / correct / relist / skip decision inline, and had
// ZERO test coverage — the most consequential branching in the repo, verified only by watching
// production. This module is that decision tree and nothing else: it is pure, it touches no
// network and no database, and it returns a PLAN. Every side effect — the DB pushes, the
// counters, the log lines, the byUrl bookkeeping, slug allocation — stays in run.mjs, so this
// extraction cannot change what is written, only make what is decided testable.
//
// It reuses relistDecision / correctionDecision / verifyAgainstStored unchanged, so the actual
// publish bar is still defined in exactly one place (lib/verify.mjs).
import { relistDecision, correctionDecision, verifyAgainstStored } from "./verify.mjs";

const round2 = (n) => Math.round(n * 100) / 100;

// Ticket price × cap, clamped. Postgres numeric would reject a pathological product.
export function poolValue(draw) {
  return Math.min(round2((draw.ticket_price || 0) * (draw.total_entries || 0)), 1_000_000_000);
}

// A category the RULES derived must never overwrite one a human or Claude judged: those were
// decided, not computed, and letting a rule re-litigate one makes the category flap daily.
// Equally, a fresh read with no category must not blank a stored one — `undefined` keys vanish
// in JSON.stringify, which is how "leave it alone" is expressed to PostgREST.
export function categoryPatch(fresh, existing, catMap) {
  const resolved = catMap[fresh.category];
  const judged = ["claude", "manual"].includes(existing?.category_source);
  return resolved && !judged
    ? { category_id: resolved, category_source: "rule" }
    : { category_id: undefined, category_source: undefined };
}

export function routeDraw(existing, fresh, {
  now = new Date(),
  catMap = {},
  autoPublish = false,
  correctLive = true,
  correctRemaining = Infinity,
  minObservationGapMs = 0,
} = {}) {
  const tpv = poolValue(fresh);

  // Brand new URL.
  if (!existing) return { kind: "insert", tpv };

  // An ended row whose competition has been RELISTED for a later draw. Without this the URL is
  // retired permanently, silently losing every recurring competition.
  if (existing.status === "ended") {
    const { revive } = relistDecision(existing, fresh, now);
    if (!revive) return { kind: "skip", reason: "not-relisted", tpv };
    return {
      kind: "relist",
      tpv,
      row: {
        ...categoryPatch(fresh, existing, catMap),
        title: fresh.title, grand_prize: fresh.grand_prize,
        image_url: fresh.image_url, ticket_price: fresh.ticket_price, total_entries: fresh.total_entries,
        total_prize_value: tpv, draw_date: fresh.draw_date, status: "draft",
        // Reviving restarts the clock. The row keeps its id, so without this stamp its
        // created_at still points at the FIRST time we ever saw the URL — months back — and any
        // minimum-observation-gap check would pass instantly on exactly the recurring draws that
        // most need a second look.
        created_at: now.toISOString(),
      },
    };
  }

  // A published row: correct its FIELDS in place, never its status. A data change is not a
  // reason to yank a live draw off the site; a finished comp is ended-sweep's job.
  if (existing.status === "active") {
    if (!correctLive) return { kind: "skip", reason: "correct-live-off", tpv };
    const decision = correctionDecision(existing, fresh, { now });
    if (!decision.correct) return { kind: "skip", reason: "no-correction", decision, tpv };
    // Checked AFTER the decision, exactly as before, so the same draws consume the cap.
    if (correctRemaining <= 0) return { kind: "skip", reason: "correction-cap", decision, tpv };

    // Patch only what actually moved. A pool-only drift is arithmetic on values we already
    // agree with; rewriting title/category/date too would be unforced risk on a public row.
    const row = { total_prize_value: tpv };
    if (decision.fields.some((f) => f !== "total_prize_value")) {
      Object.assign(row, {
        title: fresh.title, grand_prize: fresh.grand_prize,
        ticket_price: fresh.ticket_price, total_entries: fresh.total_entries, draw_date: fresh.draw_date,
      });
      const cat = categoryPatch(fresh, existing, catMap);
      if (cat.category_id) Object.assign(row, cat);
    }
    // image_url is deliberately NOT patched: it is never the reason we are here, and the stored
    // value is a proven-reachable URL on our own storage.
    return { kind: "correct", row, decision, tpv };
  }

  if (existing.status !== "draft") return { kind: "skip", reason: "not-draft", tpv };

  // The SECOND independent observation of a row we already hold. Agreement means it has been
  // read twice by separate fetches, which is what earns publication.
  const verdict = verifyAgainstStored(existing, fresh, { now, imageOk: true, minObservationGapMs });
  return {
    kind: "draft",
    tpv,
    verdict,
    candidate: Boolean(autoPublish && verdict.publish),
    row: {
      ...categoryPatch(fresh, existing, catMap),
      title: fresh.title, grand_prize: fresh.grand_prize,
      image_url: fresh.image_url, ticket_price: fresh.ticket_price, total_entries: fresh.total_entries,
      total_prize_value: tpv, draw_date: fresh.draw_date,
    },
  };
}
