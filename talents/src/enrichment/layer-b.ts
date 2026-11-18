// Layer B — STRUCTURAL DEEPENING (ENRICHMENT.md §B), class: derived.
// Deterministic extraction from the same source artefacts ingest
// already reads: collections/plugins expand into a per-item
// sub-inventory, SKILL.md files get a full parse, plugin.json yields
// its publisher metadata, MCP package records yield transport + the
// NAMES of the environment variables they require (never values).
//
// Known ingest artifact (documented, NOT fixed here): some records'
// stored description is literally "---". When the B parse reads the
// real frontmatter description for such a record it is recorded as
// `skillParse.parsedDescription` — a candidate for the later ingest
// fix, never silently substituted into the record.

import type { FetchFn, SkillRecord } from "../types.js";
import { fetchText, rawUrl } from "../ingest.js";
import type { LayerB, McpPackageFacts, PluginMeta, SkillParse, SubInventoryEntry } from "./types.js";

/** Max source files fetched for sub-inventory descriptions per record. */
export const MAX_INVENTORY_FETCHES = 60;
/** Max sub-inventory entries stored per record. */
export const MAX_INVENTORY_ENTRIES = 200;

// ---------------------------------------------------------------------------
// SKILL.md full parse (pure)
// ---------------------------------------------------------------------------

export interface SkillMdFull {
  frontmatter: SkillParse["frontmatter"];
  body: string;
}

/** Frontmatter parser that goes beyond validate.ts's flat scalars:
 *  inline arrays (`[a, b]`), block lists (`- item`), and
 *  comma-separated `allowed-tools` all normalize to string arrays. */
export function parseSkillMdFull(md: string): SkillMdFull | null {
  if (!md.startsWith("---")) return null;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = md.slice(3, end);
  const body = md.slice(end + 4).replace(/^\n+/, "");
  const fm: Record<string, unknown> = {};
  let listKey: string | null = null;
  const unquote = (v: string): string =>
    (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (fm[listKey] as string[]).push(unquote(item[1].trim()));
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) { listKey = null; continue; }
    const key = m[1];
    listKey = null;
    const v = m[2].trim();
    if (v === "") {
      // Possibly a block list follows; start an array, replaced by a
      // scalar if a continuation line turns out to be prose.
      fm[key] = [];
      listKey = key;
    } else if (v.startsWith("[") && v.endsWith("]")) {
      fm[key] = v.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
    } else {
      fm[key] = unquote(v);
    }
  }
  // Keys left as empty arrays (declared, no items) become "" scalars.
  for (const k of Object.keys(fm)) if (Array.isArray(fm[k]) && (fm[k] as unknown[]).length === 0) fm[k] = "";
  // allowed-tools is commonly a comma-separated scalar.
  const at = fm["allowed-tools"];
  if (typeof at === "string" && at) {
    fm["allowed-tools"] = at.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const frontmatter: SkillParse["frontmatter"] = {
    ...(fm as Record<string, unknown>),
    ...(typeof fm.name === "string" ? { name: fm.name } : {}),
    ...(typeof fm.description === "string" ? { description: fm.description } : {}),
    ...(Array.isArray(fm["allowed-tools"]) ? { allowedTools: fm["allowed-tools"] as string[] } : {}),
    ...(typeof fm.model === "string" ? { model: fm.model } : {}),
    ...(typeof fm.license === "string" ? { license: fm.license } : {}),
  };
  return { frontmatter, body };
}

