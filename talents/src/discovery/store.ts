// Discovery store (P5): the sources table, record upserts into D1,
// behavioral stats, and embedding bookkeeping — behind one interface
// with two implementations:
//   - D1DiscoveryStore — over the structural D1Like (Worker env.DB in
//     production; the wrangler-backed adapter in the CLI).
//   - InMemoryDiscoveryStore — for tests and dry runs.
// Records written here go through the SAME row shape as the cf seed
// (records + skills_fts + search_text), so every write path — seed,
// pipeline, webhook re-ingest — leaves the catalog identical in form.

import type { SkillRecord } from "../types.js";
import type { D1Like } from "../search-d1.js";
import { toSearchDocument } from "../search.js";
import { behaviorScore, type RecordBehavior, type TrendingRow } from "./ranking.js";
import type { SourceKind } from "./sweep.js";
import {
  STATEMENT_BUDGET_BYTES, TEXT_CHUNK_BYTES, chunkTextByBytes,
} from "../d1-limits.js";

export { chunkTextByBytes };

/** A single inlined statement must stay under the D1 limit
 *  (MAX_D1_STATEMENT_BYTES). The record INSERT carries record_json +
 *  search_text, so the split path engages well below the cap, leaving
 *  headroom for the SQL wrapper text and quote-escaping inflation.
 *  The values live in src/d1-limits.ts (shared with every D1 write
 *  path); these are the record store's historical names for them. */
export const RECORD_STATEMENT_BUDGET_BYTES = STATEMENT_BUDGET_BYTES;
/** Largest TEXT chunk written by one statement in the split path. */
export const RECORD_TEXT_CHUNK_BYTES = TEXT_CHUNK_BYTES;

export type SourceStatus =
  | "candidate" | "verified" | "ingested" | "rejected" | "stale" | "watchlist"
  /** List sources only: the list has been classified and mined for
   *  candidates. Terminal for the list itself — it never moves to
   *  verified/ingested (lists produce candidates, never records). */
  | "mined";

/** One channel's nomination of a source (Phase 2 scouts). The full
 *  history lives on the source row: when a second channel nominates
 *  the same canonical locator, its entry is APPENDED here — never a
 *  second row. Signals (stars, installs, downloads, engagement) are
 *  queue-priority inputs only; they are never trust evidence. */
export interface ProvenanceEntry {
  via: string;
  at: string;
  /** URL of the query/feed/post that produced this nomination. */
  ref?: string;
  signals?: Record<string, number | string>;
  note?: string;
  /** List mining only (via "list"): the locator of the curated list
   *  this nomination was mined from. Each list is its OWN channel
   *  for corroboration (see mergeNomination's channel key). */
  list?: string;
  /** List mining only: the nearest preceding markdown heading above
   *  the link in the list — a category HINT stored on the candidate,
   *  never auto-applied as a record category. */
  section?: string;
}

export interface SourceRow {
  kind: SourceKind;
  locator: string;
  url: string | null;
  discoveredVia: string;
  status: SourceStatus;
  reason: string | null;
  firstSeen: string;
  lastSeen: string;
  lastIngested: string | null;
  recordCount: number;
  /** Phase 2: every channel that nominated this source, in order. */
  provenance: ProvenanceEntry[];
  /** Verification-queue priority: channel weight + corroboration +
   *  log-scaled signals. Orders work; decides nothing. */
  priority: number;
}

export interface NominateInput {
  kind: SourceKind;
  locator: string;
  url?: string | null;
  discoveredVia: string;
  provenance: ProvenanceEntry;
  /** Base priority for this nomination (channel weight + signals),
   *  before the corroboration bonus mergeNomination may add. */
  priorityDelta: number;
  /** Watchlist rows are never verified or ingested (leads, X posts
   *  with no resolvable repo/package). */
  watchlist?: boolean;
  reason?: string;
}

export interface NominateResult {
  row: SourceRow;
  created: boolean;
  /** True when this nomination came from a channel that had not
   *  nominated this locator before. */
  corroborated: boolean;
}

/** Keyset cursor for listCandidatePage: the (priority, locator,
 *  kind) tuple of a page's last row, in the page's sort order. */
export interface CandidateCursor {
  priority: number;
  locator: string;
  kind: SourceKind;
}

/** Processing-lease TTL (drain hardening, 2026-11-11): a consumer
 *  holds a source for this long while it verifies/ingests it. Mean
 *  candidate latency is ~45s and the slowest collections take
 *  minutes; 30 minutes is generous without letting a crashed holder
 *  block the backlog for long. Leases are ADVISORY — idempotent
 *  ingest is the real safety net; the lease only deconflicts the
 *  two transports (queue consumer vs sandbox drain) and duplicate
 *  deliveries. */
export const LEASE_TTL_MINUTES = 30;

/** True when a claimed_at timestamp is still inside the lease TTL
 *  at `nowMs` (epoch ms). A missing or unparseable timestamp means
 *  unleased. */
export function isLeaseActive(
  claimedAt: string | null | undefined,
  nowMs: number,
  ttlMinutes: number = LEASE_TTL_MINUTES,
): boolean {
  if (!claimedAt) return false;
  const at = Date.parse(claimedAt);
  if (Number.isNaN(at)) return false;
  return nowMs - at < ttlMinutes * 60_000;
}

/** One dead-letter-queue arrival: a message that exhausted Queues
 *  retries. The source row stays status='candidate' (DLQ'd
 *  candidates are recoverable by re-enqueueing); this manifest is
 *  the operator-visible record of WHAT failed and HOW, since the
 *  Cloudflare DLQ itself has no read API for the Worker. */
export interface DlqEntry {
  kind: SourceKind;
  locator: string;
  /** Failure class at the final attempt. Deterministic failures
   *  never reach the DLQ (they ack with a D1 rejection), so the
   *  classes here are all transient: rate-limit | network |
   *  server | unknown. A "deterministic" class here would mean a
   *  future path misclassified — the sweep treats it as
   *  needs-review. */
  failureClass: string;
  attempts: number;
  firstSeen: string;
  lastSeen: string;
  error: string | null;
}

/** Bonus when a NEW channel corroborates an existing candidate. */
export const CORROBORATION_BONUS = 2;

const PROVENANCE_CAP = 50;

/** The channel identity of a provenance entry for corroboration.
 *  Normally the channel label (via) — but for list mining each LIST
 *  is its own channel: a candidate named by two different curated
 *  lists is corroborated twice, while the same list naming it again
 *  is not new evidence (multi-list corroboration is the signal the
 *  list design runs on). */
export function provenanceChannelKey(p: ProvenanceEntry): string {
  return p.via === "list" && p.list ? `list:${p.list}` : p.via;
}

