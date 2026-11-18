// Discovery pipeline (P5): sweep → verify → (enqueue | ingest) →
// stats. One orchestration used by every transport:
//   - CLI `talents discover` — the same code path, minus the Queue:
//     verified sources are ingested inline.
//   - Worker cron — sweeps and ENQUEUES verified sources; the queue
//     consumer calls ingestSource() per message.
//   - Worker webhook — a push to a known repo enqueues a re-ingest;
//     ingestSource() with an existing source refreshes its records.
//
// Dedup rules (documented, enforced here):
//   - Same (kind, locator) already in sources → the row is touched
//     (last_seen), never duplicated.
//   - A source already ingested whose records are all present is
//     skipped at ingest (record ids already in the catalog win).
//   - Records are keyed by owner/name id; an id already in the
//     catalog is never overwritten by a discovery ingest — the
//     original source keeps provenance.
// Dead-letter discipline is inherited from the engine: one bad entry
// inside a source never fails the source or the cycle.

import type { DeadLetter, FetchFn, IngestSummary, SkillRecord } from "../types.js";
import type { RegistryKey } from "../attest.js";
import { defaultFetch, ingestGithubRepo } from "../ingest.js";
import { scanGithubRepoSkills } from "../repo-scan.js";
import { buildMcpRecord, fetchMcpServer, mapMcpIdentity, mcpQualityBar } from "./scouts/mcp-record.js";
import { buildNpmPointerRecord, fetchNpmPackage } from "./scouts/npm-record.js";
import {
  Pacer, runSweep, verifyRepo,
  type SourceKind, type SweepCandidate, type SweepStats,
} from "./sweep.js";
import { classifyAsList, isNoSkillFilesReason, type ListMineStats } from "./lists.js";
import type { DiscoveryStore, SourceRow } from "./store.js";

export interface DiscoveryDeps {
  store: DiscoveryStore;
  registryKey: RegistryKey;
  fetchFn?: FetchFn;
  pacer?: Pacer;
  /** When set, verified sources are handed to the queue instead of
   *  being ingested inline (Worker cron path). */
  enqueue?: (source: SourceRow) => Promise<void>;
  /** Called with every batch of genuinely-new records an ingest
   *  produced (the CLI mirrors them into the registry file so
   *  re-seeds stay lossless; the Worker passes an embedding hook). */
  onNewRecords?: (records: SkillRecord[]) => Promise<void>;
  now?: () => Date;
}

export interface CycleStats {
  sweep: SweepStats;
  candidatesSeen: number;
  alreadyKnown: number;
  verified: number;
  rejected: { locator: string; reason: string }[];
  enqueued: number;
  /** Repos the no-skill-files rejection would have claimed that the
   *  list heuristic rescued and mined instead. */
  listsClassified: { locator: string; mine?: ListMineStats }[];
  ingestedSources: { locator: string; kind: SourceKind; newRecords: number; existingUpdated: number; existingSkipped: number; deadLetter: number }[];
  newRecords: number;
  sourcesByStatus: Record<string, number>;
}

export interface CycleOptions {
  sweepCap?: number;
  perQuery?: number;
  /** Max sources to ingest inline this cycle (ignored when enqueuing). */
  maxIngest?: number;
  queries?: { q: string; via: string }[];
}

const nowIso = (deps: DiscoveryDeps) => (deps.now ? deps.now() : new Date()).toISOString();

function deadSummary(source: SourceRow, entryName: string, reason: string): IngestSummary {
  const at = new Date().toISOString();
  const dl: DeadLetter = {
    marketplace: source.locator,
    entryName,
    reason,
    issues: [{ severity: "error", code: "scout-ingest", message: reason }],
    notice: { to: null, subject: `Talents ingest failed: ${entryName}`, body: reason },
    at,
  };
  return {
    target: source.locator, marketplaceName: null, fetchedAt: at,
    total: 1, ok: 0, deadLetter: 1, records: [], deadLetters: [dl], note: reason,
  };
}

