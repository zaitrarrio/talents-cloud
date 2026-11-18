-- Vectorize ids are capped at 64 bytes; some owner/name record ids
-- are longer. embedding_meta therefore also stores the vector id
-- actually used in the index (sha256 hex of the record id — exactly
-- 64 chars), so query results can be mapped back to records.
ALTER TABLE embedding_meta ADD COLUMN vector_id TEXT;
CREATE INDEX idx_embedding_meta_vector ON embedding_meta (vector_id);
