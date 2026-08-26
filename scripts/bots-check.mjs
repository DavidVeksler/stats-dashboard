// Checks the crawler-flood classifier against the real Aug 2026 traffic shapes.
// This is pure logic with no network, so unlike the rest of the project it can
// be verified directly — and it is the piece most worth verifying, since a false
// positive silently deletes real traffic from the dashboard.
import {
  classifyTraffic, splitDay, directRatioStats, crawlerAccounting, summarizeVerifiedBots,
  summarizeNonContent, isNonContentPath, UNVERIFIED_CATEGORY, RATIO_MIN_CLEAN_DAYS,
} from "../src/bots.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return;
  failures += 1;
  console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
}

// Build daily_traffic + daily_referrers rows for one host from a compact spec.
function rows(host, days) {
  const traffic = [], referrers = [];
  days.forEach((day, index) => {
    const date = `2026-07-${String(index + 1).padStart(2, "0")}`;
    const visits = day.visits;
    const views = Math.round(visits * (day.pps ?? 1.0));
    traffic.push({ date, host, visits, views });
    referrers.push({ date, host, kind: "direct", visits: Math.round(visits * (day.direct ?? 1.0)) });
    referrers.push({ date, host, kind: "search", visits: visits - Math.round(visits * (day.direct ?? 1.0)) });
  });
  return { traffic, referrers };
}

const floodsFor = (host, days) => {
  const { traffic, referrers } = rows(host, days);
  const classified = classifyTraffic(traffic, referrers);
  return [...classified.get(host).values()].filter((day) => day.flood).length;
};

// 1. The sustained flood that the old median-based test missed. Eight of fourteen
//    days are crawler traffic, so a median baseline sits inside the flood itself.
const forum = [
  { visits: 625 }, { visits: 803 }, { visits: 1223 }, { visits: 1431 },
  { visits: 5824 }, { visits: 2300 }, { visits: 38131 }, { visits: 21320 },
  { visits: 13837 }, { visits: 3021 }, { visits: 19797 }, { visits: 31471 },
  { visits: 17118 }, { visits: 9314 },
];
check("sustained flood is caught", floodsFor("forum", forum) >= 6, true);
check("pre-flood days stay human", floodsFor("forum", forum) <= 9, true);

// 2. The single-day spike (wiki.freecapitalists.org: ~20/day, then 10k, then back).
const wiki = [
  ...Array.from({ length: 11 }, () => ({ visits: 20 })),
  { visits: 10426 }, { visits: 8809 }, { visits: 63 },
];
check("isolated spike is caught", floodsFor("wiki", wiki), 2);

// 3. A real site must never be flagged. Humans click through and arrive referred.
const human = [
  ...Array.from({ length: 13 }, () => ({ visits: 250, pps: 1.4, direct: .6 })),
  { visits: 900, pps: 1.5, direct: .55 }, // a genuine traffic spike, still human-shaped
];
check("human traffic is never flagged", floodsFor("human", human), 0);

// 4. A flat, direct-heavy, but small site (a one-page site with no referrers) is
//    below the volume floor and must stay untouched.
const tiny = Array.from({ length: 14 }, () => ({ visits: 40, pps: 1.0, direct: 1.0 }));
check("small flat sites stay untouched", floodsFor("tiny", tiny), 0);

// 5. A flat direct site that genuinely grows 10x but stays under the floor.
const smallGrowth = [...Array.from({ length: 13 }, () => ({ visits: 30 })), { visits: 300 }];
check("growth below the volume floor is not a flood", floodsFor("smallGrowth", smallGrowth), 0);

// 6. Referrer-heavy traffic at flood volume is a viral link, not a crawler.
const viral = [
  ...Array.from({ length: 13 }, () => ({ visits: 200, pps: 1.3, direct: .5 })),
  { visits: 20000, pps: 1.25, direct: .2 },
];
check("a viral spike is not a crawler flood", floodsFor("viral", viral), 0);

