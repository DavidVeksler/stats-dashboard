# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

A single Cloudflare Worker that powers **https://stats.davidveksler.com** — a daily
per-domain dashboard of traffic + referrers (Cloudflare Web Analytics) and search
keywords (Google Search Console). No framework, no build step beyond wrangler's esbuild
bundling. Plain ES modules under `src/`.

## Commands

```sh
./deploy.sh                     # canonical deploy: token, ensure secrets, deploy, verify /health
./deploy.sh --refresh           # deploy, then trigger a live pull (/run) and print JSON result
./deploy.sh --gsc-key key.json  # also (re)set the GSC_SA_KEY secret
./deploy.sh --schema            # also (re)apply schema.sql (best-effort; see D1 gotcha below)
npm run tail                    # live Worker logs (npx wrangler tail)
```

There are no unit tests. Verification is end-to-end: hit `/run` and read the returned
`{gscOk, totalVisits, notes}`, or inspect the `runs` table in D1. `npm run dev` runs
`wrangler dev` locally, but the data pulls need the real secrets and network.

## Data flow (the big picture)

The Worker has two entry points in `src/index.js`:

- **`scheduled`** (cron `0 13 * * *`) and **`GET /run?key=…`** both call `runDaily(env)`, which:
  1. `pullTraffic()` (`cloudflare.js`) → Cloudflare GraphQL → 24h visitors/referrers.
  2. `queryKeywords()` (`gsc.js`) → Google Search Console → top keywords (only if `GSC_SA_KEY` set).
  3. Writes one snapshot per domain into **D1** (`daily_traffic`, `daily_referrers`, `daily_keywords`), plus a `runs` row.
  4. `sendNtfy()` pushes a summary to `ntfy.sh/$NTFY_TOPIC`.
- **`GET /`** calls `loadDashboard()` → reads the latest snapshot from D1 → `renderDashboard()` (`render.js`) returns a self-contained HTML page. The page is served from stored snapshots (not live pulls), which is what makes 14-day sparklines possible. `GET /api/json` returns the same data; `GET /health` returns `ok`.

`src/config.js` is the source of truth for **which domains** (`SITES`) and **which Cloudflare
accounts** (`CF_ACCOUNTS`) to query. Each site maps a CF `host` (the Web Analytics
`requestHost`) to its exact GSC property string (`sc-domain:…` or a URL prefix). An optional
`gscPageFilter` RE2 expression narrows a broad GSC property by result page URL.

## Non-obvious gotchas (these will bite you)

- **Two API tokens.** `~/Projects/.cloudflare.env` holds **two** `CLOUDFLARE_API_TOKEN=` lines.
  Naively grabbing them with `grep … \S+` concatenates both into an invalid `Bearer` header.
  Use `grep -m1 … | head -1` (deploy.sh already does). The **first** token has Workers + DNS
  edit scope needed to deploy.
- **D1 management API is NOT in scope for that token.** The token deploys the Worker and binds
  D1 at *runtime* fine, but `wrangler d1 execute --remote` and the D1 REST/import API fail with
  `Authentication error [code 10000]` / `7500`. Apply `schema.sql` via the **Cloudflare D1
  console or the MCP `d1_database_query` connector** (separate OAuth), not the token. The schema
  is a one-time bootstrap; `deploy.sh` skips it by default.
- **Web Analytics (RUM) is account-scoped, not zone-scoped.** The dataset is
  `rumPageloadEventsAdaptiveGroups` under `viewer.accounts`, NOT under `zones` (querying it on a
  zone errors with "unknown field"). `pullTraffic` queries all `CF_ACCOUNTS` and merges rows by
  `requestHost`, because a host can live on any account.
- **"visitors" = sessions, not uniques.** RUM `visits` is only counted on a session's first
  pageview, so internal navigation (`refererHost === requestHost`) carries `visits: 0` and is
  intentionally dropped from referrers. Cloudflare's free tier doesn't expose unique visitors.
- **GSC lags ~2 days.** `runDaily` requests the window `date-4 … date-2`, so keyword data is
  never truly "last 24h". The dashboard labels this.
- **`runDaily` only deletes keyword rows inside the `if (env.GSC_SA_KEY)` block** — so a run with
  no GSC key refreshes traffic without wiping existing keywords. Preserve that guard.
- **WAF blocks bot user-agents.** Requests to `stats.davidveksler.com` (davidveksler.com zone)
  from a non-browser UA get Cloudflare error **1010**. Use a real browser `User-Agent` when
  curling/fetching `/run` or `/health`.

## Secrets

Set via `wrangler secret put` (or auto-provisioned by `deploy.sh`): `CF_API_TOKEN`
(Worker's own analytics-scoped token for GraphQL), `REFRESH_KEY` (guards `/run`; persisted
locally in gitignored `.deploy/refresh_key.txt`), `GSC_SA_KEY` (Google service-account JSON,
one line). `NTFY_TOPIC` is a plain var in `wrangler.jsonc`.