/** Analyze a SKILL.md body: size, referenced local files, external URLs. */
export function analyzeSkillBody(body: string): {
  instructionLines: number;
  tokenEstimate: number;
  referencedFiles: string[];
  externalUrls: string[];
} {
  const referenced = new Set<string>();
  for (const m of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1].split("#")[0];
    if (!target || /^https?:\/\//.test(target) || target.startsWith("mailto:")) continue;
    referenced.add(target);
  }
  const urls = new Set<string>();
  for (const m of body.matchAll(/https?:\/\/[^\s)>"']+/g)) {
    urls.add(m[0].replace(/[.,;]+$/, ""));
  }
  return {
    instructionLines: body.split("\n").length,
    tokenEstimate: Math.round(body.length / 4),
    referencedFiles: [...referenced].slice(0, 100),
    externalUrls: [...urls].slice(0, 50),
  };
}

export function parseSkill(path: string, md: string, recordDescription: string): SkillParse | null {
  const full = parseSkillMdFull(md);
  if (!full) return null;
  const analysis = analyzeSkillBody(full.body);
  const parse: SkillParse = {
    path,
    frontmatter: full.frontmatter,
    ...analysis,
  };
  // The "---" ingest artifact: record the real description as a
  // candidate for the later ingest fix (see module header).
  if (recordDescription.trim() === "---" && typeof full.frontmatter.description === "string" && full.frontmatter.description) {
    parse.parsedDescription = full.frontmatter.description;
  }
  return parse;
}

// ---------------------------------------------------------------------------
// Sub-inventory (pure candidate collection + assembly)
// ---------------------------------------------------------------------------

export interface InventoryCandidate {
  kind: SubInventoryEntry["kind"];
  name: string;
  /** File to fetch for the description (SKILL.md for skills, the
   *  .md file itself for agents/commands). */
  fetchPath: string;
  /** Path reported in the entry (the skill's directory for skills). */
  path: string;
}

const inBase = (p: string, base: string): boolean => !base || p === base || p.startsWith(`${base}/`);
const rel = (p: string, base: string): string => (base && p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p);

/** Collect sub-inventory candidates from a repo tree listing,
 *  scoped to the record's base path inside the repo. */
export function collectInventoryCandidates(treePaths: string[], base: string): InventoryCandidate[] {
  const out: InventoryCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: InventoryCandidate) => {
    const key = `${c.kind}:${c.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const p of treePaths) {
    if (!inBase(p, base)) continue;
    const r = rel(p, base);
    if (r.endsWith("/SKILL.md") || r === "SKILL.md") {
      const dir = r === "SKILL.md" ? "" : r.slice(0, -"/SKILL.md".length);
      const name = dir === "" ? "(root)" : dir.split("/").pop()!.toLowerCase();
      if (dir !== "") push({ kind: "skill", name, fetchPath: p, path: base ? `${base}/${dir}` : dir });
      else push({ kind: "skill", name, fetchPath: p, path: base || "." });
      continue;
    }
    const seg = r.split("/");
    if (seg.includes("agents") && r.endsWith(".md")) {
      push({ kind: "agent", name: seg[seg.length - 1].replace(/\.md$/, "").toLowerCase(), fetchPath: p, path: p });
    } else if (seg.includes("commands") && r.endsWith(".md")) {
      push({ kind: "command", name: seg[seg.length - 1].replace(/\.md$/, "").toLowerCase(), fetchPath: p, path: p });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** One-line description from a fetched file: frontmatter description
 *  for skills; first heading / first prose line for agents/commands. */
export function inventoryDescription(kind: SubInventoryEntry["kind"], content: string): string {
  if (kind === "skill") {
    const full = parseSkillMdFull(content);
    const d = full && typeof full.frontmatter.description === "string" ? full.frontmatter.description : "";
    return d.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  const lines = content.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) return t.replace(/^#+\s*/, "").slice(0, 200);
    if (t === "---") continue;
    if (/^[A-Za-z0-9_-]+:\s/.test(t)) continue; // frontmatter scalar
    return t.replace(/[*_>`]/g, "").slice(0, 200);
  }
  return "";
}

export function buildSubInventory(
  candidates: InventoryCandidate[],
  contents: Map<string, string>,
): { entries: SubInventoryEntry[]; truncated: boolean } {
  const truncated = candidates.length > MAX_INVENTORY_ENTRIES;
  const entries = candidates.slice(0, MAX_INVENTORY_ENTRIES).map((c) => ({
    kind: c.kind,
    name: c.name,
    description: contents.has(c.fetchPath) ? inventoryDescription(c.kind, contents.get(c.fetchPath)!) : "",
    path: c.path,
  }));
  return { entries, truncated };
}

// ---------------------------------------------------------------------------
// Plugin metadata + MCP package facts (pure)
// ---------------------------------------------------------------------------

