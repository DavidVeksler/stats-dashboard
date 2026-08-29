// Renders the dashboard HTML from data read out of D1.
import { APPLE_SPLASH_LINKS } from "./appleSplashLinks.js";
import { FLOOD_MIN_VISITS, FLOOD_MULTIPLE, FLAT_PAGES_PER_SESSION, DIRECT_SHARE, RATIO_MIN_CLEAN_DAYS } from "./bots.js";
import {
  classifyOpportunity, OPPORTUNITY_MIN_IMPRESSIONS, POSITION_MIN_IMPRESSIONS,
  SNIPPET_MAX_POSITION, RANK_MAX_POSITION, SNIPPET_CTR_RATIO, MIN_ACTIONABLE_CLICKS,
  TARGET_POSITION,
} from "./opportunities.js";
import { DELTA_MIN_ABSOLUTE, ERROR_BASELINE_DAYS, cardAnchor } from "./signals.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const pct = (n, digits = 0) => `${(Number(n || 0) * 100).toFixed(digits)}%`;
const TAG_LABEL = { search: "search", direct: "direct", social: "social", ref: "referral",
  internal: "internal", ai: "AI" };

// Below this share of corpus impressions, the stored-top-query CTR comparator is
// labelled a thin sample inline. It is not a threshold anything fires on — the
// comparator always renders and always states its coverage; this only adds the
// words when the sample is too small to argue with.
const THIN_SAMPLE_SHARE = 0.25;

// A muted comparator chip that sits beside a KPI value. Every tile gets one:
// a number nobody can judge is decoration, and "is this normal?" is the first of
// the three questions this page is supposed to answer.
const cmp = (text, title = null) =>
  `<span class="cmp"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;

// "N per day over the last 14 days", plus this period's own per-day rate when the
// period is longer than a day and the two are not the same quantity.
function meanNote(value, mean, days, periodDays, unit = "") {
  if (!mean) return "";
  const suffix = unit ? ` ${unit}` : "";
  const perDay = periodDays > 1 && days > 0 ? Number(value || 0) / days : null;
  const head = perDay === null ? "" : `${fmt(Math.round(perDay))}${suffix}/day here · `;
  return cmp(`${head}14-day mean ${fmt(Math.round(mean))}${suffix}/day`,
    "Mean over the last 14 daily snapshots, computed from the same human/crawler split the cards use.");
}

// `absolute` is the session change behind the ratio. Below DELTA_MIN_ABSOLUTE the
// percentage is suppressed and the raw change is shown muted instead: a
// percentage on a single-digit base is noise dressed as signal, and rendering
// "whopaysforai.org ↑ 600%" (6 sessions to 7) in the same green pill as a real
// move is what taught the eye to ignore the pill. Same floor the session-delta
// signals use, imported rather than restated.
function deltaBadge(value, compact = false, absolute = null) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return `<span class="delta neutral">no comparison</span>`;
  }
  const arrow = value > 0 ? "↑" : value < 0 ? "↓" : "→";
  if (absolute !== null && Number.isFinite(absolute) && Math.abs(absolute) < DELTA_MIN_ABSOLUTE) {
    const sign = absolute > 0 ? "+" : absolute < 0 ? "−" : "±";
    const label = `${sign}${fmt(Math.abs(absolute))}${compact ? "" : " vs previous"}`;
    return `<span class="delta small" title="${arrow} ${Math.abs(value * 100).toFixed(0)}% on a base too small for a percentage to mean anything (under ${fmt(DELTA_MIN_ABSOLUTE)} sessions of change)">${label}</span>`;
  }
  const direction = value > 0 ? "up" : value < 0 ? "down" : "neutral";
  const label = `${arrow} ${Math.abs(value * 100).toFixed(0)}%${compact ? "" : " vs previous"}`;
  return `<span class="delta ${direction}">${label}</span>`;
}

// Top severity-1/2 signals, above the KPI tiles. The capstone of the signal
// engine: headline, one line of evidence, one imperative action, one link.
// Never an empty container — silence on this block would be indistinguishable
// from the block failing to render.
function actionsBlock(signals) {
  const top = (signals ?? []).filter((signal) => signal.severity <= 2).slice(0, 3);
  const body = top.length
    ? `<ol class="action-list">${top.map((signal) => `<li class="action sev${signal.severity}">
        <div class="action-head"><span class="sev-tag">${signal.severity === 1 ? "Act today" : "Look at it"}</span>
          <b>${esc(signal.headline)}</b>${signal.recurrence && signal.recurrence > 1
            ? `<span class="sev-run">${signal.recurrence} days running</span>` : ""}</div>
        <div class="action-why">${esc(signal.evidence)}</div>
        <div class="action-do">${esc(signal.action)} <a href="${esc(signal.href)}">Open ${esc(signal.host)} &rarr;</a></div>
      </li>`).join("")}</ol>`
    : `<p class="action-none">Nothing needs attention today.</p>`;
  return `<section class="actions" aria-labelledby="actions-heading">
    <h2 class="section-heading" id="actions-heading"><span class="dot danger" aria-hidden="true"></span>Today's actions</h2>
    ${body}
  </section>`;
}

function sparkline(points, host, unit = "sessions") {
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
  const floodCount = points.filter((point) => point.flood).length;
  // The line plots every measured day, crawler floods included — a flood is a
  // real event worth seeing — but the flooded points are marked so the spike
  // never reads as an audience the site does not have.
  const label = `${points.length}-day ${unit} for ${host}: ${vals.join(", ")}; latest ${vals.at(-1)}` +
    (floodCount ? `; ${floodCount} day${floodCount === 1 ? "" : "s"} crawler-flooded` : "");
  const pointsWithTitles = coords.map(({ x, y }, index) =>
    `<circle class="spark-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4">
      <title>${esc(points[index].date)}: ${fmt(vals[index])} ${unit}${points[index].flood ? " — crawler flood, direct traffic excluded" : ""}</title>
    </circle>`).join("");
  const floodMarks = coords.map(({ x, y }, index) => points[index].flood
    ? `<circle class="spark-flood" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4"/>` : "").join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--traffic)" stop-opacity=".22"/><stop offset="1" stop-color="var(--traffic)" stop-opacity="0"/></linearGradient></defs>
    <polygon points="${area}" fill="url(#${id})"/>
    <polyline points="${line}" fill="none" stroke="var(--traffic)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${pointsWithTitles}
    <circle cx="${coords.at(-1).x.toFixed(1)}" cy="${coords.at(-1).y.toFixed(1)}" r="2.7" fill="var(--traffic)"/>
    ${floodMarks}
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

// Two classes, never one bare "opportunity" badge: a query that ranks and is not
// clicked needs a rewritten snippet, a query that ranks too deep to be seen needs
// content and links, and a badge that does not say which is a badge the reader
// cannot act on. Same classifier that produced totals.snippetOpportunities /
// totals.rankOpportunities — see src/opportunities.js — including the site's
// queryDenyPatterns, so a denied query still renders here but carries no badge.
const OPPORTUNITY_LABEL = { snippet: "snippet", rank: "rank" };
function keywordList(site) {
  const keywords = site.keywords ?? [];
  if (!keywords.length) return `<p class="none">No search queries in the latest GSC window.</p>`;
  return `<ol class="metric-list">${keywords.map((keyword) => {
    const ctr = keyword.impressions ? keyword.clicks / keyword.impressions : 0;
    const found = classifyOpportunity(keyword, site);
    const why = !found ? ""
      : found.kind === "snippet"
        ? `Ranks at ${found.position.toFixed(1)} with ${pct(found.ctr, 1)} CTR against roughly ${pct(found.expectedCtr, 1)} expected there: about ${found.lostClicks.toFixed(1)} clicks a window lost to the snippet, not to the ranking. Rewrite the title and meta description.`
        : `Ranks at ${found.position.toFixed(1)}, too deep to be seen. Roughly ${found.potentialClicks.toFixed(1)} clicks a window are out of reach at that rank. Strengthen the page and link to it.`;
    return `<li class="metric-row ${found ? "flagged" : ""}">
      <div class="metric-name"><span class="truncate" title="${esc(keyword.query)}">${esc(keyword.query)}</span>${found ? `<span class="opportunity-tag ${esc(found.kind)}" title="${esc(why)}">${OPPORTUNITY_LABEL[found.kind]}</span>` : ""}</div>
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

function cfPageList(pages, host) {
  if (!pages.length) return `<p class="none">No landing pages in this period.</p>`;
  return `<ol class="metric-list pages-list">${pages.map((page) => {
    const href = `https://${host}${page.page}`;
    return `<li class="metric-row">
      <div class="metric-name"><a class="truncate" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(page.page)}">${esc(page.page)}</a></div>
      <div class="metric-values"><strong>${fmt(page.visits)} ent</strong><span>${fmt(page.views)} views</span></div>
    </li>`;
  }).join("")}</ol>`;
}

// Top downloaded files for a zone-sourced host. cfPages rows carry "requests"
// in `visits` and "sessions" in `views` for these hosts (see index.js).
function fileList(pages, host) {
  if (!pages.length) return `<p class="none">No files served in this period.</p>`;
  return `<ol class="metric-list pages-list">${pages.map((page) => {
    const href = `https://${host}${page.page}`;
    return `<li class="metric-row">
      <div class="metric-name"><a class="truncate" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(page.page)}">${esc(page.page)}</a></div>
      <div class="metric-values"><strong>${fmt(page.visits)} reqs</strong><span>${fmt(page.views)} sessions</span></div>
    </li>`;
  }).join("")}</ol>`;
}

function countryList(countries) {
  if (!countries.length) return `<p class="none">No country data in this period.</p>`;
  const total = countries.reduce((sum, c) => sum + Number(c.visits || 0), 0);
  const max = Math.max(1, ...countries.map((c) => Number(c.visits || 0)));
  const rows = countries.map((c) => {
    const width = Math.max(7, Math.round((Number(c.visits || 0) / max) * 100));
    const share = total ? Number(c.visits || 0) / total : 0;
    return `<li class="ref" title="${esc(c.country)}: ${fmt(c.visits)} visits (${pct(share, 1)})">
      <div class="bar" style="width:${width}%"></div>
      <div class="row"><span class="name">${esc(c.country)}</span><span class="n">${fmt(c.visits)}</span></div>
    </li>`;
  }).join("");
  return `<ol class="ref-list">${rows}</ol>`;
}

function statusList(statuses) {
  if (!statuses.length) return `<p class="none">No status data in this period.</p>`;
  const total = statuses.reduce((sum, s) => sum + Number(s.requests || 0), 0);
  return `<ol class="metric-list">${statuses.map((s) => {
    const share = total ? Number(s.requests || 0) / total : 0;
    const bad = Number(s.status) >= 400;
    return `<li class="metric-row ${bad ? "flagged" : ""}">
      <div class="metric-name"><span class="truncate">${esc(s.status)}</span></div>
      <div class="metric-values"><strong>${fmt(s.requests)}</strong><span>${pct(share, 1)} of requests</span></div>
    </li>`;
  }).join("")}</ol>`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];
function bytesLabel(n) {
  n = Number(n || 0);
  let i = 0;
  while (n >= 1024 && i < BYTE_UNITS.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
}

// Named by a heading above the block (same dot+label pattern the "Top
// referrers"/"Search opportunities" panels use below), not by prefixing every
// cell's own label: "Google clicks"/"Google impressions"/etc. was tried first
// and overflowed its column in the 4-up grid ("GOOGLE IMPRESSIONS" collided
// with "GOOGLE CTR" next to it) — `.search-summary span` is `white-space:
// nowrap` (so a stat like "1,900" never wraps off its own label), and a
// per-cell "Google " prefix pushed several labels past that width. One heading
// says which engine for the whole block instead.
function searchSummary(summary) {
  if (!summary) return "";
  return `<h3 class="mini-h3"><span class="dot search"></span>Google Search</h3>
  <div class="search-summary" aria-label="Google Search performance">
    <div><strong>${fmt(summary.clicks)}</strong><span>clicks</span></div>
    <div><strong>${fmt(summary.impressions)}</strong><span>impressions</span></div>
    <div><strong>${pct(summary.ctr, 1)}</strong><span>CTR</span></div>
    <div><strong>${summary.position ? Number(summary.position).toFixed(1) : "—"}</strong><span>avg position</span></div>
  </div>`;
}

