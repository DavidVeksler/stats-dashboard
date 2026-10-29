import { CF_ACCOUNTS, HOST_ALIASES, EXCLUDE_PATHS, classifyReferrer } from "./config.js";
import { UNVERIFIED_CATEGORY, EVIDENCE_DAYS, currentBrowsers, isCurrentBrowser, countedBrowserClauses,
  isDirectOnlySegment, segmentExclusions } from "./bots.js";

const GQL = "https://api.cloudflare.com/client/v4/graphql";

// Per-grouping row cap on the RUM dataset.
export const RUM_ROW_LIMIT = 5000;

// The RUM pull is TWO requests, each covering every account at once (one
// `accounts(filter: { accountTag })` alias per account), never one per account.
//
// 1. CENSUS. Per account, `census` counts every session by (host, browser,
//    version, OS) over the window, `censusDirect` the direct ones by the same
//    dimensions, and `evidence` counts REFERRED sessions by (browser, version)
//    over the last EVIDENCE_DAYS. `evidence` names the newest version real
//    visitors use (currentBrowsers in bots.js); the census then splits each host
//    into counted sessions and automated ones — a stale browser, or a
//    direct-only desktop segment (isDirectOnlySegment) — exactly, and lists the
//    version strings that count.
// 2. COUNTED. The same window filtered server-side to those counted (browser,
//    version) pairs, minus the direct-only segments, grouped two ways:
//      refs:  per (host, referrer)
//      pages: per (host, path), ranked by landing sessions
//    Filtering in the query, not after it, is the point: a crawler spreads one
//    session over each of 100,000+ paths, and unfiltered it fills the 5,000-row
//    cap before a single real landing page is ranked.
//
// Two subrequests where there used to be four (one per account), so the
// census costs nothing out of runDaily's 50-per-invocation budget.
const CENSUS_QUERY = (accounts) => `query RumCensus($filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!, $direct: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!, $evidence: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
  viewer {
${accounts.map((account, i) => `    a${i}: accounts(filter: { accountTag: "${account}" }) {
      census: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: ${RUM_ROW_LIMIT}, orderBy: [count_DESC]) {
        count
        sum { visits }
        avg { sampleInterval }
        dimensions { requestHost userAgentBrowser browserVersion userAgentOS }
      }
      censusDirect: rumPageloadEventsAdaptiveGroups(filter: $direct, limit: ${RUM_ROW_LIMIT}, orderBy: [count_DESC]) {
        sum { visits }
        dimensions { requestHost userAgentBrowser browserVersion userAgentOS }
      }
      evidence: rumPageloadEventsAdaptiveGroups(filter: $evidence, limit: ${RUM_ROW_LIMIT}, orderBy: [sum_visits_DESC]) {
        sum { visits }
        dimensions { userAgentBrowser browserVersion }
      }
    }`).join("\n")}
  }
}`;

const COUNTED_QUERY = (accounts) => `query RumCounted($filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
  viewer {
${accounts.map((account, i) => `    a${i}: accounts(filter: { accountTag: "${account}" }) {
      refs: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: ${RUM_ROW_LIMIT}, orderBy: [sum_visits_DESC]) {
        count
        sum { visits }
        avg { sampleInterval }
        dimensions { requestHost refererHost }
      }
      pages: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: ${RUM_ROW_LIMIT}, orderBy: [sum_visits_DESC]) {
        count
        sum { visits }
        dimensions { requestHost requestPath }
      }
    }`).join("\n")}
  }
}`;

// The RUM filter: the time window, plus one exclusion clause per raw hostname
// (aliases included) whose primary host lists excludePaths.
export function rumFilter(startISO, endISO) {
  const filter = { datetime_geq: startISO, datetime_leq: endISO };
  const exclusions = [];
  for (const [raw, host] of HOST_ALIASES) {
    const paths = EXCLUDE_PATHS.get(host);
    if (paths?.size) exclusions.push({ OR: [{ requestHost_neq: raw }, { requestPath_notin: [...paths] }] });
  }
  if (exclusions.length) filter.AND = exclusions;
  return filter;
}

// POST one GraphQL request to Cloudflare, retrying transient failures. The nightly
// cron once died on a single `serviceUnavailable` ("unable to execute query, please
// try again later", 2026-09-29) from the RUM query: no retry, no runs row, no push,
// so the dashboard just silently went a day stale. Only errors Cloudflare itself
// marks as retryable (5xx, 429, network faults, serviceUnavailable/timeout codes)
// are retried; a real query error (authz, bad field) throws immediately. Every
// retry is another subrequest, but only on failure, so the 50-per-invocation
// budget in AGENTS.md is untouched on a healthy night.
const GQL_ATTEMPTS = 3;
const GQL_BACKOFF_MS = [1500, 4000];
const RETRYABLE_GQL_CODES = new Set(["serviceUnavailable", "timeout", "internalError"]);

