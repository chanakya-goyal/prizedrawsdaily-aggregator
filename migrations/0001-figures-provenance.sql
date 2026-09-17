-- Stage 0a / 0f / 0g of the social template rework (spec §10.4, §10.2, §12.4).
--
-- WHY THIS EXISTS
-- The carousel renders an odds figure ("1 IN 13,995") derived from draws.total_entries.
-- That is a published objective claim about a named third party, and CAP 3.7 requires the
-- evidence to be held BEFORE publication. Today nothing records where total_entries came
-- from or when it was read, so the figure cannot be defended and cannot be rendered.
--
-- These columns are row-scoped rather than per-figure because ticket_price, total_entries
-- and draw_date are all read from one fetch of one page in one instant by fieldsFromHtml.
-- Nine columns for one observation would be redundant; only total_entries has an extraction
-- path whose confidence varies, so only it carries a method.
--
-- Follows the shipped category_source precedent exactly: enum text, DB CHECK constraint,
-- validation in manager/draw-update.mjs so a typo fails loudly instead of as an opaque 400.

begin;

-- ---------------------------------------------------------------- 0a: provenance
alter table public.draws
  add column if not exists figures_source_url   text,
  add column if not exists figures_checked_at   timestamptz,
  add column if not exists total_entries_method text;

comment on column public.draws.figures_source_url is
  'The operator URL actually fetched for this row''s figures. Not the entry_url.';
comment on column public.draws.figures_checked_at is
  'When that fetch happened. Deliberately distinct from updated_at, which moves for any write.';
comment on column public.draws.total_entries_method is
  'How total_entries was extracted. Drives render eligibility: bare-count and NULL never render.';

-- The enum is derived from the actual ?? chain at lib/parse.mjs:724-729, not invented.
--   operator-pattern  extractEntries step 0, op.patterns.entries        renders
--   labelled-cap      extractEntries tier 1 / 1b (the strict branches)  renders
--   derived-sum       ltyCap, sold + remaining scoped to the progress bar renders
--   progress-bar      extractEntries tier 2, takeDenom                  renders
--   bare-count        extractEntries tier 3, the noisy unlabelled grab  NEVER renders
--   agent-read        manager/draw-insert.mjs, manager/draw-update.mjs  renders
--   manual            qa-fix.mjs, hand PATCH                            renders
--   NULL              every row written before this migration           NEVER renders
--
-- operator-api is deliberately absent and must never be added: the Woo/Shopify stock count
-- is tickets REMAINING and falls every day, so it is not a cap and an odds figure built on
-- it would be wrong in a direction that flatters us.
alter table public.draws
  drop constraint if exists draws_total_entries_method_check;
alter table public.draws
  add constraint draws_total_entries_method_check
  check (total_entries_method is null or total_entries_method in (
    'operator-pattern', 'labelled-cap', 'derived-sum',
    'progress-bar', 'bare-count', 'agent-read', 'manual'));

-- figures_checked_at becomes a query predicate in carousel/select.mjs's 48h freshness
-- filter, which runs on every deck build.
create index if not exists draws_figures_checked_at_idx
  on public.draws using btree (figures_checked_at);

-- ---------------------------------------------------------------- 0f: free entry route
-- Column only, no parser work, not a render blocker. The conditions band renders the
-- 'unknown' string until this is populated, which neither asserts nor denies a free-entry
-- route — so CAP 3.7 is satisfied on day one and 'unknown' is never a failure of any class.
alter table public.draws
  add column if not exists free_entry_route text not null default 'unknown';
alter table public.draws
  drop constraint if exists draws_free_entry_route_check;
alter table public.draws
  add constraint draws_free_entry_route_check
  check (free_entry_route in ('postal', 'online-free', 'none-stated', 'unknown'));

-- ---------------------------------------------------------------- 0g: stop fabricating times
-- lib/parse.mjs substitutes 20:00 for a missing time in four places. That is a fabrication,
-- not a default, and it is the reason no rendered asset may state a time of day. Recording
-- it lets the renderer tell a read time from an invented one.
alter table public.draws
  add column if not exists time_defaulted boolean not null default false;
comment on column public.draws.time_defaulted is
  'True when draw_date''s TIME component was substituted rather than read from the page.';

-- ---------------------------------------------------------------- Trust Score evidence
-- The draw slide renders a "PDD 4.2" chip sourced from operators.rating. Same CAP 3.7
-- problem as the odds figure: a published numeric claim needs held, dated evidence. The
-- scorecards in trust_notes are that evidence; this column dates them so the chip's alt
-- text can say when it was last reviewed.
alter table public.operators
  add column if not exists rating_checked_at timestamptz;

commit;
