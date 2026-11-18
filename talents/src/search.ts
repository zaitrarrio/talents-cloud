// Search (P1) — ARCHITECTURE-v2 §7: Typesense is the specified engine
// (typo-tolerance, faceting, hybrid ranking). This module exposes ONE
// interface with two implementations:
//
//   - TypesenseSearchEngine — drives a real Typesense server over HTTP.
//   - LocalSearchEngine — dependency-free in-memory fallback behind the
//     same interface, used ONLY when no Typesense server answers its
//     health endpoint (openSearchEngine says which one it picked; the
//     fallback is never silent).
//
// Ranking: the engine returns keyword candidates; a documented re-rank
// pass (rerank) then applies, in order: exact name match → attested →
// fewer validation warnings. Behavioral signals (30-day retention,
// review velocity, publisher trust) and vector/semantic hybrid ranking
// land with the discovery-depth phase (P5, ARCHITECTURE-v2 §9) — P1 has
// no behavioral data to rank on, so it does not fake any.

import type { SkillRecord, DeclarationLine } from "./types.js";
import { normalizeComponents } from "./validate.js";

/** Clearly-labelled LOCAL DEV default — not a credential. Production sets
 *  TALENTS_TYPESENSE_KEY in the environment. */
export const DEV_TYPESENSE_KEY = "talents-dev-key-p1";
export const DEFAULT_TYPESENSE_URL = "http://127.0.0.1:8108";
export const COLLECTION = "skills";

export interface TypesenseConfig {
  url: string;
  apiKey: string;
}

export function typesenseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TypesenseConfig {
  return {
    url: env.TALENTS_TYPESENSE_URL ?? DEFAULT_TYPESENSE_URL,
    apiKey: env.TALENTS_TYPESENSE_KEY ?? DEV_TYPESENSE_KEY,
  };
}

export interface SearchQueryInput {
  q: string;
  kind?: string;
  owner?: string;
  limit?: number;
}

export interface SearchEngine {
  readonly name: "typesense" | "local";
  healthy(): Promise<boolean>;
  count(): Promise<number>;
  /** (Re)build the index from scratch over these records. Returns doc count. */
  indexAll(records: SkillRecord[]): Promise<number>;
  search(input: SearchQueryInput): Promise<SkillRecord[]>;
}

/** The Typesense document shape — one per record (ARCHITECTURE-v2 §9 P1). */
export interface SearchDocument {
  id: string;
  owner: string;
  name: string;
  kind: string;
  description: string;
  components: string[];
  declarationText: string;
  sourceRepo: string;
  status: string;
}

export function flattenComponents(r: SkillRecord): string[] {
  // Normalize first: a legacy record whose components carry a bare
  // string would otherwise spread into per-character search tokens
  // (this feeds the D1 store's search_text/FTS write path).
  const c = normalizeComponents(r.components);
  return [
    ...c.skills,
    ...c.commands,
    ...c.agents,
    ...c.mcpServers,
    ...(c.hooks ? ["hooks"] : []),
  ];
}

export function toSearchDocument(r: SkillRecord): SearchDocument {
  const arr = <T,>(v: T[] | unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    kind: r.kind,
    description: r.description ?? "",
    components: flattenComponents(r),
    declarationText: [
      ...arr<string>(r.declaration?.summary),
      ...arr<DeclarationLine>(r.declaration?.lines).map((l) => l.text),
      ...arr<string>(r.declaration?.undeclared).map((u) => `undeclared: ${u}`),
    ].join(" "),
    sourceRepo: r.sourceRepo ?? "",
    status: r.status,
  };
}

export function warningCount(r: SkillRecord): number {
  const issues = r.validation?.issues;
  return Array.isArray(issues) ? issues.filter((i) => i.severity === "warning").length : 0;
}

/**
 * Token normalization (search-fix, 2026-11-10): singularize a trailing
 * "s" on tokens of length ≥ 4 that do not end in "ss" (games → game,
 * skills → skill; class/business/access are untouched). Trigram FTS
 * matching is substring-based, so a normalized query token matches both
 * the singular and plural forms in indexed text; engines that compare
 * whole tokens (the local fallback) apply the same normalization to
 * indexed tokens, keeping both directions equivalent everywhere.
 * Deliberately a light heuristic, not a stemmer — documented as such.
 */
