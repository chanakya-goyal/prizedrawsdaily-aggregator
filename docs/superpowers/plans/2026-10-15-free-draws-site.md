# Free prize draws, Part 2 (site): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/free-prize-draws-uk` page listing every live truly-free draw. A "site credit can only be spent at {operator}" note goes wherever a site-credit free draw appears, the header "Free & Instant Wins" entry is split in two, and the new page is linked from the footer, homepage and sitemap.

**Architecture:** One server function, `getFreeDraws`, does the reads:
- the live £0 draws, soonest first;
- their count;
- the shortest cap.

The route is modelled line for line on `src/routes/instant-win-competitions-uk.tsx`, with the FAQ built by a pure, unit-tested `buildFreeFaq()`. A shared pure helper `isSiteCredit()` decides when to show the spend-only-there note, so the wording is identical on the card, the draw page and the free page.

**Tech Stack:** TanStack Start (React SSR) on Vercel, Supabase JS, Tailwind, vitest. Repo `draw-discovery-hub`, local clone `~/prizedrawsdaily`.

**Spec:** `~/pdd-aggregator-free/docs/superpowers/specs/2026-10-14-free-draws-design.md` §2 (owner decisions 1–8). Part 1 is `docs/superpowers/plans/2026-10-15-free-draws-scraper.md`.

## Global Constraints

- **Ship after Part 1's PR is merged and the first free draws are live** (`status=active`, `ticket_price=0`), so the page launches populated. Check first:
  `curl -s "$SUPABASE_URL/rest/v1/draws?status=eq.active&ticket_price=eq.0&select=id" -H "apikey: $ANON" | head`
- Work in a worktree from fresh `origin/main` (`git -C ~/prizedrawsdaily worktree add -b feat/free-prize-draws ~/prizedrawsdaily-free origin/main`). Copy `.env` and symlink `node_modules`, per the recipe in memory `pdd-polish-pass-2026-10`. Never push to main; the user merges.
- Truly free only. The page queries `status=active AND ticket_price=0 AND draw_date>=now`. `rejected` rows are already invisible to the anon read policy and are never queried.
- **Site-credit wording, exactly:** `Site credit: can only be spent at {operator name}`. With no operator name: `Site credit: can only be spent with this operator`.
- **Header split:** "Free Draws" → `/free-prize-draws-uk`, and "Instant Wins" → `/instant-win-competitions-uk`.
- The FAQ is mirrored verbatim into FAQPage JSON-LD, built by one function used by both.
- Never name Everton or Liverpool in any copy.
- Phone width: 16px side gutter, no horizontal scroll. Test in real Safari (WebKit), not Chromium only.
- **SSR checks:** `curl` to a file, then `grep -a`. A plain grep on the dev server's output silently fails because of null bytes.
- The `Free` price chip already exists: `formatTicketPrice(0)` returns `"Free"` in `src/lib/slug.ts:134`, and `DrawCard` uses it. Do not add a second badge.
- Edge caching already covers every HTML path (`src/server.ts` `shouldEdgeCacheHtml`), and IndexNow already submits every sitemap URL daily (`src/routes/api.indexnow.tsx`). Adding the URL to the sitemap is all that's needed.

## Review Focus

1. **Zero free draws live.**
   - The page must still render, stay indexable, and show the empty state with working links.
   - The FAQ must not ask "easiest free draw" with no cap.
   - The homepage link must be hidden.
   - Pinned in Task 2 (`buildFreeFaq(0, null)`) and Task 4 (homepage `freeDrawCount > 0`).
2. **A free draw with no cap.** No "1 in …" may be shown and the shortest-cap query must skip it. `DrawCard` already omits odds when `total_entries` is null; the query has `.gt("total_entries", 0)`. Pinned in Task 2.
3. **Site credit phrased differently**, such as "£30 SITE CREDIT", "Account Credit", "wallet credit" or "£50 credit to spend on site". Pinned in Task 1 with each spelling.
4. **A paid site-credit draw.** The note is for FREE draws only (owner decision 5); a £2 site-credit draw shows nothing new. Pinned in Task 1.
5. **A long operator name in the note at 375px.** It must wrap, not overflow. Checked in Task 5 (Safari at phone width).

---