// Bing's site-wide summary (GetRankAndTrafficStats) has no position field at
// all — only the per-query rows do, with two of them (see bingKeywordList) —
// so this tile is three numbers, not four, rather than padding in a figure
// Bing never reported. Never merged with searchSummary above: a different
// search engine's audience, not a second measurement of the same one. Same
// heading-names-the-block pattern as searchSummary now, so the per-cell "Bing "
// prefix is dropped too — the heading already says which engine, and repeating
// it on every cell was the more cramped of the two ways to say the same thing
// once searchSummary switched. The block no longer states its pull date
// underneath either: that "Bing Webmaster Tools · 2026-08-25" caption was the
// only one of the two panels naming a date, which read as a mismatch rather
// than useful information — the heading is enough.
function bingSummary(site) {
  const summary = site.bingSummary;
  if (!summary) return "";
  return `<h3 class="mini-h3"><span class="dot bing"></span>Bing Search</h3>
  <div class="search-summary bing" aria-label="Bing Search performance">
    <div><strong>${fmt(summary.clicks)}</strong><span>clicks</span></div>
    <div><strong>${fmt(summary.impressions)}</strong><span>impressions</span></div>
    <div><strong>${pct(summary.ctr, 1)}</strong><span>CTR</span></div>
  </div>`;
}

// Bing's own per-query rows, shown as reported rather than averaged into one
// number: with far fewer stored rows than GSC's top 500, and Bing reporting two
// distinct positions (where clicks landed vs. where every impression landed),
// collapsing either into a single figure here would manufacture a precision
// the sample doesn't support. No opportunity classification, unlike
// keywordList above — that classifier is tuned against GSC's expectedCtr curve
// (see opportunities.js), which has no Bing equivalent.
//
// A live pull against cheatsheets.davidveksler.com on 2026-08-27 came back with
// AvgClickPosition: -1 on every single query row, including rows with real
// clicks (e.g. 4 clicks, -1 position) — Bing's own sentinel for "not reported",
// not a real rank. Rendered as "—", never as a literal -1.0, which would read
// as broken data rather than absent data. AvgImpressionPosition was populated
// normally in that same pull, so only click position gets this guard.
const bingPos = (n) => (Number(n) >= 0 ? Number(n).toFixed(1) : "—");
function bingKeywordList(keywords) {
  if (!keywords?.length) return `<p class="none">No Bing search queries in the latest window.</p>`;
  return `<ol class="metric-list">${keywords.map((keyword) => {
    const ctr = keyword.impressions ? keyword.clicks / keyword.impressions : 0;
    return `<li class="metric-row">
      <div class="metric-name"><span class="truncate" title="${esc(keyword.query)}">${esc(keyword.query)}</span></div>
      <div class="metric-values"><strong>${fmt(keyword.clicks)} clk</strong><span>${fmt(keyword.impressions)} imp · ${pct(ctr, 1)} CTR · click pos ${bingPos(keyword.avgClickPosition)} · imp pos ${bingPos(keyword.avgImpressionPosition)}</span></div>
    </li>`;
  }).join("")}</ol>`;
}

// The channel mix, and the one thing it must not do: present its own accounting
// hole as a channel. "Other / unlisted" used to be the largest bucket on the page
// (1,060 of 2,012 sessions, 52.7%) and it was never a class at all — it was
// `visits - (direct + search + social + referral)`, with a zone-log host
// contributing almost all of it because zone logs carry no referer dimension.
// Item 1 took the zone hosts out; what is left here is the labelling. The
// residual is named `Unattributed`, moved out of the bar, and given its causes.
//
// `internal` — sessions arriving from one of the site's own hostnames — is a real
// channel and used to land in that residual. It is frozen into daily_referrers at
// write time, so rows stored before 2026-08-13 carry none: `internalMeasured`
// says whether any row in the window has it, and when none does the channel is
// omitted rather than drawn as a confident zero. That matters in the 7- and
// 30-day views, which still reach back over rows written before the change.
function sourceMix(totals) {
  const total = Number(totals?.visits || 0);
  const mix = totals?.sourceMix ?? {};
  if (!total) return "";
  const channels = [
    ["direct", "Direct"], ["search", "Search"], ["social", "Social"], ["referral", "Referral"],
    ...(totals.internalMeasured ? [["internal", "Internal"]] : []),
  ].map(([key, label]) => ({ key, label, value: Number(mix[key] || 0) }));
  const segments = channels.filter((channel) => channel.value > 0).map((channel) =>
    `<span class="source-segment ${channel.key}" style="width:${Math.max(0, channel.value / total * 100).toFixed(2)}%" title="${esc(channel.label)}: ${fmt(channel.value)} sessions (${pct(channel.value / total, 1)})"></span>`).join("");
  const unattributed = Number(mix.unattributed || 0);
  const note = unattributed
    ? `<p class="source-note"><b>Unattributed: ${fmt(unattributed)} sessions (${pct(unattributed / total, 1)})</b> —
        not a channel and not in the bar above. It is the gap between sessions the traffic table counted and
        referrer rows the referrer table stored, and its known causes are: only the top 50 referrers per
        host-day are persisted, so a long tail of one-session referrers falls off${totals.internalMeasured
          ? "" : "; and sessions from a site's own alias hostnames were dropped rather than stored as an <i>internal</i> referral on days before that channel existed"}.</p>`
    : `<p class="source-note">Every measured session in this period is attributed to a channel.</p>`;
  return `<section class="source-overview" aria-labelledby="source-heading">
    <div class="source-heading"><h2 id="source-heading"><span class="dot traffic" aria-hidden="true"></span>Traffic sources (RUM sites only)</h2><span>selected traffic period</span></div>
    <div class="source-bar" role="img" aria-label="Traffic source mix">${segments}</div>
    <div class="source-legend">${channels.map((channel) => `<div><i class="${channel.key}"></i><span>${esc(channel.label)}</span><strong>${fmt(channel.value)}</strong><small>${pct(channel.value / total, 1)}</small></div>`).join("")}</div>
    ${note}
  </section>`;
}

// Zone-sourced hosts are measured by Cloudflare's zone HTTP request log, not by
// the RUM beacon, so their numbers are request counts. They get this strip rather
// than a KPI tile: summing them into the headline is what turned pages/session
// into 10.4 (20,897 "pageviews" of which 19,506 were library HTTP requests)
// against a true RUM figure of 1.46 on 2026-08-13.
function zoneStrip(sites) {
  const zoneSites = sites.filter((site) => site.zoneSourced);
  if (!zoneSites.length) return "";
  const rows = zoneSites.map((site) =>
    `<li><b>${esc(site.host)}</b> — ${fmt(site.views)} requests · ${fmt(site.visits)} zone visits · ${bytesLabel(site.bytes)}</li>`
  ).join("");
  return `<aside class="zone-strip" role="note" aria-label="Zone-log sites">
    <div class="zone-strip-label">Zone-log sites <span>request counts, not comparable to RUM sessions</span></div>
    <ul>${rows}</ul>
  </aside>`;
}

// Crawler accounting for a zone-sourced host. The RUM flood classifier cannot
// fire on these hosts at all, so instead of one verdict they get two independent
// lenses — and the one thing this panel must never do is turn either of them into
// a human count. It does not subtract, does not interpolate, and says outright
// which part of the day it cannot characterize.
function zoneCrawlerPanel(site) {
  const bots = site.zoneBots;
  const nonContent = site.zoneNonContent;
  if (!bots && !nonContent) return "";

  const verified = bots?.measured && bots.verifiedRequests
    ? `<p><b>&ge;&nbsp;${fmt(bots.verifiedRequests)} requests</b> · <b>&ge;&nbsp;${fmt(bots.verifiedVisits)} zone visits</b>
        — ${pct(bots.verifiedShare, 1)} of requests, from crawlers Cloudflare cryptographically verifies.</p>
      <ul class="cats">${bots.categories.map((row) =>
        `<li>${esc(row.category)} <b>${fmt(row.requests)}</b> req · ${fmt(row.visits)} vis</li>`).join("")}</ul>
      <p>Unverified crawlers are <b>not included and cannot be measured on this plan</b>: bot scores are
        not exposed for this zone, so the remaining ${fmt(bots.unverifiedRequests)} requests
        (${pct(1 - bots.verifiedShare, 1)}) are readers and unverified or spoofing crawlers mixed together.
        Read the figure above as a floor on crawler volume, never a total and never a bot/human split.</p>`
    : bots?.measured
      ? `<p>No verified crawlers were labelled on this day. That is not evidence of none: only
          cryptographically verified bots carry a category, and this zone's plan does not expose bot
          scores for the rest.</p>`
      : `<p class="none">Verified-crawler figures appear after the next daily pull.</p>`;

  const nonContentBlock = nonContent
    ? `<p>Crawler-protocol and asset paths (robots.txt, favicon.ico, sitemap*, /.well-known/*, /cdn-cgi/*):
        <b>${fmt(nonContent.pathRequests)} requests</b>${nonContent.paths.length
          ? ` — ${nonContent.paths.slice(0, 5).map((row) => `${esc(row.page)} ${fmt(row.requests)}`).join(" · ")}` : ""}.<br>
        Error responses (status &ge; 400): <b>${fmt(nonContent.errorRequests)} requests</b>${nonContent.errorStatuses.length
          ? ` — ${nonContent.errorStatuses.slice(0, 5).map((row) => `${esc(row.status)} ${fmt(row.requests)}`).join(" · ")}` : ""}.</p>`
    : "";

  return `<div class="zone-bots" role="note">
    <h3>Verified crawlers (a floor)</h3>
    ${verified}
    <h3>Non-content requests (a separate lens)</h3>
    ${nonContentBlock}
    <p><b>The two lenses overlap and must not be added.</b> A verified crawler fetches robots.txt too, and
      an error response can come from either, so there is no combined crawler total here — and none should
      be computed. This card reports no human count for ${esc(site.host)}: what is left over after the
      verified floor cannot be characterized, and nothing is estimated to fill it in.</p>
  </div>`;
}

