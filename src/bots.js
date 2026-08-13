// Separating crawler floods from human traffic.
//
// We deliberately do NOT block crawlers (the sites opt into AI training via
// Content-Signal). The problem is purely one of measurement: a headless-Chrome
// crawler fires the RUM beacon exactly like a person does, so Cloudflare counts
// it as a session and the dashboard's headline numbers become fiction.
//
// The signature comes from the Aug 2026 floods (forum.objectivismonline.com,
// wiki.freecapitalists.org, freecapitalists.org): every "session" was a single
// pageview with no referrer, sustained for days, spread across thousands of URLs.
// Any one of those traits alone is normal — a viral link is direct and spiky, a
// single-page site is flat — so we require all of them together plus volume.

export const FLOOD_MIN_VISITS = 500;   // below this, a "flood" is indistinguishable from noise
export const FLOOD_MULTIPLE = 3;       // ...and must be this many times a normal day
// Exported so the footer prose that explains these rules can interpolate them
// rather than restate them as literals that drift out of sync with the code.
export const FLAT_PAGES_PER_SESSION = 1.15;   // humans click through; crawlers hit one URL and leave
export const DIRECT_SHARE = 0.9;              // crawlers send no referer

const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : 0;

// Build per-host, per-day traffic shape and mark the crawler-flooded days.
//
// trafficRows:  { date, host, visits, views }     from daily_traffic
// referrerRows: { date, host, kind, visits }      from daily_referrers, grouped by kind
//
// Returns Map<host, Map<date, day>> where day carries { visits, views, direct,
// directShare, pagesPerSession, signature, baseline, flood }.
export function classifyTraffic(trafficRows, referrerRows) {
  const byHost = new Map();
  for (const row of trafficRows ?? []) {
    if (!byHost.has(row.host)) byHost.set(row.host, new Map());
    byHost.get(row.host).set(row.date, {
      date: row.date,
      visits: Number(row.visits || 0),
      views: Number(row.views || 0),
      direct: 0,
    });
  }
  for (const row of referrerRows ?? []) {
    if (row.kind !== "direct") continue;
    const day = byHost.get(row.host)?.get(row.date);
    if (day) day.direct += Number(row.visits || 0);
  }

  for (const days of byHost.values()) {
    const all = [...days.values()];
    for (const day of all) {
      day.nonDirect = Math.max(0, day.visits - day.direct);
      day.pagesPerSession = day.visits ? day.views / day.visits : 0;
      day.directShare = day.visits ? day.direct / day.visits : 0;
      // Shape only — deliberately volume-free, so the baseline below can be built
      // from the days that fail this test without reasoning in a circle.
      day.signature = day.visits > 0 &&
        day.pagesPerSession > 0 && day.pagesPerSession <= FLAT_PAGES_PER_SESSION &&
        day.directShare >= DIRECT_SHARE;
    }
    // Normal days set the bar for what "normal" means. When a flood runs long
    // enough that too few clean days remain, fall back to the 25th percentile of
    // everything: a median would by then be half-built from flood days and would
    // quietly bless the flood as the new baseline. That is exactly how the
    // forum.objectivismonline.com flood went unflagged for eight days.
    const cleanVisits = all.filter((day) => !day.signature).map((day) => day.visits).sort((a, b) => a - b);
    const allVisits = all.map((day) => day.visits).sort((a, b) => a - b);
    const baseline = cleanVisits.length >= 3 ? quantile(cleanVisits, .5) : quantile(allVisits, .25);
    for (const day of all) {
      day.baseline = baseline;
      day.flood = day.signature && day.visits >= FLOOD_MIN_VISITS &&
        day.visits >= Math.max(baseline, 1) * FLOOD_MULTIPLE;
    }
  }
  return byHost;
}

// Split one classified day into the part that is still creditable to people and
// the part that is crawler noise.
//
// A flooded day used to be discarded whole, which zeroed out an entire site card
// whenever the only day in view was flooded. But the flood test is largely a test
// for *direct* traffic (>=90% of sessions carry no referer, because that is how
// crawlers arrive), so the referred sessions on a flooded day are still a real,
// measured human signal — a referral from Google or Reddit is not something the
// crawler produces. Those sessions are reported as a floor ("at least N"), which
// is a measurement, not the interpolation the docs rightly warn against.
//
// What genuinely cannot be recovered is the direct bucket, where the crawler and
// real direct visitors are mixed beyond separation, and pageviews, which carry no
// referer dimension at all. Both are reported as crawler volume rather than split.
export function splitDay(day) {
  if (!day) return { human: 0, crawler: 0, views: 0, crawlerViews: 0, partial: false };
  if (!day.flood) {
    return { human: day.visits, crawler: 0, views: day.views, crawlerViews: 0, partial: false };
  }
  return { human: day.nonDirect, crawler: day.visits - day.nonDirect, views: 0,
    crawlerViews: day.views, partial: true };
}

// Human-readable explanation for a flooded day, for the card callout.
export function floodReason(day) {
  if (!day?.flood) return null;
  return `${Math.round(day.directShare * 100)}% direct, ${day.pagesPerSession.toFixed(1)} pages/session, ` +
    `${Math.round(day.visits / Math.max(day.baseline, 1))}x a normal day`;
}

