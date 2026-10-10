# Native Instagram deck — design (2026-10-11)

## Why
The owner rejected the Sep-18 newsprint deck as too professional for an Instagram feed. Its frames had:
- a navy masthead and a "READ 22:59" stamp;
- "TICKET CAP 299,999" as the hero, with "1 IN 299,999 AT SELL-OUT";
- a 2,095-dot grid and PDD rating chips;
- three lines of terms on every frame;
- an essay caption.

They want posts that are minimal, eye-catching and "vibey" for ordinary UK men and women. The account had also posted nothing since 2026-09-22, because publishing waits on a human typing "publish today". This redesign comes first; the daily autopilot is built on it.

## Decisions (owner, 2026-10-11)
- **Style: native IG/TikTok text.** The prize photo with white Stories-style text bubbles, lowercase copy, light UK slang and emoji. The owner approved mockup v1 and then asked for two changes:
  - the site watermark on every frame;
  - more attractive text, which became IG sticker looks: the "Strong" price sticker, a countdown card, a location-style operator pill, and link and save stickers.
- **What a prize frame shows:**
  - kept: the photo, the price, the closing day, who runs it, and the cash bonus or alternative when the operator states one;
  - dropped: ticket cap, odds, dot grid, rating, per-frame terms, masthead.
- **Shape:** 7 frames (cover, 5 prizes, end slide). Mockups: https://claude.ai/artifact/GAJjwVB9YR65rJSrsXQ5bU

## How
| Unit | Owns |
|---|---|
| `native-copy.mjs` | Every word. Pure, so every string is gate-tested offline for all 8 categories. |
| `native.mjs` | Render with flow layout. Refuses a frame on a decode failure, text leaving the canvas, overflow, text-on-text overlap, a photo under 420px, or (Story) text outside Meta's safe box. |
| `native-build.mjs` | The settled deck to the gate, the render and the same `out/` files `publish.mjs` already reads. |
| `build.mjs` | Unchanged up to class B (photo choice, normalisation, collage swap, drops), then branches on `global.template`. The newsprint deck stays behind the switch. |
| `story.mjs` | Same draw choice; the native Story when the switch is on. |
| `caption-check.mjs` | The caption rules over CAPTION/FB_CAPTION/FALLBACK. `publish.mjs` refuses on class A. |

### Rules the wording gate imposed on the copy
- **No second person on a frame.** "5 cars you can enter" became "5 motors up for grabs this week". "motors", because car-draws holds bikes.
- **No clock times.** The countdown card prints the day.
- **No "?" without two verified figures.** "which one's the dream?" became "save this for later 📌", and the lead dropped its "??".
- **"on top" reads as a superlative to the gate.** A bonus is "+ £2k cash thrown in".
- **Every frame and every caption line names the operator.** The Page was suspended on 4 Sep 2026 for impersonation. The pill reads "via X", never "@x".

### Copy overrides
Claude may write fresher flavour lines into `COPY.json`. Prices, cash, days and operators always come from the data. A line that is too long, carries an unevidenced figure, or trips the gate is refused, and the template line is kept, so an override can never fail a run.

## Found on the way, fixed here
- **`cashAlt()` called any "£X cash" an alternative.** It stamped TAX-FREE on everything and was the value ceiling in `honesty.mjs`. A live A/B over 777 draws turned 120 alternative claims into 28 real alternatives plus 22 bonuses. Cash-only prizes, jackpots and instant-win pools are now nothing.
- **`freshness.mjs` read an empty config key**, so it always said STALE. It now reads the env key and reports an unreadable state as UNKNOWN.
- **The collage classifier scored a "£5,000 TAX-FREE CASH" poster `low`.** Code cannot see a wrong subject, so `DAILY.md` now makes the per-frame visual check explicit.

## Not in this change
- **The native Reel.** `reel.mjs` still renders the newsprint look, so the runbook says to skip it until the native reel ships.
- **The daily autopilot.** Planned as a launchd job on the Mac running headless Claude; it is the next PR.