export async function gqlPost(env, payload, label) {
  let lastErr;
  for (let attempt = 1; attempt <= GQL_ATTEMPTS; attempt++) {
    let retryable = false;
    try {
      const res = await fetch(GQL, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        retryable = res.status >= 500 || res.status === 429;
        throw new Error(`CF GraphQL ${res.status} for ${label}: ${await res.text()}`);
      }
      const body = await res.json();
      if (body.errors) {
        retryable = body.errors.some((e) => RETRYABLE_GQL_CODES.has(e?.extensions?.code));
        throw new Error(`CF GraphQL errors for ${label}: ${JSON.stringify(body.errors)}`);
      }
      return body;
    } catch (err) {
      lastErr = err;
      // fetch() itself rejecting (no status yet) is a network fault: retry it.
      if (!/^CF GraphQL/.test(String(err?.message))) retryable = true;
      if (!retryable || attempt === GQL_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, GQL_BACKOFF_MS[attempt - 1]));
    }
  }
  throw lastErr;
}


// ---- Sampling guard --------------------------------------------------------
// rumPageloadEventsAdaptiveGroups is an *adaptive* dataset: when Cloudflare is
// under load it answers with a coarser sample, and every count comes back as a
// multiple of the sample interval. That is what the 2026-10-17 run stored:
// forum.objectivismonline.com 18,000 visits, three more hosts at 3,000/2,000/
// 1,000, and eleven of seventeen sites at zero, while re-reading the identical
// window afterwards returned the exact figures at interval ~1. Earlier bad runs:
// 2026-09-21, 09-30, 10-06 and 10-12. The pull used to accept whatever came back.
// `avg { sampleInterval }` says how coarse the answer is, so a sampled answer is
// retried and, if it stays sampled, refused (pullTraffic reports it; runDaily
// writes no RUM rows rather than wrong ones). A healthy answer reads 1.00-1.05.
export const RUM_MAX_SAMPLE_INTERVAL = 1.5;
// Retries are spent from ONE budget per pullTraffic call, not per account: runDaily
// sits at 46-47 of the 50-subrequest ceiling, so a degraded night may add at most
// RUM_SAMPLING_RETRIES requests (and still lands at <= 50 with gqlPost's own retries
// quiet). Spaced out because sampling follows load, which a second does not clear.
export const RUM_SAMPLING_RETRIES = 3;
export const RUM_SAMPLING_BACKOFF_MS = [5000, 15000, 30000];

// Judge one account's `totals` rows. Returns null when they can be trusted, else a
// short reason. The interval is weighted by pageviews so a quiet host's noisy
// interval cannot veto a healthy day, while a flood host's cannot hide a bad one.
// `expectTraffic` is for the account that always has traffic: an empty answer
// there is the 2026-10-06 shape (every site zero), not a quiet day.
export function rumSamplingProblem(rows, expectTraffic) {
  if (!rows.length) return expectTraffic ? "no rows returned" : null;
  let weight = 0, weighted = 0;
  for (const r of rows) {
    const w = Number(r.count) || 0;
    weight += w;
    weighted += w * (Number(r.avg?.sampleInterval) || 1);
  }
  const interval = weight ? weighted / weight : 1;
  return interval > RUM_MAX_SAMPLE_INTERVAL ? `sample interval ${interval.toFixed(1)}` : null;
}

// One aliased request over every account, retried while Cloudflare answers with
// a sampled result. `judge(account)` returns the rows the sampling guard weighs.
// Retries come out of the shared `budget` ({ left }) so one pullTraffic call
// spends at most RUM_SAMPLING_RETRIES extra subrequests across both requests.
async function rumRequest(env, query, variables, label, judge, budget, backoffMs) {
  for (let attempt = 0; ; attempt++) {
    const body = await gqlPost(env, { query, variables }, label);
    const accounts = CF_ACCOUNTS.map((_, i) => body.data?.viewer?.[`a${i}`]?.[0] ?? {});
    const degraded = [];
    accounts.forEach((acct, i) => {
      const problem = rumSamplingProblem(judge(acct), i === 0);
      if (problem) degraded.push(`${CF_ACCOUNTS[i].slice(0, 8)}: ${problem}`);
    });
    if (!degraded.length || budget.left <= 0) return { accounts, degraded };
    budget.left -= 1;
    await new Promise((r) => setTimeout(r, backoffMs[Math.min(attempt, backoffMs.length - 1)]));
  }
}

