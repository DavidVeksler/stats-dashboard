// Exercises loadDashboard's aggregation against a stubbed D1, using the shape
// that broke it: freecapitalists.org on 2026-08-09, where a 1,689-session
// crawler flood on the only day in view emptied the entire card.
//
// The classifier has its own unit checks; this one covers the layer above it —
// how classified days turn into the numbers the page prints — because that is
// where a flooded day used to erase a site's traffic, referrers and all.
import worker from "../src/index.js";
import { looksMalformed } from "../src/urls.js";

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
  { date: "2026-08-05", visits: 900, requests: 17000, bytes: 58_000_000_000 },
  { date: "2026-08-06", visits: 910, requests: 17500, bytes: 59_000_000_000 },
  { date: "2026-08-07", visits: 920, requests: 17800, bytes: 60_000_000_000 },
  { date: "2026-08-08", visits: 940, requests: 17400, bytes: 61_000_000_000 },
  { date: "2026-08-09", visits: 1059, requests: 19506, bytes: 76_658_000_000 },
];

// The 2026-08-13 wiki.freecapitalists.org shape: 151 sessions up from about 54,
// flat at 1.0 pages/session, ~90% direct, and 134 of 151 entrances on one URL.
// A crawler spike sitting under FLOOD_MIN_VISITS, which is exactly why the flood
// classifier is right not to fire and why the subflood signal has to.
const WIKI_HOST = "wiki.freecapitalists.org";
const WIKI_DAYS = [
  { date: "2026-08-08", visits: 54, views: 76, direct: 30 },
  { date: "2026-08-09", visits: 151, views: 151, direct: 136 },
];

// Crawl pollution from broken pagination markup, live on
// davidveksler.freecapitalists.org on 2026-08-13 and served with a 200. These are
// the exact stored paths.
const MALFORMED_HOST = "davidveksler.freecapitalists.org";
const MALFORMED_PATHS = [
  "/category/austrian-economics/%3E%C3%97%3C/span%3E8%3C/span%3E",
  "/category/uncategorized/page/2/%3E%C3%97%3C/span%3E4%3C/span%3E",
  "/category/philosophy/%3E%C3%97%3C/span%3E2%3C/span%3E",
];

