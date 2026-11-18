// Aggregated marketplace (P2) — ARCHITECTURE-v2 §9 P2: the registry
// publishes ONE marketplace.json of its own ("talents") whose plugin
// entries POINT AT THE ORIGINAL SOURCES. Nothing in it resolves to a
// Talents-hosted copy: the meta-registry is a catalog, not a CDN, so
// `/plugin marketplace add talents` in Claude Code installs every skill
// source-direct from its publisher's repo / npm package / git URL.
//
// Source reconstruction per record (record.source is the publisher's
// original marketplace entry source, captured at ingest):
//   - object source (github / git-subdir / url / npm / …) → reused
//     verbatim: it already points at the origin.
//   - string http(s) URL → {source:"github", repo} for github.com, else
//     {source:"url", url}.
//   - string relative path ("./plugins/x", "./") → resolved against the
//     repo it lives in (record.sourceRepo — the identity rule guarantees
//     this is the repo the relative path is relative TO) and rewritten
//     as a git-subdir source pointing at that repo + path, pinned by
//     the record's ref (sha when the ref is a commit sha, else ref).
//   - standalone repo-scan skills (sourceMarketplace "direct-repo-scan:…")
//     get the git-subdir treatment too, plus strict:false + skills:["./"]
//     because their directory holds a bare SKILL.md, not a plugin.json.
//
// The output is validated with the project's own validateMarketplace +
// validateEntry (src/validate.ts) — our mirror of `claude plugin
// validate`. (The Claude Code CLI is not installed in the build sandbox,
// so the live `/plugin marketplace add talents` run is a user-machine
// step; the spec-mirror validation is what the gate asserts here.)

import type { SkillRecord } from "./types.js";
import { validateMarketplace, validateEntry, type MarketplaceEntry, type MarketplaceJson } from "./validate.js";
import type { ValidationIssue } from "./types.js";
import { parseGithubUrl } from "./ingest.js";

export const AGGREGATE_NAME = "talents";

const SHA_RE = /^[0-9a-f]{40}$/i;

export function isStandaloneScan(r: SkillRecord): boolean {
  return r.sourceMarketplace.startsWith("direct-repo-scan:");
}

/** Reconstruct a marketplace-entry source that points at the origin. */
export function entrySourceFor(r: SkillRecord): unknown {
  const src = r.source;
  if (src && typeof src === "object") return src; // already an origin pointer
  if (typeof src === "string" && /^https?:\/\//.test(src)) {
    const gh = parseGithubUrl(src);
    if (gh) return { source: "github", repo: `${gh.owner}/${gh.repo}` };
    return { source: "url", url: src };
  }
  // Relative path (or missing source): resolve against the repo it lives in.
  if (r.sourceRepo) {
    const out: Record<string, unknown> = {
      source: "git-subdir",
      url: `https://github.com/${r.sourceRepo}`,
      path: r.sourcePath ? r.sourcePath : ".",
    };
    if (SHA_RE.test(r.ref)) out.sha = r.ref;
    else if (r.ref) out.ref = r.ref;
    return out;
  }
  // No repo to point at (should not happen for listed records): keep the
  // recorded source as-is rather than inventing a destination.
  return src ?? null;
}

export function entryForRecord(r: SkillRecord): MarketplaceEntry {
  const entry: MarketplaceEntry = {
    name: r.name,
    description: r.description,
    source: entrySourceFor(r),
  };
  if (isStandaloneScan(r)) {
    // Bare SKILL.md directory, no plugin.json at the source: declare the
    // skill inline the way strict:false marketplace entries do.
    entry.strict = false;
    entry.skills = ["./"];
  }
  return entry;
}

export interface AggregateResult {
  doc: MarketplaceJson;
  entryCount: number;
  skipped: { id: string; reason: string }[];
  issues: ValidationIssue[];
}

export interface AggregateOptions {
  /** Owner-unlisted record ids (Creator Experience, P4): owner
   *  opt-out is absolute — an unlisted record never appears in the
   *  aggregate even though its verified row stays in the registry
   *  store. Exclusions are reported in `skipped`. */
  excludeIds?: Set<string>;
}

/** Build the aggregated marketplace.json over all LISTED records.
 *  Kept for the CLI / offline builds, which hold their own (small)
 *  record sets. The Worker route must use createAggregateBuilder
 *  instead — feeding it the whole catalog in one array is the
 *  53.5 MB full-table load that 500s under D1's 50 MB response
 *  limit (gate-d1size). */
export function buildAggregatedMarketplace(records: SkillRecord[], opts: AggregateOptions = {}): AggregateResult {
  const builder = createAggregateBuilder(opts);
  builder.addPage(records);
  return builder.finish();
}

/**
 * Incremental builder for the aggregated marketplace.json: the
 * Worker route pages the catalog (recordsPage, 500/page) and feeds
 * each page here instead of loading every record_json into one
 * invocation. Pages arrive in id order, so the global sort is
 * preserved by concatenation; name dedup and the unlisted skip are
 * per-entry and page-independent, so the result is identical to
 * buildAggregatedMarketplace over the same records.
 */
export interface AggregateBuilder {
  addPage(records: SkillRecord[]): void;
  finish(): AggregateResult;
}

export function createAggregateBuilder(opts: AggregateOptions = {}): AggregateBuilder {
  const plugins: MarketplaceEntry[] = [];
  const skipped: AggregateResult["skipped"] = [];
  const seen = new Set<string>();
  return {
    addPage(records: SkillRecord[]): void {
      const listed = records
        .filter((r) => r.status === "listed")
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const r of listed) {
        if (opts.excludeIds?.has(r.id)) {
          skipped.push({ id: r.id, reason: "owner-unlisted (creator opt-out)" });
          continue;
        }
        // Marketplace plugin names must be unique within one marketplace.
        if (seen.has(r.name)) {
          skipped.push({ id: r.id, reason: `duplicate plugin name "${r.name}" in aggregate` });
          continue;
        }
        seen.add(r.name);
        plugins.push(entryForRecord(r));
      }
    },
    finish(): AggregateResult {
      const doc: MarketplaceJson = {
        name: AGGREGATE_NAME,
        description:
          "The Talents meta-registry catalog: skills, plugins and MCP servers indexed in place from their original sources. Every entry points at its publisher's source — installs resolve source-direct, nothing is re-hosted.",
        owner: { name: "Talents" },
        plugins,
      };
      const issues: ValidationIssue[] = [
        ...validateMarketplace(doc),
        ...plugins.flatMap((p) => validateEntry(p)),
      ];
      return { doc, entryCount: plugins.length, skipped, issues };
    },
  };
}

/**
 * Gate assertion: no entry may point at a Talents origin or keep an
 * unresolved relative source. Returns a list of violations (empty = ok).
 */
export function externalSourceViolations(doc: MarketplaceJson): string[] {
  const violations: string[] = [];
  const check = (label: string, value: unknown, isSourceRoot = false): void => {
    if (typeof value === "string") {
      if (/talents\.sh|talents\.dev/i.test(value)) violations.push(`${label}: points at a Talents origin (${value})`);
      // A relative string AS an entry source would resolve against the
      // talents marketplace repo itself — a re-host in disguise.
      if (isSourceRoot && value.startsWith(".")) violations.push(`${label}: unresolved relative source (${value})`);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) check(label, v);
    }
  };
  for (const p of doc.plugins ?? []) check(`plugin "${p.name ?? "?"}"`, p.source, true);
  return violations;
}
