# Spec: make the dashboard actionable

Status: **items 1 through 8 implemented** — items 1–3 in `bd7e14d`, `b774260`, `ce541c1`,
`e28f6ba` (2026-08-12); items 4 and 5 in `c7eefc5` (2026-08-13); items 6, 7 and 8 in `e96c949`
(2026-08-13). Items 9, 10 and 11 proposed.
Written 2026-08-12 against the live page and `master` @ `6a07946`.

Audience: the implementing agent. Every work item names the exact file and line to change, plus an
acceptance test. Read `AGENTS.md` first for the data flow and the crawler-flood rules; where this
spec and `AGENTS.md` disagree about *current* behavior, `AGENTS.md` wins and this spec is stale.

## Problem statement

The dashboard is a strong observation surface and a weak decision surface. It reports what happened
with unusually honest provenance (crawler exclusions quantified, floors marked `≥`, GSC windows
labeled), but interpretation, prioritization, and prescription are all left to the reader. In several
cases the page already holds every fact needed to make the call and does not make it.

Two defects found during spec research are worse than a missing feature. They make headline numbers
wrong rather than merely unhelpful, so they are P0:

1. **The headline "pages / session" is an artifact.** `totals.views` (`src/index.js:497`) sums RUM
   pageviews and library.freecapitalists.org *HTTP requests* into one number. On 2026-08-13 that is
   20,897 "pageviews", of which 19,506 are library requests. Real RUM pageviews are 1,391 over 953
   RUM sessions, so the true figure is **1.46 pages/session, not the 10.4 displayed**.
2. **The one site that cannot be crawler-flagged is the single largest contributor to "human
   sessions".** `classifyTraffic` derives `directShare` from `daily_referrers` rows
   (`src/bots.js:54-56`); library never writes any (`src/index.js:89`), so `direct = 0`,
   `signature` is always false, and **a zone-sourced host can never be flagged as flooded no matter
   the volume**. Its raw crawler traffic flows straight into the "Human sessions" tile, which it
   supplies 1,059 of 2,012 sessions to (52.6%). The site's own top file is `/robots.txt` at 684
   requests.

## Governing principle

Every number on the page should answer one of: *is this normal?*, *what changed?*, *what do I do?*
A number that answers none of the three is decoration. Where the page cannot answer, it should say
so explicitly rather than presenting an uncontextualized figure.

## Non-goals

- Do not drop library.freecapitalists.org. It is a raw file index with no RUM tags and zone HTTP
  logs are the only instrumentation available. It stays tracked. The fix is to stop letting an
  incommensurable metric contaminate cross-site aggregates and rankings, not to remove it.
- Do not estimate or interpolate crawler traffic that was set aside. The existing floor-not-guess
  discipline (`AGENTS.md`, "A flooded day is partially recoverable") is preserved everywhere.
- Do not block or challenge crawlers. These sites opt into AI training; the fix stays measurement.
- No framework, no build step. Plain ES modules under `src/`, same as today.

---

# P0. Correctness of headline numbers

## 1. Separate measurement classes: RUM sessions vs zone requests — IMPLEMENTED (`bd7e14d`)

> Landed as specified, plus one thing the spec did not anticipate: `sourceMix` had to become
> RUM-only in the same commit rather than waiting for item 6. The mix bar's segment widths are
> `value / totals.visits`, so once `totals.visits` dropped to RUM-only while the zone host still
> contributed its 1,059 sessions to the `other` residual, the residual segment rendered wider than
> 100% of the bar. Item 6's remaining work — renaming the residual to `Unattributed`, moving it out
> of the bar, and writing self-referrals as `kind: "internal"` — is untouched.
> `site.measurement` (`"rum" | "zone"`) is the field that was added; `site.zoneSourced` stays as the
> same fact in boolean form, since the renderer and the check scripts already read it.


**Symptom.** The library card sits first in a traffic-sorted grid, styled identically to RUM cards,
using the word "sessions", with a value (1,059) that is Cloudflare's zone-log visit heuristic over
raw HTTP requests including `robots.txt` and `/cdn-cgi/*`. It is 52.6% of the headline. A reader
comparing it to freecapitalists.org's 291 RUM sessions is comparing two different quantities.

**Root cause.** `SITES` is one flat list; `loadDashboard` maps over all of it (`src/index.js:410`)
and `totals.visits`/`totals.views` reduce over every site with no `zoneSourced` filter
(`src/index.js:495-525`). The only concession today is cosmetic: the card label flips from
"human sessions" to "sessions" (`src/render.js:241`).

**Change.**

- In `loadDashboard`, partition `sites` on `site.zoneSourced` before computing totals.
  `totals.visits` and `totals.views` reduce over **RUM sites only**. Add a sibling object:

  ```
  totals.zone = { visits, requests, bytes, sites, hosts: [...] }
  ```

  Keep `sites` as one array (the cards still need it) and add `data.rumSites` / `data.zoneSites`
  index arrays, or a `site.measurement: "rum" | "zone"` field, whichever the implementer prefers.
  Derive `measurement` from `trafficSource` in `src/config.js` so nothing hardcodes a hostname.
- `totals.pagesPerSession` becomes RUM-only and therefore meaningful.
- KPI tiles (`src/render.js:313-326`): "Human sessions" subtitle becomes `"11 RUM sites · last 24
  hours"`. "Total pageviews" stays RUM-only.
- Add one **zone strip** below the KPI row, visually distinct from the tiles, reading e.g.
  `Zone-log sites (request counts, not comparable to RUM sessions): library.freecapitalists.org —
  19,506 requests · 1,059 zone visits · 71.4 GB`.
- Card grid (`src/render.js:406`): render RUM cards first, then a labeled section
  `Zone-log measurement` containing zone cards, each with a `card--zone` class and a one-line
  header note: `Counted from zone HTTP request logs (no RUM tag on this site). Requests include
  crawlers, assets, and robots.txt, so this is not comparable to the session counts above.`
