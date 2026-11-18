// Repo scan: standalone skills that live in a GitHub repo as SKILL.md
// directories WITHOUT any marketplace.json or plugin.json (entry path 3).
// One recursive git-tree call finds every SKILL.md; each skill is validated,
// declared, hashed and attested exactly like a marketplace entry. One bad
// skill → dead letter, never a failed scan.
//
// Identity rule (standalone): owner = repo owner. name = the SKILL.md
// frontmatter `name` when it is a clean slug, else the directory name; for a
// root SKILL.md, the repo name when the frontmatter name is not a clean slug.

import type { FetchFn, SkillRecord, IngestSummary, SourceFile, DeadLetter } from "./types.js";
import { validateSkillMd, resultFor, toDeadLetter, usableDescription, bodyDescription } from "./validate.js";
import { deriveDeclaration, type SkillFrontmatter } from "./declaration.js";
import { contentHash, signAttestation, type RegistryKey } from "./attest.js";
import { canonicalUrl, profileUrl, isValidSkillName } from "./namespace.js";
import { defaultFetch, fetchText, rawUrl, defaultBranch } from "./ingest.js";

export const MAX_SKILLS_PER_SCAN = 200;
export const MAX_SIBLINGS_PER_SKILL = 20;
export const MAX_FILE_BYTES = 200_000;

export interface RepoScanOptions {
  fetchFn?: FetchFn;
  registryKey: RegistryKey;
  ref?: string;
  limit?: number;
}

interface TreeItem {
  path?: string;
  type?: string;
  size?: number;
}

