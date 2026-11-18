// MCP Registry → SkillRecord (Phase 2). The official MCP Registry
// (registry.modelcontextprotocol.io) is a metadata feed built for
// aggregators: each entry is a server.json describing packages
// (npm/PyPI/OCI/…) or remote endpoints — never code we host. The
// record built here is a POINTER: identity mapped from the registry
// namespace (documented below), declaration derived from the
// server.json alone, attestation = the registry signature pattern
// reused — ed25519 over the sha256 of the canonical server.json.

import type { Declaration, FetchFn, SkillRecord } from "../../types.js";
import { contentHash, signAttestation, type RegistryKey } from "../../attest.js";
import { canonicalUrl, profileUrl, isValidOwnerSlug, isValidSkillName } from "../../namespace.js";
import { resultFor, usableDescription } from "../../validate.js";
import { parseGithubRepo } from "./npm-record.js";
import { stableStringify } from "./canonical-json.js";

export const MCP_REGISTRY_BASE = "https://registry.modelcontextprotocol.io";

/** The subset of server.json the mapping reads (schema 2025-09/11). */
export interface McpServerJson {
  name: string;
  description?: string;
  title?: string;
  version?: string;
  repository?: { url?: string; source?: string };
  packages?: {
    registryType?: string;
    registry_name?: string;
    identifier?: string;
    name?: string;
    version?: string;
    transport?: { type?: string };
  }[];
  remotes?: { type?: string; url?: string }[];
  [k: string]: unknown;
}

/** Slugify for owner position: lowercase, non [a-z0-9-] runs → "-",
 *  collapsed, trimmed; must satisfy GitHub-login-ish rules. */
export function slugifyOwner(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 39) s = s.slice(0, 39).replace(/-+$/g, "");
  if (!s || !isValidOwnerSlug(s)) return "mcp";
  return s;
}

/** Slugify for name position (skill-name rules: dots/underscores ok). */
export function slugifyName(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "");
  if (s.length > 100) s = s.slice(0, 100);
  if (!s || !isValidSkillName(s)) return "mcp-server";
  return s;
}

/**
 * Registry-name → talents owner/name mapping (documented rule):
 *   - The namespace is the part before the first "/". Split it on
 *     "." and take the LAST label as the owner:
 *       io.github.dba-i        → dba-i        (GitHub user/org)
 *       com.airtable           → airtable
 *       ai.bowmark             → bowmark
 *       io.modelcontextprotocol → modelcontextprotocol
 *     For io.github.* the last label IS the GitHub login, so GitHub
 *     publishers land in their own namespace with no special case.
 *   - The name is everything after the first "/", slugified.
 * Collisions with an existing GitHub-sourced record id are resolved
 * by the CALLER (buildMcpRecord's `collides` flag): owner gains a
 * "-mcp" suffix, and only then.
 */
export function mapMcpIdentity(registryName: string): { owner: string; name: string } {
  const slash = registryName.indexOf("/");
  const namespace = slash >= 0 ? registryName.slice(0, slash) : registryName;
  const rest = slash >= 0 ? registryName.slice(slash + 1) : "server";
  const labels = namespace.split(".").filter(Boolean);
  const owner = slugifyOwner(labels[labels.length - 1] ?? namespace);
  return { owner, name: slugifyName(rest) };
}

/** The nomination quality bar: an entry is ingestible only with a
 *  real distribution channel AND something to say about itself. */
