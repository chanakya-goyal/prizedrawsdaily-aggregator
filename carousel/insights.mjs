// carousel/insights.mjs — ingest Composio-pulled IG/FB analytics payloads into
// carousel_metrics, and print a joined last-7d report. Scripts can't call the
// Composio MCP directly (spec constraint); Claude pulls the JSON in-session
// (see INSIGHTS.md for the exact tool calls) and feeds saved files to this CLI.
//
//   bun carousel/insights.mjs ingest <ig_media|ig_reach|fb_posts> <file.json> [--dry-run]
//   bun carousel/insights.mjs report
//
// --dry-run (accepted anywhere in argv): parses the file + maps it, prints the row
// count and up to 3 sample rows, and exits 0 WITHOUT calling insertMetrics — use it
// to sanity-check a fresh Composio payload before it touches carousel_metrics.
import { insertMetrics, recentPosts, recentMetrics } from "./state.mjs";

const KINDS = ["ig_media", "ig_reach", "ig_insights", "fb_posts",
               "ig_media_insights", "ig_story_insights", "ig_account"];
const BATCH = 50;

const londonDay = (ts) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Europe/London" });

// ⚠ THE DEFECT THIS FILE SHIPPED WITH. `num` turns an ABSENT field into a stored 0,
// indistinguishable from a real zero. That is nearly harmless for like_count. It is not harmless
// for reel_avg_watch_time_ms, where a missing field stores a reel that looks like total
// abandonment — a number that would then be acted on.
//
// It is kept for the four ORIGINAL kinds, deliberately: carousel/tests/insights.test.mjs and
// INSIGHTS.md both lock in "missing shares → 0" as the current contract, and changing it is a
// separate migration with no benefit here. Every NEW kind uses `strict` instead:
//   absent          ⇒ NO ROW WRITTEN
//   present-and-zero ⇒ a row with value 0
const num = (v) => Number(v) || 0;
const strict = (v) => (v === null || v === undefined || v === "" ? undefined : (Number.isFinite(Number(v)) ? Number(v) : undefined));

// ── the reading's age, which is part of its identity ──────────────────────────────────────────
// Reach and views keep accruing for days. t72 is the canonical DECISION reading: long enough to
// catch most of the initial distribution, short enough for a weekly loop. There is no maturation
// curve published for an account this size, so 72h is design judgement, not a measured optimum.
export const WINDOWS = ["t24", "t72", "t168", "late", "legacy"];
export function windowFor(ageHours) {
  if (!Number.isFinite(ageHours)) return "legacy";
  if (ageHours <= 36) return "t24";
  if (ageHours <= 120) return "t72";
  if (ageHours <= 240) return "t168";
  return "late";
}

// Age is computed from the POST's own timestamp to the capture time. Both are needed: a payload
// that carries neither gets window 'legacy' and age_hours null rather than a guess, because a
// reading that landed at 61h must not be silently recorded as exactly 72h.
export function ageHours(postedAt, capturedAt) {
  const a = +new Date(postedAt), b = +new Date(capturedAt);
  if (!isFinite(a) || !isFinite(b)) return null;
  const h = (b - a) / 3600000;
  return h >= 0 ? Math.round(h) : null;
}

const stampRow = (row, { postedAt, capturedAt, source = "api" } = {}) => {
  const age = postedAt ? ageHours(postedAt, capturedAt || Date.now()) : null;
  return { ...row, source, age_hours: age, window: windowFor(age ?? NaN) };
};