/** Scan a GitHub repo (owner/repo) for standalone SKILL.md skills. */
export async function scanGithubRepoSkills(ownerRepo: string, opts: RepoScanOptions): Promise<IngestSummary> {
  const [owner, repo] = ownerRepo.toLowerCase().split("/");
  const label = `${owner}/${repo}`;
  const scanLabel = `direct-repo-scan:${label}`;
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const ref = opts.ref ?? (await defaultBranch(fetchFn, label));
  const fetchedAt = new Date().toISOString();
  const empty = (note: string): IngestSummary => ({
    target: label, marketplaceName: null, fetchedAt, total: 0, ok: 0, deadLetter: 0, records: [], deadLetters: [], note,
  });

  // One API call for the whole repo tree.
  let tree: TreeItem[] = [];
  let treeTruncated = false;
  try {
    const res = await fetchFn(`https://api.github.com/repos/${label}/git/trees/${ref}?recursive=1`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) return empty(`git tree fetch failed for ${label}@${ref} (HTTP ${res.status})`);
    const j = (await res.json()) as { tree?: TreeItem[]; truncated?: boolean };
    tree = Array.isArray(j.tree) ? j.tree : [];
    treeTruncated = Boolean(j.truncated);
  } catch (e) {
    return empty(`git tree fetch failed for ${label}@${ref} (${(e as Error).message})`);
  }

  const isBlob = (t: TreeItem) => t.type === undefined || t.type === "blob";
  const skillPaths = tree
    .filter((t) => isBlob(t) && typeof t.path === "string" && (t.path === "SKILL.md" || t.path!.endsWith("/SKILL.md")))
    .map((t) => t.path as string)
    .sort();
  const cap = Math.min(opts.limit ?? MAX_SKILLS_PER_SCAN, MAX_SKILLS_PER_SCAN);
  const selected = skillPaths.slice(0, cap);

  const notes: string[] = [];
  if (skillPaths.length > selected.length) {
    notes.push(`scan truncated: ${skillPaths.length} SKILL.md files found in ${label}, capped at ${cap}`);
  }
  if (treeTruncated) {
    notes.push(`git tree response for ${label}@${ref} was truncated by the GitHub API — scan may be incomplete`);
  }

  const records: SkillRecord[] = [];
  const deadLetters: DeadLetter[] = [];
  const seenNames = new Set<string>();

  for (const skillPath of selected) {
    const dir = skillPath === "SKILL.md" ? "" : skillPath.slice(0, -"/SKILL.md".length);
    const dirBase = dir === "" ? repo : dir.split("/").pop()!.toLowerCase();
    const text = await fetchText(fetchFn, rawUrl(label, ref, skillPath));
    if (text === null) {
      deadLetters.push(toDeadLetter(scanLabel, dirBase, [{
        severity: "error", code: "skill-fetch",
        message: `SKILL.md not reachable at ${skillPath} in ${label}@${ref}`,
      }], null));
      continue;
    }

    const v = validateSkillMd(text);
    const issues = [...v.issues];
    const fm: SkillFrontmatter | null = v.frontmatter;
    const fmName = typeof fm?.name === "string" ? fm.name : undefined;
    const name = fmName && isValidSkillName(fmName) ? fmName : dirBase;
    const id = `${owner}/${name}`;

    if (seenNames.has(name)) {
      deadLetters.push(toDeadLetter(scanLabel, name, [{
        severity: "error", code: "skill-duplicate-name",
        message: `duplicate skill name in repo scan: "${name}" already provided by an earlier SKILL.md in ${label}`,
      }], null));
      continue;
    }
    seenNames.add(name);

    const validation = resultFor(name, issues);
    if (!validation.ok) {
      deadLetters.push(toDeadLetter(scanLabel, name, issues, null));
      continue;
    }

    // Hash the SKILL.md plus its sibling files in the same directory.
    const files: SourceFile[] = [{ path: skillPath, content: text }];
    const siblings = tree
      .filter((t) => {
        if (!isBlob(t) || typeof t.path !== "string" || t.path === skillPath) return false;
        const parent = t.path.includes("/") ? t.path.slice(0, t.path.lastIndexOf("/")) : "";
        if (parent !== dir) return false;
        return !(typeof t.size === "number" && t.size > MAX_FILE_BYTES);
      })
      .map((t) => t.path as string)
      .sort()
      .slice(0, MAX_SIBLINGS_PER_SKILL);
    for (const sp of siblings) {
      const content = await fetchText(fetchFn, rawUrl(label, ref, sp));
      if (content === null) continue;
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) continue;
      files.push({ path: sp, content });
    }

    const declaration = deriveDeclaration({
      pluginJson: null,
      entryComponents: { skills: [dir === "" ? name : dir] },
      skillFrontmatters: fm ? [fm] : [],
      pluginJsonSource: `repo scan of ${label} (no marketplace.json / plugin.json — standalone skill)`,
    });

    const hash = contentHash(files);
    const attestation = signAttestation(opts.registryKey, id, ref, hash);

    records.push({
      id,
      owner,
      name,
      url: canonicalUrl(owner, name),
      profileUrl: profileUrl(owner),
      kind: "skill",
      // Description chain: frontmatter description, else the SKILL.md
      // body's first heading/paragraph. Debris values a source may carry
      // literally (`description: ---`) are rejected by usableDescription
      // and fall through instead of being listed as the description.
      description: usableDescription(
        typeof fm?.description === "string" ? fm.description : undefined,
        bodyDescription(text),
      ),
      sourceType: "github",
      source: dir === "" ? "./" : dir,
      sourceRepo: label,
      sourcePath: dir,
      sourceMarketplace: scanLabel,
      // The trees response carries no sha for a branch ref, so ref is the
      // resolved branch name in P0 (tag/SHA pinning arrives with releases).
      ref,
      pointerOnly: false,
      components: { skills: [name], commands: [], agents: [], hooks: false, mcpServers: [] },
      declaration,
      validation,
      attestation,
      filesHashed: files.map((f) => f.path),
      status: "listed",
      ingestedAt: new Date().toISOString(),
    });
  }

  return {
    target: label,
    marketplaceName: null,
    fetchedAt,
    total: selected.length,
    ok: records.length,
    deadLetter: deadLetters.length,
    records,
    deadLetters,
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };
}