- Sorting (`options.sort`) applies within each section, never across them.

**Acceptance.** With today's fixture: "Human sessions" reads 953, "Total pageviews" 1,391,
pages/session 1.46. `scripts/dashboard-check.mjs` gains an assertion that `totals.visits` excludes
every `zoneSourced` site. `scripts/render-check.mjs` asserts the zone card renders below a
`Zone-log measurement` heading and that the string `human sessions` never appears inside a
`card--zone` block.

## 2. Give zone-sourced sites their own crawler accounting — IMPLEMENTED (`b774260`)

> Landed with both lenses rather than one, because the spike's result made the choice between them
> false. Three corrections to what this section originally said:
>
> 1. The spike expected `verifiedBotCategory` to "report verified-bot vs likely-human requests
>    directly" and "end the item". It does not and cannot: the dimension labels only what Cloudflare
>    cryptographically verifies, so the unlabelled 84.6% is readers and unverified crawlers mixed
>    together, not a human bucket. Verified bots are a **floor** on crawler volume. The fallback lens
>    was therefore built too, and both ship, with an explicit rendered note that they overlap and
>    must not be added.
> 2. The fallback's "report the card's primary number as content requests" was dropped. Subtracting
>    non-content from the headline would imply the remainder is content requested by people, which is
>    exactly the assertion this item exists to prevent. The headline stays the zone-visit figure item
>    1 made honest; both lenses render beside it as decomposition.
> 3. Non-content is reported as **two components** (paths, and responses `>= 400`) with no combined
>    total, because they overlap each other as well — a 404 on `/favicon.ico` is in both — and the
>    `(path, status)` pair needed to measure that overlap does not exist until item 9.
>
> Shipped: `verifiedBotCategory` pulled in `pullZoneTraffic` with both `count` and `sum { visits }`;
> new table `daily_zone_bots(date, host, category, requests, visits)` in `schema.sql` **and**
> `ensureSchema`; `crawlerAccounting`, `summarizeVerifiedBots`, `summarizeNonContent` and
> `isNonContentPath` in `src/bots.js`; `zoneCrawlerPanel` in `src/render.js`. The RUM flood
> classifier is untouched.

### Spike result (2026-08-12) — do not re-run

Against zone `066e5342a1531be2638029c2f1dde5f6` (library.freecapitalists.org), on
`httpRequestsAdaptiveGroups`:

| Dimension | Result |
| --- | --- |
| `botScore`, `botScoreSrcName` | **Plan-gated.** `"zone … does not have access to the field 'botscore'"`, `code: "authz"`. No workaround. Do not build on them. |
| `clientRequestUserAgent` | **Not a valid dimension** on this dataset (`unknown field`). Do not chase it. |
| `verifiedBotCategory` | **Works.** Real data, see below. |
| `{ clientRequestPath, edgeResponseStatus }` | **Two dimensions in one call work**: filtered `edgeResponseStatus_geq: 400`, 1,376 rows, no cap hit. The one-dimension-per-call comment at `src/cloudflare.js:73-79` is a row-cap workaround, not an API ceiling. |

24h sample, 21,929 requests: empty/unverified 18,538 (84.6%), Archiver 936, Search Engine Crawler
867, AI Crawler 696, Search Engine Optimization 446, AI Search 405, Page Preview 21, Monitoring &
Analytics 10, Accessibility 8. Verified-bot total 3,389 (15.4%).

**The critical interpretation, and the whole point of this item:** that 84.6% is not a human bucket.
It is every request Cloudflare did not verify — real people *and* unverified or spoofing crawlers,
inseparable on this plan. Verified bots are a floor on crawler volume, never a total, and the zone
card must never assert a human count for the host: no subtracting the floor and calling the
remainder human, no interpolation, no adding the two lenses together.

**Symptom.** The flood classifier structurally cannot fire on a zone host (see Problem statement,
item 2), so library's crawler volume is silently counted as human.

**Change.** Zone hosts get a separate, honest decomposition instead of a flood verdict.

- **Verified crawlers (a floor).** A `verifiedBotCategory` query in `pullZoneTraffic`
  (`src/cloudflare.js`), requesting **both** `count` and `sum { visits }`, persisted per category
  with the empty label stored explicitly as `(unverified)`. Rendered with `≥` framing consistent
  with flooded RUM days, stating plainly that unverified crawlers are not included and cannot be
  measured on this plan.
- **Non-content requests.** Requests to `/robots.txt`, `/favicon.ico`, `/sitemap*`,
  `/.well-known/*`, `/cdn-cgi/*`, plus all responses `>= 400` — from `daily_cf_pages` and
  `daily_zone_status`, so no new query. Today that is 684 + 42 + 230 (`/cdn-cgi/*`) of paths and
  2,514 of 4xx. A separate lens that overlaps the first.
- The zone card must never assert a human-session count it cannot support, and says outright that
  the remainder cannot be characterized.

**Acceptance.** `scripts/bots-check.mjs` gains a case asserting that a zone-sourced host is routed
to the zone decomposition and never returned as `flood: false, human: <all visits>` by implication.
The library card shows a crawler or non-content figure, or an explicit "crawler share unknown".

## 3. Unify the opportunity predicate and fix the doc drift — IMPLEMENTED (`1497cab`, `bd7e14d`)

> The NUL-byte chore landed first in `1497cab`; the predicate extraction and the footer prose in
> `bd7e14d`. The predicate moved verbatim into `src/opportunities.js` — item 7 still owns replacing
> it with the snippet/rank split. One correction to this section's wording: `isOpportunity` accepts
> either a raw D1 row or the renderer's shaped row (which carries a precomputed `ctr`) and derives
> CTR itself, because the two call sites were passing different row shapes.

Three small correctness chores that block later items.

