// carousel/insights.mjs — ingest Composio-pulled IG/FB analytics payloads into
// carousel_metrics, and print a joined last-7d report. Scripts can't call the
// Composio MCP directly (spec constraint); Claude pulls the JSON in-session
// (see INSIGHTS.md for the exact tool calls) and feeds saved files to this CLI.
//
//   bun carousel/insights.mjs ingest <ig_media|ig_reach|fb_posts> <file.json>
//   bun carousel/insights.mjs report
import { insertMetrics, recentPosts, recentMetrics } from "./state.mjs";

const KINDS = ["ig_media", "ig_reach", "fb_posts"];
const BATCH = 50;

const londonDay = (ts) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const num = (v) => Number(v) || 0;

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

async function cmdIngest(kind, file) {
  if (!kind || !file) {
    console.error(`usage: bun carousel/insights.mjs ingest <${KINDS.join("|")}> <file.json>`);
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

  const rows = mapPayload(kind, json);
  if (!rows.length) {
    console.log(`(no rows mapped from ${kind} — empty payload)`);
    return;
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await insertMetrics(batch);
    console.log(`  ✓ upserted ${batch.length} ${kind} rows (${Math.min(i + BATCH, rows.length)}/${rows.length})`);
  }
  console.log(`✓ ingested ${rows.length} rows from ${kind} (${file})`);
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
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "ingest") await cmdIngest(rest[0], rest[1]);
  else if (cmd === "report") await buildReport();
  else {
    console.error(`usage: bun carousel/insights.mjs ingest <${KINDS.join("|")}> <file.json>`);
    console.error("       bun carousel/insights.mjs report");
    process.exit(1);
  }
}
