// Exercises loadDashboard's aggregation against a stubbed D1, using the shape
// that broke it: freecapitalists.org on 2026-08-09, where a 1,689-session
// crawler flood on the only day in view emptied the entire card.
//
// The classifier has its own unit checks; this one covers the layer above it —
// how classified days turn into the numbers the page prints — because that is
// where a flooded day used to erase a site's traffic, referrers and all.
import worker from "../src/index.js";
import { classifyTraffic, splitDay, directRatioStats } from "../src/bots.js";
import { looksMalformed } from "../src/urls.js";
import { expectedCtr, classifyOpportunity, TARGET_POSITION, MIN_ACTIONABLE_CLICKS,
  POSITION_MIN_IMPRESSIONS, RANK_MAX_POSITION, OPPORTUNITY_MIN_IMPRESSIONS } from "../src/opportunities.js";
import { KEYWORD_ROW_LIMIT } from "../src/gsc.js";

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

// ---- Search Console fixtures (spec items 7 and 8) -------------------------
// The three queries in the spec's acceptance list, with their real 2026-08-13
// numbers, plus enough neighbours on each host that "not in the top 5 by its
// class metric" is a statement about a list rather than about an empty array.
//
//   bitcoin recovery        13 imp, 0 clk, pos 31.2  -> must surface as `rank`
//   incest forum            61 imp, 1 clk, pos 12.8  -> must not make the top 5
//   frontier ai labs list    6 imp, 2 clk, pos  2.5  -> must not be flagged at all
//
// The first two are why the split exists: one metric cannot rank both, because
// lost clicks measures what is recoverable at the CURRENT rank and that is zero
// by construction for a query nobody can see.
const WALLET_HOST = "walletrecovery.info";
const FORUM_HOST = "forum.objectivismonline.com";
const SHEETS_HOST = "cheatsheets.davidveksler.com";
const KEYWORD_DATE = "2026-08-09";
const KEYWORDS = [
  // walletrecovery.info — a ranking problem, which is this site's whole shape.
  { host: WALLET_HOST, query: "bitcoin recovery", clicks: 0, impressions: 13, position: 31.2 },
  { host: WALLET_HOST, query: "recover lost bitcoin wallet", clicks: 0, impressions: 40, position: 22.4 },
  { host: WALLET_HOST, query: "crypto wallet recovery service", clicks: 1, impressions: 55, position: 18.7 },
  { host: WALLET_HOST, query: "forgot my wallet password", clicks: 0, impressions: 9, position: 27.0 },
  { host: WALLET_HOST, query: "bitcoin private key recovery", clicks: 0, impressions: 25, position: 41.5 },
  // Past RANK_MAX_POSITION: real, but a content project rather than a task, so
  // neither badged nor counted.
  { host: WALLET_HOST, query: "lost seed phrase", clicks: 0, impressions: 30, position: 62.0 },
  { host: WALLET_HOST, query: "wallet recovery", clicks: 0, impressions: 90, position: 9.2 },
  // forum.objectivismonline.com — five snippet gaps that all outrank the query
  // the old mechanical predicate led with.
  { host: FORUM_HOST, query: "incest forum", clicks: 1, impressions: 61, position: 12.8 },
  { host: FORUM_HOST, query: "objectivism forum", clicks: 0, impressions: 120, position: 6.4 },
  { host: FORUM_HOST, query: "ayn rand forum", clicks: 1, impressions: 200, position: 8.1 },
  { host: FORUM_HOST, query: "objectivism online", clicks: 2, impressions: 150, position: 4.5 },
  { host: FORUM_HOST, query: "is altruism evil", clicks: 0, impressions: 45, position: 11.0 },
  { host: FORUM_HOST, query: "rand quotes", clicks: 0, impressions: 30, position: 13.5 },
  // cheatsheets — one page already performing at its position, one that is not.
  { host: SHEETS_HOST, query: "frontier ai labs list", clicks: 2, impressions: 6, position: 2.5 },
  { host: SHEETS_HOST, query: "regex cheatsheet", clicks: 0, impressions: 80, position: 7.7 },
].map((row) => ({ ...row, date: KEYWORD_DATE, gsc_window: "2026-08-05–2026-08-07" }));

