// Enrichment store (Tranche 1): the `enrichment` table behind one
// interface with two implementations, mirroring the discovery store:
//   - D1EnrichmentStore — over the structural D1Like (Worker env.DB in
//     production; the wrangler-backed adapter from the operator CLI).
//   - InMemoryEnrichmentStore — for tests and dry runs.
//
// The store also owns the two read/write paths enrichment has into
// the search layer:
//   - appendSearchExtras: sub-inventory names + introspected tool
//     names (derived class) are appended to the record's FTS
//     `components` field and to records.search_text. Weighting choice
//     (documented): extras land in `components`, whose bm25 weight
//     (3.0) equals declared components — a contained skill's name or
//     a tool's name IS a component-level fact about the parent
//     record; it does not touch name (5.0) or description (2.0).
//   - searchExtrasOf / extrasForIds: the same extras string feeds the
//     embedding text (see discovery/embeddings.ts), so the vector
//     layer and the keyword layer see the same derived text.
// A later re-ingest (upsertRecord) rewrites both fields from the
// bare record; the next enrichment pass re-appends — the append is
// recomputed from the record every time, so it is idempotent.

import type { SkillRecord } from "../types.js";
import type { D1Like } from "../search-d1.js";
import { toSearchDocument } from "../search.js";
import { searchTextOf } from "../discovery/store.js";
import {
  STATEMENT_BUDGET_BYTES, TEXT_CHUNK_BYTES, chunkTextByBytes, estimateStatementBytes,
} from "../d1-limits.js";
import type { EnrichLayer, EnrichmentRow, LayerState } from "./types.js";

export interface EnrichmentStore {
  get(skillId: string): Promise<EnrichmentRow | null>;
  /** Insert the row if absent, then set one layer's state/payload/
   *  timestamp and the row's source hash + updated_at. */
  upsertLayer(
    skillId: string,
    sourceHash: string,
    layer: EnrichLayer,
    state: LayerState,
    payload: unknown | null,
    at: string,
  ): Promise<void>;
  /** The record's source hash changed: layers that had a verdict
   *  (done/partial/none) become `stale` so the pipeline re-runs
   *  them; pending stays pending. Payloads are kept for display
   *  until replaced. Returns true when a row existed and changed. */
  reconcileHash(skillId: string, newHash: string, at: string): Promise<boolean>;
}

interface EnrichmentDbRow {
  skill_id: string;
  source_hash: string;
  a_state: string; b_state: string; c_state: string; d_state: string; e_state: string;
  a_json: string | null; b_json: string | null; c_json: string | null;
  d_json: string | null; e_json: string | null;
  a_at: string | null; b_at: string | null; c_at: string | null;
  updated_at: string;
}

const ENRICH_COLS = "skill_id, source_hash, a_state, b_state, c_state, d_state, e_state, a_json, b_json, c_json, d_json, e_json, a_at, b_at, c_at, updated_at";

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

const mapRow = (r: EnrichmentDbRow): EnrichmentRow => ({
  skillId: r.skill_id,
  sourceHash: r.source_hash,
  aState: r.a_state as LayerState,
  bState: r.b_state as LayerState,
  cState: r.c_state as LayerState,
  dState: r.d_state as LayerState,
  eState: r.e_state as LayerState,
  a: parseJson(r.a_json),
  b: parseJson(r.b_json),
  c: parseJson(r.c_json),
  d: parseJson(r.d_json),
  e: parseJson(r.e_json),
  aAt: r.a_at,
  bAt: r.b_at,
  cAt: r.c_at,
  updatedAt: r.updated_at,
});

/** Layer → columns. Layers D/E have no dedicated *_at column in
 *  migration 0006 (their timestamps live inside their payloads —
 *  generatedAt / scannedAt), so `at` is null and upsertLayer writes
 *  only state + JSON + updated_at for them. */
const LAYER_COLS: Record<EnrichLayer, { state: string; json: string; at: string | null }> = {
  a: { state: "a_state", json: "a_json", at: "a_at" },
  b: { state: "b_state", json: "b_json", at: "b_at" },
  c: { state: "c_state", json: "c_json", at: "c_at" },
  d: { state: "d_state", json: "d_json", at: null },
  e: { state: "e_state", json: "e_json", at: null },
};

