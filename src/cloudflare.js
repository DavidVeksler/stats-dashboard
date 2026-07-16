import { CF_ACCOUNTS, TARGET_HOSTS, classifyReferrer } from "./config.js";

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
        dimensions { refererHost requestHost }
      }
    }
  }
}`;

// Pull the last-24h RUM rows from every account and merge by requestHost.
// Returns Map<host, { views, visits, referrers: Map<refHost, visits> }>.
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
      const host = g.dimensions.requestHost;
      if (!TARGET_HOSTS.has(host)) continue;
      const rec = hosts.get(host) ?? { views: 0, visits: 0, referrers: new Map() };
      rec.views += g.count;
      rec.visits += g.sum.visits;
      // A session ("visit") is only counted on its first pageview, so internal
      // navigation (refererHost === host) carries visits: 0 and drops out here.
      const ref = g.dimensions.refererHost || "(direct)";
      if (g.sum.visits > 0 && ref !== host) {
        rec.referrers.set(ref, (rec.referrers.get(ref) ?? 0) + g.sum.visits);
      }
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
