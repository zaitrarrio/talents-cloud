// Discovery orchestration for the Worker (P5, ARCHITECTURE-v2 §7):
// hybrid search (FTS + expansions + Vectorize, query-length weighted,
// behaviorally re-ranked), trending, suggestions, the GitHub webhook
// route, the cron sweep, the queue consumer, and token-gated admin
// triggers. All ranking math lives in ../../src/discovery/ranking.ts
// (pure, unit-tested); this module is the I/O glue.
//
// Graceful degradation is a hard rule: no AI/Vectorize binding, a
// vector outage, or an un-refreshed stats table must NEVER break
// search — every semantic/behavioral step is wrapped and falls back
// to the keyword order from the D1 engine.

import type { FetchFn, SkillRecord } from "../../src/types.js";
import { D1SearchEngine } from "../../src/search-d1.js";
import type { SearchQueryInput } from "../../src/search.js";
import {
  D1DiscoveryStore, LEASE_TTL_MINUTES, behaviorScores, isLeaseActive, trendingRows, type CandidateCursor, type DiscoveryStore, type DlqEntry, type SourceRow,
} from "../../src/discovery/store.js";
import {
  applyPostRank, buildStack, computeTrending, hybridWeights, mergeHybrid,
  relatedBlend, type GoalStack,
} from "../../src/discovery/ranking.js";
import {
  augmentedEmbeddingText, expandedQueryString,
} from "../../src/discovery/synonyms.js";
import {
  VectorizeIndex, WorkersAIEmbedder, embeddingText, indexStaleRecords, indexStaleRecordsPage,
} from "../../src/discovery/embeddings.js";
import { ingestSource, runDiscoveryCycle } from "../../src/discovery/pipeline.js";
import { classifyAsList, isNoSkillFilesReason, refreshAllLists, refreshListSource } from "../../src/discovery/lists.js";
import { Pacer, verifyRepo } from "../../src/discovery/sweep.js";
import { defaultFetch } from "../../src/ingest.js";
import { runScoutNominations } from "../../src/discovery/scouts/runner.js";
import { githubCodeScout } from "../../src/discovery/scouts/github-code.js";
import { mcpRegistryScout } from "../../src/discovery/scouts/mcp-registry.js";
import { npmScout } from "../../src/discovery/scouts/npm.js";
import { skillsShScout } from "../../src/discovery/scouts/skills-sh.js";
import { webSearchScout } from "../../src/discovery/scouts/web.js";
import type { Scout, ScoutContext, ScoutName } from "../../src/discovery/scouts/types.js";
import type { RegistryKey } from "../../src/attest.js";
import { handleGithubPush, type PushPayload } from "../../src/webhook.js";
import { extrasForIds } from "../../src/enrichment/store.js";
import {
  getRecord, listedStats, recordIdsSharingComponents, recordsByIds, recordsByKindSample, recordsByOwner,
  recordsPage, recentListedRecords, unlistedSkillIds, type Env, type QueueLike,
} from "./db.js";
import { flattenComponents } from "../../src/search.js";
import { trending as staticTrending } from "../../src/render.js";

// The registry attestation key is a Worker secret in production
// (TALENTS_REGISTRY_KEY, JSON of {privateKeyPem, publicKeyPem}); for
// the discovery paths in this build the key is only needed to SIGN
// attestations during ingest. When the secret is absent, ingest in
// the Worker is disabled with a clear error rather than minting an
// ephemeral key whose attestations would not verify tomorrow.
function registryKeyFromEnv(env: Env & { TALENTS_REGISTRY_KEY?: string }): RegistryKey | null {
  const raw = env.TALENTS_REGISTRY_KEY;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RegistryKey;
  } catch {
    return null;
  }
}

function vectorStack(env: Env) {
  if (!env.AI || !env.VECTORIZE) return null;
  return {
    embedder: new WorkersAIEmbedder(env.AI),
    index: new VectorizeIndex(env.VECTORIZE),
  };
}

/** Vector hits carry Vectorize ids (sha256 of the record id — see
 *  embeddings.vectorIdFor); translate them back to record ids via
 *  embedding_meta. Unknown ids pass through (legacy raw-id vectors). */