/**
 * Pure merge behind store.nominate(): one funnel, one row per
 * canonical locator. A re-nomination never duplicates the row, never
 * resurrects a terminal status (ingested/rejected/stale/watchlist),
 * and never overwrites the first channel's discovered_via — the full
 * channel history is the provenance array.
 */
export function mergeNomination(
  existing: SourceRow | null,
  input: NominateInput,
  at: string,
): NominateResult {
  if (!existing) {
    return {
      created: true,
      corroborated: false,
      row: {
        kind: input.kind,
        locator: input.locator,
        url: input.url ?? null,
        discoveredVia: input.discoveredVia,
        status: input.watchlist ? "watchlist" : "candidate",
        reason: input.reason ?? null,
        firstSeen: at,
        lastSeen: at,
        lastIngested: null,
        recordCount: 0,
        provenance: [input.provenance],
        priority: input.priorityDelta,
      },
    };
  }
  const channels = new Set(existing.provenance.map(provenanceChannelKey));
  if (!channels.size && existing.discoveredVia) channels.add(existing.discoveredVia);
  const corroborated = !channels.has(provenanceChannelKey(input.provenance));
  const priority = existing.priority + (corroborated
    ? input.priorityDelta + CORROBORATION_BONUS
    : input.priorityDelta * 0.25);
  return {
    created: false,
    corroborated,
    row: {
      ...existing,
      url: existing.url ?? input.url ?? null,
      reason: existing.reason ?? input.reason ?? null,
      lastSeen: at,
      provenance: [...existing.provenance, input.provenance].slice(-PROVENANCE_CAP),
      priority,
    },
  };
}

export interface DiscoveryStore {
  getSource(kind: SourceKind, locator: string): Promise<SourceRow | null>;
  /** Phase 2: find a source by canonical locator across all kinds
   *  (corroboration is locator-keyed, not kind-keyed). Prefers
   *  ingested > verified > candidate > watchlist > rejected. */
  getSourceByLocator(locator: string): Promise<SourceRow | null>;
  upsertSource(row: SourceRow): Promise<void>;
  /** Remove one (kind, locator) row. Used by kind reclassification
   *  (a rejected repo row becomes the canonical "list" row for the
   *  same locator — sources are keyed by (kind, locator), so the
   *  superseded twin must go rather than linger). */
  deleteSource(kind: SourceKind, locator: string): Promise<void>;
  /** The one funnel entrance for every scout channel: insert or
   *  corroborate-merge a nomination (see mergeNomination). */
  nominate(input: NominateInput, at: string): Promise<NominateResult>;
  listSources(status?: SourceStatus): Promise<SourceRow[]>;
  /** Every row for one canonical locator, all kinds — twin rows
   *  (provisional-kind nominations of a locator later verified under
   *  another kind) included. The queue consumer's locator-collapse
   *  view; the sandbox drain collapses the same way in memory. */
  listSourcesByLocator(locator: string): Promise<SourceRow[]>;
  /** One page of the verification queue: status='candidate' rows in
   *  verification-priority order (priority DESC, locator ASC, kind
   *  ASC), keyset-paged from `cursor` (the previous page's last row,
   *  null = first page). Feeds the queue-drain producer.
   *  `leaseCutoff` (ISO, optional): when given, rows whose
   *  claimed_at >= the cutoff (an active queue lease) are skipped
   *  — the producer and the sandbox drain both pass it so they
   *  never nominate a source another transport is already
   *  processing. */
  listCandidatePage(opts: {
    limit: number;
    cursor?: CandidateCursor | null;
    leaseCutoff?: string | null;
  }): Promise<{ rows: SourceRow[]; nextCursor: CandidateCursor | null }>;
  /** Processing leases (drain hardening, 2026-11-11): claim a
   *  source for one holder for `ttlMinutes`. Returns false when
   *  another holder's lease is still active — the caller must not
   *  process the row. A stale lease (older than the TTL) is
   *  reclaimable by anyone. Lease state lives in the
   *  claimed_at/claimed_by columns (migration 0007) and is
   *  deliberately NOT part of SourceRow: upsertSource never
   *  touches it, so a lease survives the status upserts of the
   *  row it guards. */
  tryClaimLease(kind: SourceKind, locator: string, holder: string, ttlMinutes: number, now: Date): Promise<boolean>;
  /** Release a lease (terminal outcomes, DLQ-sweep re-enqueue). */
  clearLease(kind: SourceKind, locator: string): Promise<void>;
  /** Leases still inside the TTL at `cutoffIso` (claimed_at >=
   *  cutoff) — the sandbox drain's skip set. */
  listActiveLeases(cutoffIso: string): Promise<{ kind: SourceKind; locator: string; claimedAt: string; claimedBy: string }[]>;
  /** DLQ manifest (migration 0007, dlq_entries table). */
  recordDlqEntry(entry: DlqEntry): Promise<void>;
  listDlqEntries(): Promise<DlqEntry[]>;
  deleteDlqEntry(kind: SourceKind, locator: string): Promise<void>;
  countSourcesByStatus(): Promise<Record<string, number>>;
  existingRecordIds(): Promise<Set<string>>;
  /** One record by id (Phase 2: MCP namespace-collision checks). */
  getRecord(id: string): Promise<SkillRecord | null>;
  /** Record ids whose sourceRepo is this owner/repo (skills.sh
   *  cross-check: attach external traction to existing records). */
  recordIdsBySourceRepo(repo: string): Promise<string[]>;
  upsertRecord(record: SkillRecord): Promise<void>;
  /** Per-scout incremental sync state (watermarks), opaque values. */
  getSyncState(key: string): Promise<string | null>;
  setSyncState(key: string, value: string): Promise<void>;
  /** Append one scout run to the run log. */
  recordScoutRun(scout: string, startedAt: string, finishedAt: string, stats: Record<string, unknown>): Promise<void>;
  /** External traction (e.g. skills.sh installs) — written ONLY to
   *  the external_* columns; our own counters are never touched. */
  setExternalInstalls(skillId: string, installs: number, source: string): Promise<void>;
  getEmbeddingMeta(skillId: string): Promise<{ textHash: string; model: string; vectorId: string | null } | null>;
  setEmbeddingMeta(skillId: string, textHash: string, model: string, at: string, vectorId: string): Promise<void>;
  /** vector_id → skill_id for every embedded record. */
  vectorIdMap(): Promise<Map<string, string>>;
  /** Maintain record_stats for exactly the given records
   *  (incremental — no table scan). Returns rows written. */
  upsertStatsForRecords(records: SkillRecord[], now: Date): Promise<number>;
  /** Recompute record_stats for one keyset page of listed records
   *  (the /admin/stats-rebuild job + the daily cron's heal page).
   *  Cursor is the last record id of the previous page (null = first). */
  rebuildStatsPage(limit: number, cursor: string | null, now: Date): Promise<{ processed: number; nextCursor: string | null; done: boolean }>;
}

