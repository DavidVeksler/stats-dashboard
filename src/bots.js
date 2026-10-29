// Keeping crawlers out of the RUM session counts.
//
// We deliberately do NOT block crawlers (the sites opt into AI training via
// Content-Signal). The problem is purely one of measurement: a headless-Chrome
// crawler fires the RUM beacon exactly like a person does, so Cloudflare counts
// it as a session. Cloudflare's own `bot` dimension on the RUM dataset is 0 for
// all of it (checked 2026-10-29: 165,575 of 165,575 wiki.freecapitalists.org
// sessions).
//
// THE RULES: a RUM session counts only when (1) its browser is CURRENT, meaning
// its major version is within BROWSER_LAG of the newest version real visitors of
// that browser family are using, and (2) it is not part of a direct-only desktop
// segment (isDirectOnlySegment, below), which is how a crawler sending a current
// version shows itself. Everything else is "automated" and is reported beside
// the count, never inside it.
//
// Why this and not the old flood classifier. The old rule judged whole
// site-days by shape (>=90% direct, flat pages/session) against a baseline of
// the host's own "normal" days. Every way that can fail, it did: a flood that
// lasts long enough becomes its own baseline (wiki.freecapitalists.org stored
// 165,832 "human sessions" on 2026-10-29 at 1.0 pages/session), a crawler that
// changes its click depth slips under the shape cap, and a day is either all
// crawler or all human, so the page filled with floors, ratio estimates and
// margins. The browser rule needs no history and no baseline, judges sessions
// rather than days, and is exact for every session it counts.
//
// Why browser age works. Chrome, Edge, Firefox and Safari update themselves, so
// a real visitor is almost always on one of the last two or three releases.
// Crawler fleets rotate through a fixed list of user agents that goes stale:
// on 2026-10-29 (newest Chrome 156) the wiki fleet spread 165k sessions evenly
// over Chrome 103-151, forum.objectivismonline.com's crawler sat on Chrome
// 142/145/153 and on a uniform ChromeMobile 147-151 run, and the aocr.org
// referral bot on walletrecovery.info used Chrome 146. Measured the same day:
// lag 2 kept 8 of 165,647 wiki sessions, 160 of 6,499 on the forum, and 67 of
// 161 on walletrecovery.info (whose real Google/Facebook/Reddit visitors were on
// 154-156); lag 3 let the forum's Chrome 153 crawler back in (+228) and lag 4
// let 2,700 wiki crawler sessions through on Chrome 152.
//
// What it costs. A real person on an out-of-date browser (an unpatched
// corporate machine, an old phone that stopped getting updates) is not
// counted. That is a few percent of real traffic, it is the same few percent
// every day, so trends are unaffected, and the page says the count is "current
// browsers". A crawler that sends a current user agent is the second rule's job;
// one small enough to slip under SEGMENT_MIN_VISITS still counts, and the
// `likely-bot-spike` signal is the alarm for that.

// How many major versions behind the newest a browser may be and still count.
export const BROWSER_LAG = 2;
// The newest version of a family is the highest major version holding at least
// this share (and at least NEWEST_MIN_SESSIONS) of that family's REFERRED
// sessions estate-wide over the last EVIDENCE_DAYS. Referred sessions, because
// a crawler mostly arrives direct, so this is the population least shaped by
// crawler user agents; the highest qualifying version, not the most common,
// because a referral bot on a stale version (aocr.org's Chrome 146 held more
// referred sessions than Chrome 156 that day) must not drag the floor down; and
// a share floor, so a handful of beta, dev or forged future versions (Chrome
// Mobile "443"/"444" showed up) cannot push it up.
export const NEWEST_MIN_SHARE = 0.05;
export const NEWEST_MIN_SESSIONS = 3;
export const EVIDENCE_DAYS = 7;
// One release ahead of the newest is still counted: during a rollout the new
// version is real but has not yet reached NEWEST_MIN_SHARE.
export const BROWSER_LEAD = 1;

// Apple renumbered Safari from 18 straight to 26 in 2025, so 18 is the release
// before 26, not eight behind it. Mapping 18 and below up by 7 keeps "major
// versions behind" meaning releases behind.
const APPLE_RENUMBER = { last: 18, offset: 7 };
const APPLE_FAMILIES = new Set(["Safari", "MobileSafari"]);

// A browser version string as a comparable major release number, or null when
// there is none ("", "Unknown", junk). A family with no version is never counted.
export function browserMajor(browser, version) {
  const major = Number.parseInt(String(version ?? "").split(".")[0], 10);
  if (!Number.isFinite(major) || major <= 0) return null;
  return APPLE_FAMILIES.has(browser) && major <= APPLE_RENUMBER.last ? major + APPLE_RENUMBER.offset : major;
}

// One family label can carry two unrelated version series. Cloudflare reports
// Chrome on iOS and the Google app both as "ChromeMobile", the first with
// Chrome's version (156) and the second with the app's own (GSA 443/444, real
// Google-referred visitors). Versions more than SERIES_GAP apart are treated as
// separate series, each with its own newest version. Chrome's own history is
// one series: every release between a stale crawler user agent and today's is
// somewhere in the evidence, so nothing in 1xx is ever that far from a neighbour.
export const SERIES_GAP = 50;
// Cloudflare could not parse the user agent, so there is no version to judge.
// Never counted; the forum's crawler sent 37 sessions a day this way.
export const UNCOUNTED_FAMILIES = new Set(["Unknown"]);