// Dates (per host) that were crawler-flooded, for filtering referrer and
// landing-page rows so the detail panels agree with the headline numbers.
export function floodDates(classified, host) {
  const days = classified.get(host);
  if (!days) return new Set();
  return new Set([...days.values()].filter((day) => day.flood).map((day) => day.date));
}

// ---- Zone-sourced hosts: the same problem, a different instrument ---------
//
// Everything above runs on RUM sessions and cannot fire on a zone-sourced host
// at all. `classifyTraffic` derives `directShare` from daily_referrers rows, and
// the zone log carries no referer dimension, so a zone host writes none: direct
// is always 0, `signature` is always false, and no volume whatever can flag the
// day. Left there, every crawler fetch of /robots.txt would flow into the page
// as a human arrival by implication. `crawlerAccounting` is the routing that
// stops that, and the two summaries below are what a zone host gets instead of
// a flood verdict.
//
// Neither of them ever produces a human figure, and there is no field here from
// which one could be subtracted out. That is deliberate — see summarizeVerifiedBots.
export function crawlerAccounting(site) {
  return site?.measurement === "zone" || site?.zoneSourced ? "zone" : "flood";
}

// Cloudflare labels the empty verifiedBotCategory nothing at all; we name it, so
// that a bucket meaning "not verified" can never be read as a bucket meaning
// "human".
export const UNVERIFIED_CATEGORY = "(unverified)";

// Requests that are never a person reading something: crawler protocol files,
// browser-automatic asset fetches, and Cloudflare's own endpoints.
export const NON_CONTENT_PATTERNS = [
  /^\/robots\.txt$/i,
  /^\/favicon\.ico$/i,
  /^\/sitemap[^/]*$/i,
  /^\/\.well-known(\/|$)/i,
  /^\/cdn-cgi(\/|$)/i,
];

export const isNonContentPath = (path) =>
  NON_CONTENT_PATTERNS.some((re) => re.test(String(path || "")));

// Lens 1: verified crawlers, from the verifiedBotCategory dimension on
// httpRequestsAdaptiveGroups.
//
// This is a FLOOR on crawler volume and nothing else. Cloudflare only labels the
// bots it cryptographically verifies (reverse-DNS or HTTP message signatures);
// everything it did not verify comes back with an empty category, and that bucket
// is people and unverified or spoofing crawlers mixed together. On
// library.freecapitalists.org it is 84.6% of requests. The dimensions that would
// separate it — botScore, botScoreSrcName — are plan-gated on this zone (spike
// 2026-08-12: "zone ... does not have access to the field 'botscore'", code
// "authz"), and clientRequestUserAgent is not a dimension on this dataset at all.
//
// So: no `human` field, no `likelyHuman`, no remainder anyone can subtract into
// one. The unverified bucket is reported under its own name and left uncharacterized.
export function summarizeVerifiedBots(rows) {
  const categories = [];
  let verifiedRequests = 0, verifiedVisits = 0, unverifiedRequests = 0, unverifiedVisits = 0;
  for (const row of rows ?? []) {
    const requests = Number(row.requests || 0);
    const visits = Number(row.visits || 0);
    if (!row.category || row.category === UNVERIFIED_CATEGORY) {
      unverifiedRequests += requests;
      unverifiedVisits += visits;
      continue;
    }
    categories.push({ category: row.category, requests, visits });
    verifiedRequests += requests;
    verifiedVisits += visits;
  }
  categories.sort((a, b) => b.requests - a.requests);
  const totalRequests = verifiedRequests + unverifiedRequests;
  return {
    categories, verifiedRequests, verifiedVisits, unverifiedRequests, unverifiedVisits,
    totalRequests, totalVisits: verifiedVisits + unverifiedVisits,
    verifiedShare: totalRequests ? verifiedRequests / totalRequests : 0,
    // False before the first pull that wrote daily_zone_bots. The card renders
    // the other lens and says so, rather than printing a confident 0.
    measured: (rows?.length ?? 0) > 0,
  };
}

// Lens 2: non-content requests, derived from tables that already exist —
// daily_cf_pages for paths, daily_zone_status for response codes. No new query.
//
// The two components are returned separately and there is no combined total,
// because they overlap each other (a 404 on /favicon.ico is in both) and the
// (path, status) pair needed to measure that overlap is not stored anywhere.
// This lens also overlaps lens 1 — a verified crawler fetches robots.txt too —
// which is why the renderer is required to say the figures must not be added.
export function summarizeNonContent(pageRows, statusRows) {
  const paths = [];
  let pathRequests = 0;
  for (const row of pageRows ?? []) {
    if (!isNonContentPath(row.page)) continue;
    // Zone-sourced daily_cf_pages rows carry requests in `visits` (see the
    // insert in runDaily); the column names follow the RUM path, the meaning
    // does not.
    const requests = Number(row.visits || 0);
    paths.push({ page: row.page, requests });
    pathRequests += requests;
  }
  paths.sort((a, b) => b.requests - a.requests);

  const errorStatuses = [];
  let errorRequests = 0;
  for (const row of statusRows ?? []) {
    if (Number(row.status) < 400) continue;
    const requests = Number(row.requests || 0);
    errorStatuses.push({ status: Number(row.status), requests });
    errorRequests += requests;
  }
  errorStatuses.sort((a, b) => b.requests - a.requests);

  // Only the top 50 paths and top 8 statuses are persisted per day, so both
  // components are themselves floors over what was recorded.
  return { paths, pathRequests, errorStatuses, errorRequests };
}
