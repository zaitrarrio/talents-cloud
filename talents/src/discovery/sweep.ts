// Source-discovery sweeps (P5, ARCHITECTURE-v2 §7) — the mining
// pipeline from the SkillHub v2 / Threads.dev lineage: find repos
// that carry skills WITHOUT being listed anywhere, verify them
// cheaply, and queue only the real ones.
//
// Sources of candidates: GitHub repository search over a documented
// query set — topic tags the community actually uses, plus
// name/description terms. Verification is ONE git-trees call per
// repo (recursive, via the HEAD ref): a repo counts as a source only
// if the tree provably contains a .claude-plugin/marketplace.json
// (marketplace), SKILL.md files (skill-repo), or a root
// .claude-plugin/plugin.json (plugin-repo). Search-result claims are
// never trusted — the tree is the evidence.
//
// Rate discipline: unauthenticated GitHub search allows ~10 req/min
// and core ~60 req/hr. Every request goes through a Pacer (minimum
// interval + exponential backoff on 403/429, honouring retry-after).
// A GITHUB_TOKEN in the environment (never an argument, never
// logged) raises the limits when the operator provides one.

import type { FetchFn } from "../types.js";
import { defaultFetch } from "../ingest.js";

/** Repo kinds are decided by git-tree verification (classifyTree).
 *  Phase 2 scouts add non-repo kinds: "mcp-server" (MCP Registry /
 *  npm MCP packages), "npm-package" / "skill-package" (npm pointer
 *  records), and the never-ingestable watchlist kinds "lead" (a web
 *  result that does not resolve to a repo/package yet) and "x-post"
 *  (an X post with no resolvable link). Verification decides kind
 *  for repos; a channel's claimed kind is only a nomination.
 *  "list" is the curated-list kind (awesome-* style repos): a list
 *  is an entry point that is MINED for candidates — it never
 *  produces a record and is never ingested (see lists.ts). */
export type SourceKind =
  | "marketplace" | "plugin-repo" | "skill-repo"
  | "mcp-server" | "npm-package" | "skill-package"
  | "lead" | "x-post" | "list";

/** The documented sweep query set. `via` is the label recorded in
 *  sources.discovered_via so every source can be traced to the query
 *  that found it. */
export const SWEEP_QUERIES: { q: string; via: string }[] = [
  { q: "topic:claude-skills", via: "topic:claude-skills" },
  { q: "topic:claude-code-plugin", via: "topic:claude-code-plugin" },
  { q: "topic:claude-code-skills", via: "topic:claude-code-skills" },
  { q: "topic:agent-skills", via: "topic:agent-skills" },
  { q: "topic:mcp-server", via: "topic:mcp-server" },
  { q: "claude skills in:name,description", via: "search:claude-skills" },
  { q: "agent skills in:name,description", via: "search:agent-skills" },
  { q: "claude-code marketplace in:name,description", via: "search:claude-marketplace" },
  { q: "SKILL.md in:readme", via: "search:skill-md-readme" },
];

export interface SweepCandidate {
  locator: string; // owner/repo
  url: string;
  description: string;
  discoveredVia: string;
  archived: boolean;
}

export interface SweepStats {
  queriesRun: number;
  found: number;
  uniqueCandidates: number;
  rateLimitHits: number;
  searchCalls: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Paces GitHub API calls and absorbs rate-limit responses. */
export class Pacer {
  rateLimitHits = 0;
  private lastCallAt = 0;
  constructor(
    private minIntervalMs = 1200,
    private sleep: (ms: number) => Promise<void> = realSleep,
    private now: () => number = () => Date.now(),
  ) {}