// 7. A flooded day must not zero out the site: the referred sessions are still a
//    measured human floor, and only the direct bucket is discarded. This is the
//    freecapitalists.org Aug 2026 case, where a 1,689-session flood on the only
//    day in view left the whole card blank.
const floodedSplit = (host, days, index) => {
  const { traffic, referrers } = rows(host, days);
  const classified = classifyTraffic(traffic, referrers);
  return splitDay([...classified.get(host).values()][index]);
};
const oneDayFlood = [
  ...Array.from({ length: 13 }, () => ({ visits: 26, pps: 1.4, direct: .6 })),
  { visits: 1689, pps: 1.08, direct: .99 },
];
const floodDay = floodedSplit("fc", oneDayFlood, 13);
check("a flooded day still reports its referred sessions", floodDay.human, 1689 - 1672);
check("a flooded day's direct bucket is the crawler figure", floodDay.crawler, 1672);
check("a flooded day is marked partial", floodDay.partial, true);
check("a flooded day's pageviews stay unattributed", floodDay.views, 0);

const cleanDay = floodedSplit("fc", oneDayFlood, 0);
check("a clean day is counted whole", cleanDay.human, 26);
check("a clean day reports no crawler traffic", cleanDay.crawler, 0);
check("a clean day is not partial", cleanDay.partial, false);

// 8. Zone-sourced hosts are routed to their own accounting, and must never fall
//    through to the flood classifier's implicit "not flooded, therefore human".
//
//    First, why the routing has to exist: the zone log carries no referer
//    dimension, so a zone host writes no daily_referrers rows at all. directShare
//    is then 0 for every day, `signature` is false for every day, and no volume
//    whatsoever can flag one. Reproduce that here with library's real shape.
{
  const ZONE = "library.freecapitalists.org";
  const zoneDays = [
    ...Array.from({ length: 13 }, () => ({ visits: 60 })),
    { visits: 1059 }, // 17x the baseline, flat, entirely unreferred
  ];
  const { traffic } = rows(ZONE, zoneDays);
  // No referrer rows: exactly what a zone-sourced host produces.
  const classified = classifyTraffic(traffic, []);
  const days = [...classified.get(ZONE).values()];
  check("a zone host can never be flagged as flooded, at any volume",
    days.filter((day) => day.flood).length, 0);
  // ...and this is the reading that would follow if nothing else were done.
  check("...so the flood path would call every one of its visits human",
    splitDay(days.at(-1)).human, 1059);
  check("...and would report zero crawler traffic for it", splitDay(days.at(-1)).crawler, 0);

  // Therefore the routing: a zone-sourced site goes to the zone decomposition,
  // whichever field the caller carries it in.
  check("a zone-sourced site routes to the zone decomposition",
    crawlerAccounting({ measurement: "zone" }), "zone");
  check("...by the boolean form too", crawlerAccounting({ zoneSourced: true }), "zone");
  check("a RUM site still routes to the flood classifier",
    crawlerAccounting({ measurement: "rum" }), "flood");
  check("...and so does a site that says nothing", crawlerAccounting({}), "flood");
}

// 9. The verified-bot lens is a floor. It must expose no human figure and no
//    remainder that could be mistaken for one — the unverified bucket is 84.6% of
//    library's real 2026-08-12 day and mixes readers with unlabelled crawlers.
{
  const summary = summarizeVerifiedBots([
    { category: UNVERIFIED_CATEGORY, requests: 18538, visits: 900 },
    { category: "Archiver", requests: 936, visits: 60 },
    { category: "Search Engine Crawler", requests: 867, visits: 55 },
    { category: "AI Crawler", requests: 696, visits: 40 },
    { category: "Search Engine Optimization", requests: 446, visits: 30 },
    { category: "AI Search", requests: 405, visits: 25 },
    { category: "Page Preview", requests: 21, visits: 3 },
    { category: "Monitoring & Analytics", requests: 10, visits: 2 },
    { category: "Accessibility", requests: 8, visits: 1 },
  ]);
  check("verified requests are summed across categories", summary.verifiedRequests, 3389);
  check("verified visits are summed too, so the card can decompose zone visits",
    summary.verifiedVisits, 216);
  check("the unverified bucket is kept, named, and separate", summary.unverifiedRequests, 18538);
  check("the floor is a minority of the day, which is the point",
    summary.verifiedShare < .16, true);
  check("categories are ranked by requests", summary.categories[0].category, "Archiver");
  check("...and the unverified bucket is not one of them",
    summary.categories.some((row) => row.category === UNVERIFIED_CATEGORY), false);
  // The whole point of item 2: nothing here asserts, or can be trivially turned
  // into, a human count for a zone host.
  for (const field of ["human", "humanRequests", "humanVisits", "likelyHuman", "remainder"]) {
    check(`no ${field} field is derived from a verified-bot floor`, field in summary, false);
  }
  check("a host with no rows yet is marked unmeasured, not zero-crawler",
    summarizeVerifiedBots([]).measured, false);
}

