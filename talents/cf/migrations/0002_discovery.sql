-- Discovery (P5, ARCHITECTURE-v2 §7 + §9) — the broader discovery
-- process: a source-discovery pipeline (SkillHub v2 / Threads.dev
-- lineage: mining undeclared repos), behavioral ranking stats, and
-- embedding bookkeeping for the Vectorize semantic layer.

-- Candidate sources found by discovery sweeps. A source is a repo (or,
-- later, a URL) that MIGHT carry skills; it is only ingested after the
-- cheap git-tree verification proves it actually contains a
-- marketplace.json, SKILL.md files, or a plugin.json.
CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,             -- marketplace | plugin-repo | skill-repo
  locator TEXT NOT NULL,          -- owner/repo for GitHub sources
  url TEXT,
  discovered_via TEXT NOT NULL,   -- sweep query label / webhook / manual
  status TEXT NOT NULL DEFAULT 'candidate',
                                  -- candidate | verified | ingested | rejected | stale
  reason TEXT,                    -- rejection reason / ingest note
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_ingested TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, locator)
);
CREATE INDEX idx_sources_status ON sources (status);
CREATE INDEX idx_sources_locator ON sources (locator);

-- Behavioral ranking signals (P5), refreshed from gateway_calls +
-- installs + records by the discovery stats job. Behavior is a re-rank
-- factor only — never a filter — so this table may lag safely.
CREATE TABLE record_stats (
  skill_id TEXT PRIMARY KEY,
  calls_30d INTEGER NOT NULL DEFAULT 0,
  calls_7d INTEGER NOT NULL DEFAULT 0,
  calls_prev_7d INTEGER NOT NULL DEFAULT 0,
  installs_total INTEGER NOT NULL DEFAULT 0,
  installs_30d INTEGER NOT NULL DEFAULT 0,
  owner_records INTEGER NOT NULL DEFAULT 0,
  owner_attested_share REAL NOT NULL DEFAULT 0,
  owner_warning_rate REAL NOT NULL DEFAULT 0,
  behavior_score REAL NOT NULL DEFAULT 0,
  refreshed_at TEXT NOT NULL
);

-- Which records have a current vector in Vectorize, and the hash of
-- the exact text that was embedded (staleness = hash differs).
CREATE TABLE embedding_meta (
  skill_id TEXT PRIMARY KEY,
  text_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  embedded_at TEXT NOT NULL
);
