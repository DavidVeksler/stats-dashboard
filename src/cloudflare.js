import { CF_ACCOUNTS, HOST_ALIASES, EXCLUDE_PATHS, classifyReferrer } from "./config.js";
import { UNVERIFIED_CATEGORY } from "./bots.js";

const GQL = "https://api.cloudflare.com/client/v4/graphql";

// Per-grouping row cap on the RUM dataset.
export const RUM_ROW_LIMIT = 5000;

// Three groupings of the same dataset in ONE request (GraphQL aliases), so the
// split costs no extra subrequests — runDaily sits near the 50-per-invocation
// ceiling.
//
// This used to be a single `refererHost x requestHost x requestPath` grouping,
// capped at 5,000 rows and ordered by pageviews across EVERY host in the
// account. A crawler flood (direct hits spread over many paths) filled that
// budget and pushed out the small referred rows: on 2026-09-24
// cheatsheets.davidveksler.com stored no referrers at all against Cloudflare's
// own 44 Google + 17 Bing sessions, and because visits were summed from the same
// truncated rows, the day read as 100% direct and the card had no human figure.
// Each grouping below carries only the dimensions its consumer needs:
//   totals: per host — exact visits/views
//   refs:   per (host, referrer) — no path dimension to explode it
//   pages:  per (host, path), ranked by landing sessions — the one a flood can
//           still fill; pullTraffic reports which groupings hit the cap.
// Per-host EXCLUDE_PATHS go into the shared filter as
// `OR: [{ requestHost_neq }, { requestPath_notin }]`, since two of the three
// groupings have no path to drop rows on after the fact.
const QUERY = `query Rum($account: String!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      totals: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: ${RUM_ROW_LIMIT}, orderBy: [count_DESC]) {
        count
        sum { visits }
        dimensions { requestHost }
      }
      refs: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: ${RUM_ROW_LIMIT}, orderBy: [sum_visits_DESC]) {
        sum { visits }
        dimensions { requestHost refererHost }
      }
      pages: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: ${RUM_ROW_LIMIT}, orderBy: [sum_visits_DESC]) {
        count
        sum { visits }
        dimensions { requestHost requestPath }
      }
    }
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

// Pull the last-24h RUM rows from every account and merge by requestHost.
// Returns { hosts, truncated } where hosts is
// Map<host, { views, visits, referrers: Map<refHost, visits>, pages: Map<path, { views, visits }> }>
// and truncated lists "account/grouping" for every grouping that hit RUM_ROW_LIMIT.
export async function pullTraffic(env, startISO, endISO) {
  const hosts = new Map();
  const truncated = [];
  const filter = rumFilter(startISO, endISO);
  const recFor = (host) => {
    let rec = hosts.get(host);
    if (!rec) hosts.set(host, rec = { views: 0, visits: 0, referrers: new Map(), pages: new Map() });
    return rec;
  };

  for (const account of CF_ACCOUNTS) {
    const body = await gqlPost(env, { query: QUERY, variables: { account, filter } }, `RUM ${account}`);

    const acct = body.data?.viewer?.accounts?.[0] ?? {};
    for (const name of ["totals", "refs", "pages"]) {
      if ((acct[name]?.length ?? 0) >= RUM_ROW_LIMIT) truncated.push(`${account.slice(0, 8)}/${name}`);
    }

    // Aliases (e.g. an apex landing page) roll up into the site's primary host.
    for (const g of acct.totals ?? []) {
      const host = HOST_ALIASES.get(g.dimensions.requestHost);
      if (!host) continue;
      const rec = recFor(host);
      rec.views += g.count;
      rec.visits += g.sum.visits;
    }
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

  return { hosts, truncated };
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
