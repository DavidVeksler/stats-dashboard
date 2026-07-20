// Renders the dashboard HTML from data read out of D1.
import { APPLE_SPLASH_LINKS } from "./appleSplashLinks.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const pct = (n, digits = 0) => `${(Number(n || 0) * 100).toFixed(digits)}%`;
const TAG_LABEL = { search: "search", direct: "direct", social: "social", ref: "referral" };

function deltaBadge(value, compact = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return `<span class="delta neutral">no comparison</span>`;
  }
  const direction = value > 0 ? "up" : value < 0 ? "down" : "neutral";
  const arrow = value > 0 ? "↑" : value < 0 ? "↓" : "→";
  const label = `${arrow} ${Math.abs(value * 100).toFixed(0)}%${compact ? "" : " vs previous"}`;
  return `<span class="delta ${direction}">${label}</span>`;
}

function sparkline(points, host) {
  const vals = points.map((point) => Number(point.visits || 0));
  if (vals.length < 2) return `<div class="spark-empty">Trend appears after two daily snapshots.</div>`;
  const w = 150, h = 38, pad = 3;
  const max = Math.max(...vals, 1), min = Math.min(...vals);
  const span = max - min || 1;
  const step = (w - pad * 2) / (vals.length - 1);
  const coords = vals.map((value, index) => ({
    x: pad + index * step,
    y: h - pad - ((value - min) / span) * (h - pad * 2),
  }));
  const line = coords.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`;
  const id = `spark-${host.replace(/[^a-z0-9]/gi, "-")}`;
  const label = `${points.length}-day sessions for ${host}: ${vals.join(", ")}; latest ${vals.at(-1)}`;
  const pointsWithTitles = coords.map(({ x, y }, index) =>
    `<circle class="spark-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4">
      <title>${esc(points[index].date)}: ${fmt(vals[index])} sessions</title>
    </circle>`).join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--traffic)" stop-opacity=".22"/><stop offset="1" stop-color="var(--traffic)" stop-opacity="0"/></linearGradient></defs>
    <polygon points="${area}" fill="url(#${id})"/>
    <polyline points="${line}" fill="none" stroke="var(--traffic)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${pointsWithTitles}
    <circle cx="${coords.at(-1).x.toFixed(1)}" cy="${coords.at(-1).y.toFixed(1)}" r="2.7" fill="var(--traffic)"/>
  </svg>`;
}

function referrerList(site) {
  if (!site.referrers.length) return `<p class="none">No referrers in this period.</p>`;
  const total = site.referrers.reduce((sum, row) => sum + Number(row.visits || 0), 0);
  const external = site.referrers.filter((row) => row.kind !== "direct");
  const externalMax = Math.max(1, ...external.map((row) => Number(row.visits || 0)));
  const rows = site.referrers.map((row) => {
    const isDirect = row.kind === "direct";
    const width = isDirect ? 100 : Math.max(7, Math.round((Number(row.visits || 0) / externalMax) * 100));
    const name = row.referrer === "(direct)" ? "Direct / none" : row.referrer;
    const share = total ? Number(row.visits || 0) / total : 0;
    return `<li class="ref ${isDirect ? "direct-row" : ""}" title="${esc(name)}: ${fmt(row.visits)} sessions (${pct(share, 1)})">
      <div class="bar" style="width:${width}%"></div>
      <div class="row"><span class="name">${esc(name)}<span class="tag ${esc(row.kind)}">${TAG_LABEL[row.kind] || "referral"}</span></span><span class="n">${fmt(row.visits)}</span></div>
    </li>`;
  }).join("");
  return `<ol class="ref-list">${rows}</ol>${external.length && site.referrers.some((row) => row.kind === "direct")
    ? `<div class="scale-note">External bars use their own scale.</div>` : ""}`;
}

