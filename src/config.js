// The domains to track. `host` is the Cloudflare Web Analytics requestHost;
// `gsc` is the exact Search Console property string (sc-domain: or URL-prefix).
// `gscPageFilter`, when present, limits a broader property to matching page URLs.
//
// `gsc` must be a property string that already exists in Search Console and has
// the service account added as a user — Search Console 403s on any other string,
// including a `sc-domain:` form for a domain property that was never verified.
// A URL-prefix property is protocol-exact and does not cover subdomains, so it
// cannot be swapped for the `sc-domain:` form on the assumption that the domain
// property exists. Verify with sites.list (or the `search-console` MCP's
// list_sites) before editing one of these, never by pattern.
//
// A `sc-domain:` property also covers every subdomain, so any row pointing at
// one needs a `gscPageFilter` whenever a sibling subdomain has its own row here
// — otherwise the parent row counts the sibling's clicks a second time.
//
// Optional `queryDenyPatterns: ["…"]` lists JS regex sources (matched
// case-insensitively against the query text) for search queries a site will
// never pursue. A denied query is still shown in that site's query list — the
// data stays honest — it is only excluded from the snippet/rank opportunity
// classes and from the headline opportunity count, so the recommendation list
// stays a list of things somebody actually intends to do. It ships unset on
// every site: which queries a site declines to chase is an editorial decision,
// not something this repo should make on the owner's behalf. To populate one,
// add the field to that site's entry, e.g.
//   queryDenyPatterns: ["^some phrase$", "another\\s+phrase"],
// and nothing else changes — `src/opportunities.js` compiles it lazily and a
// malformed pattern denies nothing rather than breaking the page.
export const SITES = [
  {
    // objectivismonline.com (and its www alias) is just a landing page in front
    // of the forum, so both roll up into this one row. The GSC property is the
    // domain-level one because it already covers the apex *and* the forum —
    // adding the forum's URL-prefix property on top would double-count it. The
    // page filter keeps wiki.objectivismonline.com, a separate site, out.
    host: "forum.objectivismonline.com",
    alsoHosts: ["objectivismonline.com", "www.objectivismonline.com"],
    gsc: "sc-domain:objectivismonline.com",
    gscPageFilter: "^https?://(?:www\\.|forum\\.)?objectivismonline\\.com/",
  },
  {
    host: "cheatsheets.davidveksler.com",
    gsc: "sc-domain:cheatsheets.davidveksler.com",
    // /history.php is hit almost entirely by bots crawling revision links, not
    // real users; drop it from traffic so sessions/views reflect actual readers.
    excludePaths: ["/history.php"],
  },
  {
    host: "coloradofirearmswatch.org",
    gsc: "sc-domain:coloradofirearmswatch.org",
  },
  {
    host: "davidveksler.com",
    gsc: "sc-domain:davidveksler.com",
    gscPageFilter: "^https?://(?:www\\.)?davidveksler\\.com/",
  },
  { host: "walletrecovery.info", gsc: "sc-domain:walletrecovery.info" },
  // The domain property spans every *.freecapitalists.org subdomain, several of
  // which are rows of their own below, so the apex row is filtered down to the
  // apex. Subdomains with no row here (archive., alexmerced., anarchonews.,
  // austrotrader., mises.) are therefore in the property but on no card — the
  // same coverage the old apex URL-prefix property gave.
  { host: "freecapitalists.org", gsc: "sc-domain:freecapitalists.org",
    gscPageFilter: "^https?://(?:www\\.)?freecapitalists\\.org/" },
  { host: "wiki.freecapitalists.org", gsc: "sc-domain:wiki.freecapitalists.org" },
  // Reads the parent domain property filtered to the subdomain. A dedicated
  // sc-domain:davidveksler.freecapitalists.org property was created 2026-08-12
  // and is readable, but Search Console has not backfilled it yet: it returns
  // zero rows for 2026-05-01..08-11 while the parent property returns this
  // subdomain's pages for the same window. Switch this row over once the
  // dedicated property answers with data, not before — an empty property is how
  // this site's card went blank in the first place.
  // (The older http:// URL-prefix property is dead for a different reason:
  // URL-prefix properties are protocol-exact and the site serves https.)
  { host: "davidveksler.freecapitalists.org", gsc: "sc-domain:freecapitalists.org",
    gscPageFilter: "^https?://davidveksler\\.freecapitalists\\.org/" },
  { host: "whopaysforai.org", gsc: "sc-domain:whopaysforai.org" },
  { host: "oneminute.freecapitalists.org", gsc: "https://oneminute.freecapitalists.org/" },
  // File-host subdomain (PDF/EPUB/MP3/MP4 payloads, no HTML pages), so the Web
  // Analytics RUM beacon never fires here. trafficSource: "zone" routes traffic
  // to Cloudflare's zone-level HTTP request log (httpRequestsAdaptiveGroups)
  // instead — see pullZoneTraffic in cloudflare.js. gsc is independent of
  // trafficSource and still queries Search Console; the property is live but has
  // returned no rows yet, so expect an empty search panel until it does.
  { host: "library.freecapitalists.org", trafficSource: "zone", zoneTag: "066e5342a1531be2638029c2f1dde5f6",
    gsc: "sc-domain:library.freecapitalists.org" },
  { host: "vellum.capital", gsc: "sc-domain:vellum.capital" },
];

