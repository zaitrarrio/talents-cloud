// npm → pointer SkillRecord (Phase 2). Most npm-discovered skills
// resolve to a GitHub repo and ingest through the repo path; the
// packages that DON'T link a repo still deserve a catalog presence:
// a pointer record built from registry metadata alone — the
// registry never hosts the package, the declaration says only what
// the metadata supports, and the attestation signs that metadata.

import type { Declaration, FetchFn, SkillRecord } from "../../types.js";
import { contentHash, signAttestation, type RegistryKey } from "../../attest.js";
import { canonicalUrl, profileUrl } from "../../namespace.js";
import { resultFor, usableDescription } from "../../validate.js";
import { slugifyName, slugifyOwner } from "./mcp-record.js";
import { stableStringify } from "./canonical-json.js";

/** Parse a GitHub owner/repo out of the many URL shapes npm allows:
 *  git+https://github.com/o/r.git · https://github.com/o/r ·
 *  git@github.com:o/r.git · github:o/r · o/r (bare shorthand in a
 *  repository string). Returns lowercase "owner/repo" or null. */
export function parseGithubRepo(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  const shorthand = s.match(/^github:([^/\s]+)\/([^/\s]+)$/i);
  if (shorthand) return cleanRepo(shorthand[1], shorthand[2]);
  const scp = s.match(/^git@github\.com:([^/\s]+)\/(.+)$/i);
  if (scp) return cleanRepo(scp[1], scp[2]);
  s = s.replace(/^git\+/, "");
  const url = s.match(/^(?:https?|git):\/\/github\.com\/([^/\s]+)\/(.+)$/i);
  if (url) return cleanRepo(url[1], url[2]);
  const bare = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (bare && !s.includes(".")) return cleanRepo(bare[1], bare[2]);
  return null;
}

function cleanRepo(owner: string, repo: string): string | null {
  const r = repo.replace(/\.git$/i, "").replace(/\/+$/, "");
  const o = owner.toLowerCase();
  const n = r.toLowerCase();
  if (!o || !n || n.includes("/")) return null;
  return `${o}/${n}`;
}

export interface NpmPackageMeta {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  repositoryUrl?: string;
  homepage?: string;
  maintainer?: string;
}

/** Normalize an abbreviated (install-v1) or full packument into the
 *  lite shape the pointer builder reads. Pure — exported for tests. */
export function normalizePackument(doc: unknown): NpmPackageMeta | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const name = typeof d.name === "string" ? d.name : "";
  if (!name) return null;
  const distTags = (d["dist-tags"] ?? {}) as Record<string, unknown>;
  const latest = typeof distTags.latest === "string" ? distTags.latest : "";
  const versions = (d.versions ?? {}) as Record<string, Record<string, unknown>>;
  const vdoc: Record<string, unknown> = (latest && versions[latest]) || {};
  const pick = (k: string): string | undefined => {
    const v = d[k] ?? vdoc[k];
    return typeof v === "string" ? v : undefined;
  };
  const repoRaw = (d.repository ?? vdoc.repository) as { url?: string } | string | undefined;
  const repositoryUrl = typeof repoRaw === "string" ? repoRaw : repoRaw?.url;
  const maintainers = (d.maintainers ?? vdoc.maintainers) as { name?: string }[] | undefined;
  const keywords = (d.keywords ?? vdoc.keywords) as unknown;
  return {
    name,
    version: latest || (typeof vdoc.version === "string" ? vdoc.version : "latest"),
    description: pick("description") ?? "",
    keywords: Array.isArray(keywords) ? keywords.filter((k): k is string => typeof k === "string") : [],
    repositoryUrl,
    homepage: pick("homepage"),
    maintainer: Array.isArray(maintainers) ? maintainers.find((m) => m?.name)?.name : undefined,
  };
}

