// The domains to track. `host` is the Cloudflare Web Analytics requestHost;
// `gsc` is the exact Search Console property string (sc-domain: or URL-prefix).
// `gscPageFilter`, when present, limits a broader property to matching page URLs.
export const SITES = [
  {
    host: "forum.objectivismonline.com",
    gsc: "https://forum.objectivismonline.com/",
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
  { host: "wiki.freecapitalists.org", gsc: "https://wiki.freecapitalists.org/" },
  { host: "davidveksler.freecapitalists.org", gsc: "https://davidveksler.freecapitalists.org/" },
  { host: "whopaysforai.org", gsc: "sc-domain:whopaysforai.org" },

];

export const TARGET_HOSTS = new Set(SITES.map((s) => s.host));

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
