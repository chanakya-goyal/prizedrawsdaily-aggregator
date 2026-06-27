export const meta = {
  name: 'grandprize-qa',
  description: 'Read each draw\'s prize description + draw image to find the REAL main prize and correct category',
  phases: [{ title: 'Audit', detail: 'one vision agent per draw — reads description + image' }],
}

// args = array of flagged draws: {id, op, base, method, entry_url, title, cur_grand_prize, cur_category, image_url, ticket_price}
const draws = Array.isArray(args) ? args : []
const SCRATCH = '/private/tmp/claude-501/-Users-chanakyagoyal/eb37f4e6-c421-4724-b469-2c194218f39a/scratchpad'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    grand_prize: { type: 'string', description: 'the real MAIN/headline prize a winner receives — never the competition\'s game name' },
    category: { type: 'string', enum: ['car-draws', 'cash-prizes', 'house-draws', 'tech-giveaways', 'luxury', 'collectibles'] },
    is_live: { type: 'boolean', description: 'is the competition still open to enter?' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'string', description: 'one line: what in the description/image proves the prize' },
  },
  required: ['id', 'grand_prize', 'category', 'is_live', 'confidence', 'evidence'],
}

function prompt(d) {
  const slug = (d.entry_url || '').replace(/[#?].*$/, '').replace(/\/+$/, '').split('/').pop()
  return `Audit ONE scraped UK prize-draw for its true MAIN PRIZE and category. The stored grand_prize is suspected to be the competition's game/marketing NAME, not the actual prize.

DRAW id: ${d.id}
Operator: ${d.op} (${d.base}, method=${d.method})
Page: ${d.entry_url}
Stored title: ${JSON.stringify(d.title)}
Stored grand_prize (likely WRONG): ${JSON.stringify(d.cur_grand_prize)}
Stored category: ${d.cur_category}
Draw image: ${d.image_url}

STEPS — gather ground truth from the operator's own per-competition data:
1. ${d.method === 'shopify'
      ? `Run: curl -s "${d.base}/products/${slug}.json" — read product.body_html (the prize copy) and whether a variant is available.`
      : `Run: curl -s "${d.base}/wp-json/wc/store/v1/products?slug=${slug}" — read the product .description (the "About this competition" copy) and .is_purchasable.`}
2. Download and LOOK AT the draw image (the headline prize is usually printed on it):
   curl -sL "${d.image_url}" -o ${SCRATCH}/img-${d.id}.jpg   then Read that file.
3. If still unclear, WebFetch ${d.entry_url} for the on-page prize text.

DECIDE the grand_prize = the single real MAIN/headline prize a winner receives:
- A comp NAMED "Code Cracker"/"Bottle Bounty"/"Shoot That Balloon" whose copy says "£250 MAIN PRIZE" → grand_prize "£250 Cash".
- Instant-win comp "WIN UP TO £5,000 INSTANTLY" → "Up to £5,000 Cash (instant wins)".
- "2 x £250 Main Prizes" → "2 × £250 Cash". A comp with both instant + a fixed end/main prize → name the MAIN/END draw prize (mention the instant only if it is the clear headline).
- A physical-item comp (PS5, PING irons, graded Pikachu card, Range Rover) → the item itself (the stored title may already be right — confirm it).
- Site-credit prizes → "£X Site Credit".
category (pick one): car-draws | cash-prizes | house-draws | tech-giveaways | luxury | collectibles.
  Pokémon/graded cards/LEGO/Warhammer = collectibles; watches/jewellery/gold/spa/holidays/golf gear/fishing = luxury; consoles/phones/appliances/tools/VR = tech-giveaways; a vehicle = car-draws; property/lodge = house-draws; cash/site-credit/instant-win money = cash-prizes.
is_live = is the comp still purchasable / not showing "finished"?

Ground every answer in what you actually read/saw. If genuinely unsure, set confidence "low" and put your best read in grand_prize. Return the StructuredOutput object.`
}

const results = await parallel(
  draws.map((d) => () => agent(prompt(d), { agentType: 'general-purpose', schema: SCHEMA, label: `qa:${(d.title || d.id).slice(0, 22)}`, phase: 'Audit' }).then((r) => r && { ...r, _cur_gp: d.cur_grand_prize, _cur_cat: d.cur_category, _title: d.title }))
)
const ok = results.filter(Boolean)
log(`audited ${ok.length}/${draws.length} draws`)
return { count: ok.length, results: ok }
