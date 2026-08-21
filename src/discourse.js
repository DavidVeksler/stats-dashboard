// Pulls forum user login/activity stats from each Discourse forum's own public
// /about.json, one snapshot per (date, host) into daily_forum_activity — the
// same daily-snapshot shape every other table here uses, so the existing
// 14-day-mean and sparkline machinery applies unchanged.
//
// No API key: `about.stats` (active_users_last_day/7_days/30_days, users_count,
// users_last_day/7_days/30_days, posts_*, topics_count) is served to anonymous
// requests on both forums today — it's the same rolling-window counters
// Discourse's own admin dashboard reads, not something re-derived from the
// paginated /admin/users/list/active.json (which would need an admin key and
// thousands of paginated rows to answer the same question). If a forum ever
// sets `login_required` or otherwise hides about stats, this pull starts
// failing loudly (a non-200 or an empty stats object) rather than silently —
// see parseAboutStats's zero-fallback and the try/catch around the call site
// in index.js, which records a note instead of failing the whole night's write.
const FORUM_UA = "Mozilla/5.0 (compatible; stats-dashboard/1.0; +https://stats.davidveksler.com)";

// Pure and separated from the fetch so it's testable without a live request
// (see scripts/discourse-check.mjs). Defaults every field to 0 rather than
// throwing on a missing key — `stats` can in principle come back empty
// (`can_see_about_stats: false`) while the request itself still 200s.
export function parseAboutStats(stats) {
  const s = stats || {};
  const n = (key) => Number(s[key] || 0);
  return {
    usersCount: n("users_count"),
    activeToday: n("active_users_last_day"),
    active7d: n("active_users_7_days"),
    active30d: n("active_users_30_days"),
    newToday: n("users_last_day"),
    new7d: n("users_7_days"),
    new30d: n("users_30_days"),
    postsToday: n("posts_last_day"),
    postsCount: n("posts_count"),
    topicsCount: n("topics_count"),
  };
}

export async function pullForumStats(host) {
  const res = await fetch(`https://${host}/about.json`, { headers: { "user-agent": FORUM_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return parseAboutStats(body?.about?.stats);
}
