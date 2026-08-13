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

// A zone-log host (config.js marks library.freecapitalists.org trafficSource:
// "zone"): no RUM beacon, so `visits` is Cloudflare's zone-log arrival heuristic
// and `views` is raw HTTP requests. These must never reach a session total.
const ZONE_HOST = "library.freecapitalists.org";
const ZONE_DAYS = [
  { date: "2026-08-08", visits: 940, requests: 17400, bytes: 61_000_000_000 },
  { date: "2026-08-09", visits: 1059, requests: 19506, bytes: 76_658_000_000 },
];

// The crawler accounting a zone host gets in place of a flood verdict, in the
// real 2026-08-12 proportions: verified bots are a sixth of the day and the
// unverified remainder — readers and unlabelled crawlers together — is the rest.
const ZONE_BOTS = [
  { date: "2026-08-09", host: ZONE_HOST, category: "(unverified)", requests: 16117, visits: 843 },
  { date: "2026-08-09", host: ZONE_HOST, category: "Archiver", requests: 936, visits: 60 },
  { date: "2026-08-09", host: ZONE_HOST, category: "Search Engine Crawler", requests: 867, visits: 55 },
  { date: "2026-08-09", host: ZONE_HOST, category: "AI Crawler", requests: 696, visits: 40 },
  { date: "2026-08-09", host: ZONE_HOST, category: "Search Engine Optimization", requests: 446, visits: 31 },
  { date: "2026-08-09", host: ZONE_HOST, category: "AI Search", requests: 405, visits: 25 },
  { date: "2026-08-09", host: ZONE_HOST, category: "Page Preview", requests: 39, visits: 5 },
];
const VERIFIED_REQUESTS = 936 + 867 + 696 + 446 + 405 + 39;
const VERIFIED_VISITS = 60 + 55 + 40 + 31 + 25 + 5;

// Zone daily_cf_pages rows carry requests in `visits` (see runDaily's insert).
const ZONE_PAGES = [
  { date: "2026-08-08", host: ZONE_HOST, page: "/robots.txt", visits: 590, views: 0 },
  { date: "2026-08-09", host: ZONE_HOST, page: "/robots.txt", visits: 684, views: 0 },
  { date: "2026-08-09", host: ZONE_HOST, page: "/favicon.ico", visits: 42, views: 0 },
  { date: "2026-08-09", host: ZONE_HOST, page: "/cdn-cgi/trace", visits: 230, views: 0 },
  { date: "2026-08-09", host: ZONE_HOST, page: "/books/mises.pdf", visits: 141, views: 0 },
];
const ZONE_STATUSES = [
  { date: "2026-08-09", host: ZONE_HOST, status: 200, requests: 15200 },
  { date: "2026-08-09", host: ZONE_HOST, status: 404, requests: 1745 },
  { date: "2026-08-09", host: ZONE_HOST, status: 406, requests: 769 },
];

// Flipped to false to reproduce a pre-migration deployment, where the read runs
// before ensureSchema has created daily_zone_bots.
let zoneBotsTableExists = true;

const traffic = [
  ...DAYS.map((day) => ({
    date: day.date, host: HOST, visits: day.visits, views: Math.round(day.visits * day.pps),
  })),
  ...ZONE_DAYS.map((day) => ({
    date: day.date, host: ZONE_HOST, visits: day.visits, views: day.requests, bytes: day.bytes,
  })),
];
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
      if (sql.includes("daily_cf_pages")) return { results: between(ZONE_PAGES, binds) };
      if (sql.includes("daily_zone_status")) return { results: ZONE_STATUSES.filter((r) => r.date === binds[0]) };
      if (sql.includes("daily_zone_bots")) {
        // A missing table is what D1 raises before the migration lands; the read
        // path has to survive it, not 500 the whole dashboard.
        if (!zoneBotsTableExists) throw new Error("D1_ERROR: no such table: daily_zone_bots");
        return { results: ZONE_BOTS.filter((r) => r.date === binds[0]) };
      }
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
  const quiet = data.sites.find((s) => s.host !== HOST && !s.zoneSourced);
  check("unflooded sites report no partial days", quiet.partialDays, 0);
  check("unflooded sites report no recovered sessions", quiet.partialVisits, 0);
}