// A real but small move: 40 sessions from 27 is +48%, an absolute change of 13.
// No signal and no percentage badge — a percentage on this base is noise.
const SMALL_HOST = "davidveksler.com";
const SMALL_DAYS = [
  { date: "2026-08-08", visits: 27, views: 54 },
  { date: "2026-08-09", visits: 40, views: 82 },
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
// The wiki rows below are RUM landing pages, where `visits` is entrances.
const ZONE_PAGES = [
  { date: "2026-08-09", host: WIKI_HOST, page: "/wiki/Main_Page", visits: 134, views: 134 },
  { date: "2026-08-09", host: WIKI_HOST, page: "/sitemap.xml.gz", visits: 10, views: 10 },
  { date: "2026-08-09", host: WIKI_HOST, page: "/wiki/Praxeology", visits: 7, views: 7 },
  ...MALFORMED_PATHS.map((page, index) => ({
    date: "2026-08-09", host: MALFORMED_HOST, page, visits: 4 - index, views: 4 - index,
  })),
  { date: "2026-08-09", host: MALFORMED_HOST, page: "/2026/07/sound-money/", visits: 9, views: 12 },
  { date: "2026-08-08", host: ZONE_HOST, page: "/robots.txt", visits: 590, views: 0 },
  { date: "2026-08-09", host: ZONE_HOST, page: "/robots.txt", visits: 684, views: 0 },
  { date: "2026-08-09", host: ZONE_HOST, page: "/favicon.ico", visits: 42, views: 0 },
  { date: "2026-08-09", host: ZONE_HOST, page: "/cdn-cgi/trace", visits: 230, views: 0 },
  { date: "2026-08-09", host: ZONE_HOST, page: "/books/mises.pdf", visits: 141, views: 0 },
];
// Status rows exist per day, which is what gives error-spike a baseline without
// a new query. 08-08 is an ordinary day (about 1.1% errors); 08-09 is the real
// 2026-08-13 library shape — 1,745 404s at 9.0% of requests.
const ZONE_STATUSES = [
  { date: "2026-08-05", host: ZONE_HOST, status: 200, requests: 16800 },
  { date: "2026-08-05", host: ZONE_HOST, status: 404, requests: 180 },
  { date: "2026-08-06", host: ZONE_HOST, status: 200, requests: 17300 },
  { date: "2026-08-06", host: ZONE_HOST, status: 404, requests: 200 },
  { date: "2026-08-07", host: ZONE_HOST, status: 200, requests: 17600 },
  { date: "2026-08-07", host: ZONE_HOST, status: 404, requests: 210 },
  { date: "2026-08-08", host: ZONE_HOST, status: 200, requests: 17200 },
  { date: "2026-08-08", host: ZONE_HOST, status: 404, requests: 190 },
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
  ...WIKI_DAYS.map((day) => ({ date: day.date, host: WIKI_HOST, visits: day.visits, views: day.views })),
  ...SMALL_DAYS.map((day) => ({ date: day.date, host: SMALL_HOST, visits: day.visits, views: day.views })),
];
const referrers = [
  ...DAYS.flatMap((day) => {
    const direct = Math.round(day.visits * day.direct);
    return [
      { date: day.date, host: HOST, referrer: "(direct)", kind: "direct", visits: direct },
      { date: day.date, host: HOST, referrer: "www.google.com", kind: "search", visits: day.visits - direct },
    ];
  }),
  ...WIKI_DAYS.flatMap((day) => [
    { date: day.date, host: WIKI_HOST, referrer: "(direct)", kind: "direct", visits: day.direct },
    { date: day.date, host: WIKI_HOST, referrer: "www.google.com", kind: "search", visits: day.visits - day.direct },
  ]),
];
const nonDirect = (date) =>
  referrers.find((r) => r.host === HOST && r.date === date && r.kind === "search").visits;

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
      // Read over the whole history window now, not just the latest day: the
      // error-spike baseline lives in these rows.
      if (sql.includes("daily_zone_status")) return { results: between(ZONE_STATUSES, binds) };
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
  check("...so the headline carries no zone visits", data.totals.visits,
    nonDirect("2026-08-09") + WIKI_DAYS.at(-1).visits + SMALL_DAYS.at(-1).visits);
  check("...and no zone requests, only RUM pageviews", data.totals.views,
    WIKI_DAYS.at(-1).views + SMALL_DAYS.at(-1).views);
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

// 7. The ranked signal engine (spec item 4). Rules live in src/signals.js and are
//    a pure function of rows loadDashboard already read; these assertions drive
//    them through the real aggregation rather than calling the module directly,
//    because the shape of a site row is half of every rule.
{
  const { data } = await load("period=1");
  const signals = data.signals ?? [];
  const of = (host) => signals.filter((s) => s.host === host);
  const kinds = (host) => of(host).map((s) => s.kind).sort().join(",");

  check("the signal list replaced the old anomalies list", Array.isArray(data.signals), true);
  check("...and anomalies is gone rather than left to rot", "anomalies" in data, false);
  check("signals are ranked by severity, most urgent first",
    signals.every((s, i) => i === 0 || signals[i - 1].severity <= s.severity), true);
  for (const signal of signals) {
    for (const field of ["severity", "kind", "host", "headline", "evidence", "action", "href", "recurrence"]) {
      check(`every signal carries ${field} (${signal.kind}/${signal.host})`, field in signal, true);
    }
    check(`${signal.kind} links at the card anchor`, signal.href.startsWith("#site-"), true);
    check(`${signal.kind} never fabricates a recurrence`,
      signal.recurrence === null || Number.isInteger(signal.recurrence), true);
  }

  // The sub-flood: 151 sessions, +180%, flat, direct, one landing page. Exactly
  // one severity-1 signal, and traffic-rise must NOT also fire — a spike is
  // either growth or a crawler, never reported as both.
  check("a sub-flood crawler spike is called what it is", kinds(WIKI_HOST), "likely-bot-subflood");
  check("...at severity 1", of(WIKI_HOST)[0]?.severity, 1);
  check("...and suppresses traffic-rise for the same host",
    of(WIKI_HOST).some((s) => s.kind === "traffic-rise"), false);
  check("...naming the landing page that gives it away",
    of(WIKI_HOST)[0]?.evidence.includes("/wiki/Main_Page"), true);

  // Measurement class. A zone host has no sessions and no pages/session, so no
  // rule that speaks in those units may fire on it — the live NOTABLE list led
  // with "library.freecapitalists.org pages/session fell by 2.1", a quantity
  // that does not exist. Only zone-specific rules are eligible.
  check("a zone host gets only zone-specific rules", kinds(ZONE_HOST), "error-spike");
  check("...fired on its error rate", of(ZONE_HOST)[0]?.severity, 1);
  check("...quantified against a baseline", of(ZONE_HOST)[0]?.evidence.includes("2,514"), true);
  // Only days that actually have status rows form the baseline. Counting an
  // unmeasured day as 0% errors would manufacture a spike out of a normal day.
  check("...built from the days that were measured, not from zeroes",
    of(ZONE_HOST)[0]?.evidence.includes("4-day mean of 1.1%"), true);
  for (const kind of ["traffic-rise", "traffic-drop", "likely-bot-subflood", "no-comparison"]) {
    check(`no ${kind} signal for a zone-sourced host`, of(ZONE_HOST).some((s) => s.kind === kind), false);
  }

  // Absolute-change floors. 40 sessions from 27 is +48% and 13 sessions; the
  // percentage is real and the movement is not.
  check("a small absolute change produces no signal at all", of(SMALL_HOST).length, 0);

  // Crawl pollution: three or more landing pages that could not have been
  // generated by the origin. Spec item 10 owns badging the rows themselves; the
  // predicate it will use is shared already (src/urls.js).
  check("malformed landing pages are surfaced as a cleanup ticket", kinds(MALFORMED_HOST), "malformed-urls");
  check("...at severity 2", of(MALFORMED_HOST)[0]?.severity, 2);
  check("...counting only the malformed ones", of(MALFORMED_HOST)[0]?.headline.includes("3 malformed"), true);

  // Say when you are silent: a flooded site used to drop out of NOTABLE with no
  // explanation because site.delta was null.
  check("a flooded site explains its missing comparison", kinds(HOST), "no-comparison");
  check("...as context, not an alarm", of(HOST)[0]?.severity, 3);
  // The one recurrence the loaded history answers exactly: consecutive flooded
  // days ending today, in the 24h view where that is the same statement.
  check("...counting the consecutive flooded days it can actually see",
    of(HOST)[0]?.recurrence, 2);
}

// 7b. The malformed-URL predicate itself, against the live paths and against the
//     ordinary ones it must never touch. A false positive here would badge a real
//     page and inflate the signal, so the predicate is biased to false negatives.
{
  for (const path of [
    ...MALFORMED_PATHS,
    "/category/austrian-economics/>×</span>8</span>",
    "/blog//double-slash",
    "/wiki/span",
    "/broken/%zz",
  ]) {
    check(`looksMalformed flags ${path}`, looksMalformed(path), true);
  }
  for (const path of [
    "/", "/2026/07/sound-money/", "/books/mises.pdf", "/robots.txt",
    "/cdn-cgi/trace", "/wiki/Main_Page", "/img/logo.png", "/category/uncategorized/page/2/",
    "/scripts/app.js", "/a/b", "/p/123", "/search?q=austrian%20economics",
    "https://davidveksler.freecapitalists.org/2026/07/sound-money/",
  ]) {
    check(`looksMalformed leaves ${path} alone`, looksMalformed(path), false);
  }
  check("looksMalformed tolerates a missing path", looksMalformed(undefined), false);
}

// `node scripts/dashboard-check.mjs --signals` prints the list these fixtures
// produce, which is the fastest way to see what a rule change does to it.
if (process.argv.includes("--signals")) {
  const { data } = await load("period=1");
  for (const s of data.signals) {
    console.log(`[${s.severity}] ${s.kind} — ${s.headline}\n    ${s.evidence}\n    → ${s.action} (${s.href}${s.recurrence ? `, recurrence ${s.recurrence}` : ""})`);
  }
}

// 8. The same engine feeds the ntfy push, so the rules cannot drift into two
//    copies. Only severity 1 is worth a phone alert; a quiet day is unchanged.
{
  const { data } = await load("period=1");
  const severityOne = (data.signals ?? []).filter((s) => s.severity === 1);
  check("there is a severity-1 finding for the push to carry", severityOne.length > 0, true);
  check("...and it is the head of the list", data.signals[0].severity, 1);
}

if (failures) {
  console.error(`\n${failures} dashboard aggregation check(s) failed`);
  process.exit(1);
}
console.log("Dashboard aggregation checks passed");
