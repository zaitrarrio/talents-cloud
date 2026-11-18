// Enrichment pipeline (ENRICHMENT.md "Pipeline mechanics"): the
// stage order is discover → verify → ingest → attest → ENRICH →
// embed → rank. Enrichment is keyed by (skill_id, source hash):
// an unchanged hash means no rework, EXCEPT Layer A repo stats and
// Layer C introspection, which refresh on a weekly cadence (they
// describe the living origin, not the pinned source). Enrichment
// failures degrade a record's completeness — they never unlist it
// and never throw out of enrichRecord.
//
// Execution sites (deliberate, documented in README): the operator
// script (scripts/enrich-run.mjs) is the primary driver — its fetch
// goes through the ghapi helper (authenticated GitHub) and its R2
// writes through the REST API. The Worker route POST /admin/enrich
// drives the identical code with the Worker's own fetch + R2
// binding; unauthenticated GitHub API limits make it the secondary
// path for Layer A's GitHub facts.
//
// Tranche 2 (layers D–E): Layer D (generated editorial) runs ONLY
// where a `generateD` dep is injected — i.e. inside the Worker,
// which holds the ANTHROPIC_API_KEY; the operator CLI never
// generates. Layer E (trust scan + drift) runs anywhere the fetch
// machinery reaches the pinned sources.

import type { FetchFn, SkillRecord } from "../types.js";
import type { D1Like } from "../search-d1.js";
import { contentHash } from "../attest.js";
import type { AssetStore, EnrichLayer, EnrichmentRow, LayerState } from "./types.js";
import {
  appendSearchExtras, decodeTrafficCursor, encodeTrafficCursor, generatedExtrasOf, searchExtrasOf,
  trafficPage, type EnrichmentStore, type TrafficCursor,
} from "./store.js";
import { defaultFetchBytes, runLayerA, type FetchBytes } from "./layer-a.js";
import { runLayerB } from "./layer-b.js";
import { probeMcpServer, remoteEndpointOf, type McpFetch } from "./layer-c.js";
import { runLayerD, type GenerateFn } from "./layer-d.js";
import { runLayerE } from "./layer-e.js";

/** Layer A refresh cadence: repo stats drift even when the pinned
 *  source does not. One week. */
export const A_REFRESH_MS = 7 * 24 * 3600 * 1000;
/** Layer C refresh cadence: introspection is a point-in-time probe
 *  of a living server. One week (ENRICHMENT.md §C "slow cadence"). */
export const C_REFRESH_MS = 7 * 24 * 3600 * 1000;

export interface EnrichDeps {
  store: EnrichmentStore;
  /** D1 handle for the search-extras append (records + FTS). */
  db: D1Like;
  fetchFn: FetchFn;
  fetchBytes?: FetchBytes;
  assets: AssetStore;
  probeFetch?: McpFetch;
  /** Layer D generator — injected ONLY by the Worker (it holds the
   *  Anthropic key). Without it, a requested D layer is skipped. */
  generateD?: GenerateFn;
  /** Layer D's README reader: the record's stored README text (R2),
   *  by skill id. Defaults to null (the a_json excerpt still feeds
   *  the prompt's material assessment via the row). */
  readReadme?: (skillId: string) => Promise<string | null>;
  /** Record loader for enrichIds (explicit-id runs). */
  loadRecord?: (id: string) => Promise<SkillRecord | undefined>;
}

/** The hash enrichment was computed against: the attestation
 *  content hash when the record is attested; for unattested pointer
 *  records, a documented fallback over identity + ref + hashed
 *  files (any re-ingest that changes those re-keys enrichment). */
export function sourceHashOf(record: SkillRecord): string {
  if (record.attestation?.contentHash) return record.attestation.contentHash;
  return contentHash([{
    path: "record-identity",
    content: `${record.id}@${record.ref}:${record.filesHashed.join(",")}`,
  }]);
}

const ageMs = (iso: string | null, now: Date): number =>
  iso ? now.getTime() - new Date(iso).getTime() : Number.POSITIVE_INFINITY;

/** Should this layer run for this record right now? */
export function layerDue(
  layer: EnrichLayer,
  row: EnrichmentRow | null,
  at: string | null,
  state: LayerState | undefined,
  now: Date,
): boolean {
  if (!row || !state || state === "pending" || state === "stale") return true;
  if (state === "none") {
    // A `none` verdict is sticky until the hash changes (→ stale) —
    // EXCEPT layers D/E, where `none` with NO payload is the schema
    // default (never attempted), not a verdict. An evaluated none
    // always carries a payload (D's withholding reason / E's scan
    // note), so payload-presence is the discriminator.
    if (layer === "d") return row.d === null;
    if (layer === "e") return row.e === null;
    return false;
  }
  // done | partial: refresh on cadence for the living-origin layers.
  if (layer === "a") return ageMs(at, now) > A_REFRESH_MS;
  if (layer === "c") return ageMs(at, now) > C_REFRESH_MS;
  // D: a failed generation (partial) is retried on the next pass;
  // a done generation is hash-keyed only (cost discipline).
  if (layer === "d") return state === "partial";
  // E: a partial scan (some fetches failed) is retried on the next
  // pass; a done scan is hash-keyed only.
  if (layer === "e") return state === "partial";
  return false; // B is a pure function of the pinned source: hash-keyed only
}

