// Cloudflare R2 bucket analytics — the bucket's own side of a host served from
// R2 through a custom domain (library.freecapitalists.org since 2026-09-27).
//
// Two measurements of that host exist and they are NOT the same population:
//   - the zone log (pullZoneTraffic in cloudflare.js) counts every request at
//     Cloudflare's edge, whether the edge cache answered it or not;
//   - R2's r2OperationsAdaptiveGroups counts every operation that reached the
//     bucket: edge cache misses, plus S3-API calls (uploads, listings, HEADs
//     from sync tools) that never touch the zone at all.
// So R2 GetObject is not a subset of zone GETs, and neither is a total of the
// other. The card prints them side by side and never subtracts one from the
// other to "derive" a cache figure; the cache figure comes from the zone log's
// own cacheStatus dimension.
//
// Both datasets are account-scoped (viewer.accounts), unlike the zone log, and
// accept a month-long window: a 2026-09-01..09-27 range returned fine on
// 2026-09-27, which is what lets the billing panel ask for month-to-date
// operations directly instead of summing stored nightly rows.

const GQL = "https://api.cloudflare.com/client/v4/graphql";

// Published R2 prices, from https://developers.cloudflare.com/r2/pricing/
// (read 2026-09-27). Standard storage class; Infrequent Access has different
// op prices and no free tier, and the bucket holds none (its IA row is zero).
// The page does not say whether a "GB" is 10^9 or 2^30 bytes; this uses 10^9,
// which reads ~7% higher than 2^30 would, so the estimate errs high.
export const R2_PRICING = {
  source: "https://developers.cloudflare.com/r2/pricing/",
  checked: "2026-09-27",
  storagePerGbMonth: 0.015,
  iaStoragePerGbMonth: 0.01,
  classAPerMillion: 4.5,
  classBPerMillion: 0.36,
  freeStorageGb: 10,
  freeClassA: 1_000_000,
  freeClassB: 10_000_000,
};

// Operation classes, verbatim from the same page. Anything R2 reports that the
// page does not list (it reported GetBucketSippyConfiguration and
// GetBucketNotificationConfiguration on day one) is "unlisted": counted and
// shown, never guessed into a billing class.
const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject",
  "CompleteMultipartUpload", "CreateMultipartUpload", "LifecycleStorageTierTransition",
  "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption",
  "PutBucketCors", "PutBucketLifecycleConfiguration"]);
const CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption",
  "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);
const CLASS_FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

export function opClass(actionType) {
  if (CLASS_A.has(actionType)) return "A";
  if (CLASS_B.has(actionType)) return "B";
  if (CLASS_FREE.has(actionType)) return "free";
  return "unlisted";
}

// Top objects are kept to this many per night, same order as daily_cf_pages.
export const R2_OBJECT_LIMIT = 50;
export const R2_MISSING_LIMIT = 25;

