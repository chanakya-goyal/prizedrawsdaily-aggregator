-- Stage 0f / 0g plus the Trust Score's evidence date. NOT a render blocker — 0001 is what
-- unblocks the pipeline; this can land later without holding anything up. Kept separate for
-- exactly that reason: if one of these fails, the odds figure is still publishable.
--
-- Idempotent, no transaction wrapper, touches no existing data.

-- 1 ---------------------------------------------------------------- free-entry route
-- The conditions band renders the 'unknown' string until this is populated, which neither
-- asserts nor denies a free-entry route — so CAP 3.7 is satisfied on day one against a column
-- that is 100% empty, and 'unknown' is never a failure of any class.
alter table public.draws add column if not exists free_entry_route text not null default 'unknown';
alter table public.draws drop constraint if exists draws_free_entry_route_check;
alter table public.draws add constraint draws_free_entry_route_check
  check (free_entry_route in ('postal', 'online-free', 'none-stated', 'unknown'));

-- 2 ---------------------------------------------------------------- stop fabricating times
-- lib/parse.mjs substitutes 20:00 for a missing time in four places. That is a fabrication
-- rather than a default, and it is the reason no rendered asset may state a time of day.
-- Recording it lets the renderer tell a read time from an invented one.
alter table public.draws add column if not exists time_defaulted boolean not null default false;

-- 3 ---------------------------------------------------------------- Trust Score evidence date
-- The draw slide renders a "PDD 4.2" chip from operators.rating. Same CAP 3.7 problem as the
-- odds figure: a published numeric claim needs held, dated evidence. The scorecards already in
-- operators.trust_notes ARE that evidence; this column dates them, so the chip's alt text can
-- say when the score was last reviewed.
alter table public.operators add column if not exists rating_checked_at timestamptz;

-- 4 ---------------------------------------------------------------- did it work?
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (  (table_name = 'draws'     and column_name in ('free_entry_route', 'time_defaulted'))
      or (table_name = 'operators' and column_name = 'rating_checked_at'))
order by table_name, column_name;
