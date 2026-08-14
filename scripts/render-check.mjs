import { mkdir, writeFile } from "node:fs/promises";
import { renderDashboard } from "../src/render.js";
// Imported, never retyped: the footer prose that explains these rules is
// asserted against the constants themselves, so the two cannot drift.
import { FLOOD_MIN_VISITS, FLOOD_MULTIPLE, FLAT_PAGES_PER_SESSION, DIRECT_SHARE } from "../src/bots.js";
import {
  SNIPPET_MAX_POSITION, RANK_MAX_POSITION, TARGET_POSITION, SNIPPET_CTR_RATIO,
  OPPORTUNITY_MIN_IMPRESSIONS, MIN_ACTIONABLE_CLICKS, POSITION_MIN_IMPRESSIONS,
} from "../src/opportunities.js";

const today = new Date().toISOString();
const fixture = {
  date: "2026-07-16",
  start: "2026-07-10",
  coverageStart: "2026-07-10",
  previousStart: "2026-07-03",
  previousEnd: "2026-07-09",
  generatedAt: today,
  dataUpdatedAt: today,
  run: { run_at: today, ok: 1, note: "ok" },
  periodDays: 7,
  domain: null,
  sort: "traffic",
  allDomains: ["example.com", "davidveksler.freecapitalists.org", "davidveksler.com", "library.example"],
  // Ranked signals replace the old NOTABLE chips. Severity 1 and 2 are what the
  // "Today's actions" block renders, at most three of them; severity 3 is context
  // and must stay out of it.
  signals: [
    {
      severity: 1, kind: "likely-bot-subflood", host: "wiki.example",
      headline: "wiki.example is up 180%, and it looks like a crawler rather than growth",
      evidence: "151 sessions (was 54), 90% direct, 1.0 pages/session, 89% of entrances on /wiki/Main_Page.",
      action: "Treat as crawler traffic, not growth, and consider lowering the flood floor for this host.",
      href: "#site-wiki-example", recurrence: null,
    },
    {
      severity: 1, kind: "error-spike", host: "library.example",
      headline: "library.example error responses are 12.9% of requests",
      evidence: "2,514 responses ≥ 400 out of 19,506 requests, against a 4-day mean of 1.1%.",
      action: "Check the top failing paths below and fix or redirect them.",
      href: "#site-library-example", recurrence: null,
    },
    {
      severity: 2, kind: "malformed-urls", host: "davidveksler.freecapitalists.org",
      headline: "davidveksler.freecapitalists.org is serving 8 malformed URLs",
      evidence: "8 landing pages contain encoded markup or tag fragments, e.g. /category/austrian-economics/%3E%C3%97%3C/span%3E8%3C/span%3E.",
      action: "Fix the broken links generating these, then redirect or noindex the junk URLs.",
      href: "#site-davidveksler-freecapitalists-org", recurrence: null,
    },
    {
      severity: 2, kind: "snippet-gap", host: "example.com",
      headline: "example.com has 1 query ranking well but not clicked",
      evidence: "About 5.2 clicks a window are going elsewhere, led by \"high impression opportunity\" at position 8.4 with 0.0% CTR against roughly 3.7% expected there.",
      action: "Rewrite the title and meta description for those pages; the ranking is already there.",
      href: "#site-example-com", recurrence: null,
    },
    {
      severity: 3, kind: "no-comparison", host: "flooded.example",
      headline: "flooded.example has no like-for-like comparison",
      evidence: "17 sessions is a floor: this period contains a crawler-flooded day whose direct bucket is not separable.",
      action: "Read the figure as a floor, and wait for a clean day before judging the trend.",
      href: "#site-flooded-example", recurrence: 2,
    },
  ],
  // Headline totals are RUM-only: the zone site's 1,059 zone visits and 19,506
  // requests are in totals.zone and nowhere else. Summed the old way these tiles
  // would read 2,359 sessions over 21,276 "pageviews" — 9.0 pages/session, an
  // artifact of dividing HTTP requests by RUM sessions.
  totals: { visits: 1300, views: 1770, pagesPerSession: 1770 / 1300, search: 260,
    domains: 6, rumDomains: 4, zoneDomains: 2, active: 4, previousVisits: 1000, delta: .3, searchShare: .2, daysAvailable: 7, previousDaysAvailable: 7,
    botVisits: 42000, botViews: 42350, previousBotVisits: 0, botShare: .97, floodedSiteDays: 3, floodedSites: 1,
    partialVisits: 120, partialSites: 1,
    // The residual is `unattributed` and is rendered outside the bar; `internal`
    // is a real channel that used to fall into it.
    sourceMix: { direct: 700, search: 260, social: 80, referral: 60, internal: 120, unattributed: 80 },
    internalMeasured: true,
    zone: { visits: 1059, requests: 19506, bytes: 76658000000, sites: 1, hosts: ["library.example"] },
    gscClicks: 46, gscImpressions: 2200, gscCtr: .0209, gscPosition: 12.4, searchDataDomains: 2,
    // Median across queries clearing the impression floor, plus the position-mix
    // expectation the CTR tile is judged against (spec item 8).
    gscMedianPosition: 9.4, gscPositionQueries: 18, gscTop10Queries: 11,
    // The CTR comparator is stated over ONE population on both sides: the stored
    // top-query rows. The headline gscCtr above (2.09%) is the whole corpus and is
    // deliberately a different number, so a tile that mixed the two would show it.
    gscExpectedCtr: .059, gscSampleCtr: 41 / 900, gscSampleClicks: 41, gscSampleImpressions: 900,
    gscSampleQueries: 18, gscSampleShare: 900 / 2200,
    opportunities: 2, snippetOpportunities: 1, rankOpportunities: 1,
    // 14-day comparators. GSC ones are counted in SNAPSHOTS, not days: each
    // snapshot covers a rolling three-day window lagging two days, so consecutive
    // ones overlap and the ends of the range are named from gsc_window.
    trend: { window: 14, days: 14, visitsPerDay: 96.4, viewsPerDay: 131.2, searchPerDay: 19.6,
      gscSnapshots: 14, gscClicksPerSnapshot: 41.5, gscImpressionsPerSnapshot: 2050, gscCtr: .0202,
      gscWindowFirst: "2026-06-29–2026-07-01", gscWindowLast: "2026-07-12–2026-07-14", gscSeries: [] } },
  sites: [
    {
      host: "example.com", visits: 1100, views: 1500, previousVisits: 800, delta: .375,
      botVisits: 42000, botViews: 42350, botDays: 3, previousBotVisits: 0, cleanDays: 4,
      partialVisits: 120, partialDays: 3,
      anomaly: "99% direct, 1.0 pages/session, 165x a normal day",
      pagesPerSession: 1.36, previousPagesPerSession: 1.2, pagesPerSessionDelta: .16,
      searchSummary: { clicks: 40, impressions: 1900, ctr: .0211, position: 7.5 },
      gscWindow: "2026-07-12–2026-07-14",
      referrers: [
        { referrer: "(direct)", kind: "direct", visits: 700 },
        { referrer: "www.google.com", kind: "search", visits: 250 },
        { referrer: "www.reddit.com", kind: "social", visits: 80 },
      ],
      // One of each class plus one query that is already performing at its
      // position. Every badge must say which of the two problems it is: "rewrite
      // the title" and "the page ranks too deep to be seen" are not the same
      // instruction, and a bare "opportunity" badge told the reader neither.
      keywords: [
        { query: "high impression opportunity", clicks: 0, impressions: 140, ctr: 0, position: 8.4 },
        { query: "deep ranking query", clicks: 0, impressions: 60, ctr: 0, position: 24 },
        { query: "strong query", clicks: 12, impressions: 70, ctr: .171, position: 2.1 },
        // Below OPPORTUNITY_MIN_IMPRESSIONS: CTR is not a measurement here.
        { query: "one impression stray", clicks: 0, impressions: 3, ctr: 0, position: 11 },
      ],
      opportunities: {
        snippet: [{ query: "high impression opportunity", kind: "snippet", position: 8.4,
          impressions: 140, clicks: 0, ctr: 0, expectedCtr: .0371, lostClicks: 5.2,
          potentialClicks: null, score: 5.2 }],
        rank: [{ query: "deep ranking query", kind: "rank", position: 24, impressions: 60,
          clicks: 0, ctr: 0, expectedCtr: .0083, lostClicks: null, potentialClicks: 4.32, score: 4.32 }],
      },
      opportunityCount: 2, queryDenyPatterns: [],
      pages: [
        { page: "https://example.com/guides/analytics", clicks: 14, impressions: 180, ctr: .078, position: 5.4 },
      ],
      cfPages: [
        { page: "/guides/analytics", visits: 260, views: 340 },
        { page: "/", visits: 190, views: 210 },
      ],
      spark: Array.from({ length: 14 }, (_, index) => ({
        date: `2026-07-${String(index + 3).padStart(2, "0")}`,
        visits: index >= 11 ? 14000 : 90 + index * 4,
        flood: index >= 11,
      })),
    },
    {
      host: "davidveksler.freecapitalists.org", visits: 200, views: 270, previousVisits: 200, delta: 0,
      botVisits: 0, botViews: 0, botDays: 0, previousBotVisits: 0, cleanDays: 7, anomaly: null,
      partialVisits: 0, partialDays: 0,
      pagesPerSession: 1.35, previousPagesPerSession: 1.3, pagesPerSessionDelta: .05,
      searchSummary: { clicks: 6, impressions: 300, ctr: .02, position: 9.7 },
      gscWindow: null, referrers: [], keywords: [], pages: [], cfPages: [],
      spark: [{ date: "2026-07-15", visits: 25 }, { date: "2026-07-16", visits: 30 }],
    },
    // The sub-flood shape: 151 sessions from 54, flat, almost all direct, almost
    // all on one URL. Under FLOOD_MIN_VISITS, so the flood classifier is right
    // not to fire; the card looks like growth and the signal says otherwise.
    {
      host: "wiki.example", visits: 151, views: 151, previousVisits: 54, delta: 97 / 54,
      botVisits: 0, botViews: 0, botDays: 0, previousBotVisits: 0, cleanDays: 7, anomaly: null,
      partialVisits: 0, partialDays: 0, previousPartialDays: 0,
      pagesPerSession: 1, previousPagesPerSession: 1.4, pagesPerSessionDelta: -.4,
      searchSummary: null, gscWindow: null,
      referrers: [{ referrer: "(direct)", kind: "direct", visits: 136 }],
      keywords: [], pages: [],
      cfPages: [{ page: "/wiki/Main_Page", visits: 134, views: 134 },
        { page: "/sitemap.xml.gz", visits: 10, views: 10 }],
      spark: [{ date: "2026-07-15", visits: 54 }, { date: "2026-07-16", visits: 151 }],
    },
    // A real but tiny move: 40 sessions from 27 is +48%, and 13 sessions. The
    // percentage is arithmetically true and editorially worthless, so the badge
    // shows the raw change instead. This is the whopaysforai.org "↑600%" case
    // (6 sessions to 7) that taught the eye to ignore the badge entirely.
    {
      host: "davidveksler.com", visits: 40, views: 82, previousVisits: 27, delta: 13 / 27,
      botVisits: 0, botViews: 0, botDays: 0, previousBotVisits: 0, cleanDays: 7, anomaly: null,
      partialVisits: 0, partialDays: 0, previousPartialDays: 0,
      pagesPerSession: 2.05, previousPagesPerSession: 2, pagesPerSessionDelta: .05,
      searchSummary: null, gscWindow: null,
      referrers: [], keywords: [], pages: [], cfPages: [],
      spark: [{ date: "2026-07-15", visits: 27 }, { date: "2026-07-16", visits: 40 }],
    },
    // The freecapitalists.org case: every day in view was flooded, so there is no
    // clean day at all. The card must still show the referred sessions it did
    // measure rather than going blank.
    {
      host: "flooded.example", visits: 17, views: 0, previousVisits: 0, delta: null,
      botVisits: 1672, botViews: 1828, botDays: 1, previousBotVisits: 3428, cleanDays: 0,
      partialVisits: 17, partialDays: 1,
      anomaly: "99% direct, 1.1 pages/session, 65x a normal day",
      pagesPerSession: 0, previousPagesPerSession: 0, pagesPerSessionDelta: null,
      searchSummary: { clicks: 3, impressions: 100, ctr: .03, position: 39.8 },
      gscWindow: "2026-07-12–2026-07-14",
      referrers: [{ referrer: "www.google.com", kind: "search", visits: 17 }],
      keywords: [], pages: [], cfPages: [],
      spark: [{ date: "2026-07-15", visits: 24, flood: false }, { date: "2026-07-16", visits: 1689, flood: true }],
    },
    // A zone-log host: a file index with no HTML page to fire the RUM beacon, so
    // its numbers are HTTP request counts. It must render below its own heading,
    // in its own units, and never claim a session count.
    {
      host: "library.example", measurement: "zone", zoneSourced: true,
      visits: 1059, views: 19506, bytes: 76658000000,
      previousVisits: 940, delta: .127,
      botVisits: 0, botViews: 0, botDays: 0, previousBotVisits: 0, cleanDays: 7, anomaly: null,
      partialVisits: 0, partialDays: 0,
      pagesPerSession: 0, previousPagesPerSession: 0, pagesPerSessionDelta: null,
      searchSummary: null, gscWindow: null,
      referrers: [], keywords: [], pages: [],
      cfPages: [{ page: "/robots.txt", visits: 684, views: 612 }, { page: "/books/mises.pdf", visits: 141, views: 120 }],
      zoneCountries: [{ country: "US", visits: 620 }, { country: "DE", visits: 190 }],
      zoneStatuses: [{ status: 200, requests: 15200 }, { status: 404, requests: 1745 }],
      // Crawler accounting in place of a flood verdict, which cannot fire here.
      // Two lenses that overlap, so the card renders both and adds neither.
      zoneBots: {
        categories: [
          { category: "Archiver", requests: 936, visits: 60 },
          { category: "Search Engine Crawler", requests: 867, visits: 55 },
          { category: "AI Crawler", requests: 696, visits: 40 },
        ],
        verifiedRequests: 2499, verifiedVisits: 155,
        unverifiedRequests: 17007, unverifiedVisits: 904,
        totalRequests: 19506, totalVisits: 1059,
        verifiedShare: 2499 / 19506, measured: true,
      },
      zoneNonContent: {
        paths: [{ page: "/robots.txt", requests: 684 }],
        pathRequests: 684,
        errorStatuses: [{ status: 404, requests: 1745 }],
        errorRequests: 1745,
      },
      sources: { direct: 0, search: 0, social: 0, referral: 0, other: 0 },
      spark: [{ date: "2026-07-15", visits: 940, flood: false }, { date: "2026-07-16", visits: 1059, flood: false }],
    },
    // A second zone host on a pre-migration deployment: daily_zone_bots does not
    // exist yet, so the verified lens has nothing in it. The card must still
    // render, must not print a confident zero, and must still show the other lens.
    {
      host: "files.example", measurement: "zone", zoneSourced: true,
      visits: 88, views: 940, bytes: 2_400_000_000,
      previousVisits: 0, delta: null,
      botVisits: 0, botViews: 0, botDays: 0, previousBotVisits: 0, cleanDays: 7, anomaly: null,
      partialVisits: 0, partialDays: 0,
      pagesPerSession: 0, previousPagesPerSession: 0, pagesPerSessionDelta: null,
      searchSummary: null, gscWindow: null,
      referrers: [], keywords: [], pages: [],
      cfPages: [{ page: "/dl/handbook.epub", visits: 120, views: 20 }],
      zoneCountries: [], zoneStatuses: [],
      zoneBots: { categories: [], verifiedRequests: 0, verifiedVisits: 0,
        unverifiedRequests: 0, unverifiedVisits: 0, totalRequests: 0, totalVisits: 0,
        verifiedShare: 0, measured: false },
      zoneNonContent: { paths: [], pathRequests: 0, errorStatuses: [], errorRequests: 0 },
      sources: { direct: 0, search: 0, social: 0, referral: 0, other: 0 },
      spark: [{ date: "2026-07-15", visits: 80, flood: false }, { date: "2026-07-16", visits: 88, flood: false }],
    },
  ],
};

