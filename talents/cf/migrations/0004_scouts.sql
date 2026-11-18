-- Discovery Phase 2 (multi-channel scouts): provenance, priority,
-- sync watermarks, scout run log, and external traction signals.
--
-- ONE FUNNEL: every channel (GitHub code search, the MCP Registry,
-- npm, skills.sh, web search, X) only NOMINATES candidates into the
-- sources table. Channels never write records. Verification — the
-- existing git-tree / content checks — alone decides what ingests,
-- and priority orders the verification queue; it is never trust.

-- Every nomination appends a provenance entry (JSON array):
-- {via, at, ref?, signals?, note?} — the query/feed/post that found
-- the candidate, its URL, and channel-specific signals (stars,
-- installs, downloads, engagement). Corroboration = the same
-- canonical locator nominated again by another channel: provenance
-- grows and priority rises instead of a second row appearing.
ALTER TABLE sources ADD COLUMN provenance TEXT;
ALTER TABLE sources ADD COLUMN priority REAL NOT NULL DEFAULT 0;
CREATE INDEX idx_sources_priority ON sources (status, priority DESC);

-- Per-scout incremental sync state (e.g. the MCP Registry
-- updated_since watermark), as opaque key/value rows.
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per scout run: who ran, when, and the run's counters
-- (nominated / new / corroborated / verified / ingested / records)
-- as JSON — the run log the gate and the README quote.
CREATE TABLE scout_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scout TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  stats TEXT
);
CREATE INDEX idx_scout_runs_scout ON scout_runs (scout, started_at);

-- External traction (e.g. skills.sh install counts) lives NEXT TO our
-- own gateway/install counters, never on top of them: refreshStats
-- owns calls_*/installs_*; scouts own external_* only.
ALTER TABLE record_stats ADD COLUMN external_installs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE record_stats ADD COLUMN external_source TEXT;