- **`src/index.js` contains a literal NUL byte and git treats the whole file as binary.** At
  `src/index.js:426` a composite map key is built as `` `${r.referrer}<NUL>${r.kind}` `` with the NUL
  typed as a raw character rather than an escape. It is behaviorally fine and it is in every commit
  in the history, but it costs you `git diff`, `git blame` line context, and `grep`/ripgrep on the
  single most important file in the repo. It cost real time while writing this spec. Replace the raw
  byte with `\u0000` in the template literal. The change is byte-for-byte behavior-identical, and
  every subsequent item in this spec is easier to implement afterward, so do it first.

- The OPPORTUNITY predicate exists twice, independently: `src/render.js:79` (drives the badge, over
  the top 12 keywords only) and `src/index.js:475` (drives `totals.opportunities`, over all
  keyword rows). They agree today by coincidence of maintenance and operate on different row sets,
  so the headline count can legitimately exceed the visible badges. Extract to a new
  `src/opportunities.js` exporting the classifier and its thresholds as named constants; import in
  both places. Item 7 replaces the predicate itself, but the unification lands first so there is one
  place to change.
- `src/render.js:410` states that flooded days are "excluded whole, from sessions, referrers, and
  landing pages alike". Since the `splitDay` rework that is false: referred sessions survive
  (`src/bots.js:89-96`, `src/index.js:409`) and only landing pages are excluded whole. Fix the
  sentence, and interpolate the flood thresholds into the footer prose from the `src/bots.js`
  constants rather than restating them as literals. Export `FLAT_PAGES_PER_SESSION` and
  `DIRECT_SHARE` (currently module-private, `src/bots.js:16-17`) so the prose cannot drift again.

**Acceptance.** `render-check.mjs` asserts the footer text contains the values of the four exported
constants, computed rather than typed.

---

# P1. Turn observations into decisions

## 4. Replace NOTABLE with a ranked signal engine — IMPLEMENTED (`c7eefc5`)

