// Scout: npm (Phase 2). The npm search API finds the packages
// other channels can't see from GitHub alone: MCP servers published
// as packages, and skill packages that never grew a famous repo.
// Most hits link a GitHub repository — those nominate the REPO
// (full content verification happens at the repo path) with npm as
// corroborating provenance and weekly downloads as the signal.
// Repo-less packages nominate THEMSELVES for pointer-record ingest:
// kind mcp-server when the metadata says MCP, else skill-package.

import { looksLikeMcp, parseGithubRepo } from "./npm-record.js";
import {
  SCOUT_VIA, type Scout, type ScoutContext, type ScoutNomination, type ScoutResult,
} from "./types.js";

export const NPM_QUERIES = [
  "keywords:mcp-server",
  "keywords:claude-skill",
  "keywords:agent-skills",
  "mcp server",
];

export interface NpmSearchPackage {
  name: string;
  description?: string;
  keywords?: string[];
  links?: { repository?: string; npm?: string };
}

/** One search-result package → nomination (repo first, pointer
 *  fallback). Pure — exported for tests. */
export function nominationFromNpmPackage(
  pkg: NpmSearchPackage,
  weeklyDownloads: number | undefined,
  at: string,
): ScoutNomination | null {
  if (!pkg?.name) return null;
  const repo = parseGithubRepo(pkg.links?.repository);
  const signals: Record<string, string | number> = {
    npmPackage: pkg.name,
    ...(typeof weeklyDownloads === "number" ? { weeklyDownloads } : {}),
  };
  if (repo) {
    return {
      kind: "skill-repo",
      locator: repo,
      url: `https://github.com/${repo}`,
      provenance: {
        via: SCOUT_VIA.npm,
        at,
        ref: `https://www.npmjs.com/package/${pkg.name}`,
        signals,
        note: "npm package links this repository — repo nominated, package is corroboration",
      },
      signalScore: weeklyDownloads,
    };
  }
  const isMcp = looksLikeMcp({
    name: pkg.name,
    version: "latest",
    description: pkg.description ?? "",
    keywords: pkg.keywords ?? [],
  });
  return {
    kind: isMcp ? "mcp-server" : "skill-package",
    locator: pkg.name,
    url: `https://www.npmjs.com/package/${pkg.name}`,
    provenance: {
      via: SCOUT_VIA.npm,
      at,
      ref: `https://www.npmjs.com/package/${pkg.name}`,
      signals,
      note: isMcp
        ? "repo-less npm package presenting as an MCP server — pointer-record candidate"
        : "repo-less npm package — pointer-record candidate",
    },
    signalScore: weeklyDownloads,
  };
}

interface NpmSearchObject {
  package?: NpmSearchPackage;
  downloads?: { weekly?: number };
}

export const npmScout: Scout = {
  name: "npm",
  async run(ctx: ScoutContext, opts: Record<string, unknown>): Promise<ScoutResult> {
    const size = Math.min(Number(opts.size ?? 25) || 25, 250);
    const rateBefore = ctx.pacer.rateLimitHits;
    const at = ctx.now().toISOString();
    const byName = new Map<string, ScoutNomination>();
    let examined = 0;
    let calls = 0;
    let blocked: string | undefined;

    for (const q of NPM_QUERIES) {
      const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${size}`;
      const page = await ctx.pacer.call(async () => {
        try {
          const res = await ctx.fetchFn(url, { headers: { accept: "application/json", "user-agent": "talents-discovery-scouts" } });
          if (!res.ok) return { status: res.status, value: null as NpmSearchObject[] | null };
          const j = (await res.json()) as { objects?: NpmSearchObject[] };
          return { status: res.status, value: Array.isArray(j.objects) ? j.objects : [] };
        } catch {
          return { status: 0, value: null };
        }
      });
      calls++;
      if (!page) {
        blocked = "npm search request failed (network or HTTP error)";
        continue;
      }
      for (const obj of page) {
        examined++;
        const pkg = obj.package;
        if (!pkg?.name || byName.has(pkg.name)) continue;
        const nom = nominationFromNpmPackage(pkg, obj.downloads?.weekly, at);
        if (nom) byName.set(pkg.name, nom);
      }
    }

    const nominations = [...byName.values()].sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));
    return {
      nominations,
      stats: {
        examined,
        nominated: nominations.length,
        skipped: examined - nominations.length,
        calls,
        rateLimitHits: ctx.pacer.rateLimitHits - rateBefore,
        ...(blocked ? { blocked } : {}),
        note: `${nominations.filter((n) => n.kind === "skill-repo").length} repo nominations, ${nominations.length - nominations.filter((n) => n.kind === "skill-repo").length} pointer nominations`,
      },
    };
  },
};
