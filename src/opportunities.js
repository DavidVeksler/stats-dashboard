// The single definition of "this search query is an opportunity", and of which
// KIND of opportunity it is.
//
// This predicate used to exist twice — once in loadDashboard (over every stored
// keyword row, feeding the headline count) and once in render.js (over the top
// twelve rows only, drawing the badge). They agreed by coincidence of
// maintenance rather than by construction, and because they ran over different
// row sets the headline count could legitimately exceed the visible badges with
// no way to tell that from a bug. Both still import from here.
//
// What changed in spec item 8's sibling, item 7: one label used to cover two
// opposite problems. A 0% CTR at position 8 is a SNIPPET problem — the page
// ranks, the title and description are not earning the click, and the remedy is
// a rewrite. A 0% CTR at position 31 is a RANKING problem — nobody ever saw the
// snippet, and the remedy is content and links. The remedies share nothing, so
// the classes are separate and, critically, **they are ranked by different
// metrics**:
//
//   snippet -> lost clicks      = impressions x (expectedCtr(position) - ctr)
//   rank    -> potential clicks = impressions x expectedCtr(TARGET_POSITION) - clicks
//
// Lost clicks measures what is recoverable AT THE CURRENT RANK. That is exactly
// the right question for a snippet rewrite and exactly the wrong one for a
// ranking problem, where the whole value is in moving up. Ranking both classes by
// lost clicks guarantees that deep-ranking, business-critical queries always lose
// to shallow ones: `bitcoin recovery` on walletrecovery.info (13 impressions, 0
// clicks, position 31.2) has ~0.07 lost clicks at its current rank and ~0.94
// potential clicks at position 5. It is the second number that says whether the
// work is worth doing.
//
// Thresholds are tuned for the window this dashboard actually stores: GSC is
// queried over a THREE-DAY window (date-4 .. date-2, see runDaily), so impression
// counts are small. Floors written for a 30-day window suppress everything here —
// the spec's original `impressions >= 20` gate would have hidden the very query
// that motivated the split.

// Where a `rank` opportunity is being moved TO. Not "position 1": the honest
// question is what the page would earn at a realistic top-of-page-one rank, and
// promising position 1 turns a comparator into a sales pitch.
export const TARGET_POSITION = 5;

// Class boundaries. Above SNIPPET_MAX_POSITION the page is on page one or the
// top of page two and the snippet is what is failing; past RANK_MAX_POSITION the
// query is "watch" — real, but not this week's work, so it is neither badged nor
// counted.
export const SNIPPET_MAX_POSITION = 15;
export const RANK_MAX_POSITION = 50;

// Below this, CTR is not a measurement — one stray click swings it by 20 points.
export const OPPORTUNITY_MIN_IMPRESSIONS = 5;

// A query needs this many impressions before its average position is worth
// putting into the median-position tile. Higher than the CTR floor above because
// a position on two impressions is a coin flip, still low because the window is
// only three days.
export const POSITION_MIN_IMPRESSIONS = 10;

// A snippet is "not earning its position" when it takes less than half the CTR
// its rank would ordinarily deliver. Half, not "any shortfall", because the
// benchmark curve below is an approximation and a 10% shortfall against an
// approximation is not a finding.
export const SNIPPET_CTR_RATIO = 0.5;

// Both classes need the gain to be worth a person's afternoon. Half a click over
// the three-day window is a deliberately low floor — it is there to strip
// arithmetic noise (5 impressions at position 40), not to editorialize — and it
// scales with the curve, so a deep query needs more impressions to qualify than a
// shallow one.
export const MIN_ACTIONABLE_CLICKS = 0.5;

// Cannibalization (spec item 17): one query whose impressions are split across
// two or more of the site's own pages. "Strengthen the page" is the wrong fix
// there — Google is already choosing between two of them — so it is its own
// list and its own signal rather than a third opportunity class.
//
// A query needs this many stored impressions before a split means anything;
// higher than OPPORTUNITY_MIN_IMPRESSIONS because a 3/2 split on five
// impressions is not two pages competing, it is noise. And each competing page
// must hold at least this share of the query's stored impressions: a page
// taking 3% of a query's impressions is a stray, not a competitor.
export const CANNIBAL_MIN_IMPRESSIONS = 20;
export const CANNIBAL_MIN_SHARE = 0.25;

