// Checks the pure parsing half of the forum-activity pull (src/discourse.js).
// pullForumStats itself needs a live fetch, so it's kept separate from
// parseAboutStats specifically so the parsing logic can be verified here,
// offline, the same way the rest of this project keeps pure logic testable.
import { parseAboutStats } from "../src/discourse.js";

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return;
  failures += 1;
  console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
}

// A real about.json `stats` shape (trimmed to the fields this dashboard reads),
// taken from forum.freecapitalists.org on 2026-08-21.
const live = parseAboutStats({
  topics_count: 26291, posts_last_day: 0, posts_count: 398996,
  users_last_day: 0, users_7_days: 0, users_30_days: 0, users_count: 59180,
  active_users_last_day: 3, active_users_7_days: 3, active_users_30_days: 3,
});
check("usersCount", live.usersCount, 59180);
check("activeToday", live.activeToday, 3);
check("active7d", live.active7d, 3);
check("active30d", live.active30d, 3);
check("newToday", live.newToday, 0);
check("postsCount", live.postsCount, 398996);
check("topicsCount", live.topicsCount, 26291);

// `can_see_about_stats` can in principle go false while the request still
// 200s, so a missing or empty stats object must default every field to 0
// rather than throwing — the call site in index.js relies on this to record
// a note instead of crashing the night's write.
const empty = parseAboutStats({});
for (const key of ["usersCount", "activeToday", "active7d", "active30d",
  "newToday", "new7d", "new30d", "postsToday", "postsCount", "topicsCount"]) {
  check(`empty stats: ${key} defaults to 0`, empty[key], 0);
}
const missing = parseAboutStats(undefined);
check("undefined stats: usersCount defaults to 0", missing.usersCount, 0);

if (failures) {
  console.error(`\n${failures} discourse check(s) failed`);
  process.exit(1);
}
console.log("Discourse forum-activity checks passed");
