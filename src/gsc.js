// Google Search Console access from a Worker via a service-account JWT.
// Requires env.GSC_SA_KEY = the whole service-account JSON key (as a string).
// The service account must be added as a user on each Search Console property.

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function b64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const enc = (s) => b64url(new TextEncoder().encode(s));

function pemToPkcs8(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

// Exchange the service-account key for a short-lived OAuth access token.
export async function getAccessToken(sa, nowSec) {
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`GSC token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// Search Analytics rows for one property over [start, end] (YYYY-MM-DD).
// `dimensions` is an array (["query"], ["page"], ["query", "page"]) or empty
// for the dimensionless total; every row comes back with `keys` in that order.
// pageFilter is an optional RE2 expression matched against the result page URL,
// and composes with any dimension set — it is a filter, not a dimension.
async function querySearchAnalytics(token, siteUrl, start, end, dimensions, rowLimit, pageFilter) {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const requestBody = { startDate: start, endDate: end };
  if (dimensions?.length) requestBody.dimensions = dimensions;
  if (rowLimit) requestBody.rowLimit = rowLimit;
  if (pageFilter) {
    requestBody.dimensionFilterGroups = [{
      groupType: "and",
      filters: [{ dimension: "page", operator: "includingRegex", expression: pageFilter }],
    }];
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) throw new Error(`GSC ${dimensions?.join("+") || "summary"} ${res.status} for ${siteUrl}: ${await res.text()}`);
  const body = await res.json();
  return body.rows ?? [];
}

// Aggregate totals for the window. Kept separate from ranked query/page rows
// as its own Search Console request, ONLY for the case that separation exists
// for: a `queryKeywords` pull that came back truncated at KEYWORD_ROW_LIMIT,
// where summing the stored rows would under-count. When the pull is NOT
// truncated, callers should use `summarizeKeywordRows` on those rows instead
// of calling this — see the comment there for why that is exact, not an
// approximation, and why it exists (the Worker's own subrequest budget).
export async function querySearchSummary(token, siteUrl, start, end, pageFilter = null) {
  const rows = await querySearchAnalytics(token, siteUrl, start, end, [], 1, pageFilter);
  const row = rows[0] ?? {};
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  };
}

// Derive the same shape `querySearchSummary` returns, from `queryKeywords`
// rows already pulled for the same window — no extra Search Console request.
// Only valid when those rows are NOT truncated (rows.length < the rowLimit
// they were requested with): in that case they already ARE the whole
// per-query corpus for the window, so summing clicks/impressions and taking
// the impression-weighted mean position exactly reproduces what a separate
// dimensionless query would return (GSC's own `position` is itself an
// impression-weighted average — see the Search API reference). Call
// `querySearchSummary` instead when the pull came back truncated.
//
// Why this exists: 12 sites x 3 GSC calls (keywords, pages, summary) a night,
// plus the RUM/zone/forum pulls, was landing the Worker's single invocation
// right at Cloudflare's subrequest ceiling — vellum.capital, last in SITES,
// lost its summary call to "Too many subrequests by single Worker invocation"
// on 2026-08-26 even though its own GSC pull (9 rows, nowhere near
// KEYWORD_ROW_LIMIT) succeeded. Every site currently stores well under the
// limit, so this removes one GSC call per site per night with no loss of
// accuracy, not just for vellum.capital.
export function summarizeKeywordRows(rows) {
  const clicks = rows.reduce((sum, r) => sum + r.clicks, 0);
  const impressions = rows.reduce((sum, r) => sum + r.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? rows.reduce((sum, r) => sum + r.position * r.impressions, 0) / impressions : 0,
  };
}

// How many query rows to ask Search Console for, per property, per snapshot.
//
// This is the SAME number on both sides of the pull: whatever GSC returns is
// what `runDaily` stores, so raising the request limit without raising the
// stored slice (or the reverse) does nothing at all. There is one constant
// because there is one decision.
//
// Why it is not 25 any more. At 25 the estate stored 119 query rows covering
// 647 of 58,832 impressions — **1.1% of the corpus** — and the Search CTR tile's
// comparator, which can only be computed over stored per-query rows (it needs a
// per-query position), was therefore drawn from a sample too thin to say anything
// about the estate: 51 of 258 clicks came from that 1.1%, while the unseen
// ~58,185 impressions earned about 207 clicks at roughly 0.36%. The comparator was
// honest — it labelled itself `thin sample` below THIN_SAMPLE_SHARE in render.js —
// and useless.
//
// Why 500 and not more. Google accepts rowLimit up to 25,000 per request, so the
// request side is not the constraint; the storage side is. 500 per property per
// day is up to 6,000 rows a night across 12 properties, about 2.2M rows a year
// with no pruning anywhere in the codebase (see AGENTS.md). That is affordable and
// legible; 25,000 would be 110M rows a year for a tail nothing reads. Tune this
// from the measured `totals.gscSampleShare` after a live pull, not by guessing.
//
// NOTE the ceiling this cannot cross: Search Console omits anonymized queries
// from the query dimension entirely, so no rowLimit ever reaches 100% coverage.
// If the measured share plateaus well below the corpus, that is the anonymization
// floor, not a cap that needs raising again.
export const KEYWORD_ROW_LIMIT = 500;

// The plain query-dimension pull. Since spec item 17 this is the FALLBACK, not
// the nightly path: `runDaily` asks for query+page pairs (`queryQueryPages`) and
// derives the per-query rows from them (`summarizeQueryPages`), and only calls
// this when that pair pull came back truncated at QUERY_PAGE_ROW_LIMIT — the one
// case where the derived rows would be incomplete.
export async function queryKeywords(token, siteUrl, start, end, rowLimit = KEYWORD_ROW_LIMIT, pageFilter = null) {
  const rows = await querySearchAnalytics(token, siteUrl, start, end, ["query"], rowLimit, pageFilter);
  return rows.map((r) => ({
    query: r.keys[0],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

// The page-dimension pull. Deliberately NOT derived from the query+page pairs
// below, even though both carry a page: a ["page"] request includes the traffic
// of Google's anonymized queries in each page's totals, and any request carrying
// the `query` dimension omits those queries entirely. Summing the pairs per page
// would therefore under-count every page by its anonymized share — a different
// population, not an approximation of the same one. `daily_pages` keeps meaning
// "everything Google measured for this page"; per-page sums over the pairs mean
// "over the stored queries", and render.js labels them that way.
export async function queryPages(token, siteUrl, start, end, rowLimit = 25, pageFilter = null) {
  const rows = await querySearchAnalytics(token, siteUrl, start, end, ["page"], rowLimit, pageFilter);
  return rows.map((r) => ({
    page: r.keys[0],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

// How many query+page PAIRS to ask Search Console for, per property, per
// snapshot (spec item 17). Same one-constant-one-decision rule as
// KEYWORD_ROW_LIMIT above: whatever comes back is what gets stored in
// daily_query_pages, and the per-query rows in daily_keywords are derived from
// the same response.
//
// Why it is larger than KEYWORD_ROW_LIMIT: pairs outnumber queries — a query that
// ranks two of a site's pages is two rows — so at the same cap the pair pull
// would truncate sooner than the query pull it replaces. Every site stored well
// under 500 queries at the time of writing, so 1,000 pairs is expected to leave
// every site untruncated; when a site does hit it, `runDaily` falls back to a
// separate ["query"] request for that host (one extra subrequest, for that host
// only) and says so in the run's note. Measure the live pair counts before
// changing this, in either direction — see the item 17 note in AGENTS.md.
export const QUERY_PAGE_ROW_LIMIT = 1000;

// One row per (query, page) pair. `page` is the full URL exactly as Google
// returns it (same as `queryPages`), so the two can be joined by string.
export async function queryQueryPages(token, siteUrl, start, end, rowLimit = QUERY_PAGE_ROW_LIMIT, pageFilter = null) {
  const rows = await querySearchAnalytics(token, siteUrl, start, end, ["query", "page"], rowLimit, pageFilter);
  return rows.map((r) => ({
    query: r.keys[0],
    page: r.keys[1],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    position: r.position ?? 0,
  }));
}

// Derive the per-query rows `queryKeywords` would have returned, from the
// query+page pairs already pulled for the same window — no extra request.
//
// Exact, not an approximation, on the same argument as `summarizeKeywordRows`:
// when the pair pull is NOT truncated (pairs.length < the rowLimit it was
// requested with), the pairs are the whole (query, page) corpus for the window,
// so summing a query's clicks and impressions across its pages and taking the
// impression-weighted mean of its per-page positions reproduces what Google's
// own ["query"] aggregation computes (its `position` is impression-weighted —
// Search API reference). And it is the SAME POPULATION: both request shapes omit
// anonymized queries, so a row here means exactly what a `daily_keywords` row
// always meant. Call `queryKeywords` instead when the pull came back truncated.
//
// Sorted by clicks then impressions, descending, matching Google's own default
// row order so "the top of the list" keeps meaning the same thing either way.
export function summarizeQueryPages(pairs) {
  const byQuery = new Map();
  for (const pair of pairs ?? []) {
    const acc = byQuery.get(pair.query) ?? { query: pair.query, clicks: 0, impressions: 0, weighted: 0 };
    acc.clicks += Number(pair.clicks || 0);
    acc.impressions += Number(pair.impressions || 0);
    acc.weighted += Number(pair.position || 0) * Number(pair.impressions || 0);
    byQuery.set(pair.query, acc);
  }
  return [...byQuery.values()]
    .map(({ query, clicks, impressions, weighted }) => ({
      query, clicks, impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: impressions > 0 ? weighted / impressions : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions
      || String(a.query).localeCompare(String(b.query)));
}