function keywordList(keywords) {
  if (!keywords.length) return `<p class="none">No search queries in the latest GSC window.</p>`;
  return `<ol class="metric-list">${keywords.map((keyword) => {
    const ctr = keyword.impressions ? keyword.clicks / keyword.impressions : 0;
    const opportunity = keyword.impressions >= 5 && keyword.position >= 4 && keyword.position <= 20 && ctr < .04;
    return `<li class="metric-row ${opportunity ? "opportunity" : ""}">
      <div class="metric-name"><span class="truncate" title="${esc(keyword.query)}">${esc(keyword.query)}</span>${opportunity ? `<span class="opportunity-tag">opportunity</span>` : ""}</div>
      <div class="metric-values"><strong>${fmt(keyword.clicks)} clk</strong><span>${fmt(keyword.impressions)} imp · ${pct(ctr, 1)} CTR · pos ${Number(keyword.position || 0).toFixed(1)}</span></div>
    </li>`;
  }).join("")}</ol>`;
}

function pageLabel(page) {
  try {
    const url = new URL(page);
    return `${url.pathname}${url.search}` || "/";
  } catch (_) {
    return page;
  }
}

function pageList(pages) {
  if (!pages.length) return `<p class="none">Landing-page data will appear after the next successful GSC pull.</p>`;
  return `<ol class="metric-list pages-list">${pages.map((page) =>
    `<li class="metric-row">
      <div class="metric-name"><a class="truncate" href="${esc(page.page)}" target="_blank" rel="noopener" title="${esc(page.page)}">${esc(pageLabel(page.page))}</a></div>
      <div class="metric-values"><strong>${fmt(page.clicks)} clk</strong><span>${fmt(page.impressions)} imp · ${pct(page.ctr, 1)} CTR · pos ${Number(page.position || 0).toFixed(1)}</span></div>
    </li>`).join("")}</ol>`;
}

function searchSummary(summary) {
  if (!summary) return "";
  return `<div class="search-summary" aria-label="Google Search performance">
    <div><strong>${fmt(summary.clicks)}</strong><span>clicks</span></div>
    <div><strong>${fmt(summary.impressions)}</strong><span>impressions</span></div>
    <div><strong>${pct(summary.ctr, 1)}</strong><span>CTR</span></div>
    <div><strong>${summary.position ? Number(summary.position).toFixed(1) : "—"}</strong><span>avg position</span></div>
  </div>`;
}

function sourceMix(mix, total) {
  if (!total) return "";
  const sources = [
    ["direct", "Direct"], ["search", "Search"], ["social", "Social"],
    ["referral", "Referral"], ["other", "Other / unlisted"],
  ].map(([key, label]) => ({ key, label, value: Number(mix?.[key] || 0) }));
  const segments = sources.filter((source) => source.value > 0).map((source) =>
    `<span class="source-segment ${source.key}" style="width:${Math.max(0, source.value / total * 100).toFixed(2)}%" title="${esc(source.label)}: ${fmt(source.value)} sessions (${pct(source.value / total, 1)})"></span>`).join("");
  return `<section class="source-overview" aria-labelledby="source-heading">
    <div class="source-heading"><h2 id="source-heading">Traffic sources</h2><span>selected traffic period</span></div>
    <div class="source-bar" role="img" aria-label="Traffic source mix">${segments}</div>
    <div class="source-legend">${sources.map((source) => `<div><i class="${source.key}"></i><span>${esc(source.label)}</span><strong>${fmt(source.value)}</strong><small>${pct(source.value / total, 1)}</small></div>`).join("")}</div>
  </section>`;
}

