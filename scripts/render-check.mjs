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
  allDomains: ["example.com", "small.example.com"],
  anomalies: [{ type: "up", host: "example.com", metric: "sessions", value: .31 }],
  totals: { visits: 1300, views: 1770, search: 260, domains: 2, active: 2, previousVisits: 1000, delta: .3, searchShare: .2, daysAvailable: 7, previousDaysAvailable: 7 },
  sites: [
    {
      host: "example.com", visits: 1100, views: 1500, previousVisits: 800, delta: .375,
      pagesPerSession: 1.36, previousPagesPerSession: 1.2, pagesPerSessionDelta: .16,
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
      spark: Array.from({ length: 14 }, (_, index) => ({ date: `2026-07-${String(index + 3).padStart(2, "0")}`, visits: 90 + index * 4 })),
    },
    {
      host: "small.example.com", visits: 200, views: 270, previousVisits: 200, delta: 0,
      pagesPerSession: 1.35, previousPagesPerSession: 1.3, pagesPerSessionDelta: .05,
      gscWindow: null, referrers: [], keywords: [], pages: [],
      spark: [{ date: "2026-07-15", visits: 25 }, { date: "2026-07-16", visits: 30 }],
    },
  ],
};

const html = renderDashboard(fixture);
const required = [
  "Total sessions", "Search opportunities", "Top landing pages", "data-query=\"domain\"",
  "aria-label=\"Notable changes\"", "high impression opportunity", "Last successful pull",
];
for (const marker of required) {
  if (!html.includes(marker)) throw new Error(`Rendered dashboard is missing: ${marker}`);
}
if (html.includes("Total visitors")) throw new Error("Legacy visitor terminology remains in the rendered dashboard");

if (process.argv.includes("--write")) {
  await mkdir(".preview", { recursive: true });
  await writeFile(".preview/dashboard.html", html, "utf8");
  console.log("Preview written to .preview/dashboard.html");
} else {
  console.log("Render checks passed");
}
