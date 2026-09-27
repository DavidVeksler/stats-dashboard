// Checks src/r2.js: the op-class table, the nightly summary, the cost estimate,
// the cache summary, and pullR2's parsing of an aliased GraphQL response. The
// fixture is the real freecapitalists-library response from 2026-09-27, the
// day the library moved to R2 (26,135 PutObject from the migration upload, the
// sync tool's 8,275 HEADs, and the first reader GETs).
import { opClass, summarizeR2, estimateR2Cost, summarizeCache, pullR2, R2_PRICING } from "../src/r2.js";
import { zoneQuery, ZONE_GROUPINGS } from "../src/cloudflare.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return;
  failures += 1;
  console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ---- Op classes, verbatim from the pricing page --------------------------
check("PutObject is class A", opClass("PutObject"), "A");
check("ListObjects is class A", opClass("ListObjects"), "A");
check("GetObject is class B", opClass("GetObject"), "B");
check("HeadObject is class B", opClass("HeadObject"), "B");
check("DeleteObject is free", opClass("DeleteObject"), "free");
// R2 reported these on day one; the pricing page lists neither, so they are
// counted as unlisted rather than guessed into a class.
check("GetBucketSippyConfiguration is unlisted, not guessed", opClass("GetBucketSippyConfiguration"), "unlisted");
check("GetBucketNotificationConfiguration is unlisted", opClass("GetBucketNotificationConfiguration"), "unlisted");

// ---- pullR2 against the real response ------------------------------------
const op = (actionType, actionStatus, requests, responseBytes = 0, responseObjectSize = 0) =>
  ({ sum: { requests, responseBytes, responseObjectSize }, dimensions: { actionType, actionStatus } });
const LIVE = { data: { viewer: { accounts: [{
  ops: [
    op("PutObject", "success", 26135, 0, 163231697558),
    op("HeadObject", "success", 8275),
    op("GetObject", "success", 426, 3758375321, 3758375321),
    op("GetObject", "userError", 280),
    op("ListObjects", "success", 56),
    op("HeadBucket", "success", 5),
    op("PutBucketCors", "success", 3),
    op("ListMultipartUploads", "success", 2),
    op("HeadObject", "userError", 2),
    op("PutBucket", "success", 1),
    op("GetBucketNotificationConfiguration", "userError", 1),
    op("GetBucketSippyConfiguration", "success", 1),
    op("GetBucketLifecycleConfiguration", "success", 1),
    op("GetBucketCors", "success", 1),
  ],
  statuses: [
    { sum: { requests: 34906, responseBytes: 3758375321 }, dimensions: { responseStatusCode: 200 } },
    { sum: { requests: 283, responseBytes: 0 }, dimensions: { responseStatusCode: 404 } },
  ],
  regions: [
    { sum: { requests: 34482, responseBytes: 0 }, dimensions: { eyeballRegion: "WNAM" } },
    { sum: { requests: 679, responseBytes: 3758375321 }, dimensions: { eyeballRegion: "ENAM" } },
  ],
  objects: [
    { sum: { requests: 5, responseBytes: 167161155 }, dimensions: { objectName: "books/Ludwig von Mises/Human Action.pdf" } },
  ],
  missing: [
    { sum: { requests: 21 }, dimensions: { objectName: "" } },
    { sum: { requests: 5 }, dimensions: { objectName: ".env" } },
  ],
  mtd: [
    { sum: { requests: 26135 }, dimensions: { actionType: "PutObject" } },
    { sum: { requests: 8277 }, dimensions: { actionType: "HeadObject" } },
    { sum: { requests: 729 }, dimensions: { actionType: "GetObject" } },
    { sum: { requests: 56 }, dimensions: { actionType: "ListObjects" } },
    { sum: { requests: 1 }, dimensions: { actionType: "GetBucketSippyConfiguration" } },
  ],
  // Newest first, two classes per sample, as the API returns them.
  storage: [
    { max: { objectCount: 0, payloadSize: 0, metadataSize: 0, uploadCount: 0 },
      dimensions: { datetime: "2026-09-27T06:50:00Z", storageClass: "InfrequentAccess" } },
    { max: { objectCount: 26139, payloadSize: 162880512114, metadataSize: 1839241, uploadCount: 0 },
      dimensions: { datetime: "2026-09-27T06:50:00Z", storageClass: "Standard" } },
    { max: { objectCount: 17605, payloadSize: 132906356605, metadataSize: 1228872, uploadCount: 0 },
      dimensions: { datetime: "2026-09-27T05:10:00Z", storageClass: "Standard" } },
  ],
}] } } };

let sent;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify(LIVE)); };
const pull = await pullR2({ CF_API_TOKEN: "t" }, "acct", "freecapitalists-library",
  "2026-09-26T13:00:00.000Z", "2026-09-27T13:00:00.000Z");
