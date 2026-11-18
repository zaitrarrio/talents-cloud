-- Drain hardening (2026-11-11, gate-harden-drain): processing
-- leases on sources + the DLQ manifest.
--
-- Leases (claimed_at / claimed_by) are operational metadata, not
-- source identity: they are deliberately NOT part of the SourceRow
-- upsert path — upsertSource never touches them, so a lease
-- survives the status upserts of the row it guards, and terminal
-- outcomes / the DLQ sweep release them explicitly. A lease is
-- advisory (idempotent ingest is the real safety net); it only
-- deconflicts the two transports (queue consumer vs sandbox drain)
-- and duplicate deliveries.
CREATE TABLE IF NOT EXISTS dlq_entries (
  kind TEXT NOT NULL,
  locator TEXT NOT NULL,
  failure_class TEXT NOT NULL,  -- rate-limit | network | server | unknown (all transient by construction)
  attempts INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (kind, locator)
);
ALTER TABLE sources ADD COLUMN claimed_at TEXT;
ALTER TABLE sources ADD COLUMN claimed_by TEXT;
CREATE INDEX IF NOT EXISTS sources_claimed_idx ON sources(status, claimed_at);
