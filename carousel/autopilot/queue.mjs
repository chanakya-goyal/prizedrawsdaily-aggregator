// carousel/autopilot/queue.mjs — the Reel slots: build once at lunchtime, post at UK times.
//
// The daily run (12:15 UK) builds the carousel, the Story and two native Reels. The carousel and
// the Story post straight away. Each Reel is hosted and QUEUED here for its own slot, and a short
// publisher run (run.sh --slot) posts it later:
//   reel    17:30–19:30 UK, the same day      (after work)
//   reel-2  07:30–09:30 UK, the next morning  (the commute)
// Why slots: the 21 Oct audit showed one post a day reaching 2–5 accounts, and every post went out
// within the same hour, so time of day could not even be measured. Three slots both add the
// format that reaches new people and give the insights pull a spread of times to compare.
//
//   bun carousel/autopilot/queue.mjs add <reel|reel-2>     host the built Reel + queue it (daily run)
//   bun carousel/autopilot/queue.mjs due [auto|<slot>]     exit 0 + print the item when one is due now
//   bun carousel/autopilot/queue.mjs done <slot> --ig ID   mark published, unqueue, free the day's assets
//   bun carousel/autopilot/queue.mjs drop <slot> <reason>  mark skipped, unqueue
//   bun carousel/autopilot/queue.mjs published <slot> <date>  exit 0 when that row is published
//
// The queue lives OUTSIDE $PDD_DIR: plan.mjs archives everything in the work dir each morning.
import { mkdir, rm } from "node:fs/promises";
import { GLOBAL, workDir } from "../config.mjs";
import { upsertPost, markStatus, getPost, todayLondon } from "../state.mjs";
import { supabaseUrl } from "../../lib/sb.mjs";
import { uploadHeaders } from "../../lib/storage.mjs";
import { withRetry } from "../util.mjs";
import * as compliance from "../compliance.mjs";

export const QUEUE_DIR = process.env.AUTOPOST_QUEUE || `${process.env.HOME}/pdd-autopost-queue`;
export const SLOTS = {
  reel: { dayOffset: 0, from: "17:30", to: "19:30", dir: "/reel-1" },
  "reel-2": { dayOffset: 1, from: "07:30", to: "09:30", dir: "/reel-2" },
};
// A draw must stay open this long after its slot closes, or the Reel is not queued / not posted:
// a Reel for a draw that has closed is an ad for nothing.
export const RUNWAY_MS = 2 * 3600e3;

// ── London wall-clock ↔ UTC (pure) ────────────────────────────────────────────────────────────
const offsetMin = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60000) * 60000) / 60000;
};
export function londonToUtc(ymd, hm) {
  const [y, m, d] = ymd.split("-").map(Number), [h, mi] = hm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetMin(guess) * 60000;
  t = guess - offsetMin(t) * 60000;          // second pass settles the clock-change days
  return new Date(t);
}
export const addDays = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

export function slotWindow(slot, buildDate) {
  const s = SLOTS[slot];
  if (!s) throw new Error(`unknown slot "${slot}" (reel | reel-2)`);
  const day = addDays(buildDate, s.dayOffset);
  return { from: londonToUtc(day, s.from), to: londonToUtc(day, s.to) };
}

// Pure: may this queued item post now? Returns { ok, why }.
export function dueVerdict(item, { now = new Date(), row = null, draw = null } = {}) {
  if (!item) return { ok: false, why: "nothing queued" };
  const from = new Date(item.from), to = new Date(item.to);
  if (now < from) return { ok: false, why: `not yet: the slot opens ${item.from}` };
  if (now > to) return { ok: false, why: `missed: the slot closed ${item.to}`, expired: true };
  if (row?.status === "published") return { ok: false, why: `already published (${row.ig_media_id || "no id"})`, done: true };
  if (!draw) return { ok: false, why: "the draw row could not be read: not posting blind", expired: false };
  if (draw.status !== "active") return { ok: false, why: `the draw is ${draw.status}, not active`, expired: true };
  if (+new Date(draw.draw_date) - now.getTime() < RUNWAY_MS) return { ok: false, why: `the draw closes ${draw.draw_date}: under 2 hours left`, expired: true };
  return { ok: true, why: "due" };
}