> Landed as `src/signals.js` (all rules), `src/urls.js` (the malformed-URL predicate), a widened
> `daily_zone_status` read in `loadDashboard`, an absolute-change floor on `deltaBadge`, and signal
> coverage in `dashboard-check.mjs`. **Four things this section originally said were wrong against
> live data, and the rule table below has been rewritten to match what shipped:**
>
> 1. **The `likely-bot-subflood` volume floor was too high to catch the case it was written for.**
>    "absolute change ≥ 100" would have missed the live wiki.freecapitalists.org spike — 151 sessions
>    up from about 54, an absolute change of +97. The floor shipped as **absolute change ≥ 50 AND
>    resulting sessions ≥ 100**. The other three tests (pages/session ≤ `FLAT_PAGES_PER_SESSION`,
>    direct share ≥ 0.8, top landing page ≥ 80% of entrances) are unchanged and are what make a low
>    volume floor safe: a real 100-session day is not simultaneously flat, ~all direct, and ~all
>    landing on one URL.
> 2. **The rule table said nothing about measurement class, and it had to.** The live NOTABLE list
>    led with "library.freecapitalists.org pages/session fell by 2.1", which is not a weak signal but
>    a category error — library is zone-sourced, so its "pages/session" is requests per zone-log
>    visit. Session-delta and pages-per-session rules now run on **RUM sites only**; zone-sourced
>    hosts are eligible **only for zone-specific rules**, today just `error-spike`. The gate reads
>    `site.measurement` / `site.zoneSourced` from item 1, never a hostname.
> 3. **`snippet-gap` could not be built.** It depends on item 7's snippet-vs-rank split, which does
>    not exist. What shipped is a single generic `search-opportunity` rule driven by the existing
>    shared `isOpportunity` predicate; item 7 replaces it with two rules whose remedies differ.
> 4. **`malformed-urls` needed item 10's predicate, which did not exist.** Only the predicate was
>    built — `looksMalformed` in the new `src/urls.js`, tested against the two live
>    davidveksler.freecapitalists.org paths. Item 10's per-row badging is untouched.
>
> Two implementation notes the section did not anticipate:
>
> - **Unmeasured days are absent from the `error-spike` baseline, not zero.** A day with traffic but
>   no `daily_zone_status` row was not measured (the table arrived with a later migration, or that
>   night's pull failed); counting it as a 0% error day drags the mean down and manufactures a spike
>   out of an ordinary day. The first fixture run did exactly this, reporting a 0.3% baseline where
>   the measured days averaged 1.1%.
> - **`runDaily` gets its ntfy finding by calling `loadDashboard`**, not by re-deriving anything.
>   That is the whole reason `computeSignals` is a pure function of already-loaded rows: one copy of
>   the rules, the same discipline item 3 established for the opportunity predicate. `sendNtfy`
>   appends the top **severity-1** signal only, so a quiet day's push is byte-for-byte what it was.
>
> The old standalone pages/session anomaly is gone with NOTABLE and was not replaced: the rule table
> has no such rule. The measurement-class gate is written as a general guard rather than a
> per-rule check, so it applies to whatever is added next.

**Symptom.** "Notable" reports deltas without diagnosis or priority. On 2026-08-13 the top chip is
`wiki.freecapitalists.org sessions rose 178%`, which reads as good news. The same page shows what it
actually is: 136 of 150 sessions direct, 1.0 pages/session, 134 of them landing on `/wiki/Main_Page`,
plus 10 on `/sitemap.xml.gz`. That is a bot spike sitting just under the 500-session flood floor
(`FLOOD_MIN_VISITS`, `src/bots.js:14`). Every fact needed for that call is already rendered.

**Change.** New module `src/signals.js`, computed read-side inside `loadDashboard` over the history
already loaded (`hist.results` reaches back 30 days, `src/index.js:322`, so no new query is needed).
It replaces the `anomalies` flatMap at `src/index.js:527-537`.

Signal shape:

```js
{ severity: 1|2|3, kind, host, headline, evidence, action, href, recurrence }
```

`severity` 1 = act today, 2 = look at it, 3 = context. `evidence` is the numbers that justify the
call. `action` is an imperative sentence. `href` deep-links to the relevant card anchor, GSC query,
or Cloudflare view. `recurrence` counts consecutive prior days the same `(kind, host)` fired.

**`recurrence` is populated only where the loaded history answers it exactly**, and is `null`
otherwise. Today that is one rule: `no-comparison` in the 24h view, where a flooded day is precisely
a day whose delta was suppressed, so "flooded N days running" and "this fired N days running" are the
same statement. Item 11 owns real recurrence for the rest; nothing guesses it, because a wrong "3rd
consecutive day" is worse than an absent one.

**Measurement class gates every rule.** Session-delta and pages-per-session rules are RUM-only;
zone-sourced hosts are eligible only for the zone column below. This is not a matter of confidence —
a zone host's "sessions" and "pages/session" are different quantities wearing the same words.

Rules as implemented, in priority order:

| kind | class | condition | severity | action text |
| --- | --- | --- | --- | --- |
| `error-spike` | zone | responses ≥ 400 as a share of requests exceeds its 14-day mean by ≥ 2× **or** ≥ 5 points, with ≥ 3 measured baseline days, ≥ 50 error responses, and ≥ 2% share today | 1 | "Check the top failing paths below and fix or redirect them" |
| `likely-bot-subflood` | RUM | sessions delta ≥ +100% **and** absolute change ≥ 50 **and** resulting sessions ≥ 100 **and** pages/session ≤ `FLAT_PAGES_PER_SESSION` **and** direct share ≥ 0.8 **and** top landing page ≥ 80% of entrances | 1 | "Treat as crawler traffic, not growth, and consider lowering the flood floor for this host" |
| `malformed-urls` | RUM | ≥ 3 landing pages match `looksMalformed` (`src/urls.js`) | 2 | "Fix the broken links generating these, then redirect or noindex the junk URLs" |
| `snippet-gap` | RUM | site has ≥ 1 `snippet`-class opportunity (item 7) | 2 | "Rewrite the title and meta description for those pages; the ranking is already there" |
| `rank-gap` | RUM | site has ≥ 1 `rank`-class opportunity (item 7) | 2 | "Strengthen those pages and link to them from the strongest related page on the site" |
| `traffic-drop` | RUM | sessions delta ≤ -25% **and** absolute change ≥ 25 **and** not partial | 2 | "Compare the referrer list against the previous period to find what stopped" |
| `traffic-rise` | RUM | sessions delta ≥ +25% **and** absolute change ≥ 25 **and** not `likely-bot-subflood` | 3 | "Check which referrer drove it before counting it as growth" |
| `no-comparison` | RUM | delta suppressed because either side was partial | 3 | "Read the figure as a floor, and wait for a clean day before judging the trend" |

The two search rules shipped as one generic `search-opportunity` placeholder in `c7eefc5` and were
split in `e96c949` once item 7 existed. Telling the reader to rewrite a title and description is
only correct for a page that already ranks; the table above is the post-split state. Each rule is
weighed by its own class's click metric, so the two rank against each other on the same axis even
though they are found by different ones.

Two rules that matter more than the table:

- **Absolute-change floors everywhere.** A percentage on a single-digit base is noise dressed as
  signal. The current NOTABLE list already gates on `visits >= 10` (`src/index.js:529`), but the
  **per-card delta badge does not** (`src/render.js:242`, `deltaBadge` at `:10-18`), which is why
  `whopaysforai.org ↑600%` (6 sessions to 7) renders with the same visual weight as a real move.
  Add a minimum-absolute-change gate to `deltaBadge` itself; below it, render the delta muted or as
  `±<n>` rather than a percentage. Shipped as `DELTA_MIN_ABSOLUTE` in `src/signals.js`, imported by
  `render.js` so the badge and the session-delta rules share one floor by construction: the page
  shows a percentage exactly when a percentage could mean something.
- **Say when you are silent.** Today a flooded site drops out of NOTABLE without a word because
  `site.delta` is `null` (`src/index.js:458`). The `no-comparison` signal makes that visible.

**Acceptance** (met against the 2026-08-13 fixtures in `dashboard-check.mjs`).
wiki.freecapitalists.org — 151 sessions, +180%, 1.0 pages/session, 90% direct, `/wiki/Main_Page` at
89% of entrances — produces exactly one severity-1 `likely-bot-subflood` signal and no
`traffic-rise`; the two are mutually exclusive by construction.
library.freecapitalists.org produces no session-delta or pages-per-session signal and fires
`error-spike` on 2,514 responses ≥ 400 (12.9% of requests) against a 1.1% four-day mean.
davidveksler.com (40 sessions from 27, +48%, +13) produces no signal and renders `+13` muted rather
than a percentage. forum-style fully flooded hosts produce `no-comparison` instead of vanishing.

## 5. "Today's actions" block — IMPLEMENTED (`c7eefc5`)

> Landed as `actionsBlock` in `src/render.js`, rendered first inside `<main>` above the KPI tiles,
> with `.action` styling and `render-check.mjs` coverage. The `<h2>` id doubles as nothing — the
> deep links use `cardAnchor(host)`, exported from `src/signals.js` and used by `siteCard` to build
> the card id, so a signal href can never point at an anchor no card carries. The check asserts that.
>
> Severity-3 signals are deliberately excluded from the block, not merely ranked below: a "no
> like-for-like comparison" note taking one of three slots would displace a real finding. With only
> severity-3 signals the block reads "Nothing needs attention today", which is accurate — there is
> context on the cards, and nothing to do.

**Change.** Above the KPI tiles, render the top 3 severity-1/2 signals as a short list: headline,
one line of evidence, one imperative action, one link. If there are none, render
`Nothing needs attention today` rather than an empty container. This is the capstone of item 4 and
the single highest-value change on the page.

Also feed the top signal into the ntfy summary (`sendNtfy`, called at `src/index.js:233`) so the
push carries the finding rather than only volumes. Keep the existing quiet-success discipline: no
severity-1 signal means the notification stays as-is.

## 6. Fix the traffic sources panel — IMPLEMENTED (`e96c949`)

> Item 1 had already excluded zone sites from the mix (it had to: the residual segment rendered
> wider than the whole bar otherwise), so what landed here is the labelling and the recovery of
> internal navigation. Three corrections to what this section originally said:
>
> 1. **The residual was renamed in the DATA, not only on the page.** `sourceMix.other` is now
>    `sourceMix.unattributed`, and `summarizeSources` gained an `internal` key. Keeping the field
>    called `other` while the page said "Unattributed" would have reintroduced exactly the gap
>    between what the code calls a thing and what the reader is told it is. `/api/json` changes
>    shape accordingly; it is an internal, WAF-gated surface with no external consumer.
> 2. **`internal` only exists going forward, and the panel has to say so rather than render a zero.**
>    `kind` is frozen into `daily_referrers` by `topReferrers`/`classifyReferrer` at write time, and
>    the referer that would decide it is not stored anywhere, so no backfill is possible even in
>    principle. `totals.internalMeasured` reports whether any row in the selected window and for the
>    selected hosts carries the kind; when none does, the channel is **omitted from the bar and the
>    legend entirely**, because `Internal 0 · 0.0%` asserts a measurement nobody took. The residual
>    footnote names the pre-change alias sessions as one of its causes in exactly that case.
>    `dashboard-check.mjs` and `render-check.mjs` both cover it, and both cover `?period=7` and
>    `?period=30` rather than only the 24h view — those are the windows that still reach back over
>    old rows.
> 3. **The two KPI tiles that contradicted each other were fixed here too**, since the work was in
>    the tiles anyway: "Domains shown" read `12` / `12 with traffic` beside a sessions tile reading
>    `11 RUM sites`. It now reads `11 RUM + 1 zone · 12 with traffic` (`totals.zoneDomains`), so the
>    two tiles agree about how many sites exist and about why one of them is counted differently.
>
> One thing the section got right and is worth restating: the live residual was already down to
> about 1 session in 966 after item 1, so the acceptance threshold was met before this item started.
> The value delivered here is the honesty of the labelling — a residual named as a residual — and
> internal navigation becoming a real, attributable category instead of a hole.

**Symptom.** "Other / unlisted" is 1,060 of 2,012 sessions (52.7%). A channel panel whose largest
bucket is unattributable cannot inform a channel decision.

**Root cause.** `other` is a residual, not a class: `other = visits - (direct + search + social +
referral)` (`src/index.js:388-396`). Library contributes 1,059 of it, because zone logs carry no
referer dimension so no `daily_referrers` row is ever written for that host. The remaining ~1 comes
from two smaller leaks: self-referrals are counted in `rec.visits` but their referrer row is skipped
(`src/cloudflare.js:50` then `:55`), and only the top 50 referrers per host-day are persisted
(`src/index.js:112`).

**Change.**

- Exclude zone-sourced sites from the mix entirely and title the panel
  `Traffic sources (RUM sites only)`. That alone takes unattributed from 52.7% to about 0.1%.
  (Done in item 1, out of necessity — see that item's note.)
- Rename the residual to `Unattributed`, in the data as well as on the page (`sourceMix.other` →
  `sourceMix.unattributed`), and render it outside the percentage bar as a footnote with its known
  causes, not as a fifth channel competing with Direct and Search.
- Reduce the residual at the source: write self-referrals as `kind: "internal"` in `daily_referrers`
  instead of dropping the row, and render internal as its own muted channel. Sessions arriving from
  a site's own alias hostname are a real, attributable category.
- **The `internal` kind is forward-only and this must not break history.** `kind` is frozen into the
  row at write time by `topReferrers`/`classifyReferrer`, and the referer that would decide it is not
  stored anywhere, so no backfill is possible. `totals.internalMeasured` reports whether any row in
  the selected window and for the selected hosts carries the kind; when none does, the channel is
  omitted from the bar and legend entirely rather than rendered as `Internal 0 · 0.0%`, which would
  assert a measurement nobody took.
- **Also fix the two KPI tiles that contradict each other** while the work is in the tiles:
  "Domains shown" reads `12` / `12 with traffic` beside a sessions tile reading `11 RUM sites`. State
  the split — `11 RUM + 1 zone · 12 with traffic`.

**Acceptance.** `dashboard-check.mjs` asserts `totals.sourceMix.unattributed / totals.visits < 0.05`
on the standard fixture, that no zone-sourced site contributes to `sourceMix`, that internal sessions
land in `sourceMix.internal` rather than the residual, and that a window of pre-change rows reports
`internalMeasured: false` with the channel absent. `render-check.mjs` asserts the residual renders
below the legend as a footnote, never as a segment, and covers `?period=1`, `?period=7` and
`?period=30`.

## 7. Split opportunities by required action, rank each class by its own metric — IMPLEMENTED (`e96c949`)

> **The thresholds this section originally proposed failed the very example that motivated it, and
> "rank by lost clicks" was wrong for half the cases.** Four corrections, and the section text below
> has been rewritten to match what shipped:
>
> 1. **The `rank` gates were tuned for a 30-day window.** `16 <= position <= 30` and
>    `impressions >= 20` both exclude `bitcoin recovery` on walletrecovery.info (13 impressions, 0
>    clicks, position 31.2) — the live query used to justify this whole item, which would have stayed
>    invisible. GSC is queried over a **three-day** window here, so impression counts are small and
>    any floor written for a monthly window suppresses everything. Shipped: `snippet` at position
>    ≤ 15, `rank` from there to position 50, `watch` beyond, `OPPORTUNITY_MIN_IMPRESSIONS` staying at
>    5, and a `MIN_ACTIONABLE_CLICKS = 0.5` floor on the class's own gain metric doing the work a
>    fixed impression floor was doing badly. That floor scales with the CTR curve, so a deep query
>    needs more impressions to qualify than a shallow one — which is the correct behavior and is not
>    something a constant can express.
> 2. **The two classes are ranked by DIFFERENT metrics, and this is the substantive change.** Lost
>    clicks = `impressions × (expectedCtr − actualCtr)` measures what is recoverable *at the current
>    rank*. That is exactly the right question for a snippet rewrite and exactly the wrong one for a
>    ranking problem, where the entire value is in moving up. Ranking both classes by it guarantees
>    that deep-ranking, business-critical queries always lose to shallow ones. Shipped: `snippet`
>    sorts by lost clicks; `rank` sorts by **potential clicks** = `impressions ×
>    expectedCtr(TARGET_POSITION) − clicks`, with `TARGET_POSITION = 5` as a named constant. How
>    badly the single metric fails is now an assertion: **every** ranking-class query in the fixtures
>    scores under `MIN_ACTIONABLE_CLICKS` on lost clicks, so one shared metric would not have demoted
>    the class, it would have deleted it.
> 3. **`queryDenyPatterns` was built and left empty.** This section implied suppressing
>    forum.objectivismonline.com's adult-leaning queries. Which queries a site declines to pursue is
>    an editorial decision belonging to the site's owner, not to this repo, so the mechanism ships
>    documented (`src/config.js`, and AGENTS.md says how to populate it) and **unset on every site**.
>    It turned out not to be needed for the acceptance case anyway: `incest forum` (1 click, 61
>    impressions, position 12.8) takes 1.6% CTR against roughly 1.9% expected at that position, so
>    the classifier does not flag it at all. That is the better outcome — it is excluded by
>    measurement rather than by an opinion.
> 4. **The tile subtitle changed owner.** This section wanted `N opportunities in top queries` to
>    become an anchor link on the `Avg search position` tile; item 8 replaces that tile's value with a
>    median and puts `N queries in the top 10` in its subtitle. Both landed: the subtitle is the
>    top-10 count, and the opportunity link sits beside it as `N snippet · M rank`, deep-linking to
>    the card holding the highest-scoring opportunity.
>
> Also shipped: `expectedCtr(position)` in `src/opportunities.js` with a sourced, dated comment
> (SISTRIX 2020, ~80M keywords; positions 1/2/3/10 measured, 4–9 log-linear interpolation, the tail
> past 10 our own estimate — each marked as which), `classifyOpportunity` as the single shared
> classifier behind both the badge and the count, and `search-opportunity` in `src/signals.js`
> replaced by `snippet-gap` and `rank-gap` with genuinely different action text.

**Symptom.** The badge is mechanical. It fires on `incest forum` (1 click, 61 impressions, position
12.8) for the Objectivism forum, a query nobody should optimize for, and skips `bitcoin recovery`
(13 impressions, 0 clicks, position 31.2) on walletrecovery.info, which is squarely that site's
business. Worse, one label covers two opposite problems: 0% CTR at position 50 to 90 is a *ranking*
problem needing content and links, while 0% CTR at position 5 to 15 is a *snippet* problem needing a
title and description rewrite. The remedies share nothing.

**Change.** In `src/opportunities.js` (created in item 3), classify each query. Every threshold is a
named export, and the footer prose interpolates them rather than restating them:

- `snippet`: `position <= SNIPPET_MAX_POSITION` (15) and `ctr < expectedCtr(position) *
  SNIPPET_CTR_RATIO` (0.5). Ranked by **lost clicks** = `impressions × (expectedCtr(position) −
  ctr)`. Action: rewrite title and meta description — the ranking is already there.
- `rank`: `SNIPPET_MAX_POSITION < position <= RANK_MAX_POSITION` (50). Ranked by **potential
  clicks** = `impressions × expectedCtr(TARGET_POSITION) − clicks`, `TARGET_POSITION = 5`. Action:
  strengthen the page, add internal links from the strongest related page.
- `watch`: `position > RANK_MAX_POSITION`. Not badged, not counted. It is a content project rather
  than a task.
- Both classes require `impressions >= OPPORTUNITY_MIN_IMPRESSIONS` (5 — below that CTR is not a
  measurement) and at least `MIN_ACTIONABLE_CLICKS` (0.5) of gain **on that class's own metric**.
  GSC is queried over a three-day window here, so these floors are deliberately low; a floor tuned
  for a 30-day window suppresses every query on the page.

**The two metrics are not interchangeable and must not be unified.** Lost clicks measures what is
recoverable at the current rank. For a query at position 31 that is near zero by construction — the
whole point is that nobody sees it — so a shared lost-clicks ranking does not demote the ranking
class, it deletes it. `bitcoin recovery` scores about 0.07 lost clicks and about 0.94 potential
clicks; the second number is the one that says the work is worth doing.

`expectedCtr(position)` is a small static table with a sourced, dated comment: SISTRIX's 2020 CTR
study over ~80M keywords supplies positions 1, 2, 3 and 10; positions 4–9 are log-linear
interpolation between those anchors (which lands position 5 on the commonly cited 7.2%); everything
past position 10 is our own estimate of a flat tail. Each group is marked as which. It is an
approximation of a 2020 average across every query intent there is, so nothing derived from it is
rendered to more than one decimal place, it always carries a `~`, and no threshold fires on a small
shortfall against it — that is what `SNIPPET_CTR_RATIO = 0.5` is for.

Add an optional `queryDenyPatterns: ["…"]` field to `SITES` entries in `src/config.js` (JS regex
sources, matched case-insensitively) for queries a site will never pursue. Denied queries are still
shown in the plain query list, they are only excluded from the two classes and from the headline
count. **Ship it unset on every site**: which queries a site declines to chase is the owner's
editorial call, not a decision this repo should make. Document the field and how to populate it, and
add no patterns.

Finally, put the opportunity counts on the search-position tile as an anchor link (`N snippet ·
M rank`, deep-linking to the card holding the highest-scoring opportunity) beside the top-10 count
item 8 puts in that subtitle.

**Acceptance.** On today's data, walletrecovery.info's `bitcoin recovery` (13 impressions, 0 clicks,
position 31.2) appears as a `rank` opportunity; forum.objectivismonline.com's `incest forum` (1
click, 61 impressions, position 12.8) is not in the top 5 by its class metric — in fact it is not
classified at all, because 1.6% CTR against roughly 1.9% expected at position 12.8 is a page
performing at its rank; cheatsheets.davidveksler.com's `frontier ai labs list` (2 clicks, 6
impressions, position 2.5) is not flagged for the same reason; and every rendered badge reads either
`snippet` or `rank`, never a bare `opportunity`.

