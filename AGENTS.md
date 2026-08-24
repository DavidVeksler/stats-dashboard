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
| Measurement data | the D1 database (`schema.sql`: `daily_traffic`, `daily_referrers`, `daily_keywords`, `daily_zone_bots`, `daily_forum_activity`, `runs`), not docs |
| Making the dashboard actionable / open design work | `docs/actionability-spec.md` (items 1–8 implemented; 9, 10, 11 proposed) |
| What counts as a search "opportunity", and which of the two kinds it is | `src/opportunities.js` — one classifier, imported by both `index.js` and `render.js` |
| Expected CTR by position, and where the benchmark came from | `src/opportunities.js` (`CTR_ANCHORS`, sourced and dated in the comment above it) |
| How many search queries are stored per site, and why that number | `src/gsc.js` (`KEYWORD_ROW_LIMIT`) |
| Why a night's writes are chunked, and the ordering rule that makes it safe | `src/index.js` (`D1_MAX_BATCH_STATEMENTS`, `batchInChunks`), asserted by `scripts/write-check.mjs` |
| Declining to pursue a query on a given site | `src/config.js` (`queryDenyPatterns`, shipped unset) |
| Forum user login/activity stats | `src/discourse.js` + `FORUMS` in `src/config.js` — no API key, see the note below |
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
end-to-end against the real 2026-08-13 fixtures), the **write** path
(`scripts/write-check.mjs` drives `runDaily` against a stubbed D1, Cloudflare and Search Console —
it is the only check that touches writes, and it exists because the night's batch is now chunked;
see the chunked-write gotcha below), and a render smoke test.
`node scripts/dashboard-check.mjs --signals` prints the signal list those fixtures produce, and
`--opportunities` prints both ranked opportunity classes; between them they are the fastest way to
see what a rule, threshold or CTR-curve change does. `node scripts/write-check.mjs --verbose` prints
the shape of a night's write (statements, batches, statements per table), which is the fastest way to
see what moving `KEYWORD_ROW_LIMIT` or `D1_MAX_BATCH_STATEMENTS` costs.
`npm run preview` writes `.preview/dashboard.html`
for inspection without deploying (the WAF blocks non-browser user agents on the live host, so parse
the file rather than curling the site). Beyond that, verification is
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

The **search-opportunity classifier lives once**, in `src/opportunities.js` (`classifyOpportunity`
plus its named thresholds; `isOpportunity` is the boolean form and `rankOpportunities` the sorted
form). `loadDashboard` uses it for `site.opportunities` and the headline counts, `render.js` uses it
for the badge, `signals.js` reads the ranked lists, and the footer prose interpolates the same
constants. It used to exist twice, over different row sets, so the headline count could exceed the
visible badges with no way to tell that from a bug.

**Every KPI tile carries a comparator**, built in `loadDashboard` from history it has already read —
`totals.trend` holds the 14-day means, and no new query was added for any of them. A number that
answers none of *is this normal? / what changed? / what do I do?* is decoration, so a bare figure on
a tile is a bug, not a style choice.

**Forum activity (Discourse) is a third, independent pull**, alongside Cloudflare/RUM and GSC —
`FORUMS` in `src/config.js`, pulled by `src/discourse.js`, stored in `daily_forum_activity`,
rendered as its own "Forum activity (Discourse)" section below the zone-log section rather than
folded into `sites`. It answers "how many people logged in / signed up," which SITES (traffic +
search) has no notion of. **No API key**: `pullForumStats` reads each forum's public
`/about.json`, whose `about.stats` object already carries the exact rolling-window counters
(`active_users_last_day/7_days/30_days`, `users_count`, `users_last_day/7_days/30_days`) Discourse's
own admin dashboard shows, served to anonymous requests on both live forums as of 2026-08-21. This
was a deliberate choice over paginating the admin-only `/admin/users/list/active.json` (which the
admin UI links to) — that endpoint needs an Admin API key and, at up to 59,639 users, would need
many paginated requests to answer the same three numbers about.json gives in one anonymous call.
Two read-only (`global:read`, GET-only) API keys were created and then revoked the same day once
the about.json approach proved sufficient — if `/admin/users/list/active.json` or
`/admin/reports/*.json` (visits, signups, dau_by_mau) are ever needed for a richer forum card, the
Rails-runner recipe for minting a scoped key lives in this session's history, not in this repo.
If a forum ever sets `login_required` or otherwise hides its about stats, the pull starts failing
loudly (a note in the `runs` table) rather than silently zeroing — see `parseAboutStats` in
`discourse.js` and `scripts/discourse-check.mjs`.

