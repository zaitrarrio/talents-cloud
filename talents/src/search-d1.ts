// Search (P2) — Cloudflare-native engine, ARCHITECTURE-v2 §6 as decided
// 2026-11-10: D1 FTS5 with the TRIGRAM tokenizer now, Vectorize for the
// semantic half in P5. Same interface shape as the P1 engines
// (src/search.ts): keyword candidates from the engine, then the shared
// documented re-rank (exact name → attested → fewer warnings).
//
// Why trigram: FTS5's trigram tokenizer indexes every 3-character
// substring, so a query token matches as a SUBSTRING of indexed text
// ("document" matches "document-skills"). Typo tolerance comes from the
// broadening fallback, not the tokenizer alone: a mistyped token like
// "pdff" contains trigrams no document has, so the primary MATCH returns
// nothing and the engine retries with broadened tokens (drop the last
// char, drop the first char, 3-char prefix — "pdff" → {"pdf","dff"}),
// then a LIKE scan over the stored search_text as a last resort.
//
// The engine talks to a minimal structural D1 interface (prepare/bind/
// all) so the Cloudflare Worker passes env.DB directly and unit tests
// can drive it with a fake.
//
// Ranking (search-fix, 2026-11-10 — the "build games" defect): the old
// single OR-MATCH let a high-frequency token ("build" appears in many
// dev-tool descriptions) flood the results while the distinctive token
// contributed nothing. The engine now works PER TOKEN:
//   1. Query tokens are normalized (normalizeToken: games → game), so
//      plural and singular forms match the same documents.
//   2. Each token gets its own FTS pass (with the typo-broadening and
//      LIKE fallbacks per token), yielding a per-token match set and a
//      document frequency (df).
//   3. Candidates are ranked by, in order: distinct tokens matched
//      (desc) → sum of per-token rarity weights 1/(1+df) (desc) → name
//      relevance (the name part of the P1 re-rank score: exact name →
//      name contains query → name contains a token) → whole-word
//      relevance (exactWordScore: query tokens as standalone words in
//      name/description, which trigram substring matching cannot
//      distinguish from derived words like "documentation") →
//      description aboutness (descWordCount: whole-word occurrences
//      of the tokens in the description) → best bm25 rank across the
//      token passes → attested → fewest warnings.
//      A record
//      matching only a common token therefore ranks below ANY record
//      matching a rare token, and below any record matching more
//      tokens. bm25 sits before the attestation/warning keys so that
//      when two records are equally name-relevant, raw textual
//      relevance — not a one-warning difference — decides (the grown
//      catalog has garrytan/document-generate vs
//      anthropics/document-skills for "document": same name relevance,
//      document-skills is far more bm25-relevant, and a single
//      validation warning must not flip them).
//   4. Partial-match honesty: if the query's rarest token matches no
//      document at all (df = 0 after broadening), the result is marked
//      partial and carries a plain-language note naming the unmatched
//      token — weak common-token matches are never presented as if
//      they answered the whole query (see searchDetailed).

import type { SkillRecord } from "./types.js";
import { normalizeToken, rerank, warningCount, type SearchQueryInput } from "./search.js";

/** The name-relevance part of the shared P1 re-rank score (kept in
 *  step with rerankScore in search.ts): exact name match → name
 *  contains the whole query → name contains any query token. */
export function nameScore(r: SkillRecord, q: string): number {
  const needle = q.trim().toLowerCase();
  if (!needle) return 0;
  const tokens = needle.split(/\s+/).filter(Boolean);
  const name = r.name.toLowerCase();
  if (name === needle) return 100;
  if (name.includes(needle)) return 40;
  if (tokens.some((t) => t.length > 1 && name.includes(t))) return 15;
  return 0;
}

function wholeWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(normalizeToken));
}

/** Whole-word relevance: how many query tokens appear as STANDALONE
 *  words (after the same normalization) in the record's name (+2 each)
 *  or description (+1 each), as opposed to merely as substrings of
 *  longer words. Trigram matching cannot tell "document" (the thing)
 *  from "documentation" (a derived word); this key can, and it is what
 *  separates anthropics/document-skills (name AND description carry
 *  the standalone word) from garrytan/document-generate (description
 *  only carries "documentation") for the query "document". */
export function exactWordScore(r: SkillRecord, normTokens: string[]): number {
  const nameWords = wholeWords(r.name);
  const descWords = wholeWords(r.description ?? "");
  let s = 0;
  for (const t of normTokens) {
    if (nameWords.has(t)) s += 2;
    if (descWords.has(t)) s += 1;
  }
  return s;
}

/** Description aboutness: total whole-word occurrences of the query
 *  tokens in the description (the publisher-authored summary of what
 *  the record DOES). Field-weighted bm25 under-rewards this when a
 *  record's name echoes through the components/declaration templates
 *  while a competitor's declaration is undeclared — for "security",
 *  42crunch's description uses the word three times as a standalone
 *  term (it is an API-security product), donchitos/security-audit
 *  once (a game save-tampering checklist). Capped per token so a
 *  keyword-stuffed description cannot run away with it. */
