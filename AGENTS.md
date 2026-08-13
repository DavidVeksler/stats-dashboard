# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Doc routing — read the smallest path

| Task | Read |
| --- | --- |
| What this is / architecture / data flow | this file |
| Commands | this file (`## Commands`) |
| Secrets / env | this file (`## Secrets`) |
| Deploy | `deploy.sh` / `deploy.ps1` (+ README) |
| Home-screen icons / manifest / splash screens | `scripts/generate-icons.mjs` (regen with `npm run icons`) |
| Content / marketing / SEO / KPI docs | N/A — internal WAF-gated dashboard, not a marketing surface |
| Measurement data | the D1 database (`schema.sql`: `daily_traffic`, `daily_referrers`, `daily_keywords`, `runs`), not docs |
| Making the dashboard actionable / open design work | `docs/actionability-spec.md` (proposed, not implemented) |
| Everything else | this file |

## What this is

A single Cloudflare Worker that powers **https://stats.davidveksler.com** — a daily
per-domain dashboard of traffic + referrers (Cloudflare Web Analytics) and search
keywords (Google Search Console). No framework, no build step beyond wrangler's esbuild
bundling. Plain ES modules under `src/`.

`public/` holds static "Add to Home Screen" assets (favicons, apple-touch-icons, manifest
icons, Apple splash screens) served directly by Workers Static Assets (`wrangler.jsonc`
`assets.directory`) — these never touch `src/index.js`. Every file in `public/` is generated
by `scripts/generate-icons.mjs`; re-run `npm run icons` after changing the brand mark or
colors, never hand-edit files under `public/` or `src/appleSplashLinks.js`.

## Commands

```sh
./deploy.sh                     # canonical deploy: token, ensure secrets, deploy, verify /health
./deploy.sh --refresh           # deploy, then trigger a live pull (/run) and print JSON result
./deploy.sh --gsc-key key.json  # also (re)set the GSC_SA_KEY secret
./deploy.sh --schema            # also (re)apply schema.sql (best-effort; see D1 gotcha below)
npm run refresh                 # trigger /run without deploying; reads .deploy/refresh_key.txt
npm run tail                    # live Worker logs (npx wrangler tail)
```

`npm run check` covers syntax, the crawler classifier (`scripts/bots-check.mjs`, real Aug 2026
traffic shapes — since a false positive deletes real traffic from the dashboard), the aggregation
layer above it (`scripts/dashboard-check.mjs` drives `loadDashboard` against a stubbed D1, because
that is where a flooded day used to erase a whole site card), and a render smoke test. Beyond that, verification is
end-to-end: hit `/run` and read the returned `{gscOk, totalVisits, humanVisits, botVisits, notes}`,
or inspect the `runs` table in D1. `npm run dev` runs
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
- **Crawlers are counted as humans by RUM, and we do NOT block them.** These sites opt into AI
  training (`Content-Signal: ai-train=yes`); the fix is measurement, not blocking. `src/bots.js`
  classifies each *site-day* and sets aside "floods" (≥90% direct, ≤1.15 pages/session, ≥500
  sessions, ≥3× a normal day). On a flooded day the direct bucket and the landing-page rows are
  set aside; referred sessions still count (see the next bullet). Excluded volume is always
  reported separately — never silently dropped. Two things to preserve:
  (1) the flood test is deliberately **volume-free** (`day.signature`) so the baseline can be
  built from the days that fail it without circular reasoning; (2) when too few clean days
  remain, the baseline falls back to the **25th percentile**, not the median — a median inside a
  sustained flood blesses the flood as normal, which is exactly how the Aug 2026
  forum.objectivismonline.com flood went unflagged for eight days.
- **A flooded day is partially recoverable — only the direct bucket is lost.** The flood test is
  largely a test for direct traffic (crawlers arrive with no referer), so the *referred* sessions
  on a flooded day are still a real measurement and are counted (`splitDay` in `src/bots.js`).
  What can't be recovered is the direct bucket, where crawler and human are mixed beyond
  separation, and pageviews, which carry no referer dimension at all. Consequences to preserve:
  a flooded-day total is a **floor**, rendered with `≥`; pages/session divides clean views by
  **clean** sessions only; deltas are suppressed when either side of the comparison is partial
  (a floor vs a full count is not a like-for-like change); `daily_cf_pages` rows on flooded days
  stay excluded whole. Don't "improve" any of this by interpolating the missing direct traffic —
  it is reported as crawler volume, not estimated.
  Before this split existed, a site whose only day in view was flooded rendered a completely
  blank card (freecapitalists.org, 2026-08-09).
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
