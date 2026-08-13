import { SITES } from "./config.js";
import { pullTraffic, pullZoneTraffic, topReferrers, topPages } from "./cloudflare.js";
import { getAccessToken, queryKeywords, queryPages, querySearchSummary } from "./gsc.js";
import { classifyTraffic, floodReason, floodDates, splitDay,
  crawlerAccounting, summarizeVerifiedBots, summarizeNonContent } from "./bots.js";
import { rankOpportunities, expectedCtr, POSITION_MIN_IMPRESSIONS } from "./opportunities.js";
import { computeSignals } from "./signals.js";
import { renderDashboard } from "./render.js";

// How many trailing days every KPI comparator averages over. One number, so the
// tiles cannot each claim a different window, and the renderer reads it back off
// totals.trend rather than restating it.
const COMPARATOR_DAYS = 14;

// Which instrumentation a site's numbers come from. RUM sites carry the Web
// Analytics beacon and are measured in sessions; zone sites have no HTML page to
// fire that beacon, so their numbers are HTTP request counts out of the zone log
// and are a different quantity entirely (see loadDashboard's totals split, and
// the "Two measurement classes" gotcha in AGENTS.md). Derived from config so no
// aggregate has to know a hostname.
const measurementOf = (site) => (site.trafficSource === "zone" ? "zone" : "rum");

const utcDate = (d) => d.toISOString().slice(0, 10);
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return utcDate(d);
}

