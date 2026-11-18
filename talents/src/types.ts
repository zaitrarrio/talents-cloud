// Shared types for the Talents meta-registry (P0).
// Identity rule (see README): a plugin's canonical identity is `owner/name`
// where owner = the GitHub owner of the plugin's source repo when the source
// is a GitHub repo (string-relative sources live in the marketplace repo, so
// owner = marketplace repo owner; object sources with a github.com URL use
// that URL's owner). Non-GitHub sources (npm, generic git, command) fall back
// to the marketplace owner and are recorded pointer-only.

export type FetchFn = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Response headers, when the underlying transport exposes
   *  them (defaultFetch passes the real Response headers
   *  through). Drain hardening reads GitHub's rate-limit headers
   *  here; test stubs omit it and callers must treat it as
   *  optional. */
  headers?: { get(name: string): string | null };
}>;

export interface SourceFile {
  /** Path relative to the plugin source root, e.g. ".claude-plugin/plugin.json" or "SKILL.md" */
  path: string;
  content: string;
}

export interface DeclarationLine {
  kind: "component" | "tool" | "network" | "hook" | "undeclared";
  text: string;
}

export interface Declaration {
  lines: DeclarationLine[];
  /** Permission-style summary lines a human reads at install time. */
  summary: string[];
  undeclared: string[];
  derivedFrom: string[];
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface ValidationResult {
  entryName: string;
  ok: boolean;
  issues: ValidationIssue[];
}

export interface Attestation {
  algorithm: "ed25519";
  /** sha256 hex over the canonical concatenation of source files (see attest.ts) */
  contentHash: string;
  /** base64 ed25519 signature over `${identity}@${ref}:${contentHash}` */
  signature: string;
  publicKeyPem: string;
  signedAt: string;
}

export interface SkillRecord {
  /** Canonical public identity, e.g. "anthropics/document-skills" */
  id: string;
  owner: string;
  name: string;
  url: string; // https://talents.sh/skills/{owner}/{name}
  profileUrl: string; // https://talents.sh/{owner}
  kind: "plugin" | "skill" | "mcp" | "agent";
  description: string;
  sourceType: "github" | "npm" | "git" | "marketplace" | "command";
  /** Pointer to the original source — the registry never re-hosts the skill. */
  source: unknown;
  sourceRepo?: string; // "owner/repo" when GitHub-backed
  sourcePath?: string; // subdir inside sourceRepo, "" for root
  sourceMarketplace: string; // marketplace repo/name or URL it was found through
  ref: string; // branch/tag/sha the record was computed at
  pointerOnly: boolean;
  components: { skills: string[]; commands: string[]; agents: string[]; hooks: boolean; mcpServers: string[] };
  declaration: Declaration;
  validation: ValidationResult;
  attestation: Attestation | null;
  filesHashed: string[];
  status: "listed" | "failed";
  ingestedAt: string;
}

export interface DeadLetter {
  marketplace: string;
  entryName: string;
  reason: string;
  issues: ValidationIssue[];
  /** Publisher-notice payload shape (P0: produced, not sent). */
  notice: { to: string | null; subject: string; body: string };
  at: string;
}

export interface IngestSummary {
  target: string;
  marketplaceName: string | null;
  fetchedAt: string;
  total: number;
  ok: number;
  deadLetter: number;
  records: SkillRecord[];
  deadLetters: DeadLetter[];
  /** Why an ingest came back empty, or a scan caveat (e.g. truncation).
   *  The CLI fallback keys on a note starting "marketplace.json not found". */
  note?: string;
}

export interface RegistryFile {
  version: 1;
  updatedAt: string;
  namespaces: Record<string, { owner: string; claimedBy: string; claimedAt: string; verified: boolean }>;
  records: Record<string, SkillRecord>;
  deadLetters: DeadLetter[];
}