// Pull the last-24h RUM rows from every account and merge by requestHost.
// Returns { hosts, truncated, degraded, browsers, segments } where hosts is
// Map<host, { views, visits, automatedVisits, automatedViews,
//             referrers: Map<refHost, visits>, pages: Map<path, { views, visits }> }>.
// visits/views/referrers/pages are COUNTED sessions only (current browsers, see
// bots.js); automated* is everything the two rules set aside. `browsers` is the
// newest version per family the rule used, and `segments` the direct-only
// desktop segments set aside, both for the runs note and the page.
// truncated lists "account/grouping" for every grouping that hit RUM_ROW_LIMIT,
// and degraded lists "account: reason" for every account still sampled after
// the retry budget (see the sampling guard above), or a reason the rule could
// not run at all. When degraded is non-empty `hosts` holds nothing worth
// writing and the caller must not store it.
export async function pullTraffic(env, startISO, endISO, { retries = RUM_SAMPLING_RETRIES, backoffMs = RUM_SAMPLING_BACKOFF_MS } = {}) {
  const hosts = new Map();
  const truncated = [];
  const budget = { left: retries };
  const filter = rumFilter(startISO, endISO);
  const evidenceStart = new Date(new Date(endISO).getTime() - EVIDENCE_DAYS * 86400e3).toISOString();
  const evidence = { ...rumFilter(evidenceStart, endISO), refererHost_neq: "" };
  const recFor = (host) => {
    let rec = hosts.get(host);
    if (!rec) hosts.set(host, rec = { views: 0, visits: 0, automatedViews: 0, automatedVisits: 0,
      referrers: new Map(), pages: new Map() });
    return rec;
  };
  const noteTruncation = (accounts, names) => accounts.forEach((acct, i) => {
    for (const name of names) {
      if ((acct[name]?.length ?? 0) >= RUM_ROW_LIMIT) truncated.push(`${CF_ACCOUNTS[i].slice(0, 8)}/${name}`);
    }
  });

  // 1. Census + evidence.
  const census = await rumRequest(env, CENSUS_QUERY(CF_ACCOUNTS), { filter, direct: { ...filter, refererHost: "" }, evidence }, "RUM census",
    (acct) => acct.census ?? [], budget, backoffMs);
  if (census.degraded.length) return { hosts, truncated, degraded: census.degraded, browsers: [], segments: [] };
  noteTruncation(census.accounts, ["census", "censusDirect", "evidence"]);
  const current = currentBrowsers(census.accounts.flatMap((acct) => (acct.evidence ?? []).map((g) => ({
    browser: g.dimensions.userAgentBrowser, version: g.dimensions.browserVersion, visits: g.sum.visits }))));
  const browsers = [...current].flatMap(([browser, series]) =>
    series.map(({ newest, evidence }) => ({ browser, newest, evidence })))
    .sort((a, b) => b.evidence - a.evidence);
  // Fail closed: with no evidence there is no newest version, nothing would
  // count, and writing every site at zero is the 2026-10-17 failure in a new shape.
  if (!current.size) return { hosts, truncated, degraded: ["no referred sessions to date the current browsers from"], browsers, segments: [] };

  const censusRows = [];
  const segments = [];
  const segmentKey = (d) => [d.requestHost, d.userAgentBrowser, d.browserVersion, d.userAgentOS].join("\u0000");
  for (const acct of census.accounts) {
    const direct = new Map((acct.censusDirect ?? []).map((g) => [segmentKey(g.dimensions), g.sum.visits]));
    for (const g of acct.census ?? []) {
      // Aliases (e.g. an apex landing page) roll up into the site's primary host.
      const host = HOST_ALIASES.get(g.dimensions.requestHost);
      if (!host) continue;
      const row = { browser: g.dimensions.userAgentBrowser, version: g.dimensions.browserVersion };
      const isCurrent = isCurrentBrowser(current, row.browser, row.version);
      const segment = { host, rawHost: g.dimensions.requestHost, browser: row.browser, version: row.version,
        os: g.dimensions.userAgentOS, visits: g.sum.visits, direct: direct.get(segmentKey(g.dimensions)) ?? 0 };
      const directOnly = isCurrent && isDirectOnlySegment(segment);
      if (directOnly) segments.push(segment);
      if (isCurrent) censusRows.push(row);
      const rec = recFor(host);
      if (isCurrent && !directOnly) {
        rec.views += g.count;
        rec.visits += g.sum.visits;
      } else {
        rec.automatedViews += g.count;
        rec.automatedVisits += g.sum.visits;
      }
    }
  }
  segments.sort((a, b) => b.visits - a.visits);
  const clauses = countedBrowserClauses(current, censusRows);
  if (!clauses.length) return { hosts, truncated, degraded: [], browsers, segments };

  // 2. Referrers and landing pages, counted sessions only.
  const counted = await rumRequest(env, COUNTED_QUERY(CF_ACCOUNTS),
    { filter: { ...filter, AND: [...(filter.AND ?? []), { OR: clauses }, ...segmentExclusions(segments)] } }, "RUM counted",
    (acct) => acct.refs ?? [], budget, backoffMs);
  if (counted.degraded.length) return { hosts, truncated, degraded: counted.degraded, browsers, segments };
  noteTruncation(counted.accounts, ["refs", "pages"]);
  for (const acct of counted.accounts) {
    // A session ("visit") is only counted on its first pageview, so navigation
    // within one hostname carries visits: 0 and contributes nothing here either
    // way. A hop between a site's own hostnames (landing page -> forum) does
    // start a session; it is kept and classified as kind "internal"
    // (topReferrers passes `host` through to classifyReferrer).
    for (const g of acct.refs ?? []) {
      const host = HOST_ALIASES.get(g.dimensions.requestHost);
      if (!host || !(g.sum.visits > 0)) continue;
      const rec = recFor(host);
      const ref = g.dimensions.refererHost || "(direct)";
      rec.referrers.set(ref, (rec.referrers.get(ref) ?? 0) + g.sum.visits);
    }
    // Landing pages: summing visits (session-starts) by requestPath tells us
    // which page each session actually entered on, since visits only counts
    // on a session's first pageview.
    for (const g of acct.pages ?? []) {
      const host = HOST_ALIASES.get(g.dimensions.requestHost);
      if (!host) continue;
      const rec = recFor(host);
      const path = g.dimensions.requestPath || "/";
      const pageRec = rec.pages.get(path) ?? { views: 0, visits: 0 };
      pageRec.views += g.count;
      pageRec.visits += g.sum.visits;
      rec.pages.set(path, pageRec);
    }
  }

  return { hosts, truncated, degraded: [], browsers, segments };
}

