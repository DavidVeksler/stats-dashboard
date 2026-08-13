# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Doc routing — read the smallest path

| Task | Read |
| --- | --- |
| What this is / architecture / data flow | this file |
| Commands | this file (`## Commands`) |
| Signal rules, severities, thresholds | `src/signals.js` (one module, all rules) |
| Planned work / why a thing is shaped this way | `docs/actionability-spec.md` |
| Secrets / env | this file (`## Secrets`) |
| Deploy | `deploy.sh` / `deploy.ps1` (+ README) |
| Home-screen icons / manifest / splash screens | `scripts/generate-icons.mjs` (regen with `npm run icons`) |
| Content / marketing / SEO / KPI docs | N/A — internal WAF-gated dashboard, not a marketing surface |
| Measurement data | the D1 database (`schema.sql`: `daily_traffic`, `daily_referrers`, `daily_keywords`, `daily_zone_bots`, `runs`), not docs |
| Making the dashboard actionable / open design work | `docs/actionability-spec.md` (items 1, 2 and 3 implemented; the rest proposed) |
| What counts as a search "opportunity" | `src/opportunities.js` — one predicate, imported by both `index.js` and `render.js` |
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
that is where a flooded day used to erase a whole site card, and where the signal rules are exercised
end-to-end against the real 2026-08-13 fixtures), and a render smoke test.
`node scripts/dashboard-check.mjs --signals` prints the signal list those fixtures produce, which is
the fastest way to see what a rule change does. Beyond that, verification is
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
- **`GET /`** calls `loadDashboard()` → reads the latest snapshot from D1 → `computeSignals()` (`signals.js`) ranks what needs doing → `renderDashboard()` (`render.js`) returns a self-contained HTML page. The page is served from stored snapshots (not live pulls), which is what makes 14-day sparklines possible. `GET /api/json` returns the same data; `GET /health` returns `ok`.

**The signal engine** (`src/signals.js`) is where every rule lives. `computeSignals` is a **pure function of rows `loadDashboard` has already read** — it queries nothing — which is what lets `runDaily` reuse it for the ntfy push instead of growing a second copy of the rules. When a rule needs more history, **widen an existing read rather than adding a query** (`daily_zone_status` was widened from latest-day to the history window for the `error-spike` baseline). Signals are `{ severity, kind, host, headline, evidence, action, href, recurrence }`, severity 1 = act today, 2 = look at it, 3 = context; the top three severity-1/2 signals render as "Today's actions" above the KPI tiles, and the top severity-1 signal is appended to the ntfy push. `recurrence` is populated only where the loaded history answers it exactly (today: consecutive flooded days behind `no-comparison`, in the 24h view) — nothing guesses it, because a wrong "3rd consecutive day" is worse than an absent one.

**Two measurement classes, never mixed.** `loadDashboard` partitions `SITES` on
`site.trafficSource` into `measurement: "rum"` and `measurement: "zone"` (the `measurementOf`
helper — derived from config, never from a hostname; `site.zoneSourced` is the same fact as a
boolean). Every session-shaped aggregate in `totals.*` — `visits`, `views`, `pagesPerSession`,
`previousVisits`, `sourceMix`, and the crawler/partial counters — reduces over **RUM sites only**.
Zone volume is reported beside it in `totals.zone = { visits, requests, bytes, sites, hosts }`,
rendered as its own strip under the KPI tiles and its own `Zone-log measurement` card section, and
`options.sort` ranks within a class rather than across it. Why: a zone host has no RUM beacon, so
its numbers are HTTP request counts out of the zone log and its "visits" is Cloudflare's arrival
heuristic over those requests (crawler fetches of `robots.txt` included). They are not sessions and
are not comparable to them. Summing them produced a headline "pages / session" of 10.4 on
2026-08-13 — 20,897 "pageviews" of which 19,506 were library.freecapitalists.org HTTP requests —
against a true RUM figure of 1.46 over 953 sessions. Zone-sourced sites are not dropped: zone logs
are the only instrumentation those hosts have. They are reported in their own units.

The **search-opportunity predicate lives once**, in `src/opportunities.js` (`isOpportunity` plus its
named thresholds). `loadDashboard` uses it for `totals.opportunities`, `render.js` uses it for the
badge, and the footer prose interpolates the same constants. It used to exist twice, over different
row sets, so the headline count could exceed the visible badges with no way to tell that from a bug.

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
- **A zone-sourced host can never be flagged as flooded, so it must never sit in a session total.**
  `classifyTraffic` derives `directShare` from `daily_referrers` rows, and a zone host writes none
  (zone logs carry no referer dimension), so `direct = 0`, `signature` is always false, and no
  volume flags it. Until the RUM/zone split landed, library.freecapitalists.org's raw crawler
  traffic flowed straight into "Human sessions", supplying 1,059 of 2,012 (52.6%) on 2026-08-13
  while its own top file was `/robots.txt` at 684 requests. Keep every session-shaped aggregate
  RUM-only (see "Two measurement classes" above). `crawlerAccounting(site)` in `src/bots.js` is the
  routing that replaces the missing verdict — see the next bullet for what it routes to.
