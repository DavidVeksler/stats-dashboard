// Checks the current-browser rule against the real 2026-10-29 traffic shapes,
// plus the two zone-host lenses. Pure logic with no network, and the piece most
// worth verifying: a rule that counts a crawler fills the page with fiction, and
// one that drops real visitors hides the audience.
import {
  browserMajor, currentBrowsers, isCurrentBrowser, countedBrowserClauses, BROWSER_LAG, BROWSER_LEAD,
  isDirectOnlySegment, segmentExclusions, SEGMENT_MIN_VISITS, SEGMENT_DIRECT_SHARE,
  crawlerAccounting, summarizeVerifiedBots, summarizeNonContent, isNonContentPath, UNVERIFIED_CATEGORY,
} from "../src/bots.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return;
  failures += 1;
  console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
}

// Referred sessions by (browser, version) over 7 days, estate-wide, as pulled
// 2026-10-29 (abridged). Chrome 146 is mostly the aocr.org referral bot (390 of
// 400), ChromeMobile 443/444 are real Google-app visitors on iOS, whose version
// is the app's, not Chrome's.
const EVIDENCE = [
  ...[[156, 297], [155, 366], [154, 63], [153, 22], [151, 22], [150, 30], [148, 20], [146, 400], [139, 22], [133, 20], [124, 10]]
    .map(([v, n]) => ({ browser: "Chrome", version: String(v), visits: n })),
  ...[[444, 10], [443, 31], [398, 1], [157, 10], [156, 146], [155, 328], [154, 10], [153, 10], [151, 10], [138, 10], [116, 1]]
    .map(([v, n]) => ({ browser: "ChromeMobile", version: String(v), visits: n })),
  ...[[156, 147], [155, 106], [154, 11], [151, 10]].map(([v, n]) => ({ browser: "Edge", version: String(v), visits: n })),
  ...[["27.0", 103], ["26.6", 143], ["18.6", 22], ["16.6", 10]].map(([v, n]) => ({ browser: "MobileSafari", version: v, visits: n })),
  ...[[158, 94], [157, 10], [156, 14], [115, 10]].map(([v, n]) => ({ browser: "Firefox", version: String(v), visits: n })),
  { browser: "Unknown", version: "153", visits: 10 },
  { browser: "Unknown", version: "", visits: 36 },
  { browser: "Opera", version: "153", visits: 2 },
];
const current = currentBrowsers(EVIDENCE);
const newestOf = (browser) => (current.get(browser) ?? []).map((s) => s.newest).join(",");

// 1. The newest version is the highest one real visitors use, not the most common.
check("Chrome's newest is 156, not the referral bot's 146", newestOf("Chrome"), "156");
check("Edge's newest is 156", newestOf("Edge"), "156");
check("Firefox's newest is 158 (157/156 too thin to matter, and below it anyway)", newestOf("Firefox"), "158");
check("Mobile Safari's newest is 27", newestOf("MobileSafari"), "27");

// 2. One family, two series: ChromeMobile carries Chrome's 15x and the Google app's 44x.
check("ChromeMobile has a Chrome series and a Google-app series", newestOf("ChromeMobile"), "156,444");
check("...so a real Android Chrome 156 visitor counts", isCurrentBrowser(current, "ChromeMobile", "156"), true);
check("...and so does a Google-app 443 visitor", isCurrentBrowser(current, "ChromeMobile", "443"), true);
check("...but 157 at 10 of ~540 is not mistaken for the newest", newestOf("ChromeMobile").startsWith("157"), false);

// 3. The window: BROWSER_LAG behind to BROWSER_LEAD ahead.
check(`lag is ${BROWSER_LAG}`, BROWSER_LAG, 2);
check(`lead is ${BROWSER_LEAD}`, BROWSER_LEAD, 1);
check("Chrome 154 counts (2 behind)", isCurrentBrowser(current, "Chrome", "154"), true);
check("Chrome 157 counts (the next release, mid-rollout)", isCurrentBrowser(current, "Chrome", "157"), true);
check("Chrome 158 does not (two ahead is a forged or dev build)", isCurrentBrowser(current, "Chrome", "158"), false);
check("Chrome 153 does not: the forum crawler's version", isCurrentBrowser(current, "Chrome", "153"), false);
check("Chrome 146 does not: the aocr.org referral bot", isCurrentBrowser(current, "Chrome", "146"), false);
check("Chrome 103 does not: the oldest of the wiki fleet", isCurrentBrowser(current, "Chrome", "103"), false);
check("Chrome 151 does not: the wiki fleet's busiest version", isCurrentBrowser(current, "Chrome", "151"), false);

// 4. Apple went from 18 straight to 26, so 18 is one release behind 26.
check("Safari 18 maps to 25", browserMajor("MobileSafari", "18.6"), 25);
check("...so it is still current against 27", isCurrentBrowser(current, "MobileSafari", "18.6"), true);
check("Safari 16 is not", isCurrentBrowser(current, "MobileSafari", "16.6"), false);
check("the renumbering applies to Apple families only", browserMajor("Chrome", "18"), 18);