// httpRequestsAdaptiveGroups, one dimension per grouping. Kept to a single
// dimension per grouping deliberately: combining clientRequestPath with country
// and status on this host exploded past the 5000-row cap (thousands of files
// x ~120 countries x ~10 statuses) and silently undercounted every sum — the
// same failure mode gsc.js's querySearchSummary comment warns about for
// Search Console's ranked rows. A day's total, split single-dimension ways,
// never approached the cap in testing (max ~3700 rows, for path; the one
// exception was the R2 migration morning, 2026-09-27, when a sync tool HEADed
// every file and `path` filled its cap — the top-files list is a top-N anyway).
//
// It is a row-cap convention, not an API ceiling: a two-dimension grouping is
// legal and works. `{ clientRequestPath, edgeResponseStatus }` filtered to
// edgeResponseStatus_geq: 400 returned 1,376 rows on this zone without
// approaching the cap (spike 2026-08-12). Pair dimensions only where a filter
// keeps the product small like that.
//
// The groupings are GraphQL aliases in ONE request (since 2026-09-27; it was
// five fetches before), so a zone host costs one subrequest out of runDaily's
// budget instead of five — which is what paid for the R2 pull.
export const ZONE_GROUPINGS = {
  total: null,
  path: "clientRequestPath",
  country: "clientCountryName",
  status: "edgeResponseStatus",
  bots: "verifiedBotCategory",
  // Edge cache outcome per request — how much of an R2-backed host the cache
  // answered without a bucket read (see summarizeCache in r2.js).
  cache: "cacheStatus",
  method: "clientRequestHTTPMethodName",
};

export function zoneQuery() {
  const filter = "{ datetime_geq: $start, datetime_leq: $end, clientRequestHTTPHost: $host }";
  const groupings = Object.entries(ZONE_GROUPINGS).map(([alias, dimension]) =>
    `      ${alias}: httpRequestsAdaptiveGroups(filter: ${filter}, limit: 5000, orderBy: [count_DESC]) {
        count
        sum { visits edgeResponseBytes }
        ${dimension ? `dimensions { ${dimension} }` : ""}
      }`).join("\n");
  return `query ZoneTraffic($zoneTag: String!, $start: String!, $end: String!, $host: String!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
${groupings}
    }
  }
}`;
}