const html = renderDashboard(fixture);
const required = [
  "Human sessions", "Search opportunities", "Top landing pages (all traffic)", "Top landing pages (Google Search)", "data-query=\"domain\"",
  "high impression opportunity", "Last successful pull",
  // "Today's actions": the top three severity-1/2 signals, each with headline,
  // evidence, an imperative action, and a link.
  "Today's actions", "Act today", "Look at it",
  "wiki.example is up 180%, and it looks like a crawler rather than growth",
  "89% of entrances on /wiki/Main_Page",
  "Treat as crawler traffic, not growth",
  "Open wiki.example &rarr;", `href="#site-wiki-example"`,
  "library.example error responses are 12.9% of requests",
  "davidveksler.freecapitalists.org is serving 8 malformed URLs",
  "Google clicks", "Search impressions",
  // Item 6: the panel is RUM-only, the residual is named and moved out of the bar.
  "Traffic sources (RUM sites only)",
  "<b>Unattributed: 80 sessions (6.2%)</b>",
  "only the top 50 referrers per\n        host-day are persisted",
  `<i class="internal"></i><span>Internal</span><strong>120</strong>`,
  // Item 7: two classes, each named on the badge, each with its own remedy in the
  // tooltip. Neither says the bare word "opportunity".
  `<span class="opportunity-tag snippet"`, `>snippet</span>`,
  `<span class="opportunity-tag rank"`, `>rank</span>`,
  "clicks a window lost to the snippet, not to the ranking",
  "too deep to be seen",
  // Item 8: comparators on every tile.
  "Median search position", "9.4", "11 of 18 stored top queries in the top 10",
  "1 snippet · 1 rank",
  // Item 8, correction: both sides of the CTR comparator are the stored top-query
  // rows and the tile says so. The headline (2.1% here) is the whole corpus, a
  // visibly different number from the sample's 4.6%, because a top-query
  // expectation is not a verdict on the corpus.
  "headline covers every query",
  "stored top 18 queries: 4.6% vs expected ~5.9% · 40.9% of impressions",
  "14-day mean 96/day", "186/day here",
  "14-snapshot mean 42", "14-snapshot mean 2.0%",
  "rolling windows 2026-06-29–2026-07-01 through 2026-07-12–2026-07-14",
  "consecutive snapshots overlap",
  // Item 6, correction 4: the two tiles used to read "12 / 12 with traffic" beside
  // "11 RUM sites" and contradict each other about how many sites exist.
  "4 RUM + 2 zone · 4 with traffic",
  "min-height:44px", "Use \" + target + \" color theme",
  "if (detail.classList.contains(\"detail\") && matchMedia(\"(max-width: 560px)\").matches) detail.removeAttribute(\"open\")",
  // Crawler traffic must stay visible and named rather than silently dropped.
  "42,000 crawler sessions excluded", "3 flooded site-days", "example.com (42,000)",
  "spark-flood", "crawler flood, direct traffic excluded", "Human vs crawler",
  // A fully flooded site keeps the sessions it could still measure, marked as a
  // floor, instead of rendering a blank card.
  "&ge;&nbsp;17", "The figure above is the 17 referred sessions that survived the flooded day.",
  "pageviews not separable on flooded days",
  // ...and the mixed case, where clean days and recovered days both contribute.
  "Human figures above cover the 4 clean days, plus 120 referred sessions that survived the flooded days.",
  // Measurement classes are separated: the headline is RUM-only and the zone
  // host's request counts are reported beside it, in their own units.
  "Zone-log measurement", `class="card card--zone`, "4 RUM sites",
  "1.4 pages / session · RUM only",
  "19,506 requests · 1,059 zone visits · 71.4 GB",
  "Counted from zone HTTP request logs (no RUM tag on this site).",
  // Zone crawler accounting: two lenses, both rendered, neither summed, and no
  // human count claimed for a host where crawler share is unmeasurable.
  "Verified crawlers (a floor)",
  "&ge;&nbsp;2,499 requests", "&ge;&nbsp;155 zone visits",
  "Archiver <b>936</b> req · 60 vis",
  "not included and cannot be measured on this plan",
  "Non-content requests (a separate lens)",
  "Crawler-protocol and asset paths", "<b>684 requests</b>",
  "Error responses (status &ge; 400): <b>1,745 requests</b>",
  "The two lenses overlap and must not be added.",
  "This card reports no human count for library.example",
  // The pre-migration card renders without inventing a zero.
  "Verified-crawler figures appear after the next daily pull.",
];
for (const marker of required) {
  if (!html.includes(marker)) throw new Error(`Rendered dashboard is missing: ${marker}`);
}
if (html.includes("Total visitors")) throw new Error("Legacy visitor terminology remains in the rendered dashboard");

