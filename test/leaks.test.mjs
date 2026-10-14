// Wrong figures on live operators, each pinned with a trimmed copy of the real page it was
// found on (2026-10-15). Every fixture reproduces the wrong value on the parser before the fix.
import { describe, test, expect } from "bun:test";
import { fieldsFromHtml, withoutNeighbours } from "../lib/parse.mjs";
import { ltyFinished, saysFinished } from "../lib/liveness.mjs";

const page = (name) => Bun.file(new URL(`./fixtures/leaks/${name}`, import.meta.url)).text();

describe("neighbour blocks never supply this draw's figures", () => {
  test("Lavish Life: a related card's 'DAILY EDITION *WEDNESDAY 14.10.26*' is not our date", async () => {
    // The page's own date line is "18th Oct @ 8:30pm"; the carousel showed the Wednesday edition.
    const html = await page("lavish-life.revvi.product.html");
    expect(html).toContain("DAILY EDITION! *WEDNESDAY 14.10.26*");
    const d = fieldsFromHtml({ html, url: "https://lavishlifecompetitions.co.uk/competition/revvi-18-electric-balance-bike/", op: { base: "https://lavishlifecompetitions.co.uk" }, knownPrice: 0.99 });
    expect(d.draw_date).toBe("2026-10-18T20:30:00+01:00");
    expect(d.total_entries).toBe(1499);
  });

  test("withoutNeighbours drops related/upsell sections and keeps the product", async () => {
    const html = `<body class="single-product"><div class="summary"><h1>Own</h1><p>Draw 18th Oct</p></div>
      <div class="zapc-related-products"><section class="related products"><h2>Featured Competitions</h2><p>Draw Mon 19th Oct</p><p>Sold 4 / 18000</p></section></div>
      <section class="upsells"><p>Other 99 / 5000</p></section></body>`;
    const own = withoutNeighbours(html);
    expect(own).toContain("Draw 18th Oct");
    expect(own).not.toContain("Featured Competitions");
    expect(own).not.toContain("5000");
  });

  test("the <body class=single-product> is never taken as the product summary", () => {
    // Before: `.first()` matched <body>, so the cap fallback read the whole page and took the
    // bigger neighbour bar (18,000) over this draw's own 1,200.
    const html = `<body class="single-product"><header><p>Our biggest ever: 90 / 18000</p></header>
      <div class="summary entry-summary"><h1>Own comp</h1><p>Draw 18th Oct 2026</p><p>Sold 40 / 1200</p></div></body>`;
    const d = fieldsFromHtml({ html, url: "https://x.co.uk/competition/own/", op: { base: "https://x.co.uk" }, knownPrice: 1 });
    expect(d.total_entries).toBe(1200);
  });
});

describe("Zap theme: the product's own countdown script", () => {
  test("Pawsome: the only date is the countdown, not a related card's '4th Nov'", async () => {
    // fromISO("2026-10-21T20:30:00+00:00") = 9:30pm UK. The old parser had no own date to read and
    // took a neighbour card's 4 Nov instead.
    const html = await page("pawsome.zap-countdown.product.html");
    const d = fieldsFromHtml({ html, url: "https://pawsomecomps.com/competition/win-a-2025-apple-ipad-14/", op: { base: "https://pawsomecomps.com" }, knownPrice: 0.27 });
    expect(d.draw_date).toBe("2026-10-21T21:30:00+01:00");
    expect(d.total_entries).toBe(2499);
  });

  test("the countdown is a fallback: a printed date on the page still wins", () => {
    const html = `<body><div class="summary"><p>Draw 18th Oct 2026 @ 8:30pm</p>
      <div class="competition-countdown-wrapper"><script>var t = luxon.DateTime.fromISO("2026-10-18T18:45:00+00:00", {zone: "Europe/London"});</script></div></div></body>`;
    expect(fieldsFromHtml({ html, url: "https://x.co.uk/c/", op: { base: "https://x.co.uk" }, knownPrice: 1 }).draw_date).toBe("2026-10-18T20:30:00+01:00");
  });

  test("a neighbour card's countdown is never ours", () => {
    const html = `<body><div class="summary"><h1>Own</h1></div><section class="up-sells upsells products"><ul class="products"><li class="product">
      <div class="competition-countdown-wrapper"><script>DateTime.fromISO("2026-11-01T20:40:00+00:00")</script></div></li></ul></section></body>`;
    expect(fieldsFromHtml({ html, url: "https://x.co.uk/c/", op: { base: "https://x.co.uk" }, knownPrice: 1 }).draw_date).toBe(null);
  });

  test("a countdown with no offset is not guessed at", () => {
    const html = `<body><div class="summary"><div class="competition-countdown-wrapper"><script>DateTime.fromISO("2026-10-21T20:30:00")</script></div></div></body>`;
    expect(fieldsFromHtml({ html, url: "https://x.co.uk/c/", op: { base: "https://x.co.uk" }, knownPrice: 1 }).draw_date).toBe(null);
  });
});

