-- The free-limit guardian (quota-watch.mjs). Paste this WHOLE file into the Supabase SQL editor
-- of the LIVE project once. It is safe to run again: everything is create-or-replace /
-- if-not-exists. It includes all of sql/2026-10-09-usage-snapshots.sql, so that one is not needed.
--
-- What it gives the service_role key the scraper already holds:
--   (a)+(b) the API request counter and a table for its snapshots (the egress estimate);
--   (c)     the database's size in bytes (the Free plan allows 500 MB);
--   (d)     one reading per limit per day, which is what the forecasts are made from.
-- Only counts and sizes are exposed, never data or query text. RLS is on, with no policies.

-- (a) Request counts by source since pg_stat_statements last reset.
--     PostgREST runs one `select set_config('search_path', …)` preamble per request; the role it
--     runs as tells the site (anon) from the scraper (service_role) and signed-in users
--     (authenticated). The Storage API's preamble is a multi-line `SELECT set_config('role', $1,
--     true), set_config('request.jwt.claim.role', …)` instead.
create or replace function public.api_request_total()
returns table (
  rest_anon bigint,
  rest_service bigint,
  rest_authenticated bigint,
  storage bigint,
  stats_reset timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum(s.calls) filter (where s.query like 'select set_config(''search_path''%' and r.rolname = 'anon'), 0)::bigint,
    coalesce(sum(s.calls) filter (where s.query like 'select set_config(''search_path''%' and r.rolname = 'service_role'), 0)::bigint,
    coalesce(sum(s.calls) filter (where s.query like 'select set_config(''search_path''%' and r.rolname = 'authenticated'), 0)::bigint,
    coalesce(sum(s.calls) filter (where s.query like 'SELECT%set_config(''role'', $1, true)%set_config(''request.jwt.claim.role''%'), 0)::bigint,
    (select i.stats_reset from extensions.pg_stat_statements_info i)
  from extensions.pg_stat_statements s
  join pg_catalog.pg_roles r on r.oid = s.userid;
$$;

revoke all on function public.api_request_total() from public, anon, authenticated;
grant execute on function public.api_request_total() to service_role;

-- (b) One row per scheduled run (~1 a day). RLS on with no policies: only service_role reads or writes.
create table if not exists public.usage_snapshots (
  taken_at timestamptz primary key default now(),
  rest_anon bigint not null default 0,
  rest_service bigint not null default 0,
  rest_authenticated bigint not null default 0,
  storage bigint not null default 0,
  stats_reset timestamptz
);
alter table public.usage_snapshots enable row level security;
revoke all on table public.usage_snapshots from anon, authenticated;
grant select, insert on table public.usage_snapshots to service_role;

-- (c) Database size in bytes.
create or replace function public.database_size()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.pg_database_size(pg_catalog.current_database());
$$;

revoke all on function public.database_size() from public, anon, authenticated;
grant execute on function public.database_size() to service_role;

-- (d) One reading per limit per day. Re-running a day updates its row.
create table if not exists public.quota_snapshots (
  day date not null,
  metric text not null,
  value double precision not null,
  limit_value double precision not null,
  taken_at timestamptz not null default now(),
  primary key (day, metric)
);
alter table public.quota_snapshots enable row level security;
revoke all on table public.quota_snapshots from anon, authenticated;
grant select, insert, update on table public.quota_snapshots to service_role;

-- Check (each should return a row):
-- select * from public.api_request_total();
-- select public.database_size();