## 8. Give every metric a comparator — IMPLEMENTED (`e96c949`)

> Landed as `totals.trend` in `loadDashboard`, built entirely from history already read, plus the
> `cmp` chip and `meanNote` in `src/render.js`. Four notes on what the section did not anticipate:
>
> 1. **GSC comparators are counted in SNAPSHOTS, never in days, and the field names say so.** The
>    section's caveat was right and needed to reach further than the label: because each row covers a
>    rolling three-day window lagging two days, consecutive rows overlap by two days out of three, so
>    "clicks per day" is not a quantity these rows can express at all. The fields are
>    `trend.gscClicksPerSnapshot` / `gscImpressionsPerSnapshot`, and `dashboard-check.mjs` asserts
>    that **no** `gsc*PerDay` field exists, so the next person cannot add one by habit. The rendered
>    range is named from `gsc_window` at both ends, and the chip's tooltip says the overlap out loud.
>    Trailing means only; no day-over-day GSC delta is computed anywhere.
> 2. **The CTR expectation is over the stored query mix, not the whole property.** `expectedCtr` needs
>    a per-query position, and the only per-query rows stored are GSC's top ~25 per site. Computing
>    the expectation from each site's *average* position instead would push a convex curve through a
>    mean and produce a number that means nothing. So the tile reads
>    `expected ~1.6% at this position mix` — "this position mix" being the stored queries — beside an
>    actual CTR that covers everything. Rendered with a `~` and one decimal for that reason as much
>    as for the curve's own approximation.
> 3. **The clicks sparkline was not built.** `totals.trend.gscSeries` carries the per-snapshot series
>    in `/api/json`, but a 150×38 sparkline does not fit a KPI tile beside a value, a subtitle and a
>    comparator chip, and shrinking one to fit would render a rolling overlapping window as a trend
>    line — the exact misreading this item exists to prevent. The comparator chip is what shipped.
> 4. **Widening all three GSC reads to the history window costs more than the trend needs.** Only
>    `daily_search_summary` feeds the trend; `daily_keywords` and `daily_pages` are widened as
>    specified but every consumer filters straight back down to `date`. At ~25 keyword rows per site
>    per day that is a few thousand rows read per dashboard load for no current benefit. Left as
>    specified because item 11's recurrence work will want them, but if that item is dropped, narrow
>    these two back to the latest day.
>
> Also shipped: the traffic tiles' 14-day means (sessions, pageviews, search sessions), computed
> through the same `splitDay` human/crawler split the cards use so the baseline and the figure are
> the same quantity; and `Avg search position` replaced by `Median search position` with
> `N of M queries in the top 10` in the subtitle. `totals.gscPosition` still holds the old
> impression-weighted mean for `/api/json` continuity and is off the page.

