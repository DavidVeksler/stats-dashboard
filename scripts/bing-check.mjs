// Checks the pure parsing half of the Bing Webmaster Tools pull (src/bing.js).
// queryRankAndTraffic/queryKeywords need a live fetch, so this exercises
// parseBingDate and latestDateRows directly, offline, the same way the rest of
// this project keeps pure logic testable (see discourse-check.mjs).
import { parseBingDate, latestDateRows } from "../src/bing.js";

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

if (failures) {
  console.error(`\n${failures} bing check(s) failed`);
  process.exit(1);
}
console.log("Bing Webmaster Tools checks passed");