- **Verified bots are a FLOOR on crawler volume, never a bot/human split.** Zone hosts get two
  independent lenses instead of a flood verdict, both on the zone card, and **the renderer is
  required to say they must not be added** (they overlap: a verified crawler fetches `robots.txt`
  too, and there is no stored `(path, status)` pair to measure the overlap with).
  1. **Verified crawlers** — the `verifiedBotCategory` dimension on `httpRequestsAdaptiveGroups`,
     pulled with both `count` and `sum { visits }` (the visits figure is what lets the card
     decompose its own zone-visit headline), stored in `daily_zone_bots(date, host, category,
     requests, visits)` and summarized by `summarizeVerifiedBots`. Cloudflare labels **only** the
     bots it cryptographically verifies; everything else comes back with an empty category, which
     we store under the explicit name `(unverified)` so a bucket meaning "not verified" can never
     be read as one meaning "human". On library that bucket was 84.6% of a 21,929-request day
     (verified: Archiver 936, Search Engine Crawler 867, AI Crawler 696, SEO 446, AI Search 405,
     Page Preview 21, Monitoring 10, Accessibility 8 = 3,389, i.e. 15.4%).
  2. **Non-content requests** — `/robots.txt`, `/favicon.ico`, `/sitemap*`, `/.well-known/*`,
     `/cdn-cgi/*` from `daily_cf_pages`, plus every response `>= 400` from `daily_zone_status`
     (`summarizeNonContent`). No new query; both components are returned separately and there is
     deliberately **no combined total field**, because they overlap each other too.

  **Do not re-run the bot-dimension spike** (done 2026-08-12 against zone
  `066e5342a1531be2638029c2f1dde5f6`): `botScore` and `botScoreSrcName` are **plan-gated** —
  `"zone … does not have access to the field 'botscore'"`, `code: "authz"`, no workaround — and
  `clientRequestUserAgent` is **not a valid dimension** on this dataset (`unknown field`). Nothing
  can separate the unverified bucket on this plan, so **never derive a human count for a zone host**:
  do not subtract the floor and call the remainder human, do not interpolate, do not add the two
  lenses. `summarizeVerifiedBots` intentionally exposes no `human*` field and `bots-check.mjs`
  asserts that; the card says outright that the remainder cannot be characterized.
- **Two dimensions in one zone query are legal.** The one-dimension-per-call convention at
  `src/cloudflare.js:73-79` is a 5,000-row-cap workaround for high-cardinality combinations, not an
  API ceiling. The same spike confirmed `{ clientRequestPath, edgeResponseStatus }` filtered
  `edgeResponseStatus_geq: 400` returns 1,376 rows on this zone without approaching the cap. Pair
  dimensions only where a filter keeps the product that small.
- **Footer prose is interpolated, not retyped.** The flood thresholds and the opportunity
  thresholds in `render.js`'s footer come from the exported constants in `src/bots.js`
  (`FLOOD_MIN_VISITS`, `FLOOD_MULTIPLE`, `FLAT_PAGES_PER_SESSION`, `DIRECT_SHARE`) and
  `src/opportunities.js`. `render-check.mjs` asserts the rendered sentence against those same
  imports, so changing a threshold and not the prose fails `npm run check`. The prose had already
  drifted once: it claimed flooded days were "excluded whole, from sessions, referrers, and landing
  pages alike" for as long as `splitDay` had been keeping the referred sessions.
- **Signals respect measurement class, and the gate is not optional.** Session-delta and
  pages-per-session rules run on **RUM sites only**. A zone-sourced host is measured in HTTP requests
  out of the zone log, so "sessions rose 40%" or "pages/session fell by 2.1" about one is not a weak
  signal, it is a different quantity wearing the same words — the live NOTABLE list led with exactly
  that for library.freecapitalists.org. Zone hosts are eligible **only for zone-specific rules**;
  today that is `error-spike`. The gate reads `site.measurement` / `site.zoneSourced`, never a
  hostname. Adding a rule means deciding which class it belongs to first.
- **Every ratio rule carries an absolute floor.** A percentage on a single-digit base is noise
  dressed as signal (`whopaysforai.org ↑600%` was 6 sessions to 7). `DELTA_MIN_ABSOLUTE` in
  `src/signals.js` is imported by `deltaBadge` in `src/render.js` so the per-card badge and the
  signal list share one floor: below it the badge renders the raw change (`+13`) muted instead of a
  percentage. `likely-bot-subflood` has its own, deliberately lower floor (≥ 50 sessions of change
  **and** ≥ 100 resulting sessions, not the ≥ 100 absolute change the spec first proposed, which
  would have missed the live wiki.freecapitalists.org spike it was written for at +97). The three
  shape tests beside it — flat pages/session, ≥ 80% direct, one landing page taking ≥ 80% of
  entrances — are what make a low volume floor safe there.
- **`likely-bot-subflood` and `traffic-rise` are mutually exclusive by construction.** A spike is
  either growth or a crawler; reporting it as both is how the reader learns to ignore the list.
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
