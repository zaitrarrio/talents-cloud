// Enrichment types (ENRICHMENT.md; Tranche 1: layers A–C,
// Tranche 2: layers D–E).
//
// Every enriched field carries a provenance class, and the classes
// are never blended in storage or display:
//   A — "source" facts fetched from the origin (GitHub / npm).
//   B — "derived" deterministic extraction from source artefacts.
//   C — "derived" live protocol introspection of remote MCP servers.
//   D — "generated" editorial (Anthropic; always labelled, never
//       merged into source fields, withheld when material is thin).
//   E — "derived" trust signals (risky-pattern scan + source drift;
//       neutral facts, never verdicts).
//
// Per-layer state: pending | done | partial | none | stale.
//   done    — layer produced its full payload.
//   partial — layer produced something, with recorded gaps (errors).
//   none    — layer legitimately has nothing for this record (e.g.
//             no remote endpoint for C, pointer-only record for B),
//             with the reason recorded in the payload.
//   stale   — payload exists but the record's source hash changed
//             since it was computed (set by reconcile, consumed by
//             the pipeline as "re-run").

export type LayerState = "pending" | "done" | "partial" | "none" | "stale";
export type EnrichLayer = "a" | "b" | "c" | "d" | "e";

export interface GithubFacts {
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  licenseSpdx: string | null;
  topics: string[];
  language: string | null;
  /** Language byte mix from the GitHub languages endpoint (top 8). */
  languages: Record<string, number>;
  createdAt: string | null;
  pushedAt: string | null;
  archived: boolean;
  defaultBranch: string | null;
  /** Contributor count from ONE bounded page (per_page=100);
   *  `contributorsCapped` is true when the page came back full, so
   *  the count is a floor, not an exact figure. */
  contributors: number | null;
  contributorsCapped: boolean;
  latestRelease: { tag: string; publishedAt: string | null } | null;
}

export interface NpmFacts {
  package: string;
  weeklyDownloads: number | null;
  monthlyDownloads: number | null;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  versionCount: number | null;
  maintainersCount: number | null;
  deprecated: boolean;
}

export interface ReadmeAsset {
  /** R2 object key (`readme/{skillId}`); bytes stored there, capped. */
  storedKey: string;
  /** The URL the README was fetched from — always recorded, so the
   *  bucket is never the only copy of the source reference. */
  sourceUrl: string;
  bytes: number;
  /** True when the origin README exceeded the storage cap and only
   *  the first bytes were stored. */
  truncated: boolean;
  /** Rendered-plain-text excerpt (first prose, whitespace-collapsed),
   *  stored in JSON for the skill page — no R2 round-trip to render. */
  excerpt: string;
}

export interface IconAsset {
  /** R2 object key (`icon/{skillId}`). */
  storedKey: string;
  sourceUrl: string;
  contentType: string;
  bytes: number;
}

/** Layer A payload (class: source). */
export interface LayerA {
  fetchedAt: string;
  github?: GithubFacts;
  npm?: NpmFacts;
  readme?: ReadmeAsset;
  icon?: IconAsset;
  /** Why the layer is partial (fetch failures, missing pieces). */
  errors?: string[];
}

export interface SubInventoryEntry {
  kind: "skill" | "agent" | "command";
  name: string;
  /** One-line description (frontmatter/first line); "" when the
   *  file was listed from the tree but not fetched (cap). */
  description: string;
  /** Path inside the source repo. */
  path: string;
}

export interface SkillParse {
  /** The SKILL.md path inside the source repo that was parsed. */
  path: string;
  frontmatter: {
    name?: string;
    description?: string;
    allowedTools?: string[];
    model?: string;
    license?: string;
    [k: string]: unknown;
  };
  instructionLines: number;
  /** Rough token estimate (chars / 4) — labelled an estimate. */
  tokenEstimate: number;
  /** Local files the instructions reference (relative links/images). */
  referencedFiles: string[];
  /** External URLs the instructions reference. */
  externalUrls: string[];
  /** When the stored record description is the known ingest
   *  artifact "---", the description parsed from the source
   *  frontmatter is recorded here as a candidate for the later
   *  ingest fix. NEVER displayed as the record description. */
  parsedDescription?: string;
}

export interface PluginMeta {
  author?: string;
  homepage?: string;
  repository?: string;
  keywords?: string[];
}

export interface McpPackageFacts {
  packageName?: string;
  version?: string;
  registry?: string;
  /** stdio | http | sse | … as declared; "unknown" when undeclared. */
  transport: string;
  /** Required environment variable NAMES — never values. */
  envVars: string[];
}

