import { SITES } from "./config.js";
import { pullTraffic, topReferrers } from "./cloudflare.js";
import { getAccessToken, queryKeywords } from "./gsc.js";
import { renderDashboard } from "./render.js";

const utcDate = (d) => d.toISOString().slice(0, 10);
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return utcDate(d);
}

// ---- Nightly pull: Cloudflare + GSC -> D1 -> ntfy -------------------------
async function runDaily(env, now = new Date()) {
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
    );
    for (const r of topReferrers(rec.referrers, 8)) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO daily_referrers (date,host,referrer,kind,visits) VALUES (?,?,?,?,?)`
        ).bind(date, host, r.referrer, r.kind, r.visits),
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
        let rows = [];
        try {
          rows = await queryKeywords(token, gsc, gStart, gEnd, 25, gscPageFilter);
        } catch (e) {
          notes.push(`gsc ${host}: ${e.message}`.slice(0, 120));
        }
        for (const k of rows) {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO daily_keywords (date,host,query,clicks,impressions,position,gsc_window) VALUES (?,?,?,?,?,?,?)`
            ).bind(date, host, k.query, k.clicks, k.impressions, k.position, gscWindow),
          );
        }
      }
      gscOk = true;
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

  // 4. ntfy push
  await sendNtfy(env, traffic, totalVisits, gscOk, notes);
  return { date, totalVisits, gscOk, notes };
}

async function sendNtfy(env, traffic, totalVisits, gscOk, notes) {
  if (!env.NTFY_TOPIC) return;
  const top = [...traffic.entries()]
    .sort((a, b) => b[1].visits - a[1].visits)
    .slice(0, 4)
    .map(([h, r]) => `${h.replace(/^www\./, "")}: ${r.visits}`)
    .join("\n");
  const body = `${totalVisits} visitors (24h)\n${top}${gscOk ? "" : "\n⚠ keywords: " + (notes[0] || "skipped")}`;
  try {
    await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: "Traffic + Search — daily", Tags: "bar_chart", Priority: "default" },
      body,
    });
  } catch (_) { /* non-fatal */ }
}

// ---- Read from D1 and render ---------------------------------------------
async function loadDashboard(env) {
  const latest = await env.DB.prepare(`SELECT MAX(date) AS d FROM daily_traffic`).first();
  const date = latest?.d;
  if (!date) {
    return { date: null, generatedAt: new Date().toISOString(), run: null,
      totals: { visits: 0, views: 0, search: 0, domains: SITES.length, active: 0 },
      sites: SITES.map((s) => ({ host: s.host, visits: 0, views: 0, referrers: [], keywords: [], spark: [] })) };
  }
  const [tr, refs, kws, hist, run] = await Promise.all([
    env.DB.prepare(`SELECT host,visits,views FROM daily_traffic WHERE date=?`).bind(date).all(),
    env.DB.prepare(`SELECT host,referrer,kind,visits FROM daily_referrers WHERE date=? ORDER BY visits DESC`).bind(date).all(),
    env.DB.prepare(`SELECT host,query,clicks,impressions,position,gsc_window FROM daily_keywords WHERE date=? ORDER BY clicks DESC, impressions DESC`).bind(date).all(),
    env.DB.prepare(`SELECT date,host,visits FROM daily_traffic WHERE date >= date(?, '-14 days') ORDER BY date ASC`).bind(date).all(),
    env.DB.prepare(`SELECT run_at,ok,note FROM runs ORDER BY run_at DESC LIMIT 1`).first(),
  ]);

  const byHost = (rows, h) => rows.results.filter((r) => r.host === h);
  const sites = SITES.map((s) => {
    const t = tr.results.find((r) => r.host === s.host) ?? { visits: 0, views: 0 };
    const kwRows = byHost(kws, s.host);
    return {
      host: s.host,
      visits: t.visits, views: t.views,
      referrers: byHost(refs, s.host).map((r) => ({ referrer: r.referrer, kind: r.kind, visits: r.visits })),
      keywords: kwRows.slice(0, 12).map((k) => ({ query: k.query, clicks: k.clicks, impressions: k.impressions, position: k.position })),
      gscWindow: kwRows[0]?.gsc_window || null,
      spark: byHost(hist, s.host).map((r) => ({ date: r.date, visits: r.visits })),
    };
  });

  const totals = {
    visits: sites.reduce((a, s) => a + s.visits, 0),
    views: sites.reduce((a, s) => a + s.views, 0),
    search: refs.results.filter((r) => r.kind === "search").reduce((a, r) => a + r.visits, 0),
    domains: SITES.length,
    active: sites.filter((s) => s.visits > 0).length,
  };
  return { date, generatedAt: new Date().toISOString(), run, totals, sites };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDaily(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // Manual re-pull: /run?key=<REFRESH_KEY>  (requires the REFRESH_KEY secret)
    if (url.pathname === "/run") {
      if (!env.REFRESH_KEY || url.searchParams.get("key") !== env.REFRESH_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const result = await runDaily(env);
      return Response.json(result);
    }

    if (url.pathname === "/api/json") {
      return Response.json(await loadDashboard(env));
    }

    const data = await loadDashboard(env);
    return new Response(renderDashboard(data), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  },
};