function okSummary(source: SourceRow, marketplaceName: string, record: SkillRecord): IngestSummary {
  return {
    target: source.locator, marketplaceName, fetchedAt: new Date().toISOString(),
    total: 1, ok: 1, deadLetter: 0, records: [record], deadLetters: [],
  };
}

/** MCP locators come in two families that share the "mcp-server"
 *  kind: official-registry names are reverse-DNS (the segment before
 *  "/" always contains a dot — io.github.x/y, com.airtable/y), while
 *  npm package names are "@scope/name" or a bare name with no "/". */
export function isRegistryName(locator: string): boolean {
  if (locator.startsWith("@")) return false;
  const slash = locator.indexOf("/");
  if (slash < 0) return false;
  return locator.slice(0, slash).includes(".");
}

/** Registry path: refetch the latest server.json at ingest time
 *  (the registry is the source of truth — no payload is cached in
 *  the sources row), re-apply the quality bar, build the record. */
async function ingestMcpRegistrySource(deps: DiscoveryDeps, source: SourceRow): Promise<IngestSummary> {
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const server = await fetchMcpServer(fetchFn, source.locator);
  if (!server) return deadSummary(source, source.locator, "server not found in the MCP registry (removed or renamed)");
  const bar = mcpQualityBar(server);
  if (!bar.ok) return deadSummary(source, server.name ?? source.locator, `below the MCP quality bar at ingest: ${bar.reason}`);
  const base = mapMcpIdentity(server.name ?? source.locator);
  const existing = await deps.store.getRecord(`${base.owner}/${base.name}`);
  // Namespace collision: the mapped id is already held by a record
  // that did NOT come from the MCP registry (e.g. the publisher's
  // own GitHub-sourced listing). Only then does the MCP record move
  // to the "-mcp" suffixed namespace — and the record says so.
  const collides = Boolean(existing && existing.sourceMarketplace !== "mcp-registry");
  const record = buildMcpRecord(server, deps.registryKey, { collides });
  return okSummary(source, "mcp-registry", record);
}

/** npm pointer path: refetch the packument at ingest time and build
 *  the pointer record from live registry metadata. */
async function ingestNpmPointerSource(deps: DiscoveryDeps, source: SourceRow): Promise<IngestSummary> {
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const meta = await fetchNpmPackage(fetchFn, source.locator);
  if (!meta) return deadSummary(source, source.locator, "package not found on npm (unpublished or renamed)");
  const kind = source.kind === "mcp-server" ? "mcp" : source.kind === "skill-package" ? "skill" : undefined;
  const record = buildNpmPointerRecord(meta, deps.registryKey, { kind });
  return okSummary(source, "npm", record);
}

/** Engine entry per source kind. Marketplace repos go through the
 *  marketplace adapter; skill-repos through the standalone scan;
 *  plugin-repos through the scan too (their SKILL.md skills are the
 *  listable units — a plugin.json-only repo honestly yields 0 and is
 *  marked as such, never faked). Phase 2 kinds route by locator
 *  family: registry names to the MCP record builder, npm packages
 *  to the pointer builder. */
export async function ingestSourceRecords(
  deps: DiscoveryDeps,
  source: SourceRow,
): Promise<IngestSummary> {
  const opts = { registryKey: deps.registryKey, fetchFn: deps.fetchFn };
  if (source.kind === "marketplace") return ingestGithubRepo(source.locator, opts);
  if (source.kind === "mcp-server") {
    return isRegistryName(source.locator)
      ? ingestMcpRegistrySource(deps, source)
      : ingestNpmPointerSource(deps, source);
  }
  if (source.kind === "npm-package" || source.kind === "skill-package") {
    return ingestNpmPointerSource(deps, source);
  }
  return scanGithubRepoSkills(source.locator, opts);
}

/**
 * Ingest one source into the store now. Returns counts. Used by the
 * CLI (inline path), the queue consumer, and webhook re-ingests.
 */