  /** Run fn, waiting for the pace window and retrying on 403/429
   *  with backoff (retry-after header wins; else 5s·2^n, capped). */
  async call<T>(fn: () => Promise<{ status: number; headers?: Record<string, string>; value: T }>): Promise<T> {
    let attempt = 0;
    for (;;) {
      const wait = this.minIntervalMs - (this.now() - this.lastCallAt);
      if (wait > 0) await this.sleep(wait);
      this.lastCallAt = this.now();
      const res = await fn();
      if (res.status !== 403 && res.status !== 429) return res.value;
      this.rateLimitHits++;
      if (attempt >= 3) return res.value; // give up gracefully; caller sees the status payload
      const retryAfter = Number(res.headers?.["retry-after"] ?? NaN);
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(60_000, 5000 * 2 ** attempt);
      await this.sleep(backoff);
      attempt++;
    }
  }
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": "talents-discovery-p5",
    accept: "application/vnd.github+json",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

interface RepoSearchItem {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  archived?: boolean;
}

/** One GitHub repository-search call. Returns [] on any failure —
 *  a failed query never fails the sweep. */
export async function searchGithubRepos(
  fetchFn: FetchFn,
  pacer: Pacer,
  query: string,
  perPage: number,
): Promise<RepoSearchItem[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${perPage}`;
  return pacer.call(async () => {
    try {
      const res = await fetchFn(url, { headers: ghHeaders() });
      if (!res.ok) return { status: res.status, value: [] as RepoSearchItem[] };
      const j = (await res.json()) as { items?: RepoSearchItem[] };
      return { status: res.status, value: Array.isArray(j.items) ? j.items : [] };
    } catch {
      return { status: 0, value: [] as RepoSearchItem[] };
    }
  });
}

export interface RunSweepOptions {
  fetchFn?: FetchFn;
  pacer?: Pacer;
  /** Queries to run (default: the full documented set). */
  queries?: { q: string; via: string }[];
  /** Results per query (default 8). */
  perQuery?: number;
  /** Hard cap on unique candidates returned (default 24). */
  cap?: number;
}

export interface SweepResult {
  candidates: SweepCandidate[];
  stats: SweepStats;
}

export async function runSweep(opts: RunSweepOptions = {}): Promise<SweepResult> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const pacer = opts.pacer ?? new Pacer();
  const queries = opts.queries ?? SWEEP_QUERIES;
  const perQuery = opts.perQuery ?? 8;
  const cap = opts.cap ?? 24;
  const byLocator = new Map<string, SweepCandidate>();
  let found = 0;
  for (const { q, via } of queries) {
    const items = await searchGithubRepos(fetchFn, pacer, q, perQuery);
    for (const it of items) {
      found++;
      const locator = (it.full_name ?? "").toLowerCase();
      if (!locator.includes("/") || byLocator.has(locator)) continue;
      byLocator.set(locator, {
        locator,
        url: it.html_url ?? `https://github.com/${locator}`,
        description: it.description ?? "",
        discoveredVia: via,
        archived: Boolean(it.archived),
      });
      if (byLocator.size >= cap) break;
    }
    if (byLocator.size >= cap) break;
  }
  return {
    candidates: [...byLocator.values()],
    stats: {
      queriesRun: queries.length,
      found,
      uniqueCandidates: byLocator.size,
      rateLimitHits: pacer.rateLimitHits,
      searchCalls: queries.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Cheap verification: one recursive git-tree call is the evidence.
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  kind?: SourceKind;
  /** Human-readable evidence / rejection reason. */
  reason: string;
  skillCount?: number;
  hasMarketplace?: boolean;
  hasPlugin?: boolean;
  /** Failure class when ok is false (queue-drain semantics, 2026-11-11):
   *  "deterministic" — a fact about the repo (gone, archived, empty
   *  tree, no skill files): recording a rejection is final and safe.
   *  "transient" — a fact about the moment (our credential rejected,
   *  GitHub rate-limiting or 5xx, network failure): the candidate
   *  must NOT be rejected; callers with a retry mechanism (the queue
   *  consumer) throw and let it retry. Absent on success. Callers
   *  without retries (the CLI cycle, the sandbox drain) keep their
   *  historical behavior and simply ignore the field. */
  failure?: "deterministic" | "transient";
}

interface TreeItem { path?: string; type?: string }

/** fetchTreePaths with the HTTP status preserved (status 0 = the
 *  fetch itself threw). The queue consumer classifies verification
 *  failures by status (see verifyRepo); everyone else uses the
 *  paths-only wrapper below. */
export async function fetchTreePathsDetailed(
  fetchFn: FetchFn,
  pacer: Pacer,
  locator: string,
  ref: string = "HEAD",
): Promise<{ paths: string[] | null; status: number }> {
  // HEAD resolves to the default branch tip — one call, no repo
  // metadata call needed.
  const url = `https://api.github.com/repos/${locator}/git/trees/${ref}?recursive=1`;
  return pacer.call(async (): Promise<{ status: number; value: { paths: string[] | null; status: number } }> => {
    try {
      const res = await fetchFn(url, { headers: ghHeaders() });
      if (!res.ok) return { status: res.status, value: { paths: null, status: res.status } };
      const j = (await res.json()) as { tree?: TreeItem[] };
      const paths = (Array.isArray(j.tree) ? j.tree : [])
        .map((t) => t.path)
        .filter((p): p is string => typeof p === "string");
      return { status: res.status, value: { paths, status: res.status } };
    } catch {
      return { status: 0, value: { paths: null, status: 0 } };
    }
  });
}

export async function fetchTreePaths(
  fetchFn: FetchFn,
  pacer: Pacer,
  locator: string,
  ref: string = "HEAD",
): Promise<string[] | null> {
  return (await fetchTreePathsDetailed(fetchFn, pacer, locator, ref)).paths;
}

/** Classify a tree's paths. Pure — exported for tests. */
export function classifyTree(paths: string[]): Omit<VerifyResult, "ok"> & { ok: boolean } {
  const hasMarketplace = paths.some((p) => p === ".claude-plugin/marketplace.json" || p.endsWith("/.claude-plugin/marketplace.json"));
  const skillPaths = paths.filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"));
  const hasPlugin = paths.some((p) => p === ".claude-plugin/plugin.json");
  if (hasMarketplace) {
    return { ok: true, kind: "marketplace", hasMarketplace, hasPlugin, skillCount: skillPaths.length, reason: `marketplace.json present${skillPaths.length ? `, ${skillPaths.length} SKILL.md` : ""}` };
  }
  if (skillPaths.length > 0) {
    return { ok: true, kind: "skill-repo", hasMarketplace, hasPlugin, skillCount: skillPaths.length, reason: `${skillPaths.length} SKILL.md file(s) present` };
  }
  if (hasPlugin) {
    return { ok: true, kind: "plugin-repo", hasMarketplace, hasPlugin, skillCount: 0, reason: "root plugin.json present, no SKILL.md" };
  }
  return { ok: false, hasMarketplace: false, hasPlugin: false, skillCount: 0, reason: "no marketplace.json, SKILL.md, or plugin.json in tree" };
}

export async function verifyRepo(
  fetchFn: FetchFn,
  pacer: Pacer,
  candidate: SweepCandidate,
): Promise<VerifyResult> {
  if (candidate.archived) return { ok: false, reason: "repo is archived", failure: "deterministic" };
  const { paths, status } = await fetchTreePathsDetailed(fetchFn, pacer, candidate.locator);
  if (paths === null) {
    return {
      ok: false,
      reason: "git tree fetch failed (repo gone, private, or rate-limited)",
      // 404 is a fact about the repo (gone or private for good).
      // Everything else — 401 (OUR credential is bad), 403/429
      // (rate-limited past the Pacer's own retries), 5xx, and
      // network failures — is a fact about the moment: classifying
      // it deterministic would dead-letter live candidates for an
      // operator-side problem.
      failure: status === 404 ? "deterministic" : "transient",
    };
  }
  if (paths.length === 0) return { ok: false, reason: "empty tree", failure: "deterministic" };
  const classified = classifyTree(paths);
  return classified.ok ? classified : { ...classified, failure: "deterministic" };
}
