// Discovery-depth ranking (P5, ARCHITECTURE-v2 §7): hybrid merge,
// behavioral re-rank, cold-start, trending, goal stacks, related
// skills. All pure functions — the I/O lives in store.ts / the Worker.
//
// The original design's order is preserved:
//   hybrid retrieval (query-length weighting)
//   → behavioral re-rank (retention · install velocity · publisher trust)
//   → cold-start exploration boost (new records are NOT buried)
// Install count alone never ranks: it enters only log-scaled, inside
// the behavior score, per the original precision-failure analysis.

import type { SkillRecord } from "../types.js";
import { flattenComponents } from "../search.js";

// ---------------------------------------------------------------------------
// Hybrid merge (keyword + vector)
// ---------------------------------------------------------------------------

export interface HybridWeights {
  keyword: number;
  vector: number;
}

/**
 * Query-length weighting, per the original discovery design: SHORT
 * queries are precise identifiers ("pdf", "xlsx") where keyword match
 * must dominate; LONGER natural-language queries ("turn my meetings
 * into notes") are intent statements where keyword tokens are mostly
 * noise and the semantic vector should carry more of the ranking.
 */
export function hybridWeights(tokenCount: number): HybridWeights {
  if (tokenCount <= 2) return { keyword: 0.85, vector: 0.15 };
  if (tokenCount <= 4) return { keyword: 0.65, vector: 0.35 };
  if (tokenCount <= 7) return { keyword: 0.45, vector: 0.55 };
  return { keyword: 0.3, vector: 0.7 };
}

export interface Scored {
  id: string;
  /** Keyword: arbitrary engine score (higher = better). Vector:
   *  cosine similarity 0..1. */
  score: number;
}

export interface HybridHit {
  id: string;
  score: number;
  keywordScore: number;
  vectorScore: number;
}

/**
 * Merge keyword and vector candidate lists. Keyword scores are
 * rank-normalized (1/(1+rank)) so the merge does not depend on the
 * engine's raw scale; vector scores are used as-is (cosine, clamped).
 */
