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
// answer different questions and Bing reports both distinctly. AvgClickPosition
// is passed through as-is, including -1: a live pull against
// cheatsheets.davidveksler.com on 2026-08-27 came back with -1 on every query
// row regardless of click count (one had 4 clicks and still -1), which reads as
// Bing's own "not reported" sentinel rather than a real rank. This module does
// not interpret it -- src/render.js's bingKeywordList renders any negative
// value as "—" rather than a literal -1.0.
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

// The host part of a Bing site URL ("https://wiki.freecapitalists.org/" ->
// "wiki.freecapitalists.org"). Bing's strings are protocol- and trailing-slash
// exact and http:// vs https:// is a real distinction to Bing (two SITES rows
// are verified as http://), so this is only ever used to *compare* a URL to a
// host, never to rebuild one — the stored `bing` string stays whatever
// GetUserSites returned.
function bingHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return String(url ?? "").toLowerCase();
  }
}

// Reconcile SITES' `bing` fields against what the Bing account actually has
// verified today. Pure (no fetch) so scripts/bing-check.mjs can drive it, and
// exposed over /bing-sites so the re-sync AGENTS.md asks for periodically is one
// request rather than a hand-run script with a live key pasted in.
//
// Deliberately reports rather than decides. Adding a site to the dashboard is a
// bigger call than adding a data source to a site already tracked (it means a
// card, traffic tracking, and a GSC property that has to agree), so `untracked`
// is a list to look at, not a to-do list — see AGENTS.md's Bing section for the
// hosts that are verified on one tool and deliberately not on the other.
export function diffBingSites(sites, verified) {
  const urls = new Set(verified.map((v) => v.url));
  const byHost = new Map(verified.map((v) => [bingHost(v.url), v.url]));
  // One entry per (site, URL): a row carrying several Bing properties is only
  // as correct as its least correct URL, and a mapping report that collapsed
  // them would hide exactly the half that broke.
  const configured = sites.flatMap((s) => bingUrlsOf(s).map((bing) => ({ host: s.host, bing })));
  const configuredUrls = new Set(configured.map((c) => c.bing));
  const configuredHosts = new Set(configured.map((c) => bingHost(c.bing)));
  const trackedHosts = new Set(sites.flatMap((s) => [s.host, ...(s.alsoHosts ?? [])]));
  // Every hostname a SITES row covers, aliases included: the apex alias of a
  // forum row is a tracked host, so a Bing property for it is a `bing` field
  // this config could be holding and is not — a missing mapping, not an
  // untracked site.
  const coveredHosts = new Map(sites.flatMap((s) => [s.host, ...(s.alsoHosts ?? [])].map((h) => [h.toLowerCase(), s.host])));
  return {
    // Config strings Bing still recognizes, exactly as written.
    ok: configured.filter((c) => urls.has(c.bing)),
    // Config strings Bing no longer returns: the pull for these 400s or comes
    // back empty. `verifiedAs` names the URL Bing has for that host, if any, so
    // the fix (usually an http/https or trailing-slash difference) is visible.
    stale: configured.filter((c) => !urls.has(c.bing))
      .map((c) => ({ ...c, verifiedAs: byHost.get(bingHost(c.bing)) ?? null })),
    // A hostname this dashboard already covers that Bing verifies and the
    // config does not pull — one line to wire up, and no new card, whether the
    // host is a SITES row's own or one of its aliases.
    // Hosts that already have a config string are excluded here even when the
    // string does not match: those are `stale` (a mapping to repair), and one
    // host should never appear in both lists saying two different things.
    missing: verified.filter((v) => !configuredUrls.has(v.url)
      && !configuredHosts.has(bingHost(v.url)) && coveredHosts.has(bingHost(v.url)))
      .map((v) => ({ host: coveredHosts.get(bingHost(v.url)), verifiedAs: v.url })),
    // Verified in Bing, on no SITES row at all. Adding one is a dashboard
    // decision, not a mapping fix.
    untracked: verified.filter((v) => !trackedHosts.has(bingHost(v.url)))
      .map((v) => ({ url: v.url, verified: v.verified })),
  };
}