// One request, aliased groupings (the same pattern pullTraffic uses), so the
// whole R2 pull costs one subrequest out of runDaily's budget.
//   ops:      (actionType, actionStatus) for the day — the billing-class table
//   statuses: HTTP status R2 returned
//   regions:  where the requests came from (Cloudflare's eyeball region codes)
//   objects:  successful GetObject, by requests — what readers pulled from the bucket
//   missing:  GetObject that failed (userError, i.e. 404 for a key that is not
//             there) — broken links after a migration, and scanner probes for
//             .env/config.json, which the live 2026-09-27 pull was full of
//   mtd:      actionType since the 1st of the month, for the free-tier meter
//   storage:  latest storage sample per storage class, looked up over a week
//             because samples only appear every so often, not on a fixed clock
const QUERY = `query R2($account: String!, $f: AccountR2OperationsAdaptiveGroupsFilter_InputObject!,
  $gf: AccountR2OperationsAdaptiveGroupsFilter_InputObject!,
  $xf: AccountR2OperationsAdaptiveGroupsFilter_InputObject!,
  $mf: AccountR2OperationsAdaptiveGroupsFilter_InputObject!,
  $sf: AccountR2StorageAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      ops: r2OperationsAdaptiveGroups(filter: $f, limit: 1000, orderBy: [sum_requests_DESC]) {
        sum { requests responseBytes responseObjectSize }
        dimensions { actionType actionStatus }
      }
      statuses: r2OperationsAdaptiveGroups(filter: $f, limit: 100, orderBy: [sum_requests_DESC]) {
        sum { requests responseBytes }
        dimensions { responseStatusCode }
      }
      regions: r2OperationsAdaptiveGroups(filter: $f, limit: 100, orderBy: [sum_requests_DESC]) {
        sum { requests responseBytes }
        dimensions { eyeballRegion }
      }
      objects: r2OperationsAdaptiveGroups(filter: $gf, limit: ${R2_OBJECT_LIMIT}, orderBy: [sum_requests_DESC]) {
        sum { requests responseBytes }
        dimensions { objectName }
      }
      missing: r2OperationsAdaptiveGroups(filter: $xf, limit: ${R2_MISSING_LIMIT}, orderBy: [sum_requests_DESC]) {
        sum { requests }
        dimensions { objectName }
      }
      mtd: r2OperationsAdaptiveGroups(filter: $mf, limit: 1000, orderBy: [sum_requests_DESC]) {
        sum { requests }
        dimensions { actionType }
      }
      storage: r2StorageAdaptiveGroups(filter: $sf, limit: 50, orderBy: [datetime_DESC]) {
        max { objectCount payloadSize metadataSize uploadCount }
        dimensions { datetime storageClass }
      }
    }
  }
}`;

const monthStart = (iso) => `${iso.slice(0, 7)}-01T00:00:00Z`;

