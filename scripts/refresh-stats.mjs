#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENDPOINT = "https://stats.davidveksler.com/run";
const DEFAULT_TIMEOUT_SECONDS = 180;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function usage() {
  console.log(`Refresh the production stats snapshot without deploying.

Usage:
  npm run refresh -- [options]
  node scripts/refresh-stats.mjs [options]

Options:
  --endpoint URL       Refresh endpoint (default: ${DEFAULT_ENDPOINT})
  --key-file PATH      File containing REFRESH_KEY
                       (default: .deploy/refresh_key.txt)
  --timeout SECONDS    Request timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  -h, --help           Show this help

Environment overrides:
  STATS_REFRESH_URL, STATS_REFRESH_KEY_FILE, STATS_REFRESH_KEY

The refresh key is never printed. A partial GSC refresh exits with status 2.`);
}

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseArgs(args) {
  const options = {
    endpoint: process.env.STATS_REFRESH_URL || DEFAULT_ENDPOINT,
    keyFile:
      process.env.STATS_REFRESH_KEY_FILE ||
      path.join(repoRoot, ".deploy", "refresh_key.txt"),
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--endpoint") {
      options.endpoint = takeValue(args, index, arg);
      index += 1;
    } else if (arg === "--key-file") {
      options.keyFile = takeValue(args, index, arg);
      index += 1;
    } else if (arg === "--timeout") {
      options.timeoutSeconds = Number(takeValue(args, index, arg));
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (
    !Number.isFinite(options.timeoutSeconds) ||
    options.timeoutSeconds <= 0 ||
    options.timeoutSeconds > 3600
  ) {
    throw new Error("--timeout must be between 1 and 3600 seconds");
  }

  return options;
}

async function loadRefreshKey(keyFile) {
  const environmentKey = process.env.STATS_REFRESH_KEY?.trim();
  if (environmentKey) return environmentKey;

  const resolvedPath = path.resolve(keyFile);
  let key;
  try {
    key = (await readFile(resolvedPath, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `refresh key not found at ${resolvedPath}; deploy once or set STATS_REFRESH_KEY`,
      );
    }
    throw error;
  }

  if (!key) throw new Error(`refresh key file is empty: ${resolvedPath}`);
  return key;
}

async function refreshStats(options) {
  const refreshKey = await loadRefreshKey(options.keyFile);
  const endpoint = new URL(options.endpoint);
  endpoint.searchParams.set("key", refreshKey);

  console.error(`Refreshing stats via ${endpoint.origin}${endpoint.pathname} ...`);

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      "User-Agent": BROWSER_USER_AGENT,
    },
    signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
  });
  const body = await response.text();
  const safeBody = body.replaceAll(refreshKey, "[REDACTED]");

  if (!response.ok) {
    throw new Error(
      `refresh failed with HTTP ${response.status}: ${safeBody.slice(0, 300) || response.statusText}`,
    );
  }

  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error(`refresh returned invalid JSON: ${safeBody.slice(0, 300)}`);
  }

  if (!result || typeof result !== "object" || typeof result.totalVisits !== "number") {
    throw new Error("refresh response is missing the expected totalVisits field");
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.gscOk === false) {
    console.error("Refresh completed, but Google Search Console data was partial or skipped.");
    process.exitCode = 2;
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
  } else {
    await refreshStats(options);
  }
} catch (error) {
  const detail = error.name === "TimeoutError" ? "refresh request timed out" : error.message;
  console.error(`ERROR: ${detail}`);
  process.exitCode = 1;
}