// 10. The non-content lens, from tables that already exist. Two components, kept
//     apart: they overlap each other and there is no (path, status) pair stored
//     anywhere to measure the overlap with.
{
  check("robots.txt is non-content", isNonContentPath("/robots.txt"), true);
  check("a sitemap variant is non-content", isNonContentPath("/sitemap_index.xml"), true);
  check("a well-known probe is non-content", isNonContentPath("/.well-known/security.txt"), true);
  check("a Cloudflare endpoint is non-content", isNonContentPath("/cdn-cgi/trace"), true);
  check("a real file is content", isNonContentPath("/books/mises.pdf"), false);
  check("a path merely containing robots.txt is content",
    isNonContentPath("/books/robots.txt.pdf"), false);

  const nonContent = summarizeNonContent(
    // Zone daily_cf_pages rows carry requests in `visits`.
    [{ page: "/robots.txt", visits: 684 }, { page: "/favicon.ico", visits: 42 },
      { page: "/cdn-cgi/trace", visits: 230 }, { page: "/books/mises.pdf", visits: 141 }],
    [{ status: 200, requests: 15200 }, { status: 404, requests: 1745 }, { status: 406, requests: 769 }],
  );
  check("non-content paths are summed", nonContent.pathRequests, 684 + 42 + 230);
  check("...and content paths are left out", nonContent.paths.length, 3);
  check("error responses are summed", nonContent.errorRequests, 1745 + 769);
  check("...and 2xx responses are left out", nonContent.errorStatuses.length, 2);
  for (const field of ["requests", "total", "nonContentRequests", "contentRequests"]) {
    check(`the two components are never merged into a ${field} total`, field in nonContent, false);
  }
}

