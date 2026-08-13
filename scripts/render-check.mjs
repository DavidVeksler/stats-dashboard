import { mkdir, writeFile } from "node:fs/promises";
import { renderDashboard } from "../src/render.js";
// Imported, never retyped: the footer prose that explains these rules is
// asserted against the constants themselves, so the two cannot drift.
import { FLOOD_MIN_VISITS, FLOOD_MULTIPLE, FLAT_PAGES_PER_SESSION, DIRECT_SHARE } from "../src/bots.js";

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
  allDomains: ["example.com", "davidveksler.freecapitalists.org", "library.example"],
  anomalies: [{ type: "up", host: "example.com", metric: "sessions", value: .31 }],
  // Headline totals are RUM-only: the zone site's 1,059 zone visits and 19,506
  // requests are in totals.zone and nowhere else. Summed the old way these tiles
  // would read 2,359 sessions over 21,276 "pageviews" — 9.0 pages/session, an
  // artifact of dividing HTTP requests by RUM sessions.
  totals: { visits: 1300, views: 1770, pagesPerSession: 1770 / 1300, search: 260,
    domains: 4, rumDomains: 3, active: 4, previousVisits: 1000, delta: .3, searchShare: .2, daysAvailable: 7, previousDaysAvailable: 7,
    botVisits: 42000, botViews: 42350, previousBotVisits: 0, botShare: .97, floodedSiteDays: 3, floodedSites: 1,
    partialVisits: 120, partialSites: 1,
    sourceMix: { direct: 700, search: 260, social: 80, referral: 60, other: 200 },
    zone: { visits: 1059, requests: 19506, bytes: 76658000000, sites: 1, hosts: ["library.example"] },
    gscClicks: 46, gscImpressions: 2200, gscCtr: .0209, gscPosition: 7.8, searchDataDomains: 2, opportunities: 1 },
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
      keywords: [
        { query: "high impression opportunity", clicks: 0, impressions: 140, ctr: 0, position: 8.4 },
        { query: "strong query", clicks: 12, impressions: 70, ctr: .171, position: 2.1 },
      ],
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
  "aria-label=\"Notable changes\"", "high impression opportunity", "Last successful pull",
  "Google clicks", "Search impressions", "Traffic sources", "Avg search position",
  "min-height:44px", "Use \" + target + \" color theme",
  "if (matchMedia(\"(max-width: 560px)\").matches) detail.removeAttribute(\"open\")",
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
  "Zone-log measurement", `class="card card--zone`, "3 RUM sites",
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