export async function ingestSource(
  deps: DiscoveryDeps,
  source: SourceRow,
): Promise<{ newRecords: number; existingUpdated: number; existingSkipped: number; deadLetter: number; records: SkillRecord[] }> {
  // HARD RULE: a list source is an entry point, never a listing.
  // It is mined for candidates (lists.ts) and must never reach the
  // record builders — fail loudly rather than ingest a list.
  if (source.kind === "list") {
    throw new Error(`list source ${source.locator} must never be ingested — mine it instead`);
  }
  const summary = await ingestSourceRecords(deps, source);
  const existing = await deps.store.existingRecordIds();
  const fresh: SkillRecord[] = [];
  const updated: SkillRecord[] = [];
  let skipped = 0;
  for (const r of summary.records) {
    if (!existing.has(r.id)) {
      await deps.store.upsertRecord(r);
      fresh.push(r);
      continue;
    }
    // Already listed: a re-ingest refreshes the stored record when the
    // rebuilt record actually differs — its attestation content hash
    // covers the source files, and the description is compared as well
    // (an extraction fix changes it without any source change; that is
    // how the "---" description records were repaired in 2026-11-11).
    // The rebuilt record carries a fresh attestation from the builder,
    // and upsertRecord is the same store write used for new records.
    // Identical rebuilds stay untouched, so sweep re-ingests of an
    // unchanged source remain cheap no-ops.
    const stored = await deps.store.getRecord(r.id);
    const changed = !stored
      || stored.attestation?.contentHash !== r.attestation?.contentHash
      || stored.description !== r.description;
    if (!changed) { skipped++; continue; }
    await deps.store.upsertRecord(r);
    updated.push(r);
  }
  const at = nowIso(deps);
  await deps.store.upsertSource({
    ...source,
    status: "ingested",
    reason: summary.deadLetter
      ? `ingested with ${summary.deadLetter} dead-letter(s)`
      : summary.note ?? source.reason,
    lastSeen: at,
    lastIngested: at,
    recordCount: source.recordCount + fresh.length,
  });
  const changedRecords = [...fresh, ...updated];
  if (changedRecords.length && deps.onNewRecords) await deps.onNewRecords(changedRecords);
  // Incremental stats (P0-1): maintain record_stats for exactly the
  // records whose stored bytes changed. Best-effort by design — a
  // stats failure must never fail an otherwise-successful ingest
  // (that is what dead-lettered every verified queue message: the
  // old full-catalog refresh threw after ingest). The paged rebuild
  // job heals any gap, and record_stats coverage is the detector.
  if (changedRecords.length) {
    try {
      await deps.store.upsertStatsForRecords(changedRecords, new Date(at));
    } catch (e) {
      console.warn(`ingest stats update failed for ${source.locator}: ${(e as Error).message}`);
    }
  }
  return { newRecords: fresh.length, existingUpdated: updated.length, existingSkipped: skipped, deadLetter: summary.deadLetter, records: changedRecords };
}