// ---- Traffic sources (spec item 6) ----------------------------------------
// "Other / unlisted" was the largest bucket on the page (1,060 of 2,012, 52.7%)
// and was never a class at all. It must not come back as a channel: not in the
// bar, not in the legend, not under that name anywhere.
const mixAt = html.indexOf(`class="source-overview"`);
const mixBlock = html.slice(mixAt, html.indexOf("</section>", mixAt));
if (mixBlock.includes("Other / unlisted") || /class="source-segment other"/.test(mixBlock)) {
  throw new Error("The unattributable residual must not render as a channel in the mix");
}
if (mixBlock.indexOf("Unattributed") < mixBlock.indexOf(`class="source-legend"`)) {
  throw new Error("Unattributed must render below the bar and legend, as a footnote");
}
if (!/class="source-note"/.test(mixBlock)) {
  throw new Error("The residual must render as a labelled footnote with its causes");
}
// `internal` is frozen into each stored row at write time, so a window reaching
// back before the change has no such row and the channel is ABSENT, not zero. A
// rendered "Internal 0 · 0.0%" would assert a measurement nobody took.
const historicalHtml = renderDashboard({
  ...fixture,
  totals: { ...fixture.totals, internalMeasured: false,
    sourceMix: { ...fixture.totals.sourceMix, internal: 0, unattributed: 200 } },
});
if (/<i class="internal"><\/i>/.test(historicalHtml)) {
  throw new Error("A window with no stored internal rows must omit the channel, not render a zero");
}
if (!historicalHtml.includes("were dropped rather than stored as an <i>internal</i> referral")) {
  throw new Error("With the internal channel absent, the residual note must name that as a cause");
}
if (!historicalHtml.includes("<b>Unattributed: 200 sessions (15.4%)</b>")) {
  throw new Error("The historical residual must still be quantified");
}
// The multi-day views are the ones that reach back over pre-change rows, so they
// are rendered too rather than trusting the 7-day fixture to cover it.
for (const periodDays of [1, 7, 30]) {
  const periodHtml = renderDashboard({ ...fixture, periodDays });
  if (!periodHtml.includes("Traffic sources (RUM sites only)")) {
    throw new Error(`The sources panel did not render at period=${periodDays}`);
  }
  if (periodHtml.includes("Other / unlisted")) {
    throw new Error(`The residual rendered as a channel at period=${periodDays}`);
  }
  // At 24h the tile value IS a daily figure, so the "N/day here" prefix would be
  // the same number twice; past that it is the period's own rate.
  const wantsPerDay = periodDays > 1;
  if (periodHtml.includes("/day here") !== wantsPerDay) {
    throw new Error(`period=${periodDays} rendered the wrong comparator form`);
  }
  if (!periodHtml.includes("14-day mean 96/day")) {
    throw new Error(`period=${periodDays} lost its 14-day comparator`);
  }
}
// A fixture with no history yet must not print an empty comparator chip.
const noTrendHtml = renderDashboard({
  ...fixture,
  totals: { ...fixture.totals,
    trend: { window: 14, days: 0, visitsPerDay: 0, viewsPerDay: 0, searchPerDay: 0, gscSnapshots: 0,
      gscClicksPerSnapshot: 0, gscImpressionsPerSnapshot: 0, gscCtr: 0,
      gscWindowFirst: null, gscWindowLast: null, gscSeries: [] } },
});
// Every comparator chip is a <span class="cmp">; the opportunity link is an
// <a class="cmp"> and is not a comparator.
if (noTrendHtml.includes(`<span class="cmp"`)) {
  throw new Error("With no history loaded the comparators must be absent, not rendered as zero");
}
if (!html.includes(`<span class="cmp"`)) {
  throw new Error("The comparator chips did not render on the normal fixture");
}

