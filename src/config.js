// The domains to track. `host` is the Cloudflare Web Analytics requestHost;
// `gsc` is the exact Search Console property string (sc-domain: or URL-prefix).
// `gscPageFilter`, when present, limits a broader property to matching page URLs.
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
    gsc: "https://cheatsheets.davidveksler.com/",
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
  { host: "freecapitalists.org", gsc: "https://freecapitalists.org/" },
  { host: "wiki.freecapitalists.org", gsc: "sc-domain:wiki.freecapitalists.org" },
  // http://, not https:// — the Search Console property was registered on the
  // http prefix, and URL-prefix properties are protocol-exact. Querying the
  // https form 403s, which silently zeroed this site's search data every run.
  { host: "davidveksler.freecapitalists.org", gsc: "http://davidveksler.freecapitalists.org/" },
  { host: "whopaysforai.org", gsc: "sc-domain:whopaysforai.org" },
  { host: "oneminute.freecapitalists.org", gsc: "https://oneminute.freecapitalists.org/" },
  // File-host subdomain (PDF/EPUB/MP3/MP4 payloads, no HTML pages), so the Web
  // Analytics RUM beacon never fires here. trafficSource: "zone" routes traffic
  // to Cloudflare's zone-level HTTP request log (httpRequestsAdaptiveGroups)
  // instead — see pullZoneTraffic in cloudflare.js. gsc is independent of
  // trafficSource and still queries Search Console for keyword/page data.
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

// Classify a refererHost into a source type for the dashboard tags.
export function classifyReferrer(refHost) {
  if (!refHost) return "direct";
  const h = refHost.toLowerCase();
  if (SEARCH_ENGINES.some((s) => h.includes(s))) return "search";
  if (SOCIAL.some((s) => h.includes(s))) return "social";
  return "ref";
}