/** Run one full discovery cycle. */
export async function runDiscoveryCycle(
  deps: DiscoveryDeps,
  opts: CycleOptions = {},
): Promise<CycleStats> {
  const pacer = deps.pacer ?? new Pacer();
  const { candidates, stats: sweepStats } = await runSweep({
    fetchFn: deps.fetchFn,
    pacer,
    cap: opts.sweepCap ?? 24,
    perQuery: opts.perQuery ?? 8,
    queries: opts.queries,
  });

  const stats: CycleStats = {
    sweep: sweepStats,
    candidatesSeen: candidates.length,
    alreadyKnown: 0,
    verified: 0,
    rejected: [],
    enqueued: 0,
    listsClassified: [],
    ingestedSources: [],
    newRecords: 0,
    sourcesByStatus: {},
  };

  const toIngest: SourceRow[] = [];
  for (const cand of candidates as SweepCandidate[]) {
    // Kind is unknown until verification; look up by locator across
    // kinds via a candidate-kind probe: sources are keyed by
    // (kind, locator), and a repo's kind is stable once verified, so
    // check the three kinds in order.
    let known: SourceRow | null = null;
    for (const kind of ["marketplace", "skill-repo", "plugin-repo"] as SourceKind[]) {
      known = await deps.store.getSource(kind, cand.locator);
      if (known) break;
    }
    const at = nowIso(deps);
    if (known) {
      stats.alreadyKnown++;
      await deps.store.upsertSource({ ...known, lastSeen: at });
      // An ingested source is fresh enough; a verified-but-never-
      // ingested one joins this cycle's ingest list.
      if (known.status === "verified") toIngest.push(known);
      continue;
    }
    const v = await verifyRepo(deps.fetchFn ?? defaultFetch, pacer, cand);
    if (!v.ok || !v.kind) {
      // List heuristic: a repo with NO skill files whose markdown
      // links out to ≥10 other repos is a curated list — an entry
      // point to mine, not a rejection. classifyAsList re-checks
      // the tree itself (records win) before converting the row.
      if (isNoSkillFilesReason(v.reason)) {
        try {
          const probe: SourceRow = {
            kind: "skill-repo",
            locator: cand.locator,
            url: cand.url,
            discoveredVia: cand.discoveredVia,
            status: "rejected",
            reason: v.reason,
            firstSeen: at,
            lastSeen: at,
            lastIngested: null,
            recordCount: 0,
            provenance: [{ via: cand.discoveredVia, at }],
            priority: 0,
          };
          const outcome = await classifyAsList(
            { store: deps.store, fetchFn: deps.fetchFn, pacer, now: deps.now },
            probe,
          );
          if (outcome.isList) {
            stats.listsClassified.push({ locator: cand.locator, mine: outcome.mine });
            continue;
          }
        } catch { /* classification is best-effort; rejection stands */ }
      }
      stats.rejected.push({ locator: cand.locator, reason: v.reason });
      await deps.store.upsertSource({
        kind: "skill-repo", // kind unknown for rejects; locator carries identity
        locator: cand.locator,
        url: cand.url,
        discoveredVia: cand.discoveredVia,
        status: "rejected",
        reason: v.reason,
        firstSeen: at,
        lastSeen: at,
        lastIngested: null,
        recordCount: 0,
        provenance: [{ via: cand.discoveredVia, at }],
        priority: 0,
      });
      continue;
    }
    stats.verified++;
    const row: SourceRow = {
      kind: v.kind,
      locator: cand.locator,
      url: cand.url,
      discoveredVia: cand.discoveredVia,
      status: "verified",
      reason: v.reason,
      firstSeen: at,
      lastSeen: at,
      lastIngested: null,
      recordCount: 0,
      provenance: [{ via: cand.discoveredVia, at }],
      priority: 0,
    };
    await deps.store.upsertSource(row);
    toIngest.push(row);
  }

  if (deps.enqueue) {
    for (const source of toIngest) {
      await deps.enqueue(source);
      stats.enqueued++;
    }
  } else {
    const maxIngest = opts.maxIngest ?? 5;
    for (const source of toIngest.slice(0, maxIngest)) {
      try {
        const res = await ingestSource(deps, source);
        stats.ingestedSources.push({
          locator: source.locator, kind: source.kind,
          newRecords: res.newRecords, existingUpdated: res.existingUpdated, existingSkipped: res.existingSkipped, deadLetter: res.deadLetter,
        });
        stats.newRecords += res.newRecords;
      } catch (e) {
        stats.rejected.push({ locator: source.locator, reason: `ingest failed: ${(e as Error).message}` });
      }
    }
  }

  // No cycle-end stats refresh: ingestSource maintains record_stats
  // incrementally for every record it writes (P0-1), and the paged
  // rebuild job heals drift. The old full-catalog refresh could not
  // complete at current scale (50 MB result + 22k statements).
  stats.sourcesByStatus = await deps.store.countSourcesByStatus();
  return stats;
}