// ---- The CTR comparator names its population (spec item 8, correction) -----
// The expectation can only be computed over the stored top-query rows, so the
// actual it is compared against must be those same rows. A bare
// "expected ~N% at this position mix" beside a whole-corpus CTR is the bug.
if (/expected ~[\d.]+% at this position mix/.test(html)) {
  throw new Error("The CTR expectation renders without naming the population it covers");
}
// A sample covering a sliver of the corpus says so in the tile, not only in a
// tooltip nobody hovers.
const thinHtml = renderDashboard({
  ...fixture,
  totals: { ...fixture.totals,
    gscSampleImpressions: 200, gscSampleShare: 200 / 2200 },
});
if (!thinHtml.includes("9.1% of impressions · thin sample")) {
  throw new Error("A CTR comparator drawn from 9% of impressions did not declare itself thin");
}
if (html.includes("thin sample")) {
  throw new Error("A comparator covering 41% of impressions was labelled thin");
}
// Per-site query counts stopped being uniform when the stored-keyword cap went
// from 25 to KEYWORD_ROW_LIMIT: a site may store 40 queries or 500, so the
// sample count on this tile is now a four-figure number across the estate and the
// copy has to survive both the comma and the size. This is also what the raised
// cap is FOR — at high coverage the thin-sample label stops rendering on its own,
// because THIN_SAMPLE_SHARE was never the thing that needed changing.
const wideHtml = renderDashboard({
  ...fixture,
  totals: { ...fixture.totals,
    gscSampleQueries: 1842, gscSampleClicks: 214, gscSampleCtr: 214 / 47_300,
    gscSampleImpressions: 47_300, gscSampleShare: 47_300 / 58_832, gscImpressions: 58_832,
    gscPositionQueries: 968, gscTop10Queries: 121 },
});
if (!wideHtml.includes("stored top 1,842 queries:")) {
  throw new Error("The CTR tile's sample count did not render at estate scale");
}
if (!wideHtml.includes("121 of 968 stored top queries in the top 10")) {
  throw new Error("The position tile's subtitle did not render at estate scale");
}
if (wideHtml.includes("thin sample")) {
  throw new Error("A comparator covering 80% of impressions was still labelled thin");
}