/** Layer B payload (class: derived). */
export interface LayerB {
  derivedAt: string;
  subInventory?: SubInventoryEntry[];
  /** True when the tree held more entries than the fetch caps. */
  subInventoryTruncated?: boolean;
  skillParse?: SkillParse;
  pluginMeta?: PluginMeta;
  mcpPackage?: McpPackageFacts;
  /** Present when the layer is state `none`: why there is nothing. */
  reason?: string;
  errors?: string[];
}

export interface McpToolInfo {
  name: string;
  description: string;
}

/** Layer C payload (class: derived — live introspection). */
export interface LayerC {
  probedAt: string;
  endpoint: string;
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  tools: McpToolInfo[];
  /** Counts only — resource/prompt inventories are names in v1 for
   *  tools; resources/prompts are counted (they can be huge). */
  resourceCount?: number;
  promptCount?: number;
  promptNames?: string[];
  /** Present when the probe could not complete (state none/partial):
   *  "requires auth" | "unreachable: …" | "not an MCP endpoint: …". */
  reason?: string;
  errors?: string[];
}

/** Layer D payload (class: generated — Anthropic editorial).
 *  Stored only under d_json and surfaced only under a `generated`
 *  key/label — NEVER merged into the record's source fields. */
export interface LayerD {
  generatedAt: string;
  /** The exact model id that produced this payload. */
  model: string;
  /** The source hash the payload was generated against. */
  sourceHash: string;
  oneLine: string;
  paragraph: string;
  /** Categories from the fixed TAXONOMY (layer-d.ts) only. */
  categories: string[];
  /** Free-form tags (≤6), the model's own words. */
  tags: string[];
  /** 2–4 concrete jobs, phrased as user goals. */
  useCases: string[];
  audience: "developer" | "ops" | "data" | "creative" | "general" | "mixed";
  /** Real token usage summed over generation attempts. */
  usage: { inputTokens: number; outputTokens: number };
}

/** Layer D withholding / failure payload (state `none` with a
 *  reason = the withholding verdict; state `partial` = generation
 *  was attempted and failed validation). The presence of d_json is
 *  what distinguishes "evaluated" from the schema default
 *  (`none` + NULL = never attempted). */
export interface LayerDWithheld {
  generatedAt: string;
  sourceHash: string;
  reason: string;
  errors?: string[];
  usage?: { inputTokens: number; outputTokens: number };
}

export type TrustFlagClass =
  | "remote-code-execution"
  | "credential-access"
  | "persistence"
  | "obfuscation"
  | "network-exfil";

/** One factual finding of the Layer E static scan: the pattern
 *  class, a short verbatim excerpt (≤120 chars) and the file it was
 *  found in. A flag is a FACT ("the pinned source contains this
 *  pattern"), never a verdict about the publisher or the skill. */
export interface TrustFlag {
  class: TrustFlagClass;
  evidence: string;
  file: string;
}

export type DriftStatus = "current" | "changed" | "unknown";

/** Layer E payload (class: derived — trust signals). */
export interface LayerE {
  scannedAt: string;
  /** Source files actually scanned (paths inside the source repo,
   *  or "server.json" for registry records). */
  files: string[];
  flags: TrustFlag[];
  /** When the record's source was last verified: the attestation
   *  signing time, or the ingest time for unattested records. */
  lastVerifiedAt: string;
  drift: {
    status: DriftStatus;
    /** Head commit of the source repo's default branch, when the
     *  check could be made. */
    headSha?: string;
    checkedAt: string;
    /** Why the status could not be determined (status "unknown"). */
    reason?: string;
  };
  /** Present when the scan could not cover everything (state
   *  `partial`) or had nothing to scan (state `none`). */
  reason?: string;
  errors?: string[];
}

/** One enrichment table row, JSON payloads parsed. */
export interface EnrichmentRow {
  skillId: string;
  sourceHash: string;
  aState: LayerState;
  bState: LayerState;
  cState: LayerState;
  dState: LayerState;
  eState: LayerState;
  a: LayerA | null;
  b: LayerB | null;
  c: LayerC | null;
  d: LayerD | LayerDWithheld | null;
  e: LayerE | null;
  aAt: string | null;
  bAt: string | null;
  cAt: string | null;
  updatedAt: string;
}

/** Display-asset store: R2 in production (Worker binding / REST from
 *  the operator script), in-memory in tests. Keys are
 *  `readme/{skillId}` and `icon/{skillId}`. */
export interface AssetStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
}

export class InMemoryAssetStore implements AssetStore {
  objects = new Map<string, { data: Uint8Array; contentType: string }>();
  async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { data, contentType });
  }
}
