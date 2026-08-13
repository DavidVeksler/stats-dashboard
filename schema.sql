-- stats-dashboard D1 schema
-- Apply with:  npm run schema   (or via the Cloudflare D1 console)

CREATE TABLE IF NOT EXISTS daily_traffic (
  date   TEXT NOT NULL,              -- UTC date the 24h window ended
  host   TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0, -- Cloudflare Web Analytics sessions (or zone-log visits, see config.js trafficSource)
  views  INTEGER NOT NULL DEFAULT 0, -- pageviews (or total requests, for zone-sourced hosts)
  bytes  INTEGER NOT NULL DEFAULT 0, -- edge response bytes; only populated for zone-sourced hosts
  PRIMARY KEY (date, host)
);

CREATE TABLE IF NOT EXISTS daily_referrers (
  date     TEXT NOT NULL,
  host     TEXT NOT NULL,
  referrer TEXT NOT NULL,            -- refererHost, or '(direct)'
  kind     TEXT NOT NULL DEFAULT 'ref', -- search|direct|social|ref
  visits   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, host, referrer)
);

CREATE TABLE IF NOT EXISTS daily_keywords (
  date        TEXT NOT NULL,         -- snapshot date (matches daily_traffic)
  host        TEXT NOT NULL,
  query       TEXT NOT NULL,
  clicks      INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  position    REAL NOT NULL DEFAULT 0,
  gsc_window  TEXT,                  -- the actual GSC date range pulled
  PRIMARY KEY (date, host, query)
);

CREATE TABLE IF NOT EXISTS daily_pages (
  date        TEXT NOT NULL,         -- snapshot date (matches daily_traffic)
  host        TEXT NOT NULL,
  page        TEXT NOT NULL,
  clicks      INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr         REAL NOT NULL DEFAULT 0,
  position    REAL NOT NULL DEFAULT 0,
  gsc_window  TEXT,
  PRIMARY KEY (date, host, page)
);

-- Landing pages from Cloudflare Web Analytics (RUM), covering every referrer
-- (search, social, direct, etc.), unlike daily_pages which is Search-Console-only.
CREATE TABLE IF NOT EXISTS daily_cf_pages (
  date   TEXT NOT NULL,              -- UTC date the 24h window ended (matches daily_traffic)
  host   TEXT NOT NULL,
  page   TEXT NOT NULL,              -- requestPath, e.g. "/foo"
  visits INTEGER NOT NULL DEFAULT 0, -- sessions that entered on this path
  views  INTEGER NOT NULL DEFAULT 0, -- pageviews of this path
  PRIMARY KEY (date, host, page)
);

CREATE TABLE IF NOT EXISTS daily_search_summary (
  date        TEXT NOT NULL,         -- snapshot date (matches daily_traffic)
  host        TEXT NOT NULL,
  clicks      INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr         REAL NOT NULL DEFAULT 0,
  position    REAL NOT NULL DEFAULT 0,
  gsc_window  TEXT,
  PRIMARY KEY (date, host)
);

-- Zone-log traffic detail (hosts with trafficSource: "zone" in config.js —
-- file hosts with no RUM beacon). Free-plan httpRequestsAdaptiveGroups has no
-- referrer dimension, so country and status code stand in for the referrer
-- and search-console panels that hosts with real GSC properties get instead.
CREATE TABLE IF NOT EXISTS daily_zone_countries (
  date    TEXT NOT NULL,
  host    TEXT NOT NULL,
  country TEXT NOT NULL,
  visits  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, host, country)
);

CREATE TABLE IF NOT EXISTS daily_zone_status (
  date     TEXT NOT NULL,
  host     TEXT NOT NULL,
  status   INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, host, status)
);

-- Verified-crawler breakdown for zone-sourced hosts, from the
-- verifiedBotCategory dimension. Cloudflare labels only the bots it
-- cryptographically verifies, so these rows are a FLOOR on crawler volume, never
-- a bot/human split: everything unverified lands in the single '(unverified)'
-- row, which mixes real people with unverified and spoofing crawlers and cannot
-- be separated further (botScore is plan-gated on this zone). Nothing derives a
-- human count from this table.
CREATE TABLE IF NOT EXISTS daily_zone_bots (
  date     TEXT NOT NULL,
  host     TEXT NOT NULL,
  category TEXT NOT NULL,             -- e.g. 'AI Crawler', 'Archiver', or '(unverified)'
  requests INTEGER NOT NULL DEFAULT 0,
  visits   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, host, category)
);

CREATE TABLE IF NOT EXISTS runs (
  run_at TEXT PRIMARY KEY,
  date   TEXT,
  ok     INTEGER,
  note   TEXT
);

CREATE INDEX IF NOT EXISTS idx_traffic_date ON daily_traffic(date);
CREATE INDEX IF NOT EXISTS idx_ref_dh ON daily_referrers(date, host);
CREATE INDEX IF NOT EXISTS idx_kw_dh  ON daily_keywords(date, host);
CREATE INDEX IF NOT EXISTS idx_pages_dh ON daily_pages(date, host);
CREATE INDEX IF NOT EXISTS idx_cf_pages_dh ON daily_cf_pages(date, host);
CREATE INDEX IF NOT EXISTS idx_search_summary_dh ON daily_search_summary(date, host);
CREATE INDEX IF NOT EXISTS idx_zone_countries_dh ON daily_zone_countries(date, host);
CREATE INDEX IF NOT EXISTS idx_zone_status_dh ON daily_zone_status(date, host);
CREATE INDEX IF NOT EXISTS idx_zone_bots_dh ON daily_zone_bots(date, host);
