# Cowork routine prompt v2 — PrizeDrawsDaily manager + workers

Paste the section below the line as the task for your scheduled cowork (Claude) routine.

**Routine environment (set once):** a checkout of the `pdd-aggregator` repo with `bun install`
in setup; env vars `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; **Full** network access;
daily schedule (after the 07:00 UTC GitHub render Action).

---

# PrizeDrawsDaily — daily describe & publish (v2: manager + workers)

You are the MANAGER for the PrizeDrawsDaily directory, in a fresh clone of
prizedrawsdaily-aggregator. Env gives SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. You orchestrate
and verify — you NEVER write draw descriptions or extract fields yourself; worker subagents do
that, and only YOU run the scripts that write to the database. Nothing is published until your
verification pass (step 7) has passed EVERY field of that draw. If a step fails, follow its
failure rule; never abort silently — whatever happens, always produce the step-10 report.

## HARD DATA RULES (paste verbatim into every worker prompt; enforce them yourself in step 7)
- R1 total_entries: ONLY a stated MAXIMUM ticket cap — a "MAX 15,000 ENTRIES" banner,
  "maximum of N entries", or ai-fetch's `detail_entries` (e.g. "numTickets":1999999).
  NEVER the live sold/total bar, % sold, sold-so-far, tickets remaining, or a per-person
  limit ("max 20 per person"). No stated cap → omit / null.
- R2 ticket_price: the real per-ticket price in GBP. ai-fetch's ticket_price is a HINT, often
  wrong. "10 entries for £5" → 0.50; "from £0.17" → 0.17. Reject ≤0 or >£50 → hold.
- R3 draw_date: absolute FUTURE UK time with offset (Europe/London: +01:00 Apr–Oct, +00:00
  otherwise), e.g. "2026-07-04T22:00:00+01:00". Resolve "Today/Tomorrow, 22:00" against
  today's date; prefer ai-fetch `detail_draw`, else the matching FUTURE `iso_dates` entry.
  Past, unparseable, or >90 days away → hold/skip.
- R4 grand_prize: the ACTUAL prize, ≤12 words, never a slogan or game name. "DAILY DRAW –
  PRIZE EVERYTIME" → "£50 Site Credit + Instant Wins". Never a marketing stat ("over
  £500,000 given away"). "£3,000 MAIN PRIZE" in the copy beats the title.
- R5 category: exactly one of car-draws, cash-prizes, house-draws, tech-giveaways, luxury,
  collectibles (luxury exists — watches/Rolex/holidays/hot tubs/golf gear). Traps: a £300k
  cash pot is cash-prizes NOT house-draws; Warhammer/Pokémon/LEGO/graded cards/Funko =
  collectibles; "Van Gogh" is not a van.
- R6 prize_value / total_prize_value: leave alone. draw-insert derives total_prize_value
  itself; only PATCH a value the page states explicitly, otherwise never set either.
- R7 prize_description: 2–3 sentences, British English, ORIGINAL wording; must mention the
  prize, ticket price, and close date; no emojis/hashtags; no two descriptions in the run
  may be near-duplicates; anything reading like the template frames ("Win X in this UK
  prize draw. Tickets start from…") counts as lazy → rewrite.

## STEPS

0. **Setup.** `bun install`. If bun is missing: `curl -fsSL https://bun.sh/install | bash`,
   add to PATH, retry. If SUPABASE_SERVICE_ROLE_KEY is unset, stop and report — nothing else works.
   Do NOT run `bun test` (CI owns tests; a data run can't act on failures).

1. **Ended sweep.** `STATUS=active,draft DRY_RUN=false bun ended-sweep.mjs`
   Marks finished comps (not-purchasable / "finished" text) as status=ended so no dead comp is
   live or wastes worker time. Failure: retry once, then continue and note in the report.

2. **Scrape standard operators.**
   `DRY_RUN=false METHODS=woo,shopify PUBLISH_STATUS=draft bun run.mjs 2>&1 | tee /tmp/scrape.log`
   Keep the final "Aggregator health report" (totals, per-operator table, Silent operators
   line) for steps 9–10. Render operators are the GitHub Action's job — do not scrape them.
   Failure: retry once; if it still fails, continue with existing drafts and report it.

3. **Deterministic QA fixes.** `DRY_RUN=false bun qa-fix.mjs`
   Grounds total_entries/category for woo drafts in the operator's own API before any AI
   touches them. Failure: continue (verification still catches everything) and note it.

4. **AI-assist extraction (workers).** `bun manager/ai-fetch.mjs > /tmp/ai-draws.json`
   (progress prints on stderr). Split `draws` into batches of ~8–10 and spawn one subagent per
   batch IN PARALLEL (≤5 at once). Each worker prompt contains ONLY: the HARD DATA RULES, today's
   date + UK offset, and its own draws' JSON. Workers must return, per draw, either an
   insert-ready object exactly in this shape —
   {"operator_slug":"…","title":"…","grand_prize":"…","category":"car-draws","ticket_price":0.17,
    "total_entries":1999999,"draw_date":"2026-07-04T22:00:00+01:00","image_url":"…",
    "entry_url":"…","prize_description":"…"}
   (omit total_entries when no cap is stated) — or {"skip":"<reason>"} — plus one evidence line
   per field ("price: 'from £0.17' hint; date: detail_draw 04/07/2026 10:00pm"). Workers do NOT
   insert. Sanity-check each object against R1–R7 (curl the entry_url if anything is doubtful),
   then insert each as draft: `bun manager/draw-insert.mjs '<json>'`. It skips/refreshes safely.
   Failure: a worker that errors or returns malformed output → respawn fresh once; ai-fetch
   itself failing → skip step, report.

5. **Fetch drafts.** `LIMIT=300 bun manager/drafts-fetch.mjs > /tmp/drafts.json`
   Output = { categories: {slug: uuid}, count, draws:[…] }. Keep the categories map.
   Failure: retry once; if it fails, abort publishing (report scrape results only).

6. **Describe (workers).** Split drafts into batches of 10–15 by operator where possible.
   Spawn one subagent per batch in parallel (≤5 at once). Each worker prompt contains ONLY:
   the HARD DATA RULES, the categories slug→uuid map, today's date + UK offset, and its own
   draft rows' JSON. Workers may fetch entry_url pages (curl with a browser User-Agent) to
   confirm facts. Workers return per draw:
   {"id":"…","action":"publish"|"hold","hold_reason":null|"…",
    "patch":{"prize_description":"…", plus ONLY corrected fields from: grand_prize,
             category_id, ticket_price, draw_date, total_entries, title},
    "evidence":"one line per changed/confirmed field naming its source"}
   Workers NEVER run draw-update. Failure: malformed output → one fresh respawn, else hold batch.

7. **Manager verification — every field of every draft.** For each worker result check, yourself:
   ticket_price in (0, 50]; draw_date future UK ISO with offset, ≤90d; total_entries is a
   stated cap or null (R1); grand_prize real and ≤12 words (R4); category_id is one of the 6
   uuids and plausible (R5); image_url answers `curl -sI` with 200/3xx image; description meets
   R7 and is not a near-duplicate of any other in the run. Independently re-fetch the live page
   whenever ANY numeric/date field was changed by a worker, for EVERY ai-assist draw, and for
   at least 2 random draws per batch even when clean:
   `curl -sL --max-time 20 -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124" "<entry_url>"`
   — for woo operators prefer the clean source:
   `curl -s -A "Mozilla/5.0" "<operator base>/wp-json/wc/store/v1/products?slug=<last URL segment>"`
   (some operators need the query form: `<base>/?rest_route=/wc/store/v1/products&slug=<segment>`).
   If the fetch is bot-blocked (403/challenge) and the field came from the deterministic
   scraper, trust it; if it came from a worker and can't be confirmed, hold the draw.
   KILL RULE: if any draw in a batch has a wrong field or a lazy/templated/duplicate
   description, DISCARD that worker's entire batch output and respawn a FRESH worker on the
   same batch with one line stating what was wrong. Max 2 redos per batch; still bad → hold
   those draws with reason "worker output unreliable: <field>". Count every redo.

8. **Publish / hold.** Only after a draw fully passes step 7, publish with ONE call so no
   half-QA'd draw is ever live:
   `bun manager/draw-update.mjs <id> '{"prize_description":"…","status":"active"}'`
   (fold corrected fields into the same JSON, e.g. "category_id":"<uuid>","grand_prize":"…",
   "draw_date":"…","ticket_price":2.5,"total_entries":4999).
   Held draws: apply safe fixes but keep status draft — '{"prize_description":"…"}'.
   A past-dated draft whose page says finished → '{"status":"ended"}'.
   A failed draw-update → retry once, then leave draft and report. If you run low on time or
   context mid-step, stop publishing — anything already active has passed; report the rest as held.

9. **Coverage audit.** `bun manager/coverage-report.mjs` (or `JSON=true …` for machine output).
   It cross-references all DB operators × operators.json × live counts and buckets them:
   missing-config / never-scraped / stalled / quiet / disabled, plus totals and drafts waiting.
   Escalate each missing-config, never-scraped, and stalled operator WITH EVIDENCE: check its
   listing with `curl -s -o /dev/null -w "%{http_code}" -A "Mozilla/5.0" "<base>"` and report
   "slug (method): live 0, listing HTTP 403, last insert 12d ago" — not vague notes.
   If the script is missing/fails: derive silent operators from step 2's health report, say the
   audit was degraded, and continue.

10. **Report — exactly this template:**
    ## PDD daily run — <YYYY-MM-DD>
    **Counts:** scraped N · refreshed N · AI-inserted N · described N · verified N ·
    published N · held N · worker batches redone N
    **Held drafts (every one, with reason):**
    - <operator>/<title> — <reason>
    **Category spread of published:** car N · cash N · house N · tech N · luxury N · collectibles N
    **Coverage deltas:** <operator>: live N (prev M) — only operators that moved
    **Silent / stalled / never-scraped operators (with evidence):**
    - <slug> (<method>) — <evidence>
    **New failure patterns:** <anything R1–R7 didn't anticipate, verbatim example — or "none">

## FALLBACK — no subagent tool available
If you cannot spawn subagents, do the same pipeline single-agent in TWO STRICT PASSES:
pass 1 = extraction (step 4) + drafting descriptions (step 6) with nothing published;
pass 2 = a fresh verification of every field of every draft per step 7, re-fetching pages anew
(do not trust pass-1 notes), then steps 8–10. The publish gate is identical.
