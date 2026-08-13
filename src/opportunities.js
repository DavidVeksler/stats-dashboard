// The single definition of "this search query is an opportunity".
//
// This predicate used to exist twice — once in loadDashboard (over every stored
// keyword row, feeding the headline count) and once in render.js (over the top
// twelve rows only, drawing the badge). They agreed by coincidence of
// maintenance rather than by construction, and because they ran over different
// row sets the headline count could legitimately exceed the visible badges with
// no way to tell that from a bug. Both now import from here.
//
// The thresholds are named so that changing one changes it everywhere,
// including the footer prose that explains them to the reader.

export const OPPORTUNITY_MIN_IMPRESSIONS = 5;  // below this, CTR is not a measurement
export const OPPORTUNITY_MIN_POSITION = 4;     // already ranking, just not clicked
export const OPPORTUNITY_MAX_POSITION = 20;    // beyond page two, CTR is not the problem
export const OPPORTUNITY_MAX_CTR = 0.04;       // what "not clicked" means here

// Accepts either a raw D1 keyword row ({ clicks, impressions, position }) or the
// shaped row the renderer holds, which carries a precomputed `ctr`. CTR is
// recomputed from clicks/impressions when it is absent so the two call sites
// cannot drift on how the ratio is derived either.
export function isOpportunity(row) {
  if (!row) return false;
  const impressions = Number(row.impressions || 0);
  const position = Number(row.position || 0);
  if (impressions < OPPORTUNITY_MIN_IMPRESSIONS) return false;
  if (position < OPPORTUNITY_MIN_POSITION || position > OPPORTUNITY_MAX_POSITION) return false;
  const ctr = impressions ? Number(row.clicks || 0) / impressions : 0;
  return ctr < OPPORTUNITY_MAX_CTR;
}