export function parsePluginMeta(pj: Record<string, unknown>): PluginMeta {
  const meta: PluginMeta = {};
  const author = pj.author;
  if (typeof author === "string") meta.author = author;
  else if (author && typeof author === "object" && typeof (author as { name?: unknown }).name === "string") {
    meta.author = (author as { name: string }).name;
  }
  if (typeof pj.homepage === "string") meta.homepage = pj.homepage;
  const repo = pj.repository;
  if (typeof repo === "string") meta.repository = repo;
  else if (repo && typeof repo === "object" && typeof (repo as { url?: unknown }).url === "string") {
    meta.repository = (repo as { url: string }).url;
  }
  if (Array.isArray(pj.keywords)) meta.keywords = pj.keywords.filter((k): k is string => typeof k === "string").slice(0, 20);
  return meta;
}

/** MCP package facts from a registry server.json: transport +
 *  environment variable NAMES from the package declarations. */
export function mcpFactsFromServerJson(server: Record<string, unknown>): McpPackageFacts {
  const packages = Array.isArray(server.packages) ? (server.packages as Record<string, unknown>[]) : [];
  const remotes = Array.isArray(server.remotes) ? (server.remotes as Record<string, unknown>[]) : [];
  const envVars = new Set<string>();
  for (const p of packages) {
    const evs = p.environmentVariables;
    if (Array.isArray(evs)) {
      for (const ev of evs) {
        if (ev && typeof ev === "object" && typeof (ev as { name?: unknown }).name === "string") {
          envVars.add((ev as { name: string }).name);
        }
      }
    }
  }
  const first = packages[0];
  const transport = first
    ? String((first.transport as { type?: string } | undefined)?.type ?? "stdio")
    : remotes.length ? String(remotes[0].type ?? "http") : "unknown";
  return {
    ...(first && typeof (first.identifier ?? first.name) === "string"
      ? { packageName: (first.identifier ?? first.name) as string }
      : {}),
    ...(first && typeof first.version === "string" ? { version: first.version } : {}),
    ...(first ? { registry: String(first.registryType ?? first.registry_name ?? "package") } : {}),
    transport,
    envVars: [...envVars].sort(),
  };
}

/** MCP package facts from a plugin.json `mcpServers` block (first
 *  server — the record's primary): transport + env var NAMES from
 *  its `env` block (names only; values are never read into output). */
export function mcpFactsFromPluginJson(pj: Record<string, unknown>): McpPackageFacts | null {
  const servers = pj.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  const names = Object.keys(servers as Record<string, unknown>);
  if (!names.length) return null;
  const cfg = (servers as Record<string, Record<string, unknown>>)[names[0]] ?? {};
  const transport = typeof cfg.type === "string" ? cfg.type : typeof cfg.url === "string" ? "http" : "stdio";
  const envVars = cfg.env && typeof cfg.env === "object" ? Object.keys(cfg.env as Record<string, unknown>).sort() : [];
  return { packageName: names[0], transport, envVars };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface LayerBDeps {
  fetchFn: FetchFn;
}

interface TreeItem { path?: string; type?: string }

async function fetchTree(fetchFn: FetchFn, repo: string, ref: string): Promise<{ paths: string[]; truncated: boolean }> {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`git tree ${repo}@${ref}: HTTP ${res.status}`);
  const j = (await res.json()) as { tree?: TreeItem[]; truncated?: boolean };
  const paths = (j.tree ?? []).filter((t) => typeof t.path === "string" && (t.type === undefined || t.type === "blob")).map((t) => t.path!);
  return { paths, truncated: Boolean(j.truncated) };
}

const isServerJsonSource = (record: SkillRecord): boolean =>
  record.filesHashed.includes("server.json")
  || (record.source !== null && typeof record.source === "object" && "packages" in (record.source as object) && "name" in (record.source as object));

/**
 * Run Layer B for one record.
 *   - server.json records (MCP registry): facts from the stored
 *     descriptor — no fetch needed.
 *   - GitHub records: re-fetch the pinned tree via the same API the
 *     repo scan uses, expand the sub-inventory under the record's
 *     base path, fully parse the record's primary SKILL.md, and read
 *     plugin.json metadata when present.
 *   - Pointer-only records with no tree: `none` with a reason.
 */