`src/config.js` is the source of truth for **which domains** (`SITES`) and **which Cloudflare
accounts** (`CF_ACCOUNTS`) to query. Each site maps a CF `host` (the Web Analytics
`requestHost`) to its exact GSC property string (`sc-domain:…` or a URL prefix). An optional
`gscPageFilter` RE2 expression narrows a broad GSC property by result page URL. An optional
`queryDenyPatterns` array excludes queries from the opportunity classes — see the gotcha below.

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
  pageview, so navigation within one hostname (`refererHost === requestHost`) carries `visits: 0` and
  contributes nothing either way. A hop between a site's *own different* hostnames does start a
  session — see the `internal` kind below. Cloudflare's free tier doesn't expose unique visitors.
- **`kind: "internal"` in `daily_referrers` is FORWARD-ONLY and cannot be backfilled.** Referrer
  kinds are frozen into the row at write time by `topReferrers` → `classifyReferrer(ref, selfHost)`,
  so no row stored before 2026-08-13 carries it and no migration can add one — the referer that
  would decide it is not in D1 at all. A session arriving from one of a site's own alias hostnames
  (an apex landing page handing off to the forum) used to be counted in `rec.visits` with its
  referrer row dropped, so it reappeared as an unattributable residual in the traffic-source panel.
  Consequences to preserve: `totals.internalMeasured` says whether **any** row *in the selected
  window and for the selected hosts* carries the kind, and when it does not the channel is **omitted
  from the panel entirely** rather than drawn as `Internal 0 · 0.0%`. A rendered zero there would
  assert a measurement nobody took. This matters most in `?period=7` and `?period=30`, which still
  reach back over pre-change rows — test both, not only the 24h view.
- **`kind: "ai"` is a per-row badge, not a mix-bar channel, because it is known to undercount.**
  `classifyReferrer` recognizes a short list of AI chat/answer-engine referrer hosts
  (`AI_ANSWER_ENGINES` in `src/config.js`) and tags matching rows `ai` — same write-time-frozen,
  forward-only rule as `internal` above. It is deliberately **not** added to `totals.sourceMix`:
  `summarizeSources` in `src/index.js` folds `ai` into `referral` for every aggregate, so the KPI
  tiles and the traffic-source bar are unaffected. Reason: most AI chat surfaces don't reliably send
  a `Referer` at all (`noreferrer` links, JS-driven navigation), and Google's AI Overviews and Bing
  Copilot pass their parent engine's own referrer (`google.`/`bing.`), indistinguishable from
  ordinary search — so this list only ever catches a fraction of real AI-driven traffic. Promoting
  it to a headline channel would imply a completeness the data can't back up. If that changes (a
  reliable way to separate AI Overview / Copilot clicks turns up), reconsider promoting it — until
  then it stays a badge on `referrerList`'s per-row tags only.
- **`Unattributed` is a residual, not a channel, and must never be rendered as one.** It is
  `visits - (direct + search + social + referral + internal)`, so it measures the disagreement
  between two tables rather than any behavior. It used to be called `Other / unlisted` and rendered
  as a fifth segment competing with Direct and Search — at which point the largest "channel" on the
  page (1,060 of 2,012 sessions, 52.7%) was an accounting hole. It now renders **outside** the
  percentage bar as a footnote with its causes named (top-50-per-host-day referrer truncation, and
  the pre-`internal` rows above). Do not put it back in the bar, and do not close the gap by
  inventing an attribution for it.
