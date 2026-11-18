// Ingest: the GitHub adapter + direct marketplace.json URLs.
// Fetches marketplace.json, resolves each plugin's source, fetches plugin.json
// and SKILL.md files where reachable, then runs validate → declaration →
// attestation for each entry. One bad entry → dead letter, never a crash.

import type { FetchFn, SkillRecord, IngestSummary, SourceFile, DeadLetter } from "./types.js";
import {
  validateMarketplace, validateEntry, validatePluginJson, validateSkillMd,
  resultFor, toDeadLetter, usableDescription, stringArray, normalizeComponents, type MarketplaceJson, type MarketplaceEntry,
} from "./validate.js";
import { deriveDeclaration, type PluginJson } from "./declaration.js";
import { contentHash, signAttestation, type RegistryKey } from "./attest.js";
import { canonicalUrl, profileUrl } from "./namespace.js";

export const defaultFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, { headers: { "user-agent": "talents-registry-p0", ...(init?.headers ?? {}) } });
  // Headers pass through so callers that need them (drain
  // hardening: GitHub rate-limit headers) can read them.
  return { ok: res.ok, status: res.status, text: () => res.text(), json: () => res.json(), headers: res.headers };
};

export interface ResolvedSource {
  sourceType: SkillRecord["sourceType"];
  /** GitHub repo "owner/repo" when GitHub-backed */
  repo?: string;
  /** Subdir inside repo ("" = root) */
  path: string;
  /** Ref to fetch at (branch/tag/sha) */
  ref?: string;
  pointerOnly: boolean;
  /** Namespace owner per the identity rule */
  identityOwner: string;
}

const GH_URL = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/;

export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(GH_URL);
  if (!m) return null;
  return { owner: m[1].toLowerCase(), repo: m[2].toLowerCase() };
}

function normPath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/$/, "");
}

export function resolveSource(entry: MarketplaceEntry, marketplaceRepo: { owner: string; repo: string }): ResolvedSource {
  const src = entry.source;
  const mpOwner = marketplaceRepo.owner;
  // String source: relative path inside the marketplace repo.
  if (typeof src === "string") {
    if (/^https?:\/\//.test(src)) {
      const gh = parseGithubUrl(src);
      if (gh) return { sourceType: "github", repo: `${gh.owner}/${gh.repo}`, path: "", identityOwner: gh.owner, pointerOnly: false };
      return { sourceType: "git", path: "", identityOwner: mpOwner, pointerOnly: true };
    }
    return { sourceType: "github", repo: `${marketplaceRepo.owner}/${marketplaceRepo.repo}`, path: normPath(src), identityOwner: mpOwner, pointerOnly: false };
  }
  if (src && typeof src === "object") {
    const s = src as Record<string, unknown>;
    const kind = String(s.source ?? "");
    if (kind === "github" && typeof s.repo === "string") {
      const [owner, repo] = s.repo.split("/");
      return { sourceType: "github", repo: s.repo.toLowerCase(), path: "", ref: (s.ref as string) ?? undefined, identityOwner: (owner ?? mpOwner).toLowerCase(), pointerOnly: false };
    }
    if ((kind === "url" || kind === "git-subdir" || kind === "git") && typeof s.url === "string") {
      const gh = parseGithubUrl(s.url);
      if (gh) {
        return {
          sourceType: "github",
          repo: `${gh.owner}/${gh.repo}`,
          path: kind === "git-subdir" ? normPath(String(s.path ?? "")) : "",
          ref: (s.sha as string) ?? (s.ref as string) ?? undefined,
          identityOwner: gh.owner,
          pointerOnly: false,
        };
      }
      return { sourceType: "git", path: "", identityOwner: mpOwner, pointerOnly: true };
    }
    if (kind === "npm") return { sourceType: "npm", path: "", identityOwner: mpOwner, pointerOnly: true };
    return { sourceType: "marketplace", path: "", identityOwner: mpOwner, pointerOnly: true };
  }
  return { sourceType: "marketplace", path: "", identityOwner: mpOwner, pointerOnly: true };
}

export async function fetchText(fetchFn: FetchFn, url: string): Promise<string | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export function rawUrl(repo: string, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
}