export interface EnrichOutcome {
  skillId: string;
  /** Layers that ran, with their resulting state. */
  ran: Partial<Record<EnrichLayer, LayerState>>;
  /** Layers skipped as fresh/not-due. */
  skipped: EnrichLayer[];
  /** True when B, C or D ran (search extras were re-appended). */
  searchUpdated: boolean;
}

/**
 * Enrich one record. Idempotent: with an unchanged source hash and
 * fresh layers this is a no-op besides reads. `existing` lets paged
 * callers pass the row they already loaded (trafficPage joins it).
 */
export async function enrichRecord(
  record: SkillRecord,
  deps: EnrichDeps,
  opts: { layers?: EnrichLayer[]; now?: Date; existing?: EnrichmentRow | null } = {},
): Promise<EnrichOutcome> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const hash = sourceHashOf(record);
  const store = deps.store;

  let row = opts.existing !== undefined ? opts.existing : await store.get(record.id);
  if (row && row.sourceHash !== hash) {
    await store.reconcileHash(record.id, hash, at);
    row = await store.get(record.id);
  }

  const want = opts.layers ?? ["a", "b", "c"];
  const ran: EnrichOutcome["ran"] = {};
  const skipped: EnrichLayer[] = [];
  let searchTouched = false;

  const stateOf = (l: EnrichLayer): LayerState | undefined =>
    l === "a" ? row?.aState
    : l === "b" ? row?.bState
    : l === "c" ? row?.cState
    : l === "d" ? row?.dState
    : row?.eState;
  const atOf = (l: EnrichLayer): string | null =>
    l === "a" ? row?.aAt ?? null
    : l === "b" ? row?.bAt ?? null
    : l === "c" ? row?.cAt ?? null
    : l === "d" ? (row?.d?.generatedAt ?? null)
    : (row?.e?.scannedAt ?? null);

  for (const layer of want) {
    // Layer D exists only where a generator is injected (the
    // Worker). A request for D without one is skipped, never
    // silently "done".
    if (layer === "d" && !deps.generateD) {
      skipped.push(layer);
      continue;
    }
    if (!layerDue(layer, row, atOf(layer), stateOf(layer), now)) {
      skipped.push(layer);
      continue;
    }
    try {
      if (layer === "a") {
        const { state, payload } = await runLayerA(record, {
          fetchFn: deps.fetchFn,
          fetchBytes: deps.fetchBytes ?? defaultFetchBytes,
          assets: deps.assets,
        }, now);
        await store.upsertLayer(record.id, hash, "a", state, payload, at);
        ran.a = state;
      } else if (layer === "b") {
        const { state, payload } = await runLayerB(record, { fetchFn: deps.fetchFn }, now);
        await store.upsertLayer(record.id, hash, "b", state, payload, at);
        ran.b = state;
        searchTouched = true;
      } else if (layer === "d") {
        const readmeText = deps.readReadme ? await deps.readReadme(record.id) : null;
        const { state, payload } = await runLayerD(record, row, hash, {
          generate: deps.generateD!,
          readmeText,
        }, now);
        await store.upsertLayer(record.id, hash, "d", state, payload, at);
        ran.d = state;
        searchTouched = true; // generated tags/use cases join search text
      } else if (layer === "e") {
        const { state, payload } = await runLayerE(record, { fetchFn: deps.fetchFn }, now);
        await store.upsertLayer(record.id, hash, "e", state, payload, at);
        ran.e = state;
      } else {
        const endpoint = remoteEndpointOf(record);
        if (!endpoint) {
          await store.upsertLayer(record.id, hash, "c", "none", {
            probedAt: at, endpoint: "", tools: [],
            reason: "no public remote MCP endpoint",
          }, at);
          ran.c = "none";
        } else {
          const { state, payload } = await probeMcpServer(endpoint, now, { fetchImpl: deps.probeFetch });
          await store.upsertLayer(record.id, hash, "c", state, payload, at);
          ran.c = state;
        }
        searchTouched = true;
      }
    } catch (e) {
      // A layer runner throwing (rather than degrading) still must
      // not take the record down: record a partial with the reason.
      const message = `layer threw: ${(e as Error).message}`;
      const payload = layer === "a"
        ? { fetchedAt: at, errors: [message] }
        : layer === "b"
          ? { derivedAt: at, errors: [message] }
          : layer === "d"
            ? { generatedAt: at, sourceHash: hash, reason: message, errors: [message] }
            : layer === "e"
              ? {
                  scannedAt: at, files: [], flags: [],
                  lastVerifiedAt: record.attestation?.signedAt ?? record.ingestedAt,
                  drift: { status: "unknown", checkedAt: at, reason: message },
                  reason: message, errors: [message],
                }
              : { probedAt: at, endpoint: remoteEndpointOf(record) ?? "", tools: [], errors: [message] };
      await store.upsertLayer(record.id, hash, layer, "partial", payload, at);
      ran[layer] = "partial";
      if (layer !== "a" && layer !== "e") searchTouched = true;
    }
    row = await store.get(record.id);
  }

  let searchUpdated = false;
  if (searchTouched) {
    await appendSearchExtras(deps.db, record, searchExtrasOf(row), generatedExtrasOf(row));
    searchUpdated = true;
  }
  return { skillId: record.id, ran, skipped, searchUpdated };
}

