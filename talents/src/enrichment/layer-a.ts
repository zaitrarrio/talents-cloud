// Layer A — SOURCE facts (ENRICHMENT.md §A). Everything here is
// fetched from the origin (GitHub API / npm registry / raw source
// files) and shown plainly as a fact with an "as of" date. Layer A
// refreshes on cadence (repo stats drift) even when the record's
// source hash is unchanged — see pipeline.ts for the cadence.
//
// Failure discipline: a failed sub-fetch degrades the layer to
// `partial` with the reason recorded; a record is never thrown out
// and the pipeline never throws because an origin is down.

import type { FetchFn, SkillRecord } from "../types.js";
import { rawUrl } from "../ingest.js";
import type { AssetStore, GithubFacts, IconAsset, LayerA, NpmFacts, ReadmeAsset } from "./types.js";

/** README storage cap (bytes) — display asset, not an archive. */
export const README_CAP_BYTES = 64 * 1024;
/** Icon download cap (bytes) — social previews are ~100–300KB. */
export const ICON_CAP_BYTES = 512 * 1024;

export type FetchBytes = (
  url: string,
  timeoutMs?: number,
) => Promise<{ bytes: Uint8Array; contentType: string } | null>;

/** Default binary fetch (global fetch; used by the operator script
 *  and the Worker — ghapi only speaks JSON/text). */
export const defaultFetchBytes: FetchBytes = async (url, timeoutMs = 15_000) => {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "talents-registry-enrich" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > ICON_CAP_BYTES) return null;
    return { bytes: buf, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  } catch {
    return null;
  }
};

/** The npm package a record points at, when one exists: npm pointer
 *  records carry it in `source.package`; MCP registry records carry
 *  it in the server.json package list. Null otherwise. */
export function npmPackageOf(record: SkillRecord): string | null {
  const src = record.source as Record<string, unknown> | string | null;
  if (record.sourceType === "npm" && src && typeof src === "object") {
    const pkg = (src as { package?: unknown }).package;
    if (typeof pkg === "string" && pkg) return pkg;
  }
  if (src && typeof src === "object" && Array.isArray((src as { packages?: unknown }).packages)) {
    for (const p of (src as { packages: Record<string, unknown>[] }).packages) {
      const registry = String(p.registryType ?? p.registry_name ?? "");
      const ident = p.identifier ?? p.name;
      if (registry === "npm" && typeof ident === "string" && ident) return ident;
    }
  }
  return null;
}

interface GhRepoJson {
  stargazers_count?: number;
  forks_count?: number;
  watchers_count?: number;
  open_issues_count?: number;
  license?: { spdx_id?: string } | null;
  topics?: string[];
  language?: string | null;
  created_at?: string;
  pushed_at?: string;
  archived?: boolean;
  default_branch?: string;
}

/** GitHub repo facts. Throws only when the repo call itself fails;
 *  sub-facts (contributors/languages/release) degrade individually
 *  and are named in `errors`. */
export async function fetchGithubFacts(
  fetchFn: FetchFn,
  repo: string,
): Promise<{ facts: GithubFacts; errors: string[] }> {
  const errors: string[] = [];
  const res = await fetchFn(`https://api.github.com/repos/${repo}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`github repo fetch ${repo}: HTTP ${res.status}`);
  const j = (await res.json()) as GhRepoJson;

  let contributors: number | null = null;
  let contributorsCapped = false;
  try {
    const c = await fetchFn(`https://api.github.com/repos/${repo}/contributors?per_page=100`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (c.ok) {
      const arr = (await c.json()) as unknown[];
      contributors = Array.isArray(arr) ? arr.length : null;
      contributorsCapped = contributors === 100;
    } else errors.push(`contributors: HTTP ${c.status}`);
  } catch (e) { errors.push(`contributors: ${(e as Error).message}`); }

  let languages: Record<string, number> = {};
  try {
    const l = await fetchFn(`https://api.github.com/repos/${repo}/languages`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (l.ok) {
      const all = (await l.json()) as Record<string, number>;
      languages = Object.fromEntries(Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 8));
    } else errors.push(`languages: HTTP ${l.status}`);
  } catch (e) { errors.push(`languages: ${(e as Error).message}`); }

  let latestRelease: GithubFacts["latestRelease"] = null;
  try {
    const r = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (r.ok) {
      const rel = (await r.json()) as { tag_name?: string; published_at?: string };
      if (rel.tag_name) latestRelease = { tag: rel.tag_name, publishedAt: rel.published_at ?? null };
    } else if (r.status !== 404) errors.push(`latest release: HTTP ${r.status}`);
    if (!latestRelease) {
      const t = await fetchFn(`https://api.github.com/repos/${repo}/tags?per_page=1`, {
        headers: { accept: "application/vnd.github+json" },
      });
      if (t.ok) {
        const tags = (await t.json()) as { name?: string }[];
        if (tags[0]?.name) latestRelease = { tag: tags[0].name, publishedAt: null };
      }
    }
  } catch (e) { errors.push(`latest release: ${(e as Error).message}`); }

  return {
    facts: {
      stars: j.stargazers_count ?? 0,
      forks: j.forks_count ?? 0,
      watchers: j.watchers_count ?? 0,
      openIssues: j.open_issues_count ?? 0,
      licenseSpdx: j.license?.spdx_id ?? null,
      topics: Array.isArray(j.topics) ? j.topics.slice(0, 20) : [],
      language: j.language ?? null,
      languages,
      createdAt: j.created_at ?? null,
      pushedAt: j.pushed_at ?? null,
      archived: Boolean(j.archived),
      defaultBranch: j.default_branch ?? null,
      contributors,
      contributorsCapped,
      latestRelease,
    },
    errors,
  };
}

