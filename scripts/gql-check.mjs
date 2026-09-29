// gqlPost must retry Cloudflare's transient GraphQL failures (the 2026-09-29
// `serviceUnavailable` that killed the nightly cron) and must NOT retry real
// query errors. Stubs fetch and setTimeout; touches no network.
import assert from "node:assert/strict";
import { gqlPost } from "../src/cloudflare.js";

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

  console.log("GraphQL retry checks passed");
} finally {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
}
