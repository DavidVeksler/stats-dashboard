// Bing Webmaster Tools API access via a per-account API key -- no OAuth, no
// service account, unlike gsc.js. Generate one at https://www.bing.com/webmasters
// -> the gear icon -> Settings -> API Access -> Generate API Key. One key is
// tied to the Bing account, not to a site, and covers every site verified under
// that account (see getUserSites below) -- Microsoft's own docs: "a user can use
// the same API key for all their verified sites."
//
// Confirmed against Microsoft's own IWebmasterApi reference docs (there is no
// official REST spec page, only the .NET interface docs with REST examples):
// https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi
const BASE = "https://ssl.bing.com/webmaster/api.svc/json";

async function call(method, apiKey, params = {}) {
  const url = new URL(`${BASE}/${method}`);
  url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Bing ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.d ?? [];
}

// Bing's JSON dates are the WCF/ASP.NET AJAX wire format, "/Date(1316156400000-0700)/",
// never ISO -- extract the ms epoch and report the UTC calendar date, the same
// convention every other date in this project uses (gsc_window, daily_traffic.date, etc).
export function parseBingDate(raw) {
  const m = /\/Date\((-?\d+)/.exec(raw || "");
  if (!m) return null;
  return new Date(Number(m[1])).toISOString().slice(0, 10);
}

// Every GetUserSites entry, keyed by the exact `Url` string Bing has on file.
// config.js's `bing` field must match one of these exactly -- Bing 400s on any
// other string, the same intolerance Search Console has for its `gsc` property
// (see the comment above SITES in config.js). Run this once with a live key to
// find out which of SITES' hosts actually have a verified Bing property, rather
// than guessing from the GSC list -- the two webmaster tools are verified
// independently and there is no reason to expect the same coverage.
export async function getUserSites(apiKey) {
  const rows = await call("GetUserSites", apiKey);
  return rows.map((r) => ({ url: r.Url, verified: !!r.IsVerified }));
}

// GetRankAndTrafficStats / GetQueryStats / GetPageStats all return the site's
// *entire* stored history in one call -- there is no date-range parameter like
// GSC's searchAnalytics/query -- so every pull has to reduce that array down to
// just its own freshest date, or a single night's write would try to store
// months of rows. Pure and exported so it is testable without a live fetch (see
// scripts/bing-check.mjs).
export function latestDateRows(rows) {
  const dated = rows.map((r) => ({ ...r, _date: parseBingDate(r.Date) })).filter((r) => r._date);
  if (!dated.length) return { date: null, rows: [] };
  const date = dated.reduce((max, r) => (r._date > max ? r._date : max), dated[0]._date);
  return { date, rows: dated.filter((r) => r._date === date) };
}

// Site-wide clicks/impressions for the freshest date Bing has -- deliberately
// narrower than GSC's querySearchSummary, because GetRankAndTrafficStats carries
// no position field at all (only the per-query/per-page endpoints do; see
// queryKeywords/queryPages below). Per Microsoft's docs this endpoint "will be
// updated every day", so this is normally yesterday or the day before.
export async function queryRankAndTraffic(apiKey, siteUrl) {
  const raw = await call("GetRankAndTrafficStats", apiKey, { siteUrl });
  const { date, rows } = latestDateRows(raw);
  if (!date) return null;
  const clicks = rows.reduce((sum, r) => sum + Number(r.Clicks || 0), 0);
  const impressions = rows.reduce((sum, r) => sum + Number(r.Impressions || 0), 0);
  return { window: date, clicks, impressions, ctr: impressions ? clicks / impressions : 0 };
}

// Per-query rows for the freshest date GetQueryStats has. Per Microsoft's docs
// this endpoint "will be updated every week" -- coarser than GetRankAndTrafficStats
// above, so a keyword snapshot can be several days stale relative to the same
// night's site-wide summary. That is why each table below carries its own
// bing_window rather than assuming the two windows agree, the same reason GSC's
// gsc_window exists independent of daily_traffic's date.
//
// Two position fields, not GSC's one: AvgClickPosition (where the results people
// actually clicked ranked) and AvgImpressionPosition (where every impression
// ranked). Kept apart rather than collapsed into a single number, because they
// answer different questions and Bing reports both distinctly.
export async function queryKeywords(apiKey, siteUrl) {
  const raw = await call("GetQueryStats", apiKey, { siteUrl });
  const { date, rows } = latestDateRows(raw);
  if (!date) return { window: null, rows: [] };
  return {
    window: date,
    rows: rows.map((r) => ({
      query: r.Query, clicks: Number(r.Clicks || 0), impressions: Number(r.Impressions || 0),
      avgClickPosition: Number(r.AvgClickPosition || 0), avgImpressionPosition: Number(r.AvgImpressionPosition || 0),
    })),
  };
}

// NOTE: there is no queryPages/GetPageStats here. GetPageStats would be a third
// fetch per Bing-verified site, and src/index.js's runDaily is already close to
// Cloudflare's per-invocation subrequest ceiling from the GSC pull alone (see
// AGENTS.md's subrequest-budget note, and the 2026-08-26 fix that dropped a
// redundant GSC call for exactly this reason). Bing gets 2 calls per site
// (summary + keywords) rather than 3 until that budget is re-measured with Bing
// live. If page-level Bing data is ever needed, GetPageStats reuses the exact
// same wire shape as GetQueryStats above (Microsoft's own type is literally
// named QueryStats for both) with the page URL coming back in a field still
// called `Query` — confirmed against Microsoft's own XML sample, which shows a
// URL in that position ("<Query>PageURL</Query>").