### Task 1: `isSiteCredit` + note helper

**Files:**
- Create: `src/lib/free.ts`
- Test: `src/lib/__tests__/free.test.ts`

**Interfaces:**
- Produces:
  - `isFreeDraw(d: { ticket_price?: number | null }): boolean`
  - `isSiteCredit(d: { ticket_price?: number | null; title?: string | null; grand_prize?: string | null }): boolean`
  - `siteCreditNote(operatorName?: string | null): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/free.test.ts
import { describe, it, expect } from "vitest";
import { isFreeDraw, isSiteCredit, siteCreditNote } from "@/lib/free";

describe("isFreeDraw", () => {
  it("is true only for an exact £0", () => {
    expect(isFreeDraw({ ticket_price: 0 })).toBe(true);
    expect(isFreeDraw({ ticket_price: 0.01 })).toBe(false);
    expect(isFreeDraw({ ticket_price: null })).toBe(false);
  });
});

describe("isSiteCredit", () => {
  for (const t of ["Free Draw - £30 Site Credit", "£30 SITE CREDIT", "£25 Account Credit", "£10 wallet credit", "£50 credit to spend on site"])
    it(`free + "${t}"`, () => expect(isSiteCredit({ ticket_price: 0, title: t })).toBe(true));
  it("reads grand_prize too", () => expect(isSiteCredit({ ticket_price: 0, title: "Free Friday", grand_prize: "£20 Site Credit" })).toBe(true));
  it("a paid site-credit draw gets no note", () => expect(isSiteCredit({ ticket_price: 2, title: "£500 Site Credit" })).toBe(false));
  it("a free cash draw is not site credit", () => expect(isSiteCredit({ ticket_price: 0, title: "Win £5 Cash - FREE" })).toBe(false));
  it("'credit card' is not site credit", () => expect(isSiteCredit({ ticket_price: 0, title: "Free draw: pay off your credit card" })).toBe(false));
});

describe("siteCreditNote", () => {
  it("names the operator", () => expect(siteCreditNote("Ruby Competitions")).toBe("Site credit: can only be spent at Ruby Competitions"));
  it("falls back without a name", () => expect(siteCreditNote(null)).toBe("Site credit: can only be spent with this operator"));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/prizedrawsdaily-free && bunx vitest run src/lib/__tests__/free.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/free.ts
// Free draws (owner decisions 2026-10-14/15). A free draw is an exact £0 ticket — the
// aggregator's gate (lib/free.mjs) has already rejected any with a spend/membership catch.
// A free SITE-CREDIT prize is still free to enter, but the credit only spends with that
// operator, so every surface showing one says so in the same words.
type PriceLike = { ticket_price?: number | null };
type DrawLike = PriceLike & { title?: string | null; grand_prize?: string | null };

const SITE_CREDIT = /\b(?:site|account|wallet)\s+credit\b|\bcredit to spend on (?:the )?site\b/i;

export function isFreeDraw(d: PriceLike): boolean {
  return d.ticket_price != null && Number(d.ticket_price) === 0;
}

export function isSiteCredit(d: DrawLike): boolean {
  return isFreeDraw(d) && SITE_CREDIT.test(`${d.title ?? ""} ${d.grand_prize ?? ""}`);
}

export function siteCreditNote(operatorName?: string | null): string {
  const name = operatorName?.trim();
  return name ? `Site credit: can only be spent at ${name}` : "Site credit: can only be spent with this operator";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bunx vitest run src/lib/__tests__/free.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/free.ts src/lib/__tests__/free.test.ts
git commit -m "Free draws: shared isFreeDraw / isSiteCredit / spend-only-there note

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: data + FAQ for the free page

**Files:**
- Modify: `src/lib/directory.functions.ts`: add `getFreeDraws` directly after `getInstantWinOperators` (≈ line 801)
- Create: `src/lib/free-faq.ts`
- Test: `src/lib/__tests__/free-faq.test.ts`

**Interfaces:**
- Produces:
  - `getFreeDraws()` → `{ draws: Draw[]; liveCount: number; shortestCap: { slug: string; title: string; total_entries: number } | null }`. Each Draw carries `DRAW_COLS` + `operator(slug,name,rating,review_status)` + `category(slug,name)`.
  - `buildFreeFaq(liveCount: number, shortest: ShortestCap): { q: string; a: string }[]`, plus `export type ShortestCap`.

- [ ] **Step 1: Write the failing FAQ test**

```ts
// src/lib/__tests__/free-faq.test.ts
import { describe, it, expect } from "vitest";
import { buildFreeFaq } from "@/lib/free-faq";
import { faqPageLd } from "@/lib/seo";