// ---- Multi-property sites ---------------------------------------------------
// A SITES row can carry more than one Bing URL, because a site's hostnames are
// not always verified together: objectivismonline.com and
// forum.objectivismonline.com are one card here (the apex is a landing page in
// front of the forum) and one GSC property (a domain property covers both), but
// Bing verifies them as two separate URL-prefix properties. Pulling only one of
// them reported part of that site's Bing traffic as all of it.
//
// The merge below is what makes several properties into the one row per
// (date, host) the schema stores. It is arithmetic, not estimation: clicks and
// impressions add, and every rate is recomputed from the summed pair rather than
// averaged. Both are pure so scripts/bing-check.mjs can drive them, and both are
// exact pass-throughs for the single-URL case every other site is.

// Bing's per-endpoint freshness differs by property as well as by endpoint, so
// two properties of one site can answer for different dates. Rather than picking
// one and labelling the sum with it, a spread is reported as a range — the same
// shape (and the same honesty) as gsc_window, which is a range for the same
// reason.
export function mergeBingWindows(windows) {
  const dates = [...new Set(windows.filter(Boolean))].sort();
  if (!dates.length) return null;
  return dates.length === 1 ? dates[0] : `${dates[0]}–${dates.at(-1)}`;
}

// Sum of every property's site-wide figures. CTR is recomputed from the totals,
// never averaged across properties: a 10%-CTR property with 3 impressions and a
// 1%-CTR one with 3,000 do not average to 5.5%.
export function mergeBingSummaries(parts) {
  const present = parts.filter(Boolean);
  if (!present.length) return null;
  const clicks = present.reduce((sum, p) => sum + p.clicks, 0);
  const impressions = present.reduce((sum, p) => sum + p.impressions, 0);
  return {
    window: mergeBingWindows(present.map((p) => p.window)),
    clicks, impressions, ctr: impressions ? clicks / impressions : 0,
  };
}

// Per-query rows across properties, keyed by query text because that is the
// table's key. Clicks and impressions add. The two positions are averages
// already, so combining them means weighting each property's figure by the
// count it was averaged over — impressions for the impression position, clicks
// for the click position. Bing's -1 "not reported" sentinel is not a position
// and is never averaged into one: a row contributes to the click position only
// if it reports one, and a query whose properties all report -1 keeps -1, so
// render.js still shows it as "—" rather than a number nobody measured.
export function mergeBingKeywords(parts) {
  const present = parts.filter((p) => p && p.rows?.length);
  const byQuery = new Map();
  for (const part of present) {
    for (const row of part.rows) {
      const acc = byQuery.get(row.query) ?? {
        query: row.query, clicks: 0, impressions: 0,
        impPosWeight: 0, impPosSum: 0, clickPosWeight: 0, clickPosSum: 0,
      };
      acc.clicks += row.clicks;
      acc.impressions += row.impressions;
      if (row.avgImpressionPosition >= 0) {
        // Weight by impressions, falling back to 1 so a positioned row with no
        // impressions still counts once instead of vanishing from the average.
        const w = row.impressions || 1;
        acc.impPosWeight += w;
        acc.impPosSum += row.avgImpressionPosition * w;
      }
      if (row.avgClickPosition >= 0) {
        const w = row.clicks || 1;
        acc.clickPosWeight += w;
        acc.clickPosSum += row.avgClickPosition * w;
      }
      byQuery.set(row.query, acc);
    }
  }
  const rows = [...byQuery.values()].map((acc) => ({
    query: acc.query, clicks: acc.clicks, impressions: acc.impressions,
    avgClickPosition: acc.clickPosWeight ? acc.clickPosSum / acc.clickPosWeight : -1,
    avgImpressionPosition: acc.impPosWeight ? acc.impPosSum / acc.impPosWeight : -1,
  })).sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
  return { window: mergeBingWindows(present.map((p) => p.window)), rows };
}

// The Bing URLs a SITES row covers. `bing` is a single URL string on almost
// every row and an array on the rare site whose hostnames Bing verified
// separately (see the merge note above). Normalized in one place so every
// caller — the nightly pull, diffBingSites, the checks — reads the same shape.
export function bingUrlsOf(site) {
  if (!site?.bing) return [];
  return Array.isArray(site.bing) ? site.bing.filter(Boolean) : [site.bing];
}
