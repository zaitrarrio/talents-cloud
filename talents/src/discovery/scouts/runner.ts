// Scout runner (Phase 2): the funnel entrance every channel shares.
//
//   nominations → store.nominate() (dedup + corroboration merge)
//               → verification (git-tree for repos; the registry /
//                 packument refetch inside ingest for MCP/npm)
//               → ingestSource() (inline, CLI) or enqueue (Worker)
//
// Priority orders the verification queue — corroboration count,
// channel weight, log-scaled signals. Priority is NEVER trust:
// a high-priority candidate still has to pass the same verification
// as any other, and a watchlist nomination (lead / x-post) can
// never be verified or ingested at all.

import { defaultFetch } from "../../ingest.js";
import type { SkillRecord } from "../../types.js";
import type { DiscoveryDeps } from "../pipeline.js";
import { ingestSource } from "../pipeline.js";
import { classifyAsList, isNoSkillFilesReason, type ListMineStats } from "../lists.js";
import { verifyRepo, type SourceKind } from "../sweep.js";
import type { SourceRow } from "../store.js";
import { CHANNEL_WEIGHT, type ScoutName, type ScoutResult } from "./types.js";

const REPO_KINDS: SourceKind[] = ["marketplace", "plugin-repo", "skill-repo"];
const WATCHLIST_KINDS: SourceKind[] = ["lead", "x-post"];

export interface ScoutRunnerOptions {
  /** Inline-ingest cap for this run (ignored in enqueue mode). */
  maxIngest?: number;
  /** Verification cap for this run (repo kinds only). */
  maxVerify?: number;
  /** Worker mode: hand verified sources to the queue instead of
   *  ingesting inline. */
  enqueue?: (source: SourceRow) => Promise<void>;
}

export interface ScoutRunnerStats {
  nominated: number;
  created: number;
  corroborated: number;
  watchlisted: number;
  verified: number;
  rejected: { locator: string; reason: string }[];
  /** List claims resolved this run (converted + mined), and repos
   *  the no-skill-files rejection would have claimed that the list
   *  heuristic rescued instead. */
  listsClassified: { locator: string; mine?: ListMineStats }[];
  enqueued: number;
  ingestedSources: { locator: string; kind: SourceKind; newRecords: number; existingUpdated: number; existingSkipped: number; deadLetter: number }[];
  newRecords: number;
  sampleNewRecordIds: string[];
  /** skills.sh cross-check: existing records that gained an
   *  external-installs figure this run. */
  externalInstallsAttached: number;
}

function signalBump(signalScore: number | undefined): number {
  if (!signalScore || signalScore <= 0) return 0;
  return Math.min(3, Math.log10(1 + signalScore));
}

