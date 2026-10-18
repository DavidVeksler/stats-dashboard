// gqlPost must retry Cloudflare's transient GraphQL failures (the 2026-09-29
// `serviceUnavailable` that killed the nightly cron) and must NOT retry real
// query errors. Stubs fetch and setTimeout; touches no network.
import assert from "node:assert/strict";
import { gqlPost, rumSamplingProblem, RUM_MAX_SAMPLE_INTERVAL } from "../src/cloudflare.js";

const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realTimeout(fn, 0);
const env = { CF_API_TOKEN: "t" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
const script = (...responses) => {
  let calls = 0;
  globalThis.fetch = async () => {
    const r = responses[Math.min(calls++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r();
  };
  return () => calls;
};
const unavailable = () => json({ errors: [{ message: "try again later", extensions: { code: "serviceUnavailable" } }] });
const ok = () => json({ data: { fine: true } });

try {
  let calls = script(unavailable, ok);
  assert.deepEqual((await gqlPost(env, {}, "t")).data, { fine: true });
  assert.equal(calls(), 2, "serviceUnavailable is retried once, then succeeds");

  calls = script(() => json({}, 503), ok);
  await gqlPost(env, {}, "t");
  assert.equal(calls(), 2, "HTTP 5xx is retried");

  calls = script(new Error("network reset"), ok);
  await gqlPost(env, {}, "t");
  assert.equal(calls(), 2, "a rejected fetch is retried");

  calls = script(unavailable);
  await assert.rejects(gqlPost(env, {}, "t"), /serviceUnavailable/);
  assert.equal(calls(), 3, "gives up after 3 attempts");

  calls = script(() => json({ errors: [{ message: "no access", extensions: { code: "authz" } }] }));
  await assert.rejects(gqlPost(env, {}, "t"), /authz/);
  assert.equal(calls(), 1, "a real query error is not retried");

  calls = script(() => json({}, 403));
  await assert.rejects(gqlPost(env, {}, "t"), /403/);
  assert.equal(calls(), 1, "HTTP 4xx is not retried");

  // The RUM sampling guard (2026-10-17: 18,000 / 3,000 / 2,000 / 1,000 and eleven zeros).
  const row = (count, interval) => ({ count, avg: { sampleInterval: interval } });
  assert.equal(rumSamplingProblem([row(47815, 1.002), row(194, 1.05), row(10, 1)], true), null,
    "exact answers (interval ~1.00-1.05) are trusted");
  assert.match(rumSamplingProblem([row(37000, 1000), row(3000, 1000)], true), /sample interval 1000/,
    "a sample interval of 1000 is refused");
  assert.match(rumSamplingProblem([row(35060, 10), row(380, 10.27)], true), /sample interval 10/,
    "the 2026-10-06 window (interval 10) is refused");
  assert.equal(rumSamplingProblem([row(100000, 1), row(5, 40)], true), null,
    "a quiet host's coarse interval cannot veto a healthy day");
  assert.match(rumSamplingProblem([row(5000, 1), row(100000, 20)], true), /sample interval/,
    "a busy host's coarse interval cannot hide behind quiet exact ones");
  assert.ok(RUM_MAX_SAMPLE_INTERVAL > 1.1 && RUM_MAX_SAMPLE_INTERVAL < 3,
    "the threshold sits above normal jitter (1.00-1.05) and well below the observed 10");
  assert.match(rumSamplingProblem([], true), /no rows/, "an empty answer from the main account is refused");
  assert.equal(rumSamplingProblem([], false), null, "an empty answer from a quiet account is fine");
  assert.equal(rumSamplingProblem([{ count: 7, sum: { visits: 3 } }], true), null,
    "rows without an interval field read as exact rather than throwing");

  console.log("GraphQL retry checks passed");
} finally {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
}