export async function runLayerB(
  record: SkillRecord,
  deps: LayerBDeps,
  now: Date,
): Promise<{ state: "done" | "partial" | "none"; payload: LayerB }> {
  const payload: LayerB = { derivedAt: now.toISOString() };
  const errors: string[] = [];

  if (isServerJsonSource(record)) {
    payload.mcpPackage = mcpFactsFromServerJson(record.source as Record<string, unknown>);
    return { state: "done", payload };
  }

  const repo = record.sourceRepo;
  if (!repo || record.pointerOnly) {
    payload.reason = record.pointerOnly
      ? "pointer-only record — no source tree to parse"
      : "no GitHub source repo — nothing to expand";
    return { state: "none", payload };
  }

  const base = record.sourcePath ?? "";
  let tree: { paths: string[]; truncated: boolean } | null = null;
  try {
    tree = await fetchTree(deps.fetchFn, repo, record.ref);
  } catch (e) {
    errors.push(`tree: ${(e as Error).message}`);
  }

  // plugin.json: metadata + MCP package facts.
  const pjPath = base ? `${base}/.claude-plugin/plugin.json` : ".claude-plugin/plugin.json";
  const pjText = record.filesHashed.includes(pjPath) || !tree || tree.paths.includes(pjPath)
    ? await fetchText(deps.fetchFn, rawUrl(repo, record.ref, pjPath))
    : null;
  if (pjText) {
    try {
      const pj = JSON.parse(pjText) as Record<string, unknown>;
      const meta = parsePluginMeta(pj);
      if (Object.keys(meta).length) payload.pluginMeta = meta;
      const mcp = mcpFactsFromPluginJson(pj);
      if (mcp) payload.mcpPackage = mcp;
    } catch {
      errors.push("plugin.json: present but not parseable JSON");
    }
  }

  // Primary SKILL.md full parse: prefer the record's own directory,
  // then any SKILL.md in filesHashed, then the tree.
  const skillCandidates: string[] = [];
  const ownSkill = base ? `${base}/SKILL.md` : "SKILL.md";
  skillCandidates.push(ownSkill);
  for (const f of record.filesHashed) if (f.endsWith("SKILL.md") && !skillCandidates.includes(f)) skillCandidates.push(f);
  if (tree) for (const p of tree.paths) if (p.endsWith("/SKILL.md") || p === "SKILL.md") { if (!skillCandidates.includes(p)) skillCandidates.push(p); }
  for (const path of skillCandidates.slice(0, 4)) {
    const text = await fetchText(deps.fetchFn, rawUrl(repo, record.ref, path));
    if (text === null) continue;
    const parse = parseSkill(path, text, record.description);
    if (parse) {
      payload.skillParse = parse;
      break;
    }
  }

  // Sub-inventory from the tree, scoped to the record's base path.
  // A lone root SKILL.md (a standalone skill record) is not an
  // inventory — the skillParse above already covers it.
  if (tree) {
    const candidates = collectInventoryCandidates(tree.paths, base);
    const loneRootSkill = candidates.length === 1 && candidates[0].kind === "skill"
      && (base === "" ? candidates[0].fetchPath === "SKILL.md" : candidates[0].fetchPath === `${base}/SKILL.md`);
    if (candidates.length && !loneRootSkill) {
      const contents = new Map<string, string>();
      let fetches = 0;
      for (const c of candidates) {
        if (fetches >= MAX_INVENTORY_FETCHES) break;
        const text = await fetchText(deps.fetchFn, rawUrl(repo, record.ref, c.fetchPath));
        fetches++;
        if (text !== null) contents.set(c.fetchPath, text);
      }
      const { entries, truncated } = buildSubInventory(candidates, contents);
      payload.subInventory = entries;
      if (truncated || tree.truncated || fetches < candidates.length) payload.subInventoryTruncated = true;
    }
    if (tree.truncated) errors.push("git tree response was truncated by the GitHub API — inventory may be incomplete");
  }

  if (errors.length) payload.errors = errors;
  const produced = Boolean(payload.subInventory?.length || payload.skillParse || payload.pluginMeta || payload.mcpPackage);
  if (!produced && !tree) return { state: "partial", payload };
  if (!produced) {
    payload.reason = "source tree fetched but no parseable SKILL.md / plugin.json / inventory found";
    return { state: "partial", payload };
  }
  return { state: errors.length || payload.subInventoryTruncated ? "partial" : "done", payload };
}
