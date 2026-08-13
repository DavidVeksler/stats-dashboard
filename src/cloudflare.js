import { CF_ACCOUNTS, HOST_ALIASES, EXCLUDE_PATHS, classifyReferrer } from "./config.js";
import { UNVERIFIED_CATEGORY } from "./bots.js";

const GQL = "https://api.cloudflare.com/client/v4/graphql";

const QUERY = `query Rum($account: String!, $start: String!, $end: String!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      rumPageloadEventsAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: 5000
        orderBy: [count_DESC]
      ) {
        count
        sum { visits }
        dimensions { refererHost requestHost requestPath }
      }
    }
  }
}`;

// Pull the last-24h RUM rows from every account and merge by requestHost.
// Returns Map<host, { views, visits, referrers: Map<refHost, visits>, pages: Map<path, { views, visits }> }>.
export async function pullTraffic(env, startISO, endISO) {
  const hosts = new Map();

  for (const account of CF_ACCOUNTS) {
    const res = await fetch(GQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: QUERY, variables: { account, start: startISO, end: endISO } }),
    });
    if (!res.ok) throw new Error(`CF GraphQL ${res.status} for ${account}: ${await res.text()}`);
    const body = await res.json();
    if (body.errors) throw new Error(`CF GraphQL errors: ${JSON.stringify(body.errors)}`);

    const accts = body.data?.viewer?.accounts ?? [];
    const rows = accts[0]?.rumPageloadEventsAdaptiveGroups ?? [];
    for (const g of rows) {
      // Aliases (e.g. an apex landing page) roll up into the site's primary host.
      const host = HOST_ALIASES.get(g.dimensions.requestHost);
      if (!host) continue;
      // Drop bot-heavy paths (e.g. /history.php) so totals reflect real readers.
      if (EXCLUDE_PATHS.get(host)?.has(g.dimensions.requestPath)) continue;
      const rec = hosts.get(host) ?? { views: 0, visits: 0, referrers: new Map(), pages: new Map() };
      rec.views += g.count;
      rec.visits += g.sum.visits;
      // A session ("visit") is only counted on its first pageview, so navigation
      // within one hostname carries visits: 0 and contributes nothing here either
      // way. A hop between a site's own hostnames (landing page -> forum) does
      // start a session, and used to be dropped entirely: the visits were already
      // counted in rec.visits but no referrer row was written, so the sessions
      // reappeared in the traffic-source panel as an unattributable residual.
      // They are kept now and classified as kind "internal" (topReferrers passes
      // `host` through to classifyReferrer), which is a real category rather than
      // a hole.
      const ref = g.dimensions.refererHost || "(direct)";
      if (g.sum.visits > 0) {
        rec.referrers.set(ref, (rec.referrers.get(ref) ?? 0) + g.sum.visits);
      }
      // Landing pages: summing visits (session-starts) by requestPath tells us
      // which page each session actually entered on, since visits only counts
      // on a session's first pageview.
      const path = g.dimensions.requestPath || "/";
      const pageRec = rec.pages.get(path) ?? { views: 0, visits: 0 };
      pageRec.views += g.count;
      pageRec.visits += g.sum.visits;
      rec.pages.set(path, pageRec);
      hosts.set(host, rec);
    }
  }

  return hosts;
}

// httpRequestsAdaptiveGroups filter+one optional dimension. Kept to a single
// dimension per call deliberately: combining clientRequestPath with country
// and status on this host exploded past the 5000-row cap (thousands of files
// x ~120 countries x ~10 statuses) and silently undercounted every sum — the
// same failure mode gsc.js's querySearchSummary comment warns about for
// Search Console's ranked rows. A day's total, split three single-dimension
// ways, never approached the cap in testing (max ~3700 rows, for path).
//
// It is a row-cap convention, not an API ceiling: a two-dimension call is legal
// and works. `{ clientRequestPath, edgeResponseStatus }` filtered to
// edgeResponseStatus_geq: 400 returned 1,376 rows on this zone without
// approaching the cap (spike 2026-08-12). Pair dimensions only where a filter
// keeps the product small like that.
function zoneQuery(dimension) {
  return `query ZoneTraffic($zoneTag: String!, $start: String!, $end: String!, $host: String!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end, clientRequestHTTPHost: $host }
        limit: 5000
        orderBy: [count_DESC]
      ) {
        count
        sum { visits edgeResponseBytes }
        ${dimension ? `dimensions { ${dimension} }` : ""}
      }
    }
  }
}`;
}

async function runZoneQuery(env, dimension, zoneTag, host, startISO, endISO) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: zoneQuery(dimension),
      variables: { zoneTag, start: startISO, end: endISO, host },
    }),
  });
  if (!res.ok) throw new Error(`CF zone GraphQL ${res.status} for ${host}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(`CF zone GraphQL errors for ${host}: ${JSON.stringify(body.errors)}`);
  return body.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
}

// Pull one host's traffic straight from the zone's HTTP request log, for hosts
// that carry no Web Analytics beacon (e.g. a file host serving raw payloads,
// no HTML wrapper for the RUM script to load from). Free-plan limit: this
// dataset accepts at most a 1-day window per request, so callers must pass a
// startISO/endISO span no wider than 24h.
// Returns { visits, requests, bytes, paths, countries, statuses, bots }.
export async function pullZoneTraffic(env, zoneTag, host, startISO, endISO) {
  const [totalRows, pathRows, countryRows, statusRows, botRows] = await Promise.all([
    runZoneQuery(env, null, zoneTag, host, startISO, endISO),
    runZoneQuery(env, "clientRequestPath", zoneTag, host, startISO, endISO),
    runZoneQuery(env, "clientCountryName", zoneTag, host, startISO, endISO),
    runZoneQuery(env, "edgeResponseStatus", zoneTag, host, startISO, endISO),
    runZoneQuery(env, "verifiedBotCategory", zoneTag, host, startISO, endISO),
  ]);

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
