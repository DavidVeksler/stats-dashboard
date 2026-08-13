// The ranked signal engine. Replaces the old NOTABLE list.
//
// NOTABLE reported deltas without diagnosis, without priority, and without any
// notion of what the number it was comparing actually measured. On 2026-08-13 it
// led with "library.freecapitalists.org pages/session fell by 2.1" — a figure
// that does not exist, because library is zone-sourced and its "pages/session"
// is requests per zone-log visit, not pages per session — and ranked
// "wiki.freecapitalists.org sessions rose 178%" as good news when every fact
// needed to call it a crawler spike was already on the page.
//
// Three properties this module is built around:
//
// 1. PURE. computeSignals takes rows loadDashboard has already read and returns
//    signals. It queries nothing. That is what lets runDaily reuse the same
//    rules for the ntfy push instead of growing a second copy of them — the
//    exact drift bug spec item 3 just finished fixing for the opportunity
//    predicate.
// 2. MEASUREMENT-CLASS AWARE. Session-delta and pages-per-session rules run on
//    RUM sites only. Zone-sourced hosts are measured in HTTP requests out of the
//    zone log, so a "sessions rose 40%" or "pages/session fell by 2.1" claim
//    about one is not a weak signal, it is a category error. Zone hosts are
//    eligible only for zone-specific rules; today that is `error-spike`. The
//    gate reads site.measurement / site.zoneSourced (added by spec item 1),
//    never a hostname.
// 3. ABSOLUTE FLOORS EVERYWHERE. A percentage on a single-digit base is noise
//    dressed as signal. Every rule that can fire on a ratio also requires a
//    minimum absolute movement, and DELTA_MIN_ABSOLUTE exports that floor to the
//    renderer so the per-card delta badge obeys it too.
//
// Signal shape: { severity, kind, host, headline, evidence, action, href, recurrence }
//   severity 1 = act today, 2 = look at it, 3 = context.
//   evidence  = the numbers that justify the call.
//   action    = one imperative sentence.
//   href      = deep link to the card that holds the evidence.
//   recurrence = consecutive prior days the same (kind, host) fired, or null when
//                the loaded history cannot answer that honestly. Spec item 11
//                owns real recurrence; a wrong "3rd consecutive day" is worse
//                than an absent one, so nothing here guesses.

import { FLAT_PAGES_PER_SESSION } from "./bots.js";
import { looksMalformed } from "./urls.js";

// Session-delta floors. Shared with the renderer's delta badge so the page shows
// a percentage exactly when a percentage could mean something.
export const SIGNAL_MIN_ABSOLUTE_CHANGE = 25;
export const DELTA_MIN_ABSOLUTE = SIGNAL_MIN_ABSOLUTE_CHANGE;
export const RISE_MIN_DELTA = 0.25;
export const DROP_MAX_DELTA = -0.25;

// likely-bot-subflood: a crawler spike sitting just under FLOOD_MIN_VISITS, which
// the flood classifier is right not to fire on (below 500 sessions a flood is
// indistinguishable from noise on volume alone) but which the four shape tests
// together identify with no volume ambiguity at all.
//
// The volume floor here is 50 sessions of absolute change and 100 resulting
// sessions, NOT the 100 absolute change the spec originally wrote down. The live
// case this rule exists for — wiki.freecapitalists.org on 2026-08-13, 151
// sessions up from about 54 — is an absolute change of +97 and would have failed
// its own rule. The other three tests are what make a low volume floor safe:
// a real 100-session day is not simultaneously flat, ~all direct, and ~all
// landing on one URL.
export const SUBFLOOD_MIN_DELTA = 1.0;             // +100%
export const SUBFLOOD_MIN_ABSOLUTE_CHANGE = 50;
export const SUBFLOOD_MIN_VISITS = 100;
export const SUBFLOOD_DIRECT_SHARE = 0.8;
export const SUBFLOOD_TOP_PAGE_SHARE = 0.8;

