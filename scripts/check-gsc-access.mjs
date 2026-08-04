#!/usr/bin/env node
//
// check-gsc-access.mjs — verify every `gsc` property in src/config.js is
// actually reachable by the service account the Worker authenticates as.
//
// This exists because the failure mode is silent: a property the service
// account can't read returns 403 per-site inside runDaily, which only lands in
// the `runs.note` column and the tail of an ntfy push. The dashboard just shows
// a site with no search data, which looks identical to a site with no traffic.
// Two real bugs hid there — a URL-prefix property registered on http:// while
// the config asked for https://, and a property the service account was never
// added to as a user.
//
// Usage:
//   node scripts/check-gsc-access.mjs      # or: npm run check:gsc
//
// Auth: GOOGLE_SERVICE_ACCOUNT_FILE, else ~/.claude/mcp-servers/gsc-service-account.json
// (the same key the search-console MCP server uses). Never commit that file.
//
// Exits 1 if any configured property is unreachable, so it can gate a deploy.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SITES } from "../src/config.js";
// Reuse the Worker's own auth path so this tests what production actually does.
import { getAccessToken } from "../src/gsc.js";

const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_FILE
  || join(homedir(), ".claude", "mcp-servers", "gsc-service-account.json");

let sa;
try {
  sa = JSON.parse(readFileSync(KEY_PATH, "utf8"));
} catch (e) {
  console.error(`Cannot read service-account key at ${KEY_PATH}\n  ${e.message}`);
  console.error("Set GOOGLE_SERVICE_ACCOUNT_FILE, or see WalletRecovery.info/docs/runbooks/search-console-setup.md");
  process.exit(2);
}

const token = await getAccessToken(sa, Math.floor(Date.now() / 1000));
const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error(`GSC sites list ${res.status}: ${await res.text()}`);
  process.exit(2);
}

const reachable = new Map(
  ((await res.json()).siteEntry ?? []).map((s) => [s.siteUrl, s.permissionLevel]),
);

console.log(`service account: ${sa.client_email}`);
console.log(`reachable properties: ${reachable.size}\n`);

const missing = [];
for (const { host, gsc } of SITES) {
  const level = reachable.get(gsc);
  if (level) {
    console.log(`  OK    ${host}\n          ${gsc} (${level})`);
  } else {
    missing.push({ host, gsc });
    // A property registered on the other protocol is the single most common
    // cause, so name the near-miss instead of just reporting "not found".
    const swapped = gsc.startsWith("https://") ? gsc.replace(/^https:/, "http:")
      : gsc.startsWith("http://") ? gsc.replace(/^http:/, "https:") : null;
    const hint = swapped && reachable.has(swapped)
      ? `reachable as ${swapped} — protocol mismatch in config`
      : "not granted to this service account (GSC → Settings → Users and permissions → Add user)";
    console.log(`  FAIL  ${host}\n          ${gsc}\n          ${hint}`);
  }
}

// Properties the account can read that no site uses — candidates to track.
const configured = new Set(SITES.map((s) => s.gsc));
const unused = [...reachable.keys()].filter((u) => !configured.has(u)).sort();
if (unused.length) {
  console.log(`\nreachable but not tracked (${unused.length}):`);
  for (const u of unused) console.log(`  - ${u}`);
}

console.log();
if (missing.length) {
  console.log(`${missing.length} of ${SITES.length} configured properties are unreachable; those sites will silently report no search data.`);
  process.exit(1);
}
console.log(`all ${SITES.length} configured properties reachable`);
