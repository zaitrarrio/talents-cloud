// Semantic layer (P5, ARCHITECTURE-v2 §7): embeddings + vector
// neighbours for hybrid search and related-skills.
//
// Provider choice (documented): the LLM provider is Anthropic, but
// Anthropic has NO embeddings API — so embeddings use Workers AI
// (@cf/baai/bge-base-en-v1.5, 768-dim), the Cloudflare-native option
// on the decided stack, with vectors in Vectorize. The code speaks
// to narrow interfaces (Embedder / VectorIndex) so the Worker binds
// the real services while tests and the local gate drive a
// deterministic hash stub — clearly labelled, never presented as a
// real model.

import type { SkillRecord } from "../types.js";
import { flattenComponents, toSearchDocument } from "../search.js";
import type { DiscoveryStore } from "./store.js";

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const VECTOR_DIMENSIONS = 768;

/**
 * The text that represents a record in vector space. `extra` is the
 * enrichment-derived names string (sub-inventory entries +
 * introspected tool names, class: derived — see
 * enrichment/store.ts searchExtrasOf): when present it joins the
 * document so the semantic layer sees the same derived text as the
 * keyword layer. Callers without enrichment context omit it and get
 * exactly the pre-enrichment text (and hash), so nothing re-embeds
 * spuriously.
 */
export function embeddingText(record: SkillRecord, extra?: string): string {
  const doc = toSearchDocument(record);
  const parts = [
    `${record.owner}/${record.name}`,
    record.description ?? "",
    `Kind: ${record.kind}. Components: ${flattenComponents(record).join(", ")}.`,
    doc.declarationText,
    ...(extra ? [`Contains: ${extra}`] : []),
  ];
  return parts.filter(Boolean).join("\n").slice(0, 4000);
}

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorIndex {
  upsert(vectors: { id: string; values: number[] }[]): Promise<void>;
  query(vector: number[], topK: number): Promise<{ id: string; score: number }[]>;
}

// ---------------------------------------------------------------------------
// Real bindings (Cloudflare)
// ---------------------------------------------------------------------------

/** Workers AI binding shape (env.AI). */
export interface WorkersAIBinding {
  run(model: string, input: { text: string[] }): Promise<{ data?: number[][]; shape?: number[] }>;
}

export class WorkersAIEmbedder implements Embedder {
  readonly model: string = EMBEDDING_MODEL;
  constructor(private ai: WorkersAIBinding, model?: string) {
    if (model) this.model = model;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    // bge models cap batch size; 20 is safely under every limit.
    for (let i = 0; i < texts.length; i += 20) {
      const batch = texts.slice(i, i + 20);
      const res = await this.ai.run(this.model, { text: batch });
      const data = res.data ?? [];
      if (data.length !== batch.length) {
        throw new Error(`Workers AI embedding returned ${data.length} vectors for ${batch.length} texts`);
      }
      out.push(...data);
    }
    return out;
  }
}

/** Vectorize binding shape (env.VECTORIZE). */
export interface VectorizeBinding {
  upsert(vectors: { id: string; values: number[] }[]): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number },
  ): Promise<{ matches: { id: string; score: number }[] }>;
}