export class D1EnrichmentStore implements EnrichmentStore {
  constructor(private db: D1Like) {}

  async get(skillId: string): Promise<EnrichmentRow | null> {
    const row = await this.db
      .prepare(`SELECT ${ENRICH_COLS} FROM enrichment WHERE skill_id = ?`)
      .bind(skillId)
      .first<EnrichmentDbRow>();
    return row ? mapRow(row) : null;
  }

  async upsertLayer(
    skillId: string,
    sourceHash: string,
    layer: EnrichLayer,
    state: LayerState,
    payload: unknown | null,
    at: string,
  ): Promise<void> {
    const cols = LAYER_COLS[layer];
    const payloadJson = payload === null ? null : JSON.stringify(payload);
    const sql = cols.at
      ? `INSERT INTO enrichment (skill_id, source_hash, ${cols.state}, ${cols.json}, ${cols.at}, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(skill_id) DO UPDATE SET
             source_hash = excluded.source_hash,
             ${cols.state} = excluded.${cols.state},
             ${cols.json} = excluded.${cols.json},
             ${cols.at} = excluded.${cols.at},
             updated_at = excluded.updated_at`
      : `INSERT INTO enrichment (skill_id, source_hash, ${cols.state}, ${cols.json}, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(skill_id) DO UPDATE SET
             source_hash = excluded.source_hash,
             ${cols.state} = excluded.${cols.state},
             ${cols.json} = excluded.${cols.json},
             updated_at = excluded.updated_at`;
    const params: unknown[] = cols.at
      ? [skillId, sourceHash, state, payloadJson, at, at]
      : [skillId, sourceHash, state, payloadJson, at];
    // D1 statement discipline (src/d1-limits.ts — the same rule the
    // drain fix applied to the record store): D1 rejects any single
    // statement over 100,000 bytes, and the layer payload is the one
    // unbounded value here. Layer B sub-inventories (200 entries)
    // and Layer C introspection dumps (200 tools) are source-shaped;
    // nothing bounds their total JSON, so a large collection can
    // cross the limit in this one INSERT. Below the budget the write
    // is the historic single statement; above it the upsert carries
    // the first bounded chunk of the payload and the remaining
    // chunks are appended with `||` — the stored JSON is
    // byte-identical either way (round-trip asserted in
    // test/d1harden.test.ts).
    if (payloadJson === null || estimateStatementBytes(sql, params) <= STATEMENT_BUDGET_BYTES) {
      await this.db.prepare(sql).bind(...params).run();
      return;
    }
    const chunks = chunkTextByBytes(payloadJson, TEXT_CHUNK_BYTES);
    const firstParams: unknown[] = cols.at
      ? [skillId, sourceHash, state, chunks[0] ?? "", at, at]
      : [skillId, sourceHash, state, chunks[0] ?? "", at];
    await this.db.prepare(sql).bind(...firstParams).run();
    for (const chunk of chunks.slice(1)) {
      await this.db
        .prepare(`UPDATE enrichment SET ${cols.json} = ${cols.json} || ? WHERE skill_id = ?`)
        .bind(chunk, skillId)
        .run();
    }
  }

  async reconcileHash(skillId: string, newHash: string, at: string): Promise<boolean> {
    const row = await this.get(skillId);
    if (!row || row.sourceHash === newHash) return false;
    await this.db
      .prepare(
        `UPDATE enrichment SET
           source_hash = ?,
           a_state = CASE WHEN a_state IN ('done','partial','none') THEN 'stale' ELSE a_state END,
           b_state = CASE WHEN b_state IN ('done','partial','none') THEN 'stale' ELSE b_state END,
           c_state = CASE WHEN c_state IN ('done','partial','none') THEN 'stale' ELSE c_state END,
           d_state = CASE WHEN d_state IN ('done','partial') THEN 'stale'
                          WHEN d_state = 'none' AND d_json IS NOT NULL THEN 'stale'
                          ELSE d_state END,
           e_state = CASE WHEN e_state IN ('done','partial') THEN 'stale'
                          WHEN e_state = 'none' AND e_json IS NOT NULL THEN 'stale'
                          ELSE e_state END,
           updated_at = ?
         WHERE skill_id = ?`,
      )
      .bind(newHash, at, skillId)
      .run();
    return true;
  }
}