describe("Elementor product pages with no summary box", () => {
  test("Clubhouse: our 9549/120000 in a `singleslider` widget beats a `ul.products` card's 250/75000", () => {
    // Shape of clubhousecompetitions.com on 2026-10-15: no .summary, the product's own bar sits in an
    // Elementor widget whose class contains "slider", and a loop of other competitions follows.
    const html = `<body class="single-product"><div class="elementor"><section class="elementor-section">
      <div class="elementor-element singleslider elementor-widget"><h1>The Great Beauty Advent Giveaway</h1>
      <div class="progress-stats">9549/120000</div><p>Wednesday 28th October 2026 @ 8:45pm</p></div></section>
      <div class="woocommerce"><ul class="products"><li class="product"><h2>The Great Gift Card Giveaway</h2><div class="progress-stats">250/75000</div></li></ul></div></div></body>`;
    const d = fieldsFromHtml({ html, url: "https://clubhousecompetitions.com/product/beauty/", op: { base: "https://clubhousecompetitions.com" }, knownPrice: 0.99 });
    expect(d.total_entries).toBe(120000);
  });
});

describe("pages that are not WordPress products", () => {
  test("no summary box and a plain <body>: the cut-down page still yields this draw's cap", () => {
    const html = `<body><main><h1>Own comp</h1><p>Sold 40 / 1200</p></main><aside><p>Hot now 90 / 18000</p></aside></body>`;
    const d = fieldsFromHtml({ html, url: "https://x.co.uk/raffle/own/", op: { base: "https://x.co.uk" }, knownPrice: 1 });
    expect(d.total_entries).toBe(1200);
  });
});

describe("Zap theme: the product's own progress block", () => {
  test("Prize Paradise: a brand-new comp's 0 / 504 is the cap, not the 1,000 in its title", () => {
    const html = `<body class="single-product"><div class="product"><div class="summary"><h1>Win 1,000 Tickets For Our £25,000 Comp #3</h1>
      <form class="cart"><div class="zap-competitions-progress"><div class="tickets-sold">Tickets Sold: <span class="zapc-refresh-sold-2676916"> 0 </span></div>
      <div class="label left">0</div><div class="label right zapc-refresh-max-2676916"> 504 </div>
      <div class="progress-track"><div class="progress-bar zapc-refresh-progress-2676916" role="progressbar" aria-valuenow="0" aria-valuemax="504"></div></div>
      <div class="mini-label">0 / 504</div></div></form><p>Draw Wed 21st Oct 2026</p></div></div></body>`;
    const d = fieldsFromHtml({ html, url: "https://prizeparadise.co.uk/competition/1000-tickets-25k-2110", op: { base: "https://prizeparadise.co.uk" }, knownPrice: 0.5 });
    expect(d.total_entries).toBe(504);
  });

  test("Pawsome: aria-valuemax on the bar when there is no max span", () => {
    const html = `<body><div class="summary"><form class="cart"><div class="zap-competitions-progress"><div class="progress-track">
      <div class="progress-bar" role="progressbar" aria-valuenow="188" aria-valuemax="2499"></div></div></div></form></div></body>`;
    expect(fieldsFromHtml({ html, url: "https://pawsomecomps.com/competition/x/", op: { base: "https://pawsomecomps.com" }, knownPrice: 0.27 }).total_entries).toBe(2499);
  });
});

