// Exercises loadDashboard's aggregation against a stubbed D1, using the shape
// that broke it: freecapitalists.org on 2026-08-09, where a 1,689-session
// crawler flood on the only day in view emptied the entire card.
//
// The classifier has its own unit checks; this one covers the layer above it —
// how classified days turn into the numbers the page prints — because that is
// where a flooded day used to erase a site's traffic, referrers and all.
import worker from "../src/index.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return;
  failures += 1;
  console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
}

const HOST = "freecapitalists.org";
const DIRECT_SHARE_FLOOD = .99;

const dayAfter = (start, n) => {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// 12 ordinary days, then two crawler-flooded ones (08-08, 08-09).
const DAYS = [
  ...[13, 10, 32, 13, 25, 11, 29, 18, 22, 16, 27, 24].map((visits, index) => ({
    date: dayAfter("2026-07-27", index), visits, direct: .6, pps: 1.4,
  })),
  { date: "2026-08-08", visits: 3428, direct: DIRECT_SHARE_FLOOD, pps: 1.08 },
  { date: "2026-08-09", visits: 1689, direct: DIRECT_SHARE_FLOOD, pps: 1.08 },
];

const traffic = DAYS.map((day) => ({
  date: day.date, host: HOST, visits: day.visits, views: Math.round(day.visits * day.pps),
}));
const referrers = DAYS.flatMap((day) => {
  const direct = Math.round(day.visits * day.direct);
  return [
    { date: day.date, host: HOST, referrer: "(direct)", kind: "direct", visits: direct },
    { date: day.date, host: HOST, referrer: "www.google.com", kind: "search", visits: day.visits - direct },
  ];
});
const nonDirect = (date) => referrers.find((r) => r.date === date && r.kind === "search").visits;

// Minimal D1 stub: routes on the table named in the SQL and applies the date
// filter from the bound parameters. Enough for loadDashboard's read path.
const between = (rows, [a, b]) => rows.filter((r) => r.date >= a && r.date <= b);
const db = {
  prepare(sql) {
    let binds = [];
    const run = () => {
      if (sql.includes("MAX(date)")) return { d: DAYS.at(-1).date };
      if (sql.includes("FROM runs")) return { run_at: "2026-08-09T13:00:57Z", ok: 1, note: "ok" };
      if (sql.includes("daily_traffic")) return { results: between(traffic, binds) };
      if (sql.includes("daily_referrers")) return { results: between(referrers, binds) };
      return { results: [] };
    };
    const stmt = {
      bind: (...args) => { binds = args; return stmt; },
      all: async () => run(),
      first: async () => run(),
    };
    return stmt;
  },
};

const load = async (query) => {
  const res = await worker.fetch(new Request(`https://stats.test/api/json?${query}`), { DB: db });
  const data = await res.json();
  return { data, site: data.sites.find((s) => s.host === HOST) };
};

// 1. The 24h view, where the only day available is flooded. This is the exact
//    case that rendered an empty card.
{
  const { data, site } = await load(`domain=${HOST}&period=1`);
  const recovered = nonDirect("2026-08-09");
  check("flooded-only day still reports referred sessions", site.visits, recovered);
  check("...and marks them as a partial-day floor", site.partialVisits, recovered);
  check("...over the one flooded day", site.partialDays, 1);
  check("...with no clean day claimed", site.cleanDays, 0);
  check("...crediting the crawler with the direct bucket only",
    site.botVisits, 1689 - recovered);
  check("...and keeps the referrers that survived", site.referrers.length, 1);
  check("...at the recovered volume", site.referrers[0]?.visits, recovered);
  check("...counted as search traffic", site.sources.search, recovered);
  check("...without inventing pageviews", site.views, 0);
  check("...or a pages/session rate", site.pagesPerSession, 0);
  // Previous day was flooded too, so a floor would be compared against a floor.
  check("...and suppresses the delta across partial days", site.delta, null);
  check("previous period is recovered the same way", site.previousVisits, nonDirect("2026-08-08"));
  check("totals follow the site", data.totals.visits, recovered);
  check("totals report the recovered volume", data.totals.partialVisits, recovered);
}

// 2. A window that mixes clean and flooded days: clean days count whole, flooded
//    days contribute only their referred sessions, and pageviews stay clean-only.
{
  const { site } = await load(`domain=${HOST}&period=7`);
  const window = DAYS.slice(-7);
  const clean = window.filter((day) => day.date < "2026-08-08");
  const cleanVisits = clean.reduce((sum, day) => sum + day.visits, 0);
  const cleanViews = clean.reduce((sum, day) => sum + Math.round(day.visits * day.pps), 0);
  const recovered = nonDirect("2026-08-08") + nonDirect("2026-08-09");
  check("clean days count whole", site.cleanDays, clean.length);
  check("mixed window sums clean plus recovered", site.visits, cleanVisits + recovered);
  check("pageviews come only from clean days", site.views, cleanViews);
  check("pages/session divides by clean sessions only",
    Number(site.pagesPerSession.toFixed(3)), Number((cleanViews / cleanVisits).toFixed(3)));
  check("flooded days in a mixed window are still flagged", site.partialDays, 2);
}

// 3. A site with no flood at all must be untouched by any of this.
{
  const { data } = await load("period=7");
  const quiet = data.sites.find((s) => s.host !== HOST);
  check("unflooded sites report no partial days", quiet.partialDays, 0);
  check("unflooded sites report no recovered sessions", quiet.partialVisits, 0);
}

if (failures) {
  console.error(`\n${failures} dashboard aggregation check(s) failed`);
  process.exit(1);
}
console.log("Dashboard aggregation checks passed");
