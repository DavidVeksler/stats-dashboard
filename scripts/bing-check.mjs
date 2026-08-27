// Checks the pure parsing half of the Bing Webmaster Tools pull (src/bing.js).
// queryRankAndTraffic/queryKeywords need a live fetch, so this exercises
// parseBingDate and latestDateRows directly, offline, the same way the rest of
// this project keeps pure logic testable (see discourse-check.mjs).
import { parseBingDate, latestDateRows, diffBingSites, bingUrlsOf,
  mergeBingWindows, mergeBingSummaries, mergeBingKeywords } from "../src/bing.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return;
  failures += 1;
  console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
}

// Microsoft's own documented JSON sample for GetQueryStats/GetRankAndTrafficStats.
check("parseBingDate: with UTC offset", parseBingDate("/Date(1316156400000-0700)/"), "2011-09-16");
check("parseBingDate: without offset", parseBingDate("/Date(1399100400000)/"), "2014-05-03");
check("parseBingDate: malformed", parseBingDate("not a date"), null);
check("parseBingDate: empty", parseBingDate(""), null);
check("parseBingDate: undefined", parseBingDate(undefined), null);

// GetQueryStats/GetPageStats return the site's ENTIRE stored history in one
// call (no date-range parameter, unlike GSC) — latestDateRows is what keeps a
// nightly pull from storing months of rows. Three queries across two dates,
// the newer date should win and only its two rows should survive.
const mixed = latestDateRows([
  { Query: "old query", Date: "/Date(1316070000000-0700)/", Clicks: 1, Impressions: 10 }, // 2011-09-15
  { Query: "new query a", Date: "/Date(1316156400000-0700)/", Clicks: 2, Impressions: 20 }, // 2011-09-16
  { Query: "new query b", Date: "/Date(1316156400000-0700)/", Clicks: 3, Impressions: 30 }, // 2011-09-16
]);
check("latestDateRows: picks the newest date", mixed.date, "2011-09-16");
check("latestDateRows: keeps only that date's rows", mixed.rows.length, 2);
check("latestDateRows: drops the older row", mixed.rows.some((r) => r.Query === "old query"), false);

const empty = latestDateRows([]);
check("latestDateRows: empty input date", empty.date, null);
check("latestDateRows: empty input rows", empty.rows.length, 0);

const unparsable = latestDateRows([{ Query: "x", Date: "garbage", Clicks: 1, Impressions: 1 }]);
check("latestDateRows: all-unparsable dates -> null", unparsable.date, null);

// diffBingSites reconciles SITES' `bing` fields against a live GetUserSites
// list. The case that matters is the near-miss: Bing's URLs are protocol- and
// slash-exact, so an https:// config string against an http:// verification is
// a broken pull that looks fine in a diff of hostnames.
const diff = diffBingSites([
  { host: "ok.example", bing: "https://ok.example/" },
  { host: "protocol.example", bing: "https://protocol.example/" },
  { host: "gone.example", bing: "https://gone.example/" },
  { host: "nobing.example" },
  { host: "apex.example", alsoHosts: ["www.apex.example"] },
], [
  { url: "https://ok.example/", verified: true },
  { url: "http://protocol.example/", verified: true },
  { url: "https://nobing.example/", verified: true },
  { url: "https://www.apex.example/", verified: true },
  { url: "https://stranger.example/", verified: true },
]);
check("diffBingSites: an exact match is ok", diff.ok.map((r) => r.host).join(","), "ok.example");
check("diffBingSites: an http/https mismatch is stale, not ok",
  diff.stale.map((r) => r.host).join(","), "protocol.example,gone.example");
check("diffBingSites: ...naming the URL Bing actually has",
  diff.stale.find((r) => r.host === "protocol.example").verifiedAs, "http://protocol.example/");
check("diffBingSites: ...and null when Bing has none for that host",
  diff.stale.find((r) => r.host === "gone.example").verifiedAs, null);
check("diffBingSites: a tracked site Bing verifies but config does not use",
  diff.missing.map((r) => r.host).join(","), "nobing.example,apex.example");
check("diffBingSites: ...an alias host Bing verifies separately counts too",
  diff.missing.find((r) => r.host === "apex.example").verifiedAs, "https://www.apex.example/");
check("diffBingSites: a host with a stale string is not also reported as missing",
  diff.missing.some((r) => r.host === "protocol.example"), false);