/** npm facts: download points + packument-derived fields. */
export async function fetchNpmFacts(fetchFn: FetchFn, pkg: string): Promise<NpmFacts> {
  const enc = encodeURIComponent(pkg).replace(/%40/g, "@").replace(/%2F/g, "%2F");
  const point = async (range: string): Promise<number | null> => {
    try {
      const r = await fetchFn(`https://api.npmjs.org/downloads/point/${range}/${enc}`);
      if (!r.ok) return null;
      const j = (await r.json()) as { downloads?: number };
      return typeof j.downloads === "number" ? j.downloads : null;
    } catch { return null; }
  };
  const weeklyDownloads = await point("last-week");
  const monthlyDownloads = await point("last-month");

  let latestVersion: string | null = null;
  let latestPublishedAt: string | null = null;
  let versionCount: number | null = null;
  let maintainersCount: number | null = null;
  let deprecated = false;
  const res = await fetchFn(`https://registry.npmjs.org/${enc}`, {
    headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
  });
  if (!res.ok) throw new Error(`npm packument ${pkg}: HTTP ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  const distTags = (doc["dist-tags"] ?? {}) as Record<string, unknown>;
  latestVersion = typeof distTags.latest === "string" ? distTags.latest : null;
  const versions = (doc.versions ?? {}) as Record<string, Record<string, unknown>>;
  versionCount = Object.keys(versions).length || null;
  const time = (doc.time ?? {}) as Record<string, unknown>;
  if (latestVersion && typeof time[latestVersion] === "string") latestPublishedAt = time[latestVersion] as string;
  if (latestVersion && versions[latestVersion]) {
    const dep = versions[latestVersion].deprecated;
    deprecated = typeof dep === "string" && dep.length > 0;
  }
  const maintainers = doc.maintainers;
  maintainersCount = Array.isArray(maintainers) ? maintainers.length : null;
  return { package: pkg, weeklyDownloads, monthlyDownloads, latestVersion, latestPublishedAt, versionCount, maintainersCount, deprecated };
}

/** Fetch a README for the record: the record's own directory first
 *  (sourcePath), then the repo root. Returns the text + source URL. */
export async function fetchReadme(
  fetchFn: FetchFn,
  repo: string,
  branch: string,
  sourcePath: string,
): Promise<{ text: string; url: string } | null> {
  const candidates: string[] = [];
  const names = ["README.md", "readme.md", "Readme.md"];
  if (sourcePath) for (const n of names) candidates.push(`${sourcePath}/${n}`);
  for (const n of names) candidates.push(n);
  for (const path of candidates) {
    const url = rawUrl(repo, branch, path);
    try {
      const res = await fetchFn(url);
      if (res.ok) {
        const text = await res.text();
        if (text.trim().length > 0) return { text, url };
      }
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** Plain-text excerpt from markdown: code fences and markup stripped,
 *  first substantive prose, whitespace-collapsed, ~480 chars. */
export function readmeExcerpt(md: string): string {
  const noFences = md.replace(/```[\s\S]*?```/g, " ");
  const lines = noFences.split("\n").filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (/^<!--/.test(t)) return false;
    if (/^!\[.*\]\(.*\)\s*$/.test(t)) return false; // badge/image-only line
    if (/^\[?!\[.*\]\(.*\)\]\(.*\)\s*$/.test(t)) return false; // linked badge
    return true;
  });
  const text = lines.join(" ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= 480) return text;
  const cut = text.slice(0, 480);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 200 ? lastSpace : 480).trim()}…`;
}

/** First content image URL in a README (badges skipped), resolved
 *  against the repo when relative. */
export function firstReadmeImage(md: string, repo: string, branch: string): string | null {
  const mdImg = md.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+|[^)\s]+)\)/);
  const htmlImg = md.match(/<img[^>]+src=["']([^"']+)["']/i);
  const raw = mdImg?.[1] ?? htmlImg?.[1] ?? null;
  if (!raw) return null;
  if (/shields\.io|badge|travis-ci|circleci|codecov|coveralls/i.test(raw)) return null;
  if (raw.startsWith("data:")) return null;
  if (/^https?:\/\//.test(raw)) return raw;
  const path = raw.replace(/^\.\//, "").replace(/^\//, "");
  return rawUrl(repo, branch, path);
}

export interface LayerADeps {
  fetchFn: FetchFn;
  fetchBytes: FetchBytes;
  assets: AssetStore;
}

/**
 * Run Layer A for one record. Applicability:
 *   - GitHub facts + README + icon when the record has a GitHub repo.
 *   - npm facts when the record points at an npm package.
 * Neither → state `none` (an MCP remote-only record, say). README and
 * icon failures degrade to partial, never none, when facts landed.
 */
export async function runLayerA(
  record: SkillRecord,
  deps: LayerADeps,
  now: Date,
): Promise<{ state: "done" | "partial" | "none"; payload: LayerA }> {
  const payload: LayerA = { fetchedAt: now.toISOString() };
  const errors: string[] = [];
  const repo = record.sourceRepo ?? null;
  const pkg = npmPackageOf(record);
  let attempted = false;
  let landed = false;

  if (repo) {
    attempted = true;
    let branch = record.ref && !/^[0-9a-f]{40}$/.test(record.ref) ? record.ref : null;
    try {
      const { facts, errors: ghErrors } = await fetchGithubFacts(deps.fetchFn, repo);
      payload.github = facts;
      errors.push(...ghErrors);
      landed = true;
      branch = facts.defaultBranch ?? branch ?? "main";

      const readme = await fetchReadme(deps.fetchFn, repo, branch, record.sourcePath ?? "");
      if (readme) {
        const full = new TextEncoder().encode(readme.text);
        const stored = full.byteLength > README_CAP_BYTES ? full.slice(0, README_CAP_BYTES) : full;
        const key = `readme/${record.id}`;
        try {
          await deps.assets.put(key, stored, "text/markdown; charset=utf-8");
          const asset: ReadmeAsset = {
            storedKey: key,
            sourceUrl: readme.url,
            bytes: stored.byteLength,
            truncated: full.byteLength > README_CAP_BYTES,
            excerpt: readmeExcerpt(readme.text),
          };
          if (asset.excerpt) payload.readme = asset;
          else errors.push("readme: fetched but no prose excerpt could be derived");
        } catch (e) {
          errors.push(`readme store: ${(e as Error).message}`);
        }

        const iconUrl = `https://opengraph.githubassets.com/1/${repo}`;
        let icon = await deps.fetchBytes(iconUrl);
        let iconSource = iconUrl;
        if (!icon) {
          const fromReadme = firstReadmeImage(readme.text, repo, branch);
          if (fromReadme) {
            icon = await deps.fetchBytes(fromReadme);
            iconSource = fromReadme;
          }
        }
        if (icon && /^image\//.test(icon.contentType)) {
          const key = `icon/${record.id}`;
          try {
            await deps.assets.put(key, icon.bytes, icon.contentType);
            const asset: IconAsset = { storedKey: key, sourceUrl: iconSource, contentType: icon.contentType, bytes: icon.bytes.byteLength };
            payload.icon = asset;
          } catch (e) {
            errors.push(`icon store: ${(e as Error).message}`);
          }
        }
      } else {
        errors.push("readme: none found at record path or repo root");
      }
    } catch (e) {
      errors.push(`github: ${(e as Error).message}`);
    }
  }

  if (pkg) {
    attempted = true;
    try {
      payload.npm = await fetchNpmFacts(deps.fetchFn, pkg);
      landed = true;
    } catch (e) {
      errors.push(`npm: ${(e as Error).message}`);
    }
  }

  if (errors.length) payload.errors = errors;
  if (!attempted) return { state: "none", payload };
  if (!landed) return { state: "partial", payload };
  return { state: errors.length ? "partial" : "done", payload };
}