// daily_search_summary stores one row per snapshot per host and always has. The
// rows are a ROLLING window keyed by snapshot date — each covers date-4..date-2,
// so consecutive rows overlap by two days out of three — which is why only
// trailing means are taken from them and why gsc_window, not date, is what a
// human reads. Latest day: 9 clicks over 2,250 impressions, i.e. the live 0.4%.
const GSC_WINDOW = {
  "2026-08-05": "2026-08-01–2026-08-03", "2026-08-06": "2026-08-02–2026-08-04",
  "2026-08-07": "2026-08-03–2026-08-05", "2026-08-08": "2026-08-04–2026-08-06",
  "2026-08-09": "2026-08-05–2026-08-07",
};
const SEARCH_SUMMARIES = [
  ["2026-08-05", WALLET_HOST, 2, 400, 25.0], ["2026-08-05", FORUM_HOST, 8, 1400, 15.9], ["2026-08-05", SHEETS_HOST, 3, 300, 9.9],
  ["2026-08-06", WALLET_HOST, 1, 410, 24.6], ["2026-08-06", FORUM_HOST, 7, 1450, 15.7], ["2026-08-06", SHEETS_HOST, 2, 310, 9.8],
  ["2026-08-07", WALLET_HOST, 2, 415, 24.4], ["2026-08-07", FORUM_HOST, 5, 1470, 15.5], ["2026-08-07", SHEETS_HOST, 3, 320, 9.6],
  ["2026-08-08", WALLET_HOST, 1, 418, 24.2], ["2026-08-08", FORUM_HOST, 6, 1490, 15.4], ["2026-08-08", SHEETS_HOST, 2, 325, 9.5],
  ["2026-08-09", WALLET_HOST, 1, 420, 24.1], ["2026-08-09", FORUM_HOST, 6, 1500, 15.3], ["2026-08-09", SHEETS_HOST, 2, 330, 9.4],
].map(([date, host, clicks, impressions, position]) => ({
  date, host, clicks, impressions, ctr: clicks / impressions, position, gsc_window: GSC_WINDOW[date],
}));

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
  // 2026-08-08 is a HISTORICAL day, written before kind "internal" existed: the
  // alias-host sessions it carried were dropped rather than stored, and no
  // backfill can recover them because the kind is frozen into the row at write
  // time. 2026-08-09 is written after the change and carries the internal row.
  // 40 sessions with 38 referrer rows also leaves a 2-session residual, which is
  // what the top-50-per-host-day truncation looks like in real data.
  { date: "2026-08-08", host: SMALL_HOST, referrer: "(direct)", kind: "direct", visits: 15 },
  { date: "2026-08-08", host: SMALL_HOST, referrer: "www.google.com", kind: "search", visits: 12 },
  { date: "2026-08-09", host: SMALL_HOST, referrer: "(direct)", kind: "direct", visits: 18 },
  { date: "2026-08-09", host: SMALL_HOST, referrer: "www.google.com", kind: "search", visits: 12 },
  { date: "2026-08-09", host: SMALL_HOST, referrer: "www.davidveksler.com", kind: "internal", visits: 6 },
  // An AI-answer-engine referrer: folded into "referral" for every aggregate
  // (sourceMix, totals) but carries its own "ai" kind on the row itself, which
  // is all this per-row badge is — see the AI_ANSWER_ENGINES note in config.js.
  { date: "2026-08-09", host: SMALL_HOST, referrer: "chatgpt.com", kind: "ai", visits: 2 },
];
const nonDirect = (date) =>
  referrers.find((r) => r.host === HOST && r.date === date && r.kind === "search").visits;
// The DAYS fixture gives HOST 12 clean days at a fixed direct/referred ratio of
// 1.5, so it clears RATIO_MIN_CLEAN_DAYS and the real 2026-08-08/09 flood days
// get a ratio estimate rather than the older floor-only split — computed here
// from the same bots.js functions loadDashboard calls, not hand-derived, so a
// change to the estimator's arithmetic fails this file instead of silently
// going stale.
const hostClassified = classifyTraffic(traffic, referrers);
const hostRatioStats = directRatioStats(hostClassified, HOST);
const estimatedHuman = (date) => splitDay(hostClassified.get(HOST).get(date), hostRatioStats).human;

// A deliberately deep tail of stored queries, appended to the keyword rows only
// inside the block that exercises the raised KEYWORD_ROW_LIMIT. Empty otherwise,
// so every other assertion in this file keeps describing the 15-row fixture.
let keywordTail = [];