// Runtime D1 bindings can apply additive migrations even when the deployment
// token lacks permission for the D1 management/import API.
async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS daily_pages (
      date TEXT NOT NULL,
      host TEXT NOT NULL,
      page TEXT NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      ctr REAL NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0,
      gsc_window TEXT,
      PRIMARY KEY (date, host, page)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pages_dh ON daily_pages(date, host)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS daily_search_summary (
      date TEXT NOT NULL,
      host TEXT NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      ctr REAL NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0,
      gsc_window TEXT,
      PRIMARY KEY (date, host)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_search_summary_dh ON daily_search_summary(date, host)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS daily_cf_pages (
      date TEXT NOT NULL,
      host TEXT NOT NULL,
      page TEXT NOT NULL,
      visits INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, host, page)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cf_pages_dh ON daily_cf_pages(date, host)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS daily_zone_countries (
      date TEXT NOT NULL, host TEXT NOT NULL, country TEXT NOT NULL,
      visits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, host, country)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_zone_countries_dh ON daily_zone_countries(date, host)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS daily_zone_status (
      date TEXT NOT NULL, host TEXT NOT NULL, status INTEGER NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, host, status)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_zone_status_dh ON daily_zone_status(date, host)`),
    // Verified-crawler categories for zone-sourced hosts. A floor on crawler
    // volume, not a bot/human split — see summarizeVerifiedBots in bots.js.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS daily_zone_bots (
      date TEXT NOT NULL, host TEXT NOT NULL, category TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0, visits INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, host, category)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_zone_bots_dh ON daily_zone_bots(date, host)`),
  ]);
  // Additive column on a pre-existing table: D1 has no "ADD COLUMN IF NOT
  // EXISTS", so swallow the one error that means it's already there.
  try {
    await env.DB.prepare(`ALTER TABLE daily_traffic ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`).run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// ---- Nightly pull: Cloudflare + GSC -> D1 -> ntfy -------------------------
async function runDaily(env, now = new Date()) {
  await ensureSchema(env);
  const date = utcDate(now);
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const until = now.toISOString();
  const notes = [];

  // 1. Traffic + referrers (Cloudflare Web Analytics)
  const traffic = await pullTraffic(env, since, until);

  // 1b. Zone-log traffic for hosts with no RUM beacon (trafficSource: "zone").
  // Merged into the same `traffic` map so the rest of this function doesn't
  // need to know which source a host came from; bytes/countries/statuses,
  // which the RUM path has no equivalent of, are kept alongside in zoneExtra.
  const zoneExtra = new Map();
  for (const site of SITES.filter((s) => s.trafficSource === "zone")) {
    try {
      const z = await pullZoneTraffic(env, site.zoneTag, site.host, since, until);
      traffic.set(site.host, { views: z.requests, visits: z.visits, referrers: new Map(), pages: new Map() });
      zoneExtra.set(site.host, { bytes: z.bytes, paths: z.paths, countries: z.countries,
        statuses: z.statuses, bots: z.bots });
    } catch (e) {
      notes.push(`zone traffic ${site.host}: ${e.message}`.slice(0, 140));
    }
  }

  const stmts = [];
  for (const { host } of SITES) {
    const rec = traffic.get(host) ?? { views: 0, visits: 0, referrers: new Map(), pages: new Map() };
    const zx = zoneExtra.get(host);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO daily_traffic (date,host,visits,views,bytes) VALUES (?,?,?,?,?)
         ON CONFLICT(date,host) DO UPDATE SET visits=excluded.visits, views=excluded.views, bytes=excluded.bytes`
      ).bind(date, host, rec.visits, rec.views, zx?.bytes ?? 0),
      env.DB.prepare(`DELETE FROM daily_referrers WHERE date=? AND host=?`).bind(date, host),
      env.DB.prepare(`DELETE FROM daily_cf_pages WHERE date=? AND host=?`).bind(date, host),
      env.DB.prepare(`DELETE FROM daily_zone_countries WHERE date=? AND host=?`).bind(date, host),
      env.DB.prepare(`DELETE FROM daily_zone_status WHERE date=? AND host=?`).bind(date, host),
      env.DB.prepare(`DELETE FROM daily_zone_bots WHERE date=? AND host=?`).bind(date, host),
    );
    // Keep enough rows for accurate source-mix totals; the dashboard still
    // renders only the top eight referrers per domain.
    for (const r of topReferrers(rec.referrers, 50, host)) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO daily_referrers (date,host,referrer,kind,visits) VALUES (?,?,?,?,?)`
        ).bind(date, host, r.referrer, r.kind, r.visits),
      );
    }
    if (zx) {
      // Zone-sourced host: "top files" ranked by requests, plus country and
      // status-code breakdowns the RUM path has no equivalent of.
      for (const p of zx.paths) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO daily_cf_pages (date,host,page,visits,views) VALUES (?,?,?,?,?)`
          ).bind(date, host, p.path, p.requests, p.visits),
        );
      }
      for (const c of zx.countries) {
        stmts.push(
          env.DB.prepare(`INSERT INTO daily_zone_countries (date,host,country,visits) VALUES (?,?,?,?)`)
            .bind(date, host, c.country, c.visits),
        );
      }
      for (const st of zx.statuses) {
        stmts.push(
          env.DB.prepare(`INSERT INTO daily_zone_status (date,host,status,requests) VALUES (?,?,?,?)`)
            .bind(date, host, st.status, st.requests),
        );
      }
      // Verified-crawler categories, including the "(unverified)" remainder,
      // which is stored rather than dropped so the card can show what share of
      // the day the floor does not cover.
      for (const b of zx.bots ?? []) {
        stmts.push(
          env.DB.prepare(`INSERT INTO daily_zone_bots (date,host,category,requests,visits) VALUES (?,?,?,?,?)`)
            .bind(date, host, b.category, b.requests, b.visits),
        );
      }
      continue;
    }
    for (const p of topPages(rec.pages, 50)) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO daily_cf_pages (date,host,page,visits,views) VALUES (?,?,?,?,?)`
        ).bind(date, host, p.page, p.visits, p.views),
      );
    }
  }

  // 2. Keywords (Google Search Console) — freshest full window, GSC lags ~2 days
  let gscOk = false;
  // Hosts whose Search Console property errored, named so the ntfy push can say
  // which sites lost their search data. A per-host 403 (property string doesn't
  // match a property the service account can read) otherwise shows up only as
  // one truncated note in the runs table, which is how five sites sat with no
  // keyword data from 2026-08-11 until it was noticed by eye.
  const gscFailedHosts = new Set();
  if (env.GSC_SA_KEY) {
    try {
      const sa = JSON.parse(env.GSC_SA_KEY);
      const token = await getAccessToken(sa, Math.floor(now.getTime() / 1000));
      const gStart = addDays(date, -4);
      const gEnd = addDays(date, -2);
      const gscWindow = `${gStart}–${gEnd}`;
      for (const { host, gsc, gscPageFilter } of SITES) {
        if (!gsc) continue; // no Search Console property for this host (e.g. a zone-sourced file host)
        stmts.push(env.DB.prepare(`DELETE FROM daily_keywords WHERE date=? AND host=?`).bind(date, host));
        stmts.push(env.DB.prepare(`DELETE FROM daily_pages WHERE date=? AND host=?`).bind(date, host));
        stmts.push(env.DB.prepare(`DELETE FROM daily_search_summary WHERE date=? AND host=?`).bind(date, host));
        let rows = [], pages = [], summary = null;
        try {
          rows = await queryKeywords(token, gsc, gStart, gEnd, 25, gscPageFilter);
        } catch (e) {
          notes.push(`gsc queries ${host}: ${e.message}`.slice(0, 140));
          gscFailedHosts.add(host);
        }
        try {
          pages = await queryPages(token, gsc, gStart, gEnd, 15, gscPageFilter);
        } catch (e) {
          notes.push(`gsc pages ${host}: ${e.message}`.slice(0, 140));
          gscFailedHosts.add(host);
        }
        try {
          summary = await querySearchSummary(token, gsc, gStart, gEnd, gscPageFilter);
        } catch (e) {
          notes.push(`gsc summary ${host}: ${e.message}`.slice(0, 140));
          gscFailedHosts.add(host);
        }
        for (const k of rows) {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO daily_keywords (date,host,query,clicks,impressions,position,gsc_window) VALUES (?,?,?,?,?,?,?)`
            ).bind(date, host, k.query, k.clicks, k.impressions, k.position, gscWindow),
          );
        }
        for (const p of pages) {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO daily_pages (date,host,page,clicks,impressions,ctr,position,gsc_window) VALUES (?,?,?,?,?,?,?,?)`
            ).bind(date, host, p.page, p.clicks, p.impressions, p.ctr, p.position, gscWindow),
          );
        }
        if (summary) {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO daily_search_summary (date,host,clicks,impressions,ctr,position,gsc_window) VALUES (?,?,?,?,?,?,?)`
            ).bind(date, host, summary.clicks, summary.impressions, summary.ctr, summary.position, gscWindow),
          );
        }
      }
      gscOk = !notes.some((note) => note.startsWith("gsc "));
    } catch (e) {
      notes.push(`gsc auth: ${e.message}`.slice(0, 160));
    }
  } else {
    notes.push("GSC_SA_KEY not set — keywords skipped");
  }

  await env.DB.batch(stmts);

  // 3. Record the run
  const totalVisits = [...traffic.values()].reduce((a, r) => a + r.visits, 0);
  const ok = notes.length === 0;
  await env.DB.prepare(`INSERT OR REPLACE INTO runs (run_at,date,ok,note) VALUES (?,?,?,?)`)
    .bind(now.toISOString(), date, ok ? 1 : 0, notes.join(" | ") || "ok").run();

  // 4. ntfy push — classified against the trailing history that was just written,
  //    so the daily phone alert reports the human audience rather than whatever a
  //    crawler happened to do that night.
  const summary = await summarizeToday(env, date).catch(() => null);
  // The push carries the finding, not only the volumes. The signal engine runs
  // read-side over what was just written rather than being re-derived here: one
  // copy of the rules, exactly as spec item 3 established for the opportunity
  // predicate. Quiet-success discipline is preserved — only a severity-1 signal
  // ("act today") is worth waking a phone for, and with none the push is
  // byte-for-byte what it was before.
  const dashboard = await loadDashboard(env).catch(() => null);
  const topSignal = (dashboard?.signals ?? []).find((signal) => signal.severity === 1) ?? null;
  await sendNtfy(env, traffic, totalVisits, gscOk, notes, summary, gscFailedHosts, topSignal);
  return { date, totalVisits, humanVisits: summary?.humanVisits ?? null,
    botVisits: summary?.botVisits ?? null, gscOk, gscFailedHosts: [...gscFailedHosts],
    topSignal: topSignal ? { kind: topSignal.kind, host: topSignal.host, headline: topSignal.headline } : null,
    notes };
}

// Re-read the last 30 days and split today into human vs crawler traffic.
async function summarizeToday(env, date) {
  const [hist, histRefs] = await Promise.all([
    env.DB.prepare(`SELECT date,host,visits,views FROM daily_traffic WHERE date >= date(?, '-29 days')`).bind(date).all(),
    env.DB.prepare(
      `SELECT date,host,kind,SUM(visits) AS visits FROM daily_referrers
       WHERE date >= date(?, '-29 days') GROUP BY date,host,kind`
    ).bind(date).all(),
  ]);
  const classified = classifyTraffic(hist.results ?? [], histRefs.results ?? []);
  let humanVisits = 0, botVisits = 0;
  const perHost = new Map();
  for (const { host } of SITES) {
    const day = classified.get(host)?.get(date);
    if (!day) continue;
    // Same split as the dashboard: a flooded day still contributes its referred
    // sessions, so the phone alert reports a floor instead of a zero.
    const part = splitDay(day);
    botVisits += part.crawler;
    humanVisits += part.human;
    if (part.human) perHost.set(host, part.human);
  }
  const flooded = [...SITES].filter(({ host }) => classified.get(host)?.get(date)?.flood).map(({ host }) => host);
  return { humanVisits, botVisits, perHost, flooded };
}

async function sendNtfy(env, traffic, totalVisits, gscOk, notes, summary, gscFailedHosts = new Set(), topSignal = null) {
  if (!env.NTFY_TOPIC) return;
  const ranked = summary
    ? [...summary.perHost.entries()].sort((a, b) => b[1] - a[1])
    : [...traffic.entries()].sort((a, b) => b[1].visits - a[1].visits).map(([h, r]) => [h, r.visits]);
  const top = ranked.slice(0, 4).map(([h, v]) => `${h.replace(/^www\./, "")}: ${v}`).join("\n");
  const headline = summary ? `${summary.humanVisits} visitors (24h)` : `${totalVisits} visitors (24h)`;
  const crawlers = summary?.botVisits
    ? `\n🤖 ${summary.botVisits} crawler sessions excluded (${summary.flooded.join(", ")})` : "";
  // Name the sites that lost search data. The raw note is a truncated Google
  // error body, which reads as noise; the host list is what says "go fix that
  // property in Search Console".
  const gscWarn = gscOk ? ""
    : gscFailedHosts.size
      ? `\n⚠ no search data: ${[...gscFailedHosts].join(", ")}`.slice(0, 300)
      : `\n⚠ keywords: ${notes[0] || "skipped"}`;
  // Only severity 1 ("act today") is added. Nothing else changes about the push,
  // so a quiet day still reads exactly as it did before the signal engine existed.
  const finding = topSignal ? `\n\n❗ ${topSignal.headline}\n→ ${topSignal.action}` : "";
  const body = `${headline}\n${top}${crawlers}${gscWarn}${finding}`;
  try {
    await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: "Traffic + Search — daily", Tags: "bar_chart", Priority: "default" },
      body,
    });
  } catch (_) { /* non-fatal */ }
}

// ---- Read from D1 and render ---------------------------------------------
async function loadDashboard(env, options = {}) {
  const requestedDays = Number(options.periodDays);
  const periodDays = [1, 7, 30].includes(requestedDays) ? requestedDays : 1;
  const domain = SITES.some((site) => site.host === options.domain) ? options.domain : null;
  const sort = ["traffic", "change", "name"].includes(options.sort) ? options.sort : "traffic";
  const selectedSites = domain ? SITES.filter((site) => site.host === domain) : SITES;
  const selectedHosts = new Set(selectedSites.map((site) => site.host));
  const latest = await env.DB.prepare(`SELECT MAX(date) AS d FROM daily_traffic`).first();
  const date = latest?.d;
  if (!date) {
    return { date: null, coverageStart: null, generatedAt: new Date().toISOString(), dataUpdatedAt: null, run: null,
      periodDays, domain, sort, allDomains: SITES.map((site) => site.host), signals: [],
      totals: { visits: 0, views: 0, pagesPerSession: 0, search: 0,
        domains: selectedSites.length, active: 0,
        rumDomains: selectedSites.filter((s) => measurementOf(s) === "rum").length,
        zoneDomains: selectedSites.filter((s) => measurementOf(s) === "zone").length,
        previousVisits: 0, delta: null, daysAvailable: 0, previousDaysAvailable: 0,
        botVisits: 0, botViews: 0, previousBotVisits: 0, botShare: 0, floodedSiteDays: 0, floodedSites: 0,
        partialVisits: 0, partialSites: 0,
        sourceMix: { direct: 0, search: 0, social: 0, referral: 0, internal: 0, unattributed: 0 },
        internalMeasured: false,
        zone: { visits: 0, requests: 0, bytes: 0, sites: 0, hosts: [] },
        gscClicks: 0, gscImpressions: 0, gscCtr: 0, gscPosition: 0, searchDataDomains: 0,
        gscMedianPosition: 0, gscPositionQueries: 0, gscTop10Queries: 0, gscExpectedCtr: 0,
        trend: { window: COMPARATOR_DAYS, days: 0, visitsPerDay: 0, viewsPerDay: 0, searchPerDay: 0,
          gscSnapshots: 0, gscClicksPerSnapshot: 0, gscImpressionsPerSnapshot: 0, gscCtr: 0,
          gscWindowFirst: null, gscWindowLast: null, gscSeries: [] },
        opportunities: 0, snippetOpportunities: 0, rankOpportunities: 0 },
      sites: selectedSites.map((s) => ({ host: s.host, visits: 0, views: 0, previousVisits: 0,
        botVisits: 0, botViews: 0, botDays: 0, previousBotVisits: 0, cleanDays: 0, anomaly: null,
        partialVisits: 0, partialDays: 0,
        previousPartialDays: 0,
        delta: null, referrers: [], keywords: [], pages: [], cfPages: [], searchSummary: null,
        bytes: 0, zoneCountries: [], zoneStatuses: [], zoneSourced: measurementOf(s) === "zone",
        measurement: measurementOf(s),
        zoneBots: measurementOf(s) === "zone" ? summarizeVerifiedBots([]) : null,
        zoneNonContent: measurementOf(s) === "zone" ? summarizeNonContent([], []) : null,
        opportunities: { snippet: [], rank: [] }, opportunityCount: 0,
        queryDenyPatterns: s.queryDenyPatterns ?? [],
        sources: { direct: 0, search: 0, social: 0, referral: 0, internal: 0, unattributed: 0 },
        spark: [] })) };
  }
  const start = addDays(date, -(periodDays - 1));
  const previousEnd = addDays(start, -1);
  const previousStart = addDays(previousEnd, -(periodDays - 1));
  // Crawler detection needs enough trailing history to know what a normal day
  // looks like, and it has to reach back over the comparison period too — a
  // flooded "previous period" would otherwise poison every delta on the page.
  const historyStart = [previousStart, addDays(date, -29)].sort()[0];
  // The three Search Console reads cover the history window rather than the
  // latest day, which is what gives the search tiles a comparator instead of a
  // bare number. All three tables have always stored one row per snapshot day, so
  // this is purely read-side. The panels still render the latest day only — every
  // consumer below filters on `r.date === date` — and the trailing rows exist for
  // the trend.
  //
  // ROLLING WINDOW, NOT A DAILY SERIES. These rows are keyed by the date the
  // snapshot was taken, not by the period they measure: runDaily asks GSC for
  // `date-4 .. date-2`, so consecutive rows overlap by two days out of three and
  // a day-over-day difference between them is not a like-for-like change. Only
  // trailing averages are computed from them, and any date a human reads comes
  // from `gsc_window`, never from `date`.
  const pagesQuery = env.DB.prepare(
    `SELECT date,host,page,clicks,impressions,ctr,position,gsc_window FROM daily_pages WHERE date BETWEEN ? AND ? ORDER BY clicks DESC, impressions DESC`
  ).bind(historyStart, date).all().catch(() => ({ results: [] }));
  const searchSummaryQuery = env.DB.prepare(
    `SELECT date,host,clicks,impressions,ctr,position,gsc_window FROM daily_search_summary WHERE date BETWEEN ? AND ?`
  ).bind(historyStart, date).all().catch(() => ({ results: [] }));
  // Referrers and landing pages keep their date so flooded days can be dropped;
  // otherwise the detail panels would still show the crawler's millions of
  // direct hits under a headline that had already excluded them.
  const cfPagesQuery = env.DB.prepare(
    `SELECT date,host,page,visits,views FROM daily_cf_pages WHERE date BETWEEN ? AND ?`
  ).bind(start, date).all().catch(() => ({ results: [] }));
  // Zone-sourced hosts only: country breakdown, latest day only (same "latest
  // snapshot, not trended" treatment as keywords/pages above).
  const zoneCountriesQuery = env.DB.prepare(
    `SELECT host,country,visits FROM daily_zone_countries WHERE date=? ORDER BY visits DESC`
  ).bind(date).all().catch(() => ({ results: [] }));
  // Status codes are read over the whole history window, not just the latest day:
  // daily_zone_status has always stored a row per day, and the `error-spike`
  // signal needs a 14-day baseline to say whether today's 4xx share is a spike or
  // just what this host looks like. Widening an existing read beats adding a
  // query. The card still renders the latest day only.
  const zoneStatusQuery = env.DB.prepare(
    `SELECT date,host,status,requests FROM daily_zone_status WHERE date BETWEEN ? AND ? ORDER BY date ASC, requests DESC`
  ).bind(historyStart, date).all().catch(() => ({ results: [] }));
  // Verified crawlers per category. Same schema tolerance as the queries above:
  // the table arrives with ensureSchema on the next run, and until then the
  // dashboard renders without it rather than 500ing.
  const zoneBotsQuery = env.DB.prepare(
    `SELECT host,category,requests,visits FROM daily_zone_bots WHERE date=? ORDER BY requests DESC`
  ).bind(date).all().catch(() => ({ results: [] }));
  const [tr, previousTr, refs, kws, pages, searchSummaries, cfPages, zoneCountries, zoneStatuses, zoneBots, hist, histRefs, run] = await Promise.all([
    env.DB.prepare(`SELECT date,host,visits,views,bytes FROM daily_traffic WHERE date BETWEEN ? AND ? ORDER BY date ASC`).bind(start, date).all(),
    env.DB.prepare(`SELECT date,host,visits,views FROM daily_traffic WHERE date BETWEEN ? AND ? ORDER BY date ASC`).bind(previousStart, previousEnd).all(),
    env.DB.prepare(
      `SELECT date,host,referrer,kind,SUM(visits) AS visits FROM daily_referrers
       WHERE date BETWEEN ? AND ? GROUP BY date,host,referrer,kind`
    ).bind(start, date).all(),
    env.DB.prepare(`SELECT date,host,query,clicks,impressions,position,gsc_window FROM daily_keywords WHERE date BETWEEN ? AND ? ORDER BY clicks DESC, impressions DESC`).bind(historyStart, date).all(),
    pagesQuery,
    searchSummaryQuery,
    cfPagesQuery,
    zoneCountriesQuery,
    zoneStatusQuery,
    zoneBotsQuery,
    env.DB.prepare(`SELECT date,host,visits,views FROM daily_traffic WHERE date BETWEEN ? AND ? ORDER BY date ASC`).bind(historyStart, date).all(),
    env.DB.prepare(
      `SELECT date,host,kind,SUM(visits) AS visits FROM daily_referrers
       WHERE date BETWEEN ? AND ? GROUP BY date,host,kind`
    ).bind(historyStart, date).all(),
    env.DB.prepare(`SELECT run_at,ok,note FROM runs ORDER BY run_at DESC LIMIT 1`).first(),
  ]);
  const classified = classifyTraffic(hist.results ?? [], histRefs.results ?? []);

  const byHost = (rows, h) => (rows.results ?? []).filter((r) => r.host === h);
  const availableDates = [...new Set((tr.results ?? []).map((row) => row.date))].sort();
  const previousAvailableDates = [...new Set((previousTr.results ?? []).map((row) => row.date))].sort();
  // Split every measured day into human vs crawler (see splitDay). A flooded day
  // still contributes its referred sessions, so a site whose only day in view was
  // flooded reports a measured floor instead of an empty card; its direct bucket
  // and its pageviews are the parts that stay unrecoverable.
  const sumTraffic = (rows, days) => rows.reduce((acc, row) => {
    const part = splitDay(days?.get(row.date));
    acc.visits += part.human;
    acc.views += part.views;
    if (part.partial) {
      acc.partialVisits += part.human;
      acc.partialDays += 1;
      acc.botVisits += part.crawler;
      acc.botViews += part.crawlerViews;
      acc.botDays += 1;
    } else {
      acc.cleanDays += 1;
    }
    return acc;
  }, { visits: 0, views: 0, partialVisits: 0, partialDays: 0,
       botVisits: 0, botViews: 0, botDays: 0, cleanDays: 0 });
  // `unattributed` is a residual, never a channel: it is the gap between sessions
  // the traffic table counted and referrer rows the referrer table stored. It was
  // called "other" and rendered as a fifth segment in the mix bar, which invited
  // exactly the reading it cannot support — the largest "channel" on the page was
  // an accounting hole. It is now named for what it is and rendered outside the
  // bar. `internal` is a real channel: sessions arriving from one of the site's
  // own hostnames (see classifyReferrer). Those used to fall into this residual.
  const emptyMix = () => ({ direct: 0, search: 0, social: 0, referral: 0, internal: 0, unattributed: 0 });
  const summarizeSources = (rows, visits) => {
    const result = emptyMix();
    for (const row of rows) {
      const key = row.kind === "ref" ? "referral" : row.kind;
      if (key in result && key !== "unattributed") result[key] += Number(row.visits || 0);
    }
    const attributed = result.direct + result.search + result.social + result.referral + result.internal;
    result.unattributed = Math.max(0, visits - attributed);
    return result;
  };
  // Re-aggregate date-keyed rows once the flooded days are dropped.
  const mergeBy = (rows, keyOf, build) => {
    const merged = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      const rec = merged.get(key) ?? build(row);
      rec.visits += Number(row.visits || 0);
      if ("views" in rec) rec.views += Number(row.views || 0);
      merged.set(key, rec);
    }
    return [...merged.values()].sort((a, b) => b.visits - a.visits);
  };
  let sites = selectedSites.map((s) => {
    const floods = floodDates(classified, s.host);
    const days = classified.get(s.host);
    const t = sumTraffic(byHost(tr, s.host), days);
    const previous = sumTraffic(byHost(previousTr, s.host), days);
    // The GSC reads now span the history window for the trend below; the panels
    // are still a latest-snapshot view, so they filter back down to `date`.
    const kwRows = byHost(kws, s.host).filter((r) => r.date === date);
    const pageRows = byHost(pages, s.host).filter((r) => r.date === date);
    // Both opportunity classes, each ranked by its own metric, over every stored
    // keyword row rather than the twelve the card shows. The renderer re-derives
    // each visible row's class from the same classifier, so a badge and this
    // count can differ in coverage but never in verdict.
    const opportunities = rankOpportunities(kwRows, s);
    // Landing-page rows carry no referer dimension, so a flooded day's are the
    // crawler's and stay excluded whole.
    const cfPageRows = mergeBy(byHost(cfPages, s.host).filter((r) => !floods.has(r.date)),
      (r) => r.page, (r) => ({ page: r.page, visits: 0, views: 0 }));
    // Referrers carry a referer dimension, so on a flooded day only the direct
    // bucket is spoiled: the referred rows survive and keep the detail panel
    // agreeing with the headline. Landing pages above have no such dimension,
    // which is why they stay excluded whole.
    const refRows = mergeBy(byHost(refs, s.host).filter((r) => !floods.has(r.date) || r.kind !== "direct"),
      (r) => `${r.referrer}\u0000${r.kind}`, (r) => ({ referrer: r.referrer, kind: r.kind, visits: 0 }));
    const summaryRow = byHost(searchSummaries, s.host).find((r) => r.date === date) ?? null;
    // Zone-sourced hosts only: bandwidth sums plainly over the period (bytes
    // carries no crawler-flood signal to split against), country/status rows
    // are the latest-day snapshot, same treatment as keywords/pages above.
    const bytes = byHost(tr, s.host).reduce((sum, row) => sum + Number(row.bytes || 0), 0);
    const zoneCountryRows = byHost(zoneCountries, s.host).slice(0, 10)
      .map((c) => ({ country: c.country, visits: Number(c.visits || 0) }));
    // The card is a latest-day snapshot; the trailing days in this read exist for
    // the error-spike baseline in src/signals.js and are filtered out here.
    const latestZoneStatusRows = byHost(zoneStatuses, s.host).filter((st) => st.date === date);
    const zoneStatusRows = latestZoneStatusRows.slice(0, 8)
      .map((st) => ({ status: st.status, requests: Number(st.requests || 0) }));
    // Zone hosts get a crawler decomposition instead of a flood verdict: the
    // flood classifier structurally cannot fire on them (no referrer rows means
    // directShare is always 0), so without this their crawler volume would be
    // counted as an audience by implication. Two independent lenses, both
    // latest-day so they describe the same window, and deliberately never
    // combined into one figure — see bots.js.
    const zoneRoute = crawlerAccounting({ measurement: measurementOf(s) }) === "zone";
    const zoneBotRows = zoneRoute ? byHost(zoneBots, s.host) : [];
    const latestCfPageRows = zoneRoute ? byHost(cfPages, s.host).filter((r) => r.date === date) : [];
    // Pageviews survive only from clean days, so the rate must divide by clean
    // sessions too; using the full session count would understate every flooded
    // site's pages/session.
    const cleanVisits = t.visits - t.partialVisits;
    const previousCleanVisits = previous.visits - previous.partialVisits;
    const currentRate = cleanVisits ? t.views / cleanVisits : 0;
    const previousRate = previousCleanVisits ? previous.views / previousCleanVisits : 0;
    // The callout describes the most recent flooded day, which is the one the
    // reader is looking at; older flooded days show up as gaps in the sparkline.
    const latestFlood = [...floods].sort().at(-1);
    return {
      host: s.host,
      visits: t.visits, views: t.views,
      botVisits: t.botVisits, botViews: t.botViews, botDays: t.botDays,
      // Sessions recovered from flooded days: real, but a floor rather than a
      // count, because the direct bucket those days is unusable.
      partialVisits: t.partialVisits, partialDays: t.partialDays,
      // Carried so the `no-comparison` signal can name which side of the
      // comparison was partial, rather than lumping a flooded previous period in
      // with a site that simply has no history yet.
      previousPartialDays: previous.partialDays,
      previousVisits: previous.visits,
      previousBotVisits: previous.botVisits,
      cleanDays: t.cleanDays,
      // A floor compared against a full count is not a like-for-like delta, so
      // either side being partial means no comparison rather than a fake drop.
      delta: previous.visits && !t.partialDays && !previous.partialDays
        ? (t.visits - previous.visits) / previous.visits : null,
      pagesPerSession: currentRate,
      previousPagesPerSession: previousRate,
      pagesPerSessionDelta: previous.visits ? currentRate - previousRate : null,
      anomaly: latestFlood ? floodReason(days?.get(latestFlood)) : null,
      referrers: refRows.slice(0, 8).map((r) => ({ referrer: r.referrer, kind: r.kind, visits: r.visits })),
      sources: summarizeSources(refRows, t.visits),
      keywords: kwRows.slice(0, 12).map((k) => ({ query: k.query, clicks: k.clicks,
        impressions: k.impressions, ctr: k.impressions ? k.clicks / k.impressions : 0, position: k.position })),
      pages: pageRows.slice(0, 8).map((p) => ({ page: p.page, clicks: p.clicks,
        impressions: p.impressions, ctr: p.ctr ?? (p.impressions ? p.clicks / p.impressions : 0), position: p.position })),
      cfPages: cfPageRows.slice(0, 8).map((p) => ({ page: p.page, visits: Number(p.visits || 0), views: Number(p.views || 0) })),
      searchSummary: summaryRow ? { clicks: Number(summaryRow.clicks || 0), impressions: Number(summaryRow.impressions || 0),
        ctr: Number(summaryRow.ctr || 0), position: Number(summaryRow.position || 0) } : null,
      bytes, zoneCountries: zoneCountryRows, zoneStatuses: zoneStatusRows,
      zoneSourced: measurementOf(s) === "zone",
      measurement: measurementOf(s),
      zoneBots: zoneRoute ? summarizeVerifiedBots(zoneBotRows) : null,
      zoneNonContent: zoneRoute
        ? summarizeNonContent(latestCfPageRows, latestZoneStatusRows) : null,
      opportunities,
      opportunityCount: opportunities.snippet.length + opportunities.rank.length,
      // Carried onto the shaped row so render.js can re-run the same classifier
      // over the visible keywords with the same deny list. Strings, not RegExp
      // objects, so /api/json does not serialize them to `{}`.
      queryDenyPatterns: s.queryDenyPatterns ?? [],
      gscWindow: summaryRow?.gsc_window || kwRows[0]?.gsc_window || pageRows[0]?.gsc_window || null,
      // The sparkline plots what was measured, flooded days included, but marks
      // them — hiding them would turn a crawler event into a mysterious gap.
      spark: byHost(hist, s.host).slice(-14).map((r) => ({
        date: r.date, visits: Number(r.visits || 0), flood: floods.has(r.date),
      })),
    };
  });

  // Sorting applies inside a measurement class, never across one: ranking 19,506
  // HTTP requests against 291 RUM sessions puts the two quantities in the same
  // order as though they were the same thing.
  const bySort = sort === "name" ? (a, b) => a.host.localeCompare(b.host)
    : sort === "change" ? (a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity)
      : (a, b) => b.visits - a.visits;
  const rumSites = sites.filter((s) => s.measurement === "rum").sort(bySort);
  const zoneSites = sites.filter((s) => s.measurement === "zone").sort(bySort);
  sites = [...rumSites, ...zoneSites];

  // Every session-shaped aggregate below reduces over RUM sites only. Zone hosts
  // report HTTP requests, and Cloudflare's zone-log "visits" heuristic counts
  // crawler fetches of /robots.txt as arrivals; summing them into the headline
  // made "pages / session" the ratio of two unrelated quantities (10.4 rather
  // than the true 1.46 on 2026-08-13). Zone volume is reported in totals.zone,
  // never merged.
  const sourceMix = rumSites.reduce((acc, site) => {
    for (const key of Object.keys(acc)) acc[key] += site.sources[key];
    return acc;
  }, emptyMix());
  const rumHosts = new Set(rumSites.map((site) => site.host));
  // `internal` is frozen into daily_referrers at write time by classifyReferrer,
  // so no row stored before 2026-08-13 can ever carry it. A zero here therefore
  // means one of two completely different things — "measured, and nobody arrived
  // from an alias host" or "this channel did not exist when these rows were
  // written" — and rendering a confident 0% for the second would be a claim the
  // data cannot support. The flag says which, and the panel omits the channel
  // entirely when it was never recorded. It matters most in the 7- and 30-day
  // views, where the window still reaches back over rows written before the
  // change.
  // Scoped to the sites on screen: the referrer read carries every host (the host
  // filter is applied in JS, not in SQL), and a domain-filtered view must not
  // borrow another site's evidence that the channel exists.
  const internalMeasured = (refs.results ?? [])
    .some((row) => row.kind === "internal" && rumHosts.has(row.host));
  const searchSites = sites.filter((site) => site.searchSummary);

  // ---- 14-day comparators (spec item 8) -----------------------------------
  // Every one of these comes out of history loadDashboard has already read. No
  // metric on this page should be a bare number the reader cannot judge.
  const dailyRum = new Map();
  for (const row of hist.results ?? []) {
    if (!rumHosts.has(row.host)) continue;
    // The same split the cards use: a flooded day contributes its referred
    // sessions and no pageviews, so the baseline is built from the same quantity
    // it is compared against.
    const part = splitDay(classified.get(row.host)?.get(row.date));
    const rec = dailyRum.get(row.date) ?? { date: row.date, visits: 0, views: 0, search: 0 };
    rec.visits += part.human;
    rec.views += part.views;
    dailyRum.set(row.date, rec);
  }
  for (const row of histRefs.results ?? []) {
    if (row.kind !== "search" || !rumHosts.has(row.host)) continue;
    const rec = dailyRum.get(row.date);
    if (rec) rec.search += Number(row.visits || 0);
  }
  const trafficTrend = [...dailyRum.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-COMPARATOR_DAYS);
  const meanOf = (rows, pick) => (rows.length
    ? rows.reduce((sum, row) => sum + pick(row), 0) / rows.length : 0);

  // GSC rows are a ROLLING WINDOW keyed by snapshot date (see the read above), so
  // only trailing averages are taken from them and never a day-over-day delta.
  const gscByDate = new Map();
  for (const row of searchSummaries.results ?? []) {
    if (!selectedHosts.has(row.host)) continue;
    const rec = gscByDate.get(row.date)
      ?? { date: row.date, clicks: 0, impressions: 0, gscWindow: null };
    rec.clicks += Number(row.clicks || 0);
    rec.impressions += Number(row.impressions || 0);
    rec.gscWindow = rec.gscWindow || row.gsc_window || null;
    gscByDate.set(row.date, rec);
  }
  const gscTrend = [...gscByDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-COMPARATOR_DAYS);
  const gscTrendClicks = gscTrend.reduce((sum, row) => sum + row.clicks, 0);
  const gscTrendImpressions = gscTrend.reduce((sum, row) => sum + row.impressions, 0);

  // Median position, not mean. A mean across a branded position-1 query and a
  // position-90 stray is not a number any decision rests on; it moves when the
  // junk moves and stays put when the work lands.
  const latestKeywordRows = (kws.results ?? [])
    .filter((row) => row.date === date && selectedHosts.has(row.host) && Number(row.position || 0) > 0);
  const positionRows = latestKeywordRows
    .filter((row) => Number(row.impressions || 0) >= POSITION_MIN_IMPRESSIONS);
  const positions = positionRows.map((row) => Number(row.position)).sort((a, b) => a - b);
  const median = positions.length
    ? (positions.length % 2
      ? positions[(positions.length - 1) / 2]
      : (positions[positions.length / 2 - 1] + positions[positions.length / 2]) / 2)
    : 0;
  // What the stored query mix would earn at its own positions, impression
  // weighted. An approximation over an approximation (see expectedCtr's source
  // note) and over the top rows GSC returns rather than every query, so it is
  // rendered with a "~" and one decimal and never as a target.
  const mixImpressions = latestKeywordRows.reduce((sum, row) => sum + Number(row.impressions || 0), 0);
  const expectedMixCtr = mixImpressions
    ? latestKeywordRows.reduce((sum, row) =>
      sum + Number(row.impressions || 0) * expectedCtr(Number(row.position)), 0) / mixImpressions
    : 0;
  const totals = {
    visits: rumSites.reduce((a, s) => a + s.visits, 0),
    views: rumSites.reduce((a, s) => a + s.views, 0),
    search: sourceMix.search,
    sourceMix,
    // Reported separately, in its own units, so it can be read but never averaged
    // against a session count.
    zone: {
      visits: zoneSites.reduce((a, s) => a + s.visits, 0),
      requests: zoneSites.reduce((a, s) => a + s.views, 0),
      bytes: zoneSites.reduce((a, s) => a + s.bytes, 0),
      sites: zoneSites.length,
      hosts: zoneSites.map((s) => s.host),
    },
    domains: sites.length,
    rumDomains: rumSites.length,
    // Named separately so the "Domains shown" tile can state the split. It read
    // "12 / 12 with traffic" beside a sessions tile saying "11 RUM sites", which
    // is two tiles contradicting each other about how many sites there are.
    zoneDomains: zoneSites.length,
    active: sites.filter((s) => s.visits > 0).length,
    previousVisits: rumSites.reduce((a, s) => a + s.previousVisits, 0),
    // Crawler traffic is reported, never hidden — it just does not get to sit in
    // the same number as the human audience.
    botVisits: rumSites.reduce((a, s) => a + s.botVisits, 0),
    botViews: rumSites.reduce((a, s) => a + s.botViews, 0),
    previousBotVisits: rumSites.reduce((a, s) => a + s.previousBotVisits, 0),
    partialVisits: rumSites.reduce((a, s) => a + s.partialVisits, 0),
    partialSites: rumSites.filter((s) => s.partialDays > 0).length,
    floodedSiteDays: rumSites.reduce((a, s) => a + s.botDays, 0),
    floodedSites: rumSites.filter((s) => s.botDays > 0).length,
    daysAvailable: availableDates.length,
    previousDaysAvailable: previousAvailableDates.length,
    gscClicks: searchSites.reduce((sum, site) => sum + site.searchSummary.clicks, 0),
    gscImpressions: searchSites.reduce((sum, site) => sum + site.searchSummary.impressions, 0),
    searchDataDomains: searchSites.length,
    opportunities: sites.reduce((sum, site) => sum + site.opportunityCount, 0),
    snippetOpportunities: sites.reduce((sum, site) => sum + site.opportunities.snippet.length, 0),
    rankOpportunities: sites.reduce((sum, site) => sum + site.opportunities.rank.length, 0),
    internalMeasured,
    // Median across queries with enough impressions to have a position worth
    // reading, plus how many of them are on page one. Both replace the
    // impression-weighted mean the tile used to print.
    gscMedianPosition: median,
    gscPositionQueries: positionRows.length,
    gscTop10Queries: positionRows.filter((row) => Number(row.position) <= 10).length,
    gscExpectedCtr: expectedMixCtr,
    trend: {
      window: COMPARATOR_DAYS,
      days: trafficTrend.length,
      visitsPerDay: meanOf(trafficTrend, (row) => row.visits),
      viewsPerDay: meanOf(trafficTrend, (row) => row.views),
      searchPerDay: meanOf(trafficTrend, (row) => row.search),
      // Snapshots, not days: consecutive GSC rows overlap by two days out of
      // three, so this is "the average of the last N overlapping windows" and the
      // renderer is required to label it as one.
      gscSnapshots: gscTrend.length,
      gscClicksPerSnapshot: meanOf(gscTrend, (row) => row.clicks),
      gscImpressionsPerSnapshot: meanOf(gscTrend, (row) => row.impressions),
      gscCtr: gscTrendImpressions ? gscTrendClicks / gscTrendImpressions : 0,
      // Human-readable ends of the trend, taken from gsc_window (what GSC
      // measured) rather than from the row's date (when we asked).
      gscWindowFirst: gscTrend[0]?.gscWindow ?? null,
      gscWindowLast: gscTrend[gscTrend.length - 1]?.gscWindow ?? null,
      gscSeries: gscTrend.map((row) => ({ date: row.date, gscWindow: row.gscWindow,
        clicks: row.clicks, impressions: row.impressions })),
    },
  };
  totals.delta = totals.previousVisits ? (totals.visits - totals.previousVisits) / totals.previousVisits : null;
  // RUM pageviews over RUM sessions. Meaningful only because both sides now come
  // from the same instrument.
  totals.pagesPerSession = totals.visits ? totals.views / totals.visits : 0;
  totals.searchShare = totals.visits ? totals.search / totals.visits : 0;
  totals.botShare = totals.visits + totals.botVisits
    ? totals.botVisits / (totals.visits + totals.botVisits) : 0;
  totals.gscCtr = totals.gscImpressions ? totals.gscClicks / totals.gscImpressions : 0;
  // Kept for /api/json continuity. The tile prints gscMedianPosition instead:
  // this mean is dragged around by whichever position-90 stray happens to be in
  // the stored rows, which is why it was never a number to act on.
  totals.gscPosition = totals.gscImpressions ? searchSites.reduce((sum, site) =>
    sum + site.searchSummary.position * site.searchSummary.impressions, 0) / totals.gscImpressions : 0;

  // Ranked signals replace the old NOTABLE list, which reported bare deltas with
  // no diagnosis, no priority, and no idea what it was measuring — its top chip
  // on 2026-08-13 was a pages/session change for a zone-sourced host, a quantity
  // that does not exist. The engine is a pure function of rows already read here
  // (the classifier window reaches back 30 days), so runDaily can reuse it for the
  // ntfy push without a second copy of the rules.
  const signals = computeSignals({
    sites, date, periodDays,
    zoneStatusRows: zoneStatuses.results ?? [],
    trafficRows: hist.results ?? [],
    floodDatesByHost: new Map(sites.map((site) => [site.host, floodDates(classified, site.host)])),
  });

  return { date, start, coverageStart: availableDates[0] || date, previousStart, previousEnd, generatedAt: new Date().toISOString(),
    dataUpdatedAt: run?.run_at || `${date}T00:00:00Z`, run, periodDays, domain, sort,
    allDomains: SITES.map((site) => site.host), signals, totals, sites };
}

// Internal, WAF-gated dashboard: tell compliant crawlers and AI agents to stay
// out. The WAF already blocks bot user-agents; this is the explicit signal.
const ROBOTS = `# stats.davidveksler.com - internal, WAF-gated analytics dashboard.
# Not a public content surface: no indexing, no AI input, no model training.
User-agent: *
Content-Signal: search=no, ai-input=no, ai-train=no
Disallow: /
`;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDaily(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/robots.txt") {
      return new Response(ROBOTS, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" },
      });
    }

    // Manual re-pull: /run?key=<REFRESH_KEY>  (requires the REFRESH_KEY secret)
    if (url.pathname === "/run") {
      if (!env.REFRESH_KEY || url.searchParams.get("key") !== env.REFRESH_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const result = await runDaily(env);
      return Response.json(result);
    }

    const dashboardOptions = {
      periodDays: url.searchParams.get("period"),
      domain: url.searchParams.get("domain"),
      sort: url.searchParams.get("sort"),
    };

    if (url.pathname === "/api/json") {
      return Response.json(await loadDashboard(env, dashboardOptions));
    }

    // The dashboard lives only at "/". Anything else is a real 404 — no
    // soft-404 fallback that renders the dashboard for every path, which
    // previously made /robots.txt, /llms.txt, and /.well-known/* falsely
    // return 200 and misled agent-readiness scanners.
    if (url.pathname !== "/") {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const data = await loadDashboard(env, dashboardOptions);
    return new Response(renderDashboard(data), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  },
};