// mapPayload — pure. Real Graph API field names in, carousel_metrics rows out.
export function mapPayload(kind, json) {
  const data = json?.data || [];

  if (kind === "ig_media") {
    return data.flatMap((m) => {
      const day = londonDay(m.timestamp);
      const media_id = String(m.id);
      return [
        { day, media_id, metric: "likes", value: num(m.like_count) },
        { day, media_id, metric: "comments", value: num(m.comments_count) },
      ];
    });
  }

  if (kind === "ig_reach") {
    return data.flatMap((entry) =>
      (entry.values || []).map((v) => ({
        day: londonDay(v.end_time),
        media_id: "account",
        metric: entry.name || "reach",
        value: num(v.value),
      }))
    );
  }

  // PER-MEDIA insights, which is where the metrics that actually matter live. ig_media gives
  // likes and comments; ig_reach gives ACCOUNT-level reach keyed "account", which cannot tell
  // one post from another. Neither carries saves or shares, and for this account those are the
  // two that matter most: a saved post is the behaviour a daily listings deck is FOR, and a
  // shared one is how a 66-follower account reaches anybody new.
  //
  // One measurement rule is a design constraint rather than a preference. Instagram's own
  // definitions (help.instagram.com/202865988324236) count Views as "starts to play or replay",
  // include replays in Watch time, and divide watch time INCLUDING replays by INITIAL views to
  // get average watch time. A seamless loop therefore inflates views, watch time and average
  // watch time without reaching one extra person — so on the Reel, reach and skip rate are the
  // only honest reads, and views are recorded but must never be reported as a win on their own.
  if (kind === "ig_insights") {
    // Accepts either the bare Graph response for one media, or a batch shaped
    // { media_id, data: [...] } / [{ media_id, data: [...] }].
    const batches = Array.isArray(json) ? json : [json];
    return batches.flatMap((b) => {
      const entries = b?.data || [];
      return entries.flatMap((e) => {
        // The media id is either supplied by the caller or embedded in the insight's own id,
        // which has the form "<media_id>/insights/<metric>/<period>".
        const media_id = String(b.media_id || String(e.id || "").split("/")[0] || "unknown");
        const day = b.day ? londonDay(b.day) : londonDay(Date.now());
        return (e.values || []).map((v) => ({
          day: v.end_time ? londonDay(v.end_time) : day,
          media_id,
          metric: e.name,
          value: num(v.value),
        }));
      });
    }).filter((r) => r.metric && r.media_id !== "unknown");
  }

  // ── the new kinds (§11.2 Channel A) ─────────────────────────────────────────────────────────
  // ⚠ GRAPH API FIELD NAMES ARE NOT VERIFIED. The research is authoritative on platform BEHAVIOUR
  // and says nothing about field spellings, and Meta has retired media metrics before
  // (`impressions`). So these readers do not hard-code field names at all: they walk the response
  // the way the Graph insights edge actually shapes it — `data[].name` / `data[].values[].value` —
  // and the metric name PDD stores is whatever Graph returned. An unrecognised response SHAPE
  // fails loudly rather than writing zeros.
  //
  // What each one is FOR: reach is the mandated denominator; saved is the intent signal a
  // directory should optimise for, because a save is a viewer keeping the list; shares are how a
  // 66-follower account reaches anybody new. Views are recorded and must never be reported as a
  // win on their own — the Reel loops by construction, which inflates views, watch time and
  // average watch time without reaching one extra person.
  if (kind === "ig_media_insights" || kind === "ig_story_insights") {
    const batches = Array.isArray(json) ? json : [json];
    const rows = [];
    for (const b of batches) {
      const entries = b?.data;
      if (!Array.isArray(entries)) {
        throw new Error(`insights: ${kind} payload has no data[] array — refusing to write zeros for an unrecognised response shape`);
      }
      for (const e of entries) {
        const media_id = String(b?.media_id || String(e?.id || "").split("/")[0] || "unknown");
        if (media_id === "unknown" || !e?.name) continue;   // never file a metric under a guess
        for (const v of e.values || []) {
          const value = strict(v?.value);
          if (value === undefined) continue;                // ABSENT ⇒ no row
          rows.push(stampRow({
            day: v.end_time ? londonDay(v.end_time) : (b.day ? londonDay(b.day) : londonDay(Date.now())),
            media_id, metric: e.name, value,
          }, { postedAt: b.posted_at || b.timestamp, capturedAt: b.captured_at }));
        }
      }
    }
    // A Story's insights are NOT retrievable once it expires, so they are pulled on the same day
    // at t24 only and a missed day is permanently lost. That is why no Story criterion carries a
    // target anywhere: Story data is diagnostic, never a gate.
    return kind === "ig_story_insights" ? rows.map((r) => ({ ...r, window: "t24" })) : rows;
  }

  // The follower count, daily, keyed 'account'. It makes the 200-follower Trial Reels gate an
  // OBSERVABLE EVENT rather than something noticed by accident.
  if (kind === "ig_account") {
    const src = Array.isArray(json?.data) ? json.data : [json];
    const rows = [];
    for (const a of src) {
      const value = strict(a?.followers_count ?? a?.followers ?? a?.value);
      if (value === undefined) continue;
      rows.push(stampRow({ day: londonDay(a?.day || Date.now()), media_id: "account", metric: "followers", value },
                         { postedAt: null }));
    }
    if (!rows.length && !Array.isArray(json?.data)) {
      throw new Error("insights: ig_account payload carried no followers_count — refusing to write a zero");
    }
    return rows;
  }

  if (kind === "fb_posts") {
    return data.flatMap((p) => {
      const day = londonDay(p.created_time);
      const media_id = String(p.id);
      return [
        { day, media_id, metric: "fb_reactions", value: num(p.reactions?.summary?.total_count) },
        { day, media_id, metric: "fb_comments", value: num(p.comments?.summary?.total_count) },
        { day, media_id, metric: "fb_shares", value: num(p.shares?.count) },
      ];
    });
  }

  throw new Error(`insights: unknown kind "${kind}" (expected ${KINDS.join("|")})`);
}

