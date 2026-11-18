-- Talents D1 schema (P2) — the production store on the full Cloudflare
-- stack (ARCHITECTURE-v2 §6). The registry stores metadata, pointers,
-- declarations and attestations — never the skill itself.

-- One row per catalog record. Scalar columns serve filters/facets;
-- record_json carries the full SkillRecord for page rendering (the P1
-- templates render from the record shape unchanged); search_text is the
-- flattened lowercase text the LIKE fallback pass scans.
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  source_repo TEXT,
  ref TEXT NOT NULL,
  record_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  attestation_hash TEXT,
  ingested_at TEXT NOT NULL
);
CREATE INDEX idx_records_owner ON records (owner);
CREATE INDEX idx_records_kind ON records (kind);
CREATE INDEX idx_records_status ON records (status);

-- First-come-first-served namespace claims (GitHub-ownership proof is
-- checked by the engine's namespace module before a row is written).
CREATE TABLE namespaces (
  owner TEXT PRIMARY KEY,
  claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0
);

-- Pinned installs written by the MCP gateway's install_skill ceremony
-- (step 2 only, after attestation re-verification).
CREATE TABLE installs (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  pinned_ref TEXT NOT NULL,
  attestation_hash TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  installer TEXT NOT NULL
);
CREATE INDEX idx_installs_skill ON installs (skill_id);

-- Behavioral-data seed for P5 discovery ranking: every gateway tool
-- call is logged (tool name, skill when applicable, timestamp).
CREATE TABLE gateway_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL,
  skill_id TEXT,
  called_at TEXT NOT NULL
);
CREATE INDEX idx_gateway_calls_tool ON gateway_calls (tool);

-- Keyword search: FTS5 with the TRIGRAM tokenizer (substring matching;
-- typo tolerance comes from the engine's broadening pass, see
-- ../../src/search-d1.ts). Column order matters — the engine's bm25()
-- weights are (id 0.0, name 5.0, description 2.0, components 3.0,
-- declaration_text 1.0), mirroring the P1 Typesense query_by_weights.
CREATE VIRTUAL TABLE skills_fts USING fts5(
  id UNINDEXED,
  name,
  description,
  components,
  declaration_text,
  tokenize = 'trigram'
);