globalThis.fetch = realFetch;

check("one request carries every grouping", ["ops:", "statuses:", "regions:", "objects:", "mtd:", "storage:"]
  .every((alias) => sent.query.includes(alias)), true);
check("the day's filter is scoped to the bucket", sent.variables.f.bucketName, "freecapitalists-library");
check("top objects are GetObject only (what readers pulled)", sent.variables.gf.actionType, "GetObject");
check("...successful ones, so scanner 404s cannot crowd them out", sent.variables.gf.actionStatus, "success");
check("missing keys are the failed GetObjects", sent.variables.xf.actionStatus, "userError");
check("...parsed into their own list", pull.missing.map((o) => o.object).join(","), ",.env");
check("month-to-date starts on the 1st", sent.variables.mf.datetime_geq, "2026-09-01T00:00:00Z");
check("the storage lookback is a week, not the day",
  sent.variables.sf.datetime_geq, "2026-09-20T13:00:00.000Z");
check("storage takes the NEWEST Standard sample, not an older one", pull.storage.get("Standard").objectCount, 26139);
check("status codes are strings for the (dim, value) table", pull.statuses[1].value, "404");

// ---- The nightly summary --------------------------------------------------
const s = summarizeR2(pull);
check("every operation is counted", s.requests, 34907 + 282);
check("class A sums the writes and lists", s.classA, 26135 + 56 + 3 + 2 + 1);
check("class B sums the reads and heads", s.classB, 8275 + 426 + 280 + 5 + 2 + 1 + 1);
check("unlisted ops are kept apart", s.classUnlisted, 2);
check("...so every op lands in exactly one bucket",
  s.classA + s.classB + s.classFree + s.classUnlisted, s.requests);
check("non-success statuses are errors", s.errors, 280 + 2 + 1);
check("bytes read out are GetObject's response bytes", s.responseBytes, 3758375321);
check("month-to-date class A", s.mtdClassA, 26135 + 56);
check("month-to-date class B", s.mtdClassB, 8277 + 729);
check("objects stored", s.objectCount, 26139);
check("the empty IA class stays zero", s.iaObjectCount, 0);
check("the sample time is kept", s.storageAt, "2026-09-27T06:50:00Z");

// ---- Cost ----------------------------------------------------------------
const cost = estimateR2Cost(s);
// (162,880,512,114 + 1,839,241) bytes = 162.88 GB; 152.88 billable at $0.015.
check("storage run-rate uses the free 10 GB", near(cost.storageUsd, (162882351355 / 1e9 - 10) * 0.015), true);
check("...about $2.29 a month for this bucket", cost.storageUsd.toFixed(2), "2.29");
check("no op charges inside the free tier", cost.classAUsd + cost.classBUsd, 0);
check("free-tier share is reported", near(cost.classAFreeShare, 26191 / 1e6), true);
const heavy = estimateR2Cost({ ...s, mtdClassA: 2_000_000, mtdClassB: 20_000_000 });
check("class A past the free tier bills per million", near(heavy.classAUsd, R2_PRICING.classAPerMillion), true);
check("class B past the free tier bills per million", near(heavy.classBUsd, 10 * R2_PRICING.classBPerMillion), true);
check("an empty bucket costs nothing", estimateR2Cost({ ...s, payloadBytes: 0, metadataBytes: 0 }).storageUsd, 0);

// ---- Edge cache summary (zone log, 2026-09-27 05:00-07:30) ---------------
const cache = summarizeCache([
  { value: "dynamic", requests: 8357, bytes: 489894999 },
  { value: "miss", requests: 877, bytes: 2805320624 },
  { value: "none", requests: 125, bytes: 189959 },
  { value: "hit", requests: 91, bytes: 211002495 },
  { value: "expired", requests: 27, bytes: 254072 },
  { value: "bypass", requests: 8, bytes: 16356 },
]);
check("hit share is hits over every edge request", near(cache.hitShare, 91 / 9485), true);
check("byte share likewise", near(cache.hitByteShare, 211002495 / 3506678505), true);
check("expired is not counted as served from cache", cache.hitRequests, 91);

// ---- The zone query -------------------------------------------------------
const zq = zoneQuery();
for (const alias of Object.keys(ZONE_GROUPINGS)) {
  check(`the zone query aliases the ${alias} grouping`, zq.includes(`${alias}: httpRequestsAdaptiveGroups`), true);
}
check("...with cacheStatus among them", zq.includes("dimensions { cacheStatus }"), true);
check("...and exactly one dimension per grouping (the row-cap convention)",
  /dimensions \{ \w+ \w+/.test(zq), false);

if (failures) {
  console.error(`${failures} R2 check(s) failed`);
  process.exit(1);
}
console.log("R2 bucket checks passed");