// 4. Measurement classes stay separate. A zone-log host counts HTTP requests, not
//    RUM sessions; summing the two is what made the headline "pages / session"
//    an artifact (20,897 "pageviews" of which 19,506 were library requests).
{
  const { data } = await load("period=1");
  const zone = data.sites.find((s) => s.host === ZONE_HOST);
  const today = ZONE_DAYS.at(-1);
  const rumSites = data.sites.filter((s) => !s.zoneSourced);
  const rumVisits = rumSites.reduce((sum, s) => sum + s.visits, 0);
  const rumViews = rumSites.reduce((sum, s) => sum + s.views, 0);

  check("zone hosts are typed from config, not by hostname", zone.measurement, "zone");
  check("...and still report their own volume", zone.visits, today.visits);
  check("totals.visits excludes every zoneSourced site", data.totals.visits, rumVisits);
  check("totals.views excludes every zoneSourced site", data.totals.views, rumViews);
  check("...so the headline carries no zone visits", data.totals.visits, nonDirect("2026-08-09"));
  check("...and no zone requests", data.totals.views, 0);
  check("previous-period totals exclude them too", data.totals.previousVisits,
    rumSites.reduce((sum, s) => sum + s.previousVisits, 0));
  check("zone volume is reported separately, not dropped", data.totals.zone.visits, today.visits);
  check("...with requests in their own units", data.totals.zone.requests, today.requests);
  check("...and bandwidth alongside", data.totals.zone.bytes, today.bytes);
  check("...naming the hosts it covers", data.totals.zone.hosts.join(","), ZONE_HOST);
  check("...over one zone site", data.totals.zone.sites, 1);
  check("pages/session is RUM pageviews over RUM sessions", data.totals.pagesPerSession,
    rumVisits ? rumViews / rumVisits : 0);
  check("the source mix is RUM-only as well",
    Object.values(data.totals.sourceMix).reduce((a, b) => a + b, 0) <= rumVisits, true);
  // Sorting ranks within a measurement class, never across it: 19,506 requests
  // must not outrank a RUM site's sessions.
  check("zone cards sort after every RUM card", data.sites.at(-1).host, ZONE_HOST);
}

// 5. Zone crawler accounting. The flood classifier cannot fire on a zone host
//    (no referrer rows, so directShare is always 0), so its crawler volume would
//    otherwise be counted as an audience by implication. Two lenses replace the
//    verdict, and neither may yield a human figure.
{
  const { data } = await load("period=1");
  const zone = data.sites.find((s) => s.host === ZONE_HOST);
  const rum = data.sites.find((s) => s.host === HOST);

  check("the zone host is never flagged as flooded", zone.botDays, 0);
  check("...and gets the zone decomposition instead of that silence",
    zone.zoneBots !== null, true);
  check("verified crawlers are summed as a floor", zone.zoneBots.verifiedRequests, VERIFIED_REQUESTS);
  check("...in visits as well as requests", zone.zoneBots.verifiedVisits, VERIFIED_VISITS);
  check("...a floor that is a minority of the day", zone.zoneBots.verifiedShare < .2, true);
  check("the unverified remainder is kept and named", zone.zoneBots.unverifiedRequests, 16117);
  check("...and excluded from the verified categories", zone.zoneBots.categories.length, 6);
  check("...ranked by requests", zone.zoneBots.categories[0].category, "Archiver");
  for (const field of ["human", "humanRequests", "likelyHuman"]) {
    check(`no ${field} figure is asserted for a zone host`, field in zone.zoneBots, false);
  }

  check("non-content paths come from the latest day only",
    zone.zoneNonContent.pathRequests, 684 + 42 + 230);
  check("...leaving real files out of it", zone.zoneNonContent.paths.length, 3);
  check("error responses are counted from the status table",
    zone.zoneNonContent.errorRequests, 1745 + 769);
  check("the two lenses are never merged into one total",
    "requests" in zone.zoneNonContent, false);

  check("RUM sites get no zone decomposition", rum.zoneBots, null);
  check("...nor a non-content lens", rum.zoneNonContent, null);
  // The headline stays what item 1 made it: zone volume never joins a session total.
  check("crawler accounting does not disturb the RUM headline", data.totals.visits,
    data.sites.filter((s) => !s.zoneSourced).reduce((sum, s) => sum + s.visits, 0));
}

// 6. Pre-migration: daily_zone_bots does not exist yet. The dashboard must still
//    load, and the card must report the lens as unmeasured rather than printing a
//    confident zero.
{
  zoneBotsTableExists = false;
  try {
    const { data } = await load("period=1");
    const zone = data.sites.find((s) => s.host === ZONE_HOST);
    check("a missing daily_zone_bots table still renders the dashboard", data.sites.length > 0, true);
    check("...with the zone card intact", zone.visits, ZONE_DAYS.at(-1).visits);
    check("...the verified lens marked unmeasured, not zero", zone.zoneBots.measured, false);
    check("...claiming no verified crawlers either way", zone.zoneBots.verifiedRequests, 0);
    check("...and the other lens still working", zone.zoneNonContent.pathRequests, 684 + 42 + 230);
  } finally {
    zoneBotsTableExists = true;
  }
}

if (failures) {
  console.error(`\n${failures} dashboard aggregation check(s) failed`);
  process.exit(1);
}
console.log("Dashboard aggregation checks passed");