// Pull one host's traffic straight from the zone's HTTP request log, for hosts
// that carry no Web Analytics beacon (e.g. a file host serving raw payloads,
// no HTML wrapper for the RUM script to load from). Free-plan limit: this
// dataset accepts at most a 1-day window per request, so callers must pass a
// startISO/endISO span no wider than 24h.
// Returns { visits, requests, bytes, paths, countries, statuses, bots, dims }.
export async function pullZoneTraffic(env, zoneTag, host, startISO, endISO) {
  const body = await gqlPost(env, {
    query: zoneQuery(),
    variables: { zoneTag, start: startISO, end: endISO, host },
  }, `zone ${host}`);
  const zone = body.data?.viewer?.zones?.[0] ?? {};
  const totalRows = zone.total ?? [];
  const pathRows = zone.path ?? [];
  const countryRows = zone.country ?? [];
  const statusRows = zone.status ?? [];
  const botRows = zone.bots ?? [];

  const totals = totalRows[0] ?? { count: 0, sum: { visits: 0, edgeResponseBytes: 0 } };

  const paths = new Map();
  for (const g of pathRows) {
    const path = g.dimensions.clientRequestPath || "/";
    const p = paths.get(path) ?? { visits: 0, requests: 0 };
    p.visits += g.sum.visits;
    p.requests += g.count;
    paths.set(path, p);
  }

  const countries = new Map();
  for (const g of countryRows) {
    const country = g.dimensions.clientCountryName || "Unknown";
    countries.set(country, (countries.get(country) ?? 0) + g.sum.visits);
  }

  const statuses = new Map();
  for (const g of statusRows) {
    statuses.set(g.dimensions.edgeResponseStatus, (statuses.get(g.dimensions.edgeResponseStatus) ?? 0) + g.count);
  }

  // Verified crawlers. Both count (requests) and visits are kept: the visits
  // figure is what lets the card decompose its own headline zone-visit number
  // rather than only its request total. The empty category is stored under an
  // explicit "(unverified)" name, never dropped and never read as "human" — see
  // summarizeVerifiedBots in bots.js for why that distinction is the whole point.
  const bots = new Map();
  for (const g of botRows) {
    const category = g.dimensions.verifiedBotCategory || UNVERIFIED_CATEGORY;
    const b = bots.get(category) ?? { requests: 0, visits: 0 };
    b.requests += g.count;
    b.visits += g.sum.visits;
    bots.set(category, b);
  }

  return {
    visits: totals.sum.visits,
    requests: totals.count,
    bytes: totals.sum.edgeResponseBytes,
    // Ranked by requests, not visits: for a file host, "top files" means most
    // hit, and a single session can pull many different files.
    paths: [...paths.entries()].sort((a, b) => b[1].requests - a[1].requests).slice(0, 50)
      .map(([path, r]) => ({ path, visits: r.visits, requests: r.requests })),
    countries: [...countries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([country, v]) => ({ country, visits: v })),
    statuses: [...statuses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([status, requests]) => ({ status, requests })),
    // Not sliced: this dimension has ~10 values, and truncating it would turn a
    // floor into a smaller floor for no benefit.
    bots: [...bots.entries()].sort((a, b) => b[1].requests - a[1].requests)
      .map(([category, b]) => ({ category, requests: b.requests, visits: b.visits })),
    // Small, closed dimensions stored whole in daily_zone_dims as (dim, value).
    dims: ["cache", "method"].flatMap((dim) => (zone[dim] ?? []).map((g) => ({
      dim, value: String(g.dimensions[ZONE_GROUPINGS[dim]] || "(none)"),
      requests: g.count, bytes: g.sum.edgeResponseBytes }))),
  };
}

// Flatten a referrers Map into a sorted, classified, top-N array.
//
// `selfHost` is the site's primary host. Passing it is what lets a referral from
// one of the site's own hostnames be stored as kind "internal" instead of being
// counted as an outside referral to itself. The kind is frozen into
// daily_referrers here, at write time, so it can never be recovered for rows
// already stored — see classifyReferrer.
export function topReferrers(referrers, n = 8, selfHost = null) {
  return [...referrers.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([referrer, visits]) => ({ referrer, visits,
      kind: classifyReferrer(referrer === "(direct)" ? "" : referrer, selfHost) }));
}

// Flatten a pages Map into a sorted, top-N array, ranked by landing sessions.
export function topPages(pages, n = 8) {
  return [...pages.entries()]
    .sort((a, b) => b[1].visits - a[1].visits)
    .slice(0, n)
    .map(([page, rec]) => ({ page, visits: rec.visits, views: rec.views }));
}
