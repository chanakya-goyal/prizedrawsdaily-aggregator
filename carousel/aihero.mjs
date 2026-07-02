// AI hero generation via Gemini (Nano Banana). EDITS the real operator image so the
// genuine prize is preserved — strips text/logos/busy bg, places it on PDD's dark
// studio backdrop. Returns a PNG Buffer (4:5) or null on any failure (caller falls back).
const KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
// Default to Nano Banana (cheap/fast, ~$0.039/img). Set HERO_MODEL=gemini-3-pro-image for top quality (~$0.13+/img).
const MODEL = process.env.HERO_MODEL || "gemini-2.5-flash-image";

const PROMPT = `You are a premium product photographer. Using the item(s) shown in the provided image as the EXACT reference, produce a clean cinematic product photograph of the SAME item(s) — do not change the product, its model, colour or details.
Remove ALL text, logos, watermarks, price tags, badges, ticket prices, confetti, people and any busy/branded background from the original.
Place the product centred on a deep near-black studio background (#0d0d0f) with soft cinematic rim lighting, a gentle glow that matches the product's own colour, and a faint reflection beneath it.
Photorealistic, high detail, e-commerce hero style. Vertical 4:5 composition with generous dark negative space at the top and bottom. Absolutely NO text anywhere in the image.`;

const proxiedPng = (url, w = 1024) =>
  `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=${w}&output=png&we`;

async function callGemini(body) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { console.error("  Gemini", res.status, JSON.stringify(j).slice(0, 240)); return { err: true }; }
  const parts = j.candidates?.[0]?.content?.parts || [];
  for (const p of parts) { const d = p.inlineData || p.inline_data; if (d?.data) return { png: Buffer.from(d.data, "base64") }; }
  console.error("  Gemini: no image part", JSON.stringify(j).slice(0, 240));
  return { err: true };
}

export async function genHero(imageUrl) {
  if (!KEY || !imageUrl) return null;
  try {
    const imgRes = await fetch(proxiedPng(imageUrl, 1024));
    if (!imgRes.ok) { console.error("  hero: source fetch failed", imgRes.status); return null; }
    const b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
    const base = { contents: [{ parts: [{ inline_data: { mime_type: "image/png", data: b64 } }, { text: PROMPT }] }] };

    // try with explicit 4:5 aspect ratio; retry without if the model rejects imageConfig
    let r = await callGemini({ ...base, generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:5" } } });
    if (r.err) r = await callGemini({ ...base, generationConfig: { responseModalities: ["IMAGE"] } });
    return r.png || null;
  } catch (e) { console.error("  genHero error:", e.message); return null; }
}