export class InMemoryEnrichmentStore implements EnrichmentStore {
  rows = new Map<string, EnrichmentRow>();

  async get(skillId: string): Promise<EnrichmentRow | null> {
    return this.rows.get(skillId) ?? null;
  }

  async upsertLayer(
    skillId: string,
    sourceHash: string,
    layer: EnrichLayer,
    state: LayerState,
    payload: unknown | null,
    at: string,
  ): Promise<void> {
    const prev: EnrichmentRow = this.rows.get(skillId) ?? {
      skillId, sourceHash,
      aState: "pending", bState: "pending", cState: "pending", dState: "none", eState: "none",
      a: null, b: null, c: null, d: null, e: null, aAt: null, bAt: null, cAt: null, updatedAt: at,
    };
    const next = { ...prev, sourceHash, updatedAt: at };
    if (layer === "a") { next.aState = state; next.a = payload as EnrichmentRow["a"]; next.aAt = at; }
    if (layer === "b") { next.bState = state; next.b = payload as EnrichmentRow["b"]; next.bAt = at; }
    if (layer === "c") { next.cState = state; next.c = payload as EnrichmentRow["c"]; next.cAt = at; }
    if (layer === "d") { next.dState = state; next.d = payload as EnrichmentRow["d"]; }
    if (layer === "e") { next.eState = state; next.e = payload as EnrichmentRow["e"]; }
    this.rows.set(skillId, next);
  }