export function descWordCount(r: SkillRecord, normTokens: string[]): number {
  const words = (r.description ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(normalizeToken);
  let s = 0;
  for (const t of normTokens) {
    s += Math.min(words.filter((w) => w === t).length, 3);
  }
  return s;
}

/** Minimal structural subset of the D1 API this engine uses. */
export interface D1StatementLike {
  bind(...params: unknown[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
}

export const FTS_TABLE = "skills_fts";

export { normalizeToken };

/** A query token before and after normalization. `raw` is what the
 *  user typed (used in the partial-match note); `norm` is what the
 *  index is actually queried with. */
export interface QueryTokenPair {
  raw: string;
  norm: string;
}

export function queryTokenPairs(q: string): QueryTokenPair[] {
  const seen = new Set<string>();
  const out: QueryTokenPair[] = [];
  for (const raw of q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const norm = normalizeToken(raw);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ raw, norm });
  }
  return out;
}

export function queryTokens(q: string): string[] {
  return queryTokenPairs(q).map((p) => p.norm);
}

/** FTS5 MATCH expression: quoted substring phrases, OR-joined. Tokens
 *  shorter than 3 chars have no trigrams and are left to the LIKE pass. */
export function ftsMatchExpression(tokens: string[]): string | null {
  const usable = [...new Set(tokens.filter((t) => t.length >= 3))];
  if (usable.length === 0) return null;
  return usable.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

/** Broadened token set for the typo fallback: for each token of length
 *  ≥4, the token minus its last char, minus its first char, and its
 *  3-char prefix. ("pdff" → pdf, dff.) */
export function broadenedTokens(tokens: string[]): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.length >= 4) {
      out.add(t.slice(0, -1));
      out.add(t.slice(1));
      out.add(t.slice(0, 3));
    }
  }
  return [...out].filter((t) => t.length >= 3);
}

export interface SearchPlan {
  /** Primary FTS MATCH expression (null when no token is FTS-usable). */
  match: string | null;
  /** Broadening MATCH expression, used only when the primary misses. */
  broadenMatch: string | null;
  /** Raw tokens for the LIKE last-resort pass. */
  likeTokens: string[];
}

export function buildSearchPlan(q: string): SearchPlan {
  const tokens = queryTokens(q);
  return {
    match: ftsMatchExpression(tokens),
    broadenMatch: ftsMatchExpression(broadenedTokens(tokens)),
    likeTokens: tokens,
  };
}

// bm25 column weights: name 5, description 2, components/declaration
// ZERO. The candidate ORDER from this pass is only a late tiebreak
// (bestRank), and the components/declaration columns are derived,
// echo-prone text: a scanned skill's declaration repeats its name and
// description, while a marketplace plugin with undeclared components
// contributes nothing there at all. Weighting them made the tiebreak
// compare INGEST PATHS, not relevance — measured live for "security":
// full weights ranked code-yeongyu/security-research (−5.82) above
// 42crunch-ai/42crunch-api-security-testing (−5.67) purely on echo,
// while name+description-only bm25 ranks 42crunch first (−5.67 vs
// −5.45). Matching (recall) is unaffected: MATCH still searches every
// column; only the ordering weights changed.
const FTS_SQL = `SELECT r.record_json AS record_json
FROM skills_fts f
JOIN records r ON r.id = f.id
WHERE skills_fts MATCH ?
  AND r.status = 'listed'
  AND (? IS NULL OR r.kind = ?)
  AND (? IS NULL OR r.owner = ?)
ORDER BY bm25(skills_fts, 0.0, 5.0, 2.0, 0.0, 0.0)
LIMIT 500`;

const LIKE_SQL = `SELECT record_json FROM records
WHERE status = 'listed'
  AND (? IS NULL OR kind = ?)
  AND (? IS NULL OR owner = ?)
  AND (search_text LIKE ? ESCAPE '\\')
ORDER BY id
LIMIT 50`;

const ALL_SQL = `SELECT record_json FROM records
WHERE status = 'listed'
  AND (? IS NULL OR kind = ?)
  AND (? IS NULL OR owner = ?)
ORDER BY id
LIMIT 50`;

function parseRows(rows: { record_json: string }[]): SkillRecord[] {
  return rows.map((row) => JSON.parse(row.record_json) as SkillRecord);
}

/** Partial-match metadata returned by searchDetailed. `partial` is
 *  true when the query's rarest token matched no document; `note` is a
 *  plain-language sentence for the UI (never null when partial). */
export interface SearchMeta {
  partial: boolean;
  /** Original (pre-normalization) tokens that matched nothing. */
  missingTokens: string[];
  note: string | null;
}

export interface DetailedSearchResult {
  results: SkillRecord[];
  meta: SearchMeta;
}

/** Rarity weight of a token with the given document frequency: a token
 *  in 1 document weighs 1/2; a token in 49 weighs 1/50. Distinct-token
 *  count dominates this in the sort, so it only separates records that
 *  matched the same NUMBER of tokens. */
export function tokenWeight(df: number): number {
  return 1 / (1 + df);
}