export function mcpQualityBar(server: McpServerJson): { ok: boolean; reason: string } {
  const desc = (server.description ?? "").trim();
  const hasRepo = Boolean(server.repository?.url);
  const hasRemote = Boolean(server.remotes?.some((r) => r.url));
  const hasPackage = Boolean(server.packages?.some((p) => p.identifier || p.name));
  if (!hasRepo && !hasRemote && !hasPackage) {
    return { ok: false, reason: "no repository, remote endpoint, or package — nothing to point at" };
  }
  if (desc.length < 24) {
    return { ok: false, reason: `description too thin (${desc.length} chars) to derive a declaration from` };
  }
  return { ok: true, reason: "repository/remote/package + description present" };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function buildMcpRecord(
  server: McpServerJson,
  key: RegistryKey,
  opts: { now?: Date; collides?: boolean } = {},
): SkillRecord {
  const now = opts.now ?? new Date();
  const mapped = mapMcpIdentity(server.name ?? "");
  const owner = opts.collides ? slugifyOwner(`${mapped.owner}-mcp`) : mapped.owner;
  const name = mapped.name;
  const id = `${owner}/${name}`;
  const version = server.version ?? "latest";

  const remotes = (server.remotes ?? []).filter((r) => r.url);
  const packages = (server.packages ?? []).filter((p) => p.identifier || p.name);
  const repoUrl = server.repository?.url;
  const repo = repoUrl ? parseGithubRepo(repoUrl) : null;

  // Declaration derived from server.json only. Tools are NOT in the
  // descriptor — that stays explicitly undeclared, never guessed.
  const lines: Declaration["lines"] = [];
  const summary: string[] = [];
  for (const r of remotes) {
    lines.push({ kind: "network", text: `Connects to a remote MCP server at ${hostOf(r.url!)} (${r.url})` });
    summary.push(`Talks to a remote MCP server: ${hostOf(r.url!)}`);
  }
  for (const p of packages) {
    const registry = p.registryType ?? p.registry_name ?? "package";
    const ident = p.identifier ?? p.name ?? "";
    lines.push({ kind: "tool", text: `Runs an MCP server package (${registry}:${ident}${p.version ? `@${p.version}` : ""})` });
    summary.push(`Starts a local MCP server from a ${registry} package: ${ident}`);
  }
  const undeclared = [
    "The MCP registry does not publish this server's tool list — which tools it exposes, and what they can access, is undeclared",
  ];
  for (const u of undeclared) lines.push({ kind: "undeclared", text: `Undeclared: ${u}` });
  if (!summary.length) summary.push("No derived permissions — see undeclared items");
  const declaration: Declaration = {
    lines,
    summary,
    undeclared,
    derivedFrom: [`server.json in the official MCP registry (${server.name}@${version})`],
  };

  const issues = opts.collides
    ? [{
        severity: "warning" as const,
        code: "namespace-collision",
        message: `registry identity ${mapped.owner}/${name} already exists from a GitHub source — this MCP record is namespaced ${id}`,
      }]
    : [];

  const hash = contentHash([{ path: "server.json", content: stableStringify(server) }]);
  const primaryPkg = packages[0];
  const sourceType: SkillRecord["sourceType"] = primaryPkg
    ? ((primaryPkg.registryType ?? "") === "npm" ? "npm" : "git")
    : repo ? "git" : "command";

  return {
    id,
    owner,
    name,
    url: canonicalUrl(owner, name),
    profileUrl: profileUrl(owner),
    kind: "mcp",
    description: usableDescription(server.description),
    sourceType,
    source: server,
    sourceRepo: repo ?? undefined,
    sourcePath: "",
    sourceMarketplace: "mcp-registry",
    ref: version,
    pointerOnly: true,
    components: { skills: [], commands: [], agents: [], hooks: false, mcpServers: [name] },
    declaration,
    validation: resultFor(name, issues),
    attestation: signAttestation(key, id, version, hash),
    filesHashed: ["server.json"],
    status: "listed",
    ingestedAt: now.toISOString(),
  };
}

/** Fetch one server's latest server.json from the registry. */
export async function fetchMcpServer(fetchFn: FetchFn, registryName: string): Promise<McpServerJson | null> {
  const url = `${MCP_REGISTRY_BASE}/v0.1/servers/${encodeURIComponent(registryName)}/versions/latest`;
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { server?: McpServerJson };
    return j.server ?? null;
  } catch {
    return null;
  }
}
