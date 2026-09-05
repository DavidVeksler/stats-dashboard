#!/usr/bin/env node
// Root-domain-only Bing Search stats for a site whose Bing property mixes in
// subdomain traffic. davidveksler.com is the motivating case: its apex
// property in Bing Webmaster Tools aggregates every *.davidveksler.com
// subdomain (confirmed live 2026-09-05 -- GetQueryStats' top queries were all
// cheatsheets.davidveksler.com content), and neither GetRankAndTrafficStats
// nor GetQueryStats takes a page/host filter, unlike GSC's gscPageFilter. See
// the comment on the davidveksler.com row in src/config.js for why that
// property is deliberately NOT wired into the dashboard's nightly pull.
//
// GetPageStats returns the same QueryStats wire shape as GetQueryStats, with
// the page URL riding in the field still (confusingly) called `Query` -- see
// the NOTE above queryKeywords in src/bing.js for why the dashboard itself
// doesn't call this endpoint (subrequest budget). This script runs outside
// the Worker, so that budget doesn't apply -- it's a manual/periodic report,
// not a third nightly fetch.
//
// Usage:
//   node scripts/bing-root-domain-stats.mjs [--site-url URL] [--host HOST] [--top N]
//
// Reads the API key from $BING_WEBMASTER_API_KEY, or from
// ~/Projects/.bing.env (BING_WEBMASTER_API_KEY=...) if that env var is unset.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBingDate, latestDateRows } from "../src/bing.js";

const BASE = "https://ssl.bing.com/webmaster/api.svc/json";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectsRoot = path.resolve(scriptDir, "..", "..");

function parseArgs(argv) {
  const opts = { siteUrl: "https://davidveksler.com/", host: null, top: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--site-url") opts.siteUrl = argv[++i];
    else if (a === "--host") opts.host = argv[++i];
    else if (a === "--top") opts.top = Number(argv[++i]);
    else if (a === "-h" || a === "--help") opts.help = true;
  }
  if (!opts.host) opts.host = new URL(opts.siteUrl).hostname.toLowerCase();
  return opts;
}

async function loadApiKey() {
  if (process.env.BING_WEBMASTER_API_KEY) return process.env.BING_WEBMASTER_API_KEY;
  const envPath = path.join(projectsRoot, ".bing.env");
  const text = await readFile(envPath, "utf8").catch(() => null);
  if (!text) {
    throw new Error(
      `No BING_WEBMASTER_API_KEY in the environment and no key file at ${envPath}.`
    );
  }
  const m = /^BING_WEBMASTER_API_KEY=(.+)$/m.exec(text);
  if (!m) throw new Error(`${envPath} has no BING_WEBMASTER_API_KEY= line.`);
  return m[1].trim();
}

async function getPageStats(apiKey, siteUrl) {
  const url = new URL(`${BASE}/GetPageStats`);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("siteUrl", siteUrl);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Bing GetPageStats ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  return body.d ?? [];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Root-domain-only Bing stats (excludes subdomains Bing's apex property mixes in).

Usage:
  node scripts/bing-root-domain-stats.mjs [--site-url URL] [--host HOST] [--top N]

  --site-url URL   Bing-verified property URL (default: https://davidveksler.com/)
  --host HOST      Exact hostname to keep (default: derived from --site-url)
  --top N          How many root-domain pages to list (default: 15)`);
    return;
  }
  run(opts).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

async function run(opts) {
  const apiKey = await loadApiKey();
  const raw = await getPageStats(apiKey, opts.siteUrl);
  const { date, rows } = latestDateRows(raw);
  if (!date) {
    console.log(`No dated rows returned for ${opts.siteUrl}.`);
    return;
  }

  const rootRows = [];
  const subdomainRows = [];
  for (const r of rows) {
    let hostname;
    try {
      hostname = new URL(r.Query).hostname.toLowerCase();
    } catch {
      continue; // not a URL row, skip rather than mis-bucket it
    }
    (hostname === opts.host ? rootRows : subdomainRows).push(r);
  }

  const sum = (list, field) => list.reduce((s, r) => s + Number(r[field] || 0), 0);
  const rootClicks = sum(rootRows, "Clicks");
  const rootImpressions = sum(rootRows, "Impressions");
  const allClicks = sum(rows, "Clicks");
  const allImpressions = sum(rows, "Impressions");

  console.log(`Bing page stats for ${opts.siteUrl} -- window ${date}`);
  console.log(`  Property total:     ${allClicks} clicks / ${allImpressions} impressions (${rows.length} pages)`);
  console.log(
    `  ${opts.host} only:  ${rootClicks} clicks / ${rootImpressions} impressions ` +
      `(${rootRows.length} pages, ${allImpressions ? ((rootImpressions / allImpressions) * 100).toFixed(1) : "0.0"}% of the property's impressions)`
  );
  console.log(
    `  Other subdomains:   ${allClicks - rootClicks} clicks / ${allImpressions - rootImpressions} impressions ` +
      `(${subdomainRows.length} pages)`
  );

  if (rootRows.length) {
    console.log(`\nTop ${opts.host} pages by impressions:`);
    const top = [...rootRows].sort((a, b) => b.Impressions - a.Impressions).slice(0, opts.top);
    for (const r of top) {
      const pos = r.AvgImpressionPosition >= 0 ? r.AvgImpressionPosition.toFixed(1) : "—";
      console.log(`  ${r.Impressions}\timp  ${r.Clicks}\tclicks  pos ${pos}\t${r.Query}`);
    }
  } else {
    console.log(`\nNo pages under ${opts.host} itself in this snapshot.`);
  }
}

main();
