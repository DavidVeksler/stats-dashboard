#!/usr/bin/env node
// Fetches Bing Webmaster Tools stats and POSTs them to the Worker's
// /ingest-bing endpoint for writing to D1. Runs OUTSIDE Cloudflare — as a
// scheduled GitHub Action (.github/workflows/bing-pull.yml) — because every
// call to Bing's API routed through Cloudflare Workers' shared egress IPs
// gets `ErrorCode 17 "ThrottleIP"`, confirmed 2026-09-11 to be independent of
// this account, key, or pacing: the identical call from a non-Cloudflare IP
// (this machine, a GitHub Actions runner, anything not-Cloudflare) succeeds
// instantly. See the note on runBingDaily in src/index.js for the full story.
//
// Reuses queryRankAndTraffic/queryKeywords straight from src/bing.js so the
// wire shape this script fetches is byte-identical to what runBingDaily used
// to fetch — the Worker's /ingest-bing endpoint does only the merge-and-write
// half, never re-implementing Bing's response shape.
//
// Usage:
//   node scripts/bing-pull.mjs [--dry-run] [--endpoint URL] [--key-file PATH]
//
// Reads the Bing API key from $BING_API_KEY (falls back to
// $BING_WEBMASTER_API_KEY, or ~/Projects/.bing.env's BING_WEBMASTER_API_KEY=
// line, the same convention scripts/bing-root-domain-stats.mjs already uses).
// Reads the REFRESH_KEY the same way scripts/refresh-stats.mjs does: from
// $STATS_REFRESH_KEY, or .deploy/refresh_key.txt.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SITES } from "../src/config.js";
import { bingUrlsOf, queryRankAndTraffic, queryKeywords } from "../src/bing.js";

const DEFAULT_ENDPOINT = "https://stats.davidveksler.com/ingest-bing";
const DEFAULT_TIMEOUT_SECONDS = 60;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const projectsRoot = path.resolve(repoRoot, "..");

function parseArgs(argv) {
  const opts = {
    endpoint: process.env.STATS_INGEST_BING_URL || DEFAULT_ENDPOINT,
    keyFile: process.env.STATS_REFRESH_KEY_FILE || path.join(repoRoot, ".deploy", "refresh_key.txt"),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--endpoint") opts.endpoint = argv[++i];
    else if (a === "--key-file") opts.keyFile = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function loadBingApiKey() {
  if (process.env.BING_API_KEY) return process.env.BING_API_KEY;
  if (process.env.BING_WEBMASTER_API_KEY) return process.env.BING_WEBMASTER_API_KEY;
  const envPath = path.join(projectsRoot, ".bing.env");
  const text = await readFile(envPath, "utf8").catch(() => null);
  const m = text && /^BING_WEBMASTER_API_KEY=(.+)$/m.exec(text);
  if (!m) {
    throw new Error(
      `No BING_API_KEY/BING_WEBMASTER_API_KEY in the environment and no key file at ${envPath}.`
    );
  }
  return m[1].trim();
}

async function loadRefreshKey(keyFile) {
  const environmentKey = process.env.STATS_REFRESH_KEY?.trim();
  if (environmentKey) return environmentKey;
  const resolvedPath = path.resolve(keyFile);
  const key = await readFile(resolvedPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`refresh key not found at ${resolvedPath}; deploy once or set STATS_REFRESH_KEY`);
    }
    throw error;
  });
  const trimmed = key.trim();
  if (!trimmed) throw new Error(`refresh key file is empty: ${resolvedPath}`);
  return trimmed;
}

// One SITES host -> the ingest-bing shape: try every configured Bing URL for
// summary and for keywords independently (a URL failing costs its own share,
// not the whole host — same discipline runBingDaily used), and report which
// side succeeded so the Worker applies the same delete-only-if-fetched rule
// it always has.
async function pullHost(apiKey, site) {
  const host = site.host;
  const urls = bingUrlsOf(site);
  const errors = [];

  const summaryParts = [];
  let summaryOk = false;
  for (const url of urls) {
    try {
      summaryParts.push(await queryRankAndTraffic(apiKey, url));
      summaryOk = true;
    } catch (e) {
      errors.push(`bing summary ${host} (${url}): ${e.message}`.slice(0, 140));
    }
  }

  const keywordParts = [];
  let keywordsOk = false;
  for (const url of urls) {
    try {
      keywordParts.push(await queryKeywords(apiKey, url));
      keywordsOk = true;
    } catch (e) {
      errors.push(`bing keywords ${host} (${url}): ${e.message}`.slice(0, 140));
    }
  }

  return { host, summaryOk, summaryParts, keywordsOk, keywordParts, errors };
}

async function run(opts) {
  const apiKey = await loadBingApiKey();
  const bingSites = SITES.filter((s) => bingUrlsOf(s).length);
  if (!bingSites.length) {
    console.log("no SITES entry has a `bing` property set — nothing to pull");
    return;
  }

  const results = [];
  for (const site of bingSites) {
    // Sequential, not Promise.all — Bing throttles bursts, and this mirrors
    // the pacing runBingDaily always used (see BING_CALL_DELAY_MS in
    // src/bing.js, which queryRankAndTraffic/queryKeywords already apply).
    results.push(await pullHost(apiKey, site));
  }

  const date = new Date().toISOString().slice(0, 10);
  const failed = results.filter((r) => !r.summaryOk && !r.keywordsOk);
  const partial = results.filter((r) => r.errors.length && (r.summaryOk || r.keywordsOk));
  console.error(
    `Pulled ${results.length} Bing sites for ${date}: ${results.length - failed.length} with at least one ` +
      `table written, ${failed.length} fully failed, ${partial.length} partially failed.`
  );
  for (const r of results) for (const e of r.errors) console.error(`  ${e}`);

  if (opts.dryRun) {
    console.log(JSON.stringify({ date, results }, null, 2));
    return;
  }

  const refreshKey = await loadRefreshKey(opts.keyFile);
  const endpoint = new URL(opts.endpoint);
  endpoint.searchParams.set("key", refreshKey);
  console.error(`Posting results to ${endpoint.origin}${endpoint.pathname} ...`);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ date, results }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_SECONDS * 1000),
  });
  const body = await response.text();
  const safeBody = body.replaceAll(refreshKey, "[REDACTED]");
  if (!response.ok) {
    throw new Error(`ingest failed with HTTP ${response.status}: ${safeBody.slice(0, 500) || response.statusText}`);
  }

  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error(`ingest returned invalid JSON: ${safeBody.slice(0, 300)}`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) {
    console.error("Ingest completed, but reported at least one failure — see notes above.");
    process.exitCode = 2;
  }
}

function usage() {
  console.log(`Pull Bing Webmaster Tools stats and POST them to /ingest-bing.

Usage:
  node scripts/bing-pull.mjs [options]

Options:
  --dry-run           Fetch from Bing but don't POST; print the payload instead
  --endpoint URL       Ingest endpoint (default: ${DEFAULT_ENDPOINT})
  --key-file PATH      File containing REFRESH_KEY (default: .deploy/refresh_key.txt)
  -h, --help           Show this help

Environment overrides:
  BING_API_KEY (or BING_WEBMASTER_API_KEY, or ~/Projects/.bing.env)
  STATS_REFRESH_KEY, STATS_REFRESH_KEY_FILE, STATS_INGEST_BING_URL`);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
  } else {
    await run(opts);
  }
} catch (error) {
  const detail = error.name === "TimeoutError" ? "ingest request timed out" : error.message;
  console.error(`ERROR: ${detail}`);
  process.exitCode = 1;
}