// rows: { browser, version, visits } of referred sessions. Returns
// Map<browser, [{ newest, evidence }]>, one entry per version series (see
// SERIES_GAP), where evidence is that series' referred session count. A family
// or series with too little evidence to name a newest version is absent, and
// absent means none of its sessions count — failing closed, since a browser
// nobody is referred from is not one real visitors are using.
export function currentBrowsers(rows) {
  const families = new Map();
  for (const row of rows ?? []) {
    if (UNCOUNTED_FAMILIES.has(row.browser)) continue;
    const major = browserMajor(row.browser, row.version);
    const visits = Number(row.visits || 0);
    if (major == null || visits <= 0) continue;
    const fam = families.get(row.browser) ?? new Map();
    fam.set(major, (fam.get(major) ?? 0) + visits);
    families.set(row.browser, fam);
  }
  const current = new Map();
  for (const [browser, majors] of families) {
    const ascending = [...majors.entries()].sort((a, b) => a[0] - b[0]);
    const series = [];
    for (const entry of ascending) {
      const last = series.at(-1);
      if (last && entry[0] - last.at(-1)[0] <= SERIES_GAP) last.push(entry);
      else series.push([entry]);
    }
    const found = [];
    for (const run of series) {
      const evidence = run.reduce((sum, [, n]) => sum + n, 0);
      const floor = Math.max(NEWEST_MIN_SESSIONS, evidence * NEWEST_MIN_SHARE);
      const top = [...run].reverse().find(([, n]) => n >= floor);
      if (top) found.push({ newest: top[0], evidence });
    }
    if (found.length) current.set(browser, found);
  }
  return current;
}

export function isCurrentBrowser(current, browser, version) {
  const major = browserMajor(browser, version);
  if (major == null) return false;
  return (current?.get(browser) ?? []).some(({ newest }) =>
    major >= newest - BROWSER_LAG && major <= newest + BROWSER_LEAD);
}

// SECOND RULE: a crawler that sends a current browser version. The browser rule
// cannot see one, and on 2026-10-22..28 one ran on forum.objectivismonline.com:
// Chrome 156, split evenly across macOS, Windows and Linux (777/753/753 sessions
// on 10-25), 99-100% direct, flat over the day. It shows up as a SEGMENT —
// (host, browser, version, OS) over the night — that is large and almost
// entirely direct. Measured over those eight nights, every crawler segment was
// 50-777 sessions at >=99% direct, and no real segment of 25+ sessions was above
// 93% direct (the most direct ones were iPhone readers of cheatsheets at 79-92%
// and forum regulars at 87-93%). Pages per session does NOT separate them: the
// crawler's Linux segment ran 1.00-1.64. So the test is volume plus direct
// share, per segment, desktop operating systems only (iOS and Android apps strip
// referrers from real people, and no crawler seen so far claimed a phone). The
// whole segment is set aside, including its 0-1% referred sessions.
export const SEGMENT_MIN_VISITS = 50;
export const SEGMENT_DIRECT_SHARE = 0.97;
export const DESKTOP_OS = new Set(["Windows", "MacOSX", "Linux", "ChromeOS"]);

export function isDirectOnlySegment({ os, visits, direct }) {
  const v = Number(visits || 0);
  return DESKTOP_OS.has(os) && v >= SEGMENT_MIN_VISITS && Number(direct || 0) / v >= SEGMENT_DIRECT_SHARE;
}

// Flagged segments as GraphQL filter clauses to AND onto the counted query: one
// "not this segment" per flagged segment, written as an OR of _neq conditions
// (the API has no NOT). Same shape as the excludePaths clauses in cloudflare.js.
export function segmentExclusions(segments) {
  return (segments ?? []).map((seg) => ({ OR: [
    { requestHost_neq: seg.rawHost }, { userAgentBrowser_neq: seg.browser },
    { browserVersion_neq: seg.version }, { userAgentOS_neq: seg.os },
  ] }));
}

// The exact (browser, version-string) pairs that count, as a Cloudflare GraphQL
// filter clause list for `OR`. Built from the census of version strings actually
// seen in the same window, so a counted session cannot carry a string the
// filter lacks. Empty when nothing counts; the caller must not send an empty OR.
export function countedBrowserClauses(current, censusRows) {
  const byBrowser = new Map();
  for (const row of censusRows ?? []) {
    if (!isCurrentBrowser(current, row.browser, row.version)) continue;
    const versions = byBrowser.get(row.browser) ?? new Set();
    versions.add(String(row.version));
    byBrowser.set(row.browser, versions);
  }
  return [...byBrowser].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([browser, versions]) => ({ userAgentBrowser: browser, browserVersion_in: [...versions].sort() }));
}

// ---- Zone-sourced hosts: the same problem, a different instrument ---------
//
// The browser rule above needs a user agent, and the zone log on this plan
// exposes none (clientRequestUserAgent is not a dimension; botScore is
// plan-gated). `crawlerAccounting` routes a zone host to the two summaries
// below instead, and neither of them ever produces a human figure: there is no
// field here from which one could be subtracted out. That is deliberate — see
// summarizeVerifiedBots.
export function crawlerAccounting(site) {
  return site?.measurement === "zone" || site?.zoneSourced ? "zone" : "browser";
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