async function translateVectorHits(
  env: Env,
  hits: { id: string; score: number }[],
): Promise<{ id: string; score: number }[]> {
  if (!hits.length) return hits;
  try {
    const map = await new D1DiscoveryStore(env.DB).vectorIdMap();
    return hits.map((h) => ({ id: map.get(h.id) ?? h.id, score: h.score }));
  } catch {
    return hits;
  }
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

export interface HybridSearchResult {
  results: SkillRecord[];
  partial: boolean;
  missingTokens: string[];
  note: string | null;
  stack: GoalStack | null;
  vectorUsed: boolean;
  /** Sanitized message when the vector layer was configured but
   *  failed (ops visibility; the search itself still succeeded on
   *  keyword order). Absent when the layer is off or healthy. */
  vectorError?: string;
}

export async function hybridSearch(
  env: Env,
  engine: D1SearchEngine,
  input: SearchQueryInput,
): Promise<HybridSearchResult> {
  const limit = input.limit ?? 20;
  const detailed = await engine.searchDetailed(input);
  // Owner-unlisted records (P4) are filtered from EVERY pass below:
  // the D1 engine reads `records` directly, so the opt-out filter
  // lives here and in db.ts (the shared read path). Vector hits
  // resolve through recordsByIds (unlisted ids never resolve).
  const unlisted = await unlistedSkillIds(env.DB);
  const visible = (rs: SkillRecord[]) => (unlisted.size ? rs.filter((r) => !unlisted.has(r.id)) : rs);
  let ordered: SkillRecord[] = visible([...detailed.results]);

  // Intent enrichment: a second, demoted pass over expansion terms.
  // Expansion results never outrank raw matches and never affect the
  // partial-match honesty of the raw query.
  const expanded = expandedQueryString(input.q);
  if (expanded && ordered.length < limit) {
    try {
      const extra = await engine.search({ ...input, q: expanded, limit });
      const seen = new Set(ordered.map((r) => r.id));
      for (const r of visible(extra)) if (!seen.has(r.id)) ordered.push(r);
    } catch { /* enrichment is best-effort */ }
  }

  const byId = new Map<string, SkillRecord>();
  // Seed with the keyword results (already full records) so merged
  // keyword-only ids resolve without a catalog load — the old code
  // loaded every listed record here, which is 53.5 MB at current
  // scale and 500s under D1's 50 MB response limit (gate-d1size).
  for (const r of ordered) byId.set(r.id, r);
  let vectorUsed = false;
  let vectorError: string | undefined;
  let mergeScores: Map<string, number> | null = null;
  try {
    const stack = vectorStack(env);
    if (stack && input.q.trim()) {
      const [qv] = await stack.embedder.embed([augmentedEmbeddingText(input.q)]);
      const neighbours = await translateVectorHits(env, await stack.index.query(qv, 30));
      // Fetch ONLY the neighbours' records by id (bounded, chunked).
      for (const r of await recordsByIds(env.DB, neighbours.map((n) => n.id))) byId.set(r.id, r);
      const usable = neighbours.filter((n) => {
        const r = byId.get(n.id);
        if (!r || r.status !== "listed") return false;
        if (input.kind && r.kind !== input.kind) return false;
        if (input.owner && r.owner !== input.owner) return false;
        return true;
      });
      if (usable.length) {
        vectorUsed = true;
        const tokenCount = input.q.trim().split(/\s+/).filter(Boolean).length;
        const merged = mergeHybrid(
          ordered.map((r) => ({ id: r.id, score: 0 })),
          usable,
          hybridWeights(tokenCount),
          Math.max(limit * 2, limit),
        );
        const mergedRecords = merged
          .map((h) => byId.get(h.id))
          .filter((r): r is SkillRecord => Boolean(r));
        // Records in the keyword list but not merged (beyond merge
        // limit) keep their order at the tail.
        const inMerged = new Set(mergedRecords.map((r) => r.id));
        ordered = [...mergedRecords, ...ordered.filter((r) => !inMerged.has(r.id))];
        // Keep merge scores for the post-rank step.
        mergeScores = new Map(merged.map((h) => [h.id, h.score]));
      }
    }
  } catch (e) {
    // Vector layer is best-effort; keyword order stands. The message
    // is surfaced (sanitized, no internals beyond the error text) so
    // a silently-dead semantic layer can never masquerade as healthy.
    vectorError = (e as Error).message;
  }

  // Behavioral re-rank + cold-start (bounded adjustments; see ranking.ts).
  // byId is NOT reloaded here: the old code re-scanned the whole
  // catalog when the vector block had not run, but byId is not read
  // below this point — the load was pure overhead that 500s at
  // current scale (gate-d1size).
  try {
    const ids = ordered.map((r) => r.id);
    const scores = await behaviorScores(env.DB, ids);
    const hits = ordered.map((r, i) => ({
      id: r.id,
      score: mergeScores?.get(r.id) ?? 1 / (1 + i),
      ingestedAt: r.ingestedAt,
    }));
    const ranked = applyPostRank(hits, scores, new Map(), new Date());
    const rankOf = new Map(ranked.map((h, i) => [h.id, i]));
    ordered = [...ordered].sort((a, b) => (rankOf.get(a.id) ?? 0) - (rankOf.get(b.id) ?? 0));
  } catch { /* stats table may not exist yet — keyword order stands */ }

  const results = ordered.slice(0, limit);
  return {
    results,
    partial: detailed.meta.partial,
    missingTokens: detailed.meta.missingTokens,
    note: detailed.meta.note,
    stack: buildStack(results, input.q),
    vectorUsed,
    ...(vectorError ? { vectorError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Trending
// ---------------------------------------------------------------------------

export interface TrendingResponse {
  mode: "velocity" | "static-fallback";
  floor: number;
  results: SkillRecord[];
}

/** Pool size for the static trending fallback: the most recently
 *  ingested listed records. The velocity path is exact (ids from
 *  gateway_calls, records fetched by id); the fallback ranks the
 *  same static function over this pool instead of the whole catalog
 *  (gate-d1size). */
export const STATIC_TRENDING_POOL = 500;

export async function trendingRecords(env: Env): Promise<TrendingResponse> {
  try {
    const rows = await trendingRows(env.DB, new Date());
    const t = computeTrending(rows);
    if (!t.fallback) {
      // Fetch ONLY the trending ids — the old code loaded the whole
      // catalog here (53.5 MB at current scale; D1's response limit
      // is 50 MB, so home and /api/trending 500).
      const picked = await recordsByIds(env.DB, t.ids);
      if (picked.length) return { mode: "velocity", floor: t.floor, results: picked };
    }
    const pool = await recentListedRecords(env.DB, STATIC_TRENDING_POOL);
    return { mode: "static-fallback", floor: t.floor, results: staticTrending(pool, 8) };
  } catch {
    // Last resort: never 500 the home page for a trending failure —
    // an empty rail renders, and the pool load itself is bounded.
    try {
      const pool = await recentListedRecords(env.DB, STATIC_TRENDING_POOL);
      return { mode: "static-fallback", floor: 0, results: staticTrending(pool, 8) };
    } catch {
      return { mode: "static-fallback", floor: 0, results: [] };
    }
  }
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/** Candidate-pool caps for suggestions (gate-d1size): the old code
 *  blended over the WHOLE catalog — a 53.5 MB load at current
 *  scale. The pool below is bounded by construction (vector
 *  neighbours + same-owner + same-kind sample + component matches);
 *  the blend scores themselves are unchanged. */
export const SUGGEST_OWNER_CAP = 100;
export const SUGGEST_KIND_CAP = 100;
export const SUGGEST_COMPONENT_CAP = 100;

export async function suggestForSkill(env: Env, id: string): Promise<SkillRecord[] | null> {
  const target = await getRecord(env.DB, id);
  if (!target) return null;
  let neighbours: { id: string; score: number }[] = [];
  try {
    const stack = vectorStack(env);
    if (stack) {
      const [v] = await stack.embedder.embed([embeddingText(target)]);
      neighbours = await translateVectorHits(env, await stack.index.query(v, 12));
    }
  } catch { /* structural blend still works */ }
  const ids = new Set<string>(neighbours.map((n) => n.id));
  for (const r of await recordsByOwner(env.DB, target.owner, SUGGEST_OWNER_CAP)) ids.add(r.id);
  for (const r of await recordsByKindSample(env.DB, target.kind, SUGGEST_KIND_CAP)) ids.add(r.id);
  const components = flattenComponents(target).slice(0, 8);
  for (const cid of await recordIdsSharingComponents(env.DB, components, SUGGEST_COMPONENT_CAP)) ids.add(cid);
  ids.delete(target.id);
  const candidates = await recordsByIds(env.DB, [...ids]);
  const picks = relatedBlend(target, candidates, neighbours, 6);
  const byId = new Map(candidates.map((r) => [r.id, r]));
  return picks.map((p) => byId.get(p.id)).filter((r): r is SkillRecord => Boolean(r));
}

// ---------------------------------------------------------------------------
// Webhook freshness
// ---------------------------------------------------------------------------

/** HMAC-SHA256 verification with WebCrypto (Worker-native). */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

export interface WebhookOutcome {
  reindex: boolean;
  reason: string;
  queued: boolean;
  repo: string | null;
}

export async function handleWebhook(env: Env, payload: PushPayload & { repository?: { full_name?: string } }): Promise<WebhookOutcome> {
  const repo = (payload.repository?.full_name ?? "").toLowerCase() || null;
  const result = handleGithubPush(payload);
  if (!result.reindex || !repo) return { ...result, queued: false, repo };
  if (env.INGEST_QUEUE) {
    await env.INGEST_QUEUE.send({ locator: repo, via: "webhook" });
    return { ...result, queued: true, repo };
  }
  return { ...result, queued: false, repo };
}

// ---------------------------------------------------------------------------
// Cron sweep + queue consumer + admin triggers
// ---------------------------------------------------------------------------

export interface IngestQueueMessage {
  locator: string;
  via?: string;
  kind?: SourceRow["kind"];
}

/** GitHub rate-budget observability (drain hardening, 2026-11-11).
 *
 *  GitHub's core limit is 5,000 calls/hour for an authenticated
 *  token; the consumer makes ≤8 api.github.com calls per candidate
 *  (3 typical). The Worker records two sync_state rows so the
 *  producer can pace itself and the consumer can refuse to hammer:
 *    github_rate                 — JSON {remaining, reset} while
 *      remaining < 1,000 (a low-water snapshot, not a per-call
 *      write: healthy traffic never writes it). Readers expire
 *      it past its reset epoch (readGithubRateSnapshot, 2026-11-15):
 *      a stale snapshot must never pace the producer again.
 *    github_rate_exhausted_until — ISO timestamp while the budget
 *      is exhausted (set on 403/429 with rate-limit headers; the
 *      producer halts and the consumer throws-to-retry until it
 *      passes; Retry-After wins over x-ratelimit-reset where
 *      present; a bare 403/429 with no headers gets a 60s hold)
 *  Both rows are best-effort: a store write failure never fails
 *  the fetch that produced it. */
export const RATE_BUDGET_RESERVE_CALLS = 500;
export const RATE_BUDGET_LOW_WATER = 1000;
export const RATE_BUDGET_DEFAULT_HOLD_SECONDS = 60;

export async function recordRateLimitHeaders(
  store: DiscoveryStore,
  res: { status: number; headers?: { get(name: string): string | null } },
  now: Date = new Date(),
): Promise<void> {
  const headers = res.headers;
  if (!headers || typeof headers.get !== "function") return;
  const remainingRaw = headers.get("x-ratelimit-remaining");
  const resetRaw = headers.get("x-ratelimit-reset");
  const retryAfterRaw = headers.get("retry-after");
  const remaining = remainingRaw === null ? null : Number(remainingRaw);
  const resetEpoch = resetRaw === null ? null : Number(resetRaw);
  const retryAfter = retryAfterRaw === null ? null : Number(retryAfterRaw);
  if (res.status === 403 || res.status === 429) {
    // Rate-limited: hold until Retry-After, else until the reset
    // epoch, else a fixed 60s. (A 403 here can also be an
    // authorization error — but a 403 from api.github.com with
    // rate-limit headers present IS the rate limit, and one
    // without headers still earns a short hold rather than a
    // retry storm; the Pacer already backs off per call.)
    let untilMs: number | null = null;
    if (retryAfter !== null && Number.isFinite(retryAfter) && retryAfter > 0) {
      untilMs = now.getTime() + retryAfter * 1000;
    } else if (resetEpoch !== null && Number.isFinite(resetEpoch) && resetEpoch > 0) {
      untilMs = resetEpoch * 1000;
    } else {
      untilMs = now.getTime() + RATE_BUDGET_DEFAULT_HOLD_SECONDS * 1000;
    }
    try {
      await store.setSyncState("github_rate_exhausted_until", new Date(untilMs).toISOString());
      if (remaining !== null && Number.isFinite(remaining)) {
        await store.setSyncState("github_rate", JSON.stringify({ remaining, reset: resetEpoch }));
      }
    } catch { /* best-effort; never fails the fetch */ }
    return;
  }
  if (remaining !== null && Number.isFinite(remaining) && remaining < RATE_BUDGET_LOW_WATER) {
    try {
      await store.setSyncState("github_rate", JSON.stringify({ remaining, reset: resetEpoch }));
    } catch { /* best-effort */ }
  }
}

/** Thrown when the recorded GitHub budget is exhausted. The
 *  consumer throws it before any GitHub call so Queues retries
 *  later instead of hammering; the producer treats it as a halt. */
export class RateBudgetExhaustedError extends Error {
  readonly until: string;
  constructor(until: string) {
    super(`GitHub rate budget exhausted until ${until}`);
    this.name = "RateBudgetExhaustedError";
    this.until = until;
  }
}

/** True when the recorded budget is exhausted at `now`. The
 *  producer and the consumer both check this before spending any
 *  GitHub calls. Unknown (never recorded) means "not exhausted". */
export async function checkRateBudget(store: DiscoveryStore, now: Date = new Date()): Promise<void> {
  const until = await store.getSyncState("github_rate_exhausted_until");
  if (until && Date.parse(until) > now.getTime()) {
    throw new RateBudgetExhaustedError(until);
  }
}

export interface GithubRateSnapshot {
  remaining: number | null;
  /** Unix reset epoch from the snapshot, when present. */
  reset: number | null;
}

/** Read the low-water GitHub budget snapshot, expiring it past
 *  its reset time (drain stall, 2026-11-15): the snapshot is a
 *  point-in-time {remaining, reset} written only while remaining
 *  < 1,000, and nothing refreshed it after the window reset —
 *  the producer tick then read "27 calls left" forever and
 *  refused to run while the budget had in fact refilled. A
 *  snapshot whose reset epoch has passed is stale by definition,
 *  so it is treated as unknown (and cleared, best-effort, with
 *  the same "" convention as the producer-lease release) instead
 *  of trusted. A snapshot with no usable reset (missing/null)
 *  cannot be expiry-checked, so it is kept as-is. */
export async function readGithubRateSnapshot(
  store: DiscoveryStore,
  now: Date = new Date(),
): Promise<GithubRateSnapshot> {
  const raw = await store.getSyncState("github_rate");
  if (!raw) return { remaining: null, reset: null };
  try {
    const parsed = JSON.parse(raw) as { remaining?: unknown; reset?: unknown };
    const remaining = typeof parsed.remaining === "number" ? parsed.remaining : null;
    const reset = typeof parsed.reset === "number" && Number.isFinite(parsed.reset) ? parsed.reset : null;
    if (reset !== null && reset * 1000 <= now.getTime()) {
      await store.setSyncState("github_rate", "").catch(() => {});
      return { remaining: null, reset };
    }
    return { remaining, reset };
  } catch {
    return { remaining: null, reset: null };
  }
}

/** The fetch every Worker-side discovery path runs on. When the
 *  GITHUB_TOKEN secret is set, api.github.com requests carry it as a
 *  Bearer token (an explicit authorization header from a caller
 *  always wins; non-GitHub hosts — raw.githubusercontent.com, npm,
 *  the MCP registry — never see it). This is the one place the
 *  token enters the verify/ingest path: sweep verification,
 *  marketplace/repo-scan ingest, list classification, and the scout
 *  funnel all flow through deps.fetchFn. The token is never logged
 *  and never written anywhere. GitHub rate-limit headers on
 *  api.github.com responses are recorded (see
 *  recordRateLimitHeaders) so the producer/consumer can back off. */
export function githubAuthedFetch(env: Env): FetchFn {
  const token = env.GITHUB_TOKEN;
  if (!token) return defaultFetch;
  return async (url, init) => {
    if (url.startsWith("https://api.github.com/")) {
      const headers = { ...(init?.headers ?? {}) };
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
        headers.authorization = `Bearer ${token}`;
      }
      const res = await defaultFetch(url, { ...init, headers });
      // The store is cheap to construct; the recording itself is
      // best-effort and only writes on 403/429 or low remaining.
      await recordRateLimitHeaders(new D1DiscoveryStore(env.DB), res).catch(() => {});
      return res;
    }
    return defaultFetch(url, init);
  };
}

function workerDeps(env: Env, onNewRecords?: (records: SkillRecord[]) => Promise<void>) {
  const key = registryKeyFromEnv(env as Env & { TALENTS_REGISTRY_KEY?: string });
  if (!key) return null;
  return {
    store: new D1DiscoveryStore(env.DB),
    registryKey: key,
    fetchFn: githubAuthedFetch(env),
    onNewRecords,
  };
}

async function embedRecords(env: Env, records: SkillRecord[]): Promise<void> {
  const stack = vectorStack(env);
  if (!stack || !records.length) return;
  const store = new D1DiscoveryStore(env.DB);
  await indexStaleRecords(store, stack.embedder, stack.index, records, { limit: 100 });
}

/**
 * Bounded daily-cron embed sweep (gate-d1size): page the catalog in
 * 250-record chunks with a shared 100-embed budget — the same budget
 * the old allRecords load carried, but no single D1 response may
 * exceed the 50 MB limit (the full-table load is 53.5 MB at current
 * scale). Stops early once the budget is hit. Per-ingest embedding
 * (embedRecords, bounded record sets) is untouched.
 */
async function embedCatalogBounded(env: Env): Promise<void> {
  const stack = vectorStack(env);
  if (!stack) return;
  const store = new D1DiscoveryStore(env.DB);
  const BUDGET = 100;
  const PAGE = 250;
  let embedded = 0;
  let cursor: string | null = null;
  while (embedded < BUDGET) {
    const page = await recordsPage(env.DB, cursor, PAGE);
    if (!page.length) break;
    const stats = await indexStaleRecords(store, stack.embedder, stack.index, page, { limit: BUDGET - embedded });
    embedded += stats.embedded;
    if (page.length < PAGE) break;
    cursor = page[page.length - 1].id;
  }
}

// ---------------------------------------------------------------------------
// Phase 2 scout rotation. One channel per day, staggered so no
// single cron run leans on every upstream at once (the daily cron
// is `23 4 * * *`; getUTCDay picks the channel):
//   Sun sweep · Mon sweep · Tue code-search · Wed mcp-registry
//   Thu npm · Fri skills.sh · Sat web-search
// The repo sweep keeps two days: it is also the refresh path for
// already-known sources. Scouts only NOMINATE (one funnel — see
// src/discovery/scouts/runner.ts); verified sources go to the same
// ingest queue as sweep finds. X is deliberately NOT in the Worker
// rotation: it needs a posts provider the Worker doesn't have, so
// it runs from the CLI (`talents discover x --posts <file>`).
// Code search needs the GITHUB_TOKEN Worker secret; without it the
// scout reports itself blocked in scout_runs and nominates nothing.
// Lists: known list sources are re-mined on Mondays (a sweep day —
// weekly is the right cadence for curated lists; re-mining is
// idempotent and removals are ignored by design, see lists.ts).
// ---------------------------------------------------------------------------

const SCOUT_ROTATION: Record<number, "sweep" | ScoutName> = {
  0: "sweep",
  1: "sweep",
  2: "github-code-search",
  3: "mcp-registry",
  4: "npm",
  5: "skills.sh",
  6: "web-search",
};

const CRON_SCOUTS: Partial<Record<ScoutName, { scout: Scout; pacerMs: number; opts: Record<string, unknown> }>> = {
  "github-code-search": { scout: githubCodeScout, pacerMs: 2500, opts: { pages: 1 } },
  "mcp-registry": { scout: mcpRegistryScout, pacerMs: 300, opts: { cap: 100 } },
  npm: { scout: npmScout, pacerMs: 300, opts: { size: 25 } },
  "skills.sh": { scout: skillsShScout, pacerMs: 500, opts: {} },
  "web-search": { scout: webSearchScout, pacerMs: 1000, opts: {} },
};

async function handleScheduledScout(
  env: Env,
  name: ScoutName,
  enqueue: ((source: SourceRow) => Promise<void>) | undefined,
): Promise<void> {
  const conf = CRON_SCOUTS[name];
  if (!conf) return;
  const deps = workerDeps(env, async (records) => { await embedRecords(env, records); });
  if (!deps) return;
  const pacer = new Pacer(conf.pacerMs);
  const ctx: ScoutContext = {
    fetchFn: deps.fetchFn,
    pacer,
    now: () => new Date(),
    getSyncState: (k) => deps.store.getSyncState(k),
    setSyncState: (k, v) => deps.store.setSyncState(k, v),
    githubToken: env.GITHUB_TOKEN,
  };
  const result = await conf.scout.run(ctx, conf.opts);
  const funnel = await runScoutNominations(
    { ...deps, fetchFn: deps.fetchFn, pacer },
    name,
    result,
    { enqueue, maxVerify: 16, maxIngest: 3 },
  );
  console.log(`discovery cron scout ${name}: ${JSON.stringify({ run: result.stats, funnel: { nominated: funnel.nominated, corroborated: funnel.corroborated, verified: funnel.verified, enqueued: funnel.enqueued, newRecords: funnel.newRecords } })}`);
}

/** Daily cron: the day's channel (rotation above) → enqueue
 *  verified sources → refresh embeddings for anything stale. */
export async function handleScheduled(env: Env): Promise<void> {
  const deps = workerDeps(env);
  if (!deps) {
    console.log("discovery cron: TALENTS_REGISTRY_KEY secret not set — ingest disabled, sweep skipped");
    return;
  }
  const enqueue = env.INGEST_QUEUE
    ? async (source: SourceRow) => { await env.INGEST_QUEUE!.send({ locator: source.locator, kind: source.kind, via: "cron" } satisfies IngestQueueMessage); }
    : undefined;
  const todays = SCOUT_ROTATION[new Date().getUTCDay()] ?? "sweep";
  if (todays !== "sweep") {
    await handleScheduledScout(env, todays, enqueue);
  } else {
    const stats = await runDiscoveryCycle(
      { ...deps, enqueue },
      { sweepCap: 16, perQuery: 6, maxIngest: enqueue ? 0 : 3 },
    );
    console.log(`discovery cron: ${JSON.stringify({ verified: stats.verified, rejected: stats.rejected.length, enqueued: stats.enqueued, newRecords: stats.newRecords, listsClassified: stats.listsClassified.length })}`);
  }
  // Queue-drain producer step (default OFF — QUEUE_DRAIN_ENABLED,
  // see db.ts): enqueue one bounded page of backfill candidates for
  // the candidate-mode consumer. Best-effort like the list refresh:
  // a producer failure never blocks the rest of the cron run.
  try {
    const step = await runQueueDrainProducerStep(env);
    if (step) console.log(`discovery cron queue-drain producer: ${JSON.stringify(step)}`);
  } catch (e) {
    console.log(`discovery cron queue-drain producer failed: ${(e as Error).message}`);
  }
  // Weekly list refresh (Mondays): re-mine known lists so new links
  // enter the funnel; bounded, best-effort, never blocks the cycle.
  if (new Date().getUTCDay() === 1) {
    try {
      const out = await refreshAllLists(
        { store: deps.store, fetchFn: defaultFetch, pacer: new Pacer(1200) },
        { limit: 8 },
      );
      console.log(`discovery cron list refresh: ${JSON.stringify({
        refreshed: out.refreshed,
        graduated: out.graduated,
        nominated: out.mines.reduce((a, m) => a + m.nominated, 0),
        created: out.mines.reduce((a, m) => a + m.created, 0),
      })}`);
    } catch (e) {
      console.log(`discovery cron list refresh failed: ${(e as Error).message}`);
    }
  }
  // DLQ + drain health log (drain hardening, 2026-11-11): the
  // daily cron is the one guaranteed daily observer — it logs DLQ
  // depth and the candidate backlog so a stall is visible in the
  // Worker logs even if nobody opens the admin endpoint. A
  // missing dlq_entries table (pre-migration DBs) degrades to no
  // log line, never a cron failure.
  try {
    const dlq = await deps.store.listDlqEntries();
    const counts = await deps.store.countSourcesByStatus();
    console.log(`discovery cron drain health: ${JSON.stringify({ dlqDepth: dlq.length, candidates: counts.candidate ?? 0 })}`);
  } catch { /* best-effort ops log */ }
  await embedCatalogBounded(env);
  // Stats rebuild (P0-1): one bounded page per daily cron run heals
  // drift; the bulk backfill runs through /admin/stats-rebuild.
  // Best-effort like the producer step above — a rebuild failure
  // never fails the cron run.
  try {
    const out = await handleAdminStatsRebuild(env, { limit: 500 });
    console.log(`discovery cron stats rebuild: ${JSON.stringify(out)}`);
  } catch (e) {
    console.log(`discovery cron stats rebuild failed: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Queue-based backfill drain (2026-11-11): CANDIDATE-mode messages.
//
// Until now the queue carried only VERIFIED sources (the daily cron
// verifies inline, capped at 16/run) and the ~20k-row candidate
// backlog was worked by a sandbox operator script over wrangler
// (scripts/backfill-drain.mjs) — a process every VM restart killed.
// The producer below (admin route + flag-gated cron step) now feeds
// candidates onto the same queue, and the consumer runs the drain's
// semantics per message:
//
//   verify → ingest, with the drain's list-classification heuristic
//   on the rejection path and its locator collapse (twin rows retire
//   when the canonical row reaches a terminal state).
//
// The one semantic upgrade the queue buys: failure CLASS decides
// the outcome. Deterministic failures (not-a-skill, repo gone,
// oversized-deterministic ingest errors) mark the source rejected
// with the reason in D1 and the message ACKs — no retry. Transient
// failures (network, GitHub 5xx, rate-limit, our own credential)
// THROW: Queues retries (max_retries 3) and then dead-letters to
// talents-ingest-dlq, and the source row stays a candidate the
// whole time, so a DLQ'd candidate is recoverable by re-enqueueing
// it — never silently rejected for an operator-side problem.
// ---------------------------------------------------------------------------

const REPO_KINDS: SourceRow["kind"][] = ["marketplace", "plugin-repo", "skill-repo"];

/** Deterministic ingest failures: the statement-size class the
 *  sandbox drain dead-letters on (the same matcher as
 *  src/discovery/wrangler-d1.ts's isOversizedStatementError, minus
 *  the FlushError case that only exists on the operator transport).
 *  The shared chunked store should make these impossible on the
 *  Worker path; the classification exists so that if one ever
 *  occurs, the candidate is dead-lettered in D1 instead of
 *  retry-looping on a write that can never succeed. */
export function isDeterministicIngestError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /statement too long|SQLITE_TOOBIG/i.test(msg);
}

/** Retire the OTHER rows for a locator (twins left behind when a
 *  provisional-kind nomination was later verified under a different
 *  kind) once the canonical row reaches a terminal state — the
 *  drain's locator collapse, per message. Terminal rows and the
 *  canonical row itself are never touched. */
async function retireCandidateTwins(
  store: DiscoveryStore,
  canonical: SourceRow,
  status: "stale" | "rejected",
  reason: string,
  at: string,
): Promise<void> {
  const rows = await store.listSourcesByLocator(canonical.locator);
  for (const row of rows) {
    if (row.kind === canonical.kind) continue;
    if (row.status !== "candidate" && row.status !== "verified") continue;
    await store.upsertSource({ ...row, status, reason, lastSeen: at });
  }
}

export interface CandidateOutcome {
  outcome: "ingested" | "rejected" | "list-mined" | "twin-stale";
  locator: string;
  kind: SourceRow["kind"];
  newRecords?: number;
}

/** Thrown when a redelivered duplicate (or a rival transport)
 *  finds the source already leased. The queue consumer throws it
 *  so Queues retries later — the lease holder is still working the
 *  row, and a retry after the TTL either wins the (now stale)
 *  lease or finds the row terminal. */
export class LeaseConflictError extends Error {
  constructor(locator: string) {
    super(`lease held for ${locator}`);
    this.name = "LeaseConflictError";
  }
}

/** Process one candidate source: the drain's per-candidate body.
 *  Returns the outcome for logging on terminal paths; throws on
 *  transient failure so the queue retries. */
async function processCandidateMessage(
  deps: {
    store: DiscoveryStore;
    registryKey: RegistryKey;
    fetchFn: FetchFn;
    pacer: Pacer;
    onNewRecords?: (records: SkillRecord[]) => Promise<void>;
    /** Lease holder id (queue message id, or "sandbox-drain").
     *  Defaults to `queue:<locator>`. */
    holder?: string;
  },
  source: SourceRow,
): Promise<CandidateOutcome> {
  const { store } = deps;
  const fetchFn = deps.fetchFn;
  const pacer = deps.pacer;
  const at = new Date().toISOString();
  let ready: SourceRow = source;

  // Rate-budget backpressure (drain hardening): if a recent
  // GitHub 403/429 recorded an exhausted-until timestamp that has
  // not passed yet, throw BEFORE any GitHub call — Queues retries
  // later instead of hammering a dead budget.
  await checkRateBudget(store);

  // Locator collapse (drain parity): another row for this locator
  // may already carry the outcome. An ingested twin ends this row
  // as stale; a verified twin is adopted as the ingest target so
  // the locator still progresses in this message.
  const byLocator = await store.getSourceByLocator(source.locator);
  if (byLocator && byLocator.kind !== source.kind) {
    if (byLocator.status === "ingested") {
      await store.upsertSource({
        ...source, status: "stale", lastSeen: at,
        reason: "twin row — locator already ingested under its verified kind",
      });
      return { outcome: "twin-stale", locator: source.locator, kind: source.kind };
    }
    if (byLocator.status === "verified") ready = byLocator;
  }

  // Processing lease (drain hardening): claim the row before any
  // GitHub work so a redelivered duplicate or the sandbox drain
  // skips it instead of verifying the same repo twice. The claim
  // is AFTER the collapse above (a no-op twin outcome needs no
  // lease) and BEFORE the first GitHub call in every branch below.
  // A lost claim throws LeaseConflictError → queue retry. The
  // lease is cleared on the terminal path by the caller
  // (handleQueueMessage), which also records the drain counter;
  // a thrown (transient) outcome leaves the lease to expire by
  // TTL so a redelivery inside the window does not duplicate the
  // in-flight work.
  const holder = deps.holder ?? `queue:${source.locator}`;
  const claimed = await store.tryClaimLease(source.kind, source.locator, holder, LEASE_TTL_MINUTES, new Date());
  if (!claimed) throw new LeaseConflictError(source.locator);

  if (ready === source && source.kind === "list") {
    // List claims classify first: mine, graduate, or reject — the
    // classification itself inspects the tree, so a claimed list
    // that actually carries skill files graduates to a verified
    // row and flows on to ingest below. A classifyAsList throw is
    // treated as TRANSIENT (propagates → queue retry) rather than
    // the drain's reject-fallback: retries + the DLQ keep the
    // candidate recoverable instead of dead-lettering it on what
    // may be a network failure.
    const outcome = await classifyAsList({ store, fetchFn, pacer }, source);
    if (outcome.isList) {
      await retireCandidateTwins(store, source, "stale", "twin row — locator resolved via its list row", at);
      return { outcome: "list-mined", locator: source.locator, kind: source.kind };
    }
    if (outcome.graduatedKind) {
      ready = {
        ...source, kind: outcome.graduatedKind, status: "verified",
        reason: `list claim discarded: ${outcome.reason}`,
      };
      await store.upsertSource(ready);
    } else {
      await store.upsertSource({ ...source, status: "rejected", reason: outcome.reason, lastSeen: at });
      await retireCandidateTwins(store, source, "stale", "twin row — locator resolved via its list row", at);
      return { outcome: "rejected", locator: source.locator, kind: source.kind };
    }
  } else if (ready === source && REPO_KINDS.includes(source.kind)) {
    const v = await verifyRepo(fetchFn, pacer, {
      locator: source.locator,
      url: source.url ?? `https://github.com/${source.locator}`,
      description: "",
      discoveredVia: source.discoveredVia,
      archived: false,
    });
    if (!v.ok || !v.kind) {
      if (v.failure === "transient") {
        throw new Error(`transient verify failure for ${source.locator}: ${v.reason}`);
      }
      // List heuristic: no skill files + link-dense markdown = a
      // curated list to mine, not a rejection (lists.ts).
      if (isNoSkillFilesReason(v.reason)) {
        let rescued = false;
        try {
          const outcome = await classifyAsList({ store, fetchFn, pacer }, source);
          if (outcome.isList) rescued = true;
        } catch { /* best-effort; rejection stands (drain parity) */ }
        if (rescued) {
          await retireCandidateTwins(store, source, "stale", "twin row — locator classified as a list source", at);
          return { outcome: "list-mined", locator: source.locator, kind: source.kind };
        }
      }
      await store.upsertSource({ ...source, status: "rejected", reason: v.reason, lastSeen: at });
      await retireCandidateTwins(store, source, "rejected", v.reason, at);
      return { outcome: "rejected", locator: source.locator, kind: source.kind };
    }
    ready = { ...source, kind: v.kind, status: "verified", reason: v.reason };
    await store.upsertSource(ready);
  }

  // Ingest: the verified row (repo kinds), the graduated row (list
  // claims), the adopted verified twin, or the candidate itself
  // (MCP/npm kinds verify inside ingest by refetch — drain parity).
  let res: Awaited<ReturnType<typeof ingestSource>>;
  try {
    res = await ingestSource(deps, ready);
  } catch (e) {
    if (isDeterministicIngestError(e)) {
      await store.upsertSource({
        ...ready, status: "rejected", lastSeen: at,
        reason: `ingest failed (deterministic): ${(e as Error).message.slice(0, 200)}`,
      });
      await retireCandidateTwins(store, source, "rejected", `twin of ${ready.locator}, rejected: deterministic ingest failure`, at);
      return { outcome: "rejected", locator: source.locator, kind: ready.kind };
    }
    throw e; // transient: Queues retries, then the DLQ — the row stays a candidate throughout
  }
  if (ready.kind !== source.kind) {
    await store.upsertSource({
      ...source, status: "stale", lastSeen: at,
      reason: `kind corrected at verification to ${ready.kind}; canonical row carries this locator`,
    });
  }
  await retireCandidateTwins(store, ready, "stale", "twin row — locator ingested via its canonical-kind row", at);
  return { outcome: "ingested", locator: source.locator, kind: ready.kind, newRecords: res.newRecords };
}

/** Queue consumer: ingest one source, then embed its new records.
 *  Messages for VERIFIED sources keep the original path exactly
 *  (cron sweep + webhook re-ingests); messages for CANDIDATE
 *  sources (the backfill producer) run verify → ingest in
 *  processCandidateMessage. `opts.pacer` exists for tests — the
 *  production consumer paces per message via queue concurrency,
 *  not an in-memory pacer. `opts.messageId` becomes the lease
 *  holder for candidate messages (drain hardening). */
export async function handleQueueMessage(
  env: Env,
  message: IngestQueueMessage,
  opts?: { pacer?: Pacer; messageId?: string },
): Promise<void> {
  const deps = workerDeps(env, async (records) => { await embedRecords(env, records); });
  if (!deps) throw new Error("TALENTS_REGISTRY_KEY secret not set — cannot ingest");
  const store = deps.store;
  let source: SourceRow | null = null;
  const kinds = message.kind ? [message.kind] : (["marketplace", "skill-repo", "plugin-repo", "list"] as SourceRow["kind"][]);
  for (const kind of kinds) {
    source = await store.getSource(kind, message.locator);
    if (source) break;
  }
  if (source?.kind === "list" && source.status !== "candidate") {
    // A push to a known list repo: re-mine it (new links enter the
    // funnel). Lists are never ingested — ingestSource would throw.
    // (CANDIDATE list claims are classified in processCandidateMessage
    // instead: classify → mine / graduate / reject.)
    await refreshListSource(
      { store, fetchFn: deps.fetchFn, pacer: new Pacer(1200) },
      source,
    );
    return;
  }
  if (!source) {
    // A webhook for a repo the pipeline has never verified: record it
    // as a candidate for the next sweep rather than ingesting blind.
    const at = new Date().toISOString();
    source = {
      kind: "skill-repo",
      locator: message.locator,
      url: `https://github.com/${message.locator}`,
      discoveredVia: message.via ?? "queue",
      status: "candidate",
      reason: "queued before verification (webhook for unknown repo)",
      firstSeen: at, lastSeen: at, lastIngested: null, recordCount: 0,
      provenance: [{ via: message.via ?? "queue", at }],
      priority: 0,
    };
    await store.upsertSource(source);
    return;
  }
  if (source.status === "rejected" || source.status === "watchlist" || source.status === "stale") return;
  if (source.status === "candidate") {
    const outcome = await processCandidateMessage(
      { ...deps, pacer: opts?.pacer ?? new Pacer(0), holder: opts?.messageId ? `queue:${opts.messageId}` : undefined },
      source,
    );
    console.log(`ingest queue candidate: ${JSON.stringify(outcome)}`);
    // Drain bookkeeping (hardening): one terminal completion per
    // candidate outcome — the stall detector watches this counter
    // and drain:last_terminal_at. The lease clears with the
    // terminal outcome; both writes are best-effort so a
    // bookkeeping failure never un-acks a completed message.
    try { await recordDrainTerminal(store); } catch { /* best-effort */ }
    try { await store.clearLease(source.kind, source.locator); } catch { /* lease expires by TTL */ }
    // No per-message stats call here: ingestSource maintains
    // record_stats incrementally for the records it writes (P0-1).
    return;
  }
  await ingestSource(deps, source);
}

// ---------------------------------------------------------------------------
// Queue-drain producer: feed backlog candidates to the ingest queue.
// One paging implementation behind both entry points — the
// ADMIN_TOKEN-gated route (operator-driven slices) and the
// QUEUE_DRAIN_ENABLED-gated cron step (steady state after cutover).
// ---------------------------------------------------------------------------

/** Page size for the scheduled producer step: one page per daily
 *  cron run while the flag is on. The consumer's max_concurrency
 *  (5) is the real rate governor — the math is in
 *  data/gate-queuedrain.txt — the producer only keeps it fed. */
export const QUEUE_DRAIN_PAGE_SIZE = 100;

/** The scheduled producer's switch (see QUEUE_DRAIN_ENABLED in
 *  db.ts). Default OFF: unset, empty, or anything but "1"/"true". */
export function queueDrainEnabled(env: Env): boolean {
  const v = (env.QUEUE_DRAIN_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export interface EnqueueCandidatesOutcome {
  enqueued: number;
  /** The exact (kind, locator) pairs enqueued, in page order — the
   *  slice driver tracks outcomes by these source ids. */
  items: { kind: SourceRow["kind"]; locator: string; priority: number }[];
  nextCursor: string | null;
  done: boolean;
}

export function encodeCandidateCursor(cursor: CandidateCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCandidateCursor(raw: string | null | undefined): CandidateCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as CandidateCursor;
    if (typeof parsed?.priority !== "number" || typeof parsed?.locator !== "string" || typeof parsed?.kind !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Enqueue ONE page of status='candidate' sources in
 *  verification-priority order. `via` distinguishes the entry
 *  point in the message (informational — the consumer keys off the
 *  sources row, not the message). `leaseCutoff` (ISO, optional)
 *  skips rows holding an active queue lease — the producer tick
 *  and the admin route both pass it, so neither nominates a
 *  source another transport is already processing. Every enqueue
 *  bumps the drain:enqueued counter (the stall detector's
 *  inflight math: enqueued − terminal − dlq-arrivals); the
 *  counter write is best-effort and never fails the enqueue. */
export async function enqueueCandidatePage(
  store: DiscoveryStore,
  queue: QueueLike,
  opts: { limit: number; cursor?: CandidateCursor | null; via: string; leaseCutoff?: string | null },
): Promise<EnqueueCandidatesOutcome> {
  const limit = Math.min(Math.max(Math.floor(opts.limit) || 1, 1), 500);
  const page = await store.listCandidatePage({ limit, cursor: opts.cursor ?? null, leaseCutoff: opts.leaseCutoff ?? null });
  const items: EnqueueCandidatesOutcome["items"] = [];
  for (const row of page.rows) {
    await queue.send({ locator: row.locator, kind: row.kind, via: opts.via } satisfies IngestQueueMessage);
    items.push({ kind: row.kind, locator: row.locator, priority: row.priority });
  }
  if (items.length > 0) {
    try { await bumpDrainCounter(store, "drain:enqueued", items.length); } catch { /* best-effort */ }
  }
  return {
    enqueued: items.length,
    items,
    nextCursor: page.nextCursor ? encodeCandidateCursor(page.nextCursor) : null,
    done: page.nextCursor === null,
  };
}

/** POST /admin/enqueue-candidates — one bounded page of the backlog
 *  onto the ingest queue (token-gated in index.ts, same contract as
 *  /admin/embed: `{ limit ≤ 500, cursor }` in, page + `nextCursor`
 *  / `done` out; the caller loops until done). Actively-leased
 *  rows are skipped (drain hardening) — the page may return fewer
 *  than `limit` rows while leases are held. */
export async function handleAdminEnqueueCandidates(env: Env, body: { limit?: number; cursor?: string }): Promise<unknown> {
  if (!env.INGEST_QUEUE) return { error: "INGEST_QUEUE binding not configured" };
  const cursor = decodeCandidateCursor(body.cursor);
  if (body.cursor && !cursor) return { error: "invalid cursor" };
  const leaseCutoff = new Date(Date.now() - LEASE_TTL_MINUTES * 60_000).toISOString();
  return enqueueCandidatePage(new D1DiscoveryStore(env.DB), env.INGEST_QUEUE, {
    limit: body.limit ?? 100,
    cursor,
    via: "backfill",
    leaseCutoff,
  });
}

/** True while a drain Workflow instance is live: the instance's
 *  init step stamps drain:workflow:active with its start time and
 *  its finish step clears it. The cron producers (daily trickle
 *  below + the dedicated tick) stand down while it is fresh so
 *  the Workflow is the ONLY feeder — the hardening gate's
 *  single-producer invariant. Stale after 24h so a crashed
 *  instance never blocks the tick forever. The key is the same
 *  literal as DRAIN_WORKFLOW_ACTIVE_KEY in drain-workflow-steps.ts
 *  (duplicated, not imported: that module imports this one). */
export async function drainWorkflowActive(store: DiscoveryStore): Promise<boolean> {
  const raw = await store.getSyncState("drain:workflow:active").catch(() => null);
  if (!raw) return false;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return false;
  return Date.now() - at < 24 * 60 * 60_000;
}

/** The scheduled producer step: when QUEUE_DRAIN_ENABLED is on,
 *  enqueue ONE bounded page of backlog candidates per cron run.
 *  Returns null when disabled or unconfigured — a no-op by design,
 *  so the step is safe to ship ahead of the cutover decision.
 *  Superseded for the drain by runDrainProducerTick (its own
 *  10-minute cron); kept for the daily cron's steady-state
 *  trickle after cutover. Stands down while a drain Workflow
 *  instance is live (drainWorkflowActive). */
export async function runQueueDrainProducerStep(env: Env): Promise<{ enqueued: number; done: boolean } | null> {
  if (!queueDrainEnabled(env) || !env.INGEST_QUEUE) return null;
  if (await drainWorkflowActive(new D1DiscoveryStore(env.DB))) return null;
  const leaseCutoff = new Date(Date.now() - LEASE_TTL_MINUTES * 60_000).toISOString();
  const out = await enqueueCandidatePage(new D1DiscoveryStore(env.DB), env.INGEST_QUEUE, {
    limit: QUEUE_DRAIN_PAGE_SIZE,
    cursor: null,
    via: "backfill-cron",
    leaseCutoff,
  });
  return { enqueued: out.enqueued, done: out.done };
}

// ---------------------------------------------------------------------------
// Drain hardening (2026-11-11, gate-harden-drain): producer pacing,
// DLQ observability + recovery, stall detection. All state lives in
// sync_state / dlq_entries (D1) — no KV dependency. The daily cron
// step above is the steady-state trickle; the dedicated producer
// below is the drain mechanism.
// ---------------------------------------------------------------------------

/** Dedicated producer cadence: every 10 minutes (its own cron
 *  trigger — see wrangler.deploy.jsonc). */
export const DRAIN_PRODUCER_CRON = "*/10 * * * *";
/** Max candidates enqueued per producer tick. */
export const PRODUCER_TICK_PAGE = 100;
/** Stop enqueueing while this many messages are inflight
 *  (enqueued − terminal − dlq-arrivals). At the measured
 *  ~880–1,000/hr mixed drain rate this is ~30–35 minutes of
 *  queue depth — deep enough to absorb a slow consumer hour,
 *  shallow enough that a stuck consumer cannot bury the queue. */
export const INFLIGHT_THRESHOLD = 500;
/** A tick's own single-producer lease (minutes): two concurrent
 *  ticks never double-enqueue the same page. Stale after 15 min
 *  so a crashed tick never blocks the next one. */
export const PRODUCER_LEASE_MINUTES = 15;
/** No candidate reaching a terminal state for this long (minutes)
 *  while candidates remain and messages are inflight = stalled. */
export const TERMINAL_STALL_MINUTES = 180;

/** Drain counters in sync_state (monotonic, never reset): */
export const DRAIN_COUNTER_KEYS = ["drain:enqueued", "drain:terminal", "drain:dlq"] as const;

export async function bumpDrainCounter(store: DiscoveryStore, key: string, by: number): Promise<number> {
  const raw = await store.getSyncState(key);
  const next = (raw ? Number(raw) || 0 : 0) + by;
  await store.setSyncState(key, String(next));
  return next;
}

export async function getDrainCounters(store: DiscoveryStore): Promise<{ enqueued: number; terminal: number; dlq: number }> {
  const read = async (key: string) => {
    const raw = await store.getSyncState(key);
    return raw ? Number(raw) || 0 : 0;
  };
  return {
    enqueued: await read("drain:enqueued"),
    terminal: await read("drain:terminal"),
    dlq: await read("drain:dlq"),
  };
}

/** One terminal candidate completion: bump the counter and stamp
 *  the last-terminal time the stall detector watches. */
export async function recordDrainTerminal(store: DiscoveryStore): Promise<void> {
  await bumpDrainCounter(store, "drain:terminal", 1);
  await store.setSyncState("drain:last_terminal_at", new Date().toISOString());
}

/** Classify a final-attempt queue error into the DLQ failure
 *  classes. Deterministic failures never reach the DLQ (they ack
 *  with a D1 rejection), so everything here is transient by
 *  construction; the class only says WHICH transient kind it was.
 *  Rate-budget exhaustion and lease conflicts are retried by the
 *  queue itself, not DLQ'd — they appear here only if a future
 *  path throws them on the final attempt. */
export function classifyDlqFailure(e: unknown): string {
  if (e instanceof RateBudgetExhaustedError) return "rate-limit";
  if (e instanceof LeaseConflictError) return "lease-conflict";
  const msg = e instanceof Error ? e.message : String(e);
  if (/rate limit|429|403/i.test(msg)) return "rate-limit";
  if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(msg)) return "network";
  if (/5\d\d|internal server error|service unavailable|bad gateway/i.test(msg)) return "server";
  return "unknown";
}

export interface DrainHealth {
  candidates: number;
  byStatus: Record<string, number>;
  enqueued: number;
  terminal: number;
  dlqArrivals: number;
  /** enqueued − terminal − dlqArrivals (≥ 0). */
  inflight: number;
  dlqDepth: number;
  lastTerminalAt: string | null;
  /** Minutes since the last terminal completion (null = none ever). */
  terminalAgeMin: number | null;
  rateExhaustedUntil: string | null;
  rateRemaining: number | null;
  producerEnabled: boolean;
  stalled: boolean;
  reasons: string[];
}

/** The drain's health snapshot — the stall detector's single
 *  source of truth, served by GET /admin/drain-health and used by
 *  the producer tick. A drain is stalled when any reason fires:
 *  a non-empty DLQ, no terminal completion in TERMINAL_STALL_MINUTES
 *  while candidates remain and messages are inflight, or the
 *  producer enabled but starving the queue (no inflight, no recent
 *  terminal, candidates waiting). */
export async function drainHealth(env: Env): Promise<DrainHealth> {
  const store = new D1DiscoveryStore(env.DB);
  const byStatus = await store.countSourcesByStatus();
  const candidates = byStatus.candidate ?? 0;
  const counters = await getDrainCounters(store);
  const inflight = Math.max(0, counters.enqueued - counters.terminal - counters.dlq);
  const dlqEntries = await store.listDlqEntries();
  const lastTerminalAt = await store.getSyncState("drain:last_terminal_at");
  const terminalAgeMin = lastTerminalAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(lastTerminalAt)) / 60_000))
    : null;
  const exhaustedUntil = await store.getSyncState("github_rate_exhausted_until");
  const rateExhausted = !!exhaustedUntil && Date.parse(exhaustedUntil) > Date.now();
  // Expired snapshots read as unknown (see readGithubRateSnapshot).
  const { remaining: rateRemaining } = await readGithubRateSnapshot(store);
  const reasons: string[] = [];
  if (dlqEntries.length > 0) reasons.push("dlq-nonempty");
  if (candidates > 0 && inflight > 0 && terminalAgeMin !== null && terminalAgeMin > TERMINAL_STALL_MINUTES) {
    reasons.push("no-terminal-3h");
  }
  if (
    candidates > 0 && inflight === 0 && queueDrainEnabled(env) && !rateExhausted
    && (terminalAgeMin === null || terminalAgeMin > 60)
  ) reasons.push("producer-starved");
  return {
    candidates,
    byStatus,
    enqueued: counters.enqueued,
    terminal: counters.terminal,
    dlqArrivals: counters.dlq,
    inflight,
    dlqDepth: dlqEntries.length,
    lastTerminalAt,
    terminalAgeMin,
    rateExhaustedUntil: rateExhausted ? exhaustedUntil : null,
    rateRemaining,
    producerEnabled: queueDrainEnabled(env),
    stalled: reasons.length > 0,
    reasons,
  };
}

export interface DrainProducerTickResult {
  skipped?: string;
  enqueued?: number;
  done?: boolean;
  inflight?: number;
  candidates?: number;
  dlqDepth?: number;
  stalled?: boolean;
  reasons?: string[];
  until?: string;
  remaining?: number | null;
}

/** The dedicated producer tick (every 10 min, own cron trigger):
 *  enqueue ONE bounded page of backlog candidates, paced by
 *  (a) queue depth — stop above INFLIGHT_THRESHOLD inflight,
 *  (b) the GitHub rate budget — halt while exhausted, cap the
 *      page by the remaining calls minus the reserve,
 *  (c) the QUEUE_DRAIN_ENABLED flag — off is a no-op.
 *  A single-producer lease (15 min) keeps concurrent ticks from
 *  double-enqueueing the same page. Returns null when disabled
 *  or unconfigured. */
export async function runDrainProducerTick(env: Env): Promise<DrainProducerTickResult | null> {
  if (!queueDrainEnabled(env) || !env.INGEST_QUEUE) return null;
  const store = new D1DiscoveryStore(env.DB);
  // A live drain Workflow instance is the only feeder (the
  // single-producer invariant): the tick stands down, and does
  // NOT take the producer lease, while it runs.
  if (await drainWorkflowActive(store)) return { skipped: "workflow-active" };
  const now = new Date();
  // Single-producer lease: stale after PRODUCER_LEASE_MINUTES so a
  // crashed tick never blocks the next one. The lease is a
  // sync_state timestamp, not a queue lease — it guards the tick,
  // not a source.
  const leaseRaw = await store.getSyncState("drain:producer_lease");
  if (leaseRaw) {
    const leasedAt = Date.parse(leaseRaw);
    if (!Number.isNaN(leasedAt) && now.getTime() - leasedAt < PRODUCER_LEASE_MINUTES * 60_000) {
      return { skipped: "producer-lease-held" };
    }
  }
  await store.setSyncState("drain:producer_lease", now.toISOString());
  try {
    return await runDrainProducerTickInner(env, store, now);
  } finally {
    // Release promptly: the next tick re-claims; a crash leaves a
    // stale lease the next tick reclaims after 15 min.
    await store.setSyncState("drain:producer_lease", "").catch(() => {});
  }
}

async function runDrainProducerTickInner(
  env: Env,
  store: DiscoveryStore,
  now: Date,
): Promise<DrainProducerTickResult> {
  // (b) Rate budget first: an exhausted budget halts the tick
  // before it spends any queue depth on messages the consumer
  // would throw-to-retry.
  const exhaustedUntil = await store.getSyncState("github_rate_exhausted_until");
  if (exhaustedUntil && Date.parse(exhaustedUntil) > now.getTime()) {
    return { skipped: "rate-budget-exhausted", until: exhaustedUntil };
  }
  // Expired snapshots read as unknown (see readGithubRateSnapshot).
  const { remaining } = await readGithubRateSnapshot(store, now);
  if (remaining !== null && remaining < RATE_BUDGET_RESERVE_CALLS) {
    return { skipped: "rate-budget-low", remaining };
  }

  const health = await drainHealth(env);
  if (health.candidates === 0) {
    return {
      enqueued: 0, done: true, inflight: health.inflight, candidates: 0,
      dlqDepth: health.dlqDepth, stalled: health.stalled, reasons: health.reasons,
    };
  }
  // (a) Queue depth: stop above the inflight threshold.
  const headroom = INFLIGHT_THRESHOLD - health.inflight;
  if (headroom <= 0) {
    return {
      skipped: "queue-depth", inflight: health.inflight, candidates: health.candidates,
      dlqDepth: health.dlqDepth, stalled: health.stalled, reasons: health.reasons,
    };
  }
  let page = Math.min(PRODUCER_TICK_PAGE, headroom);
  if (remaining !== null) {
    // ≤8 GitHub calls per candidate worst case (3 typical): the
    // page must fit the remaining budget minus the reserve.
    page = Math.min(page, Math.max(0, Math.floor((remaining - RATE_BUDGET_RESERVE_CALLS) / 8)));
  }
  if (page <= 0) return { skipped: "rate-budget-low", remaining, inflight: health.inflight, candidates: health.candidates };

  const leaseCutoff = new Date(now.getTime() - LEASE_TTL_MINUTES * 60_000).toISOString();
  const out = await enqueueCandidatePage(store, env.INGEST_QUEUE!, {
    limit: page,
    cursor: null,
    via: "backfill-producer",
    leaseCutoff,
  });
  const after = await drainHealth(env);
  const result: DrainProducerTickResult = {
    enqueued: out.enqueued,
    done: out.done,
    inflight: after.inflight,
    candidates: after.candidates,
    dlqDepth: after.dlqDepth,
    stalled: after.stalled,
    reasons: after.reasons,
  };
  console.log(`drain producer tick: ${JSON.stringify(result)}`);
  if (after.stalled) console.log(`drain producer STALL: ${JSON.stringify(after)}`);
  return result;
}

export interface DlqSweepResult {
  dlqDepth: number;
  entries: DlqEntry[];
  /** Recoverable entries re-enqueued this call (source still
   *  candidate + failure class transient). */
  reenqueued: { kind: SourceRow["kind"]; locator: string }[];
  /** Entries left for operator review (source no longer a
   *  candidate, or a failure class the sweep does not trust). */
  needsReview: { kind: SourceRow["kind"]; locator: string; failureClass: string; reason: string }[];
  skippedCap: number;
}

const DLQ_SWEEP_RECOVERABLE = new Set(["rate-limit", "network", "server", "unknown"]);

/** POST /admin/dlq-sweep — DLQ observability + recovery
 *  (token-gated in index.ts). Reports the DLQ depth and every
 *  entry's failure class, and re-enqueues recoverable ones (the
 *  source is still a candidate AND the failure class is
 *  transient) up to `limit` (default 25, max 100). Deterministic
 *  or orphaned entries are left for operator review, never
 *  deleted: nothing auto-deletes from the DLQ. A re-enqueued
 *  entry's manifest row and the source's lease are cleared, so
 *  the consumer sees a clean candidate. */
export async function sweepDlq(env: Env, body: { limit?: number }): Promise<DlqSweepResult> {
  const store = new D1DiscoveryStore(env.DB);
  const limit = Math.min(Math.max(Math.floor(body.limit ?? 25) || 1, 1), 100);
  const entries = await store.listDlqEntries();
  const reenqueued: DlqSweepResult["reenqueued"] = [];
  const needsReview: DlqSweepResult["needsReview"] = [];
  let skippedCap = 0;
  for (const entry of entries) {
    if (!DLQ_SWEEP_RECOVERABLE.has(entry.failureClass)) {
      needsReview.push({ kind: entry.kind, locator: entry.locator, failureClass: entry.failureClass, reason: "failure class is not transient" });
      continue;
    }
    const source = await store.getSource(entry.kind, entry.locator);
    if (!source || source.status !== "candidate") {
      needsReview.push({
        kind: entry.kind,
        locator: entry.locator,
        failureClass: entry.failureClass,
        reason: !source ? "source row gone" : `source is ${source.status}, not a candidate`,
      });
      continue;
    }
    if (reenqueued.length >= limit) {
      skippedCap++;
      continue;
    }
    if (!env.INGEST_QUEUE) {
      needsReview.push({ kind: entry.kind, locator: entry.locator, failureClass: entry.failureClass, reason: "INGEST_QUEUE binding not configured" });
      continue;
    }
    await env.INGEST_QUEUE.send({ locator: entry.locator, kind: entry.kind, via: "dlq-sweep" } satisfies IngestQueueMessage);
    try { await bumpDrainCounter(store, "drain:enqueued", 1); } catch { /* best-effort */ }
    await store.deleteDlqEntry(entry.kind, entry.locator);
    await store.clearLease(entry.kind, entry.locator);
    reenqueued.push({ kind: entry.kind, locator: entry.locator });
  }
  return { dlqDepth: entries.length, entries, reenqueued, needsReview, skippedCap };
}

/** GET /admin/drain-health — the stall detector's snapshot
 *  (token-gated in index.ts). */
export async function handleAdminDrainHealth(env: Env): Promise<unknown> {
  return drainHealth(env);
}

/** POST /admin/discover — one inline cycle (token-gated). */
export async function handleAdminDiscover(env: Env, body: { sweepCap?: number; perQuery?: number; maxIngest?: number }): Promise<unknown> {
  const deps = workerDeps(env, async (records) => { await embedRecords(env, records); });
  if (!deps) return { error: "TALENTS_REGISTRY_KEY secret not set — Worker-side ingest disabled; use the talents discover CLI" };
  const stats = await runDiscoveryCycle(deps, {
    sweepCap: Math.min(body.sweepCap ?? 16, 32),
    perQuery: Math.min(body.perQuery ?? 6, 10),
    maxIngest: Math.min(body.maxIngest ?? 3, 5),
  });
  return stats;
}

/**
 * POST /admin/embed — index stale record embeddings, ONE bounded
 * page per call (token-gated). Body: `{ limit?, cursor? }` — limit
 * is the page size (default 100, max 500), cursor is the previous
 * page's `nextCursor`. The response is the page stats plus
 * `nextCursor` / `done`; operators loop until done
 * (scripts/backfill-embed.mjs).
 *
 * This replaces the original all-records scan, which loaded every
 * listed record into a single invocation before embedding any: past
 * a few thousand records the call hung and 500'd under D1 import
 * contention, leaving Vectorize covering a minority of the catalog
 * (data/gate-backfill.txt). A no-body call now processes just the
 * first bounded page — safe by default, never a full-catalog scan.
 */
export async function handleAdminEmbed(env: Env, body: { limit?: number; cursor?: string }): Promise<unknown> {
  const stack = vectorStack(env);
  if (!stack) return { error: "AI/VECTORIZE bindings not configured" };
  const store = new D1DiscoveryStore(env.DB);
  return indexStaleRecordsPage(
    store,
    stack.embedder,
    stack.index,
    (cursor, limit) => recordsPage(env.DB, cursor, limit),
    {
      limit: body.limit,
      cursor: body.cursor ?? null,
      // Enrichment (Tranche 1): records whose B/C layers produced
      // names embed with those names included, so a record whose
      // enrichment lands after its first embedding goes stale and
      // is re-embedded by this same paged route.
      extraTextFor: (records) => extrasForIds(env.DB, records.map((r) => r.id)),
    },
  );
}

/**
 * POST /admin/stats-rebuild — recompute record_stats for ONE bounded
 * page of listed records (token-gated). Body: `{ limit?, cursor? }`
 * — limit is the page size (default 500, max 500), cursor is the
 * previous page's `nextCursor`. The response is the page stats plus
 * `nextCursor` / `done` and the current coverage counts; operators
 * loop until done. This is the heal path for the 44% of records
 * whose stats rows the old full-catalog refresh never wrote
 * (P0-1): the daily cron runs one page per day, and the bulk
 * backfill is an operator loop over this route.
 */
export async function handleAdminStatsRebuild(env: Env, body: { limit?: number; cursor?: string }): Promise<unknown> {
  const store = new D1DiscoveryStore(env.DB);
  const out = await store.rebuildStatsPage(body.limit ?? 500, body.cursor ?? null, new Date());
  const listed = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE status = 'listed'").first<{ n: number }>();
  const statsRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM record_stats").first<{ n: number }>();
  return { ...out, statsRows: statsRows?.n ?? 0, listed: listed?.n ?? 0 };
}

/** Constant-time-ish admin token check. */
export function adminAuthorized(env: Env, req: Request): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const presented = req.headers.get("x-talents-admin") ?? "";
  if (presented.length !== env.ADMIN_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ env.ADMIN_TOKEN.charCodeAt(i);
  return diff === 0;
}
