-- carousel/state-schema.sql — one-time setup, run in Supabase dashboard → SQL editor.
create table if not exists carousel_posts (
  date date not null,
  format text not null,
  status text not null default 'pending',
  category text,
  draw_slugs jsonb not null default '[]',
  hook_archetype text,
  seo_keyword text,
  caption text,
  ig_container_id text,
  ig_media_id text,
  fb_post_id text,
  asset_urls jsonb not null default '[]',
  posted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (date, format)
);

create table if not exists carousel_metrics (
  day date not null,                      -- the POST's own Europe/London date, never the capture date
  media_id text not null default 'account',
  metric text not null,
  value numeric,
  -- An app-typed number must never be mistaken for an API number.
  source text not null default 'api' check (source in ('api', 'app', 'derived')),
  -- Reach and views keep accruing for days, so the reading's AGE is part of its identity.
  -- ⚠ "window" is a reserved word in Postgres — double-quote it in hand-written SQL.
  "window" text not null default 'legacy' check ("window" in ('t24', 't72', 't168', 'late', 'legacy')),
  age_hours integer,                      -- nullable: unknowable on the pre-rework rows
  captured_at timestamptz not null default now(),
  primary key (day, media_id, metric, "window")
);

-- The retention curve is a series, not a scalar (spec §11.2 Channel B). Hand-transcribed from
-- Instagram's own app, so every row carries an archived screenshot of the chart it came from.
create table if not exists carousel_curves (
  day date not null,
  media_id text not null,
  kind text not null,
  points jsonb not null,                  -- [{t_ms, t_pct, viewers_pct}, …], must include t_ms=3000
  source text not null default 'app',
  evidence_url text,
  captured_at timestamptz not null default now(),
  primary key (day, media_id, kind)
);

alter table carousel_posts enable row level security;
alter table carousel_metrics enable row level security;
alter table carousel_curves enable row level security;
-- anon may READ (cloud watchdog / reports); only service_role writes (bypasses RLS).
create policy "anon read carousel_posts" on carousel_posts for select using (true);
create policy "anon read carousel_metrics" on carousel_metrics for select using (true);
create policy "anon read carousel_curves" on carousel_curves for select using (true);
