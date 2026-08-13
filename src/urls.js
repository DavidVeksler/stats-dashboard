// Shared URL-shape predicates.
//
// `looksMalformed` exists because broken pagination markup on WordPress sites
// gets crawled and indexed as real URLs. Two live examples from
// davidveksler.freecapitalists.org (2026-08-13), both served with a 200:
//
//   /category/austrian-economics/%3E%C3%97%3C/span%3E8%3C/span%3E
//   /category/uncategorized/page/2/%3E%C3%97%3C/span%3E4%3C/span%3E
//
// Those are a closing `</span>` tag that leaked into an href, percent-encoded by
// the crawler. They are crawl and index pollution, and they sit in the landing
// page list as ordinary rows.
//
// This is deliberately a false-negative-biased predicate. A missed malformed URL
// costs nothing; a false positive would badge a real page (item 10) and inflate
// the `malformed-urls` signal, which is why the standalone tag-fragment list is
// tiny and excludes every segment that is plausible in a real path (`/img`,
// `/p`, `/a`, `/em`, `/script` are all common and are NOT matched on their own).
//
// Item 10 of docs/actionability-spec.md owns the per-row badging that also uses
// this; today it feeds only the `malformed-urls` signal in src/signals.js.

// Percent-encoded `<` (%3C) or `>` (%3E) anywhere in the path.
const PERCENT_ANGLE = /%3[ce]/i;

// A raw angle bracket that survived into the stored path.
const RAW_ANGLE = /[<>]/;

// A tag fragment sitting next to an angle bracket, encoded or not:
// `%3C/span%3E`, `</div>`, `%3Escript`. Safe to list broadly because the
// bracket is what makes it markup rather than a path segment.
const BRACKETED_TAG = /(?:%3[ce]|[<>])\s*\/?\s*(?:span|div|p|a|b|i|br|em|strong|li|ul|ol|td|tr|img|script|iframe|style)\b/i;

// A tag fragment standing on its own as a path segment. Only names that are not
// plausible real path segments on these sites — `/img/…`, `/p/…`, `/a/…` and
// `/scripts/…` are all real URLs somewhere, so none of them are here.
const BARE_TAG_SEGMENT = /\/(?:span|iframe|noscript)(?:%3e|>|\/|$)/i;

export function looksMalformed(path) {
  const raw = String(path ?? "");
  if (!raw) return false;
  if (PERCENT_ANGLE.test(raw) || RAW_ANGLE.test(raw)) return true;
  if (BRACKETED_TAG.test(raw)) return true;
  if (BARE_TAG_SEGMENT.test(raw)) return true;
  // Doubled slashes anywhere after the leading one: `/a//b`. Checked on the
  // slice so a stored absolute URL ("https://host/x") is not flagged for its
  // scheme separator.
  if (raw.slice(1).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").includes("//")) return true;
  // A percent sequence that decodes to markup, and a percent sequence that
  // cannot be decoded at all — a path the origin could not have generated.
  try {
    return RAW_ANGLE.test(decodeURIComponent(raw));
  } catch (_) {
    return true;
  }
}