function siteCard(site, index, periodDays) {
  const id = `site-${site.host.replace(/[^a-z0-9]/gi, "-")}`;
  const periodLabel = periodDays === 1 ? "24h" : `${periodDays}d`;
  const hasDetails = site.searchSummary || site.referrers.length || site.keywords.length || site.pages.length;
  return `<section class="card ${!site.visits && !hasDetails ? "empty" : ""}" aria-labelledby="${id}">
    <div class="chead">
      <div class="hostwrap">
        <h2 class="host" id="${id}"><a href="https://${esc(site.host)}" target="_blank" rel="noopener">${esc(site.host)}</a></h2>
        ${sparkline(site.spark, site.host)}
      </div>
      <div class="nums"><div class="big">${site.visits ? fmt(site.visits) : "—"}</div><div class="lbl">sessions ${periodLabel}</div>
        ${deltaBadge(site.delta, true)}<div class="pv">${fmt(site.views)} views · ${site.pagesPerSession ? site.pagesPerSession.toFixed(1) : "0.0"} pages/session</div></div>
    </div>
    ${searchSummary(site.searchSummary)}
    ${hasDetails ? `<details class="detail" open data-card-index="${index}">
      <summary><span>Referrers, search queries &amp; landing pages</span><span class="summary-action">Hide details</span></summary>
      <div class="cols">
        <section class="panel"><h3><span class="dot traffic"></span>Top referrers</h3>${referrerList(site)}</section>
        <section class="panel"><h3><span class="dot search"></span>Search opportunities</h3>${keywordList(site.keywords)}</section>
      </div>
      <section class="panel pages-panel"><h3><span class="dot good"></span>Top landing pages</h3>${pageList(site.pages)}</section>
    </details>` : `<p class="none">No analytics data in this window.</p>`}
  </section>`;
}

function withQuery(data, changes) {
  const values = { period: data.periodDays, domain: data.domain || "", sort: data.sort || "traffic", ...changes };
  const params = new URLSearchParams();
  if (values.period !== 1) params.set("period", String(values.period));
  if (values.domain) params.set("domain", values.domain);
  if (values.sort && values.sort !== "traffic") params.set("sort", values.sort);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function formatDate(date) {
  if (!date) return "—";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function formatTimestamp(timestamp) {
  if (!timestamp) return "not yet available";
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: "America/Denver", timeZoneName: "short",
  });
}

function anomalyText(item) {
  if (item.metric === "sessions") {
    return `${item.host} sessions ${item.value > 0 ? "rose" : "fell"} ${Math.abs(item.value * 100).toFixed(0)}%`;
  }
  return `${item.host} pages/session ${item.value > 0 ? "rose" : "fell"} by ${Math.abs(item.value).toFixed(1)}`;
}

