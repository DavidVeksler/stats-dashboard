import { CF_ACCOUNTS, HOST_ALIASES, EXCLUDE_PATHS, classifyReferrer } from "./config.js";

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
      // A session ("visit") is only counted on its first pageview, so internal
      // navigation (refererHost === host) carries visits: 0 and drops out here.
      const ref = g.dimensions.refererHost || "(direct)";
      // Compare through the alias map so a hop between a site's own hostnames
      // (landing page -> forum) counts as internal, not as a referral to itself.
      if (g.sum.visits > 0 && HOST_ALIASES.get(ref) !== host) {
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

// Flatten a referrers Map into a sorted, classified, top-N array.
export function topReferrers(referrers, n = 8) {
  return [...referrers.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([referrer, visits]) => ({ referrer, visits, kind: classifyReferrer(referrer === "(direct)" ? "" : referrer) }));
}

// Flatten a pages Map into a sorted, top-N array, ranked by landing sessions.
export function topPages(pages, n = 8) {
  return [...pages.entries()]
    .sort((a, b) => b[1].visits - a[1].visits)
    .slice(0, n)
    .map(([page, rec]) => ({ page, visits: rec.visits, views: rec.views }));
}
