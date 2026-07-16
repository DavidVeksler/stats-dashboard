# stats-dashboard

Daily traffic + search dashboard for all my domains, at **https://stats.davidveksler.com**.

- **Traffic + referrers** (last 24 h) — Cloudflare Web Analytics (RUM) via the GraphQL Analytics API.
- **Search keywords** — Google Search Console. GSC data lags ~2 days, so the card shows the freshest full 3-day window, not literally the last 24 h.
- A **Cron Trigger** pulls both every night at **13:00 UTC (~6 am Pacific)**, writes one snapshot per domain into **D1**, and sends an **ntfy** push (topic `david-stats-cf-serp`).
- The dashboard renders from stored D1 snapshots, so it loads instantly and builds **14-day sparklines** over time.

## Architecture

```
Cron 13:00 UTC ─┐
                ├─> Worker (src/index.js runDaily)
 /run?key=…  ───┘        ├─ pullTraffic()  → Cloudflare GraphQL (all 4 accounts)
                         ├─ queryKeywords()→ Google Search Console (per property)
                         ├─ write snapshot → D1 (daily_traffic, daily_referrers, daily_keywords)
                         └─ sendNtfy()     → ntfy.sh/david-stats-cf-serp

GET /            → loadDashboard() reads D1 → renderDashboard() HTML
GET /api/json    → same data as JSON
GET /health      → "ok"
GET /run?key=…   → manual re-pull (needs REFRESH_KEY secret)
```

Files: `src/config.js` (domains + accounts), `src/cloudflare.js` (RUM pull),
`src/gsc.js` (Search Console + JWT auth), `src/render.js` (HTML), `src/index.js` (handlers).

## Domains tracked

Edit `SITES` in `src/config.js`. `host` = the Cloudflare Web Analytics requestHost;
`gsc` = the exact Search Console property string (`sc-domain:…` or a URL prefix).

## The one remaining setup step — Google Search Console auth

The nightly job runs headless, so it can't use an interactive Google login. It needs a
**service account**. Until `GSC_SA_KEY` is set, traffic/referrers work fully and keywords
are simply skipped (the ntfy push notes it).

1. Google Cloud Console → create (or pick) a project → **APIs & Services → Enable APIs** →
   enable **Google Search Console API**.
2. **IAM & Admin → Service Accounts → Create service account**. No roles needed.
3. On the new account → **Keys → Add key → JSON**. Download the key file.
4. In **Search Console** (https://search.google.com/search-console), for **each** property
   → Settings → **Users and permissions → Add user** → paste the service account's
   `client_email` (looks like `name@project.iam.gserviceaccount.com`) → **Restricted** (read) is enough.
   Do this for all 7 properties.
5. Store the whole JSON key as the Worker secret (one line):
   ```sh
   export CLOUDFLARE_API_TOKEN=<your-cf-token>
   wrangler secret put GSC_SA_KEY < path/to/key.json
   ```
6. Trigger a pull to confirm keywords populate:
   ```sh
   curl "https://stats.davidveksler.com/run?key=$REFRESH_KEY"
   # gscOk should be true; the ntfy warning disappears
   ```

## Deploy / operate

```sh
npm install
export CLOUDFLARE_API_TOKEN=<cf-token-with-workers+d1+dns edit>   # first token in ~/Projects/.cloudflare.env
npm run deploy           # wrangler deploy
npm run tail             # live logs
wrangler d1 execute stats-dashboard --remote --command "SELECT * FROM runs ORDER BY run_at DESC LIMIT 5"
```

Secrets (set once via `wrangler secret put`):
- `CF_API_TOKEN` — Cloudflare token with **Account Analytics: Read** (the Worker's GraphQL calls). ✅ set
- `REFRESH_KEY` — protects `GET /run`. ✅ set (value saved locally when created)
- `GSC_SA_KEY` — Google service-account JSON. ⬜ pending (see above)

Vars (in `wrangler.jsonc`): `NTFY_TOPIC = david-stats-cf-serp`.

## Resources (created 2026-07-16)

- Worker: `stats-dashboard` on account **David Veksler's Websites** (`556c237bf8cb62edb8f7b401499bb7a9`)
- D1: `stats-dashboard` (`2f5ea431-472e-462f-94a4-b396576c1a5b`)
- Custom domain: `stats.davidveksler.com`
- Cron: `0 13 * * *`

## Notes / limitations

- **Visitors = sessions**, not unique people — Cloudflare's free RUM tier doesn't expose uniques.
  Referrer ranks use sessions; internal navigation is excluded.
- **`2020.theobjectivestandard.com`** shows no data — no Web Analytics beacon and no GSC clicks.
  Remove it from `SITES` if it stays dormant.
- The `davidveksler.com` GSC property is a `sc-domain:` property, so its keywords overlap with
  the `cheatsheets.davidveksler.com` subdomain. Expected.
- D1 grows ~a few KB/day; no pruning needed for years. Add a retention `DELETE` if desired.