export function renderDashboard(data) {
  const totals = data.totals;
  const periodLabel = data.periodDays === 1 ? "Last 24 hours" : `Last ${data.periodDays} days`;
  const previousLabel = data.periodDays === 1 ? "previous day" : `previous ${data.periodDays} days`;
  const trafficWindow = data.coverageStart && data.date && data.coverageStart !== data.date
    ? `${formatDate(data.coverageStart)}–${formatDate(data.date)}` : formatDate(data.date);
  const coverageNote = data.periodDays > 1 && totals.daysAvailable < data.periodDays
    ? `${totals.daysAvailable} of ${data.periodDays} daily snapshots available` : null;
  const gscWindow = data.sites.find((site) => site.gscWindow)?.gscWindow || "latest available";
  const updatedAt = data.dataUpdatedAt || data.run?.run_at;
  const stale = updatedAt ? Date.now() - Date.parse(updatedAt) > 30 * 3600 * 1000 : true;
  const stats = [
    ["Total sessions", fmt(totals.visits), `${deltaBadge(totals.delta)}<span>${coverageNote || periodLabel.toLowerCase()}</span>`],
    ["Total pageviews", fmt(totals.views), `<span>${totals.visits ? (totals.views / totals.visits).toFixed(1) : "0.0"} pages / session</span>`],
    ["Search sessions", fmt(totals.search), `<span>${pct(totals.searchShare, 1)} of all sessions</span>`],
    [data.domain ? "Domain selected" : "Domains shown", totals.domains, `<span>${totals.active} with traffic</span>`],
  ];
  if (totals.searchDataDomains) {
    stats.push(
      ["Google clicks", fmt(totals.gscClicks), `<span>latest complete GSC window</span>`],
      ["Search impressions", fmt(totals.gscImpressions), `<span>across ${fmt(totals.searchDataDomains)} domain${totals.searchDataDomains === 1 ? "" : "s"}</span>`],
      ["Search CTR", pct(totals.gscCtr, 1), `<span>clicks / impressions</span>`],
      ["Avg search position", totals.gscPosition ? totals.gscPosition.toFixed(1) : "—", `<span>${fmt(totals.opportunities)} opportunities in top queries</span>`],
    );
  }

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Traffic &amp; Search — Daily Brief</title>

<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/favicon-16x16.png" sizes="16x16" type="image/png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="mask-icon" href="/mask-icon.svg" color="#256cad">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="apple-touch-icon" sizes="120x120" href="/apple-touch-icon-120x120.png">
<link rel="apple-touch-icon" sizes="152x152" href="/apple-touch-icon-152x152.png">
<link rel="apple-touch-icon" sizes="167x167" href="/apple-touch-icon-167x167.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
${APPLE_SPLASH_LINKS}

<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Stats">
<meta name="application-name" content="Stats">
<meta name="format-detection" content="telephone=no">
<meta name="theme-color" id="theme-color-meta" content="#f5f7fa">
<style>
:root{--paper:#f5f7fa;--card:#fff;--ink:#151a23;--muted:#596474;--faint:#7d8898;--line:#e2e7ee;--traffic:#256cad;--traffic-soft:#dce9f5;--search:#aa6d13;--search-soft:#f5ead5;--direct:#64748b;--social:#7454b8;--good:#31865a;--good-soft:#dff1e8;--danger:#b84b4b;--danger-soft:#f8e4e4;--shadow:0 1px 2px rgba(20,25,34,.04),0 7px 24px rgba(20,25,34,.055);--radius:14px}
@media (prefers-color-scheme:dark){:root{--paper:#0e131a;--card:#171e27;--ink:#e8edf4;--muted:#a0aaba;--faint:#7f8a9a;--line:#293340;--traffic:#70afe5;--traffic-soft:#20384e;--search:#e0ad54;--search-soft:#3c311d;--direct:#94a0b1;--social:#b093e8;--good:#68c58d;--good-soft:#1e3b2b;--danger:#ef8e8e;--danger-soft:#482626;--shadow:0 2px 4px rgba(0,0,0,.28),0 8px 28px rgba(0,0,0,.34)}}
:root[data-theme=dark]{--paper:#0e131a;--card:#171e27;--ink:#e8edf4;--muted:#a0aaba;--faint:#7f8a9a;--line:#293340;--traffic:#70afe5;--traffic-soft:#20384e;--search:#e0ad54;--search-soft:#3c311d;--direct:#94a0b1;--social:#b093e8;--good:#68c58d;--good-soft:#1e3b2b;--danger:#ef8e8e;--danger-soft:#482626;--shadow:0 2px 4px rgba(0,0,0,.28),0 8px 28px rgba(0,0,0,.34)}
:root[data-theme=light]{--paper:#f5f7fa;--card:#fff;--ink:#151a23;--muted:#596474;--faint:#7d8898;--line:#e2e7ee;--traffic:#256cad;--traffic-soft:#dce9f5;--search:#aa6d13;--search-soft:#f5ead5;--direct:#64748b;--social:#7454b8;--good:#31865a;--good-soft:#dff1e8;--danger:#b84b4b;--danger-soft:#f8e4e4;--shadow:0 1px 2px rgba(20,25,34,.04),0 7px 24px rgba(20,25,34,.055)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;line-height:1.45;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit}a,button,select,summary{touch-action:manipulation}a:focus-visible,button:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid color-mix(in srgb,var(--traffic) 58%,transparent);outline-offset:2px}.skip{position:fixed;left:12px;top:-60px;background:var(--ink);color:var(--paper);padding:8px 12px;border-radius:6px;z-index:10}.skip:focus{top:12px}.wrap{max-width:1180px;margin:0 auto;padding:calc(34px + env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) calc(64px + env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left))}
header.top{display:flex;align-items:flex-start;justify-content:space-between;gap:18px 32px;padding-bottom:22px;border-bottom:1px solid var(--line)}.eyebrow{text-transform:uppercase;letter-spacing:.15em;font-size:11px;font-weight:700;color:var(--faint)}h1{font-size:28px;margin:4px 0 0;letter-spacing:-.025em;text-wrap:balance}.win{font-size:12.5px;color:var(--muted);text-align:right;line-height:1.65}.win b{color:var(--ink);font-weight:650}.fresh{display:inline-flex;align-items:center;gap:5px}.fresh::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--good)}.fresh.stale{color:var(--danger)}.fresh.stale::before{background:var(--danger)}
.toolbar{display:flex;align-items:end;justify-content:space-between;gap:12px;margin:18px 0}.periods{display:flex;gap:4px;background:color-mix(in srgb,var(--line) 62%,transparent);padding:4px;border-radius:10px}.periods a{text-decoration:none;font-size:12px;font-weight:650;color:var(--muted);padding:6px 10px;border-radius:7px}.periods a[aria-current=page]{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}.filters{display:flex;align-items:end;gap:8px}.field{display:flex;flex-direction:column;gap:3px}.field label{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);font-weight:700}.field select,.theme{height:34px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit;font-size:12px;padding:0 28px 0 9px}.theme{padding:0 10px;cursor:pointer}
.totals{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin:0 0 18px}.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:15px 17px;box-shadow:var(--shadow)}.stat .k{font-size:10px;text-transform:uppercase;letter-spacing:.11em;color:var(--faint);font-weight:700}.stat .v{font-size:30px;font-weight:700;letter-spacing:-.035em;margin:3px 0}.stat .s{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:7px;flex-wrap:wrap}.delta{display:inline-flex;align-items:center;font-size:10px;font-weight:700;border-radius:999px;padding:2px 6px;background:var(--line);color:var(--muted);white-space:nowrap}.delta.up{background:var(--good-soft);color:var(--good)}.delta.down{background:var(--danger-soft);color:var(--danger)}
.source-overview{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px 17px;box-shadow:var(--shadow);margin:-2px 0 18px}.source-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:9px}.source-heading h2{font-size:10px;text-transform:uppercase;letter-spacing:.11em;color:var(--faint);margin:0}.source-heading span{font-size:10px;color:var(--faint)}.source-bar{height:8px;display:flex;overflow:hidden;border-radius:999px;background:var(--line);margin-bottom:10px}.source-segment{height:100%}.source-segment.direct,.source-legend i.direct{background:var(--direct)}.source-segment.search,.source-legend i.search{background:var(--search)}.source-segment.social,.source-legend i.social{background:var(--social)}.source-segment.referral,.source-legend i.referral{background:var(--good)}.source-segment.other,.source-legend i.other{background:var(--faint)}.source-legend{display:grid;grid-template-columns:repeat(5,1fr);gap:8px 14px}.source-legend>div{display:grid;grid-template-columns:auto 1fr auto;align-items:center;column-gap:6px;font-size:11px;min-width:0}.source-legend i{width:7px;height:7px;border-radius:50%}.source-legend span{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.source-legend strong{font-size:11px}.source-legend small{grid-column:2/-1;color:var(--faint);font-size:9px}.signals{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 20px}.signal-label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;font-weight:700;color:var(--faint);align-self:center;margin-right:2px}.signal{font-size:11.5px;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:5px 9px}.signal.up::before{content:"↑";color:var(--good);font-weight:800;margin-right:5px}.signal.down::before{content:"↓";color:var(--danger);font-weight:800;margin-right:5px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px 20px 20px;display:flex;flex-direction:column;gap:13px;min-width:0}.card.empty{opacity:.68}.chead{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.hostwrap{display:flex;flex-direction:column;gap:6px;min-width:0}.host{font-size:15px;font-weight:700;letter-spacing:-.01em;word-break:break-word;margin:0}.host a{text-decoration:none}.host a:hover{text-decoration:underline}.spark{display:block;max-width:100%;height:auto}.spark-hit{fill:transparent;stroke:none}.spark-empty{font-size:10px;color:var(--faint);font-style:italic}.nums{text-align:right;white-space:nowrap}.nums .big{font-size:25px;font-weight:700;letter-spacing:-.035em}.nums .lbl{font-size:9px;text-transform:uppercase;letter-spacing:.11em;color:var(--faint);margin-bottom:4px}.nums .pv{font-size:11px;color:var(--muted);margin-top:4px}.detail>summary{display:none}.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}.panel{min-width:0}.panel h3{font-size:9.5px;text-transform:uppercase;letter-spacing:.11em;font-weight:700;margin:0 0 8px;display:flex;align-items:center;gap:6px}.dot{width:7px;height:7px;border-radius:50%;display:inline-block}.dot.traffic{background:var(--traffic)}.dot.search{background:var(--search)}.dot.good{background:var(--good)}
.ref-list,.metric-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}.ref{position:relative}.ref .bar{position:absolute;inset:0 auto 0 0;background:var(--traffic-soft);border-radius:5px;z-index:0}.ref.direct-row .bar{background:color-mix(in srgb,var(--direct) 14%,transparent)}.ref .row{position:relative;z-index:1;display:flex;justify-content:space-between;gap:8px;padding:4px 7px;font-size:12px}.ref .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ref .n{font-weight:650;color:var(--muted)}.tag{font-size:8px;text-transform:uppercase;letter-spacing:.06em;padding:1px 4px;border-radius:4px;font-weight:700;margin-left:5px}.tag.search{background:var(--search-soft);color:var(--search)}.tag.direct{background:color-mix(in srgb,var(--direct) 16%,transparent);color:var(--direct)}.tag.social{background:color-mix(in srgb,var(--social) 18%,transparent);color:var(--social)}.tag.ref{background:var(--good-soft);color:var(--good)}.scale-note{font-size:9px;color:var(--faint);margin-top:5px}
.search-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;background:color-mix(in srgb,var(--search-soft) 55%,transparent);border-radius:8px;padding:8px 10px}.search-summary>div{display:flex;flex-direction:column;min-width:0}.search-summary strong{font-size:13px;color:var(--search);line-height:1.2}.search-summary span{font-size:8px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);white-space:nowrap}.metric-row{display:flex;justify-content:space-between;gap:10px;border-bottom:1px dashed var(--line);padding:2px 0 5px;min-width:0}.metric-row:last-child{border-bottom:0}.metric-row.opportunity{background:linear-gradient(90deg,var(--search-soft),transparent 72%);border-radius:5px;padding-left:5px}.metric-name{display:flex;align-items:center;gap:4px 6px;min-width:0;font-size:11.5px;flex-wrap:wrap}.truncate{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.metric-name .truncate{flex:1 1 120px;min-width:70px}.metric-name a{text-decoration:none}.metric-name a:hover{text-decoration:underline}.opportunity-tag{font-size:7.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--search);font-weight:800;border:1px solid color-mix(in srgb,var(--search) 35%,transparent);border-radius:4px;padding:1px 3px;flex:none}.metric-values{text-align:right;white-space:nowrap;display:flex;flex-direction:column;line-height:1.2}.metric-values strong{font-size:11px;color:var(--search)}.metric-values span{font-size:8.5px;color:var(--faint)}.pages-panel{margin-top:15px;padding-top:13px;border-top:1px solid var(--line)}.pages-list{display:grid;grid-template-columns:1fr 1fr;gap:5px 16px}.none{font-size:11.5px;color:var(--faint);font-style:italic;margin:0;padding:3px 0}
footer{margin-top:32px;padding-top:17px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted);display:flex;flex-direction:column;gap:5px}footer b{color:var(--ink);font-weight:650}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (max-width:940px){.grid{grid-template-columns:1fr}.card{max-width:760px;width:100%;margin-inline:auto}}
@media (max-width:700px){.toolbar{align-items:stretch;flex-direction:column}.filters{display:grid;grid-template-columns:1fr 1fr auto}.field select{width:100%}.totals{grid-template-columns:repeat(2,1fr)}.source-legend{grid-template-columns:repeat(2,1fr)}}
@media (max-width:560px){.wrap{padding:calc(20px + env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) calc(44px + env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))}header.top{flex-direction:column;align-items:flex-start;gap:10px;padding-bottom:16px}.win{text-align:left;width:100%;font-size:12px;line-height:1.7}h1{font-size:25px;line-height:1.15}.toolbar{margin:14px 0 16px}.periods{width:100%;padding:3px}.periods a{flex:1;display:flex;align-items:center;justify-content:center;min-height:44px;text-align:center;font-size:13px}.filters{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 8px}.field{gap:5px}.field label{font-size:10px}.field select,.theme{min-height:44px;height:44px;font-size:16px}.theme{grid-column:1/-1;width:100%}.totals{gap:8px;margin-bottom:14px}.stat{padding:13px 13px}.stat .k{font-size:10px;line-height:1.3}.stat .v{font-size:27px}.stat .s{font-size:12px}.source-overview{padding:14px;margin-bottom:14px}.source-heading span{font-size:11px}.source-legend{gap:10px 14px}.source-legend>div{font-size:12px}.source-legend strong{font-size:12px}.source-legend small{font-size:10px}.signals{margin-bottom:14px}.signal{font-size:12px;padding:7px 10px}.card{padding:16px 15px 17px;gap:12px}.chead{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:8px 12px}.hostwrap{display:contents}.host{grid-column:1/-1;font-size:16px;overflow-wrap:anywhere;word-break:normal}.spark,.spark-empty{grid-column:1;grid-row:2}.spark{width:132px}.nums{grid-column:2;grid-row:2;max-width:150px}.nums .big{font-size:25px}.nums .lbl{font-size:10px}.nums .pv{font-size:11px;white-space:normal}.search-summary{padding:10px}.search-summary strong{font-size:14px}.search-summary span{font-size:9px}.detail{border-top:1px solid var(--line);padding-top:0}.detail>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:44px;padding:8px 0;cursor:pointer;font-size:12px;color:var(--muted);line-height:1.35;list-style:none}.detail>summary::-webkit-details-marker{display:none}.summary-action{color:var(--traffic);font-weight:700;white-space:nowrap}.detail[open]>summary{margin-bottom:10px}.cols{grid-template-columns:1fr;gap:18px}.panel h3{font-size:10.5px}.pages-list{grid-template-columns:1fr}.pages-panel{margin-top:17px}.ref .row{min-height:36px;align-items:center;font-size:13px}.tag{font-size:9px}.metric-row{min-height:40px;align-items:center;padding-top:5px;padding-bottom:7px}.metric-name{font-size:13px}.metric-values strong{font-size:12px}.metric-values span{font-size:10px}.none{font-size:12px}footer{font-size:12px;line-height:1.55}}
@media (max-width:360px){.wrap{padding-inline:12px}.totals{gap:7px}.stat{padding:12px 11px}.stat .v{font-size:25px}.source-legend{grid-template-columns:1fr}.search-summary{grid-template-columns:repeat(2,1fr);gap:10px 8px}}
</style></head><body>
<a class="skip" href="#main">Skip to dashboard</a>
<div class="wrap">
  <header class="top">
    <div><div class="eyebrow">Daily traffic &amp; search brief</div><h1>${data.domain ? esc(data.domain) : "All domains — one glance"}</h1></div>
    <div class="win">
      Traffic: <b>${esc(periodLabel)}</b> · ${esc(trafficWindow)}${coverageNote ? ` · ${esc(coverageNote)}` : ""}<br>
      Search: <b>${esc(gscWindow)}</b> · freshest complete GSC window<br>
      <span class="fresh ${stale ? "stale" : ""}">${stale ? "Data may be stale" : "Last successful pull"}: <b>${esc(formatTimestamp(updatedAt))}</b></span>
    </div>
  </header>
  <nav class="toolbar" aria-label="Dashboard controls">
    <div class="periods" aria-label="Traffic reporting period">
      ${[1, 7, 30].map((days) => `<a href="${withQuery(data, { period: days })}" ${data.periodDays === days ? `aria-current="page"` : ""}>${days === 1 ? "24h" : `${days}d`}</a>`).join("")}
    </div>
    <div class="filters">
      <div class="field"><label for="domain-filter">Domain</label><select id="domain-filter" data-query="domain"><option value="">All domains</option>${data.allDomains.map((host) => `<option value="${esc(host)}" ${data.domain === host ? "selected" : ""}>${esc(host)}</option>`).join("")}</select></div>
      <div class="field"><label for="sort-filter">Sort</label><select id="sort-filter" data-query="sort"><option value="traffic" ${data.sort === "traffic" ? "selected" : ""}>Traffic</option><option value="change" ${data.sort === "change" ? "selected" : ""}>Biggest gain</option><option value="name" ${data.sort === "name" ? "selected" : ""}>Domain name</option></select></div>
      <button class="theme" id="theme-toggle" type="button" aria-label="Change color theme">◐ Theme</button>
    </div>
  </nav>
  <main id="main">
    <section class="totals" aria-labelledby="overview-heading"><h2 class="sr-only" id="overview-heading">Traffic overview</h2>
      ${stats.map((stat) => `<div class="stat"><div class="k">${stat[0]}</div><div class="v">${stat[1]}</div><div class="s">${stat[2]}</div></div>`).join("")}
    </section>
    ${sourceMix(totals.sourceMix, totals.visits)}
    ${data.anomalies.length ? `<aside class="signals" aria-label="Notable changes"><span class="signal-label">Notable</span>${data.anomalies.map((item) => `<span class="signal ${item.type}">${esc(anomalyText(item))} vs ${esc(previousLabel)}</span>`).join("")}</aside>` : ""}
    <div class="grid">${data.sites.map((site, index) => siteCard(site, index, data.periodDays)).join("")}</div>
  </main>
  <footer>
    <div><b>Sessions</b> are Cloudflare Web Analytics visits; pageviews and referrers use the selected traffic period. Direct traffic is shown separately so smaller external sources remain readable.</div>
    <div><b>Search performance, queries, and landing pages</b> use the latest complete Google Search Console window. Summary totals come from an aggregate query rather than the ranked rows; opportunity rows have impressions, average position 4–20, and CTR below 4%.</div>
    <div>Data pulled ${esc(formatTimestamp(updatedAt))} · ${data.run?.ok ? "last run OK" : "see run log"} · rendered ${esc(formatTimestamp(data.generatedAt))} · sources: Cloudflare GraphQL Analytics and Google Search Console.</div>
  </footer>