- **Two opportunity classes, two remedies, and deliberately TWO SORT METRICS.** `snippet` is a query
  at position ≤ `SNIPPET_MAX_POSITION` taking under `SNIPPET_CTR_RATIO` of `expectedCtr(position)`:
  it already ranks, so the fix is the title and meta description, and it is ranked by **lost
  clicks** = `impressions × (expectedCtr(position) − ctr)`. `rank` is a query between
  `SNIPPET_MAX_POSITION` and `RANK_MAX_POSITION`: nobody ever saw the snippet, so the fix is content
  and internal links, and it is ranked by **potential clicks** = `impressions ×
  expectedCtr(TARGET_POSITION) − clicks`. Past `RANK_MAX_POSITION` a query is neither badged nor
  counted. **Do not unify the two metrics.** Lost clicks measures what is recoverable *at the current
  rank*, which is right for a snippet and structurally near-zero for a ranking problem: every
  ranking-class query in the fixtures scores under `MIN_ACTIONABLE_CLICKS` on lost clicks, so a
  single lost-clicks gate would not demote that class, it would delete it. The live case is
  `bitcoin recovery` on walletrecovery.info — 13 impressions, 0 clicks, position 31.2, ~0.07 lost
  clicks and ~0.94 potential clicks. Every rendered badge reads `snippet` or `rank`; a bare
  `opportunity` badge is a regression, because it names a problem without naming which of two
  unrelated fixes applies.