export function searchTextOf(record: SkillRecord): string {
  const doc = toSearchDocument(record);
  return [doc.name, doc.description, doc.components.join(" "), doc.declarationText].join(" ").toLowerCase();
}

// ---------------------------------------------------------------------------
// D1 implementation
// ---------------------------------------------------------------------------

interface SourceDbRow {
  kind: string; locator: string; url: string | null; discovered_via: string;
  status: string; reason: string | null; first_seen: string; last_seen: string;
  last_ingested: string | null; record_count: number;
  provenance: string | null; priority: number | null;
}

function parseProvenance(raw: string | null, discoveredVia: string, firstSeen: string): ProvenanceEntry[] {
  if (raw) {
    try {
      const arr = JSON.parse(raw) as ProvenanceEntry[];
      if (Array.isArray(arr)) return arr;
    } catch { /* fall through to the synthesized entry */ }
  }
  // Pre-0004 rows have no provenance array: synthesize the first
  // entry from the columns that migration started from.
  return discoveredVia ? [{ via: discoveredVia, at: firstSeen }] : [];
}

const mapSource = (r: SourceDbRow): SourceRow => ({
  kind: r.kind as SourceKind,
  locator: r.locator,
  url: r.url,
  discoveredVia: r.discovered_via,
  status: r.status as SourceStatus,
  reason: r.reason,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  lastIngested: r.last_ingested,
  recordCount: r.record_count,
  provenance: parseProvenance(r.provenance, r.discovered_via, r.first_seen),
  priority: r.priority ?? 0,
});

const SOURCE_COLS = "kind, locator, url, discovered_via, status, reason, first_seen, last_seen, last_ingested, record_count, provenance, priority";

export class D1DiscoveryStore implements DiscoveryStore {
  constructor(private db: D1Like) {}

  async getSource(kind: SourceKind, locator: string): Promise<SourceRow | null> {
    const row = await this.db
      .prepare(`SELECT ${SOURCE_COLS} FROM sources WHERE kind = ? AND locator = ?`)
      .bind(kind, locator)
      .first<SourceDbRow>();
    return row ? mapSource(row) : null;
  }

  async upsertSource(row: SourceRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sources (${SOURCE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, locator) DO UPDATE SET
           url = excluded.url, status = excluded.status, reason = excluded.reason,
           last_seen = excluded.last_seen, last_ingested = excluded.last_ingested,
           record_count = excluded.record_count, provenance = excluded.provenance,
           priority = excluded.priority`,
      )
      .bind(row.kind, row.locator, row.url, row.discoveredVia, row.status, row.reason,
        row.firstSeen, row.lastSeen, row.lastIngested, row.recordCount,
        JSON.stringify(row.provenance), row.priority)
      .run();
  }

  async getSourceByLocator(locator: string): Promise<SourceRow | null> {
    const row = await this.db
      .prepare(
        `SELECT ${SOURCE_COLS} FROM sources WHERE locator = ?
         ORDER BY CASE status WHEN 'ingested' THEN 0 WHEN 'verified' THEN 1
           WHEN 'candidate' THEN 2 WHEN 'watchlist' THEN 3 WHEN 'mined' THEN 4 WHEN 'stale' THEN 5 ELSE 6 END
         LIMIT 1`,
      )
      .bind(locator)
      .first<SourceDbRow>();
    return row ? mapSource(row) : null;
  }

  async deleteSource(kind: SourceKind, locator: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM sources WHERE kind = ? AND locator = ?")
      .bind(kind, locator)
      .run();
  }

  async nominate(input: NominateInput, at: string): Promise<NominateResult> {
    const existing = await this.getSourceByLocator(input.locator);
    const result = mergeNomination(existing, input, at);
    await this.upsertSource(result.row);
    return result;
  }

  async recordIdsBySourceRepo(repo: string): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT id FROM records WHERE source_repo = ?")
      .bind(repo)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  async getRecord(id: string): Promise<SkillRecord | null> {
    const row = await this.db
      .prepare("SELECT record_json FROM records WHERE id = ?")
      .bind(id)
      .first<{ record_json: string }>();
    return row ? (JSON.parse(row.record_json) as SkillRecord) : null;
  }

  async getSyncState(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM sync_state WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSyncState(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, new Date().toISOString())
      .run();
  }

  async recordScoutRun(scout: string, startedAt: string, finishedAt: string, stats: Record<string, unknown>): Promise<void> {
    await this.db
      .prepare("INSERT INTO scout_runs (scout, started_at, finished_at, stats) VALUES (?, ?, ?, ?)")
      .bind(scout, startedAt, finishedAt, JSON.stringify(stats))
      .run();
  }

  async setExternalInstalls(skillId: string, installs: number, source: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO record_stats (skill_id, external_installs, external_source, refreshed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET external_installs = excluded.external_installs,
           external_source = excluded.external_source`,
      )
      .bind(skillId, installs, source, new Date().toISOString())
      .run();
  }

  async listSources(status?: SourceStatus): Promise<SourceRow[]> {
    const stmt = status
      ? this.db.prepare(`SELECT ${SOURCE_COLS} FROM sources WHERE status = ? ORDER BY locator`).bind(status)
      : this.db.prepare(`SELECT ${SOURCE_COLS} FROM sources ORDER BY locator`);
    const { results } = await stmt.all<SourceDbRow>();
    return results.map(mapSource);
  }