// ---- Opportunity classes (spec item 7) ------------------------------------
// Every badge names its class. A bare "opportunity" told the reader that
// something was wrong and nothing about which of two unrelated fixes applies.
if (/>opportunity<\/span>/.test(html)) {
  throw new Error("A bare `opportunity` badge remains; every badge must read snippet or rank");
}
const badges = html.match(/class="opportunity-tag[^"]*"[^>]*>([a-z]+)</g) || [];
if (!badges.length) throw new Error("No opportunity badges rendered at all");
for (const badge of badges) {
  if (!/>(snippet|rank)</.test(badge)) {
    throw new Error(`An opportunity badge reads something other than snippet/rank: ${badge}`);
  }
}
// A query already earning its position's CTR, and one with too few impressions
// for CTR to be a measurement, both stay unbadged.
const keywordPanelAt = html.indexOf("Search opportunities");
const keywordPanel = html.slice(keywordPanelAt, html.indexOf("</section>", keywordPanelAt));
for (const query of ["strong query", "one impression stray"]) {
  const rowAt = keywordPanel.indexOf(query);
  if (rowAt < 0) throw new Error(`${query} did not render in the query list`);
  const row = keywordPanel.slice(rowAt, keywordPanel.indexOf("</li>", rowAt));
  if (row.includes("opportunity-tag")) {
    throw new Error(`${query} must not be badged: it is performing at its position`);
  }
}
// The two remedies are different sentences, and the badge tooltip carries the one
// that applies.
if (!keywordPanel.includes("Rewrite the title and meta description.")) {
  throw new Error("A snippet badge must carry the snippet remedy");
}
if (!keywordPanel.includes("Strengthen the page and link to it.")) {
  throw new Error("A rank badge must carry the ranking remedy");
}