**Symptom.** No number can be judged. Is 0.4% search CTR bad? At an average position of 10 the
expected range is roughly 1 to 2%, so yes, materially, but the page does not say. "pages/session
fell by 3.2" against what baseline? Only the reader knows.

**Change.**

- Every KPI tile gets a 14-day mean beneath it, computed from the history already loaded, through the
  same `splitDay` human/crawler split the cards use. No new queries for traffic metrics.
- The `Search CTR` tile gets the position-adjusted expectation from `expectedCtr()`, impression
  weighted over the stored per-query rows, rendered as `2.1%` with
  `expected ~1.6% at this position mix` beneath it.
- Replace the `Avg search position` tile value. A mean across branded position-1 queries and
  position-90 junk is not a number any decision rests on. Use **median position across queries with
  ≥ `POSITION_MIN_IMPRESSIONS` (10) impressions**, and put `N of M queries in the top 10` in the
  subtitle.
- GSC trend is a pure read-side change: `daily_keywords`, `daily_pages`, and `daily_search_summary`
  all store one row per day already, but `loadDashboard` reads them for the latest date only.
  Widen those three reads to the history window; every panel consumer filters back down to the
  latest date, and the trailing rows feed the comparator. **Caveat that must be rendered:** GSC rows
  are keyed by snapshot date, not by measurement window, and the window lags 2 to 4 days, so
  consecutive rows overlap by two days out of three. The comparator is therefore stated **per
  snapshot, never per day**, no day-over-day GSC delta is computed anywhere, and every date a human
  reads comes from `gsc_window` — what Google measured — rather than from the row's `date`, which is
  only when we asked.