export const slotForNow = (now = new Date()) => {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(now));
  return h >= 17 && h < 20 ? "reel" : h >= 7 && h < 10 ? "reel-2" : null;
};

// ── I/O ───────────────────────────────────────────────────────────────────────────────────────
const qPath = (slot) => `${QUEUE_DIR}/${slot}.json`;
const readItem = (slot) => Bun.file(qPath(slot)).json().catch(() => null);
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

async function upload(path, buf, contentType) {
  const r = await fetch(`${supabaseUrl()}/storage/v1/object/${GLOBAL.bucket}/${path}`, {
    method: "POST", headers: { ...uploadHeaders({ serviceKey: KEY(), contentType }), "x-upsert": "true" }, body: buf,
  });
  if (!r.ok) throw new Error(`upload ${path} failed ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return `${supabaseUrl()}/storage/v1/object/public/${GLOBAL.bucket}/${path}`;
}

async function readDraw(slug) {
  const k = KEY() || process.env.SUPABASE_PUBLISHABLE_KEY;
  const r = await fetch(`${supabaseUrl()}/rest/v1/draws?slug=eq.${encodeURIComponent(slug)}&select=slug,status,draw_date&limit=1`,
    { headers: { apikey: k, Authorization: "Bearer " + k } });
  if (!r.ok) throw new Error(`draw ${slug}: HTTP ${r.status}`);
  return (await r.json())[0] || null;
}

async function add(slot) {
  if (!SLOTS[slot]) throw new Error(`unknown slot "${slot}"`);
  if (!KEY()) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  const DIR = workDir(), out = `${DIR}/out${SLOTS[slot].dir}`;
  const meta = await Bun.file(`${out}/reel-meta.json`).json().catch(() => null);
  const caption = await Bun.file(`${out}/REEL_CAPTION.txt`).text().catch(() => "");
  if (!meta || !caption || !(await Bun.file(`${out}/reel.mp4`).exists()) || !(await Bun.file(`${out}/cover.jpg`).exists()))
    throw new Error(`${out} has no complete Reel (reel.mp4, cover.jpg, reel-meta.json, REEL_CAPTION.txt): run bun carousel/native-reel.mjs`);
  const sel = await Bun.file(`${DIR}/selection.json`).json();
  const d = sel.draws.find((x) => x.slug === meta.hero);
  if (!d) throw new Error(`the Reel's hero ${meta.hero} is not in today's selection`);
  // the caption gate again, on the exact text that will post
  const capA = compliance.checkUnit(caption, { surface: "caption", bannedPhrases: GLOBAL.bannedPhrases, operatorNames: [meta.operator].filter(Boolean),
    facts: compliance.factsTable({ drawsRendered: 1, prices: [String(d.ticket_price)] }) }).filter((h) => h.class === compliance.CLASS.A);
  if (capA.length) throw new Error(`class A in the Reel caption: ${capA.map((h) => h.predicate).join(", ")}`);
  const date = todayLondon();
  const win = slotWindow(slot, date);
  if (+new Date(d.draw_date) < win.to.getTime() + RUNWAY_MS) throw new Error(`${d.slug} closes ${d.draw_date}, before its ${slot} slot ends + 2h: not queued`);
  const base = `${date}/${sel.slug}/${slot}`;
  const mp4 = Buffer.from(await Bun.file(`${out}/reel.mp4`).arrayBuffer());
  const jpg = Buffer.from(await Bun.file(`${out}/cover.jpg`).arrayBuffer());
  const videoUrl = await withRetry(() => upload(`${base}.mp4`, mp4, "video/mp4"), { label: `upload ${slot}` });
  const coverUrl = await withRetry(() => upload(`${base}-cover.jpg`, jpg, "image/jpeg"), { label: `upload ${slot} cover` });
  const item = { slot, date, category: sel.slug, hero: d.slug, operator: meta.operator, drawDate: d.draw_date,
    from: win.from.toISOString(), to: win.to.toISOString(), videoUrl, coverUrl, caption, hook: meta.hook, igUserId: GLOBAL.igUserId };
  await upsertPost({ date, format: slot, status: "assets_uploaded", category: sel.slug, draw_slugs: [d.slug], caption,
    reel_arm: "arm-native", arm_source: meta.armSource || "native-reel", duration_ms: meta.durationMs ?? null, is_loop: false,
    asset_urls: [videoUrl, coverUrl] });
  await mkdir(QUEUE_DIR, { recursive: true });
  await Bun.write(qPath(slot), JSON.stringify(item, null, 2));
  console.log(`✓ ${slot} queued for ${win.from.toISOString()} → ${win.to.toISOString()}: "${meta.hook}" (${d.slug})`);
}

async function due(which) {
  const slot = which === "auto" || !which ? slotForNow() : which;
  if (!slot) { console.log("no slot at this UK hour"); return 1; }
  const item = await readItem(slot);
  if (!item) { console.log(`${slot}: nothing queued`); return 1; }
  const row = await getPost(item.date, slot).catch(() => null);
  const draw = await readDraw(item.hero).catch((e) => { console.error(`⚠ ${e.message}`); return null; });
  const v = dueVerdict(item, { row, draw });
  if (!v.ok) {
    console.log(`${slot}: ${v.why}`);
    if (v.done) await rm(qPath(slot), { force: true });
    if (v.expired) await drop(slot, v.why);
    return 1;
  }
  console.log(`SLOT ${slot} ${item.date}`);
  console.log(JSON.stringify({ slot, igUserId: item.igUserId, video_url: item.videoUrl, cover_url: item.coverUrl, caption: item.caption, date: item.date, hero: item.hero }, null, 2));
  return 0;
}

async function done(slot, ig) {
  const item = await readItem(slot);
  if (!item) throw new Error(`${slot}: nothing queued`);
  if (!/^\d{6,}$/.test(String(ig || ""))) throw new Error("done needs --ig <published media id>");
  await markStatus(item.date, slot, "published", { ig_media_id: ig });
  await rm(qPath(slot), { force: true });
  console.log(`✓ ${item.date} ${slot} → published (${ig})`);
  // the last Reel of a day releases that day's hosted assets
  const p = Bun.spawn(["bun", new URL("../cleanup.mjs", import.meta.url).pathname], { env: { ...process.env, CLEANUP_DATE: item.date }, stdout: "inherit", stderr: "inherit" });
  await p.exited;
}

async function drop(slot, reason = "dropped") {
  const item = await readItem(slot);
  if (item) await markStatus(item.date, slot, "skipped").catch((e) => console.error(`⚠ ${e.message}`));
  await rm(qPath(slot), { force: true });
  console.log(`✓ ${slot} unqueued (${reason})`);
}

if (import.meta.main) {
  const [cmd, slot, ...rest] = Bun.argv.slice(2);
  try {
    if (cmd === "add") await add(slot);
    else if (cmd === "due") process.exit(await due(slot));
    else if (cmd === "done") await done(slot, rest[rest.indexOf("--ig") + 1]);
    else if (cmd === "drop") await drop(slot, rest.join(" ") || "dropped");
    else if (cmd === "published") process.exit((await getPost(rest[0] || todayLondon(), slot))?.status === "published" ? 0 : 1);
    else { console.error("usage: queue.mjs add <slot> | due [auto|<slot>] | done <slot> --ig ID | drop <slot> <reason>"); process.exit(64); }
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}
