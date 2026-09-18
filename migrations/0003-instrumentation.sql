-- 0003-instrumentation.sql — Stage E (spec §11.2). Paste into Supabase → SQL editor.
--
-- WHY THIS IS A GATE AND NOT A NICE-TO-HAVE
-- Stage E is a precondition on the FIRST POST of the new format, because the moment that post
-- ships the only comparison available is a twelve-row set from 3 July 2026. Nothing has published
-- yet (today's five rows sit at assets_uploaded), so the window is still open.
--
-- Additive and idempotent. The 95 existing carousel_metrics rows default cleanly to
-- source='api', window='legacy', age_hours=NULL — NULL because their real age at capture is
-- genuinely unknowable, and a guessed provenance figure is worse than none.

begin;

-- ── carousel_metrics ─────────────────────────────────────────────────────────────────────────
-- source: an app-typed number must never be mistaken for an API number.
alter table carousel_metrics add column if not exists source text not null default 'api';

-- window: reach and views keep accruing for DAYS. The old PK (day, media_id, metric) made the
-- last capture silently overwrite the first, so today you cannot tell whether a post's 12 views
-- were at 6 hours or 6 days. 'legacy' exists solely to carry the 95 pre-rework rows.
--
-- ⚠ WINDOW IS A RESERVED WORD IN POSTGRES (window functions), so it must be double-quoted in any
-- hand-written SQL: `select "window" from carousel_metrics`. The application never writes raw SQL
-- against this table — PostgREST quotes its own identifiers — so the footgun is contained to this
-- file and to the dashboard. The name is §11.2's and is kept for that reason.
alter table carousel_metrics add column if not exists "window" text not null default 'legacy';

-- age_hours: NULLABLE on purpose. The actual age at capture, so a reading that landed at 61h is
-- not silently treated as exactly 72h.
alter table carousel_metrics add column if not exists age_hours integer;

alter table carousel_metrics drop constraint if exists carousel_metrics_source_chk;
alter table carousel_metrics add  constraint carousel_metrics_source_chk
  check (source in ('api', 'app', 'derived'));

alter table carousel_metrics drop constraint if exists carousel_metrics_window_chk;
alter table carousel_metrics add  constraint carousel_metrics_window_chk
  check ("window" in ('t24', 't72', 't168', 'late', 'legacy'));

-- The primary key gains `window`. ⚠ THIS IS A TWO-PLACE CHANGE: the DDL here AND the PostgREST
-- upsert key in carousel/state.mjs. Changing one without the other silently reverts to
-- last-write-wins, which is the exact defect this column exists to fix.
alter table carousel_metrics drop constraint if exists carousel_metrics_pkey;
alter table carousel_metrics add  constraint carousel_metrics_pkey
  primary key (day, media_id, metric, "window");

-- ── carousel_curves ──────────────────────────────────────────────────────────────────────────
-- The retention curve is a SERIES, not a scalar, and does not belong in a key-value table.
-- `points` must always include an explicit reading at t_ms = 3000, because the Reels Chaining
-- system card (transparency.meta.com, updated 11 Nov 2025) names "watch under 3 seconds" as an
-- input to the abandonment prediction head.
create table if not exists carousel_curves (
  day          date not null,
  media_id     text not null,
  kind         text not null,                  -- 'reel_retention'
  points       jsonb not null,                 -- [{t_ms, t_pct, viewers_pct}, …]
  source       text not null,                  -- 'app'
  -- Every app-transcribed row carries an archived screenshot. That deliberately borrows CAP 3.7's
  -- discipline — hold documentary evidence before publication — and applies it to our OWN
  -- numbers. CAP does not require it for internal metrics; it is a judgement that a hand-typed
  -- number without an audit trail will eventually be wrong and unfalsifiable.
  evidence_url text,
  captured_at  timestamptz not null default now(),
  primary key (day, media_id, kind)
);

alter table carousel_curves enable row level security;
drop policy if exists "anon read carousel_curves" on carousel_curves;
create policy "anon read carousel_curves" on carousel_curves for select using (true);

-- ── carousel_posts ───────────────────────────────────────────────────────────────────────────
-- draws_rendered: the deck size this post actually SHIPPED at. §5.11's ladder shrinks a deck one
-- draw at a time, so a series that silently mixes deck sizes cannot be read at all.
alter table carousel_posts add column if not exists draws_rendered integer;

-- archetype_requested: what the rotation DREW, before any substitution. Without it a substituted
-- post is silently credited to the wrong arm.
alter table carousel_posts add column if not exists archetype_requested text;

-- cover_headline: the literal rendered string. Diagnostic only — it is how a degenerate or
-- fallen-through headline becomes visible afterwards. Never the experiment key.
alter table carousel_posts add column if not exists cover_headline text;

-- reel_arm: hook_archetype was OVERLOADED — the caption archetype on carousel rows and
-- arm-A/B/C on reel rows. Two experiments in one column cannot be crossed.
alter table carousel_posts add column if not exists reel_arm text;

-- arm_source: REEL_ARM=A|B|C lets a human force an arm and nothing recorded that it was forced.
-- A hand-picked arm scored as a rotation draw is a corrupted experiment.
alter table carousel_posts add column if not exists arm_source text;

-- duration_ms: watch duration is judged against peer reels of SIMILAR LENGTH (Reels Chaining
-- system card), so the length cohort must be stored or the watch metrics are uninterpretable.
alter table carousel_posts add column if not exists duration_ms integer;

-- is_loop: marks a seamless loop so its watch figures always carry the inflation caveat. The
-- Reel's loop is asserted byte-identical at the wrap point, so this is true by construction.
alter table carousel_posts add column if not exists is_loop boolean;

-- gate_violations: a jsonb counter of §10's L2/L4 predicate hits, keyed by predicate. §10.6a
-- demotes the deny-list to a backstop, and a backstop whose firing rate is never recorded cannot
-- be told apart from one that does nothing.
alter table carousel_posts add column if not exists gate_violations jsonb not null default '{}';

-- followers_at_post: so the one permitted follower-denominated line is computed against the right
-- number rather than today's.
alter table carousel_posts add column if not exists followers_at_post integer;

-- caption_sha256: §10.7 P4. Detection, not prevention — it lets a post-publish reconciliation
-- compare the live caption against what was cleared.
alter table carousel_posts add column if not exists caption_sha256 text;

alter table carousel_posts drop constraint if exists carousel_posts_arm_source_chk;
alter table carousel_posts add  constraint carousel_posts_arm_source_chk
  check (arm_source is null or arm_source in ('rotation', 'env_override'));

-- figures_checked_at became a query predicate in 0001; this is the index that makes it one.
create index if not exists carousel_metrics_day_idx on carousel_metrics (day desc);
create index if not exists carousel_posts_date_idx   on carousel_posts   (date desc);

commit;

-- Verify (expect 3 rows, then 11, then the 4-column PK):
--   select column_name from information_schema.columns
--    where table_name='carousel_metrics' and column_name in ('source','window','age_hours');
--   select count(*) from information_schema.columns
--    where table_name='carousel_posts'
--      and column_name in ('draws_rendered','archetype_requested','cover_headline','reel_arm',
--                          'arm_source','duration_ms','is_loop','gate_violations',
--                          'followers_at_post','caption_sha256');
--   select a.attname from pg_index i join pg_attribute a
--     on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
--    where i.indrelid='carousel_metrics'::regclass and i.indisprimary;
