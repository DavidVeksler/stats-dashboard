import { mkdir, writeFile } from "node:fs/promises";
import { renderDashboard } from "../src/render.js";

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
  allDomains: ["example.com", "davidveksler.freecapitalists.org"],
  anomalies: [{ type: "up", host: "example.com", metric: "sessions", value: .31 }],
  totals: { visits: 1300, views: 1770, search: 260, domains: 2, active: 2, previousVisits: 1000, delta: .3, searchShare: .2, daysAvailable: 7, previousDaysAvailable: 7,
    botVisits: 42000, botViews: 42350, previousBotVisits: 0, botShare: .97, floodedSiteDays: 3, floodedSites: 1,
    partialVisits: 120, partialSites: 1,
    sourceMix: { direct: 700, search: 260, social: 80, referral: 60, other: 200 },
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
  "&ge;&nbsp;17", "The figure above is the 17 referred sessions",
  "pageviews not separable on flooded days",
];
for (const marker of required) {
  if (!html.includes(marker)) throw new Error(`Rendered dashboard is missing: ${marker}`);
}
if (html.includes("Total visitors")) throw new Error("Legacy visitor terminology remains in the rendered dashboard");
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
