// Renders the dashboard HTML from data read out of D1.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n).toLocaleString("en-US");

const TAG_LABEL = { search: "search", direct: "direct", social: "social", ref: "referral" };

function sparkline(points) {
  const vals = points.map((p) => p.visits);
  if (vals.length < 2) return "";
  const w = 108, h = 30, pad = 2;
  const max = Math.max(...vals, 1), min = Math.min(...vals);
  const span = max - min || 1;
  const step = (w - pad * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(",");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${pts.join(" ")}" fill="none" stroke="var(--traffic)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="var(--traffic)"/>
  </svg>`;
}

function siteCard(s) {
  if (!s.visits && !s.keywords.length) {
    return `<div class="card empty">
      <div class="chead"><div class="host">${esc(s.host)}</div>
        <div class="nums"><div class="big">—</div><div class="lbl">no data</div></div></div>
      <div class="none">No Web Analytics traffic or Search Console data in this window.</div>
    </div>`;
  }
  const max = Math.max(1, ...s.referrers.map((r) => r.visits));
  const refs = s.referrers.length ? s.referrers.map((r) => {
    const width = Math.max(6, Math.round((r.visits / max) * 100));
    const name = r.referrer === "(direct)" ? "Direct / none" : r.referrer;
    return `<li class="ref"><div class="bar" style="width:${width}%"></div>
      <div class="row"><span class="name">${esc(name)}<span class="tag ${r.kind}">${TAG_LABEL[r.kind]}</span></span><span class="n">${fmt(r.visits)}</span></div></li>`;
  }).join("") : `<li class="none">No external referrers.</li>`;
  const kws = s.keywords.length ? s.keywords.map((k) =>
    `<div class="kw"><span class="q">${esc(k.query)}</span><span class="c ${k.clicks === 0 ? "zero" : ""}">${k.clicks === 0 ? "0 clk" : k.clicks + " clk"}</span></div>`
  ).join("") : `<div class="none">No search clicks in window.</div>`;
  return `<div class="card">
    <div class="chead">
      <div class="hostwrap">
        <div class="host"><a href="https://${esc(s.host)}" target="_blank" rel="noopener">${esc(s.host)}</a></div>
        ${sparkline(s.spark)}
      </div>
      <div class="nums"><div class="big">${fmt(s.visits)}</div><div class="lbl">visitors 24h</div><div class="pv">${fmt(s.views)} views</div></div>
    </div>
    <div class="cols">
      <div><div class="colhead"><span class="dot t"></span>Top referrers</div><ul>${refs}</ul></div>
      <div><div class="colhead"><span class="dot s"></span>Top keywords</div>${kws}</div>
    </div>
  </div>`;
}

export function renderDashboard(d) {
  const t = d.totals;
  const stats = [
    ["Total visitors", fmt(t.visits), `across ${t.active} active domains`],
    ["Total pageviews", fmt(t.views), t.visits ? `${(t.views / t.visits).toFixed(1)} pages / visit` : "—"],
    ["From search engines", fmt(t.search), "Google · Bing · DDG · Brave"],
    ["Domains tracked", t.domains, `${t.active} with traffic today`],
  ];
  const dateLabel = d.date
    ? new Date(d.date + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "—";
  const kwWindow = d.sites.find((s) => s.gscWindow)?.gscWindow || "latest available";

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Traffic &amp; Search — Daily Brief</title>
<style>
:root{--paper:#f6f7f9;--card:#fff;--ink:#141922;--muted:#5b6472;--faint:#8892a0;--line:#e5e8ee;--traffic:#2f6fb0;--traffic-soft:#dbe7f3;--search:#b7791f;--search-soft:#f3e9d6;--direct:#64748b;--social:#7c5cbf;--good:#3f8f5f;--shadow:0 1px 2px rgba(20,25,34,.04),0 4px 16px rgba(20,25,34,.05);--radius:12px}
@media (prefers-color-scheme:dark){:root{--paper:#0f1319;--card:#171d26;--ink:#e8ecf2;--muted:#97a1b0;--faint:#6b7686;--line:#262e3a;--traffic:#6aa6dc;--traffic-soft:#21354a;--search:#d6a44e;--search-soft:#3a2f1a;--direct:#8592a4;--social:#a78bdb;--good:#5fb381;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.35)}}
:root[data-theme=dark]{--paper:#0f1319;--card:#171d26;--ink:#e8ecf2;--muted:#97a1b0;--faint:#6b7686;--line:#262e3a;--traffic:#6aa6dc;--traffic-soft:#21354a;--search:#d6a44e;--search-soft:#3a2f1a;--direct:#8592a4;--social:#a78bdb;--good:#5fb381;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.35)}
:root[data-theme=light]{--paper:#f6f7f9;--card:#fff;--ink:#141922;--muted:#5b6472;--faint:#8892a0;--line:#e5e8ee;--traffic:#2f6fb0;--traffic-soft:#dbe7f3;--search:#b7791f;--search-soft:#f3e9d6;--direct:#64748b;--social:#7c5cbf;--good:#3f8f5f;--shadow:0 1px 2px rgba(20,25,34,.04),0 4px 16px rgba(20,25,34,.05)}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;line-height:1.45;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.wrap{max-width:1120px;margin:0 auto;padding:32px 24px 64px}
header.top{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 24px;padding-bottom:20px;border-bottom:1px solid var(--line)}
.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:600;color:var(--faint)}
h1{font-size:26px;margin:4px 0 0;letter-spacing:-.01em;text-wrap:balance}
.win{font-size:13px;color:var(--muted);text-align:right}
.win b{color:var(--ink);font-weight:600}
.totals{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0 30px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow)}
.stat .k{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);font-weight:600}
.stat .v{font-size:30px;font-weight:650;letter-spacing:-.02em;margin-top:4px}
.stat .s{font-size:12px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px 20px 20px;display:flex;flex-direction:column;gap:14px}
.card.empty{opacity:.62}
.chead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.hostwrap{display:flex;flex-direction:column;gap:6px;min-width:0}
.host{font-size:15px;font-weight:650;letter-spacing:-.01em;word-break:break-word}
.host a{color:inherit;text-decoration:none}.host a:hover{text-decoration:underline}
.spark{display:block}
.nums{text-align:right;white-space:nowrap}
.nums .big{font-size:24px;font-weight:650;letter-spacing:-.02em}
.nums .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--faint)}
.nums .pv{font-size:12px;color:var(--muted);margin-top:2px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.colhead{font-size:10px;text-transform:uppercase;letter-spacing:.1em;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}.dot.t{background:var(--traffic)}.dot.s{background:var(--search)}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.ref{position:relative}
.ref .bar{position:absolute;inset:0;background:var(--traffic-soft);border-radius:5px;z-index:0}
.ref .row{position:relative;z-index:1;display:flex;justify-content:space-between;gap:8px;padding:4px 8px;font-size:12.5px}
.ref .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ref .n{font-weight:600;color:var(--muted)}
.tag{font-size:9px;text-transform:uppercase;letter-spacing:.06em;padding:1px 5px;border-radius:4px;font-weight:600;margin-left:5px}
.tag.search{background:var(--search-soft);color:var(--search)}
.tag.direct{background:color-mix(in srgb,var(--direct) 16%,transparent);color:var(--direct)}
.tag.social{background:color-mix(in srgb,var(--social) 18%,transparent);color:var(--social)}
.tag.ref{background:color-mix(in srgb,var(--good) 16%,transparent);color:var(--good)}
.kw{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;padding:3px 0;border-bottom:1px dashed var(--line)}
.kw:last-child{border-bottom:0}
.kw .q{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kw .c{font-weight:650;color:var(--search);white-space:nowrap}
.kw .c.zero{color:var(--faint);font-weight:500}
.none{font-size:12px;color:var(--faint);font-style:italic;padding:4px 0}
footer{margin-top:34px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);display:flex;flex-direction:column;gap:6px}
footer b{color:var(--ink);font-weight:600}
@media (max-width:900px) and (min-width:561px){.grid{grid-template-columns:1fr}}
@media (max-width:560px){.cols{grid-template-columns:1fr}.totals{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap">
  <header class="top">
    <div>
      <div class="eyebrow">Daily traffic &amp; search brief</div>
      <h1>All domains — one glance</h1>
    </div>
    <div class="win">
      Traffic: <b>last 24 h</b> · ${esc(dateLabel)}<br>
      Search: <b>${esc(kwWindow)}</b> (GSC ~2-day lag)
    </div>
  </header>
  <div class="totals">
    ${stats.map((s) => `<div class="stat"><div class="k">${s[0]}</div><div class="v">${s[1]}</div><div class="s">${s[2]}</div></div>`).join("")}
  </div>
  <div class="grid">
    ${d.sites.map(siteCard).join("")}
  </div>
  <footer>
    <div><b>Visitors</b> = Cloudflare Web Analytics sessions; <b>pageviews</b> beneath. Referrers ranked by sessions over the last 24 h. Sparkline = daily visitors, last 14 days.</div>
    <div><b>Keywords</b> from Google Search Console, ranked by clicks. GSC lags ~2 days, so this is the freshest full window — not literally the last 24 h.</div>
    <div>Updated ${esc(d.generatedAt)} · ${d.run?.ok ? "last run OK" : "see run log"} · sources: Cloudflare GraphQL Analytics · Google Search Console.</div>
  </footer>
</div>
<script>
// Respect a manual theme toggle if one is ever added; harmless otherwise.
</script>
</body></html>`;
}