// Today's actions plus the two "aside" banners (zone-log sites, crawler
// exclusion) grouped into one collapsible panel. They used to sit on either
// side of the KPI tiles — actions above, asides below — so getting to "what
// are the numbers today" meant scrolling past three unrelated blocks first.
// Collapsing this one panel now gets straight to the KPI tiles beneath it.
function insightsPanel(signals, totals, sites) {
  const top = (signals ?? []).filter((signal) => signal.severity <= 2).slice(0, 3);
  const labelParts = [top.length ? `${top.length} action${top.length === 1 ? "" : "s"}` : "no actions today"];
  if (totals.botVisits) labelParts.push("crawler note");
  if (sites.some((site) => site.zoneSourced)) labelParts.push("zone-log sites");
  return `<details class="insights" open>
    <summary><span class="insights-label">Today's actions &amp; notes<span class="insights-count">${esc(labelParts.join(" · "))}</span></span><span class="summary-action">Hide details</span></summary>
    <div class="insights-body">
      ${actionsBlock(signals)}
      ${zoneStrip(sites)}
      ${crawlerNote(totals, sites)}
    </div>
  </details>`;
}

// Crawlers are welcome here (the sites opt into AI training) — they just are not
// an audience. This banner keeps the excluded volume visible and named, so the
// headline drop from "13,870 sessions" to a few hundred is explained, not silent.
function crawlerNote(totals, sites) {
  if (!totals.botVisits) return "";
  const named = sites.filter((site) => site.botVisits > 0)
    .sort((a, b) => b.botVisits - a.botVisits)
    .map((site) => `${esc(site.host)} (${fmt(site.botVisits)})`)
    .join(", ");
  const days = totals.floodedSiteDays;
  const measuredReferred = totals.partialVisits - (totals.estimatedDirect || 0);
  const estimateNote = totals.estimatedSites
    ? ` For ${totals.estimatedSites} site${totals.estimatedSites === 1 ? "" : "s"} with enough clean-day history,
      that direct bucket also gets a ratio estimate (that site's own typical direct/referred split) —
      ${fmt(totals.estimatedDirect)} more sessions, with its own margin, shown as "~"; everywhere else it
      stays a hard floor, shown as "&ge;".`
    : "";
  return `<aside class="crawler" role="note">
    <strong>${fmt(totals.botVisits)} crawler sessions excluded</strong> — ${pct(totals.botShare, 0)} of everything measured
    in this period, across ${days} flooded site-day${days === 1 ? "" : "s"}: ${named}.
    Nothing is blocked. On those days only the direct bucket is unusable — a crawler arrives without a
    referer, so referred sessions still count${measuredReferred
      ? ` (${fmt(measuredReferred)} of them here)` : ""}.${estimateNote}
  </aside>`;
}

// What the headline number actually covers once a flood is in the window. A
// flooded day is no longer a hole: its referred sessions still count, so the
// number is a floor. Say which parts came from where, and say plainly when the
// referred sessions are all there is.
function crawlerRowDetail(site) {
  const clean = site.cleanDays
    ? `Human figures above cover the ${site.cleanDays} clean day${site.cleanDays === 1 ? "" : "s"}` : "";
  if (!site.partialDays) return clean ? `${clean}.` : "";
  if (!site.partialVisits) {
    return clean
      ? `${clean}; the flooded day${site.botDays === 1 ? "" : "s"} produced no referred sessions at all.`
      : `No referred sessions were measured on those days, so there is no human figure to report.`;
  }
  // partialVisits is the reported total for those days — a bare floor, or, once
  // estimated, referred (measured) plus the estimated direct share. Keep the two
  // apart here so "referred sessions" only ever describes the measured part.
  const measuredReferred = site.partialVisits - (site.estimatedDirect || 0);
  const recovered = `${fmt(measuredReferred)} referred session${measuredReferred === 1 ? "" : "s"} ` +
    `that survived the flooded day${site.botDays === 1 ? "" : "s"}`;
  // Two honest framings for the direct bucket: a bare floor (referred sessions
  // only, direct traffic set aside as unseparable), or — when this host has
  // enough clean-day history — a ratio estimate of it (see directRatioStats in
  // bots.js), always stated with its margin so it never reads as a hard count.
  const why = site.estimatedVisits
    ? `A crawler arrives without a referer, so a referral is still a person. Its direct bucket on those ` +
      `days adds an estimated ${fmt(site.estimatedDirect)} more, from this site's own direct/referred ` +
      `ratio over ${site.ratioSampleDays} clean days, so the total above is "~" a figure` +
      `${site.spread ? `, plus or minus about ${fmt(site.spread)}` : ""} — an estimate, not a count.`
    : `A crawler arrives without a referer, so a referral is still a person; the direct traffic ` +
      `on those days is not separable, which is why the total is a floor.`;
  return `${clean ? `${clean}, plus ${recovered}` : `The figure above is the ${recovered}`}. ${why}`;
}

// Consecutive-run grouping, never a re-sort: loadDashboard has already ordered
// the cards domain-first (see groupByDomain there), so this only draws a heading
// where the domain changes. Reading the order rather than re-deriving it means
// the page cannot disagree with /api/json about which domain outranks which.
// Falls back to the host when a row carries no `domain` (an /api/json payload
// captured before this shipped), which groups that card alone rather than
// throwing it into somebody else's domain.
function domainRuns(sites) {
  const runs = [];
  for (const site of sites) {
    const domain = site.domain || site.host;
    if (runs.at(-1)?.domain === domain) runs.at(-1).sites.push(site);
    else runs.push({ domain, sites: [site] });
  }
  return runs;
}

// One grid per domain, with a label naming the domain and its total in the unit
// of the class it belongs to — "sessions" for RUM, "zone visits" for zone hosts.
// The unit is spelled out on the heading because the total is the number the
// group's position in the page is ranked by, and a zone group's total is not the
// same quantity as a RUM group's.
// Sessions with any non-direct referrer (search + social + referral + internal).
// Not `visits - direct`, which would silently fold the unattributed residual in
// as though it were known to carry a referrer — see the "Unattributed is a
// residual" gotcha in AGENTS.md. Zero for zone-sourced hosts, which write no
// daily_referrers rows at all (see the RUM/zone measurement-class split).
const referredVisitsOf = (site) =>
  Number(site.sources?.search || 0) + Number(site.sources?.social || 0) +
  Number(site.sources?.referral || 0) + Number(site.sources?.internal || 0);

// One heading, three renderings of its trailing count — all/search/referred —
// toggled client-side (see the bottom-of-page script) by hiding all but one via
// the `hidden` attribute. Only the RUM ("sessions") unit gets search/referred
// variants: a zone group has no referrer dimension to break out (same reason
// zoneCrawlerPanel never claims a human count for a zone host).
//
// Each group is a native <details>, so collapsing it costs nothing extra: the
// heading — countLabel and total included — is the <summary> and so stays
// visible when closed, which is already "a single total sessions number" with
// no separate collapsed rendering to keep in sync. `data-domain-key` is
// `unit:domain` rather than the `id` above, because `id` is derived from the
// domain name alone and a domain with both a RUM host and a zone-log host
// would otherwise collide between the two sections; the bottom-of-page script
// persists open/closed state per key and the collapse-all toggle reads it too.
function domainGrids(sites, allSites, periodDays, unit) {
  const isRum = unit === "sessions";
  return domainRuns(sites).map((run) => {
    const id = `domain-${run.domain.replace(/[^a-z0-9]/gi, "-")}`;
    const key = `${unit}:${run.domain}`;
    const total = run.sites.reduce((sum, site) => sum + (site.visits || 0), 0);
    const countLabel = `${run.sites.length} site${run.sites.length === 1 ? "" : "s"}`;
    const channelSpans = isRum ? (() => {
      const totalSearch = run.sites.reduce((sum, site) => sum + Number(site.sources?.search || 0), 0);
      const totalReferred = run.sites.reduce((sum, site) => sum + referredVisitsOf(site), 0);
      // Same wording as numsBlocks/sessionsTile — "search-referred"/"non-direct",
      // never bare "search", so this never reads as a Search Console figure.
      return `<span class="tv-search" hidden>${countLabel} &middot; ${fmt(totalSearch)} search-referred sessions</span>
        <span class="tv-referred" hidden>${countLabel} &middot; ${fmt(totalReferred)} non-direct sessions</span>`;
    })() : "";
    return `<details class="domain-group" data-domain-group data-domain-key="${esc(key)}" open>
      <summary class="domain-heading" id="${id}">${esc(run.domain)}<span class="tv-all">${countLabel} &middot; ${fmt(total)} ${unit}</span>${channelSpans}</summary>
      <div class="grid">${run.sites.map((site) => siteCard(site, allSites.indexOf(site), periodDays)).join("")}</div>
    </details>`;
  }).join("");
}