// Pull one bucket's day. startISO/endISO are the same 24h window runDaily uses
// for everything else; the month-to-date and storage lookbacks are derived.
export async function pullR2(env, account, bucket, startISO, endISO) {
  const f = { bucketName: bucket, datetime_geq: startISO, datetime_leq: endISO };
  const storageStart = new Date(Date.parse(endISO) - 7 * 86400_000).toISOString();
  const mtdStart = monthStart(endISO);
  const res = await fetch(GQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: {
      account, f,
      gf: { ...f, actionType: "GetObject", actionStatus: "success" },
      xf: { ...f, actionType: "GetObject", actionStatus: "userError" },
      mf: { bucketName: bucket, datetime_geq: mtdStart, datetime_leq: endISO },
      sf: { bucketName: bucket, datetime_geq: storageStart, datetime_leq: endISO },
    } }),
  });
  if (!res.ok) throw new Error(`CF R2 GraphQL ${res.status} for ${bucket}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(`CF R2 GraphQL errors for ${bucket}: ${JSON.stringify(body.errors)}`);
  const acct = body.data?.viewer?.accounts?.[0] ?? {};

  // Latest sample per storage class (rows arrive newest first).
  const storage = new Map();
  for (const g of acct.storage ?? []) {
    const cls = g.dimensions.storageClass || "Standard";
    if (!storage.has(cls)) storage.set(cls, { at: g.dimensions.datetime, ...g.max });
  }

  return {
    ops: (acct.ops ?? []).map((g) => ({ actionType: g.dimensions.actionType, actionStatus: g.dimensions.actionStatus,
      requests: g.sum.requests, responseBytes: g.sum.responseBytes, objectBytes: g.sum.responseObjectSize })),
    statuses: (acct.statuses ?? []).map((g) => ({ value: String(g.dimensions.responseStatusCode),
      requests: g.sum.requests, responseBytes: g.sum.responseBytes })),
    regions: (acct.regions ?? []).map((g) => ({ value: g.dimensions.eyeballRegion || "(unknown)",
      requests: g.sum.requests, responseBytes: g.sum.responseBytes })),
    objects: (acct.objects ?? []).map((g) => ({ object: g.dimensions.objectName,
      requests: g.sum.requests, responseBytes: g.sum.responseBytes })),
    missing: (acct.missing ?? []).map((g) => ({ object: g.dimensions.objectName, requests: g.sum.requests })),
    mtd: (acct.mtd ?? []).map((g) => ({ actionType: g.dimensions.actionType, requests: g.sum.requests })),
    mtdStart: mtdStart.slice(0, 10),
    storage,
  };
}

// The one-row-per-night summary stored in daily_r2_summary. Pure, so the write
// path and the checks share it.
export function summarizeR2(pull) {
  const s = { requests: 0, responseBytes: 0, classA: 0, classB: 0, classFree: 0, classUnlisted: 0,
    errors: 0, mtdClassA: 0, mtdClassB: 0, mtdStart: pull.mtdStart };
  for (const op of pull.ops) {
    s.requests += op.requests;
    s.responseBytes += op.responseBytes;
    const cls = opClass(op.actionType);
    s[{ A: "classA", B: "classB", free: "classFree", unlisted: "classUnlisted" }[cls]] += op.requests;
    if (op.actionStatus && op.actionStatus !== "success") s.errors += op.requests;
  }
  for (const op of pull.mtd) {
    const cls = opClass(op.actionType);
    if (cls === "A") s.mtdClassA += op.requests;
    if (cls === "B") s.mtdClassB += op.requests;
  }
  const std = pull.storage.get("Standard");
  const ia = pull.storage.get("InfrequentAccess");
  s.objectCount = std?.objectCount ?? 0;
  s.payloadBytes = std?.payloadSize ?? 0;
  s.metadataBytes = std?.metadataSize ?? 0;
  s.uploadCount = std?.uploadCount ?? 0;
  s.iaObjectCount = ia?.objectCount ?? 0;
  s.iaPayloadBytes = ia?.payloadSize ?? 0;
  s.storageAt = std?.at ?? ia?.at ?? null;
  return s;
}

// What the bucket costs, from the stored summary and R2_PRICING. Storage is a
// monthly run-rate at today's size (R2 bills the average of each day's peak,
// so a steady bucket converges on this); operations are month-to-date against
// the monthly free allowance. Every request is counted, errors included — the
// page exempts only 401s, which a public custom domain does not produce — so
// this is an upper bound, never a bill.
export function estimateR2Cost(summary, pricing = R2_PRICING) {
  const gb = (summary.payloadBytes + summary.metadataBytes) / 1e9;
  const iaGb = summary.iaPayloadBytes / 1e9;
  const billableGb = Math.max(0, gb - pricing.freeStorageGb);
  const storageUsd = billableGb * pricing.storagePerGbMonth + iaGb * pricing.iaStoragePerGbMonth;
  const classAUsd = Math.max(0, summary.mtdClassA - pricing.freeClassA) / 1e6 * pricing.classAPerMillion;
  const classBUsd = Math.max(0, summary.mtdClassB - pricing.freeClassB) / 1e6 * pricing.classBPerMillion;
  return { gb, billableGb, storageUsd, classAUsd, classBUsd,
    classAFreeShare: summary.mtdClassA / pricing.freeClassA,
    classBFreeShare: summary.mtdClassB / pricing.freeClassB,
    monthUsd: storageUsd + classAUsd + classBUsd };
}

// Zone-log cache statuses that mean the edge answered without asking the
// bucket. "miss"/"expired" went to R2; "dynamic"/"bypass"/"none" were never
// eligible for cache (HEADs, non-cacheable responses, errors) and went to R2 or
// were answered by the edge without a body.
const CACHE_SERVED = new Set(["hit", "stale", "updating", "revalidated"]);

export function summarizeCache(rows) {
  let requests = 0, bytes = 0, hitRequests = 0, hitBytes = 0;
  for (const r of rows) {
    requests += r.requests;
    bytes += r.bytes;
    if (CACHE_SERVED.has(r.value)) { hitRequests += r.requests; hitBytes += r.bytes; }
  }
  return { rows, requests, bytes, hitRequests, hitBytes,
    hitShare: requests ? hitRequests / requests : 0, hitByteShare: bytes ? hitBytes / bytes : 0 };
}