// error-spike, over daily_zone_status history. Both a relative and an absolute
// trigger, plus two floors so a 2x rise from 0.1% to 0.2% cannot fire.
export const ERROR_BASELINE_DAYS = 14;
export const ERROR_MIN_BASELINE_DAYS = 3;
export const ERROR_SPIKE_MULTIPLE = 2;
export const ERROR_SPIKE_POINTS = 0.05;
export const ERROR_MIN_SHARE = 0.02;
export const ERROR_MIN_REQUESTS = 50;

export const MALFORMED_MIN_PATHS = 3;

// The card anchor renderer and engine agree on. Exported so render.js builds its
// section ids from the same function the hrefs are built from.
export const cardAnchor = (host) => `site-${String(host).replace(/[^a-z0-9]/gi, "-")}`;

const pctText = (value, digits = 0) => `${(Number(value || 0) * 100).toFixed(digits)}%`;
const num = (value) => Number(value || 0).toLocaleString("en-US");
const isRum = (site) => (site?.measurement ?? (site?.zoneSourced ? "zone" : "rum")) === "rum";

// Requests and error requests per day for one zone host, from rows that are
// already loaded: daily_zone_status for the error counts, daily_traffic.views
// for the denominator (a zone host's "views" is its raw HTTP request count).
function errorSeries(host, zoneStatusRows, trafficRows) {
  const errors = new Map();
  // A day with no daily_zone_status row at all was not measured — the table
  // arrived with a later migration, or that night's pull failed. Counting it as
  // a 0% error day would drag the baseline down and manufacture a spike out of an
  // ordinary day, so unmeasured days are absent from the series rather than zero.
  const measured = new Set();
  for (const row of zoneStatusRows ?? []) {
    if (row.host !== host) continue;
    measured.add(row.date);
    if (Number(row.status) < 400) continue;
    errors.set(row.date, (errors.get(row.date) ?? 0) + Number(row.requests || 0));
  }
  const series = [];
  for (const row of trafficRows ?? []) {
    if (row.host !== host || !measured.has(row.date)) continue;
    const requests = Number(row.views || 0);
    if (!requests) continue;
    series.push({ date: row.date, requests, errorRequests: errors.get(row.date) ?? 0,
      share: (errors.get(row.date) ?? 0) / requests });
  }
  return series.sort((a, b) => a.date.localeCompare(b.date));
}

// Share of entrances taken by the single busiest landing page. The denominator is
// the larger of the measured entrances and the site's session count, because only
// the top rows are kept per day — taking the smaller one would inflate the share
// and make the subflood rule easier to trip, which is the wrong direction for a
// rule that tells the reader to discount their own traffic.
function topLandingShare(site) {
  const rows = site.cfPages ?? [];
  if (!rows.length) return { share: 0, page: null, entries: 0 };
  const entries = rows.reduce((sum, row) => sum + Number(row.visits || 0), 0);
  const top = rows.reduce((best, row) => (Number(row.visits || 0) > Number(best.visits || 0) ? row : best), rows[0]);
  const denominator = Math.max(entries, Number(site.visits || 0));
  return { share: denominator ? Number(top.visits || 0) / denominator : 0,
    page: top.page, entries: Number(top.visits || 0) };
}

