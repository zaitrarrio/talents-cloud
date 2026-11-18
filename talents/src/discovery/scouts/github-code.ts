// Scout: GitHub Code Search (Phase 2). Repository search only sees
// repos that SAY "skill" in their name/description/topics; code
// search sees the FILES: every indexed SKILL.md, marketplace.json
// and .claude-plugin/plugin.json on GitHub, in repos that never
// mention skills anywhere. This is the broadest corpus unlock.
//
// Code search REQUIRES authentication (anonymous calls 401). Token
// resolution: GITHUB_TOKEN from the environment (Worker secret in
// production; never an argument, never logged) — or, in the
// sandbox, a ghapi-backed FetchFn supplied by the CLI (see
// ghapi-fetch.ts), in which case no token exists in this process at
// all and requests simply succeed. If neither is available the run
// reports stats.blocked with the precise requirement instead of
// pretending to have searched.
//
// Hits dedup to unique repos: a repo with 40 SKILL.md files is ONE
// candidate; the per-query hit counts ride along as signals.

import type { FetchFn } from "../../types.js";
import type { Pacer } from "../sweep.js";
import {
  SCOUT_VIA, type Scout, type ScoutContext, type ScoutNomination, type ScoutResult,
} from "./types.js";

export const CODE_SEARCH_QUERIES: { q: string; tag: "skill" | "marketplace" | "plugin" }[] = [
  { q: "filename:SKILL.md", tag: "skill" },
  { q: "filename:marketplace.json", tag: "marketplace" },
  { q: "path:.claude-plugin filename:plugin.json", tag: "plugin" },
];

interface CodeSearchItem {
  path?: string;
  repository?: { full_name?: string; html_url?: string };
}

interface CodePage {
  status: number;
  items: CodeSearchItem[];
  message: string;
}

async function fetchCodePage(fetchFn: FetchFn, pacer: Pacer, query: string, perPage: number, page: number, token?: string): Promise<CodePage> {
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`;
  const headers: Record<string, string> = {
    "user-agent": "talents-discovery-scouts",
    accept: "application/vnd.github+json",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return pacer.call(async () => {
    try {
      const res = await fetchFn(url, { headers });
      if (!res.ok) {
        let message = "";
        try {
          const j = (await res.json()) as { message?: string };
          message = j.message ?? "";
        } catch { /* keep empty */ }
        return { status: res.status, value: { status: res.status, items: [], message } };
      }
      const j = (await res.json()) as { items?: CodeSearchItem[] };
      return { status: res.status, value: { status: res.status, items: Array.isArray(j.items) ? j.items : [], message: "" } };
    } catch {
      return { status: 0, value: { status: 0, items: [], message: "network error" } };
    }
  });
}

/** Aggregate code-search items (grouped by query tag) into repo
 *  nominations. Pure — exported for tests. */
export function nominationsFromCodeSearch(
  byTag: Map<string, CodeSearchItem[]>,
  at: string,
): ScoutNomination[] {
  const repos = new Map<string, { url: string; skill: number; marketplace: number; plugin: number }>();
  for (const [tag, items] of byTag) {
    for (const it of items) {
      const full = (it.repository?.full_name ?? "").toLowerCase();
      if (!full.includes("/")) continue;
      const agg = repos.get(full) ?? {
        url: it.repository?.html_url ?? `https://github.com/${full}`,
        skill: 0, marketplace: 0, plugin: 0,
      };
      if (tag === "skill") agg.skill++;
      else if (tag === "marketplace") agg.marketplace++;
      else if (tag === "plugin") agg.plugin++;
      repos.set(full, agg);
    }
  }
  const out: ScoutNomination[] = [];
  for (const [locator, agg] of repos) {
    const total = agg.skill + agg.marketplace + agg.plugin;
    out.push({
      kind: agg.marketplace > 0 ? "marketplace" : "skill-repo",
      locator,
      url: agg.url,
      provenance: {
        via: SCOUT_VIA["github-code-search"],
        at,
        ref: "https://github.com/search?type=code",
        signals: { skillMdHits: agg.skill, marketplaceHits: agg.marketplace, pluginHits: agg.plugin, totalHits: total },
        note: "code search hit — repo nominated, contents unverified",
      },
      signalScore: total,
    });
  }
  return out.sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));
}

export const githubCodeScout: Scout = {
  name: "github-code-search",
  async run(ctx: ScoutContext, opts: Record<string, unknown>): Promise<ScoutResult> {
    const perPage = Math.min(Number(opts.perPage ?? 100) || 100, 100);
    const pages = Math.min(Number(opts.pages ?? 1) || 1, 3);
    const maxRepos = Number(opts.maxRepos ?? 120) || 120;
    const rateBefore = ctx.pacer.rateLimitHits;
    const byTag = new Map<string, CodeSearchItem[]>();
    let calls = 0;
    let examined = 0;
    let blocked: string | undefined;
    const token = ctx.githubToken
      ?? (typeof process !== "undefined" ? process.env?.GITHUB_TOKEN : undefined);

    for (const { q, tag } of CODE_SEARCH_QUERIES) {
      for (let page = 1; page <= pages; page++) {
        const res = await fetchCodePage(ctx.fetchFn, ctx.pacer, q, perPage, page, token);
        calls++;
        if (res.status === 401 || (res.status === 403 && /auth|credential/i.test(res.message))) {
          blocked = "GitHub code search requires authentication — set GITHUB_TOKEN (Worker secret in production) or run the CLI where the ghapi connector helper supplies access";
          break;
        }
        if (res.status !== 200) {
          if (res.status === 403 || res.status === 429) {
            blocked = `GitHub code search rate-limited (HTTP ${res.status}) after ${calls} call(s) — partial results kept`;
          }
          break;
        }
        examined += res.items.length;
        byTag.set(tag, [...(byTag.get(tag) ?? []), ...res.items]);
        if (res.items.length < perPage) break;
      }
      if (blocked && examined === 0) break;
    }

    const at = ctx.now().toISOString();
    let nominations = nominationsFromCodeSearch(byTag, at);
    const totalRepos = nominations.length;
    nominations = nominations.slice(0, maxRepos);
    return {
      nominations,
      stats: {
        examined,
        nominated: nominations.length,
        skipped: totalRepos - nominations.length,
        calls,
        rateLimitHits: ctx.pacer.rateLimitHits - rateBefore,
        ...(blocked ? { blocked } : {}),
        note: `unique repos from code search: ${totalRepos} (cap ${maxRepos})`,
      },
    };
  },
};