// Three renderings of the card's headline number block, only one visible at a
// time (toggled client-side — see the bottom-of-page script and the
// "Bot-resistant view" select in the toolbar). "all" is the existing figure,
// unchanged. "search"/"referred" read straight off `site.sources`, which is
// already the crawler-clean quantity: a flooded day's direct bucket is set
// aside, but its referred/search rows survive (see splitDay/refRows in
// index.js), so these two views need no separate bot-handling of their own —
// that is the whole premise of the toggle (a crawler arrives without a referer,
// so it cannot fake one). Neither carries a delta badge or a
// pages/session figure: no previous-period channel breakdown is stored, and
// pageviews carry no referrer dimension to split by channel, so showing either
// would fabricate a comparison the data does not support.
function numsBlocks(site, periodLabel) {
  const allBlock = `<div class="nums tv-all"><div class="big">${site.visits
    ? `${site.partialDays ? (site.estimatedVisits ? "&sim;&nbsp;" : "&ge;&nbsp;") : ""}${fmt(site.visits)}`
    : "—"}${site.estimatedVisits && site.spread ? `<span class="spread" title="Ratio estimate of the flooded day's direct bucket, plus or minus this margin — see the note below.">&plusmn;${fmt(site.spread)}</span>` : ""}</div><div class="lbl">${site.zoneSourced ? "zone visits" : "human sessions"} ${periodLabel}</div>
    ${deltaBadge(site.delta, true, site.visits - site.previousVisits)}<div class="pv">${site.zoneSourced
      ? `${fmt(site.views)} requests · ${bytesLabel(site.bytes)}`
      : site.cleanDays
        ? `${fmt(site.views)} views · ${site.pagesPerSession ? site.pagesPerSession.toFixed(1) : "0.0"} pages/session`
        : `pageviews not separable on flooded days`}</div></div>`;
  if (site.zoneSourced) {
    // Zone hosts write no daily_referrers rows at all (no referer dimension in
    // the zone log), so there is no channel to break out — say so rather than
    // rendering a confident zero. Kept to one short line: `.nums` is
    // `white-space:nowrap` (see the CSS), so a longer sentence here would widen
    // the box and squeeze the host name instead of wrapping — the fuller
    // explanation lives in the KPI tile and footer instead.
    const na = `<div class="big">—</div><div class="lbl">not tracked by referrer</div>
      <div class="pv">No referrer dimension on this host.</div>`;
    return `${allBlock}<div class="nums tv-search" hidden>${na}</div><div class="nums tv-referred" hidden>${na}</div>`;
  }
  // Short lines only — see the `.nums{white-space:nowrap}` note above; the fuller
  // "why" is in the title tooltip and the footer, not repeated per card.
  //
  // MUST NAME ITS OWN POPULATION, right next to the number, not just in a
  // tooltip: this figure is a Cloudflare Web Analytics REFERRER classification
  // (site.sources), and on a card with a Google/Bing search-summary panel it
  // renders directly above numbers from a completely different system — Search
  // Console / Bing's own CLICK counts, on their own rolling/lagged window,
  // unaffected by whether this device's browser sent a referrer or by today's
  // crawler flood. A RUM-referrer count of 2 sitting over a GSC click count of
  // 352 (forum.objectivismonline.com, a heavily flooded day) reads as a bug if
  // the two aren't told apart in the visible text — see the "two populations,
  // never mixed" gotcha in AGENTS.md for the same trap elsewhere on this page.
  const popNote = `RUM referrer, not GSC/Bing clicks`;
  const popTitle = "Cloudflare Web Analytics sessions classified by referrer — not the same measurement as the "
    + "Search Console / Bing panels on this card, which report their own click counts on their own rolling, "
    + "lagged window and are unaffected by referrers or today's crawler flood. The two numbers are not comparable.";
  const searchBlock = `<div class="nums tv-search" hidden><div class="big">${fmt(site.sources?.search)}</div>
    <div class="lbl" title="${esc(popTitle)}">search-referred sessions ${periodLabel}</div>
    <div class="pv">${popNote}</div></div>`;
  const referred = referredVisitsOf(site);
  const referredBlock = `<div class="nums tv-referred" hidden><div class="big">${fmt(referred)}</div>
    <div class="lbl" title="${esc(popTitle)}">non-direct sessions ${periodLabel}</div>
    <div class="pv">${popNote}</div></div>`;
  return `${allBlock}${searchBlock}${referredBlock}`;
}

function siteCard(site, index, periodDays) {
  // Same function the signal hrefs are built from, so a "Today's actions" link
  // cannot point at an anchor this card does not carry.
  const id = cardAnchor(site.host);
  const periodLabel = periodDays === 1 ? "24h" : `${periodDays}d`;
  const hasDetails = site.zoneSourced
    ? site.cfPages.length || site.zoneCountries.length || site.zoneStatuses.length
    : site.searchSummary || site.referrers.length || site.keywords.length || site.pages.length
      || site.cfPages.length || site.bingKeywords.length;
  return `<section class="card ${site.zoneSourced ? "card--zone" : ""} ${!site.visits && !hasDetails ? "empty" : ""}" aria-labelledby="${id}">
    <div class="chead">
      <div class="hostwrap">
        <h2 class="host" id="${id}"><a href="https://${esc(site.host)}" target="_blank" rel="noopener">${esc(site.host)}</a></h2>
        ${sparkline(site.spark, site.host)}
      </div>
      ${numsBlocks(site, periodLabel)}
    </div>
    ${site.zoneSourced ? `<p class="zone-row" role="note">Counted from zone HTTP request logs (no RUM tag on this site).
      Requests include crawlers, assets, and robots.txt, so this is not comparable to the session counts above.</p>` : ""}
    ${site.zoneSourced ? zoneCrawlerPanel(site) : ""}
    ${site.botVisits ? `<p class="crawler-row" role="note"><strong>+ ${fmt(site.botVisits)} crawler sessions</strong> over ${site.botDays} flooded day${site.botDays === 1 ? "" : "s"}${site.anomaly ? ` — ${esc(site.anomaly)}` : ""}. ${crawlerRowDetail(site)}</p>` : ""}
    ${searchSummary(site.searchSummary)}
    ${bingSummary(site)}
    ${hasDetails ? (site.zoneSourced ? `<details class="detail" open data-card-index="${index}">
      <summary><span>Countries, status codes &amp; top files</span><span class="summary-action">Hide details</span></summary>
      <div class="cols">
        <section class="panel"><h3><span class="dot traffic"></span>Top countries</h3>${countryList(site.zoneCountries)}</section>
        <section class="panel"><h3><span class="dot search"></span>Status codes</h3>${statusList(site.zoneStatuses)}</section>
      </div>
      <section class="panel pages-panel"><h3><span class="dot traffic"></span>Top files</h3>${fileList(site.cfPages, site.host)}</section>
    </details>` : `<details class="detail" open data-card-index="${index}">
      <summary><span>Referrers, search queries &amp; landing pages</span><span class="summary-action">Hide details</span></summary>
      <div class="cols">
        <section class="panel"><h3><span class="dot traffic"></span>Top referrers</h3>${referrerList(site)}</section>
        <section class="panel"><h3><span class="dot search"></span>Search opportunities</h3>${keywordList(site)}</section>
      </div>
      <section class="panel pages-panel"><h3><span class="dot traffic"></span>Top landing pages (all traffic)</h3>${cfPageList(site.cfPages, site.host)}</section>
      <section class="panel pages-panel"><h3><span class="dot good"></span>Top landing pages (Google Search)</h3>${pageList(site.pages)}</section>
      ${site.bingKeywords.length ? `<section class="panel pages-panel"><h3><span class="dot bing"></span>Top search queries (Bing)</h3>${bingKeywordList(site.bingKeywords)}</section>` : ""}
    </details>`) : `<p class="none">No analytics data in this window.</p>`}
  </section>`;
}

// One card per Discourse forum, reading data.forums (see loadDashboard's
// `forums` shaping step — independent of the RUM/zone `sites` cards above).
// The two stat grids reuse the `.search-summary` layout the search-panel cards
// already use rather than introducing a new component for four-number rows.
function forumCard(f) {
  const id = `forum-${f.host.replace(/[^a-z0-9]/gi, "-")}`;
  if (!f.hasData) {
    return `<section class="card empty" aria-labelledby="${id}">
      <div class="chead"><div class="hostwrap">
        <h2 class="host" id="${id}"><a href="https://${esc(f.host)}/admin/users/list/active" target="_blank" rel="noopener">${esc(f.name)}</a></h2>
      </div></div>
      <p class="none">No snapshot yet — the next nightly pull will populate this.</p>
    </section>`;
  }
  return `<section class="card" aria-labelledby="${id}">
    <div class="chead">
      <div class="hostwrap">
        <h2 class="host" id="${id}"><a href="https://${esc(f.host)}/admin/users/list/active" target="_blank" rel="noopener">${esc(f.name)}</a></h2>
        ${sparkline(f.spark, f.host, "active users")}
      </div>
      <div class="nums"><div class="big">${fmt(f.activeToday)}</div><div class="lbl">active users today</div>
        <div class="pv">${f.meanActiveToday
          ? cmp(`14-day mean ${fmt(Math.round(f.meanActiveToday))}`, "Mean daily active-user count over the last 14 daily snapshots.")
          : ""}</div></div>
    </div>
    <div class="cols">
      <section class="panel"><h3><span class="dot traffic"></span>Active users</h3>
        <div class="search-summary">
          <div><strong>${fmt(f.activeToday)}</strong><span>today</span></div>
          <div><strong>${fmt(f.active7d)}</strong><span>7 days</span></div>
          <div><strong>${fmt(f.active30d)}</strong><span>30 days</span></div>
          <div><strong>${fmt(f.usersCount)}</strong><span>registered</span></div>
        </div>
      </section>
      <section class="panel"><h3><span class="dot good"></span>New signups</h3>
        <div class="search-summary">
          <div><strong>${fmt(f.newToday)}</strong><span>today</span></div>
          <div><strong>${fmt(f.new7d)}</strong><span>7 days</span></div>
          <div><strong>${fmt(f.new30d)}</strong><span>30 days</span></div>
          <div><strong>${fmt(f.postsToday)}</strong><span>posts today</span></div>
        </div>
      </section>
    </div>
  </section>`;
}