// 5. Fail closed on anything without a usable version or enough evidence.
check("an Unknown browser never counts, whatever its version", isCurrentBrowser(current, "Unknown", "153"), false);
check("a browser with no version never counts", isCurrentBrowser(current, "Chrome", ""), false);
check("a family with too little evidence has no newest", current.has("Opera"), false);
check("...so it does not count", isCurrentBrowser(current, "Opera", "153"), false);
check("no evidence at all means nothing counts", currentBrowsers([]).size, 0);

// 6. The wiki.freecapitalists.org fleet on 2026-10-29: 165k direct sessions spread
//    evenly over Chrome 103-151. Every one of them is set aside.
{
  const fleet = Array.from({ length: 49 }, (_, i) => ({ browser: "Chrome", version: String(103 + i), visits: 3380 }));
  const people = [{ browser: "Chrome", version: "156", visits: 5 }, { browser: "ChromeMobile", version: "156", visits: 3 }];
  const counted = [...fleet, ...people].filter((r) => isCurrentBrowser(current, r.browser, r.version))
    .reduce((sum, r) => sum + r.visits, 0);
  check("the wiki fleet is set aside whole; only the people count", counted, 8);
}

// 7. The server-side filter lists exactly the version strings that count, from
//    the census of strings actually seen, grouped by browser.
{
  const census = [
    { browser: "Chrome", version: "156" }, { browser: "Chrome", version: "151" },
    { browser: "Chrome", version: "155" }, { browser: "Chrome", version: "156" },
    { browser: "MobileSafari", version: "27.0" }, { browser: "MobileSafari", version: "18.6" },
    { browser: "Unknown", version: "153" },
  ];
  const clauses = countedBrowserClauses(current, census);
  check("one clause per counted browser", clauses.length, 2);
  check("...Chrome's counted strings, deduplicated", JSON.stringify(clauses[0]),
    JSON.stringify({ userAgentBrowser: "Chrome", browserVersion_in: ["155", "156"] }));
  check("...Safari's exact strings, minor version included", JSON.stringify(clauses[1].browserVersion_in),
    JSON.stringify(["18.6", "27.0"]));
  check("nothing counted means no clauses (the caller must not send an empty OR)",
    countedBrowserClauses(new Map(), census).length, 0);
}

// 8. The second rule: a crawler that sends a current browser version, caught as
//    a large, almost entirely direct desktop segment. Real segments from the
//    same eight nights (2026-10-22..29) must stay counted.
{
  const seg = (os, visits, directShare) => ({ os, visits, direct: Math.round(visits * directShare) });
  check("forum crawler, Chrome 156 macOS, 777 at 100% direct", isDirectOnlySegment(seg("MacOSX", 777, 1)), true);
  check("forum crawler, Chrome 156 Linux, 100 at 100% direct (1.61 pages/session)", isDirectOnlySegment(seg("Linux", 100, 1)), true);
  check("forum crawler at the volume floor", isDirectOnlySegment(seg("Windows", SEGMENT_MIN_VISITS, .99)), true);
  check("...but not one session under it", isDirectOnlySegment(seg("Windows", SEGMENT_MIN_VISITS - 1, 1)), false);
  check("forum regulars, Chrome 156 Windows, 49 at 90% direct", isDirectOnlySegment(seg("Windows", 49, .9)), false);
  check("forum regulars, 60 at 93% direct, the most direct real segment seen", isDirectOnlySegment(seg("Windows", 60, .93)), false);
  check(`the share floor is ${SEGMENT_DIRECT_SHARE}`, isDirectOnlySegment({ os: "Windows", visits: 100, direct: 96 }), false);
  check("cheatsheets iPhone readers stay counted at any direct share (apps strip referrers)",
    isDirectOnlySegment(seg("iOS", 400, 1)), false);
  check("...and so do Android ones", isDirectOnlySegment(seg("Android", 400, 1)), false);
  const exclusions = segmentExclusions([{ rawHost: "forum.example", browser: "Chrome", version: "156", os: "Linux" }]);
  check("each flagged segment becomes one NOT clause, written as an OR of _neq", JSON.stringify(exclusions),
    JSON.stringify([{ OR: [{ requestHost_neq: "forum.example" }, { userAgentBrowser_neq: "Chrome" },
      { browserVersion_neq: "156" }, { userAgentOS_neq: "Linux" }] }]));
}

// 9. Zone-sourced hosts are routed to their own accounting: the browser rule
//    needs a user agent, which the zone log does not carry.
check("a zone-sourced site routes to the zone decomposition", crawlerAccounting({ measurement: "zone" }), "zone");
check("...by the boolean form too", crawlerAccounting({ zoneSourced: true }), "zone");
check("a RUM site routes to the browser rule", crawlerAccounting({ measurement: "rum" }), "browser");
check("...and so does a site that says nothing", crawlerAccounting({}), "browser");

// 10. The verified-bot lens is a floor. It must expose no human figure and no
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

// 11. The non-content lens, from tables that already exist. Two components, kept
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



if (failures) {
  console.error(`\n${failures} browser-rule check(s) failed`);
  process.exit(1);
}
console.log("Browser rule and zone-lens checks passed");