describe("wpgenie WooCommerce Lottery progress meter", () => {
  test("Croc Comps: the cap is `.max`, not the 'Tickets available' remaining count (or the year in the title)", async () => {
    // Live page: <span class="sold">Tickets available: 250</span><span class="max">250</span>, title
    // "Hawkstone Advent Calendar 2026". The labelled-cap tier read the cap as 2,026.
    const html = await page("croc-comps.wpgenie-meter.product.html");
    const d = fieldsFromHtml({ html, url: "https://croccomps.co.uk/product/hawkstone-advent-calendar-2026-2/", op: { base: "https://croccomps.co.uk" }, knownPrice: 1 });
    expect(d.total_entries).toBe(250);
    expect(d.total_entries_method).toBe("labelled-cap");
  });

  test("a partly sold meter publishes the maximum, never what is left", () => {
    const html = `<body><h1>Ninja Coffee Machine</h1><div class="wcl-progress-meter "><span class="sold">Tickets available: 989</span> <span class="max">999</span><progress max="999" value="10"></progress></div></body>`;
    const d = fieldsFromHtml({ html, url: "https://croccomps.co.uk/product/ninja/", op: { base: "https://croccomps.co.uk" }, knownPrice: 0.5 });
    expect(d.total_entries).toBe(999);
  });
});

describe("closed lottery-for-woocommerce (lty) products", () => {
  test("Property Comps: 'Lottery Closed / Please wait for the result' is finished", async () => {
    expect(ltyFinished(await page("property-comps.lty-closed.product.html"))).toBe(true);
  });

  test("status forms the plugin prints", () => {
    const wrap = (inner) => `<body><div class="lty-lottery-product-summary">${inner}</div></body>`;
    expect(ltyFinished(wrap(`<p class="lty-lottery-status">Lottery Finished</p><table class="lty-frontend-table"></table>`))).toBe(true);
    expect(ltyFinished(wrap(`<p class="lty-lottery-status">Lottery Failed</p><p>Minimum Ticket Count not met</p>`))).toBe(true);
    expect(ltyFinished(wrap(`<p class="lty-waiting-result-message">Please wait for the result</p>`))).toBe(true);
    // Albo: only the drawn winners table is left where the buy box was.
    expect(ltyFinished(wrap(`<table class="lty-frontend-table"><tr><td>Winners are</td></tr></table>`))).toBe(true);
  });

  test("a live lottery is not finished", () => {
    const live = `<body><div class="lty-lottery-product-summary"><p>Ending On: 26/10/2026 10:00pm</p><p class="lty-tickets-sold">Sold: 0</p>
      <form class="cart lty-participate-now"><button class="single_add_to_cart_button lty-participate-now-button">Participate</button></form></div></body>`;
    expect(ltyFinished(live)).toBe(false);
  });

  test("a live lottery with winners of its instant prizes listed is not finished", () => {
    const live = `<body><div class="lty-lottery-product-summary"><table class="lty-frontend-table"><tr><td>Winners are</td></tr></table>
      <button class="single_add_to_cart_button">Participate</button></div></body>`;
    expect(ltyFinished(live)).toBe(false);
  });

  test("a FINISHED neighbour card does not end a live lottery", () => {
    const html = `<body><div class="lty-lottery-product-summary"><button class="lty-participate-now-button">Participate</button></div>
      <section class="related products"><p class="lty-lottery-status">Lottery Finished</p><p class="lty-waiting-result-message">Please wait for the result</p></section></body>`;
    expect(ltyFinished(html)).toBe(false);
  });

  test("the plugin's i18n strings inside a <script> are not a marker", () => {
    const html = `<body><script>var lty = {"finished":"Lottery Finished","wait":"<p class=\\"lty-waiting-result-message\\">"};</script>
      <div class="lty-lottery-product-summary"><button class="lty-participate-now-button">Participate</button></div></body>`;
    expect(ltyFinished(html)).toBe(false);
    expect(saysFinished(html)).toBe(false);
  });
});