export async function defaultBranch(fetchFn: FetchFn, repo: string): Promise<string> {
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}`, { headers: { accept: "application/vnd.github+json" } });
    if (res.ok) {
      const j = (await res.json()) as { default_branch?: string };
      if (j.default_branch) return j.default_branch;
    }
  } catch { /* fall through */ }
  return "main";
}

export interface IngestOptions {
  fetchFn?: FetchFn;
  registryKey: RegistryKey;
  ref?: string;
  limit?: number;
}

/** Ingest a GitHub repo (owner/repo) that hosts a marketplace.json. */
export async function ingestGithubRepo(ownerRepo: string, opts: IngestOptions): Promise<IngestSummary> {
  const [owner, repo] = ownerRepo.toLowerCase().split("/");
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const ref = opts.ref ?? (await defaultBranch(fetchFn, `${owner}/${repo}`));
  const url = rawUrl(`${owner}/${repo}`, ref, ".claude-plugin/marketplace.json");
  const text = await fetchText(fetchFn, url);
  if (text === null) {
    return emptySummary(ownerRepo, `marketplace.json not found at ${owner}/${repo}@${ref}`);
  }
  return ingestMarketplaceText(text, { label: ownerRepo, repo: { owner, repo }, ref, fetchFn, opts });
}

/** Ingest a direct marketplace.json URL (fetched via raw HTTP). */
export async function ingestMarketplaceUrl(marketplaceUrl: string, opts: IngestOptions): Promise<IngestSummary> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const text = await fetchText(fetchFn, marketplaceUrl);
  if (text === null) return emptySummary(marketplaceUrl, `could not fetch ${marketplaceUrl}`);
  // Best-effort repo context from a raw.githubusercontent URL.
  const m = marketplaceUrl.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//);
  const repo = m ? { owner: m[1].toLowerCase(), repo: m[2].toLowerCase() } : { owner: "unknown", repo: "unknown" };
  const ref = opts.ref ?? (m ? m[3] : "main");
  return ingestMarketplaceText(text, { label: marketplaceUrl, repo, ref, fetchFn, opts });
}

function emptySummary(target: string, why: string): IngestSummary {
  return { target, marketplaceName: null, fetchedAt: new Date().toISOString(), total: 0, ok: 0, deadLetter: 0, records: [], deadLetters: [], note: why };
}

async function ingestMarketplaceText(
  text: string,
  ctx: { label: string; repo: { owner: string; repo: string }; ref: string; fetchFn: FetchFn; opts: IngestOptions },
): Promise<IngestSummary> {
  const { fetchFn, opts } = ctx;
  let mj: MarketplaceJson;
  try {
    mj = JSON.parse(text) as MarketplaceJson;
  } catch {
    return emptySummary(ctx.label, "marketplace.json is not valid JSON");
  }
  const mIssues = validateMarketplace(mj);
  const fatal = mIssues.some((i) => i.severity === "error");
  const entries = Array.isArray(mj.plugins) ? mj.plugins : [];
  const limited = opts.limit ? entries.slice(0, opts.limit) : entries;
  const records: SkillRecord[] = [];
  const deadLetters: DeadLetter[] = [];
  const publisherEmail = mj.owner?.email ?? null;

  if (fatal) {
    for (const e of limited) {
      deadLetters.push(toDeadLetter(ctx.label, e.name ?? "(unnamed)", mIssues, publisherEmail));
    }
    return { target: ctx.label, marketplaceName: mj.name ?? null, fetchedAt: new Date().toISOString(), total: limited.length, ok: 0, deadLetter: deadLetters.length, records, deadLetters };
  }

  for (const entry of limited) {
    const rec = await ingestEntry(entry, mj, ctx, publisherEmail);
    if (rec.record) records.push(rec.record);
    if (rec.deadLetter) deadLetters.push(rec.deadLetter);
  }
  return {
    target: ctx.label,
    marketplaceName: mj.name ?? null,
    fetchedAt: new Date().toISOString(),
    total: limited.length,
    ok: records.length,
    deadLetter: deadLetters.length,
    records,
    deadLetters,
  };
}

async function ingestEntry(
  entry: MarketplaceEntry,
  mj: MarketplaceJson,
  ctx: { label: string; repo: { owner: string; repo: string }; ref: string; fetchFn: FetchFn; opts: IngestOptions },
  publisherEmail: string | null,
): Promise<{ record?: SkillRecord; deadLetter?: DeadLetter }> {
  const { fetchFn, opts } = ctx;
  const name = (entry.name ?? "(unnamed)").toLowerCase();
  const issues = [...validateEntry(entry)];
  const resolved = resolveSource(entry, ctx.repo);
  const owner = resolved.identityOwner;
  const id = `${owner}/${name}`;
  const files: SourceFile[] = [];
  let pluginJson: PluginJson | null = null;
  const frontmatters: import("./declaration.js").SkillFrontmatter[] = [];

  if (!resolved.pointerOnly && resolved.repo) {
    const ref = resolved.ref ?? ctx.ref;
    const base = resolved.path;
    // plugin.json
    const pjPath = base ? `${base}/.claude-plugin/plugin.json` : ".claude-plugin/plugin.json";
    const pjText = await fetchText(fetchFn, rawUrl(resolved.repo, ref, pjPath));
    if (pjText !== null) {
      files.push({ path: pjPath, content: pjText });
      try {
        pluginJson = JSON.parse(pjText) as PluginJson;
        issues.push(...validatePluginJson(pluginJson));
      } catch {
        issues.push({ severity: "error", code: "pluginjson-parse", message: "plugin.json is not valid JSON" });
      }
    } else if (entry.strict !== false) {
      issues.push({ severity: "error", code: "pluginjson-missing", message: `plugin.json not found at ${pjPath} in ${resolved.repo}@${ref}` });
    } else {
      issues.push({ severity: "warning", code: "pluginjson-absent-strict-false", message: "no plugin.json at source root; marketplace entry is strict:false and defines components inline" });
    }
    // SKILL.md files from discoverable skill paths (entry.skills + plugin.json.skills)
    const skillPaths = new Set<string>();
    for (const s of stringArray(entry.skills)) skillPaths.add(normPath(s));
    const pjSkills = pluginJson?.skills;
    for (const s of Array.isArray(pjSkills) ? pjSkills : pjSkills ? [pjSkills] : []) skillPaths.add(normPath(String(s)));
    for (const sp of skillPaths) {
      // Skill paths in a marketplace entry are relative to the marketplace repo root
      // when the plugin source is the root, else relative to the plugin dir.
      const candidates = base === "" || sp.startsWith(base)
        ? [`${sp}/SKILL.md`]
        : [`${base}/${sp}/SKILL.md`, `${sp}/SKILL.md`];
      let got: string | null = null;
      let gotPath = "";
      for (const c of candidates) {
        got = await fetchText(fetchFn, rawUrl(resolved.repo, ref, c));
        if (got !== null) { gotPath = c; break; }
      }
      if (got !== null) {
        files.push({ path: gotPath, content: got });
        const v = validateSkillMd(got);
        issues.push(...v.issues);
        if (v.frontmatter) frontmatters.push(v.frontmatter);
      } else {
        issues.push({ severity: "warning", code: "skill-unreachable", message: `SKILL.md not reachable for skill path "${sp}"` });
      }
    }
    var effectiveRef = ref;
  } else {
    var effectiveRef = resolved.ref ?? ctx.ref;
  }

  const validation = resultFor(name, issues);
  if (!validation.ok) {
    return { deadLetter: toDeadLetter(ctx.label, name, issues, publisherEmail) };
  }

  const declaration = deriveDeclaration({
    pluginJson,
    entryComponents: { skills: entry.skills, commands: entry.commands, agents: entry.agents },
    skillFrontmatters: frontmatters,
    pluginJsonSource: pluginJson ? `plugin.json in ${resolved.repo ?? ctx.label}` : `marketplace entry in ${ctx.label} (no plugin.json reachable)`,
  });

  const hash = files.length ? contentHash(files) : contentHash([{ path: "marketplace-entry.json", content: JSON.stringify(entry) }]);
  const attestation = signAttestation(opts.registryKey, id, effectiveRef, hash);

  // Component collections are normalized through normalizeComponents:
  // a marketplace entry may carry a bare string ("./commands/") where
  // the model wants an array, and storing it verbatim crashes array
  // consumers at render time (the aaron-marketing page 500).
  const components = normalizeComponents({
    skills: [...stringArray(entry.skills), ...frontmatters.map((f) => String(f.name))],
    commands: entry.commands,
    agents: entry.agents,
    hooks: Boolean(pluginJson?.hooks),
    mcpServers: pluginJson?.mcpServers && typeof pluginJson.mcpServers === "object" ? Object.keys(pluginJson.mcpServers) : [],
  });
  const kind: SkillRecord["kind"] = components.mcpServers.length && !components.skills.length
    ? "mcp"
    : components.agents.length && !components.skills.length ? "agent" : "plugin";

  const record: SkillRecord = {
    id,
    owner,
    name,
    url: canonicalUrl(owner, name),
    profileUrl: profileUrl(owner),
    kind,
    // Guarded pick: a debris/empty entry description falls through to
    // plugin.json's instead of being stored verbatim.
    description: usableDescription(entry.description, pluginJson?.description),
    sourceType: resolved.sourceType,
    source: entry.source,
    sourceRepo: resolved.repo,
    sourcePath: resolved.path,
    sourceMarketplace: ctx.label,
    ref: effectiveRef,
    pointerOnly: resolved.pointerOnly,
    components,
    declaration,
    validation,
    attestation,
    filesHashed: files.map((f) => f.path),
    status: "listed",
    ingestedAt: new Date().toISOString(),
  };
  return { record };
}