// Expected organic CTR by average position.
//
// SOURCE (measured anchors, marked below): SISTRIX, "Why (almost) everything you
// knew about Google CTR is no longer valid", published 2020-07-14, over ~80
// million keywords / billions of Google search results. Positions 1, 2, 3 and 10
// are the figures that study reports (28.5%, 15%, 11%, 2.5%).
//
// The intermediate positions are NOT from the study: they are log-linear
// (geometric) interpolation between its anchors, which reproduces the published
// curve's shape closely (position 5 lands on 7.2%, matching the commonly cited
// figure) but is still our arithmetic, not Google's data. Everything past
// position 10 is our own conservative approximation of a long, flat tail; SISTRIX
// does not publish per-position figures out there.
//
// Consequences for anything downstream: this is an APPROXIMATION of a 2020
// desktop+mobile average across every query intent there is. Branded queries beat
// it, informational queries with an AI Overview above them lose to it badly, and
// the whole curve has drifted since 2020. Do not render a number derived from it
// with more than one decimal place, do not present it as a target, and do not
// build a threshold that fires on a small shortfall against it (see
// SNIPPET_CTR_RATIO). It is a comparator, not a measurement.
const CTR_ANCHORS = [
  [1, 0.285],   // measured
  [2, 0.150],   // measured
  [3, 0.110],   // measured
  [10, 0.025],  // measured
  [15, 0.015],  // approximated from here down
  [20, 0.010],
  [30, 0.006],
  [50, 0.003],
  [100, 0.001],
];

export function expectedCtr(position) {
  const p = Number(position);
  if (!Number.isFinite(p) || p <= CTR_ANCHORS[0][0]) return CTR_ANCHORS[0][1];
  const last = CTR_ANCHORS[CTR_ANCHORS.length - 1];
  if (p >= last[0]) return last[1];
  for (let i = 1; i < CTR_ANCHORS.length; i += 1) {
    const [x1, y1] = CTR_ANCHORS[i - 1];
    const [x2, y2] = CTR_ANCHORS[i];
    if (p > x2) continue;
    // Geometric, not linear: CTR decays multiplicatively with rank, and straight
    // lines between the anchors would overstate positions 4-9 by a third.
    return y1 * Math.pow(y2 / y1, (p - x1) / (x2 - x1));
  }
  return last[1];
}

// Compiled `queryDenyPatterns` per site object. See config.js for what the field
// is for and why it ships empty on every site.
const denyCache = new WeakMap();
function denyRegexes(site) {
  const patterns = site?.queryDenyPatterns;
  if (!Array.isArray(patterns) || !patterns.length) return [];
  const cached = denyCache.get(site);
  if (cached) return cached;
  const compiled = [];
  for (const pattern of patterns) {
    try {
      compiled.push(pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i"));
    } catch (_) {
      // A malformed pattern denies nothing. Failing closed here would mean one
      // typo in config.js silently emptying a site's opportunity list, which is
      // worse than the pattern not applying.
    }
  }
  denyCache.set(site, compiled);
  return compiled;
}

// Denied queries stay in the rendered query list — the data is what it is — and
// are excluded only from the two opportunity classes and the headline count.
export function isDeniedQuery(query, site = null) {
  const text = String(query ?? "");
  if (!text) return false;
  return denyRegexes(site).some((re) => re.test(text));
}

/**
 * Classify one keyword row. Accepts either a raw D1 row ({ query, clicks,
 * impressions, position }) or the renderer's shaped row (which carries a
 * precomputed `ctr`); CTR is recomputed from clicks/impressions either way so
 * the two call sites cannot drift on how the ratio is derived.
 *
 * @returns {null | { kind: "snippet"|"rank", score, lostClicks, potentialClicks,
 *                    expectedCtr, ctr, position, impressions, clicks }}
 */
export function classifyOpportunity(row, site = null) {
  if (!row) return null;
  const impressions = Number(row.impressions || 0);
  const position = Number(row.position || 0);
  if (!(position > 0) || impressions < OPPORTUNITY_MIN_IMPRESSIONS) return null;
  // "watch": ranking this deep is a content project, not a task.
  if (position > RANK_MAX_POSITION) return null;
  if (isDeniedQuery(row.query, site)) return null;

  const clicks = Number(row.clicks || 0);
  const ctr = impressions ? clicks / impressions : 0;
  const expected = expectedCtr(position);

  if (position <= SNIPPET_MAX_POSITION) {
    if (ctr >= expected * SNIPPET_CTR_RATIO) return null;   // performing at its position
    const lostClicks = impressions * (expected - ctr);
    if (lostClicks < MIN_ACTIONABLE_CLICKS) return null;
    return { kind: "snippet", position, impressions, clicks, ctr, expectedCtr: expected,
      lostClicks, potentialClicks: null, score: lostClicks };
  }

  const potentialClicks = impressions * expectedCtr(TARGET_POSITION) - clicks;
  if (potentialClicks < MIN_ACTIONABLE_CLICKS) return null;
  return { kind: "rank", position, impressions, clicks, ctr, expectedCtr: expected,
    lostClicks: null, potentialClicks, score: potentialClicks };
}

// The boolean form, kept because "is this row badged" is what most call sites
// want. Both the badge and the count go through classifyOpportunity, so they
// cannot disagree about a row.
export function isOpportunity(row, site = null) {
  return classifyOpportunity(row, site) !== null;
}

// Split a site's keyword rows into the two classes, each sorted by ITS OWN
// metric. Sorting both by lost clicks is the bug this function exists to prevent.
export function rankOpportunities(rows, site = null) {
  const snippet = [];
  const rank = [];
  for (const row of rows ?? []) {
    const found = classifyOpportunity(row, site);
    if (!found) continue;
    (found.kind === "snippet" ? snippet : rank).push({ query: row.query, ...found });
  }
  const byScore = (a, b) => b.score - a.score || String(a.query).localeCompare(String(b.query));
  snippet.sort(byScore);
  rank.sort(byScore);
  return { snippet, rank };
}

// ---- Query-to-page join (spec item 17) -------------------------------------
//
// Everything below is a pure function of daily_query_pages rows loadDashboard
// has already read for the latest snapshot. None of it changes what
// classifyOpportunity decides about a query — the page is attached BESIDE the
// verdict, never used to make it — so a badge and a "Pages to fix" entry cannot
// disagree about whether a query is an opportunity.

// Group one site's (query, page) rows by query. Each query's pages are sorted by
// impressions, descending, and carry `share`: that page's fraction of the
// query's stored impressions. `Object.create(null)` rather than a Map so the
// result survives JSON.stringify for /api/json and a query literally named
// "constructor" cannot collide with a prototype property.
export function groupQueryPages(rows) {
  const byQuery = Object.create(null);
  for (const row of rows ?? []) {
    const query = String(row.query ?? "");
    if (!query || !row.page) continue;
    (byQuery[query] ??= []).push({
      page: row.page,
      clicks: Number(row.clicks || 0),
      impressions: Number(row.impressions || 0),
      position: Number(row.position || 0),
    });
  }
  for (const pages of Object.values(byQuery)) {
    pages.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks
      || String(a.page).localeCompare(String(b.page)));
    const total = pages.reduce((sum, page) => sum + page.impressions, 0);
    for (const page of pages) page.share = total > 0 ? page.impressions / total : 0;
  }
  return byQuery;
}