  async listSourcesByLocator(locator: string): Promise<SourceRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${SOURCE_COLS} FROM sources WHERE locator = ? ORDER BY kind`)
      .bind(locator)
      .all<SourceDbRow>();
    return results.map(mapSource);
  }

  async listCandidatePage(opts: {
    limit: number;
    cursor?: CandidateCursor | null;
    leaseCutoff?: string | null;
  }): Promise<{ rows: SourceRow[]; nextCursor: CandidateCursor | null }> {
    const limit = Math.max(1, Math.floor(opts.limit));
    const c = opts.cursor ?? null;
    const lease = opts.leaseCutoff ?? null;
    // ISO timestamps order lexicographically; claimed_at >= the
    // cutoff is an active lease (drain hardening).
    const leaseSql = lease ? ` AND (claimed_at IS NULL OR claimed_at < ?)` : ``;
    const stmt = c
      ? this.db
          .prepare(
            `SELECT ${SOURCE_COLS} FROM sources WHERE status = 'candidate'
             AND (priority < ? OR (priority = ? AND locator > ?) OR (priority = ? AND locator = ? AND kind > ?))${leaseSql}
             ORDER BY priority DESC, locator ASC, kind ASC LIMIT ?`,
          )
          .bind(c.priority, c.priority, c.locator, c.priority, c.locator, c.kind, ...(lease ? [lease] : []), limit)
      : this.db
          .prepare(
            `SELECT ${SOURCE_COLS} FROM sources WHERE status = 'candidate'${leaseSql}
             ORDER BY priority DESC, locator ASC, kind ASC LIMIT ?`,
          )
          .bind(...(lease ? [lease] : []), limit);
    const { results } = await stmt.all<SourceDbRow>();
    const rows = results.map(mapSource);
    const last = rows[rows.length - 1];
    return {
      rows,
      nextCursor: rows.length === limit && last
        ? { priority: last.priority, locator: last.locator, kind: last.kind }
        : null,
    };
  }

  /** Processing lease (drain hardening): conditional UPDATE is the
   *  atomic claim (D1 serializes writers); the read-back confirms
   *  this holder won. On the WranglerD1 adapter, reads auto-flush,
   *  so the SELECT sees the UPDATE even before an explicit flush.
   *  The caller compares timestamps, not the read-back row alone:
   *  a concurrent writer in another isolate would show as a
   *  different holder/timestamp. */
  async tryClaimLease(kind: SourceKind, locator: string, holder: string, ttlMinutes: number, now: Date): Promise<boolean> {
    const cutoff = new Date(now.getTime() - ttlMinutes * 60_000).toISOString();
    await this.db
      .prepare(
        `UPDATE sources SET claimed_at = ?, claimed_by = ?
         WHERE kind = ? AND locator = ? AND (claimed_at IS NULL OR claimed_at < ?)`,
      )
      .bind(now.toISOString(), holder, kind, locator, cutoff)
      .run();
    const row = await this.db
      .prepare("SELECT claimed_at, claimed_by FROM sources WHERE kind = ? AND locator = ?")
      .bind(kind, locator)
      .first<{ claimed_at: string | null; claimed_by: string | null }>();
    return row?.claimed_by === holder && row?.claimed_at === now.toISOString();
  }

  async clearLease(kind: SourceKind, locator: string): Promise<void> {
    await this.db
      .prepare("UPDATE sources SET claimed_at = NULL, claimed_by = NULL WHERE kind = ? AND locator = ?")
      .bind(kind, locator)
      .run();
  }

  async listActiveLeases(cutoffIso: string): Promise<{ kind: SourceKind; locator: string; claimedAt: string; claimedBy: string }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT kind, locator, claimed_at, claimed_by FROM sources
         WHERE claimed_at IS NOT NULL AND claimed_at >= ? ORDER BY claimed_at`,
      )
      .bind(cutoffIso)
      .all<{ kind: string; locator: string; claimed_at: string; claimed_by: string }>();
    return results.map((r) => ({
      kind: r.kind as SourceKind,
      locator: r.locator,
      claimedAt: r.claimed_at,
      claimedBy: r.claimed_by,
    }));
  }

  async recordDlqEntry(entry: DlqEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dlq_entries (kind, locator, failure_class, attempts, first_seen, last_seen, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, locator) DO UPDATE SET failure_class = excluded.failure_class,
           attempts = excluded.attempts, last_seen = excluded.last_seen, error = excluded.error`,
      )
      .bind(entry.kind, entry.locator, entry.failureClass, entry.attempts, entry.firstSeen, entry.lastSeen, entry.error)
      .run();
  }

  async listDlqEntries(): Promise<DlqEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT kind, locator, failure_class, attempts, first_seen, last_seen, error
         FROM dlq_entries ORDER BY last_seen DESC LIMIT 500`,
      )
      .all<{ kind: string; locator: string; failure_class: string; attempts: number; first_seen: string; last_seen: string; error: string | null }>();
    return results.map((r) => ({
      kind: r.kind as SourceKind,
      locator: r.locator,
      failureClass: r.failure_class,
      attempts: r.attempts,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      error: r.error,
    }));
  }

  async deleteDlqEntry(kind: SourceKind, locator: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM dlq_entries WHERE kind = ? AND locator = ?")
      .bind(kind, locator)
      .run();
  }

  async countSourcesByStatus(): Promise<Record<string, number>> {
    const { results } = await this.db
      .prepare("SELECT status, COUNT(*) AS n FROM sources GROUP BY status")
      .all<{ status: string; n: number }>();
    const out: Record<string, number> = {};
    for (const r of results) out[r.status] = r.n;
    return out;
  }

  async existingRecordIds(): Promise<Set<string>> {
    const { results } = await this.db.prepare("SELECT id FROM records").all<{ id: string }>();
    return new Set(results.map((r) => r.id));
  }

  async upsertRecord(record: SkillRecord): Promise<void> {
    const doc = toSearchDocument(record);
    const json = JSON.stringify(record);
    const search = searchTextOf(record);
    // D1 rejects any single statement over 100,000 bytes
    // (SQLITE_TOOBIG). A collection record's INSERT carries
    // record_json + search_text — the declaration text appears in
    // both — so large collections cross the limit in one statement
    // (measured 2026-11-11: nomadamas/k-skill 100,314 bytes,
    // dpearson2699/swift-ios-skills 108,975, superkit-agents
    // 103,121, nexscope-ai/ecommerce-skills 105,563). Below the
    // budget the fast path is unchanged; above it the write is
    // split so every emitted statement stays bounded — record_json
    // is complete from the first statement (only search_text is
    // transiently empty), and an over-long record_json is appended
    // in bounded chunks. Nothing is truncated: the stored row is
    // byte-identical to the fast path's.
    const encoder = new TextEncoder();
    const estimate = encoder.encode(json).length + encoder.encode(search).length + 2_000;
    if (estimate <= RECORD_STATEMENT_BUDGET_BYTES) {
      await this.db
        .prepare(
          `INSERT INTO records (id, owner, name, kind, status, source_repo, ref, record_json, search_text, attestation_hash, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, name = excluded.name, kind = excluded.kind,
             status = excluded.status, source_repo = excluded.source_repo, ref = excluded.ref,
             record_json = excluded.record_json, search_text = excluded.search_text,
             attestation_hash = excluded.attestation_hash, ingested_at = excluded.ingested_at`,
        )
        .bind(record.id, record.owner, record.name, record.kind, record.status,
          record.sourceRepo ?? null, record.ref, json, search,
          record.attestation?.contentHash ?? null, record.ingestedAt)
        .run();
    } else {
      const jsonChunks = chunkTextByBytes(json, RECORD_TEXT_CHUNK_BYTES);
      await this.db
        .prepare(
          `INSERT INTO records (id, owner, name, kind, status, source_repo, ref, record_json, search_text, attestation_hash, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, name = excluded.name, kind = excluded.kind,
             status = excluded.status, source_repo = excluded.source_repo, ref = excluded.ref,
             record_json = excluded.record_json, search_text = excluded.search_text,
             attestation_hash = excluded.attestation_hash, ingested_at = excluded.ingested_at`,
        )
        .bind(record.id, record.owner, record.name, record.kind, record.status,
          record.sourceRepo ?? null, record.ref, jsonChunks[0] ?? "", "",
          record.attestation?.contentHash ?? null, record.ingestedAt)
        .run();
      for (const chunk of jsonChunks.slice(1)) {
        await this.db
          .prepare("UPDATE records SET record_json = record_json || ? WHERE id = ?")
          .bind(chunk, record.id)
          .run();
      }
      const searchChunks = chunkTextByBytes(search, RECORD_TEXT_CHUNK_BYTES);
      await this.db
        .prepare("UPDATE records SET search_text = ? WHERE id = ?")
        .bind(searchChunks[0] ?? "", record.id)
        .run();
      for (const chunk of searchChunks.slice(1)) {
        await this.db
          .prepare("UPDATE records SET search_text = search_text || ? WHERE id = ?")
          .bind(chunk, record.id)
          .run();
      }
    }
    await this.db.prepare("DELETE FROM skills_fts WHERE id = ?").bind(record.id).run();
    // The FTS row duplicates the same long text (description and
    // declaration_text are both inside record_json), so when the
    // record needed the chunked path, the FTS row does too: write
    // each long column in bounded chunks. (In the fast path above,
    // the single FTS INSERT is already under the budget.)
    const descChunks = chunkTextByBytes(doc.description, RECORD_TEXT_CHUNK_BYTES);
    const compChunks = chunkTextByBytes(doc.components.join(" "), RECORD_TEXT_CHUNK_BYTES);
    const declChunks = chunkTextByBytes(doc.declarationText, RECORD_TEXT_CHUNK_BYTES);
    const appendChunks = async (column: string, chunks: string[]) => {
      for (const chunk of chunks.slice(1)) {
        await this.db
          .prepare(`UPDATE skills_fts SET ${column} = ${column} || ? WHERE id = ?`)
          .bind(chunk, doc.id)
          .run();
      }
    };
    if (estimate <= RECORD_STATEMENT_BUDGET_BYTES) {
      await this.db
        .prepare("INSERT INTO skills_fts (id, name, description, components, declaration_text) VALUES (?, ?, ?, ?, ?)")
        .bind(doc.id, doc.name, doc.description, doc.components.join(" "), doc.declarationText)
        .run();
    } else {
      await this.db
        .prepare("INSERT INTO skills_fts (id, name, description, components, declaration_text) VALUES (?, ?, ?, ?, ?)")
        .bind(doc.id, doc.name, descChunks[0] ?? "", compChunks[0] ?? "", declChunks[0] ?? "")
        .run();
      await appendChunks("description", descChunks);
      await appendChunks("components", compChunks);
      await appendChunks("declaration_text", declChunks);
    }
  }

  async getEmbeddingMeta(skillId: string): Promise<{ textHash: string; model: string; vectorId: string | null } | null> {
    const row = await this.db
      .prepare("SELECT text_hash, model, vector_id FROM embedding_meta WHERE skill_id = ?")
      .bind(skillId)
      .first<{ text_hash: string; model: string; vector_id: string | null }>();
    return row ? { textHash: row.text_hash, model: row.model, vectorId: row.vector_id } : null;
  }

  async setEmbeddingMeta(skillId: string, textHash: string, model: string, at: string, vectorId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO embedding_meta (skill_id, text_hash, model, embedded_at, vector_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET text_hash = excluded.text_hash, model = excluded.model, embedded_at = excluded.embedded_at, vector_id = excluded.vector_id`,
      )
      .bind(skillId, textHash, model, at, vectorId)
      .run();
  }

  async vectorIdMap(): Promise<Map<string, string>> {
    const { results } = await this.db
      .prepare("SELECT skill_id, vector_id FROM embedding_meta WHERE vector_id IS NOT NULL")
      .all<{ skill_id: string; vector_id: string }>();
    return new Map(results.map((r) => [r.vector_id, r.skill_id]));
  }

  async upsertStatsForRecords(records: SkillRecord[], now: Date): Promise<number> {
    return upsertStatsForRecords(this.db, records, now);
  }
  async rebuildStatsPage(limit: number, cursor: string | null, now: Date): Promise<{ processed: number; nextCursor: string | null; done: boolean }> {
    return rebuildStatsPage(this.db, limit, cursor, now);
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests / dry runs)
// ---------------------------------------------------------------------------

export class InMemoryDiscoveryStore implements DiscoveryStore {
  sources = new Map<string, SourceRow>();
  records = new Map<string, SkillRecord>();
  embeddingMeta = new Map<string, { textHash: string; model: string; vectorId: string | null }>();
  stats = new Map<string, RecordBehavior & { skillId: string }>();
  syncState = new Map<string, string>();
  scoutRuns: { scout: string; startedAt: string; finishedAt: string; stats: Record<string, unknown> }[] = [];
  /** Processing leases (drain hardening): key = kind + "|" + locator. */
  leases = new Map<string, { claimedAt: string; claimedBy: string }>();
  /** DLQ manifest (drain hardening): key = kind + "|" + locator. */
  dlq = new Map<string, DlqEntry>();
  externalInstalls = new Map<string, { installs: number; source: string }>();

  async getSource(kind: SourceKind, locator: string): Promise<SourceRow | null> {
    return this.sources.get(`${kind}:${locator}`) ?? null;
  }
  async getSourceByLocator(locator: string): Promise<SourceRow | null> {
    const rank: Record<string, number> = { ingested: 0, verified: 1, candidate: 2, watchlist: 3, mined: 4, stale: 5, rejected: 6 };
    const matches = [...this.sources.values()].filter((s) => s.locator === locator);
    matches.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
    return matches[0] ?? null;
  }
  async deleteSource(kind: SourceKind, locator: string): Promise<void> {
    this.sources.delete(`${kind}:${locator}`);
  }
  async nominate(input: NominateInput, at: string): Promise<NominateResult> {
    const existing = await this.getSourceByLocator(input.locator);
    const result = mergeNomination(existing, input, at);
    await this.upsertSource(result.row);
    return result;
  }
  async recordIdsBySourceRepo(repo: string): Promise<string[]> {
    return [...this.records.values()].filter((r) => r.sourceRepo === repo).map((r) => r.id);
  }
  async getRecord(id: string): Promise<SkillRecord | null> {
    return this.records.get(id) ?? null;
  }
  async getSyncState(key: string): Promise<string | null> {
    return this.syncState.get(key) ?? null;
  }
  async setSyncState(key: string, value: string): Promise<void> {
    this.syncState.set(key, value);
  }
  async recordScoutRun(scout: string, startedAt: string, finishedAt: string, stats: Record<string, unknown>): Promise<void> {
    this.scoutRuns.push({ scout, startedAt, finishedAt, stats });
  }
  async setExternalInstalls(skillId: string, installs: number, source: string): Promise<void> {
    this.externalInstalls.set(skillId, { installs, source });
  }
  async upsertSource(row: SourceRow): Promise<void> {
    const key = `${row.kind}:${row.locator}`;
    const prev = this.sources.get(key);
    this.sources.set(key, prev ? { ...row, firstSeen: prev.firstSeen } : row);
  }
  async listSources(status?: SourceStatus): Promise<SourceRow[]> {
    return [...this.sources.values()].filter((s) => !status || s.status === status);
  }
  async listSourcesByLocator(locator: string): Promise<SourceRow[]> {
    return [...this.sources.values()]
      .filter((s) => s.locator === locator)
      .sort((a, b) => a.kind.localeCompare(b.kind));
  }
  async listCandidatePage(opts: {
    limit: number;
    cursor?: CandidateCursor | null;
    leaseCutoff?: string | null;
  }): Promise<{ rows: SourceRow[]; nextCursor: CandidateCursor | null }> {
    const limit = Math.max(1, Math.floor(opts.limit));
    const c = opts.cursor ?? null;
    const lease = opts.leaseCutoff ?? null;
    const after = (s: SourceRow) => !c
      || s.priority < c.priority
      || (s.priority === c.priority && s.locator > c.locator)
      || (s.priority === c.priority && s.locator === c.locator && s.kind > c.kind);
    const unleased = (s: SourceRow) => {
      if (!lease) return true;
      const l = this.leases.get(`${s.kind}|${s.locator}`);
      return !l || l.claimedAt < lease;
    };
    const rows = [...this.sources.values()]
      .filter((s) => s.status === "candidate" && after(s) && unleased(s))
      .sort((a, b) => b.priority - a.priority || a.locator.localeCompare(b.locator) || a.kind.localeCompare(b.kind))
      .slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      rows,
      nextCursor: rows.length === limit && last
        ? { priority: last.priority, locator: last.locator, kind: last.kind }
        : null,
    };
  }

  /** In-memory lease: same semantics as the D1 conditional UPDATE
   *  (single-threaded here, so the check-and-set is atomic). */
  async tryClaimLease(kind: SourceKind, locator: string, holder: string, ttlMinutes: number, now: Date): Promise<boolean> {
    const key = `${kind}|${locator}`;
    const cutoff = new Date(now.getTime() - ttlMinutes * 60_000).toISOString();
    const existing = this.leases.get(key);
    if (existing && existing.claimedAt >= cutoff) return false;
    this.leases.set(key, { claimedAt: now.toISOString(), claimedBy: holder });
    return true;
  }

  async clearLease(kind: SourceKind, locator: string): Promise<void> {
    this.leases.delete(`${kind}|${locator}`);
  }

  async listActiveLeases(cutoffIso: string): Promise<{ kind: SourceKind; locator: string; claimedAt: string; claimedBy: string }[]> {
    const out: { kind: SourceKind; locator: string; claimedAt: string; claimedBy: string }[] = [];
    for (const [key, l] of this.leases) {
      if (l.claimedAt < cutoffIso) continue;
      const [kind, locator] = key.split("|");
      out.push({ kind: kind as SourceKind, locator, claimedAt: l.claimedAt, claimedBy: l.claimedBy });
    }
    return out.sort((a, b) => a.claimedAt.localeCompare(b.claimedAt));
  }

  async recordDlqEntry(entry: DlqEntry): Promise<void> {
    const key = `${entry.kind}|${entry.locator}`;
    const existing = this.dlq.get(key);
    this.dlq.set(key, existing ? { ...entry, firstSeen: existing.firstSeen } : entry);
  }

  async listDlqEntries(): Promise<DlqEntry[]> {
    return [...this.dlq.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 500);
  }

  async deleteDlqEntry(kind: SourceKind, locator: string): Promise<void> {
    this.dlq.delete(`${kind}|${locator}`);
  }
  async countSourcesByStatus(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const s of this.sources.values()) out[s.status] = (out[s.status] ?? 0) + 1;
    return out;
  }
  async existingRecordIds(): Promise<Set<string>> {
    return new Set(this.records.keys());
  }
  async upsertRecord(record: SkillRecord): Promise<void> {
    this.records.set(record.id, record);
  }
  async getEmbeddingMeta(skillId: string) {
    return this.embeddingMeta.get(skillId) ?? null;
  }
  async setEmbeddingMeta(skillId: string, textHash: string, model: string, _at: string, vectorId: string): Promise<void> {
    this.embeddingMeta.set(skillId, { textHash, model, vectorId });
  }
  async vectorIdMap(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [skillId, meta] of this.embeddingMeta) if (meta.vectorId) out.set(meta.vectorId, skillId);
    return out;
  }
  async upsertStatsForRecords(records: SkillRecord[], now: Date): Promise<number> {
    const listed = records.filter((r) => r.status === "listed");
    if (!listed.length) return 0;
    // Owner aggregates from the in-memory records map (exact);
    // call counts are 0 — the in-memory store keeps no
    // gateway_calls log.
    const byOwner = new Map<string, { count: number; attested: number; warnings: number }>();
    for (const r of this.records.values()) {
      if (r.status !== "listed") continue;
      const o = byOwner.get(r.owner) ?? { count: 0, attested: 0, warnings: 0 };
      o.count++;
      if (r.attestation) o.attested++;
      o.warnings += r.validation.issues.filter((i) => i.severity === "warning").length;
      byOwner.set(r.owner, o);
    }
    void now;
    let n = 0;
    for (const r of listed) {
      const o = byOwner.get(r.owner) ?? { count: 0, attested: 0, warnings: 0 };
      this.stats.set(r.id, {
        skillId: r.id,
        calls30d: 0, calls7d: 0, callsPrev7d: 0, installsTotal: 0, installs30d: 0,
        ownerAttestedShare: o.count ? o.attested / o.count : 0,
        ownerWarningRate: o.count ? o.warnings / o.count : 0,
      });
      n++;
    }
    return n;
  }
  async rebuildStatsPage(limit: number, cursor: string | null, now: Date): Promise<{ processed: number; nextCursor: string | null; done: boolean }> {
    const page = Math.max(1, Math.min(Math.floor(limit) || 500, 500));
    const ids = [...this.records.values()].filter((r) => r.status === "listed").map((r) => r.id).sort();
    const start = cursor ? ids.findIndex((id) => id > cursor) : 0;
    const from = start === -1 ? ids.length : start;
    const slice = ids.slice(from, from + page);
    const records = slice.map((id) => this.records.get(id)!).filter(Boolean);
    const processed = await this.upsertStatsForRecords(records, now);
    const done = slice.length < page;
    return { processed, nextCursor: done ? null : (slice[slice.length - 1] ?? null), done };
  }
}

// ---------------------------------------------------------------------------
// Behavioral stats over D1 (shared by the D1 store and the Worker routes)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Incremental behavioral stats (P0-1, 2026-11-12): the old
// refreshRecordStats loaded the whole catalog (53.5 MB > D1's 50 MB
// result limit) and then issued one INSERT per listed record
// (22,407 > the 1,000 queries/invocation cap), so it could not
// complete anywhere in the Worker — every verified queue message
// threw after ingest and dead-lettered. Stats are now maintained
// incrementally: ingest updates exactly the records whose stored
// bytes changed, and a paged rebuild job heals drift. No function
// here ever scans the catalog: every query is scoped to explicit
// ids/owners, and multi-row upserts are chunked to the 100
// bound-parameter cap.
// ---------------------------------------------------------------------------

/** Ids per calls/installs aggregate query: 5 cut params + 50 ids = 55 ≤ 100 bound params. */
const STATS_ID_CHUNK = 50;
/** Owners per owner-aggregate query (50 ids, no other params). */
const STATS_OWNER_CHUNK = 50;
/** Rows per multi-row stats upsert: 8 rows × 11 columns = 88 ≤ 100 bound params. */
const STATS_UPSERT_ROWS = 8;
/** Pack owner warning-rate loads to ~200 records each (~0.5 MB per
 *  response at the current 2.4 KB average record_json). A single
 *  owner above the target is one load on its own (largest owner
 *  today: 510 records ≈ 1.2 MB). */
const STATS_OWNER_LOAD_RECORDS = 200;

interface StatsCountsRow {
  id: string;
  calls_30d: number;
  calls_7d: number;
  calls_prev_7d: number;
  installs_total: number;
  installs_30d: number;
}

interface StatsCounts {
  calls30d: number;
  calls7d: number;
  callsPrev7d: number;
  installsTotal: number;
  installs30d: number;
}

interface OwnerAggregate {
  count: number;
  attested: number;
  warnings: number;
}

/** Per-record gateway/install counts, scoped to the given ids (the
 *  same correlated-subquery shape as the old full refresh, with a
 *  WHERE id IN (…) instead of a full-table scan). */
async function statsCountsForIds(db: D1Like, ids: string[], now: Date): Promise<Map<string, StatsCounts>> {
  const out = new Map<string, StatsCounts>();
  if (!ids.length) return out;
  const iso = (d: Date) => d.toISOString();
  const day = 86_400_000;
  const cut30 = iso(new Date(now.getTime() - 30 * day));
  const cut7 = iso(new Date(now.getTime() - 7 * day));
  const cut14 = iso(new Date(now.getTime() - 14 * day));
  for (let i = 0; i < ids.length; i += STATS_ID_CHUNK) {
    const chunk = ids.slice(i, i + STATS_ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(
        `SELECT r.id AS id,
          (SELECT COUNT(*) FROM gateway_calls g WHERE g.skill_id = r.id AND g.called_at >= ?) AS calls_30d,
          (SELECT COUNT(*) FROM gateway_calls g WHERE g.skill_id = r.id AND g.called_at >= ?) AS calls_7d,
          (SELECT COUNT(*) FROM gateway_calls g WHERE g.skill_id = r.id AND g.called_at >= ? AND g.called_at < ?) AS calls_prev_7d,
          (SELECT COUNT(*) FROM installs i WHERE i.skill_id = r.id) AS installs_total,
          (SELECT COUNT(*) FROM installs i WHERE i.skill_id = r.id AND i.installed_at >= ?) AS installs_30d
         FROM records r WHERE r.id IN (${placeholders})`,
      )
      .bind(cut30, cut7, cut14, cut7, cut30, ...chunk)
      .all<StatsCountsRow>();
    for (const a of results) {
      out.set(a.id, {
        calls30d: a.calls_30d, calls7d: a.calls_7d, callsPrev7d: a.calls_prev_7d,
        installsTotal: a.installs_total, installs30d: a.installs_30d,
      });
    }
  }
  return out;
}

/** Per-owner aggregates, computed exactly from the owner's listed
 *  records — counts + attested share in SQL, warning rate from the
 *  owners' record_json loaded in ~200-record packs (never a
 *  full-table scan; each load is bounded by construction). */
async function ownerAggregates(db: D1Like, owners: string[]): Promise<Map<string, OwnerAggregate>> {
  const out = new Map<string, OwnerAggregate>();
  if (!owners.length) return out;
  const counts = new Map<string, { count: number; attested: number }>();
  for (let i = 0; i < owners.length; i += STATS_OWNER_CHUNK) {
    const chunk = owners.slice(i, i + STATS_OWNER_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(
        `SELECT owner, COUNT(*) AS n,
           SUM(CASE WHEN attestation_hash IS NOT NULL THEN 1 ELSE 0 END) AS attested
         FROM records WHERE owner IN (${placeholders}) AND status = 'listed' GROUP BY owner`,
      )
      .bind(...chunk)
      .all<{ owner: string; n: number; attested: number }>();
    for (const r of results) counts.set(r.owner, { count: r.n, attested: r.attested ?? 0 });
  }
  // Warning rate: pack owners into loads of ~200 records each.
  const loads: string[][] = [];
  let cur: string[] = [];
  let curRecords = 0;
  for (const owner of owners) {
    const n = counts.get(owner)?.count ?? 0;
    if (cur.length && curRecords + n > STATS_OWNER_LOAD_RECORDS) {
      loads.push(cur);
      cur = [];
      curRecords = 0;
    }
    cur.push(owner);
    curRecords += n;
  }
  if (cur.length) loads.push(cur);
  const warnings = new Map<string, number>();
  for (const load of loads) {
    const placeholders = load.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT owner, record_json FROM records WHERE owner IN (${placeholders}) AND status = 'listed'`)
      .bind(...load)
      .all<{ owner: string; record_json: string }>();
    for (const row of results) {
      const r = JSON.parse(row.record_json) as SkillRecord;
      warnings.set(row.owner, (warnings.get(row.owner) ?? 0) + r.validation.issues.filter((x) => x.severity === "warning").length);
    }
  }
  for (const owner of owners) {
    const c = counts.get(owner) ?? { count: 0, attested: 0 };
    out.set(owner, { count: c.count, attested: c.attested, warnings: warnings.get(owner) ?? 0 });
  }
  return out;
}