/** Fetch + normalize a package's registry metadata. */
export async function fetchNpmPackage(fetchFn: FetchFn, name: string): Promise<NpmPackageMeta | null> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace(/%40/g, "@").replace(/%2F/g, "%2F")}`;
  try {
    const res = await fetchFn(url, {
      headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
    });
    if (!res.ok) return null;
    return normalizePackument(await res.json());
  } catch {
    return null;
  }
}

/** Does this package present as an MCP server? (keywords/description) */
export function looksLikeMcp(meta: NpmPackageMeta): boolean {
  const kw = meta.keywords.map((k) => k.toLowerCase());
  if (kw.some((k) => k === "mcp" || k === "mcp-server" || k.includes("model-context-protocol"))) return true;
  return /\bmcp\b|model context protocol/i.test(meta.description);
}

/** Identity for a pointer record: scoped packages take their scope
 *  as owner (@modelcontextprotocol/x → modelcontextprotocol);
 *  unscoped packages take the maintainer's npm username; anything
 *  unusable falls back to owner "npm". */
export function npmIdentity(meta: NpmPackageMeta): { owner: string; name: string } {
  if (meta.name.startsWith("@")) {
    const [scope, pkg] = meta.name.slice(1).split("/");
    return { owner: slugifyOwner(scope ?? "npm"), name: slugifyName(pkg ?? meta.name) };
  }
  return {
    owner: meta.maintainer ? slugifyOwner(meta.maintainer) : "npm",
    name: slugifyName(meta.name),
  };
}

/** The description a pointer record carries: the package's own
 *  when it has one; otherwise a factual fallback derived from the
 *  metadata (some packuments ship an empty description, and a
 *  listed record — and its aggregate entry — must describe itself).
 *  The fallback is part of the signed metadata, so the record and
 *  its attestation always agree. */
export function effectiveDescription(meta: NpmPackageMeta, kind: "mcp" | "skill"): string {
  const own = usableDescription(meta.description);
  if (own) return own;
  const kw = meta.keywords.length ? ` Keywords: ${meta.keywords.slice(0, 6).join(", ")}.` : "";
  return kind === "mcp"
    ? `MCP server published on npm as ${meta.name} (the package metadata carries no description).${kw}`
    : `Skill package published on npm as ${meta.name} (the package metadata carries no description).${kw}`;
}

export function buildNpmPointerRecord(
  meta: NpmPackageMeta,
  key: RegistryKey,
  opts: { now?: Date; kind?: "mcp" | "skill" } = {},
): SkillRecord {
  const now = opts.now ?? new Date();
  const kind = opts.kind ?? (looksLikeMcp(meta) ? "mcp" : "skill");
  const description = effectiveDescription(meta, kind);
  const { owner, name } = npmIdentity(meta);
  const id = `${owner}/${name}`;
  const repo = parseGithubRepo(meta.repositoryUrl);

  const lines: Declaration["lines"] = [];
  const summary: string[] = [];
  if (kind === "mcp") {
    lines.push({ kind: "tool", text: `Runs an MCP server published on npm as ${meta.name}@${meta.version}` });
    summary.push(`Starts a local MCP server from npm: ${meta.name}`);
  } else {
    lines.push({ kind: "component", text: `npm package ${meta.name}@${meta.version} — installed from the npm registry, contents not unpacked by Talents` });
    summary.push(`Installs an npm package: ${meta.name}`);
  }
  const undeclared = [
    kind === "mcp"
      ? "Tool list not published in the npm metadata — what this server can access is undeclared"
      : "No SKILL.md or plugin.json was reachable for this package — its contents and tool access are undeclared",
  ];
  for (const u of undeclared) lines.push({ kind: "undeclared", text: `Undeclared: ${u}` });
  const declaration: Declaration = {
    lines,
    summary,
    undeclared,
    derivedFrom: [`npm registry metadata for ${meta.name}`],
  };

  const signedMeta = {
    name: meta.name, version: meta.version, description,
    repository: meta.repositoryUrl ?? null, keywords: meta.keywords,
  };
  const hash = contentHash([{ path: "package.json", content: stableStringify(signedMeta) }]);

  return {
    id,
    owner,
    name,
    url: canonicalUrl(owner, name),
    profileUrl: profileUrl(owner),
    kind,
    description,
    sourceType: "npm",
    source: { source: "npm", package: meta.name, version: meta.version },
    sourceRepo: repo ?? undefined,
    sourcePath: "",
    sourceMarketplace: "npm",
    ref: meta.version,
    pointerOnly: true,
    components: {
      skills: [], commands: [], agents: [], hooks: false,
      mcpServers: kind === "mcp" ? [name] : [],
    },
    declaration,
    validation: resultFor(name, [{
      severity: "warning",
      code: "pointer-only",
      message: "pointer-only record built from npm registry metadata; the package itself was not fetched or hashed",
    }]),
    attestation: signAttestation(key, id, meta.version, hash),
    filesHashed: ["package.json"],
    status: "listed",
    ingestedAt: now.toISOString(),
  };
}