</div>
<script>
(function () {
  var root = document.documentElement;
  var button = document.getElementById("theme-toggle");
  var themeColorMeta = document.getElementById("theme-color-meta");
  try { var saved = localStorage.getItem("stats-theme"); if (saved) root.dataset.theme = saved; } catch (_) {}
  var activeTheme = function () { return root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); };
  var updateThemeButton = function () {
    var target = activeTheme() === "dark" ? "light" : "dark";
    button.textContent = target === "light" ? "☀ Light theme" : "☾ Dark theme";
    button.setAttribute("aria-label", "Use " + target + " color theme");
    themeColorMeta.setAttribute("content", activeTheme() === "dark" ? "#0e131a" : "#f5f7fa");
  };
  button.addEventListener("click", function () {
    var current = activeTheme();
    var next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("stats-theme", next); } catch (_) {}
    updateThemeButton();
  });
  updateThemeButton();
  document.querySelectorAll("select[data-query]").forEach(function (select) {
    select.addEventListener("change", function () {
      var url = new URL(location.href);
      if (select.value) url.searchParams.set(select.dataset.query, select.value); else url.searchParams.delete(select.dataset.query);
      location.assign(url.toString());
    });
  });
  document.querySelectorAll("details.detail").forEach(function (detail) {
    if (matchMedia("(max-width: 560px)").matches) detail.removeAttribute("open");
    var action = detail.querySelector(".summary-action");
    var update = function () { action.textContent = detail.open ? "Hide details" : "Show details"; };
    detail.addEventListener("toggle", update);
    update();
  });
})();
</script>
</body></html>`;
}