const STATS_UPSERT_COLS = "skill_id, calls_30d, calls_7d, calls_prev_7d, installs_total, installs_30d, owner_records, owner_attested_share, owner_warning_rate, behavior_score, refreshed_at";
const STATS_UPSERT_SET = "calls_30d = excluded.calls_30d, calls_7d = excluded.calls_7d, calls_prev_7d = excluded.calls_prev_7d, installs_total = excluded.installs_total, installs_30d = excluded.installs_30d, owner_records = excluded.owner_records, owner_attested_share = excluded.owner_attested_share, owner_warning_rate = excluded.owner_warning_rate, behavior_score = excluded.behavior_score, refreshed_at = excluded.refreshed_at";
// NOTE: external_installs / external_source are deliberately NOT in
// the column list — setExternalInstalls owns those columns and this
// upsert must never clobber them (and vice versa: setExternalInstalls
// only touches its own columns).

/**
 * Maintain record_stats for exactly the given records. Every query
 * is scoped to the records' ids/owners (see the caps above); a
 * 100-record single-owner batch costs ~17 statements, a 100-record
 * 100-owner batch ~22 — both far under the 1,000
 * queries/invocation cap, with no single response anywhere near
 * the 50 MB result limit. Records whose status is not 'listed'
 * are skipped (the old full refresh only ever wrote rows for
 * listed records).
 */