---

# P2. Surface the buried actionable data

## 9. Per-path error detail for zone sites

**Symptom.** The most genuinely actionable data on the page is collapsed and unranked:
library.freecapitalists.org served 1,745 404s (9.0% of requests), 769 406s (3.9%), and 212 gateway
timeouts (1.1%) in one day. Those are fix-it-today signals. The page shows the counts but not
**which paths**, so nothing can be done with them. Meanwhile the visible TOP FILES list is dominated
by `/robots.txt`, `/cdn-cgi/*`, and `/favicon.ico`.

**Root cause.** Status and path are stored in separate, un-crossed tables: `daily_zone_status(date,
host, status, requests)` and `daily_cf_pages(date, host, page, visits, views)`. There is no
`(path, status)` pair anywhere.

**Change.**

- Add a query to `pullZoneTraffic` (`src/cloudflare.js`) dimensioned on the **pair**
  `{ clientRequestPath, edgeResponseStatus }` with an `edgeResponseStatus_geq: 400` filter. Item 2's
  spike settled the open question here: two dimensions in one call work, and that exact query
  returned 1,376 rows on this zone with no cap hit. The one-dimension-per-call convention at
  `src/cloudflare.js:73-79` is about the 5,000-row cap, not a hard API limit; the `>= 400` filter is
  what keeps the product small enough.