// ---------------------------------------------------------------------------
// Paged runner — mirrors indexStaleRecordsPage's contract exactly:
// { limit, cursor } in, page stats + nextCursor/done out, one bounded
// page per invocation, checkpoint = the enrichment table itself.
// ---------------------------------------------------------------------------

export const DEFAULT_ENRICH_PAGE = 25;
export const MAX_ENRICH_PAGE = 100;

export interface EnrichPageStats {
  considered: number;
  /** Records where at least one layer ran. */
  enriched: number;
  /** Records where every requested layer was already fresh. */
  skippedFresh: number;
  layerRuns: Record<EnrichLayer, number>;
  nextCursor: string | null;
  done: boolean;
}

export async function enrichPage(
  deps: EnrichDeps,
  opts: { limit?: number; cursor?: string | null; layers?: EnrichLayer[]; now?: Date } = {},
): Promise<EnrichPageStats> {
  const raw = Math.floor(opts.limit ?? DEFAULT_ENRICH_PAGE);
  const limit = Math.max(1, Math.min(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ENRICH_PAGE, MAX_ENRICH_PAGE));
  const cursor: TrafficCursor | null = decodeTrafficCursor(opts.cursor ?? null);
  const items = await trafficPage(deps.db, cursor, limit);
  const stats: EnrichPageStats = {
    considered: items.length,
    enriched: 0,
    skippedFresh: 0,
    layerRuns: { a: 0, b: 0, c: 0, d: 0, e: 0 },
    nextCursor: null,
    done: items.length < limit,
  };
  for (const item of items) {
    const outcome = await enrichRecord(item.record, deps, {
      layers: opts.layers, now: opts.now, existing: item.enrichment,
    });
    const ranLayers = Object.keys(outcome.ran) as EnrichLayer[];
    if (ranLayers.length) stats.enriched++;
    else stats.skippedFresh++;
    for (const l of ranLayers) stats.layerRuns[l]++;
  }
  if (!stats.done && items.length) {
    const last = items[items.length - 1];
    stats.nextCursor = encodeTrafficCursor({ s: last.behaviorScore, c: last.calls30d, id: last.record.id });
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Explicit-id runner — the tranche-run counterpart to enrichPage:
// the operator (or gate) names the exact record set (e.g. "the
// tranche-1 slice" = every record holding an enrichment row), and
// each id is enriched in turn. Bounded by the caller's list length;
// records that no longer exist are reported, never fatal.
// ---------------------------------------------------------------------------

export interface EnrichIdsStats {
  considered: number;
  missing: string[];
  enriched: number;
  skippedFresh: number;
  layerRuns: Record<EnrichLayer, number>;
  outcomes: EnrichOutcome[];
}

export async function enrichIds(
  deps: EnrichDeps,
  ids: string[],
  opts: { layers?: EnrichLayer[]; now?: Date } = {},
): Promise<EnrichIdsStats> {
  if (!deps.loadRecord) throw new Error("enrichIds requires deps.loadRecord");
  const stats: EnrichIdsStats = {
    considered: ids.length,
    missing: [],
    enriched: 0,
    skippedFresh: 0,
    layerRuns: { a: 0, b: 0, c: 0, d: 0, e: 0 },
    outcomes: [],
  };
  for (const id of ids) {
    const record = await deps.loadRecord(id);
    if (!record) { stats.missing.push(id); continue; }
    const outcome = await enrichRecord(record, deps, { layers: opts.layers, now: opts.now });
    stats.outcomes.push(outcome);
    const ranLayers = Object.keys(outcome.ran) as EnrichLayer[];
    if (ranLayers.length) stats.enriched++;
    else stats.skippedFresh++;
    for (const l of ranLayers) stats.layerRuns[l]++;
  }
  return stats;
}