export async function upsertStatsForRecords(db: D1Like, records: SkillRecord[], now: Date): Promise<number> {
  const byId = new Map<string, SkillRecord>();
  for (const r of records) if (r.status === "listed") byId.set(r.id, r);
  const listed = [...byId.values()];
  if (!listed.length) return 0;
  const ids = listed.map((r) => r.id);
  const owners = [...new Set(listed.map((r) => r.owner))];
  const counts = await statsCountsForIds(db, ids, now);
  const aggs = await ownerAggregates(db, owners);
  const at = now.toISOString();
  const values: unknown[] = [];
  const rows: string[] = [];
  let n = 0;
  const flush = async () => {
    if (!rows.length) return;
    await db
      .prepare(`INSERT INTO record_stats (${STATS_UPSERT_COLS}) VALUES ${rows.join(", ")} ON CONFLICT(skill_id) DO UPDATE SET ${STATS_UPSERT_SET}`)
      .bind(...values)
      .run();
    rows.length = 0;
    values.length = 0;
  };
  for (const r of listed) {
    const c = counts.get(r.id) ?? { calls30d: 0, calls7d: 0, callsPrev7d: 0, installsTotal: 0, installs30d: 0 };
    const o = aggs.get(r.owner) ?? { count: 0, attested: 0, warnings: 0 };
    const behavior: RecordBehavior = {
      calls30d: c.calls30d, calls7d: c.calls7d, callsPrev7d: c.callsPrev7d,
      installsTotal: c.installsTotal, installs30d: c.installs30d,
      ownerAttestedShare: o.count ? o.attested / o.count : 0,
      ownerWarningRate: o.count ? o.warnings / o.count : 0,
    };
    rows.push(`(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    values.push(r.id, c.calls30d, c.calls7d, c.callsPrev7d, c.installsTotal, c.installs30d,
      o.count, behavior.ownerAttestedShare, behavior.ownerWarningRate, behaviorScore(behavior), at);
    n++;
    if (rows.length === STATS_UPSERT_ROWS) await flush();
  }
  await flush();
  return n;
}

/** One page of the stats rebuild job: the next `limit` listed
 *  records in id order, stats recomputed exactly via
 *  upsertStatsForRecords. Cursor is the last id of the previous
 *  page (null = first page). A page costs ~90 statements at limit
 *  500 — far under the per-invocation cap. */
export async function rebuildStatsPage(db: D1Like, limit: number, cursor: string | null, now: Date): Promise<{ processed: number; nextCursor: string | null; done: boolean }> {
  const page = Math.max(1, Math.min(Math.floor(limit) || 500, 500));
  const { results } = cursor
    ? await db.prepare("SELECT id, record_json FROM records WHERE status = 'listed' AND id > ? ORDER BY id LIMIT ?").bind(cursor, page).all<{ id: string; record_json: string }>()
    : await db.prepare("SELECT id, record_json FROM records WHERE status = 'listed' ORDER BY id LIMIT ?").bind(page).all<{ id: string; record_json: string }>();
  const records = results.map((r) => JSON.parse(r.record_json) as SkillRecord);
  const processed = await upsertStatsForRecords(db, records, now);
  const last = results[results.length - 1];
  const done = results.length < page;
  return { processed, nextCursor: done ? null : (last?.id ?? null), done };
}

/** Read behavior scores for a set of ids (missing id = no row). */
export async function behaviorScores(db: D1Like, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT skill_id, behavior_score FROM record_stats WHERE skill_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ skill_id: string; behavior_score: number }>();
  for (const r of results) out.set(r.skill_id, r.behavior_score);
  return out;
}

/** Trending inputs: per-record call windows straight from gateway_calls.
 *  NOTE (gate-d1size, 2026-11-11): the SQL aliases are snake_case
 *  (calls_7d, …) while TrendingRow/computeTrending read camelCase
 *  (calls7d, …) — the rows used to be returned unmapped, so
 *  computeTrending saw `undefined` for every count and trending was
 *  ALWAYS static-fallback in production. The mapping below restores
 *  the velocity path as designed; the record_stats refresh path
 *  already maps the same columns (see upsertStatsForRecords). */
export async function trendingRows(db: D1Like, now: Date): Promise<TrendingRow[]> {
  const day = 86_400_000;
  const cut7 = new Date(now.getTime() - 7 * day).toISOString();
  const cut14 = new Date(now.getTime() - 14 * day).toISOString();
  const cut30 = new Date(now.getTime() - 30 * day).toISOString();
  const { results } = await db
    .prepare(
      `SELECT skill_id AS id,
         SUM(CASE WHEN called_at >= ? THEN 1 ELSE 0 END) AS calls_7d,
         SUM(CASE WHEN called_at >= ? AND called_at < ? THEN 1 ELSE 0 END) AS calls_prev_7d,
         COUNT(*) AS calls_30d
       FROM gateway_calls
       WHERE skill_id IS NOT NULL AND called_at >= ?
       GROUP BY skill_id`,
    )
    .bind(cut7, cut14, cut7, cut30)
    .all<{ id: string; calls_7d: number; calls_prev_7d: number; calls_30d: number }>();
  return results.map((r) => ({
    id: r.id,
    calls7d: r.calls_7d,
    callsPrev7d: r.calls_prev_7d,
    calls30d: r.calls_30d,
  }));
}