  async reconcileHash(skillId: string, newHash: string, at: string): Promise<boolean> {
    const prev = this.rows.get(skillId);
    if (!prev || prev.sourceHash === newHash) return false;
    const flip = (s: LayerState): LayerState =>
      s === "done" || s === "partial" || s === "none" ? "stale" : s;
    // D/E: 'none' is also the never-attempted schema default — only
    // an EVALUATED none (payload present, e.g. a D withholding
    // verdict) goes stale; a bare default stays untouched.
    const flipDE = (s: LayerState, payload: unknown): LayerState =>
      s === "done" || s === "partial" || (s === "none" && payload !== null) ? "stale" : s;
    this.rows.set(skillId, {
      ...prev,
      sourceHash: newHash,
      aState: flip(prev.aState), bState: flip(prev.bState), cState: flip(prev.cState),
      dState: flipDE(prev.dState, prev.d), eState: flipDE(prev.eState, prev.e),
      updatedAt: at,
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Traffic-order paging (POST /admin/enrich mirrors /admin/embed's
// paged contract; the operator script drives the same code)
// ---------------------------------------------------------------------------

export interface TrafficCursor {
  /** behavior_score of the last row of the previous page. */
  s: number;
  /** calls_30d of the last row of the previous page. */
  c: number;
  /** record id of the last row of the previous page. */
  id: string;
}

export function encodeTrafficCursor(cursor: TrafficCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeTrafficCursor(raw: string | null | undefined): TrafficCursor | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as TrafficCursor;
    if (typeof j.s !== "number" || typeof j.c !== "number" || typeof j.id !== "string") return null;
    return j;
  } catch {
    return null;
  }
}

export interface TrafficPageItem {
  record: SkillRecord;
  enrichment: EnrichmentRow | null;
  behaviorScore: number;
  calls30d: number;
}

/**
 * One page of listed records in TRAFFIC ORDER: record_stats
 * behavior_score desc, calls_30d desc, then record id asc (the
 * deterministic tail for the zero-traffic majority), with each
 * record's enrichment row attached. Keyset-paged on the sort tuple.
 */
export async function trafficPage(
  db: D1Like,
  cursor: TrafficCursor | null,
  limit: number,
): Promise<TrafficPageItem[]> {
  const keyset = cursor
    ? `AND (
        COALESCE(rs.behavior_score, 0) < ?
        OR (COALESCE(rs.behavior_score, 0) = ? AND COALESCE(rs.calls_30d, 0) < ?)
        OR (COALESCE(rs.behavior_score, 0) = ? AND COALESCE(rs.calls_30d, 0) = ? AND r.id > ?)
      )`
    : "";
  const sql = `
    SELECT r.record_json AS record_json,
      COALESCE(rs.behavior_score, 0) AS behavior_score,
      COALESCE(rs.calls_30d, 0) AS calls_30d,
      ${ENRICH_COLS.split(", ").map((c) => `e.${c} AS e_${c}`).join(", ")}
    FROM records r
    LEFT JOIN record_stats rs ON rs.skill_id = r.id
    LEFT JOIN enrichment e ON e.skill_id = r.id
    WHERE r.status = 'listed' ${keyset}
    ORDER BY COALESCE(rs.behavior_score, 0) DESC, COALESCE(rs.calls_30d, 0) DESC, r.id ASC
    LIMIT ?`;
  const stmt = db.prepare(sql);
  const bound = cursor
    ? stmt.bind(cursor.s, cursor.s, cursor.c, cursor.s, cursor.c, cursor.id, limit)
    : stmt.bind(limit);
  const { results } = await bound.all<Record<string, unknown>>();
  return results.map((row) => {
    const enrichment = row.e_skill_id
      ? mapRow({
          skill_id: row.e_skill_id as string,
          source_hash: row.e_source_hash as string,
          a_state: row.e_a_state as string, b_state: row.e_b_state as string,
          c_state: row.e_c_state as string, d_state: row.e_d_state as string,
          e_state: row.e_e_state as string,
          a_json: row.e_a_json as string | null, b_json: row.e_b_json as string | null,
          c_json: row.e_c_json as string | null,
          d_json: row.e_d_json as string | null, e_json: row.e_e_json as string | null,
          a_at: row.e_a_at as string | null, b_at: row.e_b_at as string | null,
          c_at: row.e_c_at as string | null, updated_at: row.e_updated_at as string,
        })
      : null;
    return {
      record: JSON.parse(row.record_json as string) as SkillRecord,
      enrichment,
      behaviorScore: row.behavior_score as number,
      calls30d: row.calls_30d as number,
    };
  });
}

// ---------------------------------------------------------------------------
// Search-layer extras (derived class)
// ---------------------------------------------------------------------------

/** The derived names a record's enrichment contributes to search:
 *  sub-inventory entry names (B) + introspected tool names (C).
 *  Deduped, order-stable, capped — these strings land in FTS and in
 *  the embedding text, so they stay name-like, never prose. */
export function searchExtrasOf(row: EnrichmentRow | null): string[] {
  if (!row) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const n = name.trim();
    if (!n || seen.has(n.toLowerCase())) return;
    seen.add(n.toLowerCase());
    out.push(n);
  };
  for (const e of row.b?.subInventory ?? []) push(e.name);
  for (const t of row.c?.tools ?? []) push(t.name);
  return out.slice(0, 200);
}

/** The GENERATED strings a record's Layer D contributes to search:
 *  tags + use cases (only when D actually generated — a withheld or
 *  failed D contributes nothing). Weighting (documented, Tranche 2):
 *  generated text is the LOWEST tier of the three classes —
 *    source text     → FTS name/description, fully ranked;
 *    derived extras  → FTS components (recall + token matching);
 *    generated text  → records.search_text ONLY (the engine's LIKE
 *                      last-resort pass, reached per-token only when
 *                      no record matches that token in FTS) plus the
 *                      embedding text (after the derived extras).
 *  So a generated term can surface a record for vocabulary that
 *  exists nowhere in source/derived text, but it can never win
 *  keyword ranking against a source or derived match. */
export function generatedExtrasOf(row: EnrichmentRow | null): string[] {
  if (!row || row.dState !== "done" || !row.d || !("oneLine" in row.d)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = s.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  for (const t of row.d.tags) push(t);
  for (const u of row.d.useCases) push(u);
  return out;
}

/** Extras string for a batch of records (the embed path's lookup):
 *  derived extras first, generated text after — one combined string
 *  for embeddingText(). Chunked at 50 ids per query: D1 caps bound
 *  variables per statement (~100), and embed pages run larger than
 *  that — an unchunked IN (…) blew up /admin/embed pages of 200 with
 *  "too many SQL variables" (found in the tranche-1 gate run). */
export async function extrasForIds(db: D1Like, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const placeholders = part.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT ${ENRICH_COLS} FROM enrichment WHERE skill_id IN (${placeholders})`)
      .bind(...part)
      .all<EnrichmentDbRow>();
    for (const r of results) {
      const row = mapRow(r);
      const extras = [...searchExtrasOf(row), ...generatedExtrasOf(row)];
      if (extras.length) out.set(r.skill_id, extras.join(" "));
    }
  }
  return out;
}

/** Full enrichment rows for a batch of ids (API payloads, creator
 *  dashboard). Same 50-id chunking discipline as extrasForIds. */
export async function enrichmentForIds(db: D1Like, ids: string[]): Promise<Map<string, EnrichmentRow>> {
  const out = new Map<string, EnrichmentRow>();
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const placeholders = part.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT ${ENRICH_COLS} FROM enrichment WHERE skill_id IN (${placeholders})`)
      .bind(...part)
      .all<EnrichmentDbRow>();
    for (const r of results) out.set(r.skill_id, mapRow(r));
  }
  return out;
}

/**
 * Append the enrichment extras to the record's search text.
 * Derived extras (sub-inventory + tool names) go to BOTH the FTS
 * `components` field and records.search_text; generated extras
 * (tags + use cases) go to records.search_text ONLY — the tiering
 * documented on generatedExtrasOf. Recomputed from the bare record
 * on every call — idempotent. See the module header for the
 * weighting rationale.
 */
export async function appendSearchExtras(
  db: D1Like,
  record: SkillRecord,
  extras: string[],
  generatedExtras: string[] = [],
): Promise<void> {
  const doc = toSearchDocument(record);
  const extra = extras.join(" ");
  const gen = generatedExtras.join(" ");
  const searchText = [searchTextOf(record), extra.toLowerCase(), gen.toLowerCase()].filter(Boolean).join(" ");
  // D1 statement discipline (src/d1-limits.ts): the recomputed
  // search text and the FTS row duplicate the record's full
  // description/declaration text, which the chunked ingest path
  // deliberately stores at sizes past the 100,000-byte statement
  // limit (the biggest collections' search_text alone is ~42 KB and
  // grows with the catalog). Writing either back in ONE statement
  // would throw SQLITE_TOOBIG on exactly the records enrichment
  // most needs to touch — so both writes use the record store's
  // split pattern: below the budget the historic single statement,
  // above it a first bounded chunk plus `||` appends, byte-identical
  // result either way.
  const searchSql = "UPDATE records SET search_text = ? WHERE id = ?";
  if (estimateStatementBytes(searchSql, [searchText, record.id]) <= STATEMENT_BUDGET_BYTES) {
    await db.prepare(searchSql).bind(searchText, record.id).run();
  } else {
    const chunks = chunkTextByBytes(searchText, TEXT_CHUNK_BYTES);
    await db.prepare(searchSql).bind(chunks[0] ?? "", record.id).run();
    for (const chunk of chunks.slice(1)) {
      await db
        .prepare("UPDATE records SET search_text = search_text || ? WHERE id = ?")
        .bind(chunk, record.id)
        .run();
    }
  }
  await db.prepare("DELETE FROM skills_fts WHERE id = ?").bind(record.id).run();
  const components = extra ? `${doc.components.join(" ")} ${extra}` : doc.components.join(" ");
  const ftsSql = "INSERT INTO skills_fts (id, name, description, components, declaration_text) VALUES (?, ?, ?, ?, ?)";
  if (estimateStatementBytes(ftsSql, [doc.id, doc.name, doc.description, components, doc.declarationText]) <= STATEMENT_BUDGET_BYTES) {
    await db.prepare(ftsSql).bind(doc.id, doc.name, doc.description, components, doc.declarationText).run();
  } else {
    const descChunks = chunkTextByBytes(doc.description, TEXT_CHUNK_BYTES);
    const compChunks = chunkTextByBytes(components, TEXT_CHUNK_BYTES);
    const declChunks = chunkTextByBytes(doc.declarationText, TEXT_CHUNK_BYTES);
    await db
      .prepare(ftsSql)
      .bind(doc.id, doc.name, descChunks[0] ?? "", compChunks[0] ?? "", declChunks[0] ?? "")
      .run();
    const appendChunks = async (column: string, chunks: string[]) => {
      for (const chunk of chunks.slice(1)) {
        await db
          .prepare(`UPDATE skills_fts SET ${column} = ${column} || ? WHERE id = ?`)
          .bind(chunk, doc.id)
          .run();
      }
    };
    await appendChunks("description", descChunks);
    await appendChunks("components", compChunks);
    await appendChunks("declaration_text", declChunks);
  }
}
