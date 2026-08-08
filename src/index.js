import { SITES } from "./config.js";
import { pullTraffic, topReferrers, topPages } from "./cloudflare.js";
import { getAccessToken, queryKeywords, queryPages, querySearchSummary } from "./gsc.js";
import { classifyTraffic, floodReason, floodDates } from "./bots.js";
import { renderDashboard } from "./render.js";

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
  ]);
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
  const stmts = [];
  for (const { host } of SITES) {
    const rec = traffic.get(host) ?? { views: 0, visits: 0, referrers: new Map() };
    stmts.push(
      env.DB.prepare(
        `INSERT INTO daily_traffic (date,host,visits,views) VALUES (?,?,?,?)
         ON CONFLICT(date,host) DO UPDATE SET visits=excluded.visits, views=excluded.views`
      ).bind(date, host, rec.visits, rec.views),
      env.DB.prepare(`DELETE FROM daily_referrers WHERE date=? AND host=?`).bind(date, host),
      env.DB.prepare(`DELETE FROM daily_cf_pages WHERE date=? AND host=?`).bind(date, host),
    );
    // Keep enough rows for accurate source-mix totals; the dashboard still
    // renders only the top eight referrers per domain.
    for (const r of topReferrers(rec.referrers, 50)) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO daily_referrers (date,host,referrer,kind,visits) VALUES (?,?,?,?,?)`
        ).bind(date, host, r.referrer, r.kind, r.visits),
      );
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
  if (env.GSC_SA_KEY) {
    try {
      const sa = JSON.parse(env.GSC_SA_KEY);
      const token = await getAccessToken(sa, Math.floor(now.getTime() / 1000));
      const gStart = addDays(date, -4);
      const gEnd = addDays(date, -2);
      const gscWindow = `${gStart}–${gEnd}`;
      for (const { host, gsc, gscPageFilter } of SITES) {
        stmts.push(env.DB.prepare(`DELETE FROM daily_keywords WHERE date=? AND host=?`).bind(date, host));
        stmts.push(env.DB.prepare(`DELETE FROM daily_pages WHERE date=? AND host=?`).bind(date, host));
        stmts.push(env.DB.prepare(`DELETE FROM daily_search_summary WHERE date=? AND host=?`).bind(date, host));
        let rows = [], pages = [], summary = null;
        try {
          rows = await queryKeywords(token, gsc, gStart, gEnd, 25, gscPageFilter);
        } catch (e) {
          notes.push(`gsc queries ${host}: ${e.message}`.slice(0, 140));
        }
        try {
          pages = await queryPages(token, gsc, gStart, gEnd, 15, gscPageFilter);
        } catch (e) {
          notes.push(`gsc pages ${host}: ${e.message}`.slice(0, 140));
        }
        try {
          summary = await querySearchSummary(token, gsc, gStart, gEnd, gscPageFilter);
        } catch (e) {
          notes.push(`gsc summary ${host}: ${e.message}`.slice(0, 140));
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
  await sendNtfy(env, traffic, totalVisits, gscOk, notes, summary);
  return { date, totalVisits, humanVisits: summary?.humanVisits ?? null,
    botVisits: summary?.botVisits ?? null, gscOk, notes };
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
    if (day.flood) botVisits += day.visits;
    else { humanVisits += day.visits; perHost.set(host, day.visits); }
  }
  const flooded = [...SITES].filter(({ host }) => classified.get(host)?.get(date)?.flood).map(({ host }) => host);
  return { humanVisits, botVisits, perHost, flooded };
}

async function sendNtfy(env, traffic, totalVisits, gscOk, notes, summary) {
  if (!env.NTFY_TOPIC) return;
  const ranked = summary
    ? [...summary.perHost.entries()].sort((a, b) => b[1] - a[1])
    : [...traffic.entries()].sort((a, b) => b[1].visits - a[1].visits).map(([h, r]) => [h, r.visits]);
  const top = ranked.slice(0, 4).map(([h, v]) => `${h.replace(/^www\./, "")}: ${v}`).join("\n");
  const headline = summary ? `${summary.humanVisits} visitors (24h)` : `${totalVisits} visitors (24h)`;
  const crawlers = summary?.botVisits
    ? `\n🤖 ${summary.botVisits} crawler sessions excluded (${summary.flooded.join(", ")})` : "";
  const body = `${headline}\n${top}${crawlers}${gscOk ? "" : "\n⚠ keywords: " + (notes[0] || "skipped")}`;
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
  const latest = await env.DB.prepare(`SELECT MAX(date) AS d FROM daily_traffic`).first();
  const date = latest?.d;
  if (!date) {
    return { date: null, coverageStart: null, generatedAt: new Date().toISOString(), dataUpdatedAt: null, run: null,
      periodDays, domain, sort, allDomains: SITES.map((site) => site.host), anomalies: [],
      totals: { visits: 0, views: 0, search: 0, domains: selectedSites.length, active: 0,
        previousVisits: 0, delta: null, daysAvailable: 0, previousDaysAvailable: 0,
        botVisits: 0, botViews: 0, previousBotVisits: 0, botShare: 0, floodedSiteDays: 0, floodedSites: 0,
        sourceMix: { direct: 0, search: 0, social: 0, referral: 0, other: 0 },
        gscClicks: 0, gscImpressions: 0, gscCtr: 0, gscPosition: 0, searchDataDomains: 0,
        opportunities: 0 },
      sites: selectedSites.map((s) => ({ host: s.host, visits: 0, views: 0, previousVisits: 0,
        botVisits: 0, botViews: 0, botDays: 0, previousBotVisits: 0, cleanDays: 0, anomaly: null,
        delta: null, referrers: [], keywords: [], pages: [], cfPages: [], searchSummary: null,
        sources: { direct: 0, search: 0, social: 0, referral: 0, other: 0 }, spark: [] })) };
  }
  const start = addDays(date, -(periodDays - 1));
  const previousEnd = addDays(start, -1);
  const previousStart = addDays(previousEnd, -(periodDays - 1));
  // Crawler detection needs enough trailing history to know what a normal day
  // looks like, and it has to reach back over the comparison period too — a
  // flooded "previous period" would otherwise poison every delta on the page.
  const historyStart = [previousStart, addDays(date, -29)].sort()[0];
  const pagesQuery = env.DB.prepare(
    `SELECT host,page,clicks,impressions,ctr,position,gsc_window FROM daily_pages WHERE date=? ORDER BY clicks DESC, impressions DESC`
  ).bind(date).all().catch(() => ({ results: [] }));
  const searchSummaryQuery = env.DB.prepare(
    `SELECT host,clicks,impressions,ctr,position,gsc_window FROM daily_search_summary WHERE date=?`
  ).bind(date).all().catch(() => ({ results: [] }));
  // Referrers and landing pages keep their date so flooded days can be dropped;
  // otherwise the detail panels would still show the crawler's millions of
  // direct hits under a headline that had already excluded them.
  const cfPagesQuery = env.DB.prepare(
    `SELECT date,host,page,visits,views FROM daily_cf_pages WHERE date BETWEEN ? AND ?`
  ).bind(start, date).all().catch(() => ({ results: [] }));
  const [tr, previousTr, refs, kws, pages, searchSummaries, cfPages, hist, histRefs, run] = await Promise.all([
    env.DB.prepare(`SELECT date,host,visits,views FROM daily_traffic WHERE date BETWEEN ? AND ? ORDER BY date ASC`).bind(start, date).all(),
    env.DB.prepare(`SELECT date,host,visits,views FROM daily_traffic WHERE date BETWEEN ? AND ? ORDER BY date ASC`).bind(previousStart, previousEnd).all(),
    env.DB.prepare(
      `SELECT date,host,referrer,kind,SUM(visits) AS visits FROM daily_referrers
       WHERE date BETWEEN ? AND ? GROUP BY date,host,referrer,kind`
    ).bind(start, date).all(),
    env.DB.prepare(`SELECT host,query,clicks,impressions,position,gsc_window FROM daily_keywords WHERE date=? ORDER BY clicks DESC, impressions DESC`).bind(date).all(),
    pagesQuery,
    searchSummaryQuery,
    cfPagesQuery,
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
  // Split every measured day into human vs crawler. A flooded day is excluded
  // whole rather than estimated: within such a day the real visitors are not
  // separable from the crawler, so the honest move is to report the clean days
  // and say plainly how many days were dropped.
  const sumTraffic = (rows, floods) => rows.reduce((acc, row) => {
    const visits = Number(row.visits || 0), views = Number(row.views || 0);
    if (floods.has(row.date)) { acc.botVisits += visits; acc.botViews += views; acc.botDays += 1; }
    else { acc.visits += visits; acc.views += views; }
    return acc;
  }, { visits: 0, views: 0, botVisits: 0, botViews: 0, botDays: 0 });
  const summarizeSources = (rows, visits) => {
    const result = { direct: 0, search: 0, social: 0, referral: 0, other: 0 };
    for (const row of rows) {
      const key = row.kind === "ref" ? "referral" : row.kind;
      if (key in result && key !== "other") result[key] += Number(row.visits || 0);
    }
    const attributed = result.direct + result.search + result.social + result.referral;
    result.other = Math.max(0, visits - attributed);
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
    const t = sumTraffic(byHost(tr, s.host), floods);
    const previous = sumTraffic(byHost(previousTr, s.host), floods);
    const kwRows = byHost(kws, s.host);
    const pageRows = byHost(pages, s.host);
    const cfPageRows = mergeBy(byHost(cfPages, s.host).filter((r) => !floods.has(r.date)),
      (r) => r.page, (r) => ({ page: r.page, visits: 0, views: 0 }));
    const refRows = mergeBy(byHost(refs, s.host).filter((r) => !floods.has(r.date)),
      (r) => `${r.referrer} ${r.kind}`, (r) => ({ referrer: r.referrer, kind: r.kind, visits: 0 }));
    const summaryRow = byHost(searchSummaries, s.host)[0] ?? null;
    const currentRate = t.visits ? t.views / t.visits : 0;
    const previousRate = previous.visits ? previous.views / previous.visits : 0;
    // The callout describes the most recent flooded day, which is the one the
    // reader is looking at; older flooded days show up as gaps in the sparkline.
    const latestFlood = [...floods].sort().at(-1);
    return {
      host: s.host,
      visits: t.visits, views: t.views,
      botVisits: t.botVisits, botViews: t.botViews, botDays: t.botDays,
      previousVisits: previous.visits,
      previousBotVisits: previous.botVisits,
      cleanDays: byHost(tr, s.host).length - t.botDays,
      delta: previous.visits ? (t.visits - previous.visits) / previous.visits : null,
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
      opportunityCount: kwRows.filter((k) => Number(k.impressions) >= 5 && Number(k.position) >= 4 &&
        Number(k.position) <= 20 && Number(k.clicks) / Number(k.impressions) < .04).length,
      gscWindow: summaryRow?.gsc_window || kwRows[0]?.gsc_window || pageRows[0]?.gsc_window || null,
      // The sparkline plots what was measured, flooded days included, but marks
      // them — hiding them would turn a crawler event into a mysterious gap.
      spark: byHost(hist, s.host).slice(-14).map((r) => ({
        date: r.date, visits: Number(r.visits || 0), flood: floods.has(r.date),
      })),
    };
  });

  if (sort === "name") sites.sort((a, b) => a.host.localeCompare(b.host));
  else if (sort === "change") sites.sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));
  else sites.sort((a, b) => b.visits - a.visits);

  const sourceMix = sites.reduce((acc, site) => {
    for (const key of Object.keys(acc)) acc[key] += site.sources[key];
    return acc;
  }, { direct: 0, search: 0, social: 0, referral: 0, other: 0 });
  const searchSites = sites.filter((site) => site.searchSummary);
  const totals = {
    visits: sites.reduce((a, s) => a + s.visits, 0),
    views: sites.reduce((a, s) => a + s.views, 0),
    search: sourceMix.search,
    sourceMix,
    domains: sites.length,
    active: sites.filter((s) => s.visits > 0).length,
    previousVisits: sites.reduce((a, s) => a + s.previousVisits, 0),
    // Crawler traffic is reported, never hidden — it just does not get to sit in
    // the same number as the human audience.
    botVisits: sites.reduce((a, s) => a + s.botVisits, 0),
    botViews: sites.reduce((a, s) => a + s.botViews, 0),
    previousBotVisits: sites.reduce((a, s) => a + s.previousBotVisits, 0),
    floodedSiteDays: sites.reduce((a, s) => a + s.botDays, 0),
    floodedSites: sites.filter((s) => s.botDays > 0).length,
    daysAvailable: availableDates.length,
    previousDaysAvailable: previousAvailableDates.length,
    gscClicks: searchSites.reduce((sum, site) => sum + site.searchSummary.clicks, 0),
    gscImpressions: searchSites.reduce((sum, site) => sum + site.searchSummary.impressions, 0),
    searchDataDomains: searchSites.length,
    opportunities: sites.reduce((sum, site) => sum + site.opportunityCount, 0),
  };
  totals.delta = totals.previousVisits ? (totals.visits - totals.previousVisits) / totals.previousVisits : null;
  totals.searchShare = totals.visits ? totals.search / totals.visits : 0;
  totals.botShare = totals.visits + totals.botVisits
    ? totals.botVisits / (totals.visits + totals.botVisits) : 0;
  totals.gscCtr = totals.gscImpressions ? totals.gscClicks / totals.gscImpressions : 0;
  totals.gscPosition = totals.gscImpressions ? searchSites.reduce((sum, site) =>
    sum + site.searchSummary.position * site.searchSummary.impressions, 0) / totals.gscImpressions : 0;

  const anomalies = sites.flatMap((site) => {
    const items = [];
    if (site.delta !== null && Math.abs(site.delta) >= 0.25 && site.visits >= 10) {
      items.push({ type: site.delta > 0 ? "up" : "down", host: site.host, metric: "sessions", value: site.delta });
    }
    if (site.pagesPerSessionDelta !== null && Math.abs(site.pagesPerSessionDelta) >= 0.4 && site.visits >= 10) {
      items.push({ type: site.pagesPerSessionDelta > 0 ? "up" : "down", host: site.host,
        metric: "pages/session", value: site.pagesPerSessionDelta });
    }
    return items;
  }).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 4);

  return { date, start, coverageStart: availableDates[0] || date, previousStart, previousEnd, generatedAt: new Date().toISOString(),
    dataUpdatedAt: run?.run_at || `${date}T00:00:00Z`, run, periodDays, domain, sort,
    allDomains: SITES.map((site) => site.host), anomalies, totals, sites };
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
