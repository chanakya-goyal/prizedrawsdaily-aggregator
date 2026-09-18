-- Stage 0a: the three columns the odds figure cannot be published without.
--
-- WHY THIS EXISTS
-- The carousel renders an odds figure derived from draws.total_entries ("1 IN 13,995"). That is
-- a published objective claim about a named third party's promotion, and CAP 3.7 requires the
-- evidence to be held BEFORE publication. Nothing currently records where total_entries came
-- from or when it was read, so the figure cannot be defended and the renderer refuses it.
--
-- HOW TO RUN IT
-- Paste into the Supabase SQL Editor and run. There is deliberately NO transaction wrapper:
-- inside one, a single failing statement makes every later statement report "current
-- transaction is aborted", which hides the one real error behind a wall of them. Every
-- statement here is idempotent, so running it twice is safe and running it after a partial
-- failure just completes the job.
--
-- Nothing here touches existing data. No row is written, no column is dropped, no default is
-- backfilled onto draws.total_entries.

-- 1 ---------------------------------------------------------------- the columns
alter table public.draws add column if not exists figures_source_url   text;
alter table public.draws add column if not exists figures_checked_at   timestamptz;
alter table public.draws add column if not exists total_entries_method text;

-- 2 ---------------------------------------------------------------- the method enum
-- Derived from the actual ?? chain at lib/parse.mjs:724-729, not invented:
--   operator-pattern  extractEntries step 0, the operator's own override      renders
--   labelled-cap      tier 1 / 1b, the two strict branches                    renders
--   derived-sum       ltyCap — sold + remaining, scoped to the progress bar    renders
--   progress-bar      tier 2, takeDenom                                       renders
--   bare-count        tier 3, the noisy unlabelled grab                       NEVER renders
--   agent-read        manager/draw-insert.mjs, manager/draw-update.mjs        renders
--   manual            qa-fix.mjs, a hand PATCH                                renders
--   NULL              every row written before this migration                 NEVER renders
--
-- operator-api is deliberately absent and must never be added: the Woo/Shopify stock count is
-- tickets REMAINING and falls every day, so it is not a cap, and an odds figure built on it
-- would be wrong in the direction that flatters us.
alter table public.draws drop constraint if exists draws_total_entries_method_check;
alter table public.draws add constraint draws_total_entries_method_check
  check (total_entries_method is null or total_entries_method in (
    'operator-pattern', 'labelled-cap', 'derived-sum',
    'progress-bar', 'bare-count', 'agent-read', 'manual'));

-- 3 ---------------------------------------------------------------- the freshness index
-- figures_checked_at becomes a query predicate in carousel/select.mjs's 48h filter, which runs
-- on every deck build.
create index if not exists draws_figures_checked_at_idx
  on public.draws using btree (figures_checked_at);

-- 4 ---------------------------------------------------------------- did it work?
-- Expect three rows back. If you see three, the pipeline is unblocked.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'draws'
  and column_name in ('figures_source_url', 'figures_checked_at', 'total_entries_method')
order by column_name;
