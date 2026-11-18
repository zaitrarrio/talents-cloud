// X scout — SIGNAL ONLY. Nominates candidates mentioned in X
// (Twitter) posts fed in by an operator/provider.
//
// ONE FUNNEL: this scout only NOMINATES candidates (canonical
// locator + provenance + signals). It never writes records, never
// marks anything verified, and its signals (likes / reposts) affect
// queue priority only — never trust. Verification elsewhere (the
// pipeline's git-tree / content checks) alone decides ingestion.
// Channels nominate; verification decides. A post with no resolvable
// repo/package link becomes an "x-post" nomination — watchlist-only,
// never ingestable.
//
// This module makes NO HTTP calls and holds NO credential: posts
// arrive via opts.posts or opts.postsProvider (production: the X
// API or a social-search capture, fed in as posts). Only literal
// github.com / npmjs.com links in the post text are resolved —
// shortened links (t.co, x.com redirects) are NOT followed, so a
// post whose only link is shortened lands on the watchlist.

import type { Scout, ScoutContext, ScoutNomination, ScoutResult } from "./types.js";
import { SCOUT_VIA } from "./types.js";

export interface XPost {
  url: string;
  author: string;
  text: string;
  likes?: number;
  reposts?: number;
}

/** Queries for the operator/provider side to capture posts with. */
export const X_SCOUT_QUERIES: string[] = [
  "SKILL.md",
  "\"claude skill\" github",
  "\"agent skill\" github.com",
  "marketplace.json claude",
];

const engagement = (p: XPost): number => (p.likes ?? 0) + 2 * (p.reposts ?? 0);

/** Strip punctuation a sentence glues onto the end of a URL. */
function cleanRepoSegment(seg: string): string {
  return seg.replace(/\.git$/i, "").replace(/[.,;:!?'"”’)\]}>]+$/g, "");
}

interface ResolvedLink { kind: "skill-repo" | "npm-package"; locator: string; url: string }

/** Extract literal github.com/{owner}/{repo} and
 *  npmjs.com/package/{name} links from post text (deduped). */
export function extractPostLinks(text: string): ResolvedLink[] {
  const out: ResolvedLink[] = [];
  const seen = new Set<string>();
  const push = (link: ResolvedLink) => {
    const key = `${link.kind}:${link.locator}`;
    if (!seen.has(key)) { seen.add(key); out.push(link); }
  };
  for (const m of text.matchAll(/https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/g)) {
    const owner = m[1].toLowerCase();
    const repo = cleanRepoSegment(m[2]).toLowerCase();
    if (!owner || !repo) continue;
    const locator = `${owner}/${repo}`;
    push({ kind: "skill-repo", locator, url: `https://github.com/${locator}` });
  }
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?npmjs\.com\/package\/((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)/gi)) {
    const locator = m[1].toLowerCase().replace(/[.,;:!?'"”’)\]}>]+$/g, "");
    if (!locator) continue;
    push({ kind: "npm-package", locator, url: `https://www.npmjs.com/package/${locator}` });
  }
  return out;
}

/**
 * Turn X posts into nominations. Pure — exported for tests.
 * Resolved links → "skill-repo" / "npm-package" nominations; the
 * same locator from several posts merges into ONE nomination whose
 * signals sum engagement across all those posts and whose ref is
 * the highest-engagement post. A post with no resolvable link →
 * an "x-post" watchlist nomination keyed by the post URL.
 * signalScore = likes + 2·reposts (summed, for merged nominations).
 */
export function extractXCandidates(
  posts: XPost[],
  at: string = new Date().toISOString(),
): ScoutNomination[] {
  const out: ScoutNomination[] = [];
  const merged = new Map<string, {
    nomination: ScoutNomination;
    likes: number;
    reposts: number;
    bestEngagement: number;
  }>();

  for (const post of posts) {
    const links = extractPostLinks(post.text ?? "");
    if (links.length === 0) {
      out.push({
        kind: "x-post",
        locator: post.url,
        url: post.url,
        provenance: {
          via: SCOUT_VIA.x,
          at,
          ref: post.url,
          signals: {
            author: post.author,
            ...(post.likes !== undefined ? { likes: post.likes } : {}),
            ...(post.reposts !== undefined ? { reposts: post.reposts } : {}),
          },
          note: "no resolvable repo/package link — watchlist only, never ingestable",
        },
        signalScore: engagement(post),
      });
      continue;
    }
    for (const link of links) {
      const key = `${link.kind}:${link.locator}`;
      const eng = engagement(post);
      const existing = merged.get(key);
      if (!existing) {
        const entry = {
          nomination: {
            kind: link.kind,
            locator: link.locator,
            url: link.url,
            provenance: {
              via: SCOUT_VIA.x,
              at,
              ref: post.url,
              signals: {
                author: post.author,
                likes: post.likes ?? 0,
                reposts: post.reposts ?? 0,
              },
            },
            signalScore: eng,
          } as ScoutNomination,
          likes: post.likes ?? 0,
          reposts: post.reposts ?? 0,
          bestEngagement: eng,
        };
        merged.set(key, entry);
        out.push(entry.nomination);
      } else {
        existing.likes += post.likes ?? 0;
        existing.reposts += post.reposts ?? 0;
        existing.nomination.signalScore = existing.likes + 2 * existing.reposts;
        existing.nomination.provenance.signals = {
          author: eng > existing.bestEngagement ? post.author : (existing.nomination.provenance.signals?.author ?? post.author),
          likes: existing.likes,
          reposts: existing.reposts,
        };
        if (eng > existing.bestEngagement) {
          existing.bestEngagement = eng;
          existing.nomination.provenance.ref = post.url;
        }
      }
    }
  }
  return out;
}

function isXPost(v: unknown): v is XPost {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.url === "string" && typeof p.author === "string" && typeof p.text === "string";
}

function numOpt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export const xScout: Scout = {
  name: "x",
  async run(ctx: ScoutContext, opts: Record<string, unknown>): Promise<ScoutResult> {
    const rateBefore = ctx.pacer.rateLimitHits;
    const base = { calls: 0, rateLimitHits: ctx.pacer.rateLimitHits - rateBefore };

    let posts: XPost[] | null = null;
    if (Array.isArray(opts.posts)) {
      posts = opts.posts.filter(isXPost);
    } else if (typeof opts.postsProvider === "function") {
      try {
        const provided = await (opts.postsProvider as () => Promise<unknown>)();
        posts = Array.isArray(provided) ? provided.filter(isXPost) : [];
      } catch (e) {
        return {
          nominations: [],
          stats: {
            examined: 0, nominated: 0, skipped: 0, ...base,
            blocked: `x posts provider failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }
    }

    if (posts === null) {
      return {
        nominations: [],
        stats: {
          examined: 0, nominated: 0, skipped: 0, ...base,
          blocked: "no X posts provider configured (production: X API or social-search capture, fed in as posts)",
        },
      };
    }

    const cap = numOpt(opts.cap, 200);
    const nominations = extractXCandidates(posts, ctx.now().toISOString()).slice(0, cap);
    return {
      nominations,
      stats: {
        examined: posts.length,
        nominated: nominations.length,
        skipped: Math.max(0, posts.length - nominations.length),
        ...base,
      },
    };
  },
};

export default xScout;
