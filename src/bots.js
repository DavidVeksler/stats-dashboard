// Separating crawler floods from human traffic.
//
// We deliberately do NOT block crawlers (the sites opt into AI training via
// Content-Signal). The problem is purely one of measurement: a headless-Chrome
// crawler fires the RUM beacon exactly like a person does, so Cloudflare counts
// it as a session and the dashboard's headline numbers become fiction.
//
// The signature comes from the Aug 2026 floods (forum.objectivismonline.com,
// wiki.freecapitalists.org, freecapitalists.org): every "session" was a single
// pageview with no referrer, sustained for days, spread across thousands of URLs.
// Any one of those traits alone is normal — a viral link is direct and spiky, a
// single-page site is flat — so we require all of them together plus volume.

export const FLOOD_MIN_VISITS = 500;   // below this, a "flood" is indistinguishable from noise
export const FLOOD_MULTIPLE = 3;       // ...and must be this many times a normal day
const FLAT_PAGES_PER_SESSION = 1.15;   // humans click through; crawlers hit one URL and leave
const DIRECT_SHARE = 0.9;              // crawlers send no referer

const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : 0;

// Build per-host, per-day traffic shape and mark the crawler-flooded days.
//
// trafficRows:  { date, host, visits, views }     from daily_traffic
// referrerRows: { date, host, kind, visits }      from daily_referrers, grouped by kind
//
// Returns Map<host, Map<date, day>> where day carries { visits, views, direct,
// directShare, pagesPerSession, signature, baseline, flood }.
export function classifyTraffic(trafficRows, referrerRows) {
  const byHost = new Map();
  for (const row of trafficRows ?? []) {
    if (!byHost.has(row.host)) byHost.set(row.host, new Map());
    byHost.get(row.host).set(row.date, {
      date: row.date,
      visits: Number(row.visits || 0),
      views: Number(row.views || 0),
      direct: 0,
    });
  }
  for (const row of referrerRows ?? []) {
    if (row.kind !== "direct") continue;
    const day = byHost.get(row.host)?.get(row.date);
    if (day) day.direct += Number(row.visits || 0);
  }

  for (const days of byHost.values()) {
    const all = [...days.values()];
    for (const day of all) {
      day.pagesPerSession = day.visits ? day.views / day.visits : 0;
      day.directShare = day.visits ? day.direct / day.visits : 0;
      // Shape only — deliberately volume-free, so the baseline below can be built
      // from the days that fail this test without reasoning in a circle.
      day.signature = day.visits > 0 &&
        day.pagesPerSession > 0 && day.pagesPerSession <= FLAT_PAGES_PER_SESSION &&
        day.directShare >= DIRECT_SHARE;
    }
    // Normal days set the bar for what "normal" means. When a flood runs long
    // enough that too few clean days remain, fall back to the 25th percentile of
    // everything: a median would by then be half-built from flood days and would
    // quietly bless the flood as the new baseline. That is exactly how the
    // forum.objectivismonline.com flood went unflagged for eight days.
    const cleanVisits = all.filter((day) => !day.signature).map((day) => day.visits).sort((a, b) => a - b);
    const allVisits = all.map((day) => day.visits).sort((a, b) => a - b);
    const baseline = cleanVisits.length >= 3 ? quantile(cleanVisits, .5) : quantile(allVisits, .25);
    for (const day of all) {
      day.baseline = baseline;
      day.flood = day.signature && day.visits >= FLOOD_MIN_VISITS &&
        day.visits >= Math.max(baseline, 1) * FLOOD_MULTIPLE;
    }
  }
  return byHost;
}

// Human-readable explanation for a flooded day, for the card callout.
export function floodReason(day) {
  if (!day?.flood) return null;
  return `${Math.round(day.directShare * 100)}% direct, ${day.pagesPerSession.toFixed(1)} pages/session, ` +
    `${Math.round(day.visits / Math.max(day.baseline, 1))}x a normal day`;
}

// Dates (per host) that were crawler-flooded, for filtering referrer and
// landing-page rows so the detail panels agree with the headline numbers.
export function floodDates(classified, host) {
  const days = classified.get(host);
  if (!days) return new Set();
  return new Set([...days.values()].filter((day) => day.flood).map((day) => day.date));
}
