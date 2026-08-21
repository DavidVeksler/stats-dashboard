// Exercises runDaily's WRITE path — the half of the Worker the other check
// scripts never touch, because they drive loadDashboard against stored rows.
//
// It exists because raising KEYWORD_ROW_LIMIT to 500 turned a night's writes from
// roughly 300 bound statements into roughly 7,000, which no longer fits one
// `env.DB.batch()` call. The batch is now cut into chunks, and chunking a stream
// whose idempotency is "DELETE the day, then INSERT it again" is exactly the kind
// of change that destroys a day of data silently if the ordering is got wrong. So
// the ordering is asserted, not reasoned about:
//
//   - no chunk exceeds D1_MAX_BATCH_STATEMENTS;
//   - the chunks are a partition of one ordered stream (the flattened statement
//     order is the order they were prepared in);
//   - every DELETE precedes every INSERT for the same (table, host), INCLUDING
//     the cases where a site's 500 keyword rows straddle a chunk boundary;
//   - a run with no GSC key issues no keyword DELETE at all, so it refreshes
//     traffic without wiping keyword history.
//
// Cloudflare, Google and D1 are all stubbed. The service-account key is generated
// here rather than fixtured, because gsc.js signs a real JWT with it.
import worker, { D1_MAX_BATCH_STATEMENTS } from "../src/index.js";
import { KEYWORD_ROW_LIMIT } from "../src/gsc.js";
import { SITES, FORUMS } from "../src/config.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return;
  failures += 1;
  console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
}

const GSC_SITES = SITES.filter((s) => s.gsc);

// ---- A real (throwaway) service-account key ------------------------------
// getAccessToken imports this with crypto.subtle and signs with it, so a
// placeholder string would fail before any write happened.
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
const pem = `-----BEGIN PRIVATE KEY-----\n${
  (Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g) ?? []).join("\n")
}\n-----END PRIVATE KEY-----\n`;
const GSC_SA_KEY = JSON.stringify({ client_email: "check@example.invalid", private_key: pem });

// ---- Stubs ---------------------------------------------------------------
const json = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});

// What Google was asked for, per dimension, so the request side of the cap can be
// asserted as well as the stored side. Raising one without the other does nothing.
let keywordRowLimits = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input);
  if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "stub-token" });

  if (url.includes("searchconsole.googleapis.com")) {
    const body = JSON.parse(init.body ?? "{}");
    const dimension = body.dimensions?.[0] ?? null;
    if (!dimension) return json({ rows: [{ clicks: 9, impressions: 2250, ctr: .004, position: 10.1 }] });
    // Return exactly as many rows as were asked for. A property with a deep tail
    // returns the full rowLimit, which is the case that matters here.
    const n = body.rowLimit ?? 0;
    if (dimension === "query") keywordRowLimits.push(n);
    return json({
      rows: Array.from({ length: n }, (_, i) => ({
        keys: [`${dimension} ${i}`], clicks: i < 3 ? 1 : 0, impressions: 100 - (i % 90),
        ctr: 0, position: 5 + (i % 60),
      })),
    });
  }

  if (FORUMS.some((f) => url === `https://${f.host}/about.json`)) {
    return json({ about: { stats: {
      users_count: 59180, active_users_last_day: 3, active_users_7_days: 3, active_users_30_days: 3,
      users_last_day: 0, users_7_days: 0, users_30_days: 0,
      posts_last_day: 0, posts_count: 398996, topics_count: 26291,
    } } });
  }

  if (url.includes("api.cloudflare.com")) {
    const body = JSON.parse(init.body ?? "{}");
    if (body.query.includes("rumPageloadEventsAdaptiveGroups")) {
      return json({ data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups:
        SITES.filter((s) => s.trafficSource !== "zone").map((s) => ({
          count: 40, sum: { visits: 20 },
          dimensions: { refererHost: "www.google.com", requestHost: s.host, requestPath: "/" },
        })) }] } } });
    }
    // Zone queries: one row is enough — this check is about the write, not the pull.
    return json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [{
      count: 19506, sum: { visits: 1059, edgeResponseBytes: 76_658_000_000 },
      dimensions: { clientRequestPath: "/robots.txt", clientCountryName: "United States",
        edgeResponseStatus: 404, verifiedBotCategory: "AI Crawler" },
    }] }] } } });
  }

  throw new Error(`unstubbed fetch: ${url}`);
};

let seq = 0;
let batches = [];
const db = {
  prepare(sql) {
    const stmt = { sql, binds: [], seq: seq += 1 };
    stmt.bind = (...args) => { stmt.binds = args; return stmt; };
    // Reads: loadDashboard runs at the end of runDaily to pick the ntfy finding,
    // and an empty database is a valid answer for it.
    stmt.all = async () => ({ results: [] });
    stmt.first = async () => null;
    stmt.run = async () => ({ success: true });
    return stmt;
  },
  async batch(list) {
    batches.push(list);
    return list.map(() => ({ success: true }));
  },
};

const run = async (env) => {
  seq = 0;
  batches = [];
  keywordRowLimits = [];
  const res = await worker.fetch(
    new Request("https://stats.test/run?key=k"), { DB: db, REFRESH_KEY: "k", CF_API_TOKEN: "cf", ...env });
  const result = await res.json();
  // ensureSchema has its own batch; the night's data writes are the rest.
  const writes = batches.filter((list) => !/CREATE TABLE|CREATE INDEX/i.test(list[0].sql));
  return { result, writes, flat: writes.flat() };
};