describe("buildFreeFaq", () => {
  it("asks the four questions in order when a cap is live", () => {
    const faq = buildFreeFaq(12, { slug: "x", title: "Win £5 Cash - FREE", total_entries: 1999 });
    expect(faq.map((f) => f.q)).toEqual([
      "Are free prize draws legit?",
      "What is the easiest free draw to win?",
      "Do free draws have worse odds?",
      "Why do sites give away free draws?",
    ]);
    expect(faq[1].a).toContain("1,999");
    expect(faq[1].a).toContain("Win £5 Cash - FREE");
  });
  it("drops the easiest-draw question when nothing has a cap (or nothing is live)", () => {
    expect(buildFreeFaq(0, null).map((f) => f.q)).not.toContain("What is the easiest free draw to win?");
  });
  it("quotes the live count, and never claims a count of zero as inventory", () => {
    expect(buildFreeFaq(12, null)[0].a).toContain("12 free draws");
    expect(buildFreeFaq(0, null)[0].a).not.toMatch(/\b0 free draws/);
  });
  it("mirrors 1:1 into FAQPage JSON-LD", () => {
    const faq = buildFreeFaq(3, null);
    expect(faqPageLd(faq).mainEntity.map((e: any) => e.name)).toEqual(faq.map((f) => f.q));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/lib/__tests__/free-faq.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/free-faq.ts`**

```ts
// Visible FAQ for /free-prize-draws-uk — mirrored verbatim into FAQPage JSON-LD by the route.
// Built from loader data (not a const) because two answers quote live inventory and both
// copies must stay identical. Odds are 1/cap for the headline prize, from the published cap.
export type ShortestCap = { slug: string; title: string; total_entries: number | null } | null;
type Faq = { q: string; a: string };

export function buildFreeFaq(liveCount: number, shortest: ShortestCap): Faq[] {
  const live =
    liveCount > 0
      ? `Right now we list ${liveCount} free draws from UK operators we review, each checked twice for hidden conditions.`
      : "We list free draws only after checking them twice for hidden conditions, and none are open at this moment.";
  const faq: Faq[] = [
    {
      q: "Are free prize draws legit?",
      a: `Genuine ones are. A UK free prize draw needs no payment at all, so it sits outside gambling law and needs no licence. The catch to watch for is a "free" draw that only counts if you have spent money, subscribed or joined a VIP club. We exclude those. ${live}`,
    },
  ];
  if (shortest?.total_entries) {
    const cap = shortest.total_entries.toLocaleString("en-GB");
    faq.push({
      q: "What is the easiest free draw to win?",
      a: `The one with the smallest entry cap. With a capped draw, one entry's chance of the headline prize is one divided by the cap. Right now the shortest cap among the free draws we list is ${cap} entries ("${shortest.title}"), roughly a 1 in ${cap} chance. Caps change as draws open and close, so treat this as a snapshot.`,
    });
  }
  faq.push(
    {
      q: "Do free draws have worse odds?",
      a: "Not necessarily. The odds depend only on the cap: a free draw capped at 2,000 entries gives better odds than a paid draw capped at 20,000 tickets. What free draws usually limit is how many times you can enter, often once per person.",
    },
    {
      q: "Why do sites give away free draws?",
      a: "To bring in new players and keep existing ones coming back. A small free prize costs an operator less than advertising, and it gets you onto its site. Some free prizes are site credit, which can only be spent with that operator, so we say so wherever one is listed.",
    },
  );
  return faq;
}
```

- [ ] **Step 4: Add `getFreeDraws` to `src/lib/directory.functions.ts`**

Directly after the closing `});` of `getInstantWinOperators`:

```ts
// Live truly-free draws (ticket_price = 0) for /free-prize-draws-uk. The aggregator only lets a
// £0 draw through when it has no spend/membership catch (lib/free.mjs) and the QA routine
// double-checks each one, so status=active + price 0 IS the free list — no title matching.
export const getFreeDraws = createServerFn({ method: "GET" }).handler(async () => {
  const supabaseAdmin = await db();
  const nowIso = new Date().toISOString();
  const sel = `${DRAW_COLS}, operator:operators(slug,name,rating,review_status), category:categories(slug,name)`;
  const [draws, liveCount, shortest] = await unwrapAll([
    supabaseAdmin
      .from("draws")
      .select(sel)
      .eq("status", "active")
      .eq("ticket_price", 0)
      .gte("draw_date", nowIso)
      .order("draw_date", { ascending: true })
      .limit(48),
    supabaseAdmin
      .from("draws")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .eq("ticket_price", 0)
      .gte("draw_date", nowIso),
    supabaseAdmin
      .from("draws")
      .select("slug, title, total_entries")
      .eq("status", "active")
      .eq("ticket_price", 0)
      .gte("draw_date", nowIso)
      .not("total_entries", "is", null)
      .gt("total_entries", 0)
      .order("total_entries", { ascending: true })
      .limit(1),
  ]);
  return {
    draws: draws.data ?? [],
    liveCount: liveCount.count ?? 0,
    shortestCap: shortest.data?.[0] ?? null,
  };
});
```

- [ ] **Step 5: Run tests + typecheck, then commit**

Run: `bunx vitest run && bunx tsc --noEmit`
Expected: PASS, no type errors.

```bash
git add src/lib/free-faq.ts src/lib/__tests__/free-faq.test.ts src/lib/directory.functions.ts
git commit -m "Free draws: getFreeDraws loader + FAQ built once for page and JSON-LD

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: the `/free-prize-draws-uk` route

**Files:**
- Create: `src/routes/free-prize-draws-uk.tsx`
- Regenerated: `src/routeTree.gen.ts` (by `vite dev`/`vite build`; commit the regenerated file)

**Interfaces:**
- Consumes:
  - `getFreeDraws` and `buildFreeFaq` / `ShortestCap` (Task 2);
  - `isSiteCredit` / `siteCreditNote` (Task 1);
  - `DrawCard`, `PageHero`, `SiteHeader`, `SiteFooter`;
  - `SITE`, `absUrl`, `ldScript`, `breadcrumbLd`, `itemListLd`, `collectionPageLd` and `faqPageLd` from `@/lib/seo`.

- [ ] **Step 1: Write the route**

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { getFreeDraws } from "@/lib/directory.functions";
import { buildFreeFaq, type ShortestCap } from "@/lib/free-faq";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { DrawCard } from "@/components/site/DrawCard";
import { PageHero } from "@/components/site/PageHero";
import { SITE, absUrl, ldScript, breadcrumbLd, itemListLd, collectionPageLd, faqPageLd } from "@/lib/seo";
import cover from "@/assets/cover-instant-win.jpg?w=640;1024;1440;1920&format=webp&as=picture";

const CANONICAL = `${SITE}/free-prize-draws-uk`;
const TITLE = "Free Prize Draws UK: Free Draws You Can Enter Today";
const DESC =
  "Every UK prize draw that is genuinely free to enter, checked twice for hidden spend or membership conditions. Updated daily, with real odds from each entry cap.";

export const Route = createFileRoute("/free-prize-draws-uk")({
  loader: async () => await getFreeDraws(),
  head: ({ loaderData }) => {
    const draws = (loaderData?.draws ?? []) as { slug: string; title: string }[];
    const faq = buildFreeFaq((loaderData?.liveCount ?? 0) as number, (loaderData?.shortestCap ?? null) as ShortestCap);
    return {
      meta: [
        { title: TITLE },
        { name: "description", content: DESC },
        { property: "og:title", content: TITLE },
        { property: "og:description", content: DESC },
        { property: "og:type", content: "website" },
        { property: "og:url", content: CANONICAL },
        { property: "og:image", content: absUrl(cover.img.src) },
      ],
      links: [{ rel: "canonical", href: CANONICAL }],
      scripts: [
        ldScript(collectionPageLd({ name: "Free Prize Draws UK", description: DESC, url: "/free-prize-draws-uk" })),
        ldScript(breadcrumbLd([{ name: "Home", path: "/" }, { name: "Free Prize Draws", path: "/free-prize-draws-uk" }])),
        ...(draws.length
          ? [ldScript(itemListLd(draws.map((d) => ({ name: d.title, path: `${SITE}/draws/${d.slug}` })), { name: "Free UK prize draws", total: draws.length }))]
          : []),
        ldScript(faqPageLd(faq)),
      ],
    };
  },
  component: FreeDrawsPage,
});

function FreeDrawsPage() {
  const { draws, liveCount, shortestCap } = Route.useLoaderData();
  const live = (draws ?? []) as any[];
  const faq = buildFreeFaq((liveCount ?? 0) as number, (shortestCap ?? null) as ShortestCap);

  return (
    <div className="min-h-screen bg-canvas">
      <SiteHeader />
      <main id="main">
        <PageHero
          imageAlt="A prize box opening with light bursting out at sunset"
          image={cover}
          eyebrow="Free Draws"
          crumbs={[{ label: "Home", to: "/" }, { label: "Free Prize Draws" }]}
          title={<>Free prize draws in the UK</>}
          description={
            liveCount > 0
              ? `${liveCount} free draws open today, from UK operators we review. No purchase, no subscription, no catch.`
              : "Genuinely free draws from UK operators we review. No purchase, no subscription, no catch."
          }
        />

        <section className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
          {live.length > 0 ? (
            <>
              <h2 className="font-display text-2xl font-bold tracking-tight mb-6">Free draws you can enter right now</h2>
              {liveCount > live.length && (
                <p className="-mt-3 mb-6 text-sm text-muted-foreground">
                  <span className="font-semibold text-foreground">{liveCount}</span> free draws are live. The {live.length} closing soonest are below.
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-6">
                {live.map((d) => (
                  <DrawCard key={d.id} draw={d} />
                ))}
              </div>
              <p className="mt-6 text-sm text-muted-foreground">Closing soonest first. Odds shown are for the headline prize from one entry.</p>
            </>
          ) : (
            <div className="max-w-3xl rounded-xl bg-card ring-1 ring-black/10 dark:ring-white/15 p-6">
              <h2 className="font-display text-xl font-bold mb-2">No free draws are open right now</h2>
              <p className="text-foreground/80 leading-relaxed">
                New ones are added as operators open them, usually within a day. Meanwhile, browse the{" "}
                <Link to="/draws" search={{ sort: "price_asc" }} className="underline hover:text-brand-ink">
                  cheapest paid draws
                </Link>{" "}
                or read how to enter almost any draw for free by{" "}
                <Link to="/guides/$slug" params={{ slug: "free-postal-entry-uk-prize-draws" }} className="underline hover:text-brand-ink">
                  free postal entry
                </Link>
                .
              </p>
            </div>
          )}
        </section>

        <section className="border-t border-border">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12 text-foreground/80 leading-relaxed space-y-4">
            <h2 className="font-display text-2xl font-bold tracking-tight">How free entry works</h2>
            <p>
              The draws on this page cost nothing to enter. Some ask you to make an account, answer a simple question or enter once
              per person, and that is all. We leave out any "free" draw that only counts if you have spent money, subscribed or joined
              a VIP or loyalty club.
            </p>
            <p>
              Paid draws are different, but most UK operators still offer a free postal route into them with the same odds as a
              ticket. Our guide to{" "}
              <Link to="/guides/$slug" params={{ slug: "free-postal-entry-uk-prize-draws" }} className="underline hover:text-brand-ink">
                free postal entry
              </Link>{" "}
              explains how. Some free prizes are site credit, which can only be spent with that operator; each one is marked.
            </p>
          </div>
        </section>

        <section className="border-t border-border">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
            <h2 className="font-display text-2xl font-bold tracking-tight mb-4">Free prize draws: FAQs</h2>
            <div className="divide-y divide-black/10 dark:divide-white/10 ring-1 ring-black/10 dark:ring-white/15 rounded-xl bg-card">
              {faq.map((f, i) => (
                <details key={i} className="group p-5">
                  <summary className="cursor-pointer font-semibold list-none flex justify-between gap-4">
                    <span>{f.q}</span>
                    <span className="text-brand-ink group-open:rotate-45 transition-transform">+</span>
                  </summary>
                  <p className="mt-3 text-sm text-foreground/80 leading-relaxed">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
```

`/draws` takes `search={{ sort: "price_asc" }}` because `SORT_VALUES` includes `"price_asc"` (`src/lib/directory.functions.ts` ≈ line 218). If the `/draws` route's search schema rejects the literal type, copy the `as const` style the homepage quick filters use (`src/routes/index.tsx` ≈ line 348).

- [ ] **Step 2: Regenerate the route tree and typecheck**

Run: `bun run build && bunx tsc --noEmit`
Expected: the build succeeds, and `src/routeTree.gen.ts` now contains `/free-prize-draws-uk`.

- [ ] **Step 3: SSR check**

Run:

```bash
bun run dev &   # wait for "ready", note the port (default 3000; use the printed one)
curl -s http://localhost:3000/free-prize-draws-uk -o /tmp/free.html
grep -a -c "Free prize draws in the UK" /tmp/free.html
grep -a -o '"@type":"FAQPage"' /tmp/free.html
grep -a -o '"@type":"CollectionPage"' /tmp/free.html
grep -a -o '"@type":"BreadcrumbList"' /tmp/free.html
grep -a -o '<link rel="canonical" href="https://prizedrawsdaily.co.uk/free-prize-draws-uk"' /tmp/free.html
grep -a -c 'noindex' /tmp/free.html
```

Expected:
- the title text count is ≥1;
- each `@type` prints once;
- the canonical prints;
- `noindex` count = 0;
- `ItemList` appears only if free draws are live; otherwise "No free draws are open right now" is present.

- [ ] **Step 4: Commit**

```bash
git add src/routes/free-prize-draws-uk.tsx src/routeTree.gen.ts
git commit -m "New page /free-prize-draws-uk: live free draws, how free entry works, FAQ mirrored in JSON-LD

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: site-credit note, header split, footer, homepage, sitemap

**Files:**
- Modify: `src/components/site/DrawCard.tsx`:
  - add `grand_prize?: string | null` to the `draw` prop type (≈ line 11);
  - add the note above the dashed price row (≈ line 152).
- Modify: `src/routes/draws.$slug.tsx`, `drawQuickAnswer` (≈ line 44): add the note to the free sentence.
- Modify: `src/components/site/SiteHeader.tsx:36` (the `FIND_DRAWS` entry).
- Modify: `src/components/site/SiteFooter.tsx`: add a link in the list that holds `/is-this-raffle-site-legit` and `/operators` (≈ line 45–60).
- Modify: `src/lib/directory.functions.ts`, `getHomepage`: add a free count (≈ line 84 + return ≈ line 212).
- Modify: `src/routes/index.tsx`: the "Ending today →" link group (≈ line 332).
- Modify: `src/routes/sitemap[.]xml.tsx:106`.

**Interfaces:**
- Consumes: `isSiteCredit` and `siteCreditNote` (Task 1).
- Produces: `getHomepage()` gains a `freeDrawCount: number`.

- [ ] **Step 1: DrawCard note**

Import `import { isSiteCredit, siteCreditNote } from "@/lib/free";`, add `grand_prize?: string | null;` to the draw type, then insert directly above `<div className="mt-auto flex items-end justify-between gap-2 border-t border-dashed …">`:

```tsx
        {isSiteCredit(draw) && (
          <p className="mb-2 text-[11px] leading-snug text-muted-foreground break-words">
            {siteCreditNote(draw.operator?.name)}
          </p>
        )}
```

`DRAW_COLS` and `HOME_DRAW_COLS` both already select `grand_prize`.

- [ ] **Step 2: Draw page quick answer**

In `drawQuickAnswer`, import the helpers and replace the free branch:

```ts
        ? cap
          ? `Entry is free, and with a maximum of ${cap} entries the odds of winning the headline prize with a single entry are around 1 in ${cap}.`
          : `Entry is free.`
```

with:

```ts
        ? (cap
            ? `Entry is free, and with a maximum of ${cap} entries the odds of winning the headline prize with a single entry are around 1 in ${cap}.`
            : `Entry is free.`) + (isSiteCredit(d) ? ` ${siteCreditNote(op)}.` : "")
```

- [ ] **Step 3: Header split**

Replace `src/components/site/SiteHeader.tsx:36`:

```ts
  { to: "/instant-win-competitions-uk", label: "Free & Instant Wins", desc: "Win on the spot" },
```

with:

```ts
  { to: "/free-prize-draws-uk", label: "Free Draws", desc: "Free to enter, no catch" },
  { to: "/instant-win-competitions-uk", label: "Instant Wins", desc: "Win on the spot" },
```

Then confirm that nothing else keys on the old label: `grep -rn "Free & Instant" src`. Expected: no matches.

- [ ] **Step 4: Footer link**

In `SiteFooter.tsx`, copy the existing `<li>` that links `/operators` and point it at `/free-prize-draws-uk` with the label `Free prize draws`. Use the icon `Gift` from `lucide-react`, added to that file's existing lucide import.

- [ ] **Step 5: Homepage count + link**

In `getHomepage`, add to the `unwrapAll` array (and destructure it as `freeCount`) after `spotlight`:

```ts
      supabaseAdmin
        .from("draws")
        .select("id", { count: "exact", head: true })
        .eq("status", "active")
        .eq("ticket_price", 0)
        .gte("draw_date", now),
```

Return `freeDrawCount: freeCount.count ?? 0,`. In `src/routes/index.tsx`, read `freeDrawCount` from `Route.useLoaderData()` (line ≈128) and add before the "Ending today →" link:

```tsx
              {freeDrawCount > 0 && (
                <Link to="/free-prize-draws-uk" className="underline underline-offset-4 hover:text-brand-ink">
                  Free draws today ({freeDrawCount}) →
                </Link>
              )}
```

- [ ] **Step 6: Sitemap**

After line 106 of `src/routes/sitemap[.]xml.tsx`:

```ts
          { loc: `${SITE}/free-prize-draws-uk`, lastmod: drawsMax },
```

- [ ] **Step 7: Tests, build, SSR check**

Run: `bunx vitest run && bunx tsc --noEmit && bun run build`
Expected: PASS.

With the dev server running:

```bash
curl -s http://localhost:3000/ -o /tmp/home.html && grep -a -o 'href="/free-prize-draws-uk"' /tmp/home.html | head -3
curl -s http://localhost:3000/sitemap.xml | grep -a -c "free-prize-draws-uk"
```

Expected:
- at least one header/footer `href` on the homepage;
- the sitemap count = 1.

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "Free draws everywhere: site-credit note, header split into Free Draws / Instant Wins, footer, homepage, sitemap

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Safari check, then the PR

- [ ] **Step 1: Safari at phone width**

Open `http://localhost:3000/free-prize-draws-uk` in real Safari (`open -a Safari …`). Use Develop → Responsive Design Mode at 375×812, and check each item:
- the hero count;
- the grid (or the empty state);
- the FAQ toggles open;
- no horizontal scroll;
- the header menu shows "Free Draws" and "Instant Wins" as separate items;
- a site-credit card, if one is live, wraps its note inside the card.

Repeat at desktop width. Fix anything found, then re-run Task 4 Step 7.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/free-prize-draws
gh pr create --title "Free prize draws page + site-credit note + Free Draws / Instant Wins menu split" --body "$(cat <<'EOF'
## What
- New `/free-prize-draws-uk`: live free draws (status=active, £0), soonest first; how free entry works; FAQ mirrored verbatim into FAQPage; CollectionPage + ItemList + BreadcrumbList; indexable empty state.
- Site-credit free draws say "Site credit: can only be spent at {operator}" on the card, the draw page and the free page (owner decision 2026-10-15).
- Header "Free & Instant Wins" split into "Free Draws" and "Instant Wins"; footer link; homepage "Free draws today (N)" (hidden at 0); sitemap entry (IndexNow picks it up from the sitemap).

## Checks
- vitest + tsc + build green
- SSR curl + `grep -a`: title, canonical, FAQPage/CollectionPage/Breadcrumb JSON-LD, no noindex
- Safari 375px + desktop

Depends on the aggregator PR (free draws pass the gate) being merged and the first free draws being live.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: a PR URL. Do not merge.
