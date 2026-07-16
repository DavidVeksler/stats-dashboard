-- stats-dashboard D1 schema
-- Apply with:  npm run schema   (or via the Cloudflare D1 console)

CREATE TABLE IF NOT EXISTS daily_traffic (
  date   TEXT NOT NULL,              -- UTC date the 24h window ended
  host   TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0, -- Cloudflare Web Analytics sessions
  views  INTEGER NOT NULL DEFAULT 0, -- pageviews
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

CREATE TABLE IF NOT EXISTS runs (
  run_at TEXT PRIMARY KEY,
  date   TEXT,
  ok     INTEGER,
  note   TEXT
);

CREATE INDEX IF NOT EXISTS idx_traffic_date ON daily_traffic(date);
CREATE INDEX IF NOT EXISTS idx_ref_dh ON daily_referrers(date, host);
CREATE INDEX IF NOT EXISTS idx_kw_dh  ON daily_keywords(date, host);