// ---- 1. The full run, with a GSC key -------------------------------------
{
  const { result, writes, flat } = await run({ GSC_SA_KEY });
  check("the run completed", Array.isArray(result.notes) && result.notes.length === 0, true);

  // The cap, on both sides. Neither alone does anything.
  check("Google is asked for the raised row limit",
    [...new Set(keywordRowLimits)].join(","), String(KEYWORD_ROW_LIMIT));
  check("...for every property with a Search Console site", keywordRowLimits.length, GSC_SITES.length);
  const kwInserts = flat.filter((s) => s.sql.startsWith("INSERT INTO daily_keywords"));
  check("...and every row it returns is stored", kwInserts.length, KEYWORD_ROW_LIMIT * GSC_SITES.length);

  // Chunking.
  check("the write is cut into more than one batch", writes.length > 1, true);
  check("...none of them larger than the limit",
    writes.every((list) => list.length <= D1_MAX_BATCH_STATEMENTS), true);
  check("...and the last one is a remainder, not a coincidence",
    writes.at(-1).length <= D1_MAX_BATCH_STATEMENTS, true);
  check("the chunks partition the stream without dropping a statement",
    flat.length, writes.reduce((sum, list) => sum + list.length, 0));
  check("...in the order the statements were prepared",
    flat.every((stmt, i) => i === 0 || flat[i - 1].seq < stmt.seq), true);

  // Ordering, which is the whole reason this file exists. Chunking is only safe
  // because the chunks are awaited in sequence: a DELETE that landed after its
  // INSERTs would empty a day of data, and nothing else in the repo would notice.
  const tables = ["daily_keywords", "daily_pages", "daily_search_summary",
    "daily_referrers", "daily_cf_pages", "daily_zone_countries", "daily_zone_status", "daily_zone_bots"];
  let straddles = 0;
  for (const table of tables) {
    const hosts = new Set(flat.filter((s) => s.sql.includes(`DELETE FROM ${table} `))
      .map((s) => s.binds[1]));
    check(`${table} is deleted for at least one host`, hosts.size > 0, true);
    for (const host of hosts) {
      const deleteAt = flat.findIndex((s) =>
        s.sql.includes(`DELETE FROM ${table} `) && s.binds[1] === host);
      const inserts = flat
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.sql.startsWith(`INSERT INTO ${table} `) && s.binds[1] === host)
        .map(({ i }) => i);
      if (!inserts.length) continue;
      check(`${table}/${host}: the delete precedes every insert`,
        deleteAt >= 0 && deleteAt < Math.min(...inserts), true);
      // The case chunking introduced: the delete and its inserts are executed by
      // different batch() calls, so only sequential execution keeps them ordered.
      const batchOf = (index) => {
        let seen = 0;
        for (let b = 0; b < writes.length; b += 1) {
          seen += writes[b].length;
          if (index < seen) return b;
        }
        return -1;
      };
      if (batchOf(deleteAt) !== batchOf(Math.max(...inserts))) straddles += 1;
    }
  }
  check("at least one delete/insert pair really does straddle a chunk boundary",
    straddles > 0, true);

  // `node scripts/write-check.mjs --verbose` prints the shape of a night's write,
  // which is the fastest way to see what raising KEYWORD_ROW_LIMIT or lowering
  // D1_MAX_BATCH_STATEMENTS does to the number of round trips.
  if (process.argv.includes("--verbose")) {
    console.log(`statements ${flat.length} · batches ${writes.length} ` +
      `· max ${Math.max(...writes.map((l) => l.length))}/batch · straddling pairs ${straddles}`);
    const byTable = new Map();
    for (const stmt of flat) {
      const key = `${stmt.sql.slice(0, 6).trim()} ${(stmt.sql.match(/(?:INTO|FROM)\s+(\w+)/) ?? [])[1]}`;
      byTable.set(key, (byTable.get(key) ?? 0) + 1);
    }
    for (const [key, n] of [...byTable].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${key}`);
  }

  // The daily traffic row is an upsert, not a delete/insert, and must stay one:
  // it is the row every other read keys off, and a gap in it is a missing day.
  check("daily_traffic is written as an upsert, one row per site",
    flat.filter((s) => s.sql.startsWith("INSERT INTO daily_traffic")).length, SITES.length);
  check("...and is never deleted",
    flat.some((s) => s.sql.includes("DELETE FROM daily_traffic")), false);

  // Forum activity (Discourse) is an independent pull from the CF/GSC ones
  // above: one upsert row per configured forum, no delete/insert pattern (there
  // are no per-forum child rows to keep in step with a delete).
  check("daily_forum_activity is written as an upsert, one row per forum",
    flat.filter((s) => s.sql.startsWith("INSERT INTO daily_forum_activity")).length, FORUMS.length);
  check("...and is never deleted",
    flat.some((s) => s.sql.includes("DELETE FROM daily_forum_activity")), false);
}

// ---- 2. No GSC key: traffic refreshes, keywords survive -------------------
// The guard this protects has been in AGENTS.md since before the chunking, and
// chunking is exactly the kind of edit that could have moved a DELETE outside it.
{
  const { flat, result } = await run({});
  check("a run with no GSC key still writes traffic",
    flat.filter((s) => s.sql.startsWith("INSERT INTO daily_traffic")).length, SITES.length);
  check("...and reports the keyword pull as skipped", result.gscOk, false);
  for (const table of ["daily_keywords", "daily_pages", "daily_search_summary"]) {
    check(`...without deleting ${table}`,
      flat.some((s) => s.sql.includes(`DELETE FROM ${table} `)), false);
    check(`...or writing to ${table}`,
      flat.some((s) => s.sql.startsWith(`INSERT INTO ${table} `)), false);
  }
}

globalThis.fetch = realFetch;

if (failures) {
  console.error(`\n${failures} write-path check(s) failed`);
  process.exit(1);
}
console.log("Write-path checks passed");