check("diffBingSites: an alias host counts as tracked, not untracked",
  diff.untracked.some((r) => r.url.includes("apex")), false);
check("diffBingSites: a Bing property on no SITES row is untracked",
  diff.untracked.map((r) => r.url).join(","), "https://stranger.example/");

// A site whose hostnames Bing verified as separate properties (the live case is
// objectivismonline.com vs forum.objectivismonline.com, one card and one GSC
// domain property here) is pulled per URL and merged into the one row per
// (date, host) the schema allows. The merge must be arithmetic, never an
// average of averages, and must be an exact pass-through for the single-URL
// case every other site is.
check("bingUrlsOf: a plain string is one URL", bingUrlsOf({ bing: "https://a.example/" }).length, 1);
check("bingUrlsOf: an array is each of its URLs", bingUrlsOf({ bing: ["https://a.example/", "https://b.example/"] }).length, 2);
check("bingUrlsOf: no bing field is no URLs", bingUrlsOf({ host: "a.example" }).length, 0);

check("mergeBingWindows: one date stays a date", mergeBingWindows(["2026-08-25"]), "2026-08-25");
check("mergeBingWindows: two dates become a range",
  mergeBingWindows(["2026-08-26", "2026-08-24"]), "2026-08-24–2026-08-26");
check("mergeBingWindows: nothing measured is null", mergeBingWindows([null, undefined]), null);

const oneSummary = { window: "2026-08-25", clicks: 4, impressions: 100, ctr: .04 };
check("mergeBingSummaries: a single property passes through unchanged",
  JSON.stringify(mergeBingSummaries([oneSummary])), JSON.stringify(oneSummary));
// 10% of 10 impressions and 1% of 1,000 must come out at 1.09%, not 5.5%.
const merged = mergeBingSummaries([
  { window: "2026-08-25", clicks: 1, impressions: 10, ctr: .1 },
  { window: "2026-08-24", clicks: 10, impressions: 1000, ctr: .01 },
]);
check("mergeBingSummaries: clicks add", merged.clicks, 11);
check("mergeBingSummaries: impressions add", merged.impressions, 1010);
check("mergeBingSummaries: CTR is recomputed from the totals, not averaged", merged.ctr, 11 / 1010);
check("mergeBingSummaries: a spread of freshness is reported as a range",
  merged.window, "2026-08-24–2026-08-25");
check("mergeBingSummaries: every property failing yields no row", mergeBingSummaries([null, undefined]), null);

const kw = mergeBingKeywords([
  { window: "2026-08-20", rows: [
    { query: "shared", clicks: 2, impressions: 100, avgClickPosition: 4, avgImpressionPosition: 10 },
    { query: "apex only", clicks: 0, impressions: 5, avgClickPosition: -1, avgImpressionPosition: 30 },
  ] },
  { window: "2026-08-20", rows: [
    { query: "shared", clicks: 8, impressions: 900, avgClickPosition: -1, avgImpressionPosition: 20 },
  ] },
]);
const shared = kw.rows.find((r) => r.query === "shared");
check("mergeBingKeywords: one row per query across properties", kw.rows.length, 2);
check("mergeBingKeywords: clicks add", shared.clicks, 10);
check("mergeBingKeywords: impressions add", shared.impressions, 1000);
check("mergeBingKeywords: impression position is impression-weighted",
  shared.avgImpressionPosition, (10 * 100 + 20 * 900) / 1000);
check("mergeBingKeywords: Bing's -1 sentinel is never averaged in as a position",
  shared.avgClickPosition, 4);
check("mergeBingKeywords: ...and a query no property positions keeps the sentinel",
  kw.rows.find((r) => r.query === "apex only").avgClickPosition, -1);
check("mergeBingKeywords: rows come back ranked by impressions", kw.rows[0].query, "shared");

const singleKw = { window: "2026-08-20", rows: [
  { query: "solo", clicks: 3, impressions: 60, avgClickPosition: 2.5, avgImpressionPosition: 7.5 },
] };
const passthrough = mergeBingKeywords([singleKw]);
check("mergeBingKeywords: a single property passes through unchanged",
  JSON.stringify(passthrough.rows), JSON.stringify(singleKw.rows));

if (failures) {
  console.error(`\n${failures} bing check(s) failed`);
  process.exit(1);
}
console.log("Bing Webmaster Tools checks passed");