function forumSection(forums) {
  if (!forums?.length) return "";
  return `<section class="zone-section" aria-labelledby="forum-section-heading">
    <h2 class="section-heading" id="forum-section-heading"><span class="dot good" aria-hidden="true"></span>Forum activity (Discourse)</h2>
    <div class="grid">${forums.map(forumCard).join("")}</div>
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

export function renderDashboard(data) {
  const totals = data.totals;
  const periodLabel = data.periodDays === 1 ? "Last 24 hours" : `Last ${data.periodDays} days`;
  const trafficWindow = data.coverageStart && data.date && data.coverageStart !== data.date
    ? `${formatDate(data.coverageStart)}–${formatDate(data.date)}` : formatDate(data.date);
  const coverageNote = data.periodDays > 1 && totals.daysAvailable < data.periodDays
    ? `${totals.daysAvailable} of ${data.periodDays} daily snapshots available` : null;
  const gscWindow = data.sites.find((site) => site.gscWindow)?.gscWindow || "latest available";
  // Cards, and every headline number, are split by measurement class: RUM
  // sessions and zone HTTP requests are different quantities and are never mixed
  // into one figure or one ranking.
  const rumSites = data.sites.filter((site) => !site.zoneSourced);
  const zoneSites = data.sites.filter((site) => site.zoneSourced);
  const hasZoneSite = zoneSites.length > 0;
  const hasBingSite = data.sites.some((site) => site.bingSummary || site.bingKeywords.length);
  const rumDomains = totals.rumDomains ?? rumSites.length;
  const pagesPerSession = totals.pagesPerSession ?? (totals.visits ? totals.views / totals.visits : 0);
  const updatedAt = data.dataUpdatedAt || data.run?.run_at;
  const stale = updatedAt ? Date.now() - Date.parse(updatedAt) > 30 * 3600 * 1000 : true;
  // Comparators, not bare numbers (spec item 8). Traffic tiles compare against a
  // 14-day daily mean from the history already loaded; search tiles compare
  // against the trailing GSC snapshots and, for CTR, against what the stored
  // query mix would earn at its own positions.
  const trend = totals.trend ?? {};
  const zoneDomains = totals.zoneDomains ?? 0;
  // The zone hosts are counted in "Domains shown" and deliberately not in
  // "Human sessions", which is exactly the pair of tiles that read "12 / 12 with
  // traffic" beside "11 RUM sites" and looked like a bug. State the split.
  const domainSplit = zoneDomains
    ? `${rumDomains} RUM + ${zoneDomains} zone · ${totals.active} with traffic`
    : `${rumDomains} RUM site${rumDomains === 1 ? "" : "s"} · ${totals.active} with traffic`;
  // The "Human sessions" tile gets three renderings — all/search/referred — same
  // client-side toggle as the site cards and domain headings (see numsBlocks and
  // the bottom-of-page script). `totals.sourceMix` is already RUM-only and
  // already crawler-clean (see the "Two measurement classes" and flood-splitting
  // notes in AGENTS.md), so no new aggregate is computed here — just read back.
  // Neither channel view carries a delta or 14-day mean: no previous-period
  // channel breakdown is stored, so showing one would fabricate a comparator.
  const searchTotal = Number(totals.sourceMix?.search || 0);
  const referredTotal = ["search", "social", "referral", "internal"]
    .reduce((sum, key) => sum + Number(totals.sourceMix?.[key] || 0), 0);
  // The tile label swaps with the view too (unlike the site cards, `.stat .k`
  // isn't `white-space:nowrap`, so there's no layout reason not to), and the sub
  // text names the population explicitly: this is a Cloudflare Web Analytics
  // referrer classification, not the Google clicks / search impressions tiles
  // that sit right beside it a moment later — same "two populations, never
  // mixed" trap as numsBlocks above, just at the page level instead of the card
  // level.
  const sessionsTile = `<div class="stat">
    <div class="k tv-all"><span class="dot traffic" aria-hidden="true"></span>Human sessions</div>
    <div class="k tv-search" hidden><span class="dot search" aria-hidden="true"></span>Search-referred sessions</div>
    <div class="k tv-referred" hidden><span class="dot social" aria-hidden="true"></span>Non-direct sessions</div>
    <div class="v tv-all">${fmt(totals.visits)}</div>
    <div class="v tv-search" hidden>${fmt(searchTotal)}</div>
    <div class="v tv-referred" hidden>${fmt(referredTotal)}</div>
    <div class="s tv-all">${deltaBadge(totals.delta, false, totals.visits - totals.previousVisits)}<span>${rumDomains} RUM site${rumDomains === 1 ? "" : "s"} · ${coverageNote || periodLabel.toLowerCase()}</span>${meanNote(totals.visits, trend.visitsPerDay, totals.daysAvailable, data.periodDays)}</div>
    <div class="s tv-search" hidden><span>RUM sessions with a search-engine referrer — any of them, not just Google and Bing. A crawler doesn't fake this, so it holds up even on a flooded day. Not the same measurement as the Google clicks / search impressions tiles below: those are Search Console's own click counts on their own rolling, lagged window.</span></div>
    <div class="s tv-referred" hidden><span>RUM sessions with any non-direct referrer (search, social, external link). Bots almost never carry one. Not the same measurement as the search tiles below, which come from Search Console's own click reporting.</span></div>
  </div>`;
  // Fourth tuple item is the color of the small `.dot` icon rendered beside the
  // label — traffic (blue) for volume tiles, search (amber) for anything pulled
  // from GSC, good (green) for coverage/health — so the row can be scanned by
  // color alone before reading a single label.
  const stats = [
    ["Total pageviews", fmt(totals.views), `<span>${pagesPerSession.toFixed(1)} pages / session · RUM only</span>${meanNote(totals.views, trend.viewsPerDay, totals.daysAvailable, data.periodDays)}`, "traffic"],
    ["Search sessions", fmt(totals.search), `<span>${pct(totals.searchShare, 1)} of all sessions</span>${meanNote(totals.search, trend.searchPerDay, totals.daysAvailable, data.periodDays)}`, "search"],
    [data.domain ? "Domain selected" : "Domains shown", totals.domains, `<span>${domainSplit}</span>`, "good"],
  ];
  if (totals.searchDataDomains) {
    // Every GSC figure is a rolling three-day window that lags two days, and
    // consecutive stored rows overlap by two of those three days. So the
    // comparator is stated per snapshot, never per day, and the window it spans is
    // named from gsc_window rather than from the snapshot dates.
    const rolling = trend.gscSnapshots > 1
      ? `Mean over the last ${trend.gscSnapshots} GSC snapshots${trend.gscWindowFirst && trend.gscWindowLast
        ? ` (rolling windows ${trend.gscWindowFirst} through ${trend.gscWindowLast})` : ""}. `
        + `Each snapshot covers a three-day window lagging two days, so consecutive snapshots overlap and a snapshot-over-snapshot difference is not a like-for-like change.`
      : null;
    const gscMean = (value) => (trend.gscSnapshots > 1
      ? cmp(`14-snapshot mean ${fmt(Math.round(value))}`, rolling) : "");
    // The CTR tile describes TWO populations and has to say which is which. The
    // headline is the whole corpus out of daily_search_summary; the expectation
    // can only be computed from the stored per-query rows (the top
    // KEYWORD_ROW_LIMIT queries GSC returns per site, minus whatever it
    // anonymizes), which are better positioned than the tail. Printing 0.4% beside
    // `expected ~5.9%` implied a 15x shortfall that does not exist — so the
    // comparator's actual side is the sample too, and the sample's impression
    // coverage is stated beside it. See the trap note in src/index.js.
    const sampleShare = Number(totals.gscSampleShare || 0);
    const thinSample = sampleShare > 0 && sampleShare < THIN_SAMPLE_SHARE ? " · thin sample" : "";
    const expected = totals.gscSampleImpressions
      ? `<span>headline covers every query</span>`
        + `<span title="Both sides of this comparison are the ${fmt(totals.gscSampleQueries ?? 0)} per-query rows Google returns (its top queries per site), covering ${fmt(totals.gscSampleImpressions)} of ${fmt(totals.gscImpressions)} impressions. The headline CTR above covers the whole corpus including the tail, so the expectation is not a verdict on it.">`
        + `stored top ${fmt(totals.gscSampleQueries ?? 0)} queries: ${pct(totals.gscSampleCtr, 1)} vs expected ~${pct(totals.gscExpectedCtr, 1)}`
        + ` · ${pct(sampleShare, 1)} of impressions${thinSample}</span>`
      : "";
    const opportunityHost = data.sites
      .filter((site) => (site.opportunityCount ?? 0) > 0)
      .sort((a, b) => (b.opportunities?.snippet[0]?.score ?? b.opportunities?.rank[0]?.score ?? 0)
        - (a.opportunities?.snippet[0]?.score ?? a.opportunities?.rank[0]?.score ?? 0))[0]?.host;
    const opportunityNote = totals.opportunities
      ? `<a class="cmp" href="#${cardAnchor(opportunityHost ?? "")}" title="Ranked by lost clicks for snippet gaps and by potential clicks at position ${TARGET_POSITION} for ranking gaps — two classes, two remedies, two metrics.">${fmt(totals.snippetOpportunities ?? 0)} snippet · ${fmt(totals.rankOpportunities ?? 0)} rank</a>`
      : "";
    stats.push(
      ["Google clicks", fmt(totals.gscClicks), `<span>${esc(gscWindow)} · rolling GSC window</span>${gscMean(trend.gscClicksPerSnapshot)}`, "search"],
      ["Search impressions", fmt(totals.gscImpressions), `<span>across ${fmt(totals.searchDataDomains)} domain${totals.searchDataDomains === 1 ? "" : "s"}</span>${gscMean(trend.gscImpressionsPerSnapshot)}`, "search"],
      ["Search CTR", pct(totals.gscCtr, 1), `${expected}${trend.gscSnapshots > 1 ? cmp(`14-snapshot mean ${pct(trend.gscCtr, 1)}`, rolling) : ""}`, "search"],
      ["Median search position", totals.gscMedianPosition ? totals.gscMedianPosition.toFixed(1) : "—",
        // "7 of 11 queries" read as though the estate had 11 queries; it is 11
        // STORED rows clearing the impression floor, out of a corpus of tens of
        // thousands of impressions. Name the population.
        `<span>${fmt(totals.gscTop10Queries ?? 0)} of ${fmt(totals.gscPositionQueries ?? 0)} stored top queries in the top 10</span>${opportunityNote}`, "search"],
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
header.top{display:flex;align-items:flex-start;justify-content:space-between;gap:18px 32px;padding-bottom:22px;border-bottom:1px solid var(--line)}.eyebrow{text-transform:uppercase;letter-spacing:.15em;font-size:11px;font-weight:700;color:var(--faint)}h1{font-size:28px;margin:4px 0 0;letter-spacing:-.025em;text-wrap:balance}.win{font-size:12.5px;color:var(--muted);text-align:right;line-height:1.65}.win b{color:var(--ink);font-weight:650}.ext-links{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:11.5px}.ext-links a{color:var(--muted)}.ext-links a:hover{color:var(--ink)}.fresh{display:inline-flex;align-items:center;gap:5px}.fresh::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--good)}.fresh.stale{color:var(--danger)}.fresh.stale::before{background:var(--danger)}
.toolbar{display:flex;align-items:end;justify-content:space-between;gap:12px;margin:18px 0}.periods{display:flex;gap:4px;background:color-mix(in srgb,var(--line) 62%,transparent);padding:4px;border-radius:10px}.periods a{text-decoration:none;font-size:12px;font-weight:650;color:var(--muted);padding:6px 10px;border-radius:7px}.periods a[aria-current=page]{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}.filters{display:flex;align-items:end;gap:8px}.field{display:flex;flex-direction:column;gap:3px}.field label{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);font-weight:700}.field select,.theme{height:34px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit;font-size:12px;padding:0 28px 0 9px}.theme{padding:0 10px;cursor:pointer}
.totals{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin:0 0 18px}.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:15px 17px;box-shadow:var(--shadow)}.stat .k{font-size:10px;text-transform:uppercase;letter-spacing:.11em;color:var(--faint);font-weight:700}.stat .v{font-size:30px;font-weight:700;letter-spacing:-.035em;margin:3px 0}.stat .s{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:7px;flex-wrap:wrap}.delta{display:inline-flex;align-items:center;font-size:10px;font-weight:700;border-radius:999px;padding:2px 6px;background:var(--line);color:var(--muted);white-space:nowrap}.delta.up{background:var(--good-soft);color:var(--good)}.delta.down{background:var(--danger-soft);color:var(--danger)}
.anomaly{margin:0 0 14px;padding:9px 12px;border-radius:9px;background:var(--danger-soft);color:var(--danger);font-size:12px;line-height:1.45;border:1px solid color-mix(in srgb,var(--danger) 28%,transparent)}.anomaly strong{font-weight:700}
.crawler{margin:-2px 0 18px;padding:11px 14px;border-radius:var(--radius);background:var(--card);border:1px solid var(--line);border-left:3px solid var(--social);box-shadow:var(--shadow);font-size:12px;line-height:1.5;color:var(--muted)}.crawler strong{color:var(--ink);font-weight:700}
.crawler-row{margin:0;padding:8px 11px;border-radius:9px;background:color-mix(in srgb,var(--social) 10%,transparent);border:1px solid color-mix(in srgb,var(--social) 24%,transparent);font-size:11.5px;line-height:1.45;color:var(--muted)}.crawler-row strong{color:var(--social);font-weight:700}
.spark-flood{fill:var(--paper);stroke:var(--social);stroke-width:1.6}
.zone-strip{margin:-2px 0 18px;padding:11px 14px;border-radius:var(--radius);background:var(--card);border:1px solid var(--line);border-left:3px solid var(--faint);box-shadow:var(--shadow);font-size:12px;line-height:1.5;color:var(--muted)}.zone-strip-label{font-size:10px;text-transform:uppercase;letter-spacing:.11em;font-weight:700;color:var(--faint)}.zone-strip-label span{text-transform:none;letter-spacing:0;font-weight:400}.zone-strip ul{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:3px}.zone-strip b{color:var(--ink);font-weight:650}
.zone-section{margin-top:22px}.domain-group+.domain-group{margin-top:20px}.domain-heading{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;font-size:12px;font-weight:700;letter-spacing:-.01em;margin:0 0 9px;padding-bottom:6px;border-bottom:1px solid var(--line);cursor:pointer;list-style:none}.domain-heading::-webkit-details-marker{display:none}.domain-heading::before{content:"▾";font-size:9px;color:var(--faint)}.domain-group:not([open])>.domain-heading::before{content:"▸"}.domain-heading span{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--faint)}.section-heading{font-size:10px;text-transform:uppercase;letter-spacing:.11em;color:var(--faint);margin:0 0 11px;font-weight:700}.card--zone{border-left:3px solid var(--faint)}.zone-row{margin:0;padding:8px 11px;border-radius:9px;background:color-mix(in srgb,var(--faint) 9%,transparent);border:1px solid color-mix(in srgb,var(--faint) 22%,transparent);font-size:11.5px;line-height:1.45;color:var(--muted)}
.zone-bots{margin:0;padding:10px 12px;border-radius:9px;background:color-mix(in srgb,var(--social) 8%,transparent);border:1px solid color-mix(in srgb,var(--social) 22%,transparent);font-size:11.5px;line-height:1.5;color:var(--muted)}.zone-bots h3{font-size:9.5px;text-transform:uppercase;letter-spacing:.11em;font-weight:700;margin:0 0 5px;color:var(--social)}.zone-bots h3:not(:first-child){margin-top:11px;padding-top:9px;border-top:1px dashed color-mix(in srgb,var(--social) 26%,transparent)}.zone-bots p{margin:0 0 6px}.zone-bots p:last-child{margin-bottom:0}.zone-bots b{color:var(--ink);font-weight:650}.zone-bots .cats{list-style:none;margin:0 0 6px;padding:0;display:flex;flex-wrap:wrap;gap:3px 12px;font-size:11px}
.source-overview{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px 17px;box-shadow:var(--shadow);margin:-2px 0 18px}.source-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:9px}.source-heading h2{font-size:10px;text-transform:uppercase;letter-spacing:.11em;color:var(--faint);margin:0}.source-heading span{font-size:10px;color:var(--faint)}.source-bar{height:8px;display:flex;overflow:hidden;border-radius:999px;background:var(--line);margin-bottom:10px}.source-segment{height:100%}.source-segment.direct,.source-legend i.direct{background:var(--direct)}.source-segment.search,.source-legend i.search{background:var(--search)}.source-segment.social,.source-legend i.social{background:var(--social)}.source-segment.referral,.source-legend i.referral{background:var(--good)}.source-segment.internal,.source-legend i.internal{background:var(--faint)}.source-legend{display:grid;grid-template-columns:repeat(5,1fr);gap:8px 14px}.source-legend>div{display:grid;grid-template-columns:auto 1fr auto;align-items:center;column-gap:6px;font-size:11px;min-width:0}.source-legend i{width:7px;height:7px;border-radius:50%}.source-legend span{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.source-legend strong{font-size:11px}.source-legend small{grid-column:2/-1;color:var(--faint);font-size:9px}.source-note{margin:10px 0 0;padding-top:9px;border-top:1px dashed var(--line);font-size:10.5px;line-height:1.5;color:var(--faint)}.source-note b{color:var(--muted);font-weight:650}
html[data-traffic-view=search] .source-segment:not(.search),html[data-traffic-view=search] .source-legend>div:not(:has(i.search)){opacity:.32}html[data-traffic-view=referred] .source-segment.direct,html[data-traffic-view=referred] .source-legend>div:has(i.direct){opacity:.32}
.cmp{display:inline-flex;align-items:center;font-size:10px;font-weight:650;border-radius:999px;padding:2px 6px;background:color-mix(in srgb,var(--line) 70%,transparent);color:var(--faint);white-space:nowrap;text-decoration:none}a.cmp:hover{color:var(--ink)}
.insights{margin:0 0 18px}.insights>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;list-style:none;padding:2px 2px 11px;font-size:10px;text-transform:uppercase;letter-spacing:.11em;color:var(--faint);font-weight:700}.insights>summary::-webkit-details-marker{display:none}.insights>summary::before{content:"▾";font-size:9px;margin-right:7px;color:var(--faint)}.insights:not([open])>summary::before{content:"▸"}.insights:not([open])>summary{padding-bottom:2px}.insights-label{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.insights-count{font-size:10px;text-transform:none;letter-spacing:0;font-weight:650;color:var(--muted);background:color-mix(in srgb,var(--line) 70%,transparent);border-radius:999px;padding:2px 8px}.insights-body{display:flex;flex-direction:column;gap:12px}.insights>summary .summary-action{text-transform:none;letter-spacing:0;font-weight:650;font-size:11.5px;color:var(--traffic)}
.actions{margin:0}.action-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px}.action{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--faint);border-radius:var(--radius);box-shadow:var(--shadow);padding:11px 14px;font-size:12px;line-height:1.5;color:var(--muted)}.action.sev1{border-left-color:var(--danger)}.action.sev2{border-left-color:var(--search)}.action-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:3px}.action-head b{color:var(--ink);font-weight:650;font-size:13px}.sev-tag{font-size:8.5px;text-transform:uppercase;letter-spacing:.09em;font-weight:800;border-radius:4px;padding:2px 5px;background:var(--line);color:var(--muted);flex:none}.action.sev1 .sev-tag{background:var(--danger-soft);color:var(--danger)}.action.sev2 .sev-tag{background:var(--search-soft);color:var(--search)}.sev-run{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:var(--faint)}.action-why{color:var(--muted)}.action-do{margin-top:4px;color:var(--ink)}.action-do a{color:var(--traffic);font-weight:650;text-decoration:none;white-space:nowrap}.action-do a:hover{text-decoration:underline}.action-none{margin:0;padding:11px 14px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--good);border-radius:var(--radius);box-shadow:var(--shadow);font-size:12px;color:var(--muted)}
.delta.small{background:color-mix(in srgb,var(--line) 70%,transparent);color:var(--faint);font-weight:650}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px 20px 20px;display:flex;flex-direction:column;gap:13px;min-width:0}.card.empty{opacity:.68}.chead{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.hostwrap{display:flex;flex-direction:column;gap:6px;min-width:0}.host{font-size:15px;font-weight:700;letter-spacing:-.01em;word-break:break-word;margin:0}.host a{text-decoration:none}.host a:hover{text-decoration:underline}.spark{display:block;max-width:100%;height:auto}.spark-hit{fill:transparent;stroke:none}.spark-empty{font-size:10px;color:var(--faint);font-style:italic}.nums{text-align:right;white-space:nowrap}.nums .big{font-size:25px;font-weight:700;letter-spacing:-.035em}.nums .big .spread{font-size:12px;font-weight:600;color:var(--faint);letter-spacing:normal;margin-left:3px;cursor:help}.nums .lbl{font-size:9px;text-transform:uppercase;letter-spacing:.11em;color:var(--faint);margin-bottom:4px}.nums .pv{font-size:11px;color:var(--muted);margin-top:4px}.detail>summary{display:none}.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}.panel{min-width:0}.panel h3{font-size:9.5px;text-transform:uppercase;letter-spacing:.11em;font-weight:700;margin:0 0 8px;display:flex;align-items:center;gap:6px}.dot{width:7px;height:7px;border-radius:50%;display:inline-block}.dot.traffic{background:var(--traffic)}.dot.search{background:var(--search)}.dot.good{background:var(--good)}.dot.bing{background:var(--traffic)}.dot.social{background:var(--social)}.dot.danger{background:var(--danger)}.dot.faint{background:var(--faint)}
.k .dot,.section-heading .dot,.source-heading h2 .dot{margin-right:6px;vertical-align:1px}
.ref-list,.metric-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}.ref{position:relative}.ref .bar{position:absolute;inset:0 auto 0 0;background:var(--traffic-soft);border-radius:5px;z-index:0}.ref.direct-row .bar{background:color-mix(in srgb,var(--direct) 14%,transparent)}.ref .row{position:relative;z-index:1;display:flex;justify-content:space-between;gap:8px;padding:4px 7px;font-size:12px}.ref .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ref .n{font-weight:650;color:var(--muted)}.tag{font-size:8px;text-transform:uppercase;letter-spacing:.06em;padding:1px 4px;border-radius:4px;font-weight:700;margin-left:5px}.tag.search{background:var(--search-soft);color:var(--search)}.tag.direct{background:color-mix(in srgb,var(--direct) 16%,transparent);color:var(--direct)}.tag.social{background:color-mix(in srgb,var(--social) 18%,transparent);color:var(--social)}.tag.ref{background:var(--good-soft);color:var(--good)}.tag.internal{background:color-mix(in srgb,var(--faint) 16%,transparent);color:var(--faint)}.tag.ai{background:color-mix(in srgb,var(--traffic) 18%,transparent);color:var(--traffic)}.scale-note{font-size:9px;color:var(--faint);margin-top:5px}
.search-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;background:color-mix(in srgb,var(--search-soft) 55%,transparent);border-radius:8px;padding:8px 10px}.search-summary>div{display:flex;flex-direction:column;min-width:0}.search-summary strong{font-size:13px;color:var(--search);line-height:1.2}.search-summary span{font-size:8px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);white-space:nowrap}.search-summary.bing{grid-template-columns:repeat(3,1fr);background:color-mix(in srgb,var(--traffic-soft) 55%,transparent);margin-top:-3px}.search-summary.bing strong{color:var(--traffic)}.mini-h3{font-size:9.5px;text-transform:uppercase;letter-spacing:.11em;font-weight:700;margin:0 0 6px;display:flex;align-items:center;gap:6px;color:var(--muted)}.metric-row{display:flex;justify-content:space-between;gap:10px;border-bottom:1px dashed var(--line);padding:2px 0 5px;min-width:0}.metric-row:last-child{border-bottom:0}.metric-row.flagged{background:linear-gradient(90deg,var(--search-soft),transparent 72%);border-radius:5px;padding-left:5px}.metric-name{display:flex;align-items:center;gap:4px 6px;min-width:0;font-size:11.5px;flex-wrap:wrap}.truncate{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.metric-name .truncate{flex:1 1 120px;min-width:70px}.metric-name a{text-decoration:none}.metric-name a:hover{text-decoration:underline}.opportunity-tag{font-size:7.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--search);font-weight:800;border:1px solid color-mix(in srgb,var(--search) 35%,transparent);border-radius:4px;padding:1px 3px;flex:none;cursor:help}.opportunity-tag.rank{color:var(--traffic);border-color:color-mix(in srgb,var(--traffic) 35%,transparent)}.metric-values{text-align:right;white-space:nowrap;display:flex;flex-direction:column;line-height:1.2}.metric-values strong{font-size:11px;color:var(--search)}.metric-values span{font-size:8.5px;color:var(--faint)}.pages-panel{margin-top:15px;padding-top:13px;border-top:1px solid var(--line)}.pages-list{display:grid;grid-template-columns:1fr 1fr;gap:5px 16px}.none{font-size:11.5px;color:var(--faint);font-style:italic;margin:0;padding:3px 0}
footer{margin-top:32px;padding-top:17px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted);display:flex;flex-direction:column;gap:5px}footer b{color:var(--ink);font-weight:650}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (max-width:940px){.grid{grid-template-columns:1fr}.card{max-width:760px;width:100%;margin-inline:auto}}
@media (max-width:700px){.toolbar{align-items:stretch;flex-direction:column}.filters{display:grid;grid-template-columns:1fr 1fr auto}.field select{width:100%}.totals{grid-template-columns:repeat(2,1fr)}.source-legend{grid-template-columns:repeat(2,1fr)}}
@media (max-width:560px){.wrap{padding:calc(20px + env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) calc(44px + env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))}header.top{flex-direction:column;align-items:flex-start;gap:10px;padding-bottom:16px}.win{text-align:left;width:100%;font-size:12px;line-height:1.7}h1{font-size:25px;line-height:1.15}.toolbar{margin:14px 0 16px}.periods{width:100%;padding:3px}.periods a{flex:1;display:flex;align-items:center;justify-content:center;min-height:44px;text-align:center;font-size:13px}.filters{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 8px}.field{gap:5px}.field label{font-size:10px}.field select,.theme{min-height:44px;height:44px;font-size:16px}.theme{grid-column:1/-1;width:100%}.totals{gap:8px;margin-bottom:14px}.stat{padding:13px 13px}.stat .k{font-size:10px;line-height:1.3}.stat .v{font-size:27px}.stat .s{font-size:12px}.source-overview{padding:14px;margin-bottom:14px}.source-heading span{font-size:11px}.source-legend{gap:10px 14px}.source-legend>div{font-size:12px}.source-legend strong{font-size:12px}.source-legend small{font-size:10px}.actions{margin-bottom:14px}.action,.action-none{font-size:12.5px;padding:12px 13px}.action-head b{font-size:13.5px}.action-do a{display:inline-block;min-height:32px;line-height:32px}.card{padding:16px 15px 17px;gap:12px}.chead{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:8px 12px}.hostwrap{display:contents}.host{grid-column:1/-1;font-size:16px;overflow-wrap:anywhere;word-break:normal}.spark,.spark-empty{grid-column:1;grid-row:2}.spark{width:132px}.nums{grid-column:2;grid-row:2;max-width:150px}.nums .big{font-size:25px}.nums .lbl{font-size:10px}.nums .pv{font-size:11px;white-space:normal}.search-summary{padding:10px}.search-summary strong{font-size:14px}.search-summary span{font-size:9px}.detail{border-top:1px solid var(--line);padding-top:0}.detail>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:44px;padding:8px 0;cursor:pointer;font-size:12px;color:var(--muted);line-height:1.35;list-style:none}.detail>summary::-webkit-details-marker{display:none}.summary-action{color:var(--traffic);font-weight:700;white-space:nowrap}.detail[open]>summary{margin-bottom:10px}.cols{grid-template-columns:1fr;gap:18px}.panel h3{font-size:10.5px}.pages-list{grid-template-columns:1fr}.pages-panel{margin-top:17px}.ref .row{min-height:36px;align-items:center;font-size:13px}.tag{font-size:9px}.metric-row{min-height:40px;align-items:center;padding-top:5px;padding-bottom:7px}.metric-name{font-size:13px}.metric-values strong{font-size:12px}.metric-values span{font-size:10px}.none{font-size:12px}footer{font-size:12px;line-height:1.55}}
@media (max-width:360px){.wrap{padding-inline:12px}.totals{gap:7px}.stat{padding:12px 11px}.stat .v{font-size:25px}.source-legend{grid-template-columns:1fr}.search-summary{grid-template-columns:repeat(2,1fr);gap:10px 8px}}
[hidden]{display:none!important}
</style></head><body>
<a class="skip" href="#main">Skip to dashboard</a>
<div class="wrap">
  <header class="top">
    <div><div class="eyebrow">Daily traffic &amp; search brief</div><h1>${data.domain ? esc(data.domain) : "All domains — one glance"}</h1>
      <div class="ext-links"><a href="http://dashboard.davidveksler.com/" target="_blank" rel="noopener">Error dashboard</a><a href="https://dashboard.davidveksler.com/admin.php" target="_blank" rel="noopener">Admin links</a><a href="https://search.google.com/search-console" target="_blank" rel="noopener">Search Console</a><a href="https://dash.cloudflare.com/556c237bf8cb62edb8f7b401499bb7a9/web-analytics" target="_blank" rel="noopener">Web Analytics</a></div>
    </div>
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
      <div class="field"><label for="traffic-view">Bot-resistant view</label><select id="traffic-view" title="Switch the numbers shown to a traffic slice a crawler can't fake — instant, no reload. Card order stays ranked by total traffic. These are Cloudflare RUM sessions classified by referrer, not Search Console/Bing click counts."><option value="all">All traffic</option><option value="search">Search traffic only</option><option value="referred">Referred traffic only</option></select></div>
      <button class="theme" id="collapse-all-toggle" type="button" aria-label="Collapse or expand all domain sections">▾ Collapse all</button>
      <button class="theme" id="theme-toggle" type="button" aria-label="Change color theme">◐ Theme</button>
    </div>
  </nav>
  <main id="main">
    ${insightsPanel(data.signals, totals, data.sites)}
    <section class="totals" aria-labelledby="overview-heading"><h2 class="sr-only" id="overview-heading">Traffic overview</h2>
      ${sessionsTile}
      ${stats.map((stat) => `<div class="stat"><div class="k"><span class="dot ${stat[3]}" aria-hidden="true"></span>${stat[0]}</div><div class="v">${stat[1]}</div><div class="s">${stat[2]}</div></div>`).join("")}
    </section>
    ${sourceMix(totals)}
    ${domainGrids(rumSites, data.sites, data.periodDays, "sessions")}
    ${hasZoneSite ? `<section class="zone-section" aria-labelledby="zone-section-heading">
      <h2 class="section-heading" id="zone-section-heading"><span class="dot faint" aria-hidden="true"></span>Zone-log measurement</h2>
      ${domainGrids(zoneSites, data.sites, data.periodDays, "zone visits")}
    </section>` : ""}
    ${forumSection(data.forums)}
  </main>
  <footer>
    <div><b>Sessions</b> are Cloudflare Web Analytics visits; pageviews, referrers, and "landing pages (all traffic)" use the selected traffic period and cover every referrer (search, social, direct, etc.) — "ent" is entrances, sessions that started on that page. Direct traffic is shown separately so smaller external sources remain readable. Each KPI tile carries a <b>14-day mean</b> beside it, computed from the same daily snapshots and the same human/crawler split the cards use, so every figure can be read against what normal looks like.</div>
    <div><b>Cards are grouped by domain.</b> Every host of a registrable domain (freecapitalists.org covers wiki., forum., library. and the apex) sits in one block, blocks are ordered by that domain's own total, and hosts are ordered by theirs inside it — the same metric at both levels, so the sort control moves them together. Grouping happens within a measurement class, never across one: a domain with both a RUM host and a zone-log host appears in both sections, ranked against its own class each time, because sessions and HTTP requests are not the same quantity.</div>
    <div><b>Traffic sources</b> covers RUM sites only, and <b>Unattributed is a residual, not a channel</b>: it is the arithmetic gap between the sessions the traffic table counted and the referrer rows the referrer table stored, so it sits outside the mix bar with its causes named rather than competing with Direct and Search. <b>Internal</b> is sessions arriving from one of a site's own hostnames — an apex landing page handing off to the forum, say. Those were dropped rather than stored and reappeared inside the residual; they are recorded from 2026-08-13 forward. The channel is frozen into each stored row at write time, so it cannot be backfilled: over a window that reaches back before that date the channel is simply absent rather than shown as a measured zero.</div>
    <div><b>Human vs crawler.</b> Crawlers fire the same analytics beacon a person does, so a site-day is set aside as a crawler flood when it is ≥${pct(DIRECT_SHARE, 0)} direct, ≤${FLAT_PAGES_PER_SESSION} pages/session, at least ${fmt(FLOOD_MIN_VISITS)} sessions, and at least ${FLOOD_MULTIPLE}× a normal day for that site. On a flooded day only the direct bucket and the landing-page rows are set aside: a crawler arrives without a referer, so the referred sessions are still a real measurement and still count. For a site with at least ${RATIO_MIN_CLEAN_DAYS} clean days on record, the direct bucket is also given a ratio estimate — that site's own typical direct-to-referred split on ordinary days — and shown as "~" with its own margin; otherwise the day's sessions read as a floor (≥) rather than a count. Either way, pages/session divides by clean sessions only, and a delta is suppressed whenever either side of the comparison is partial. Excluded volume is counted separately and flooded days are marked on each sparkline. Crawling is not blocked, and search/GSC figures are unaffected.</div>
    <div><b>Bot-resistant view</b> (toolbar) switches every card, domain heading, and the Human sessions tile to a slice of RUM traffic a crawler is structurally unlikely to fake: <b>Search traffic only</b> ("search-referred sessions") is sessions whose Cloudflare Web Analytics referrer was a search engine, and <b>Referred traffic only</b> ("non-direct sessions") is any non-direct referrer (search, social, or an external link) — a crawler arrives without a referer, so both are already the crawler-clean part of the numbers above, flooded days included. It is instant and client-side, so it never re-sorts the cards (still ranked by total traffic) and carries no delta or 14-day mean, because no previous-period channel breakdown is stored to compare against. Zone-log hosts have no referrer dimension and show "not tracked by referrer" in both views. <b>These are not the Google/Bing search figures on the same card or in the KPI tiles below</b>: this is a Cloudflare Web Analytics referrer classification, an entirely different measurement from Search Console/Bing's own click counts, which are pulled on their own rolling, lagged window and unaffected by whether a browser sent a referrer or by today's crawler flood. A small RUM search-referred count sitting above a much larger GSC click count for the same host is not a contradiction — see the "two populations, never mixed" gotchas elsewhere on this page for why the two are never merged into one number.</div>
    <div><b>Today's actions</b> lists the highest-severity signals the page can justify from its own data, not every change. Percentage changes are only shown where the absolute movement is at least ${fmt(DELTA_MIN_ABSOLUTE)} sessions — below that the raw change is shown instead, because a percentage on a small base is noise. Session and pages/session rules run on RUM sites only: a zone-log host is measured in HTTP requests, so "sessions rose 40%" or "pages/session fell by 2.1" about one of them would be a different quantity wearing the same words. Zone hosts get their own rules instead, today an error-rate spike against a ${fmt(ERROR_BASELINE_DAYS)}-day baseline. Flooded days are called out as "no like-for-like comparison" rather than quietly dropping off the list.</div>
    <div><b>Search performance, queries, and landing pages (Google Search)</b> use the latest complete Google Search Console window and only cover organic Google traffic. Summary totals come from an aggregate query rather than the ranked rows. <b>Median search position</b> is the median across queries with at least ${fmt(POSITION_MIN_IMPRESSIONS)} impressions, not a mean: a mean across a branded position-1 query and a position-90 stray moves when the junk moves and stays put when the work lands. <b>Two populations, never mixed:</b> the <b>Search CTR</b> headline is every query on every property, tail included, but expected CTR needs a per-query position and the only per-query rows stored are the top queries Google returns per site. So the CTR comparison states both of its sides over those stored rows and reports what share of impressions they cover, and the position tile counts stored top queries rather than the whole estate. Comparing a top-query expectation against a whole-corpus actual made a roughly 6× gap read as 15×. <b>GSC figures are a rolling window, not a daily series</b> — each nightly snapshot asks Google for a three-day window that lags two days, so consecutive snapshots overlap by two days out of three; only trailing averages are taken from them, a snapshot-over-snapshot difference is never presented as a change, and every date shown here is the window Google measured rather than the night we asked.</div>
    <div><b>Forum activity</b> is read from each Discourse forum's own <code>/about.json</code>, the same rolling-window counters its admin dashboard shows (active users today / 7 days / 30 days, new signups on the same three windows) — not re-derived from the paginated admin user list. These are Discourse's own counts, not this dashboard's; no comparator or crawler-flood logic applies to them.</div>
    <div><b>Search opportunities come in two classes with two different remedies, ranked by two different metrics.</b> A <b>snippet</b> gap is a query at position ${SNIPPET_MAX_POSITION} or better taking under ${pct(SNIPPET_CTR_RATIO, 0)} of the click-through its rank would ordinarily deliver: the ranking is already there, so the fix is the title and meta description, and these are ranked by <b>lost clicks</b> — impressions × (expected CTR − actual CTR) — which is what is recoverable without moving at all. A <b>rank</b> gap is a query between position ${SNIPPET_MAX_POSITION} and ${RANK_MAX_POSITION}, where nobody ever saw the snippet, so the fix is content and internal links, and these are ranked by <b>potential clicks</b> — what the query would earn at position ${TARGET_POSITION}, less what it earns now. Ranking both classes by lost clicks would guarantee that a deep, valuable query always lost to a shallow trivial one. Both classes need at least ${fmt(OPPORTUNITY_MIN_IMPRESSIONS)} impressions and at least ${MIN_ACTIONABLE_CLICKS} clicks of gain over the window; past position ${RANK_MAX_POSITION} a query is neither badged nor counted. Expected CTR by position is approximated from the SISTRIX 2020 CTR study (~80M keywords; positions 1, 2, 3 and 10 measured, the rest interpolated and the tail past 10 estimated), so it is a comparator and never a target — that is why no number derived from it is shown to more than one decimal place. Where a site sets <code>queryDenyPatterns</code> in <code>src/config.js</code>, matching queries still appear in the list and carry no badge.</div>
    ${hasZoneSite ? `<div><b>Zone-log sites</b> (file hosts with no HTML page to carry the Web Analytics beacon) report Cloudflare's zone-level HTTP request log instead of RUM, so their numbers are request counts, not sessions: "zone visits" is Cloudflare's heuristic arrival count over raw HTTP requests — crawler fetches of robots.txt included — "requests" is total HTTP hits, and country / status-code panels stand in for the referrer and search-console data those sites don't have. They are excluded from every headline total, from pages/session, and from the traffic-source mix, and ranked only against each other. The crawler-flood classifier cannot run on them either — it needs a referrer dimension the zone log does not have — so each zone card carries its own two-lens accounting instead: <b>verified crawlers</b>, from the categories Cloudflare cryptographically verifies, which is a floor on crawler volume rather than a bot/human split (this plan does not expose bot scores, so unverified crawlers are unmeasurable and sit in the same bucket as real readers), and <b>non-content requests</b>, meaning crawler-protocol and asset paths plus every response ≥ 400. The two overlap, so they are never added, and no human count is claimed for a zone host at all.</div>` : ""}
    ${hasBingSite ? `<div><b>Bing Search</b> is pulled from Bing Webmaster Tools, a separate account-wide API key rather than GSC's OAuth. It is never added to the Google figures above — a different engine's audience, measured by a different tool. The site-wide summary (clicks, impressions, CTR) updates daily; per-query rows update weekly, so a query list can be several days further behind than the summary beside it — each carries its own window. Bing reports two positions per query (where clicks landed, and where every impression landed) rather than GSC's one, shown as reported rather than averaged into a single figure. Only sites with a verified Bing Webmaster Tools property (<code>bing</code> in <code>src/config.js</code>) are pulled; page-level Bing data is not collected, to stay within the Worker's per-invocation subrequest budget.</div>` : ""}
    <div>Data pulled ${esc(formatTimestamp(updatedAt))} · ${data.run?.ok ? "last run OK" : "see run log"} · rendered ${esc(formatTimestamp(data.generatedAt))} · sources: Cloudflare GraphQL Analytics, Google Search Console${hasBingSite ? ", and Bing Webmaster Tools" : ""}.</div>
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
  document.querySelectorAll("details.detail, details.insights").forEach(function (detail) {
    if (detail.classList.contains("detail") && matchMedia("(max-width: 560px)").matches) detail.removeAttribute("open");
    var action = detail.querySelector(".summary-action");
    var update = function () { action.textContent = detail.open ? "Hide details" : "Show details"; };
    detail.addEventListener("toggle", update);
    update();
  });
  // Domain sections default open (unchanged page density on a fresh visit).
  // Per-section collapse state is kept in localStorage per data-domain-key —
  // same convention as stats-theme/stats-traffic-view above — so a domain
  // collapsed today stays collapsed on tomorrow's SSR page load. The
  // collapse-all button just flips every group to the opposite of whatever the
  // majority currently is, same "flip the odd one out" logic a bulk toggle
  // needs when individual sections can already differ.
  (function () {
    var groups = [].slice.call(document.querySelectorAll("[data-domain-group]"));
    if (!groups.length) return;
    var toggleBtn = document.getElementById("collapse-all-toggle");
    var KEY = "stats-collapsed-domains";
    var readCollapsed = function () {
      try { return new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch (_) { return new Set(); }
    };
    var writeCollapsed = function (set) {
      try { localStorage.setItem(KEY, JSON.stringify(Array.from(set))); } catch (_) {}
    };
    var updateToggleLabel = function () {
      if (!toggleBtn) return;
      var anyOpen = groups.some(function (g) { return g.open; });
      toggleBtn.textContent = anyOpen ? "▾ Collapse all" : "▸ Expand all";
    };
    var collapsed = readCollapsed();
    groups.forEach(function (details) {
      if (collapsed.has(details.dataset.domainKey)) details.open = false;
      details.addEventListener("toggle", function () {
        var set = readCollapsed();
        if (details.open) set.delete(details.dataset.domainKey); else set.add(details.dataset.domainKey);
        writeCollapsed(set);
        updateToggleLabel();
      });
    });
    if (toggleBtn) {
      toggleBtn.addEventListener("click", function () {
        var next = !groups.some(function (g) { return g.open; });
        var set = readCollapsed();
        groups.forEach(function (details) {
          details.open = next;
          if (next) set.delete(details.dataset.domainKey); else set.add(details.dataset.domainKey);
        });
        writeCollapsed(set);
        updateToggleLabel();
      });
    }
    updateToggleLabel();
  })();
  // Bot-resistant traffic view: instant, client-side, no reload — every number
  // it needs (site.sources, totals.sourceMix) is already in the rendered page.
  // Only one of .tv-all/.tv-search/.tv-referred is ever unhidden at a time, on
  // every element that carries the three variants (site cards, domain headings,
  // the Human sessions tile); card order is left alone (still ranked by total
  // traffic), and the source-mix bar just dims the channels the view excludes.
  var trafficSelect = document.getElementById("traffic-view");
  var applyTrafficView = function (view) {
    ["all", "search", "referred"].forEach(function (name) {
      document.querySelectorAll(".tv-" + name).forEach(function (el) { el.hidden = name !== view; });
    });
    document.documentElement.dataset.trafficView = view;
  };
  if (trafficSelect) {
    var savedView = "all";
    try { savedView = localStorage.getItem("stats-traffic-view") || "all"; } catch (_) {}
    if (savedView !== "all") { trafficSelect.value = savedView; applyTrafficView(savedView); }
    trafficSelect.addEventListener("change", function () {
      try { localStorage.setItem("stats-traffic-view", trafficSelect.value); } catch (_) {}
      applyTrafficView(trafficSelect.value);
    });
  }
})();
</script>
</body></html>`;
}
