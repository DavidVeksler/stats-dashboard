#!/usr/bin/env node
// Rebuild the RUM rows (daily_traffic, daily_referrers, daily_cf_pages) for nights
// where the nightly pull stored Cloudflare's *sampled* answer: round numbers
// (18,000 / 3,000 / 1,000) and zeros for sites that had real traffic. Bad runs found
// 2026-10-17: 2026-09-21, 09-30, 10-06, 10-12 and 10-17. See the sampling guard in
// src/cloudflare.js and the matching gotcha in AGENTS.md.
//
// This script NEVER writes to D1. It re-reads each night's window from the
// Cloudflare GraphQL API (read-only), applies the same sampling guard the Worker now
// uses, and writes a .sql file for you to review and apply. It cannot apply it
// itself: the deploy token has no D1 management scope (AGENTS.md, "D1 management
// API is NOT in scope"), so apply the file in the D1 console or through the
// Cloudflare MCP `d1_database_query` connector.
//
// Usage:
//   node scripts/backfill-rum.mjs                       # the five known bad nights
//   node scripts/backfill-rum.mjs --dates 2026-10-17    # chosen nights
//   node scripts/backfill-rum.mjs --end 2026-10-17=2026-10-17T13:00:57Z
//                                                        # exact original run_at for a night
//   node scripts/backfill-rum.mjs --out path.sql
//
// A night's window is the 24 hours ending at its run (default 13:00:00Z, the cron time;
// the real run_at is a few seconds to a minute later, so figures can differ from the
// original pull by the traffic in that gap -- pass --end with the runs.run_at value
// from D1 to match exactly). A night that is STILL sampled when re-read (2026-10-06
// reads back at interval 10) is skipped, not written: its true figures are gone.
//
// Token: CLOUDFLARE_API_TOKEN, else the first such line in ~/Projects/.cloudflare.env
// (that file holds two; the first has the analytics scope). Never printed.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pullTraffic, topReferrers, topPages, RUM_MAX_SAMPLE_INTERVAL } from "../src/cloudflare.js";
import { SITES } from "../src/config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN_BAD_NIGHTS = ["2026-09-21", "2026-09-30", "2026-10-06", "2026-10-12", "2026-10-17"];

function arg(name) {
  const values = [];
  process.argv.forEach((a, i) => { if (a === name) values.push(process.argv[i + 1]); });
  return values;
}
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: node scripts/backfill-rum.mjs [--dates a,b,...] [--end DATE=ISO ...] [--out FILE.sql]
Re-reads sampled nights from Cloudflare (read-only) and writes a reviewable SQL file. Never touches D1.`);
  process.exit(0);
}

const dates = (arg("--dates")[0]?.split(",") ?? KNOWN_BAD_NIGHTS).map((d) => d.trim());
for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date: ${d}`);
const ends = new Map(arg("--end").map((v) => v.split(/=(.*)/s).slice(0, 2)));
const outFile = arg("--out")[0] ?? path.join(repoRoot, ".deploy", `backfill-rum-${new Date().toISOString().slice(0, 10)}.sql`);

async function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const text = await readFile(path.join(os.homedir(), "Projects", ".cloudflare.env"), "utf8");
  const m = text.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m);
  if (!m) throw new Error("no CLOUDFLARE_API_TOKEN in env or ~/Projects/.cloudflare.env");
  return m[1].trim().replace(/^"|"$/g, "");
}

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(Math.round(v)) : `'${String(v).replace(/'/g, "''")}'`);
const env = { CF_API_TOKEN: await token() };
const rumSites = SITES.filter((s) => s.trafficSource !== "zone");

const sql = [
  `-- RUM backfill generated ${new Date().toISOString()} by scripts/backfill-rum.mjs.`,
  "-- Review, then apply in the D1 console or via the d1_database_query connector.",
  "-- Replaces daily_traffic (visits/views), daily_referrers and daily_cf_pages for RUM hosts only;",
  "-- zone-sourced hosts, GSC, R2 and everything else are untouched.",
  "",
];
const summary = [];

for (const date of dates) {
  const endISO = ends.get(date) ?? `${date}T13:00:00.000Z`;
  const end = new Date(endISO);
  if (Number.isNaN(end.getTime())) throw new Error(`bad --end for ${date}: ${endISO}`);
  const startISO = new Date(end.getTime() - 24 * 3600 * 1000).toISOString();
  // No backoff and no retries: a night that is sampled now is sampled for good.
  const { hosts, degraded } = await pullTraffic(env, startISO, end.toISOString(), { retries: 0, backoffMs: [0] });
  if (degraded.length) {
    console.log(`${date}: SKIPPED, still sampled on re-read (${degraded.join("; ")}) (limit ${RUM_MAX_SAMPLE_INTERVAL}); the exact figures are not recoverable`);
    summary.push({ date, status: "skipped" });
    continue;
  }
  sql.push(`-- ${date}: window ${startISO} .. ${end.toISOString()}`);
  let visits = 0;
  for (const { host } of rumSites) {
    const rec = hosts.get(host) ?? { views: 0, visits: 0, referrers: new Map(), pages: new Map() };
    visits += rec.visits;
    sql.push(
      `INSERT INTO daily_traffic (date,host,visits,views,bytes) VALUES (${q(date)},${q(host)},${q(rec.visits)},${q(rec.views)},0) ` +
        "ON CONFLICT(date,host) DO UPDATE SET visits=excluded.visits, views=excluded.views;",
      `DELETE FROM daily_referrers WHERE date=${q(date)} AND host=${q(host)};`,
      `DELETE FROM daily_cf_pages WHERE date=${q(date)} AND host=${q(host)};`,
    );
    for (const r of topReferrers(rec.referrers, 50, host)) {
      sql.push(`INSERT INTO daily_referrers (date,host,referrer,kind,visits) VALUES (${q(date)},${q(host)},${q(r.referrer)},${q(r.kind)},${q(r.visits)});`);
    }
    for (const p of topPages(rec.pages, 50)) {
      sql.push(`INSERT INTO daily_cf_pages (date,host,page,visits,views) VALUES (${q(date)},${q(host)},${q(p.page)},${q(p.visits)},${q(p.views)});`);
    }
  }
  sql.push("");
  console.log(`${date}: ${visits} RUM visits across ${rumSites.length} hosts`);
  summary.push({ date, status: "ready", visits });
}

const ready = summary.filter((s) => s.status === "ready").length;
if (!ready) {
  console.log("Nothing recoverable; no SQL file written.");
  process.exit(0);
}
await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, sql.join("\n") + "\n", "utf8");
console.log(`\nWrote ${outFile} (${ready} of ${dates.length} nights). Review it, then apply it to D1. Nothing was written to D1.`);
