// Build a contact sheet of all fetched candidates so Claude can visually QA them.
// Run: bun carousel/contact.mjs
import { chromium } from "playwright";
import { readdir } from "node:fs/promises";

const DIR = "/Users/chanakyagoyal/Desktop/pdd-today/.fetched";
const OUT = "/Users/chanakyagoyal/Desktop/pdd-today/contact.png";
const dirs = (await readdir(DIR)).filter((d) => !d.startsWith("."));

async function dataUrl(path) {
  const buf = Buffer.from(await Bun.file(path).arrayBuffer());
  const ext = path.split(".").pop().toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

let rows = "";
for (const d of dirs) {
  const files = (await readdir(`${DIR}/${d}`)).filter((f) => /^cand-\d/.test(f)).sort();
  let cells = "";
  for (const f of files) {
    const u = await dataUrl(`${DIR}/${d}/${f}`);
    cells += `<div class=c><img src="${u}"><span>${f}</span></div>`;
  }
  rows += `<div class=row><div class=lbl>${d}</div><div class=cells>${cells}</div></div>`;
}

const html = `<!doctype html><meta charset=utf8><style>
*{box-sizing:border-box;font-family:Arial}body{margin:0;background:#111;color:#eee}
.row{border-bottom:1px solid #333;padding:8px}
.lbl{font-size:13px;color:#9cf;margin-bottom:4px;word-break:break-all}
.cells{display:flex;gap:6px}
.c{width:200px;text-align:center}
.c img{width:200px;height:200px;object-fit:contain;background:#fff;border-radius:6px}
.c span{font-size:11px;color:#aaa}
</style>${rows}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 800 } });
await page.setContent(html, { waitUntil: "networkidle" });
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();
console.log("wrote", OUT);