export function normalizeToken(t: string): string {
  if (t.length >= 4 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** The per-record score of the P1 re-rank, factored out so the D1
 *  engine can use it as one key in its multi-key sort (search-d1.ts). */
export function rerankScore(r: SkillRecord, q: string): number {
  const needle = q.trim().toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);
  let s = 0;
  if (needle) {
    const name = r.name.toLowerCase();
    if (name === needle) s += 100;
    else if (name.includes(needle)) s += 40;
    else if (tokens.some((t) => t.length > 1 && name.includes(t))) s += 15;
  }
  if (r.attestation) s += 10;
  s -= warningCount(r) * 2;
  return s;
}

/**
 * P1 re-rank (documented): exact name match boost → records with an
 * attestation → fewer validation warnings. Engine order breaks remaining
 * ties (stable sort), so the engine's keyword relevance still matters.
 */
export function rerank(records: SkillRecord[], q: string, limit = 20): SkillRecord[] {
  const scored = records.map((r, idx) => ({ r, s: rerankScore(r, q), idx }));
  scored.sort((a, b) => b.s - a.s || a.idx - b.idx);
  return scored.slice(0, limit).map((x) => x.r);
}

// ---------------------------------------------------------------------------
// Typesense over HTTP
// ---------------------------------------------------------------------------

const COLLECTION_SCHEMA = {
  name: COLLECTION,
  fields: [
    { name: "id", type: "string" },
    { name: "owner", type: "string", facet: true },
    { name: "name", type: "string" },
    { name: "kind", type: "string", facet: true },
    { name: "description", type: "string" },
    { name: "components", type: "string[]" },
    { name: "declarationText", type: "string" },
    { name: "sourceRepo", type: "string" },
    { name: "status", type: "string", facet: true },
  ],
};

interface TsHit { document: SearchDocument }
interface TsSearchResponse { hits?: TsHit[]; found?: number }

export class TypesenseSearchEngine implements SearchEngine {
  readonly name = "typesense" as const;
  private byId: Map<string, SkillRecord>;

  constructor(private cfg: TypesenseConfig, records: SkillRecord[] = []) {
    this.byId = new Map(records.map((r) => [r.id, r]));
  }

  /** Keep the id→record map current (serve passes the full record set). */
  setRecords(records: SkillRecord[]): void {
    this.byId = new Map(records.map((r) => [r.id, r]));
  }

  private async call(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.cfg.url}${path}`, {
      ...init,
      headers: { "X-TYPESENSE-API-KEY": this.cfg.apiKey, ...(init?.headers ?? {}) },
    });
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.url}/health`);
      if (!res.ok) return false;
      const j = (await res.json()) as { ok?: boolean };
      return j.ok === true;
    } catch {
      return false;
    }
  }

  async count(): Promise<number> {
    const res = await this.call(`/collections/${COLLECTION}`);
    if (!res.ok) return 0;
    const j = (await res.json()) as { num_documents?: number };
    return j.num_documents ?? 0;
  }

  async indexAll(records: SkillRecord[]): Promise<number> {
    this.setRecords(records);
    // P1 scale is tiny: drop + recreate keeps the index exactly in step
    // with the registry file (no stale documents from earlier ingests).
    await this.call(`/collections/${COLLECTION}`, { method: "DELETE" }).catch(() => undefined);
    const create = await this.call(`/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(COLLECTION_SCHEMA),
    });
    if (!create.ok) throw new Error(`typesense: create collection failed (${create.status}): ${await create.text()}`);
    if (records.length === 0) return 0;
    const ndjson = records.map((r) => JSON.stringify(toSearchDocument(r))).join("\n");
    const imp = await this.call(`/collections/${COLLECTION}/documents/import?action=upsert`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: ndjson,
    });
    if (!imp.ok) throw new Error(`typesense: import failed (${imp.status}): ${await imp.text()}`);
    const lines = (await imp.text()).trim().split("\n").map((l) => JSON.parse(l) as { success?: boolean; error?: string });
    const failed = lines.filter((l) => !l.success);
    if (failed.length) throw new Error(`typesense: ${failed.length} documents failed to import: ${failed[0].error ?? "unknown"}`);
    return lines.length;
  }

  async search(input: SearchQueryInput): Promise<SkillRecord[]> {
    const filters: string[] = ["status:=listed"];
    if (input.kind) filters.push(`kind:=${input.kind}`);
    if (input.owner) filters.push(`owner:=${input.owner}`);
    const params = new URLSearchParams({
      q: input.q.trim() === "" ? "*" : input.q,
      query_by: "name,description,components,declarationText",
      query_by_weights: "5,2,3,1",
      per_page: "50",
      filter_by: filters.join("&&"),
    });
    const res = await this.call(`/collections/${COLLECTION}/documents/search?${params}`);
    if (!res.ok) throw new Error(`typesense: search failed (${res.status}): ${await res.text()}`);
    const j = (await res.json()) as TsSearchResponse;
    const found = (j.hits ?? [])
      .map((h) => this.byId.get(h.document.id))
      .filter((r): r is SkillRecord => r !== undefined);
    return rerank(found, input.q, input.limit ?? 20);
  }
}

// ---------------------------------------------------------------------------
// Local fallback engine (same interface; used only when Typesense is down)
// ---------------------------------------------------------------------------

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(normalizeToken);
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

interface IndexedDoc {
  record: SkillRecord;
  fields: { tokens: string[]; weight: number }[];
}

export class LocalSearchEngine implements SearchEngine {
  readonly name = "local" as const;
  private docs: IndexedDoc[] = [];

  async healthy(): Promise<boolean> {
    return true;
  }

  async count(): Promise<number> {
    return this.docs.length;
  }

  async indexAll(records: SkillRecord[]): Promise<number> {
    this.docs = records
      .filter((r) => r.status === "listed")
      .map((r) => {
        const d = toSearchDocument(r);
        return {
          record: r,
          fields: [
            { tokens: tokenize(d.name), weight: 5 },
            { tokens: tokenize(d.components.join(" ")), weight: 3 },
            { tokens: tokenize(d.description), weight: 2 },
            { tokens: tokenize(d.declarationText), weight: 1 },
          ],
        };
      });
    return this.docs.length;
  }

  async search(input: SearchQueryInput): Promise<SkillRecord[]> {
    const qTokens = tokenize(input.q);
    const scored: { r: SkillRecord; s: number; idx: number }[] = [];
    this.docs.forEach((doc, idx) => {
      if (input.kind && doc.record.kind !== input.kind) return;
      if (input.owner && doc.record.owner !== input.owner) return;
      if (qTokens.length === 0) {
        scored.push({ r: doc.record, s: 1, idx });
        return;
      }
      let s = 0;
      for (const qt of qTokens) {
        for (const f of doc.fields) {
          for (const t of f.tokens) {
            if (t === qt) s += f.weight;
            else if (qt.length >= 3 && t.startsWith(qt)) s += f.weight * 0.6;
            // Distance-1 typo tolerance. Doc tokens of length 3 are
            // included ("pdff" ~ "pdf"): normalization turns indexed
            // "pdfs" into "pdf", so the 3-char form is the one a typo
            // must be able to reach (mirrors the D1 broadening pass).
            else if (qt.length >= 4 && t.length >= 3 && levenshtein(qt, t) <= 1) s += f.weight * 0.5;
          }
        }
      }
      if (s > 0) scored.push({ r: doc.record, s, idx });
    });
    scored.sort((a, b) => b.s - a.s || a.idx - b.idx);
    return rerank(scored.map((x) => x.r), input.q, input.limit ?? 20);
  }
}

// ---------------------------------------------------------------------------
// Engine selection — Typesense when it answers, local fallback otherwise.
// The caller MUST surface engine.name (CLI + serve log + README do).
// ---------------------------------------------------------------------------

export async function openSearchEngine(records: SkillRecord[], cfg: TypesenseConfig): Promise<SearchEngine> {
  const ts = new TypesenseSearchEngine(cfg, records);
  if (await ts.healthy()) return ts;
  return new LocalSearchEngine();
}

/** Index at startup only when the index is empty (serve path). */
export async function ensureIndexed(engine: SearchEngine, records: SkillRecord[]): Promise<number> {
  const existing = await engine.count().catch(() => 0);
  if (existing > 0) return existing;
  return engine.indexAll(records);
}