// The page a query row should point the reader at: the one holding the largest
// share of its stored impressions. Null when the pairs carry no row for it —
// a query stored before daily_query_pages existed, or one whose pairs were cut
// by QUERY_PAGE_ROW_LIMIT — in which case the row simply carries no page, the
// same way a pre-`internal` referrer row carries no kind.
export function pageForQuery(query, queryPages) {
  const pages = queryPages?.[String(query ?? "")];
  if (!pages?.length) return { page: null, pageShare: null, pageCount: 0 };
  return { page: pages[0].page, pageShare: pages[0].share, pageCount: pages.length };
}

// Attach each opportunity row's page (see pageForQuery). Returns a new
// { snippet, rank } with the same rows in the same order — the class metric and
// the ranking are untouched.
export function attachPages(opportunities, queryPages) {
  const attach = (rows) => (rows ?? []).map((row) => ({ ...row, ...pageForQuery(row.query, queryPages) }));
  return { snippet: attach(opportunities?.snippet), rank: attach(opportunities?.rank) };
}

// Regroup the two opportunity classes by page, each ranked by ITS OWN class's
// metric summed over the page's queries. Two lists, two metrics, never one:
// item 7's rule survives the change of grain from query to page unchanged, and
// for the same reason — a page's recoverable-at-current-rank clicks and its
// out-of-reach-until-it-ranks clicks answer different questions with different
// fixes, and adding them would rank a snippet job against a content job on a
// number that means neither.
//
// Rows with no page (see pageForQuery) are skipped here, not lumped under a
// synthetic "(unknown)" page: an entry the reader cannot open is not a page to
// fix.
export function rankPageOpportunities(opportunities) {
  const group = (rows, metric) => {
    const byPage = new Map();
    for (const row of rows ?? []) {
      if (!row.page) continue;
      const acc = byPage.get(row.page) ?? { page: row.page, queries: 0, [metric]: 0, topQuery: row.query };
      acc.queries += 1;
      acc[metric] += Number(row[metric] || 0);
      byPage.set(row.page, acc);
    }
    return [...byPage.values()].sort((a, b) => b[metric] - a[metric]
      || String(a.page).localeCompare(String(b.page)));
  };
  return {
    snippet: group(opportunities?.snippet, "lostClicks"),
    rank: group(opportunities?.rank, "potentialClicks"),
  };
}

// Queries whose stored impressions are split across two or more pages, each
// holding at least CANNIBAL_MIN_SHARE of them, with at least
// CANNIBAL_MIN_IMPRESSIONS impressions in total. Ranked by impressions. A denied
// query (queryDenyPatterns) is excluded here too: "not pursuing this query" is
// an editorial call that covers consolidating pages for it as much as
// strengthening them.
export function findCannibalized(queryPages, site = null) {
  const out = [];
  for (const [query, pages] of Object.entries(queryPages ?? {})) {
    const impressions = pages.reduce((sum, page) => sum + page.impressions, 0);
    if (impressions < CANNIBAL_MIN_IMPRESSIONS) continue;
    const competing = pages.filter((page) => page.share >= CANNIBAL_MIN_SHARE);
    if (competing.length < 2) continue;
    if (isDeniedQuery(query, site)) continue;
    out.push({ query, impressions, pages: competing });
  }
  return out.sort((a, b) => b.impressions - a.impressions
    || String(a.query).localeCompare(String(b.query)));
}