export async function runScoutNominations(
  deps: DiscoveryDeps,
  scoutName: ScoutName,
  result: ScoutResult,
  opts: ScoutRunnerOptions = {},
): Promise<ScoutRunnerStats> {
  const startedAt = (deps.now ? deps.now() : new Date()).toISOString();
  const stats: ScoutRunnerStats = {
    nominated: result.nominations.length,
    created: 0, corroborated: 0, watchlisted: 0,
    verified: 0, rejected: [], listsClassified: [], enqueued: 0,
    ingestedSources: [], newRecords: 0, sampleNewRecordIds: [],
    externalInstallsAttached: 0,
  };

  // 1) Nominate everything. Dedup + corroboration live in the store.
  const rows = new Map<string, SourceRow>();
  for (const n of result.nominations) {
    const watchlist = WATCHLIST_KINDS.includes(n.kind);
    const res = await deps.store.nominate({
      kind: n.kind,
      locator: n.locator,
      url: n.url ?? null,
      discoveredVia: n.provenance.via,
      provenance: n.provenance,
      priorityDelta: CHANNEL_WEIGHT[scoutName] + signalBump(n.signalScore),
      watchlist,
      reason: n.provenance.note,
    }, startedAt);
    if (res.created) stats.created++;
    if (res.corroborated) stats.corroborated++;
    if (watchlist) { stats.watchlisted++; continue; }
    rows.set(res.row.locator, res.row);

    // skills.sh cross-check: listings whose repo is ALREADY in the
    // catalog attach their install count as external traction on the
    // existing records (external_* columns only — our own gateway /
    // install counters are never overwritten by a channel).
    if (scoutName === "skills.sh") {
      const installs = n.provenance.signals?.installs;
      if (typeof installs === "number") {
        const ids = await deps.store.recordIdsBySourceRepo(n.locator);
        for (const id of ids) {
          await deps.store.setExternalInstalls(id, installs, "skills.sh");
          stats.externalInstallsAttached++;
        }
      }
    }
  }

  // 2) Verification queue, highest priority first. Terminal rows
  //    (ingested / rejected / stale) were corroboration-only.
  const queue = [...rows.values()]
    .filter((r) => r.status === "candidate" || r.status === "verified")
    .sort((a, b) => b.priority - a.priority);
  const maxVerify = opts.maxVerify ?? 25;
  const maxIngest = opts.maxIngest ?? 5;
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const pacer = deps.pacer;
  if (!pacer) throw new Error("runScoutNominations needs deps.pacer for repo verification");

  const ready: SourceRow[] = [];
  let verifiedCount = 0;
  for (const row of queue) {
    if (row.status === "verified") { ready.push(row); continue; }
    // List claims resolve HERE, never at ingest: classify (the
    // tree check inside discards the claim when the repo carries
    // skill files — records win — and returns the verified kind to
    // continue with), mine when the link bar passes, or reject
    // when it does neither.
    if (row.kind === "list") {
      try {
        const outcome = await classifyAsList(
          { store: deps.store, fetchFn, pacer, now: deps.now },
          row,
        );
        if (outcome.isList) {
          stats.listsClassified.push({ locator: row.locator, mine: outcome.mine });
          continue;
        }
        if (outcome.graduatedKind) {
          stats.verified++;
          const verifiedRow: SourceRow = {
            ...row, kind: outcome.graduatedKind, status: "verified",
            reason: `list claim discarded: ${outcome.reason}`,
          };
          await deps.store.upsertSource(verifiedRow);
          ready.push(verifiedRow);
          continue;
        }
        stats.rejected.push({ locator: row.locator, reason: outcome.reason });
        await deps.store.upsertSource({ ...row, status: "rejected", reason: outcome.reason, lastSeen: startedAt });
        continue;
      } catch (e) {
        stats.rejected.push({ locator: row.locator, reason: `list classification failed: ${(e as Error).message}` });
        continue;
      }
    }
    if (!REPO_KINDS.includes(row.kind)) { ready.push(row); continue; } // MCP/npm verify at ingest (refetch)
    if (verifiedCount >= maxVerify) continue;
    verifiedCount++;
    const v = await verifyRepo(fetchFn, pacer, {
      locator: row.locator,
      url: row.url ?? `https://github.com/${row.locator}`,
      description: "",
      discoveredVia: row.discoveredVia,
      archived: false,
    });
    if (!v.ok || !v.kind) {
      // List heuristic: no skill files + link-dense markdown = a
      // curated list to mine, not a rejection.
      if (isNoSkillFilesReason(v.reason)) {
        try {
          const outcome = await classifyAsList(
            { store: deps.store, fetchFn, pacer, now: deps.now },
            row,
          );
          if (outcome.isList) {
            stats.listsClassified.push({ locator: row.locator, mine: outcome.mine });
            continue;
          }
        } catch { /* best-effort; rejection stands */ }
      }
      stats.rejected.push({ locator: row.locator, reason: v.reason });
      await deps.store.upsertSource({ ...row, status: "rejected", reason: v.reason, lastSeen: startedAt });
      continue;
    }
    stats.verified++;
    const verifiedRow: SourceRow = { ...row, kind: v.kind, status: "verified", reason: v.reason };
    await deps.store.upsertSource(verifiedRow);
    ready.push(verifiedRow);
  }

  // 3) Ingest inline (CLI) or enqueue (Worker cron).
  const sampleIds: string[] = [];
  const innerOnNew = deps.onNewRecords;
  const ingestDeps: DiscoveryDeps = {
    ...deps,
    onNewRecords: async (records: SkillRecord[]) => {
      for (const r of records) if (sampleIds.length < 10) sampleIds.push(r.id);
      if (innerOnNew) await innerOnNew(records);
    },
  };
  if (opts.enqueue) {
    for (const row of ready) {
      await opts.enqueue(row);
      stats.enqueued++;
    }
  } else {
    for (const row of ready.slice(0, maxIngest)) {
      try {
        const res = await ingestSource(ingestDeps, row);
        stats.ingestedSources.push({
          locator: row.locator, kind: row.kind,
          newRecords: res.newRecords, existingUpdated: res.existingUpdated, existingSkipped: res.existingSkipped, deadLetter: res.deadLetter,
        });
        stats.newRecords += res.newRecords;
      } catch (e) {
        stats.rejected.push({ locator: row.locator, reason: `ingest failed: ${(e as Error).message}` });
      }
    }
  }
  stats.sampleNewRecordIds = sampleIds;

  // No funnel-end stats refresh: ingestSource maintains record_stats
  // incrementally for every record it writes (P0-1); the paged
  // rebuild job heals drift.
  await deps.store.recordScoutRun(scoutName, startedAt, (deps.now ? deps.now() : new Date()).toISOString(), {
    scout: { ...result.stats },
    funnel: {
      nominated: stats.nominated, created: stats.created, corroborated: stats.corroborated,
      watchlisted: stats.watchlisted, verified: stats.verified, rejected: stats.rejected.length,
      listsClassified: stats.listsClassified.length,
      enqueued: stats.enqueued, ingestedSources: stats.ingestedSources.length,
      newRecords: stats.newRecords, externalInstallsAttached: stats.externalInstallsAttached,
    },
  });
  return stats;
}