// ---- Footer prose, interpolated from src/opportunities.js ------------------
// Computed here from the same imports, never typed, so changing a threshold
// fails this check until the prose follows (the same discipline the flood
// thresholds are held to below).
const opportunityProse = `A <b>snippet</b> gap is a query at position ${SNIPPET_MAX_POSITION} or better ` +
  `taking under ${(SNIPPET_CTR_RATIO * 100).toFixed(0)}% of the click-through its rank would ordinarily deliver`;
if (!html.includes(opportunityProse)) {
  throw new Error(`Footer snippet-class prose does not match src/opportunities.js: expected "${opportunityProse}"`);
}
const rankProse = `A <b>rank</b> gap is a query between position ${SNIPPET_MAX_POSITION} and ${RANK_MAX_POSITION}`;
if (!html.includes(rankProse)) {
  throw new Error(`Footer rank-class prose does not match src/opportunities.js: expected "${rankProse}"`);
}
for (const prose of [
  `what the query would earn at position ${TARGET_POSITION}`,
  `at least ${OPPORTUNITY_MIN_IMPRESSIONS} impressions and at least ${MIN_ACTIONABLE_CLICKS} clicks of gain`,
  `at least ${POSITION_MIN_IMPRESSIONS} impressions, not a mean`,
]) {
  if (!html.includes(prose)) {
    throw new Error(`Footer prose does not match the exported constants: expected "${prose}"`);
  }
}
// The GSC rolling-window caveat, and the sourcing of the CTR curve, are both
// claims the page has to make out loud rather than leaving to the reader.
for (const prose of [
  "GSC figures are a rolling window, not a daily series",
  "consecutive snapshots overlap by two days out of three",
  "SISTRIX 2020 CTR study",
  "it is a comparator and never a target",
  "Internal</b> is sessions arriving from one of a site's own hostnames",
  "it cannot be backfilled",
]) {
  if (!html.includes(prose)) throw new Error(`Footer is missing the required caveat: "${prose}"`);
}