async function cmdIngest(kind, file, { dryRun = false } = {}) {
  if (!kind || !file) {
    console.error(`usage: bun carousel/insights.mjs ingest <${KINDS.join("|")}> <file.json> [--dry-run]`);
    process.exit(1);
  }
  if (!KINDS.includes(kind)) {
    console.error(`✗ insights: unknown kind "${kind}" (expected ${KINDS.join("|")})`);
    process.exit(1);
  }
  const f = Bun.file(file);
  if (!(await f.exists())) {
    console.error(`✗ insights: file not found: ${file}`);
    process.exit(1);
  }
  let json;
  try {
    json = await f.json();
  } catch (e) {
    console.error(`✗ insights: ${file} is not valid JSON: ${e?.message || e}`);
    process.exit(1);
  }

  const mapped = mapPayload(kind, json);
  // Derived rows are appended, never substituted: source='derived' is what tells them apart from
  // an observed figure later, and both must land in the same upsert so a partial write cannot
  // leave a quotient without its inputs.
  const rows = [...mapped, ...derivedRows(mapped)];
  if (!rows.length) {
    console.log(`(no rows mapped from ${kind} — empty payload)`);
    return;
  }

  if (dryRun) {
    console.log(`(dry run) ${rows.length} row(s) would be ingested from ${kind} (${file}) — no writes performed`);
    for (const r of rows.slice(0, 3)) console.log("  " + JSON.stringify(r));
    process.exit(0);
  }

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await insertMetrics(batch);
    console.log(`  ✓ upserted ${batch.length} ${kind} rows (${Math.min(i + BATCH, rows.length)}/${rows.length})`);
  }
  console.log(`✓ ingested ${rows.length} rows from ${kind} (${file})`);
}

// ── derived rows (§11.2) ──────────────────────────────────────────────────────────────────────
// Both follow directly from Meta's own published definition of average watch time: it is watch
// time INCLUDING replays divided by INITIAL views.
//
//   reel_initial_views = reel_watch_time_total_ms ÷ reel_avg_watch_time_ms
//   reel_replays       = views − reel_initial_views
//
// They are quotients of small integers and are UNUSABLE at this account's scale: with a handful
// of views, rounding in reel_avg_watch_time_ms dominates the result entirely. So they are
// suppressed below 50 views. That threshold is my design judgement about where rounding stops
// swamping the signal — it is not a measured optimum, and it is written here rather than left
// implicit so that nobody reads a derived figure as an observed one.
export const DERIVED_MIN_VIEWS = 50;