- New table `daily_zone_errors(date, host, path, status, requests)`, PK `(date, host, path,
  status)`, added to `schema.sql` and to the idempotent `ensureSchema` batch (`src/index.js:16` onward).
  Note the D1 gotcha in `AGENTS.md`: `schema.sql` cannot be applied with the deploy token. Rely on
  `ensureSchema`, or apply via the D1 console or the MCP connector.
- Render a `Top failing paths` list in the zone details block, above TOP FILES, grouped by status.
- Split TOP FILES into `Content` and `Assets and crawler noise` using `isNonContentPath` from
  `src/bots.js` (shipped in item 2 — do not write a second predicate) so real file demand is visible
  instead of being crowded out by `robots.txt`.
- ~~Feed the `error-spike` signal from item 4 off `daily_zone_status` history~~ — **done in item 4.**
  `loadDashboard`'s `daily_zone_status` read was widened from latest-day to the history window and
  the baseline is built from the days that actually carry status rows (an unmeasured day is absent,
  not zero). Nothing further is needed here; the per-path detail below is what remains.

**Note on scope.** `daily_zone_status` exists only for zone-sourced hosts, so this gives error
visibility for library only. The 11 RUM sites have no per-day status data at all. Adding it for them
means a zone-log pull per site, which is a larger change; leave it out of this spec and revisit if
error visibility proves valuable on library.

## 10. Flag malformed and injected URLs

**Symptom.** davidveksler.freecapitalists.org's landing pages include
`/category/austrian-economics/%3E%C3%97%3C/span%3E8%3C/span%3E` and seven siblings. These are real
crawl and index pollution from broken pagination markup, presented as ordinary rows.

**Change.** ~~Add a `looksMalformed(path)` predicate~~ — **the predicate shipped with item 4**, as
`src/urls.js`: percent-encoded angle brackets, a tag fragment beside a bracket, a bare `/span`-style
segment, doubled slashes, and percent sequences that decode to markup or cannot be decoded at all.
It is deliberately biased to false negatives — `/img`, `/p`, `/a`, `/em` and `/scripts` are real path
segments somewhere and are never matched on their own — because a false positive would badge a real
page. Do not write a second predicate.

What remains for this item is the rendering: **badge the matching rows** in the landing-page lists so
the reader can see which ones they are. The `malformed-urls` signal already fires with the count and
the remedy. Deterministic, cheap, and it turns a row nobody reads into a cleanup ticket.

---

# P3. Memory across days

## 11. Recurrence

**Symptom.** The page is stateless day to day. It cannot say "this fired yesterday too", "this 404
spike is new", or "cheatsheets clicks rose after the GSC property switch three days ago". For a
fleet built around routines acting on data, the dashboard stops exactly where a routine needs to
start.

**Change.** Compute signals (item 4) over each of the last N days in the already-loaded history and
set `recurrence` to the count of consecutive prior days the same `(kind, host)` fired. The field and
its rendering slot already exist (`N days running` on the action row, asserted in `render-check.mjs`)
and `no-comparison` already populates it exactly; every other rule returns `null` rather than a
guess, so this item is filling in a wired-up hole rather than adding one. Escalate severity by one level at `recurrence >= 3`, since a
repeating signal that nobody has acted on is more urgent than a fresh one, not less.

If read-side recomputation proves slow, persist instead: `daily_signals(date, host, kind, severity,
headline, evidence_json)` written during `runDaily`. Prefer the read-side version first. It needs no
schema change, and D1 retains everything already (there is no pruning anywhere in the codebase).

---

# Test plan

`npm run check` is the gate. Extend the three existing scripts rather than adding a framework.

- `scripts/dashboard-check.mjs` (drives `loadDashboard` against a stubbed D1): assert zone exclusion
  from `totals.visits` and `totals.views`, assert `sourceMix.other` is under 5% of RUM sessions,
  assert `signals` ordering and the absolute-change floors.
- `scripts/render-check.mjs` (renders a fixture, asserts substrings): add fixtures for a zone site,
  a sub-flood bot spike matching the 2026-08-13 wiki shape, malformed URLs, and one `snippet` plus
  one `rank` opportunity. Add negative assertions: no `human sessions` string inside a `card--zone`
  block, no percentage delta badge on a site below the absolute-change floor.
- `scripts/bots-check.mjs`: add the zone-host routing case from item 2. Keep the existing real
  Aug-2026 traffic shapes untouched, since a false positive deletes real traffic from the dashboard.

Beyond the check scripts, verification stays end-to-end per `AGENTS.md`: deploy, hit `/run`, read
the returned JSON. Remember the WAF blocks non-browser user agents on this host.

# Suggested order

1. ~~Items 1, 2, 3.~~ Done. Headline numbers stop being wrong.
2. ~~Items 4, 5.~~ Done. The signal engine and the actions block, which is where the actionability
   actually arrives.
3. ~~Items 6, 7, 8.~~ Done. Panels and metrics become judgeable.
4. Items 9, 10. Buried data surfaces. Item 9 is the only one needing a schema change.
5. Item 11. Recurrence.

Items 1 and 2 are worth shipping alone even if nothing else is built, because until they land the
two largest numbers on the page do not mean what they say.
