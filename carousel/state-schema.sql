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
  day date not null,
  media_id text not null default 'account',
  metric text not null,
  value numeric,
  captured_at timestamptz not null default now(),
  primary key (day, media_id, metric)
);

alter table carousel_posts enable row level security;
alter table carousel_metrics enable row level security;
-- anon may READ (cloud watchdog / reports); only service_role writes (bypasses RLS).
create policy "anon read carousel_posts" on carousel_posts for select using (true);
create policy "anon read carousel_metrics" on carousel_metrics for select using (true);
