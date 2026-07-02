// PUBLISH step: take the rendered slides in ~/Desktop/pdd-today/out/, make them
// Instagram-ready (JPEG, 1080×1350, public URLs), upload to a public Supabase bucket,
// and emit a publish.json the Composio step consumes (IG carousel + FB album).
//
//   bun run carousel/publish.mjs
//
// Needs SUPABASE_SERVICE_ROLE_KEY (add to ~/pdd-aggregator/.env — Bun auto-loads it;
// Supabase dashboard → Project Settings → API → service_role secret).
import { chromium } from "playwright";
import { readdir } from "node:fs/promises";
import { buildFbCaption } from "./caption.mjs";
import { toDrawSlide } from "./format.mjs";
import { workDir } from "./config.mjs";

const DIR = workDir();
const OUT = `${DIR}/out`;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "carousel-slides";
const IG_USER_ID = "27332554436394910"; // @prizedrawsdaily

if (!KEY) {
  console.error("✗ SUPABASE_SERVICE_ROLE_KEY missing. Add it to ~/pdd-aggregator/.env:");
  console.error("  SUPABASE_SERVICE_ROLE_KEY=<service_role secret from Supabase dashboard → Settings → API>");
  process.exit(1);
}

// date folder (Europe/London) for tidy storage paths
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // YYYY-MM-DD
const sel = JSON.parse(await Bun.file(`${DIR}/selection.json`).text());
const caption = await Bun.file(`${OUT}/CAPTION.txt`).text();

// ordered slide PNGs (01-…, 02-…, …)
const pngs = (await readdir(OUT)).filter((f) => /^\d\d-.*\.png$/.test(f)).sort();
if (pngs.length < 2) { console.error("✗ Need ≥2 slides in", OUT); process.exit(1); }
console.log(`Slides: ${pngs.length}  | caption ${caption.length} chars`);

// 1) convert each PNG → Instagram-ready JPEG (1080×1350) via a headless canvas
const browser = await chromium.launch();
const page = await browser.newPage();
async function toJpeg(pngPath) {
  const buf = Buffer.from(await Bun.file(pngPath).arrayBuffer());
  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  const jpegDataUrl = await page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = src; });
    const c = document.createElement("canvas"); c.width = 1080; c.height = 1350;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#07060a"; ctx.fillRect(0, 0, 1080, 1350);
    ctx.drawImage(img, 0, 0, 1080, 1350);
    return c.toDataURL("image/jpeg", 0.92);
  }, dataUrl);
  return Buffer.from(jpegDataUrl.split(",")[1], "base64");
}

// 2) ensure the public bucket exists (idempotent)
async function ensureBucket() {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST", headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (r.ok) { console.log(`Bucket '${BUCKET}' created (public).`); return; }
  const t = await r.text();
  if (r.status === 409 || /exists/i.test(t)) { console.log(`Bucket '${BUCKET}' already exists.`); return; }
  throw new Error(`bucket create failed ${r.status}: ${t.slice(0, 200)}`);
}

// 3) upload a JPEG buffer → public URL
async function upload(path, jpeg) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "image/jpeg", "x-upsert": "true" },
    body: jpeg,
  });
  if (!r.ok) throw new Error(`upload ${path} failed ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

await ensureBucket();
const urls = [];
for (let i = 0; i < pngs.length; i++) {
  const jpeg = await toJpeg(`${OUT}/${pngs[i]}`);
  const url = await upload(`${today}/${sel.slug}/${String(i + 1).padStart(2, "0")}.jpg`, jpeg);
  urls.push(url);
  console.log(`  ✓ ${pngs[i]} → ${(jpeg.length / 1024).toFixed(0)}KB → ${url}`);
}
await browser.close();

// Facebook: ONE detailed captioned post (FACEBOOK_CREATE_PHOTO_POST), not a pile
// of caption-less photos. heroUrl = the intro slide (most eye-catching); fbCaption
// is the full body with a real clickable link.
const fbItems = sel.draws.map((d) => { const s = toDrawSlide(d); return { title: s.title, price: s.price }; });
const fbCaption = buildFbCaption(sel.name, sel.slug, fbItems);
const heroUrl = urls[0];

const publish = { date: today, category: sel.slug, igUserId: IG_USER_ID, caption, fbCaption, heroUrl, urls };
await Bun.write(`${OUT}/publish.json`, JSON.stringify(publish, null, 2));
console.log(`\n✓ ${urls.length} public JPEGs hosted. Wrote ${OUT}/publish.json`);
console.log("\n--- FB CAPTION (single detailed post) ---\n" + fbCaption);
console.log("\nNext: IG → carousel (urls + caption). FB → FACEBOOK_CREATE_PHOTO_POST(heroUrl, message=fbCaption).");