interface TokenMatches {
  pair: QueryTokenPair;
  /** Documents matched (after broadening/LIKE fallbacks), df = size. */
  records: Map<string, SkillRecord>;
  /** id → best (lowest) bm25 rank within this token's passes. */
  ranks: Map<string, number>;
}

export class D1SearchEngine {
  readonly name = "d1" as const;

  constructor(private db: D1Like) {}

  private async fts(match: string, input: SearchQueryInput): Promise<SkillRecord[]> {
    const kind = input.kind ?? null;
    const owner = input.owner ?? null;
    const { results } = await this.db
      .prepare(FTS_SQL)
      .bind(match, kind, kind, owner, owner)
      .all<{ record_json: string }>();
    return parseRows(results);
  }

  private async like(token: string, input: SearchQueryInput): Promise<SkillRecord[]> {
    const kind = input.kind ?? null;
    const owner = input.owner ?? null;
    const like = `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { results } = await this.db
      .prepare(LIKE_SQL)
      .bind(kind, kind, owner, owner, like)
      .all<{ record_json: string }>();
    return parseRows(results);
  }

  /** All matches for ONE normalized token: FTS first, then the typo
   *  broadening variants, then the substring LIKE pass as last resort
   *  (also the only pass for sub-3-char tokens, which have no
   *  trigrams). Rank order is preserved across the passes. */
  private async tokenMatches(pair: QueryTokenPair, input: SearchQueryInput): Promise<TokenMatches> {
    const records = new Map<string, SkillRecord>();
    const ranks = new Map<string, number>();
    const add = (rows: SkillRecord[]) => {
      rows.forEach((r, i) => {
        if (!records.has(r.id)) {
          records.set(r.id, r);
          ranks.set(r.id, i);
        }
      });
    };
    const t = pair.norm;
    if (t.length >= 3) {
      add(await this.fts(`"${t.replace(/"/g, "")}"`, input));
      if (records.size === 0) {
        for (const v of broadenedTokens([t])) {
          if (v !== t) add(await this.fts(`"${v}"`, input));
        }
      }
      if (records.size === 0) add(await this.like(t, input));
    } else {
      add(await this.like(t, input));
    }
    return { pair, records, ranks };
  }

  async search(input: SearchQueryInput): Promise<SkillRecord[]> {
    return (await this.searchDetailed(input)).results;
  }

  async searchDetailed(input: SearchQueryInput): Promise<DetailedSearchResult> {
    const kind = input.kind ?? null;
    const owner = input.owner ?? null;
    const limit = input.limit ?? 20;
    const pairs = queryTokenPairs(input.q);

    // No usable tokens → browse mode (unchanged P1/P2 behaviour).
    if (pairs.length === 0) {
      const { results } = await this.db.prepare(ALL_SQL).bind(kind, kind, owner, owner).all<{ record_json: string }>();
      return {
        results: rerank(parseRows(results), input.q, limit),
        meta: { partial: false, missingTokens: [], note: null },
      };
    }

    const perToken: TokenMatches[] = [];
    for (const p of pairs) perToken.push(await this.tokenMatches(p, input));

    const missingTokens = perToken.filter((t) => t.records.size === 0).map((t) => t.pair.raw);
    const partial = missingTokens.length > 0;

    // Merge per-token match sets with the documented multi-key sort.
    interface Cand {
      record: SkillRecord;
      matched: number;
      tokenScore: number;
      name: number;
      exactWord: number;
      descTf: number;
      attested: number;
      warnings: number;
      bestRank: number;
    }
    const normTokens = pairs.map((p) => p.norm);
    const byId = new Map<string, Cand>();
    perToken.forEach((tm) => {
      const w = tokenWeight(tm.records.size);
      for (const [id, record] of tm.records) {
        const c = byId.get(id) ?? {
          record, matched: 0, tokenScore: 0,
          name: nameScore(record, input.q),
          exactWord: exactWordScore(record, normTokens),
          descTf: descWordCount(record, normTokens),
          attested: record.attestation ? 1 : 0,
          warnings: warningCount(record),
          bestRank: Number.POSITIVE_INFINITY,
        };
        c.matched += 1;
        c.tokenScore += w;
        c.bestRank = Math.min(c.bestRank, tm.ranks.get(id) ?? Number.POSITIVE_INFINITY);
        byId.set(id, c);
      }
    });
    const sorted = [...byId.values()].sort((a, b) =>
      b.matched - a.matched ||
      b.tokenScore - a.tokenScore ||
      b.name - a.name ||
      b.exactWord - a.exactWord ||
      b.descTf - a.descTf ||
      a.bestRank - b.bestRank ||
      b.attested - a.attested ||
      a.warnings - b.warnings ||
      a.record.id.localeCompare(b.record.id));
    const results = sorted.slice(0, limit).map((c) => c.record);

    let note: string | null = null;
    if (partial) {
      const named = missingTokens.map((t) => `'${t}'`).join(", ");
      note = results.length > 0
        ? `No skills match ${named} yet — showing closest matches for the rest of your search`
        : `No skills match ${named} yet — nothing in the catalog matches the rest of your search either.`;
    }
    return { results, meta: { partial, missingTokens, note } };
  }
}