// Consecutive days ending at `date` on which this host was crawler-flooded.
// The one recurrence the loaded history answers exactly, and only in the 24h
// view: at periodDays === 1 a flooded day is precisely a day whose delta was
// suppressed, so "flooded N days running" and "no-comparison fired N days
// running" are the same statement. Every other rule gets null (see the header).
function floodRun(floodDates, date) {
  if (!floodDates?.size || !floodDates.has(date)) return null;
  let run = 0;
  const cursor = new Date(`${date}T00:00:00Z`);
  while (floodDates.has(cursor.toISOString().slice(0, 10))) {
    run += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return run;
}

// Rank inside a severity band: how big the thing is, in its own units. Rough
// across kinds by design — severity is the real ordering, this only breaks ties.
function weigh(kind, site, extra) {
  switch (kind) {
    case "error-spike": return extra.errorRequests;
    case "likely-bot-subflood": return Math.abs(extra.absolute);
    case "traffic-drop":
    case "traffic-rise": return Math.abs(extra.absolute);
    case "malformed-urls": return extra.count * 10;
    case "search-opportunity": return extra.count;
    case "no-comparison": return Number(site.visits || 0);
    default: return 0;
  }
}

/**
 * @param {object} input
 * @param {Array}  input.sites      shaped site rows from loadDashboard
 * @param {string} input.date       the latest snapshot date
 * @param {number} input.periodDays 1 | 7 | 30
 * @param {Array}  input.zoneStatusRows  {date,host,status,requests} over the history window
 * @param {Array}  input.trafficRows     {date,host,visits,views} over the history window
 * @param {Map}    input.floodDatesByHost Map<host, Set<date>>
 */
export function computeSignals({ sites = [], date = null, periodDays = 1,
  zoneStatusRows = [], trafficRows = [], floodDatesByHost = new Map() } = {}) {
  const ranked = [];
  const add = (signal, weight) => ranked.push({ signal, weight });

  for (const site of sites) {
    const host = site.host;
    const href = `#${cardAnchor(host)}`;
    const rum = isRum(site);

    // ---- Zone-only rules --------------------------------------------------
    if (!rum) {
      const series = errorSeries(host, zoneStatusRows, trafficRows);
      const today = series.at(-1);
      const prior = series.slice(0, -1).slice(-ERROR_BASELINE_DAYS);
      if (today && (!date || today.date === date) && prior.length >= ERROR_MIN_BASELINE_DAYS
        && today.errorRequests >= ERROR_MIN_REQUESTS && today.share >= ERROR_MIN_SHARE) {
        const mean = prior.reduce((sum, day) => sum + day.share, 0) / prior.length;
        const spike = today.share >= mean * ERROR_SPIKE_MULTIPLE
          || today.share - mean >= ERROR_SPIKE_POINTS;
        if (spike) {
          add({
            severity: 1, kind: "error-spike", host,
            headline: `${host} error responses are ${pctText(today.share, 1)} of requests`,
            evidence: `${num(today.errorRequests)} responses ≥ 400 out of ${num(today.requests)} requests, ` +
              `against a ${prior.length}-day mean of ${pctText(mean, 1)}.`,
            action: "Check the top failing paths below and fix or redirect them.",
            href, recurrence: null,
          }, weigh("error-spike", site, today));
        }
      }
      // Every other rule below is a session-shaped or content-shaped claim about
      // a RUM site. A zone host has no sessions and no landing pages in the same
      // sense, so it is not merely a weaker signal there — it is a different
      // quantity wearing the same words. Zone hosts stop here.
      continue;
    }

    // ---- RUM rules --------------------------------------------------------
    const visits = Number(site.visits || 0);
    const previousVisits = Number(site.previousVisits || 0);
    const absolute = visits - previousVisits;
    const delta = site.delta;
    const hasDelta = delta !== null && delta !== undefined && Number.isFinite(delta);
    const directShare = visits ? Number(site.sources?.direct || 0) / visits : 0;
    const pagesPerSession = Number(site.pagesPerSession || 0);
    const landing = topLandingShare(site);

    // likely-bot-subflood. Mutually exclusive with traffic-rise by construction:
    // the rise rule below is guarded on this not having fired.
    const subflood = hasDelta
      && delta >= SUBFLOOD_MIN_DELTA
      && absolute >= SUBFLOOD_MIN_ABSOLUTE_CHANGE
      && visits >= SUBFLOOD_MIN_VISITS
      && pagesPerSession > 0 && pagesPerSession <= FLAT_PAGES_PER_SESSION
      && directShare >= SUBFLOOD_DIRECT_SHARE
      && landing.share >= SUBFLOOD_TOP_PAGE_SHARE;
    if (subflood) {
      add({
        severity: 1, kind: "likely-bot-subflood", host,
        headline: `${host} is up ${pctText(delta, 0)}, and it looks like a crawler rather than growth`,
        evidence: `${num(visits)} sessions (was ${num(previousVisits)}), ${pctText(directShare, 0)} direct, ` +
          `${pagesPerSession.toFixed(1)} pages/session, ${pctText(landing.share, 0)} of entrances on ${landing.page}.`,
        action: "Treat as crawler traffic, not growth, and consider lowering the flood floor for this host.",
        href, recurrence: null,
      }, weigh("likely-bot-subflood", site, { absolute }));
    }

    // malformed-urls. Item 10 owns badging the individual rows; this counts them.
    const malformed = (site.cfPages ?? []).filter((row) => looksMalformed(row.page));
    if (malformed.length >= MALFORMED_MIN_PATHS) {
      add({
        severity: 2, kind: "malformed-urls", host,
        headline: `${host} is serving ${malformed.length} malformed URLs`,
        evidence: `${malformed.length} landing pages contain encoded markup or tag fragments, e.g. ${malformed[0].page}.`,
        action: "Fix the broken links generating these, then redirect or noindex the junk URLs.",
        href, recurrence: null,
      }, weigh("malformed-urls", site, { count: malformed.length }));
    }

    // search-opportunity. Deliberately ONE generic rule off the shared
    // isOpportunity predicate (counted into site.opportunityCount by
    // loadDashboard), not the spec's `snippet-gap`: telling the reader to rewrite
    // a title and description is only correct for a page that already ranks, and
    // the snippet-vs-rank split that distinguishes those two remedies is spec
    // item 7 and does not exist yet. Item 7 replaces this rule with two.
    const opportunities = Number(site.opportunityCount || 0);
    if (opportunities >= 1) {
      add({
        severity: 2, kind: "search-opportunity", host,
        headline: `${host} has ${opportunities} search ${opportunities === 1 ? "query" : "queries"} ranking without clicks`,
        evidence: `${opportunities} ${opportunities === 1 ? "query is" : "queries are"} on page one or two with a CTR near zero.`,
        action: "Open the search panel and rewrite the titles and meta descriptions for those pages.",
        href, recurrence: null,
      }, weigh("search-opportunity", site, { count: opportunities }));
    }

    // traffic-drop / traffic-rise. Both floored on absolute change, so a
    // 6-to-7-session site never reaches the list.
    if (hasDelta && delta <= DROP_MAX_DELTA && Math.abs(absolute) >= SIGNAL_MIN_ABSOLUTE_CHANGE) {
      add({
        severity: 2, kind: "traffic-drop", host,
        headline: `${host} sessions fell ${pctText(Math.abs(delta), 0)}`,
        evidence: `${num(visits)} sessions, down ${num(Math.abs(absolute))} from ${num(previousVisits)}.`,
        action: "Compare the referrer list against the previous period to find what stopped.",
        href, recurrence: null,
      }, weigh("traffic-drop", site, { absolute }));
    }
    if (!subflood && hasDelta && delta >= RISE_MIN_DELTA && Math.abs(absolute) >= SIGNAL_MIN_ABSOLUTE_CHANGE) {
      add({
        severity: 3, kind: "traffic-rise", host,
        headline: `${host} sessions rose ${pctText(delta, 0)}`,
        evidence: `${num(visits)} sessions, up ${num(absolute)} from ${num(previousVisits)}.`,
        action: "Check which referrer drove it before counting it as growth.",
        href, recurrence: null,
      }, weigh("traffic-rise", site, { absolute }));
    }

    // no-comparison. Says out loud what the page used to leave silent: a flooded
    // site simply dropped out of NOTABLE because site.delta was null, with no
    // explanation rendered anywhere.
    const partial = Number(site.partialDays || 0) > 0 || Number(site.previousPartialDays || 0) > 0;
    if (!hasDelta && partial) {
      add({
        severity: 3, kind: "no-comparison", host,
        headline: `${host} has no like-for-like comparison`,
        evidence: `${num(visits)} sessions is a floor: ${Number(site.partialDays || 0) > 0 ? "this" : "the previous"} ` +
          `period contains a crawler-flooded day whose direct bucket is not separable.`,
        action: "Read the figure as a floor, and wait for a clean day before judging the trend.",
        href,
        recurrence: periodDays === 1 ? floodRun(floodDatesByHost.get(host), date) : null,
      }, weigh("no-comparison", site, {}));
    }
  }

  ranked.sort((a, b) => a.signal.severity - b.signal.severity || b.weight - a.weight
    || a.signal.host.localeCompare(b.signal.host));
  return ranked.map((entry) => entry.signal);
}