- **BOTH SIDES OF A COMPARATOR MUST COME FROM THE SAME POPULATION, and the tile must name it.**
  This has gone wrong twice, in different shapes, so it is a rule rather than a habit.
  (1) **The Search CTR tile.** The headline `totals.gscCtr` is the whole corpus out of
  `daily_search_summary` — every query on every property, deep tail included, 58,832 impressions —
  but `expectedCtr` needs a per-query position and the only per-query rows stored are the top
  `KEYWORD_ROW_LIMIT` queries GSC returns per site, a better positioned sample than the corpus and
  (until the cap was raised from 25) a tiny one. The tile printed `0.4%` beside
  `expected ~5.9% at this position mix` and asserted a 15× shortfall; the corpus mean position of
  10.1 expects roughly 2.5%, so the real gap was nearer 6×. The comparator is now computed on both
  sides over `latestKeywordRows` (`totals.gscSampleCtr` and `totals.gscExpectedCtr` share the
  `gscSampleImpressions` denominator), the headline is labelled `headline covers every query`, and
  `totals.gscSampleShare` states the sample's impression coverage — `thin sample` below
  `THIN_SAMPLE_SHARE`. Same fix in the position tile's subtitle: `N of M **stored top** queries in
  the top 10`, because `7 of 11 queries` read as though the estate had 11 queries.
  (2) **The `error-spike` baseline** counted days with no `daily_zone_status` row as 0%-error days,
  so an unmeasured stretch dragged the mean down and manufactured a spike out of an ordinary day;
  `errorSeries` now builds the series from measured days only. `dashboard-check.mjs` asserts the CTR
  comparator's two sides against a fixture whose stored keyword rows deliberately disagree with the
  `daily_search_summary` totals, so a mismatch fails the check rather than shipping. Before adding
  any comparator, say out loud which rows each side is drawn from; if the answer differs, it is not
  a comparison.
- **`expectedCtr()` is an approximation and the page must never treat it as a target.** The anchors
  are the SISTRIX 2020 CTR study (positions 1, 2, 3, 10 measured over ~80M keywords); positions 4–9
  are log-linear interpolation between them, and everything past 10 is our own estimate of a flat
  tail. It is a 2020 average across every query intent there is, so branded queries beat it and
  AI-Overview queries lose to it badly. Hence: nothing derived from it renders with more than one
  decimal place, it is always prefixed `expected ~`, and no threshold fires on a small shortfall
  against it (`SNIPPET_CTR_RATIO` is 0.5 for exactly this reason). If you replace the curve, keep the
  sourced-and-dated comment and keep the measured/interpolated/estimated distinction explicit.
- **`queryDenyPatterns` exists and ships unset on every site — leave it that way.** It is an optional
  array of JS regex *sources* (matched case-insensitively against the query text) on a `SITES` entry
  in `src/config.js`. A matching query still renders in that site's query list, carries no badge, and
  is excluded from the two classes and the headline count, so the data stays honest while the
  recommendation list stays usable. To populate one, add the field to that site's entry and change
  nothing else; a malformed pattern denies nothing rather than throwing. **Which queries a site
  declines to pursue is the owner's editorial call**, so do not add patterns to any site on your own
  judgment — surface the query and ask.
- **`KEYWORD_ROW_LIMIT` (`src/gsc.js`, 500) is the SAME number on both sides of the pull.** It is
  what `runDaily` asks Search Console for *and* what it stores, because whatever GSC returns is what
  gets written; raising one side alone changes nothing. It was 25, which stored 119 query rows across
  the estate covering **647 of 58,832 impressions — 1.1%** — so the Search CTR comparator, which can
  only be computed over stored per-query rows, was drawn from a sample too thin to say anything (it
  labelled itself `thin sample` and was right to). Google accepts rowLimit up to 25,000, so the
  request side is not the constraint; storage is. **There is a ceiling this cannot cross:** Search
  Console omits anonymized queries from the query dimension entirely, so no limit reaches 100%
  coverage — a measured share that plateaus is the anonymization floor, not a cap to raise again.
  Tune it from the measured `totals.gscSampleShare` after a live pull. Two consequences to keep in
  mind: **per-site query counts are no longer uniform** (a small site stores 40 rows, a forum stores
  500), so nothing may assume a fixed count; and the median-position tile now sees the deep tail,
  which is what `POSITION_MIN_IMPRESSIONS` is for — the median got worse and more honest, it did not
  regress. Do **not** "fix" a surviving `thin sample` label by moving `THIN_SAMPLE_SHARE`.
- **Row growth is unpruned and that is a deliberate, human decision.** There is no retention deletion
  anywhere in this codebase. At 25 rows a site `daily_keywords` grew about 110k rows a year; at 500
  it is up to 6,000 rows a night, about **2.2M rows a year** (a few hundred MB against D1's 10 GB
  limit, so years of headroom). If that ever needs a retention policy, it is David's call — deleting
  stored history is irreversible and no agent should implement one on its own initiative.
- **The three GSC reads are deliberately NOT the same width, and the asymmetry is about cost.**
  `daily_search_summary` spans the history window because the search tiles' trailing comparators have
  no other source. `daily_keywords` and `daily_pages` are read for the **latest date only**: spec item
  8 widened all three, but every consumer of those two filters straight back down to `date`, so the
  trailing rows were read and discarded — a few thousand wasted rows a page load at 25 keywords per
  site, and up to **30 days × 12 sites × 500 = 180,000 rows on every dashboard load** at the raised
  cap. `dashboard-check.mjs` asserts the bind width of all three, so a widening cannot land silently.
  If spec item 11 (recurrence) needs per-query history, widen them back deliberately and price it
  first — and read a narrow projection or a pre-aggregated table rather than whole rows.
- **A night's writes are CHUNKED, and sequential execution is the whole safety argument.** `runDaily`
  builds one ordered statement stream and `batchInChunks` (`src/index.js`) feeds it to `env.DB.batch()`
  in groups of `D1_MAX_BATCH_STATEMENTS` (100), awaited **in order**. Roughly 6,300–7,000 statements a
  night, so about 64–70 batches. Idempotency is DELETE-the-day-then-INSERT-it-again per (table, host),
  and at 500 keyword rows a site those DELETEs and INSERTs land in *different* chunks — so running the
  chunks concurrently (`Promise.all`), sorting `stmts`, or moving a DELETE after its INSERTs would
  destroy a day of data with nothing else in the repo noticing. `scripts/write-check.mjs` asserts the
  ordering, the chunk sizes, that the flattened order is the order statements were prepared, that a
  delete/insert pair really does straddle a boundary, and that the keyword DELETEs stay inside the
  `if (env.GSC_SA_KEY)` guard. What chunking costs: a batch is a transaction, so a run that dies
  midway leaves the night partly written — self-healing, since the next run deletes and rewrites the
  same (table, host) rows wholesale, and `/run` can be triggered by hand.
- **GSC rows are a ROLLING WINDOW keyed by snapshot date, not a daily series.** All three tables
  store a row per day; only `daily_search_summary` is *read* that way (see the read-width bullet
  above — `daily_keywords` and `daily_pages` are latest-day-only, deliberately). Each
  snapshot asks Google for `date-4 … date-2`, so **consecutive rows overlap by two days out of
  three** and a day-over-day difference between them is not a like-for-like change. Only trailing
  means are computed from them, the comparator is stated per *snapshot* rather than per day
  (`trend.gscClicksPerSnapshot`, never a `PerDay` name — `dashboard-check.mjs` asserts no such field
  exists), and **any date a human reads comes from `gsc_window`**, which is what Google measured,
  never from the row's `date`, which is only when we asked.
- **Search position on the tile is a MEDIAN, not a mean.** Median across queries with at least
  `POSITION_MIN_IMPRESSIONS` impressions, with the top-10 count in the subtitle. An impression-
  weighted mean is dragged around by whichever position-60 stray happens to be in the stored rows and
  stays put when the work lands. `totals.gscPosition` still holds the old mean for `/api/json`
  continuity; do not put it back on a tile.
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
- **The baseline window itself can run out of clean days, not just the fallback percentile.**
  Both percentile paths in `classifyTraffic` are computed over whatever window the caller reads —
  and by 2026-08-24 the forum.objectivismonline.com flood (started 2026-07-30, a true baseline of
  ~618/day) had been running for 26 of the 30 days in the then-current read, so the 25th-percentile
  fallback from the fix above was itself built almost entirely from flood days. The flood settled
  into an elevated "new normal" (10k-30k/day, matching its own shape day over day) that never
  tripped `FLOOD_MULTIPLE` against that inflated baseline, so every day from 2026-08-19 on rendered
  as clean "human sessions" — the same failure mode recurring in a form the 25th-percentile fix
  didn't reach. `BASELINE_LOOKBACK_DAYS` (`src/bots.js`, 180 days) is a second, wider window read
  *only* for the two queries that feed `classifyTraffic` (`hist`/`histRefs` in `loadDashboard`, and
  the equivalent pair in `summarizeToday` for the nightly ntfy push — these were two independent
  30-day windows, both had the bug, both needed the fix). Every other read keeps the narrower
  `historyStart`/`-29 days` window, so this costs nothing beyond a few hundred extra
  one-row-a-day-per-host `daily_traffic` rows and a handful of grouped `daily_referrers` rows — see
  the comment on `BASELINE_LOOKBACK_DAYS` for why that's cheap. If a flood ever outlasts 180 days
  too, the same fix applies again: widen further, don't add a third window.
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
  `src/opportunities.js` (`SNIPPET_MAX_POSITION`, `RANK_MAX_POSITION`, `TARGET_POSITION`,
  `SNIPPET_CTR_RATIO`, `OPPORTUNITY_MIN_IMPRESSIONS`, `MIN_ACTIONABLE_CLICKS`,
  `POSITION_MIN_IMPRESSIONS`). `render-check.mjs` asserts the rendered sentence against those same
  imports, so changing a threshold and not the prose fails `npm run check`. The prose had already
  drifted once: it claimed flooded days were "excluded whole, from sessions, referrers, and landing
  pages alike" for as long as `splitDay` had been keeping the referred sessions.
- **Signals respect measurement class, and the gate is not optional.** Session-delta and
  pages-per-session rules run on **RUM sites only**. A zone-sourced host is measured in HTTP requests
  out of the zone log, so "sessions rose 40%" or "pages/session fell by 2.1" about one is not a weak
  signal, it is a different quantity wearing the same words — the live NOTABLE list led with exactly
  that for library.freecapitalists.org. Zone hosts are eligible **only for zone-specific rules**;
  today that is `error-spike`. The gate reads `site.measurement` / `site.zoneSourced`, never a
  hostname. Adding a rule means deciding which class it belongs to first. The two search rules
  (`snippet-gap`, `rank-gap`) sit inside the RUM branch for the same reason the rest do; they
  replaced a single generic `search-opportunity` placeholder whose action text ("rewrite the titles
  and meta descriptions") was correct for only one of the two problems it fired on.
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