// Map<anyHost, primaryHost>. A site can span several hostnames (an apex landing
// page in front of a forum, a www alias); every alias rolls up into the site's
// primary `host` so the dashboard shows one row per site and D1 stays keyed on
// that one host.
export const HOST_ALIASES = new Map(
  SITES.flatMap((s) => [s.host, ...(s.alsoHosts ?? [])].map((h) => [h, s.host])),
);

export const TARGET_HOSTS = new Set(HOST_ALIASES.keys());

// Map<host, Set<path>> of request paths to drop from RUM traffic (bot noise).
export const EXCLUDE_PATHS = new Map(
  SITES.filter((s) => s.excludePaths?.length).map((s) => [s.host, new Set(s.excludePaths)]),
);

// Web Analytics RUM data is account-scoped; a host may live on any of these.
// We query all and merge by requestHost.
export const CF_ACCOUNTS = [
  "556c237bf8cb62edb8f7b401499bb7a9", // David Veksler's Websites
  "8482eee75e575abe1199fd3491909b09", // Paytech Systems
  "a207da77ad660aed3d86fdc41bab26fd", // Prometheus Foundation
  "8a0c9adc37fc6601da5a408c8f1c0d4a", // The Objective Standard
];

const SEARCH_ENGINES = ["google.", "bing.", "duckduckgo.", "search.brave.", "yandex.", "ecosia.", "search.marginalia", "yahoo."];
const SOCIAL = ["reddit.", "reddit.frontpage", "linkedin.", "facebook.", "x.com", "t.co", "twitter.", "instagram.", "youtube.", "news.ycombinator", "mastodon", "bsky", "t.me", "telegram"];

// AI chat / answer-engine referrers that click straight through to a page. This
// is necessarily partial: most of these surfaces don't reliably send a Referer
// header at all (noreferrer links, JS-driven navigation), and Google's AI
// Overviews and Bing Copilot pass their parent engine's own referrer
// (google./bing.), which is indistinguishable from ordinary search — those stay
// classified as "search" and can't be split out from this list. Checked before
// SEARCH_ENGINES because gemini.google.com would otherwise match "google.".
const AI_ANSWER_ENGINES = ["chatgpt.com", "chat.openai.com", "claude.ai", "perplexity.ai", "gemini.google.com", "copilot.microsoft.com", "you.com", "poe.com"];

// Classify a refererHost into a source type for the dashboard tags.
//
// `selfHost`, when given, is the primary host of the site being measured. A
// referer that maps back to that same site through HOST_ALIASES is internal
// navigation between the site's own hostnames (an apex landing page handing off
// to the forum, say), which is a real and attributable category — it used to be
// dropped on the floor and reappear as an unattributable residual in the traffic
// sources panel. Note this kind is frozen into daily_referrers at write time, so
// it only exists on rows written after 2026-08-13; rows stored before that carry
// no "internal" at all and the panel treats the channel as absent rather than
// measured-zero for those days.
//
// "ai" is the same kind of write-time-frozen classification, added later still:
// rows stored before this shipped keep whatever they were classified as then
// (usually "ref"). Unlike "internal" it isn't promoted to its own channel in the
// traffic-source mix — see summarizeSources in index.js, which folds "ai" into
// "referral" for the aggregate and only exposes it as a badge on individual
// referrer rows, because the undercount above is too large to headline as a
// measured channel.
export function classifyReferrer(refHost, selfHost = null) {
  if (!refHost) return "direct";
  const h = refHost.toLowerCase();
  if (selfHost && HOST_ALIASES.get(refHost) === selfHost) return "internal";
  if (AI_ANSWER_ENGINES.some((s) => h.includes(s))) return "ai";
  if (SEARCH_ENGINES.some((s) => h.includes(s))) return "search";
  if (SOCIAL.some((s) => h.includes(s))) return "social";
  return "ref";
}
