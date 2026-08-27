// Checks the pure parsing half of the Bing Webmaster Tools pull (src/bing.js).
// queryRankAndTraffic/queryKeywords need a live fetch, so this exercises
// parseBingDate and latestDateRows directly, offline, the same way the rest of
// this project keeps pure logic testable (see discourse-check.mjs).
import { parseBingDate, latestDateRows, diffBingSites } from "../src/bing.js";

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
  diff.missing.map((r) => r.host).join(","), "nobing.example");
check("diffBingSites: an alias host counts as tracked, not untracked",
  diff.untracked.some((r) => r.url.includes("apex")), false);
check("diffBingSites: a Bing property on no SITES row is untracked",
  diff.untracked.map((r) => r.url).join(","), "https://stranger.example/");

if (failures) {
  console.error(`\n${failures} bing check(s) failed`);
  process.exit(1);
}
console.log("Bing Webmaster Tools checks passed");
