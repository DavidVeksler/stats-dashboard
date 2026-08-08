// Checks the crawler-flood classifier against the real Aug 2026 traffic shapes.
// This is pure logic with no network, so unlike the rest of the project it can
// be verified directly — and it is the piece most worth verifying, since a false
// positive silently deletes real traffic from the dashboard.
import { classifyTraffic } from "../src/bots.js";

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

if (failures) {
  console.error(`\n${failures} bot-classifier check(s) failed`);
  process.exit(1);
}
console.log("Bot classifier checks passed");