// 11. The ratio estimator. A flooded day's direct bucket used to be discarded
//     whole; with enough clean-day history it now gets a point estimate (that
//     host's own typical direct/referred ratio on ordinary days) instead,
//     always alongside a spread so it is never shown with more precision than
//     it has. See the comment above splitDay and directRatioStats in bots.js.
{
  // A host with exactly RATIO_MIN_CLEAN_DAYS clean days at a fixed 1.5 ratio
  // (visits: 100, 60 direct / 40 referred, every day), then one 3x flood.
  const RATIO_HOST = "ratio";
  const ratioDays = [
    ...Array.from({ length: RATIO_MIN_CLEAN_DAYS }, () => ({ visits: 100, pps: 1.4, direct: .6 })),
    { visits: 1000, pps: 1.0, direct: .99 },
  ];
  const { traffic: rTraffic, referrers: rReferrers } = rows(RATIO_HOST, ratioDays);
  const rClassified = classifyTraffic(rTraffic, rReferrers);
  const rStats = directRatioStats(rClassified, RATIO_HOST);
  check("enough clean days produces a ratio", rStats?.sampleDays, RATIO_MIN_CLEAN_DAYS);
  check("...median matches the fixed clean-day ratio (60/40)", rStats?.median, 1.5);
  check("...MAD is zero when every clean day agrees", rStats?.mad, 0);

  const rFlood = [...rClassified.get(RATIO_HOST).values()].at(-1);
  check("fixture check: the last day is the flood", rFlood.flood, true);
  const rEstimated = splitDay(rFlood, rStats);
  // nonDirect=10, direct=990: estimatedDirect = min(990, 10*1.5=15) = 15.
  check("estimated human is referred plus the ratio-scaled direct share", rEstimated.human, 25);
  check("...crawler is whatever the estimate leaves over", rEstimated.crawler, 975);
  check("...flagged as an estimate, not a bare floor", rEstimated.estimated, true);
  check("...with zero spread when the clean-day ratio never varied", rEstimated.spread, 0);
  check("...and the estimated-direct portion is exposed for the source mix", rEstimated.estimatedDirect, 15);

  // Below RATIO_MIN_CLEAN_DAYS, the same host falls back to the floor-only
  // split — omitting ratioStats entirely, exactly like the pre-estimator
  // callers in test 7 above, must behave identically.
  const thinDays = [
    ...Array.from({ length: RATIO_MIN_CLEAN_DAYS - 1 }, () => ({ visits: 100, pps: 1.4, direct: .6 })),
    { visits: 1000, pps: 1.0, direct: .99 },
  ];
  const { traffic: tTraffic, referrers: tReferrers } = rows("thin", thinDays);
  const tClassified = classifyTraffic(tTraffic, tReferrers);
  check("one day short of the minimum yields no ratio at all",
    directRatioStats(tClassified, "thin"), null);
  const tFlood = [...tClassified.get("thin").values()].at(-1);
  const tFloor = splitDay(tFlood, directRatioStats(tClassified, "thin"));
  check("...so splitDay falls back to the floor", tFloor.human, tFlood.nonDirect);
  check("...not flagged as an estimate", tFloor.estimated, false);
  check("a host absent from the classified map has no ratio", directRatioStats(rClassified, "nobody"), null);

  // The estimate can never claim more direct humans than were measured as
  // direct at all: a ratio built from a very different (low-direct-share) clean
  // history must not blow past the flooded day's own direct count.
  const capDay = { visits: 1000, direct: 20, nonDirect: 980, flood: true };
  const capStats = { median: 5, mad: 0, sampleDays: 10 };
  const capped = splitDay(capDay, capStats);
  check("the estimate is capped at the day's own measured direct count", capped.estimatedDirect, 20);
  check("...so human can reach the full visit count but never exceed it", capped.human, 1000);
  check("...leaving zero crawler volume, not a negative one", capped.crawler, 0);

  // The displayed spread is clamped into [nonDirect, visits] — a noisy ratio
  // (large MAD) must not print a margin wider than the hard counts allow.
  const spreadDay = { visits: 100, direct: 90, nonDirect: 10, flood: true };
  const noisyStats = { median: 1, mad: 50, sampleDays: 10 };
  const clamped = splitDay(spreadDay, noisyStats);
  // estimatedDirect = min(90, 10*1=10) = 10, human = 20; raw spread would be
  // 10*50=500, clamped to min(500, human-nonDirect=10, visits-human=80) = 10.
  check("a noisy ratio's spread is clamped, not printed raw", clamped.spread, 10);

  // Median resists a single outlier clean day the way a mean would not — the
  // same reason the flood baseline itself uses median over mean (see the
  // comment on `baseline` in classifyTraffic).
  const outlierDays = new Map([
    ["d1", { signature: false, nonDirect: 40, direct: 40 }],
    ["d2", { signature: false, nonDirect: 40, direct: 40 }],
    ["d3", { signature: false, nonDirect: 40, direct: 40 }],
    ["d4", { signature: false, nonDirect: 40, direct: 40 }],
    ["d5", { signature: false, nonDirect: 40, direct: 40 }],
    ["d6", { signature: false, nonDirect: 10, direct: 100 }], // ratio 10, the outlier
  ]);
  const outlierStats = directRatioStats(new Map([["outlier", outlierDays]]), "outlier");
  check("the median ignores a single outlier clean day", outlierStats.median, 1);
  check("...but the outlier is still counted in the sample size", outlierStats.sampleDays, 6);

  // A signature-shaped "clean" day (i.e. one that looks like a flood but never
  // crossed the volume floor) must not contaminate the ratio pool, and neither
  // should a day with zero referred sessions (undefined ratio).
  const mixedDays = new Map([
    ["d1", { signature: false, nonDirect: 40, direct: 40 }],
    ["d2", { signature: false, nonDirect: 40, direct: 40 }],
    ["d3", { signature: false, nonDirect: 40, direct: 40 }],
    ["d4", { signature: false, nonDirect: 40, direct: 40 }],
    ["d5", { signature: false, nonDirect: 40, direct: 40 }],
    ["d6", { signature: true, nonDirect: 1, direct: 999 }],   // flood-shaped, excluded
    ["d7", { signature: false, nonDirect: 0, direct: 0 }],    // no referred traffic at all
  ]);
  const mixedStats = directRatioStats(new Map([["mixed", mixedDays]]), "mixed");
  check("a flood-shaped day never joins the clean-day ratio pool", mixedStats.sampleDays, 5);
}

if (failures) {
  console.error(`\n${failures} bot-classifier check(s) failed`);
  process.exit(1);
}
console.log("Bot classifier checks passed");
