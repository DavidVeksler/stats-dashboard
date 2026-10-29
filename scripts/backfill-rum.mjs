#!/usr/bin/env node
// Rebuild past nights' RUM rows (daily_traffic, daily_referrers, daily_cf_pages,
// daily_rum_filter, daily_browser_current) under the current-browser rule, by
// calling the Worker's guarded /backfill-rum endpoint once per night. The Worker
// re-reads each night's window from Cloudflare and writes D1 through its own
// binding, so there is no SQL file to apply by hand.
//
// Use it (1) after a night the pull refused as sampled, within a few days, and
// (2) once after the browser rule first ships, to rebuild the last week so the
// dashboard has comparisons from day one. Cloudflare serves exact RUM for about
// the last 7 days and a 1-in-10 sample after that; the endpoint refuses a sampled
// night rather than storing it, so older nights report "not written".
//
// Usage:
//   npm run backfill:rum                          # the last 8 nights, oldest first
//   npm run backfill:rum -- --dates 2026-10-27,2026-10-28
//   npm run backfill:rum -- --days 3
//
// Key: STATS_REFRESH_KEY, else .deploy/refresh_key.txt. Never printed.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = process.env.STATS_BACKFILL_URL || "https://stats.davidveksler.com/backfill-rum";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log("Usage: node scripts/backfill-rum.mjs [--dates a,b,...] [--days N]");
  process.exit(0);
}

const days = Number(arg("--days") ?? 8);
const today = new Date().toISOString().slice(0, 10);
const dates = arg("--dates")?.split(",").map((d) => d.trim())
  ?? Array.from({ length: days }, (_, i) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    return d.toISOString().slice(0, 10);
  });
for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date: ${d}`);

const key = process.env.STATS_REFRESH_KEY?.trim()
  || (await readFile(path.join(repoRoot, ".deploy", "refresh_key.txt"), "utf8")).trim();

let failed = 0;
for (const date of dates) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("key", key);
  url.searchParams.set("date", date);
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": BROWSER_USER_AGENT },
    signal: AbortSignal.timeout(180_000) });
  const body = (await res.text()).replaceAll(key, "[REDACTED]");
  if (!res.ok) {
    console.log(`${date}: HTTP ${res.status} ${body.slice(0, 200)}`);
    failed += 1;
    continue;
  }
  const r = JSON.parse(body);
  console.log(r.written
    ? `${date}: written, ${r.counted} counted sessions, ${r.automated} automated set aside (${r.batches} batches)`
    : `${date}: not written, ${(r.degraded ?? []).join("; ")}`);
}
process.exitCode = failed ? 1 : 0;