export function mergeHybrid(
  keyword: Scored[],
  vector: Scored[],
  weights: HybridWeights,
  limit = 20,
): HybridHit[] {
  const byId = new Map<string, HybridHit>();
  keyword.forEach((h, rank) => {
    const kw = 1 / (1 + rank);
    byId.set(h.id, { id: h.id, score: weights.keyword * kw, keywordScore: kw, vectorScore: 0 });
  });
  for (const h of vector) {
    const vec = Math.max(0, Math.min(1, h.score));
    const cur = byId.get(h.id);
    if (cur) {
      cur.vectorScore = vec;
      cur.score += weights.vector * vec;
    } else {
      byId.set(h.id, { id: h.id, score: weights.vector * vec, keywordScore: 0, vectorScore: vec });
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Behavioral signals + cold start
// ---------------------------------------------------------------------------

/** The per-record behavioral snapshot (record_stats rows). */
export interface RecordBehavior {
  calls30d: number;
  calls7d: number;
  callsPrev7d: number;
  installsTotal: number;
  installs30d: number;
  /** Share of the owner's records carrying an attestation, 0..1. */
  ownerAttestedShare: number;
  /** Owner's mean validation warnings per record, ≥ 0. */
  ownerWarningRate: number;
}

/**
 * Behavior score (documented formula):
 *   retention   = log1p(calls in last 30d via the gateway)   — the
 *                 retention proxy: skills people keep calling back
 *   installs    = 0.7 · log1p(total pinned installs)
 *   trust       = 0.6 · owner attested share − 0.4 · min(owner
 *                 warning rate, 1)
 * Log scales keep a single viral skill from swamping the catalog,
 * and keep behavior a *factor*, never a gate.
 */
export function behaviorScore(b: RecordBehavior): number {
  const retention = Math.log1p(Math.max(0, b.calls30d));
  const installs = 0.7 * Math.log1p(Math.max(0, b.installsTotal));
  const trust = 0.6 * b.ownerAttestedShare - 0.4 * Math.min(Math.max(0, b.ownerWarningRate), 1);
  return retention + installs + trust;
}

/**
 * Cold-start exploration boost (the original cold-start program): a
 * record younger than 14 days gets a boost that decays linearly to
 * zero at day 14, so new supply surfaces while it has no behavioral
 * history yet instead of being buried under established records.
 */
export function coldStartBoost(ingestedAt: string, now: Date): number {
  const ageMs = now.getTime() - new Date(ingestedAt).getTime();
  const ageDays = ageMs / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0.5; // unparseable/future → treat as new
  if (ageDays >= 14) return 0;
  return 0.5 * (1 - ageDays / 14);
}

/** How much behavior + cold-start may move a hybrid score. Both are
 *  additive adjustments on the 0..~1 hybrid scale — bounded on
 *  purpose, so relevance always dominates. */
export const BEHAVIOR_WEIGHT = 0.08;
export const COLD_START_WEIGHT = 0.2;

export interface PostRankItem {
  id: string;
  score: number;
}

/**
 * Apply the behavioral re-rank + cold-start boost to merged hybrid
 * hits. Records missing from the stats map count as zero behavior
 * (but may still earn the cold-start boost).
 */
export function applyPostRank<T extends PostRankItem & { ingestedAt?: string }>(
  hits: T[],
  behavior: Map<string, number>,
  ingestedAtById: Map<string, string>,
  now: Date,
): (T & { adjustedScore: number })[] {
  return hits
    .map((h) => {
      const b = behavior.get(h.id) ?? 0;
      const ingestedAt = h.ingestedAt ?? ingestedAtById.get(h.id);
      const boost = ingestedAt ? coldStartBoost(ingestedAt, now) : 0;
      return { ...h, adjustedScore: h.score + BEHAVIOR_WEIGHT * b + COLD_START_WEIGHT * boost };
    })
    .sort((a, b) => b.adjustedScore - a.adjustedScore || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Trending (cohort velocity with an honesty floor)
// ---------------------------------------------------------------------------

export interface TrendingRow {
  id: string;
  calls7d: number;
  callsPrev7d: number;
  calls30d: number;
}

export interface TrendingResult {
  ids: string[];
  /** True when activity was too thin to rank by velocity and the
   *  caller should fall back to the static ranking. */
  fallback: boolean;
  floor: number;
}

/** Minimum 7-day gateway calls for a record to count as "active". */
export const TRENDING_FLOOR = 3;

/**
 * Trending = 7-day gateway-call velocity: recent calls, boosted by
 * growth over the prior 7 days. If fewer than `minActive` records
 * clear the activity floor, trending is declared a fallback — the
 * endpoint then serves the documented static ranking and SAYS so,
 * rather than dressing up near-zero data as a trend.
 */
export function computeTrending(
  rows: TrendingRow[],
  opts: { floor?: number; minActive?: number; limit?: number } = {},
): TrendingResult {
  const floor = opts.floor ?? TRENDING_FLOOR;
  const minActive = opts.minActive ?? 3;
  const limit = opts.limit ?? 8;
  const active = rows
    .filter((r) => r.calls7d >= floor)
    .map((r) => ({ id: r.id, score: r.calls7d + 2 * Math.max(0, r.calls7d - r.callsPrev7d) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (active.length < minActive) return { ids: [], fallback: true, floor };
  return { ids: active.slice(0, limit).map((r) => r.id), fallback: false, floor };
}

// ---------------------------------------------------------------------------
// Goal stacks (rule-based, first-class result type)
// ---------------------------------------------------------------------------

const KIND_RATIONALE: Record<string, string> = {
  skill: "the hands — instructions your agent follows step by step",
  mcp: "the connection — live tools/data your agent can call",
  agent: "the operator — an autonomous worker for the whole job",
  plugin: "the bundle — a packaged set of skills, commands and tools",
};

export interface GoalStack {
  picks: { id: string; kind: string; rationale: string }[];
  rationale: string;
}

/**
 * The stack rule (documented, deliberately simple): when a
 * multi-token query's top 8 results span ≥2 different kinds, offer
 * the top pick PER KIND as a suggested goal stack — real goals are
 * usually "a skill to do it + an MCP server to connect it", not one
 * record. Otherwise no stack (null), never a forced one.
 */
export function buildStack(results: SkillRecord[], query: string, topN = 8): GoalStack | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const top = results.slice(0, topN);
  const byKind = new Map<string, SkillRecord>();
  for ( const r of top) if (!byKind.has(r.kind)) byKind.set(r.kind, r);
  if (byKind.size < 2) return null;
  const picks = [...byKind.entries()].map(([kind, r]) => ({
    id: r.id,
    kind,
    rationale: KIND_RATIONALE[kind] ?? kind,
  }));
  return {
    picks,
    rationale: `Your goal spans ${picks.length} kinds of help — one top pick per kind from the results.`,
  };
}

// ---------------------------------------------------------------------------
// Related skills (in-context suggestions)
// ---------------------------------------------------------------------------

export interface RelatedPick {
  id: string;
  score: number;
  reasons: string[];
}

/**
 * Related = vector neighbours of the record, blended with structural
 * signals: same owner (+0.25), shared components (+0.08 each, capped
 * +0.32), same kind (+0.05). The record itself is always excluded.
 * Pure: the caller supplies vector neighbours (or [] when the vector
 * layer is unavailable — structural signals still produce a rail).
 */
export function relatedBlend(
  target: SkillRecord,
  candidates: SkillRecord[],
  vectorNeighbors: Scored[],
  limit = 6,
): RelatedPick[] {
  const vecScore = new Map(vectorNeighbors.map((n) => [n.id, Math.max(0, Math.min(1, n.score))]));
  const targetComponents = new Set(flattenComponents(target).map((c) => c.toLowerCase()));
  const out: RelatedPick[] = [];
  for (const c of candidates) {
    if (c.id === target.id) continue;
    let score = vecScore.get(c.id) ?? 0;
    const reasons: string[] = [];
    if (vecScore.has(c.id)) reasons.push("semantically close");
    if (c.owner === target.owner) { score += 0.25; reasons.push("same publisher"); }
    const shared = flattenComponents(c)
      .map((x) => x.toLowerCase())
      .filter((x) => targetComponents.has(x));
    if (shared.length) {
      score += Math.min(0.32, 0.08 * shared.length);
      reasons.push(`shares components: ${[...new Set(shared)].slice(0, 3).join(", ")}`);
    }
    if (c.kind === target.kind) { score += 0.05; reasons.push(`also a ${c.kind}`); }
    if (score > 0) out.push({ id: c.id, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