export class VectorizeIndex implements VectorIndex {
  constructor(private index: VectorizeBinding) {}
  async upsert(vectors: { id: string; values: number[] }[]): Promise<void> {
    for (let i = 0; i < vectors.length; i += 100) {
      await this.index.upsert(vectors.slice(i, i + 100));
    }
  }
  async query(vector: number[], topK: number): Promise<{ id: string; score: number }[]> {
    const res = await this.index.query(vector, { topK });
    return (res.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
  }
}

// ---------------------------------------------------------------------------
// Local stub (tests + offline gate ONLY — not a model)
// ---------------------------------------------------------------------------

/**
 * Deterministic token-hash embedder: 128-dim bag-of-hashed-tokens
 * vectors, L2-normalized. Shares vocabulary → shares direction, so
 * the hybrid merge and related-skills logic can be genuinely
 * exercised offline. It has NO learned semantics — the live gate
 * uses the real Workers AI model; this stub exists so the code paths
 * are testable without an account binding.
 */
export class HashStubEmbedder implements Embedder {
  readonly model = "stub:hash-tokens-128";
  readonly dims = 128;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }
  one(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    for (const tok of text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      v[Math.abs(h) % this.dims] += 1;
      v[Math.abs(h >> 8) % this.dims] += 0.5;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

export class InMemoryVectorIndex implements VectorIndex {
  private vectors = new Map<string, number[]>();
  async upsert(vectors: { id: string; values: number[] }[]): Promise<void> {
    for (const v of vectors) this.vectors.set(v.id, v.values);
  }
  async query(vector: number[], topK: number): Promise<{ id: string; score: number }[]> {
    const scored = [...this.vectors.entries()].map(([id, values]) => {
      let dot = 0;
      const n = Math.min(values.length, vector.length);
      for (let i = 0; i < n; i++) dot += values[i] * vector[i];
      return { id, score: dot };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }
  get size(): number {
    return this.vectors.size;
  }
}

// ---------------------------------------------------------------------------
// Indexer: embed whatever is missing or stale
// ---------------------------------------------------------------------------

export async function textHash(text: string): Promise<string> {
  try {
    const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
    if (subtle) {
      const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch { /* fall through to FNV */ }
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv:${(h >>> 0).toString(16)}`;
}

export interface IndexStats {
  considered: number;
  embedded: number;
  skippedFresh: number;
}

/**
 * The id a record's vector carries in the index. Vectorize caps ids
 * at 64 bytes and some owner/name ids are longer, so vectors are
 * keyed by the sha256 hex of the record id (exactly 64 chars). The
 * mapping back lives in embedding_meta.vector_id (store.vectorIdMap).
 */
export async function vectorIdFor(recordId: string): Promise<string> {
  return textHash(recordId);
}

/**
 * Embed records whose stored text hash differs from the current
 * embedding text (or that were embedded by a different model), and
 * upsert their vectors. Bounded by `limit` per run so cron/admin
 * invocations stay inside Worker CPU budgets.
 */
export async function indexStaleRecords(
  store: DiscoveryStore,
  embedder: Embedder,
  index: VectorIndex,
  records: SkillRecord[],
  opts: { limit?: number; now?: Date; extraText?: Map<string, string> } = {},
): Promise<IndexStats> {
  const limit = opts.limit ?? 50;
  const now = opts.now ?? new Date();
  const stale: { record: SkillRecord; text: string; hash: string }[] = [];
  let fresh = 0;
  for (const record of records) {
    const text = embeddingText(record, opts.extraText?.get(record.id));
    const hash = await textHash(text);
    const meta = await store.getEmbeddingMeta(record.id);
    if (meta && meta.textHash === hash && meta.model === embedder.model) {
      fresh++;
      continue;
    }
    if (stale.length < limit) stale.push({ record, text, hash });
  }
  if (stale.length) {
    const vectors = await embedder.embed(stale.map((s) => s.text));
    const vectorIds = await Promise.all(stale.map((s) => vectorIdFor(s.record.id)));
    await index.upsert(stale.map((s, i) => ({ id: vectorIds[i], values: vectors[i] })));
    for (const [i, s] of stale.entries()) {
      await store.setEmbeddingMeta(s.record.id, s.hash, embedder.model, now.toISOString(), vectorIds[i]);
    }
  }
  return { considered: records.length, embedded: stale.length, skippedFresh: fresh };
}

// ---------------------------------------------------------------------------
// Paged indexer: one bounded page per invocation
// ---------------------------------------------------------------------------

/** Default page size for paged embedding (records considered per call). */
export const DEFAULT_EMBED_PAGE = 100;
/** Hard cap on the page size — one call must stay inside Worker CPU /
 *  subrequest budgets even when every record on the page is stale. */
export const MAX_EMBED_PAGE = 500;

export interface EmbedPageRequest {
  /** Records to consider in this page (clamped to 1..MAX_EMBED_PAGE). */
  limit?: number;
  /** Resume token from a previous page's `nextCursor`: only records
   *  with id strictly greater than the cursor are considered. Null /
   *  absent starts from the beginning (a fresh sweep). */
  cursor?: string | null;
}

export interface EmbedPageStats extends IndexStats {
  /** Pass back as `cursor` to continue the sweep; null when `done`. */
  nextCursor: string | null;
  /** True when the sweep is exhausted (the page came back short or
   *  empty). A caller wanting full coverage loops until done, then
   *  may sweep once more from a null cursor for records that arrived
   *  mid-sweep with ids behind the cursor. */
  done: boolean;
}

/**
 * Fetches one page of records to consider for embedding: ordered by
 * record id ascending, strictly after `cursor` (null = first page).
 */
export type EmbedPageFetcher = (cursor: string | null, limit: number) => Promise<SkillRecord[]>;

/**
 * Embed one bounded page of stale records. Why paging exists: the
 * pre-paging /admin/embed loaded EVERY listed record into one Worker
 * invocation before embedding any of them; once the catalog passed a
 * few thousand records that call hung / 500'd (see
 * data/gate-backfill.txt), leaving the Vectorize layer covering only
 * a minority of the catalog. A page loads at most `limit` records,
 * embeds the stale subset via indexStaleRecords (same text-hash +
 * model staleness rule), and returns a cursor. embedding_meta is the
 * checkpoint: a failed page is simply retried — records it managed
 * to embed before the failure come back fresh and are skipped.
 */
export async function indexStaleRecordsPage(
  store: DiscoveryStore,
  embedder: Embedder,
  index: VectorIndex,
  fetchPage: EmbedPageFetcher,
  opts: EmbedPageRequest & {
    now?: Date;
    /** Enrichment extras resolver (sub-inventory / tool names per
     *  record id): records whose enrichment produced names embed
     *  with them; everyone else keeps the bare-record text. */
    extraTextFor?: (records: SkillRecord[]) => Promise<Map<string, string>>;
  } = {},
): Promise<EmbedPageStats> {
  const raw = Math.floor(opts.limit ?? DEFAULT_EMBED_PAGE);
  const limit = Math.max(1, Math.min(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EMBED_PAGE, MAX_EMBED_PAGE));
  const cursor = opts.cursor ?? null;
  const records = await fetchPage(cursor, limit);
  const extraText = opts.extraTextFor ? await opts.extraTextFor(records) : undefined;
  const stats = await indexStaleRecords(store, embedder, index, records, { limit, now: opts.now, extraText });
  const done = records.length < limit;
  const nextCursor = done ? null : records[records.length - 1].id;
  return { ...stats, nextCursor, done };
}