// ---- "Today's actions" (spec item 5) --------------------------------------
// The block is the first thing in <main>, above the KPI tiles: it is the answer
// to "what do I do", and the tiles are the answer to "what happened".
const actionsAt = html.indexOf(`class="actions"`);
if (actionsAt < 0 || actionsAt > html.indexOf(`class="totals"`)) {
  throw new Error("Today's actions must render above the KPI tiles");
}
const actionsBlockHtml = html.slice(actionsAt, html.indexOf("</section>", actionsAt));
// At most three, and only severity 1 and 2. Severity 3 is context for the card,
// not an instruction — a "no like-for-like comparison" note must not displace a
// real finding from a three-slot list.
if ((actionsBlockHtml.match(/<li class="action /g) || []).length !== 3) {
  throw new Error("Today's actions must render exactly the top three severity-1/2 signals");
}
if (actionsBlockHtml.includes("no like-for-like comparison")) {
  throw new Error("A severity-3 signal must not appear in Today's actions");
}
if (actionsBlockHtml.includes("example.com has 1 query ranking well but not clicked")) {
  throw new Error("Today's actions is capped at three; the fourth signal leaked in");
}
// Every rendered action carries all four parts. A headline with no action is the
// old NOTABLE list with better typography.
for (const part of ["action-head", "action-why", "action-do"]) {
  if (!actionsBlockHtml.includes(part)) {
    throw new Error(`An action row is missing its ${part}`);
  }
}
// Links must land on anchors the page actually renders.
for (const anchor of actionsBlockHtml.match(/href="#site-[a-z0-9-]+"/g) || []) {
  const id = anchor.slice(7, -1);
  if (!html.includes(`id="${id}"`)) {
    throw new Error(`Today's actions links at #${id}, which no card carries`);
  }
}

// Recurrence renders when the engine can populate it honestly, and is silent
// otherwise — spec item 11 owns filling it in for the remaining rules, and this
// keeps the slot it lands in wired up.
const repeatHtml = renderDashboard({
  ...fixture,
  signals: fixture.signals.map((s, i) => (i === 0 ? { ...s, recurrence: 3 } : s)),
});
if (!repeatHtml.includes("3 days running")) {
  throw new Error("A signal carrying a recurrence must render it");
}
if (html.includes("days running")) {
  throw new Error("A signal with recurrence null must render no recurrence text");
}

// With no signals at all the block still renders, and says so. An empty
// container is indistinguishable from the block failing to render.
const quietHtml = renderDashboard({ ...fixture, signals: [] });
if (!quietHtml.includes("Nothing needs attention today.")) {
  throw new Error("With no signals the actions block must say so, not render empty");
}
if (quietHtml.includes(`<li class="action `)) {
  throw new Error("An empty signal list must not render action rows");
}
// ...and with only severity-3 signals, which are context rather than instructions.
const contextOnlyHtml = renderDashboard({ ...fixture, signals: fixture.signals.filter((s) => s.severity === 3) });
if (!contextOnlyHtml.includes("Nothing needs attention today.")) {
  throw new Error("Severity-3-only signals must still read as nothing to act on");
}

// ---- Absolute-change floor on the delta badge (spec item 4) ---------------
// 40 sessions from 27 is +48%, an absolute change of 13. The percentage is real
// and the movement is not, so the badge shows the raw change, muted.
const smallCardAt = html.indexOf(`id="site-davidveksler-com"`);
if (smallCardAt < 0) throw new Error("The small-change fixture card did not render");
const smallCard = html.slice(smallCardAt, html.indexOf("</section>", smallCardAt));
if (!/class="delta small"/.test(smallCard) || !smallCard.includes("+13")) {
  throw new Error("A change below the absolute floor must render as ±n, muted");
}
if (/class="delta up"[^>]*>↑ 48%/.test(smallCard) || smallCard.includes("↑ 48%<")) {
  throw new Error("A change below the absolute floor must not render as a percentage");
}
// ...while a real move keeps its percentage, in the same badge, at full weight.
const bigCardAt = html.indexOf(`id="site-example-com"`);
const bigCard = html.slice(bigCardAt, html.indexOf("</section>", bigCardAt));
if (!bigCard.includes(`class="delta up">↑ 38%`)) {
  throw new Error("A change above the absolute floor must still render as a percentage");
}

// Zone cards live below the "Zone-log measurement" heading, never above it and
// never interleaved with the RUM grid. Anchored on the card markup, not the
// class name, which also appears in the stylesheet above the heading.
const zoneCardAt = html.indexOf(`class="card card--zone`);
if (html.indexOf("Zone-log measurement") > zoneCardAt) {
  throw new Error("Zone cards must render below the Zone-log measurement heading");
}
// ...and nothing inside a zone card may call a request count a human session.
const zoneBlock = html.slice(zoneCardAt, html.indexOf("</main>", zoneCardAt));
if (zoneBlock.includes("human sessions")) {
  throw new Error("A zone-sourced card must never label its numbers as human sessions");
}
// ...nor invent one under any other name. The verified-bot floor covers 12.8% of
// this fixture's requests; the remaining 87.2% is readers and unlabelled crawlers
// mixed together, and nothing on the card may present a slice of it as an audience.
for (const claim of [/human (?:requests|visits|traffic)/i, /likely human/i, /estimated (?:human|crawler)/i]) {
  if (claim.test(zoneBlock)) {
    throw new Error(`A zone-sourced card must not assert a human figure: matched ${claim}`);
  }
}
// Both lenses appear on the measured zone card, and the overlap warning appears
// with them — a combined total would double-count a crawler that fetched robots.txt.
const measuredCard = zoneBlock.slice(0, zoneBlock.indexOf("files.example"));
for (const marker of ["Verified crawlers (a floor)", "Non-content requests (a separate lens)",
  "must not be added"]) {
  if (!measuredCard.includes(marker)) {
    throw new Error(`Zone crawler accounting is missing from the card: ${marker}`);
  }
}
// The pre-migration card renders, and reports the lens as unmeasured instead of
// printing a floor of zero that would read as "no crawlers here".
const preMigrationCard = zoneBlock.slice(zoneBlock.indexOf("files.example"));
if (!preMigrationCard.includes("Verified-crawler figures appear after the next daily pull.")) {
  throw new Error("A zone card with no daily_zone_bots rows must say so, not render a zero floor");
}
if (/&ge;&nbsp;0 requests/.test(preMigrationCard)) {
  throw new Error("A zone card with no verified-bot data must not render a zero floor");
}

// Footer prose is interpolated from the classifier's own constants. Computed
// here from the same imports, never typed, so changing a threshold in bots.js
// fails this check until the prose follows.
const floodProse = `≥${(DIRECT_SHARE * 100).toFixed(0)}% direct, ≤${FLAT_PAGES_PER_SESSION} pages/session, ` +
  `at least ${FLOOD_MIN_VISITS.toLocaleString("en-US")} sessions, and at least ${FLOOD_MULTIPLE}× a normal day`;
if (!html.includes(floodProse)) {
  throw new Error(`Footer flood thresholds do not match src/bots.js: expected "${floodProse}"`);
}
// The sentence the splitDay rework made false.
if (html.includes("excluded whole — from sessions, referrers, and landing pages alike")) {
  throw new Error("Footer still claims flooded days are excluded whole; referred sessions survive");
}
// A site with no crawler activity must not sprout an empty crawler callout:
// two of the three fixture sites have bot traffic.
if (html.split(`class="crawler-row"`).length - 1 !== 2) {
  throw new Error("Crawler callout should render for exactly the two flooded fixture sites");
}

if (process.argv.includes("--write")) {
  await mkdir(".preview", { recursive: true });
  await writeFile(".preview/dashboard.html", html, "utf8");
  console.log("Preview written to .preview/dashboard.html");
} else {
  console.log("Render checks passed");
}