export function derivedRows(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.day}|${r.media_id}|${r.window || "legacy"}`;
    if (!by.has(k)) by.set(k, { ...r, metrics: new Map() });
    by.get(k).metrics.set(r.metric, Number(r.value));
  }
  const out = [];
  for (const g of by.values()) {
    const total = g.metrics.get("reel_watch_time_total_ms");
    const avg = g.metrics.get("reel_avg_watch_time_ms");
    const views = g.metrics.get("views");
    if (!Number.isFinite(total) || !Number.isFinite(avg) || avg <= 0) continue;
    if (!Number.isFinite(views) || views < DERIVED_MIN_VIEWS) continue;   // n/a, not zero
    const initial = Math.round(total / avg);
    out.push({ day: g.day, media_id: g.media_id, window: g.window || "legacy", age_hours: g.age_hours ?? null,
               source: "derived", metric: "reel_initial_views", value: initial });
    out.push({ day: g.day, media_id: g.media_id, window: g.window || "legacy", age_hours: g.age_hours ?? null,
               source: "derived", metric: "reel_replays", value: Math.max(0, views - initial) });
  }
  return out;
}

// buildReport — joins last-7d carousel_posts × carousel_metrics and prints a
// per-day table. Exported so it can be exercised without shelling out.
export async function buildReport() {
  const [posts, metrics] = await Promise.all([recentPosts(7), recentMetrics(7)]);

  if (!metrics.length) {
    console.log("no metrics yet");
    return;
  }

  const byDay = new Map();
  for (const p of posts) {
    if (!byDay.has(p.date)) byDay.set(p.date, { formats: [], category: null, posts: [] });
    const d = byDay.get(p.date);
    d.formats.push(p.format);
    d.category = d.category || p.category;
    d.posts.push(p);
  }

  const metricsByDay = new Map();
  for (const m of metrics) {
    if (!metricsByDay.has(m.day)) metricsByDay.set(m.day, []);
    metricsByDay.get(m.day).push(m);
  }

  const allDays = [...new Set([...byDay.keys(), ...metricsByDay.keys()])].sort().reverse();

  console.log("date        formats            category      reach   per-post (ig_media_id: likes/comments)");
  console.log("-".repeat(100));
  for (const day of allDays) {
    const d = byDay.get(day) || { formats: [], category: null, posts: [] };
    const dayMetrics = metricsByDay.get(day) || [];
    const reach = dayMetrics.find((m) => m.media_id === "account" && m.metric === "reach")?.value ?? "-";
    const formats = d.formats.length ? d.formats.join(",") : "-";
    const category = d.category || "-";
    const perPost = d.posts
      .filter((p) => p.ig_media_id)
      .map((p) => {
        const likes = dayMetrics.find((m) => m.media_id === p.ig_media_id && m.metric === "likes")?.value ?? "-";
        const comments = dayMetrics.find((m) => m.media_id === p.ig_media_id && m.metric === "comments")?.value ?? "-";
        return `${p.ig_media_id}:${likes}/${comments}`;
      })
      .join(" ") || "-";
    console.log(`${day}  ${formats.padEnd(18)} ${String(category).padEnd(13)} ${String(reach).padEnd(7)} ${perPost}`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const [cmd, ...rest] = argv.filter((a) => a !== "--dry-run");
  if (cmd === "ingest") await cmdIngest(rest[0], rest[1], { dryRun });
  else if (cmd === "report") await buildReport();
  else {
    console.error(`usage: bun carousel/insights.mjs ingest <${KINDS.join("|")}> <file.json> [--dry-run]`);
    console.error("       bun carousel/insights.mjs report");
    console.error("       --dry-run: parse + map only, print row count + up to 3 sample rows, no writes (exit 0)");
    process.exit(1);
  }
}