// Minimal D1 stub: routes on the table named in the SQL and applies the date
// filter from the bound parameters. Enough for loadDashboard's read path.
// The two date shapes are not interchangeable, and which one a table gets is a
// decision this file checks rather than tolerates — see readWidths below.
const between = (rows, [a, b]) => rows.filter((r) => r.date >= a && r.date <= b);
const onDate = (rows, [d]) => rows.filter((r) => r.date === d);
// Every SELECT the read path issues, as { table, binds }, so the read WIDTH can
// be asserted rather than inferred from the results.
let readWidths = [];
const tableOf = (sql) => (sql.match(/FROM\s+(\w+)/i) ?? [])[1] ?? null;
const db = {
  prepare(sql) {
    let binds = [];
    const run = () => {
      if (sql.includes("MAX(date)")) return { d: DAYS.at(-1).date };
      if (sql.includes("FROM runs")) return { run_at: "2026-08-09T13:00:57Z", ok: 1, note: "ok" };
      if (sql.includes("daily_traffic")) return { results: between(traffic, binds) };
      if (sql.includes("daily_referrers")) return { results: between(referrers, binds) };
      // The three GSC reads are NOT the same width, and that asymmetry is load
      // bearing. `daily_search_summary` spans the history window because the
      // comparator's trailing means have no other source. `daily_keywords` and
      // `daily_pages` are latest-day only: spec item 8 widened them too, but
      // every consumer filters back down to `date`, and at KEYWORD_ROW_LIMIT (500)
      // rows a site the wasted read would be up to 180,000 rows per page load.
      // The stub applies whichever filter the SQL actually asks for, so a read
      // that widens again shows up as a changed row count rather than passing.
      if (sql.includes("daily_keywords")) return { results: onDate([...KEYWORDS, ...keywordTail], binds) };
      if (sql.includes("daily_search_summary")) return { results: between(SEARCH_SUMMARIES, binds) };
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
    const record = () => {
      readWidths.push({ table: tableOf(sql), binds: [...binds] });
      return run();
    };
    const stmt = {
      bind: (...args) => { binds = args; return stmt; },
      all: async () => record(),
      first: async () => record(),
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
//    case that rendered an empty card. HOST's 12 clean prior days clear
//    RATIO_MIN_CLEAN_DAYS, so the direct bucket gets a ratio estimate instead
//    of the older floor-only split (see hostRatioStats above).
{
  const { data, site } = await load(`domain=${HOST}&period=1`);
  const recovered = nonDirect("2026-08-09");           // referred sessions, measured
  const estimated = estimatedHuman("2026-08-09");       // referred + estimated direct
  check("flooded-only day reports the ratio-estimated total", site.visits, estimated);
  check("...flagged as an estimate, not a bare floor", site.estimatedVisits, true);
  check("...marked as a partial day", site.partialVisits, estimated);
  check("...over the one flooded day", site.partialDays, 1);
  check("...with no clean day claimed", site.cleanDays, 0);
  check("...crediting the crawler with what the estimate leaves over",
    site.botVisits, 1689 - estimated);
  check("...and keeps the referrers that survived", site.referrers.length, 1);
  check("...at the measured (not estimated) referred volume", site.referrers[0]?.visits, recovered);
  check("...counted as search traffic", site.sources.search, recovered);
  // The estimated direct portion has no referrer row to sit in, so it is
  // credited straight into the direct bucket rather than ballooning
  // "unattributed" into the largest slice of the mix.
  check("...and the estimated direct portion lands in the direct bucket, not unattributed",
    site.sources.direct, estimated - recovered);
  check("...without inventing pageviews", site.views, 0);
  check("...or a pages/session rate", site.pagesPerSession, 0);
  // Previous day was flooded too, so an estimate would be compared against one.
  check("...and suppresses the delta across partial days", site.delta, null);
  check("previous period is estimated the same way", site.previousVisits, estimatedHuman("2026-08-08"));
  check("totals follow the site", data.totals.visits, estimated);
  check("totals report the estimated volume", data.totals.partialVisits, estimated);
}

// 2. A window that mixes clean and flooded days: clean days count whole, flooded
//    days contribute their ratio-estimated total, and pageviews stay clean-only
//    (a flooded day's views carry no referer dimension at all, so they cannot
//    be estimated the same way and stay a hard exclusion).
{
  const { site } = await load(`domain=${HOST}&period=7`);
  const window = DAYS.slice(-7);
  const clean = window.filter((day) => day.date < "2026-08-08");
  const cleanVisits = clean.reduce((sum, day) => sum + day.visits, 0);
  const cleanViews = clean.reduce((sum, day) => sum + Math.round(day.visits * day.pps), 0);
  const estimated = estimatedHuman("2026-08-08") + estimatedHuman("2026-08-09");
  check("clean days count whole", site.cleanDays, clean.length);
  check("mixed window sums clean plus the ratio estimate", site.visits, cleanVisits + estimated);
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
    estimatedHuman("2026-08-09") + WIKI_DAYS.at(-1).visits + SMALL_DAYS.at(-1).visits);
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

// 4b. Domain grouping. Cards are laid out domain-first: one contiguous run per
//     registrable domain, runs ranked by the domain's own total, hosts ranked by
//     theirs inside it. Contiguity is the part worth asserting — a card that
//     drifts out of its domain's run turns the heading above it into a lie about
//     what the block contains.
{
  const { data } = await load("period=1");
  const runs = (sites) => {
    const out = [];
    for (const site of sites) {
      if (out.at(-1)?.domain === site.domain) out.at(-1).sites.push(site);
      else out.push({ domain: site.domain, sites: [site] });
    }
    return out;
  };
  const rum = data.sites.filter((s) => !s.zoneSourced);
  const rumRuns = runs(rum);

  check("every host carries its registrable domain",
    data.sites.find((s) => s.host === WIKI_HOST).domain, "freecapitalists.org");
  check("...a two-label host included",
    data.sites.find((s) => s.host === SMALL_HOST).domain, "davidveksler.com");
  check("each domain forms exactly one contiguous run of cards",
    rumRuns.length, new Set(rum.map((s) => s.domain)).size);
  check("...so a subdomain sits next to its own apex",
    rumRuns.find((r) => r.domain === "freecapitalists.org").sites.some((s) => s.host === WIKI_HOST), true);
  const total = (run) => run.sites.reduce((sum, s) => sum + s.visits, 0);
  check("domain runs are ordered by the domain's own total, descending",
    rumRuns.every((run, i) => i === 0 || total(rumRuns[i - 1]) >= total(run)), true);
  check("...and hosts by theirs inside each run",
    rumRuns.every((run) => run.sites.every((s, i) => i === 0 || run.sites[i - 1].visits >= s.visits)), true);
  check("the busiest domain leads", rumRuns[0].domain, "freecapitalists.org");
  // Zone hosts are grouped the same way but ranked in their own class: a domain
  // that owns a host in each section gets a run in each, never one ranking that
  // adds 19,506 HTTP requests to a session count.
  const zoneRuns = runs(data.sites.filter((s) => s.zoneSourced));
  check("zone hosts group by domain in their own section", zoneRuns[0].domain, "freecapitalists.org");
  check("...without merging into the RUM run for the same domain",
    rumRuns.some((r) => r.sites.some((s) => s.host === ZONE_HOST)), false);

  const { data: byName } = await load("period=1&sort=name");
  const nameRuns = runs(byName.sites.filter((s) => !s.zoneSourced));
  check("sort=name orders the domain runs alphabetically",
    nameRuns.map((r) => r.domain).join(","), [...nameRuns.map((r) => r.domain)].sort().join(","));
  check("...and the hosts inside each run",
    nameRuns.every((run) => run.sites.every((s, i) => i === 0 || run.sites[i - 1].host.localeCompare(s.host) <= 0)), true);
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

// `node scripts/dashboard-check.mjs --opportunities` prints both ranked classes
// across every fixture site. The two lists are ranked by different metrics, so
// this is the fastest way to see what moving a threshold or the CTR curve does to
// each of them independently.
if (process.argv.includes("--opportunities")) {
  const { data } = await load("period=1");
  for (const kind of ["snippet", "rank"]) {
    const rows = data.sites.flatMap((site) =>
      site.opportunities[kind].map((row) => ({ host: site.host, ...row })));
    rows.sort((a, b) => b.score - a.score);
    console.log(`\n${kind.toUpperCase()} — ranked by ${kind === "snippet" ? "lost clicks" : `potential clicks at position ${TARGET_POSITION}`} (${rows.length} total)`);
    for (const row of rows.slice(0, 5)) {
      console.log(`  ${row.score.toFixed(2)}  ${row.query} — ${row.host}, ` +
        `${row.impressions} imp, ${row.clicks} clk, pos ${row.position.toFixed(1)}, ` +
        `${(row.ctr * 100).toFixed(1)}% CTR vs ~${(row.expectedCtr * 100).toFixed(1)}% expected there`);
    }
  }
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

// 9. Traffic sources (spec item 6). "Other / unlisted" was 1,060 of 2,012
//    sessions — a channel panel whose largest bucket was an accounting hole.
//    Item 1 removed the zone host from it; what is checked here is that the
//    residual is small, is named for what it is, and that internal navigation is
//    recovered as a real channel instead of falling into it.
{
  const { data } = await load("period=1");
  const mix = data.totals.sourceMix;
  const small = data.sites.find((s) => s.host === SMALL_HOST);

  check("the residual is named for what it is, not passed off as a channel",
    "unattributed" in mix && !("other" in mix), true);
  check("...and is a rounding error rather than the largest bucket",
    mix.unattributed / data.totals.visits < .05, true);
  check("...at exactly the sessions no referrer row covers", mix.unattributed, 2);
  check("self-referrals are recovered as their own channel", mix.internal, 6);
  check("...on the site they arrived at", small.sources.internal, 6);
  check("...and are no longer counted as unattributed", small.sources.unattributed, 2);
  check("every channel plus the residual accounts for every RUM session",
    mix.direct + mix.search + mix.social + mix.referral + mix.internal + mix.unattributed,
    data.totals.visits);
  check("the mix stays RUM-only", mix.direct + mix.search + mix.social + mix.referral + mix.internal
    <= data.totals.visits, true);
  check("the internal channel is flagged as measured when a row carries it",
    data.totals.internalMeasured, true);
  // An AI-answer-engine referrer (kind "ai") is a per-row badge, not a mix
  // channel: see the AI_ANSWER_ENGINES note in config.js for why it's folded
  // into "referral" here rather than counted separately or left unattributed.
  check("an ai-kind referrer is folded into referral, not given its own mix key",
    mix.referral, 2);
}

// 9b. The historical case, and the reason item 6 needs one. `kind` is frozen into
//     daily_referrers by classifyReferrer at WRITE time, so no row stored before
//     the change can ever carry "internal" and no backfill can add it. A window
//     with no such row must report the channel as absent — a rendered 0% would
//     assert a measurement nobody took. Checked over 7 and 30 days, not just 24h,
//     because those are the windows that still reach back over old rows.
for (const period of [7, 30]) {
  const { data } = await load(`domain=${HOST}&period=${period}`);
  check(`a ${period}-day window of pre-change rows reports internal as absent`,
    data.totals.internalMeasured, false);
  check(`...rather than as a measured zero (${period}d)`, data.totals.sourceMix.internal, 0);
  check(`...while still attributing everything it did measure (${period}d)`,
    data.totals.sourceMix.unattributed, 0);
  // ...and the site itself still renders its real traffic over that window.
  const site = data.sites.find((s) => s.host === HOST);
  check(`...with the historical days intact (${period}d)`, site.visits > 0, true);
}
{
  // The same 30-day window across every site DOES contain a post-change row, so
  // the channel is measured there. The flag is about the window, not the period.
  const { data } = await load("period=30");
  check("a mixed window with one post-change row measures the channel",
    data.totals.internalMeasured, true);
  check("...counting only what was actually stored", data.totals.sourceMix.internal, 6);
}

// 10. The snippet/rank split (spec item 7). One label used to cover two opposite
//     problems with nothing in common but the word "opportunity", and ranking both
//     by lost clicks guaranteed that a deep, valuable query lost to a shallow one.
{
  const { data } = await load("period=1");
  const wallet = data.sites.find((s) => s.host === WALLET_HOST);
  const forum = data.sites.find((s) => s.host === FORUM_HOST);
  const sheets = data.sites.find((s) => s.host === SHEETS_HOST);
  const named = (rows) => rows.map((row) => row.query);

  // The query that motivated the item. 13 impressions at position 31.2 fails both
  // of the spec's original gates (>= 20 impressions, position 16-30) and would
  // still have been invisible.
  const bitcoin = wallet.opportunities.rank.find((row) => row.query === "bitcoin recovery");
  check("`bitcoin recovery` surfaces at all", Boolean(bitcoin), true);
  check("...as a ranking problem, not a snippet one", bitcoin?.kind, "rank");
  check("...scored by what it would earn at the target position",
    bitcoin?.potentialClicks.toFixed(2), (13 * expectedCtr(TARGET_POSITION)).toFixed(2));
  check("...which is a different metric from lost clicks", bitcoin?.lostClicks, null);
  check("...and it is not in the snippet class",
    wallet.opportunities.snippet.some((row) => row.query === "bitcoin recovery"), false);

  // The reason the two classes cannot share one metric. Lost clicks measures what
  // is recoverable AT THE CURRENT RANK, and at position 31 that is nothing by
  // construction: every ranking-class query here scores under the actionable
  // floor on it, so a single lost-clicks gate would not have demoted them, it
  // would have deleted the whole class.
  check("no ranking-class query clears the actionable floor on lost clicks",
    wallet.opportunities.rank.every((row) =>
      row.impressions * (expectedCtr(row.position) - row.ctr) < MIN_ACTIONABLE_CLICKS), true);
  check("...including the one this item exists for",
    (13 * expectedCtr(31.2)) < MIN_ACTIONABLE_CLICKS, true);
  check("...while it clears the floor comfortably on its own metric",
    bitcoin?.potentialClicks > MIN_ACTIONABLE_CLICKS, true);

  check("rank opportunities are sorted by potential clicks, descending",
    wallet.opportunities.rank.every((row, i) =>
      i === 0 || wallet.opportunities.rank[i - 1].potentialClicks >= row.potentialClicks), true);
  check("...five of them on this site", wallet.opportunities.rank.length, 5);
  check("...and a query past RANK_MAX_POSITION is neither badged nor counted",
    named([...wallet.opportunities.rank, ...wallet.opportunities.snippet]).includes("lost seed phrase"), false);

  // The query the old mechanical predicate led with. It is not merely demoted:
  // at 1.6% CTR against roughly 1.9% expected at position 12.8, it is performing
  // close enough to its rank that no rewrite would recover anything.
  check("`incest forum` is not classified as an opportunity at all",
    classifyOpportunity({ query: "incest forum", clicks: 1, impressions: 61, position: 12.8 }), null);
  check("...so it cannot be in the top five by its class metric",
    named(forum.opportunities.snippet.slice(0, 5)).includes("incest forum"), false);
  check("...while five real snippet gaps on that site are",
    forum.opportunities.snippet.length, 5);
  check("...led by the biggest recoverable loss",
    forum.opportunities.snippet[0].query, "objectivism online");
  check("snippet opportunities are sorted by lost clicks, descending",
    forum.opportunities.snippet.every((row, i) =>
      i === 0 || forum.opportunities.snippet[i - 1].lostClicks >= row.lostClicks), true);

  // Already performing at its position: 33% CTR at position 2.5 beats the ~13%
  // the position would ordinarily deliver. Nothing to fix.
  check("a query beating its position's expected CTR is not flagged",
    classifyOpportunity({ query: "frontier ai labs list", clicks: 2, impressions: 6, position: 2.5 }), null);
  check("...and does not appear on its site's lists",
    named([...sheets.opportunities.snippet, ...sheets.opportunities.rank])
      .includes("frontier ai labs list"), false);
  check("...while the site's real snippet gap does", sheets.opportunities.snippet[0]?.query, "regex cheatsheet");

  check("the headline count is the two classes and nothing else",
    data.totals.opportunities, data.totals.snippetOpportunities + data.totals.rankOpportunities);
  check("...seven snippet gaps", data.totals.snippetOpportunities, 7);
  check("...and five ranking gaps", data.totals.rankOpportunities, 5);

  // queryDenyPatterns: built, documented, and shipped unset. Which queries a site
  // declines to pursue is an editorial call, so the mechanism exists and the
  // config does not use it.
  check("queryDenyPatterns is wired through to every site", Array.isArray(wallet.queryDenyPatterns), true);
  check("...and ships empty on every one of them",
    data.sites.every((s) => (s.queryDenyPatterns ?? []).length === 0), true);
  const denied = { query: "objectivism online", clicks: 2, impressions: 150, position: 4.5 };
  check("a denied query is excluded from the classes",
    classifyOpportunity(denied, { queryDenyPatterns: ["^objectivism online$"] }), null);
  check("...and only that query", Boolean(classifyOpportunity(denied, { queryDenyPatterns: ["^nothing$"] })), true);
}

// 11. Comparators on every metric (spec item 8). A number that answers neither
//     "is this normal?" nor "what changed?" nor "what do I do?" is decoration.
{
  const { data } = await load("period=1");
  const totals = data.totals;
  const trend = totals.trend;

  check("the traffic comparator spans 14 daily snapshots", trend.days, 14);
  // HOST's flood days fall inside this 14-day window and now carry a ratio
  // estimate (see hostRatioStats above) rather than the older floor, which is
  // why this mean is higher than the pre-estimator figure.
  check("...averaging human sessions the same way the cards do",
    trend.visitsPerDay.toFixed(1), "45.7");
  check("...pageviews from clean days only", trend.viewsPerDay.toFixed(1), "49.9");
  check("...and search sessions off the same referrer history", trend.searchPerDay.toFixed(1), "15.0");

  // GSC rows are keyed by snapshot date and each covers a three-day window
  // lagging two days, so consecutive rows overlap: the field is named per
  // SNAPSHOT, and the ends of the range are named from gsc_window rather than
  // from the snapshot dates a human would misread as the measurement period.
  check("the GSC comparator counts snapshots, not days", trend.gscSnapshots, 5);
  check("...averaged over the rolling windows", trend.gscClicksPerSnapshot.toFixed(1), "10.2");
  check("...impressions alongside", Math.round(trend.gscImpressionsPerSnapshot), 2192);
  check("...with CTR aggregated rather than averaged", trend.gscCtr.toFixed(5), (51 / 10958).toFixed(5));
  check("...and the range labelled by what Google measured, not when we asked",
    trend.gscWindowFirst, "2026-08-01–2026-08-03");
  check("...through the latest window", trend.gscWindowLast, "2026-08-05–2026-08-07");
  check("no GSC field is exposed as a per-day rate",
    Object.keys(trend).some((key) => /^gsc.*PerDay$/.test(key)), false);

  // The live 0.4%, and the number that says whether 0.4% is bad.
  //
  // BOTH SIDES OF A COMPARATOR COME FROM THE SAME ROW SET. This is the second
  // population mismatch this file has had to catch (item 4's error baseline
  // counted unmeasured days as zero-error days), so it is asserted rather than
  // reasoned about. The fixture is built so the two populations disagree on
  // purpose: `daily_search_summary` says 9 clicks over 2,250 impressions (0.40%)
  // for the whole corpus, while the stored top-query rows say 7 clicks over 954
  // impressions (0.73%). Every wrong pairing therefore produces a different
  // number, and the checks below pin the right one.
  check("search CTR is the live shape", totals.gscCtr.toFixed(3), "0.004");
  const mixImpressions = KEYWORDS.reduce((sum, row) => sum + row.impressions, 0);
  const mixClicks = KEYWORDS.reduce((sum, row) => sum + row.clicks, 0);
  const mixExpected = KEYWORDS.reduce((sum, row) =>
    sum + row.impressions * expectedCtr(row.position), 0) / mixImpressions;
  check("the fixture's two populations disagree on CTR, so a mismatch cannot pass",
    (mixClicks / mixImpressions).toFixed(4) !== totals.gscCtr.toFixed(4), true);
  check("...the comparator's ACTUAL side is the stored rows",
    totals.gscSampleCtr.toFixed(5), (mixClicks / mixImpressions).toFixed(5));
  check("...the comparator's EXPECTED side is the same stored rows",
    totals.gscExpectedCtr.toFixed(5), mixExpected.toFixed(5));
  check("...so the two sides share one denominator", totals.gscSampleImpressions, mixImpressions);
  check("...and one click count", totals.gscSampleClicks, mixClicks);
  check("...over one query count", totals.gscSampleQueries, KEYWORDS.length);
  // The three ways this has gone wrong, each of which the fixture makes visible.
  check("the comparator is NOT the corpus actual against a top-query expectation",
    totals.gscSampleCtr.toFixed(5) === totals.gscCtr.toFixed(5), false);
  check("...NOT the corpus clicks over the sample's impressions",
    totals.gscSampleCtr.toFixed(5) === (totals.gscClicks / mixImpressions).toFixed(5), false);
  check("...and NOT the sample's clicks over the corpus impressions",
    totals.gscSampleCtr.toFixed(5) === (mixClicks / totals.gscImpressions).toFixed(5), false);
  // Coverage, so a comparator drawn from a sliver of the corpus can be discounted.
  check("the sample reports what share of impressions it covers",
    totals.gscSampleShare.toFixed(4), (mixImpressions / totals.gscImpressions).toFixed(4));
  check("...and the headline stays the whole corpus", totals.gscImpressions > mixImpressions, true);
  check("the stored top queries still underperform their own position mix",
    totals.gscExpectedCtr > totals.gscSampleCtr, true);

  // Median, not mean. The 62.0-position stray is exactly what a mean is dragged
  // around by and a median is not.
  check("search position is a median across queries with enough impressions",
    totals.gscMedianPosition.toFixed(1), "12.8");
  check("...over the queries that clear the impression floor", totals.gscPositionQueries, 13);
  check("...and says how many are on page one", totals.gscTop10Queries, 5);
  check("the impression-weighted mean it replaced is dragged higher by one stray",
    totals.gscPosition > totals.gscMedianPosition, true);

  // The widened GSC reads are read-side only: the panels are still the latest
  // snapshot, and the trailing rows exist for the trend.
  const forum = data.sites.find((s) => s.host === FORUM_HOST);
  check("panels still show the latest snapshot only", forum.keywords.length,
    KEYWORDS.filter((row) => row.host === FORUM_HOST).length);
  check("...and the summary is the latest row, not a sum of the window",
    forum.searchSummary.impressions, 1500);
}

// 12. The two opportunity signals that replaced the generic placeholder. Their
//     remedies differ, so they cannot be one rule: telling someone to rewrite a
//     title is wrong for a page nobody can see.
{
  const { data } = await load("period=1");
  const of = (host) => (data.signals ?? []).filter((s) => s.host === host);
  const kinds = (host) => of(host).map((s) => s.kind).sort().join(",");

  check("the generic search-opportunity rule is gone",
    (data.signals ?? []).some((s) => s.kind === "search-opportunity"), false);
  check("a site with both classes gets both signals", kinds(WALLET_HOST), "rank-gap,snippet-gap");
  check("a site with only snippet gaps gets only that one", kinds(FORUM_HOST), "snippet-gap");
  const snippet = of(FORUM_HOST)[0];
  check("...at severity 2", snippet.severity, 2);
  check("...with the remedy that fits the class",
    snippet.action.includes("Rewrite the title and meta description"), true);
  check("...naming the query that leads it", snippet.evidence.includes("objectivism online"), true);
  const rank = of(WALLET_HOST).find((s) => s.kind === "rank-gap");
  check("the ranking signal prescribes ranking work, not a rewrite",
    rank.action.includes("Strengthen those pages"), true);
  check("...and never tells the reader to rewrite a snippet nobody sees",
    /rewrite/i.test(rank.action), false);
}

// 13. Read width. The three GSC tables are read at two different widths on
//     purpose, and the reason is cost: `daily_search_summary` has to span the
//     history window because the comparator's trailing means come from nowhere
//     else, while `daily_keywords` and `daily_pages` are latest-day only because
//     every consumer filters back down to `date` anyway. Item 8 widened all three
//     and flagged the waste; at KEYWORD_ROW_LIMIT rows a site it stops being
//     theoretical — 30 days x 12 sites x 500 is up to 180,000 rows a page load.
{
  readWidths = [];
  const { data } = await load("period=30");
  const width = (table) => readWidths.filter((r) => r.table === table).map((r) => r.binds.length);

  check("daily_keywords is read for one date, not a range", width("daily_keywords").join(","), "1");
  check("...that date being the latest snapshot",
    readWidths.find((r) => r.table === "daily_keywords").binds[0], data.date);
  check("daily_pages is read the same way", width("daily_pages").join(","), "1");
  check("daily_search_summary keeps the history window it needs for the trend",
    width("daily_search_summary").join(","), "2");
  // The narrowing must not have cost the trend anything.
  check("...and the trend still has its snapshots", data.totals.trend.gscSnapshots > 1, true);
  readWidths = [];
}

// 14. The raised stored-keyword cap (KEYWORD_ROW_LIMIT). At 25 rows a site the
//     estate stored 119 queries covering 1.1% of impressions and the CTR
//     comparator labelled itself a thin sample, correctly and uselessly. Raising
//     the cap changes what several other numbers are computed over, so the deep
//     tail is fixtured here rather than reasoned about:
//
//       - the median-position tile now sees a long tail of deep-ranked queries,
//         which is exactly what POSITION_MIN_IMPRESSIONS exists to filter;
//       - the opportunity classes now see hundreds more candidates, which is what
//         MIN_ACTIONABLE_CLICKS and RANK_MAX_POSITION exist to filter.
//
//     Both floors are asserted at the new volume. The tail is sized to sit just
//     under the cap for one host, so the fixture describes a site that would
//     actually be truncated by it.
{
  const TAIL_HOST = FORUM_HOST;
  const forumRows = KEYWORDS.filter((row) => row.host === TAIL_HOST).length;
  // 440 one-impression queries: real, and below every floor on the page.
  const noise = Array.from({ length: 440 }, (_, i) => ({
    host: TAIL_HOST, query: `tail noise ${i}`, clicks: 0, impressions: 1,
    position: 30 + (i % 66),
  }));
  // 45 queries that DO clear the impression floor and are ranked far too deep to
  // act on. These move the median, and that is the honest answer rather than a
  // regression: the tile now describes the estate instead of its 25 best queries.
  const deep = Array.from({ length: 45 }, (_, i) => ({
    host: TAIL_HOST, query: `deep tail ${i}`, clicks: 0, impressions: 12,
    position: 70 + (i % 21),
  }));
  keywordTail = [...noise, ...deep].map((row) => ({ ...row, date: KEYWORD_DATE,
    gsc_window: "2026-08-05–2026-08-07" }));

  check("the fixture host sits just under the stored-keyword cap",
    forumRows + keywordTail.length <= KEYWORD_ROW_LIMIT, true);
  check("...and would have been truncated by the old one", forumRows + keywordTail.length > 25, true);

  try {
    const { data } = await load("period=1");
    const totals = data.totals;
    const forum = data.sites.find((s) => s.host === TAIL_HOST);
    const stored = [...KEYWORDS, ...keywordTail];

    // Coverage is the whole point of the change.
    check("every stored row reaches the comparator's sample", totals.gscSampleQueries, stored.length);
    check("...raising the sample's impression coverage above a sliver",
      totals.gscSampleShare > .5, true);
    check("...without the sample ever exceeding the corpus it is a sample of",
      totals.gscSampleImpressions <= totals.gscImpressions, true);

    // The impression floor at the new volume. 440 one-impression queries do not
    // reach the median; the 45 twelve-impression ones do, because they are a real
    // measurement of a real ranking.
    const eligible = stored.filter((row) => row.impressions >= POSITION_MIN_IMPRESSIONS);
    const sorted = eligible.map((row) => row.position).sort((a, b) => a - b);
    const expectedMedian = sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    check("the impression floor keeps 1-impression tail queries out of the median",
      totals.gscPositionQueries, eligible.length);
    check("...admitting only the tail rows that clear it", eligible.length, 13 + deep.length);
    check("...and the median is the median of exactly those", totals.gscMedianPosition, expectedMedian);
    check("...which the deep tail moves, honestly, rather than leaving flattered",
      totals.gscMedianPosition > 12.8, true);
    check("...while the top-10 count is unchanged by any of it", totals.gscTop10Queries, 5);

    // The opportunity floors at the new volume. 485 extra candidate queries admit
    // exactly none: 440 fail OPPORTUNITY_MIN_IMPRESSIONS, 45 are past
    // RANK_MAX_POSITION. A list that grew by hundreds of near-zero items would be
    // unusable, which is what these two constants are for.
    check("hundreds of new candidates admit no new opportunities",
      totals.opportunities, totals.snippetOpportunities + totals.rankOpportunities);
    check("...still seven snippet gaps", totals.snippetOpportunities, 7);
    check("...and five ranking gaps", totals.rankOpportunities, 5);
    check("...none of them from the tail",
      [...forum.opportunities.snippet, ...forum.opportunities.rank]
        .some((row) => /^(tail noise|deep tail)/.test(row.query)), false);
    check("the one-impression tail is below the CTR floor by construction",
      noise[0].impressions < OPPORTUNITY_MIN_IMPRESSIONS, true);
    check("...and the deep tail is past the ranking horizon",
      deep.every((row) => row.position > RANK_MAX_POSITION), true);

    // The card list stays a list a person can read.
    check("the card still shows at most twelve queries", forum.keywords.length, 12);
  } finally {
    keywordTail = [];
  }
}

// 15. The baseline window itself can be entirely flood, not just the 25th-
//     percentile fallback within it. This is the real forum.objectivismonline.com
//     incident (2026-08-24): a flood that started 2026-07-30 against a true
//     ~618/day baseline was still running 26 days later, so a 30-day read never
//     contained enough (or any) clean days — every fallback computed inside that
//     window was itself built from flood, and the flood read as "human sessions"
//     from 2026-08-19 on. BASELINE_LOOKBACK_DAYS widens only the two reads that
//     feed classifyTraffic, independent of the 30-day floor every other read
//     keeps; this section proves that widening is actually wired in, not just
//     that classifyTraffic behaves correctly when handed a wide window (bots-
//     check.mjs already covers that).
//
//     FORUM_HOST gets its own traffic/referrer rows here — nowhere else in this
//     file gives it any, so this cannot perturb the opportunity-classifier
//     checks above that use the same host for keywords/search-summary fixtures.
{
  const FLOOD_TODAY = "2026-08-09"; // matches DAYS.at(-1).date, i.e. MAX(date)
  // 21 genuinely clean days, entirely outside the 30-day floor (`date - 29` =
  // 2026-07-11): real browsing shape, well under FLOOD_MIN_VISITS.
  const cleanDays = Array.from({ length: 21 }, (_, i) => ({
    date: dayAfter("2026-06-20", i), visits: 700 + (i % 3) * 40,
  }));
  // 30 flood days filling the entire 30-day floor, including today: matches the
  // flood signature (>=90% direct, <=FLAT_PAGES_PER_SESSION pages/session) throughout, so the
  // narrow window has zero clean days to build a baseline from.
  const floodDays = Array.from({ length: 30 }, (_, i) => ({
    date: dayAfter("2026-07-11", i), visits: i === 29 ? 8000 : 20000,
  }));
  for (const day of [...cleanDays, ...floodDays]) {
    const direct = day.visits >= 5000 ? Math.round(day.visits * .98) : Math.round(day.visits * .7);
    const pps = day.visits >= 5000 ? 1.05 : 1.35;
    traffic.push({ date: day.date, host: FORUM_HOST, visits: day.visits, views: Math.round(day.visits * pps) });
    referrers.push({ date: day.date, host: FORUM_HOST, referrer: "(direct)", kind: "direct", visits: direct });
    referrers.push({ date: day.date, host: FORUM_HOST, referrer: "www.google.com", kind: "search", visits: day.visits - direct });
  }
  // Sanity on the fixture itself: with only the narrow 30-day window (no clean
  // days in range), the flood's own 25th percentile is 20000, so 8000 must NOT
  // clear FLOOD_MULTIPLE x that on its own — otherwise this test would pass for
  // the wrong reason.
  check("fixture check: today's volume is below 3x the flood's own 25th percentile",
    8000 < 3 * 20000, true);

  // FORUM_HOST's 21 genuinely clean days (a fixed .7 direct/.3 referred ratio)
  // clear RATIO_MIN_CLEAN_DAYS too, so today's direct bucket gets the same ratio
  // estimate treatment as HOST above rather than the floor-only split — computed
  // the same way, from the real bots.js functions over this block's own fixture.
  const forumClassified = classifyTraffic(traffic, referrers);
  const forumRatioStats = directRatioStats(forumClassified, FORUM_HOST);
  const forumEstimated = splitDay(forumClassified.get(FORUM_HOST).get(FLOOD_TODAY), forumRatioStats).human;

  readWidths = [];
  const { data } = await load(`domain=${FORUM_HOST}&period=1`);
  const site = data.sites.find((s) => s.host === FORUM_HOST);
  check("the classifier still finds today a bot flood despite 29 flood-shaped days in the 30-day window",
    site.botVisits > 0, true);
  check("...specifically the crawler volume computed against the true, older baseline",
    site.botVisits, 8000 - forumEstimated);
  check("...leaving the ratio-estimated total as human",
    site.visits, forumEstimated);
  check("...marked partial, not a clean day",
    site.partialDays, 1);
  check("the daily_traffic read for the classifier reaches back past the 30-day floor",
    readWidths.some((r) => r.table === "daily_traffic" && r.binds[0] <= "2026-03-01"), true);
  readWidths = [];
}

if (failures) {
  console.error(`\n${failures} dashboard aggregation check(s) failed`);
  process.exit(1);
}
console.log("Dashboard aggregation checks passed");
