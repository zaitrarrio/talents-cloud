-- Enrichment Tranche 1 (ENRICHMENT.md) — layers A (source facts),
-- B (structural deepening), C (live MCP introspection). Layers D
-- (generated editorial) and E (trust signals) are the NEXT tranche;
-- their columns exist now (state + JSON, default 'none'/NULL) so
-- they slot in without another migration.
--
-- Enrichment is a pipeline stage of its own — NOT verification and
-- NOT ranking. A row here never changes whether a record is listed;
-- it only deepens what the catalog knows about it. Per-layer state:
--   pending | done | partial | none | stale
-- with the layer payload as JSON and the source hash the payload
-- was computed against (the record's attestation content hash, or a
-- documented fallback for unattested pointer records). A hash change
-- marks layers stale; A and C additionally refresh on cadence.
--
-- Display assets (README text, icon images) live in the R2 bucket
-- `talents-assets`, keyed by skill id (`readme/{id}`, `icon/{id}`);
-- the source URL of every asset is recorded in a_json — the bucket
-- is never the only copy of a source URL, and pages never hot-link
-- the origin at render time.

CREATE TABLE enrichment (
  skill_id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  a_state TEXT NOT NULL DEFAULT 'pending',
  b_state TEXT NOT NULL DEFAULT 'pending',
  c_state TEXT NOT NULL DEFAULT 'pending',
  d_state TEXT NOT NULL DEFAULT 'none',
  e_state TEXT NOT NULL DEFAULT 'none',
  a_json TEXT,
  b_json TEXT,
  c_json TEXT,
  d_json TEXT,
  e_json TEXT,
  a_at TEXT,
  b_at TEXT,
  c_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_enrichment_a_state ON enrichment (a_state);
CREATE INDEX idx_enrichment_b_state ON enrichment (b_state);
CREATE INDEX idx_enrichment_c_state ON enrichment (c_state);
