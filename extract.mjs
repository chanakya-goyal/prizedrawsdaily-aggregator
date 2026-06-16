// PoC draw extractor — dry run (prints results, writes nothing to the DB).
// Acquires each operator's draws via the best available method, then an LLM
// (Groq) maps the page content to our draw fields.
import { createGroq } from "@ai-sdk/groq";
import { generateObject } from "ai";
import { z } from "zod";

const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = "openai/gpt-oss-120b";
const CATEGORIES = ["car-draws", "cash-prizes", "house-draws", "tech-giveaways", "luxury"];
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" };

const DrawSchema = z.object({
  draws: z.array(
    z.object({
      title: z.string().describe("the draw/competition headline (the prize you can win)"),
      grand_prize: z.string().describe("the single biggest/headline prize"),
      category: z.enum(CATEGORIES),
      ticket_price: z.number().nullable().describe("price per ONE ticket in GBP; null if not shown"),
      total_entries: z.number().nullable().describe("MAXIMUM number of tickets (not remaining/sold); null if not shown"),
      draw_date: z.string().nullable().describe("closing/draw date-time as ISO8601; null if not determinable"),
      image_url: z.string().nullable().describe("absolute URL of the prize image"),
      entry_url: z.string().nullable().describe("absolute URL of this specific draw's page"),
    }),
  ),
});

async function extract(operator, content, sourceUrl) {
  const { object } = await generateObject({
    model: groq(MODEL),
    schema: DrawSchema,
    mode: "json",
    prompt: `Extract the CURRENT live prize-draw/competition listings for the operator "${operator}" from the web content below.
Rules:
- One entry per distinct active draw (a prize you buy tickets to win).
- NEVER invent values. ticket_price / total_entries / draw_date must come from the text; use null if absent.
- total_entries = the MAXIMUM tickets available (ignore "sold" / "remaining").
- category MUST be one of: ${CATEGORIES.join(", ")}.
- Prefer absolute URLs. Source page: ${sourceUrl}

CONTENT:
${content.slice(0, 26000)}`,
  });
  return object.draws;
}

async function revComps() {
  // 1) list current draws (WooCommerce Store API gives us the real draw URLs)
  const r = await fetch("https://www.revcomps.com/wp-json/wc/store/v1/products?per_page=5&orderby=date", { headers: UA });
  const products = await r.json();
  const out = [];
  // 2) visit each draw's detail page and extract the full field set
  for (const p of products.slice(0, 4)) {
    const pr = await fetch(p.permalink, { headers: UA });
    const html = (await pr.text())
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const minor = p.prices?.currency_minor_unit ?? 2;
    const price = p.prices?.price != null ? (Number(p.prices.price) / 10 ** minor).toFixed(2) : "?";
    const hint = `Known facts (use these): ticket_price=£${price}; image_url=${p.images?.[0]?.src || ""}; entry_url=${p.permalink}\n\nFULL DRAW PAGE TEXT:\n`;
    const draws = await extract("Rev Comps", hint + html, p.permalink);
    out.push(...draws);
  }
  return out;
}

async function dreamCar() {
  const r = await fetch("https://dreamcargiveaways.co.uk/", { headers: UA });
  const html = (await r.text())
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  return extract("Dream Car Giveaways", html, "https://dreamcargiveaways.co.uk/");
}

const ops = [["Rev Comps", revComps], ["Dream Car Giveaways", dreamCar]];
for (const [name, fn] of ops) {
  try {
    const draws = await fn();
    console.log(`\n===== ${name}: ${draws.length} draws extracted =====`);
    for (const d of draws.slice(0, 6)) {
      const pool = d.ticket_price && d.total_entries ? `£${(d.ticket_price * d.total_entries).toLocaleString("en-GB")}` : "—";
      console.log(
        `• ${d.title}\n   prize: ${d.grand_prize} | cat: ${d.category}\n   £${d.ticket_price ?? "—"} × ${d.total_entries ?? "—"} entries = pool ${pool} | ends: ${d.draw_date ?? "—"}\n   img: ${(d.image_url || "—").slice(0, 70)}\n   url: ${d.entry_url ?? "—"}`,
      );
    }
  } catch (e) {
    console.log(`\n✗ ${name} failed: ${e.message}`);
  }
}
