// Web-search scout — nominates candidates surfaced by general web
// search queries about agent skills / SKILL.md / MCP servers.
//
// ONE FUNNEL: this scout only NOMINATES candidates (canonical
// locator + provenance + signals). It never writes records, never
// marks anything verified, and its signals (search rank) affect
// queue priority only — never trust. Verification elsewhere (the
// pipeline's git-tree / content checks) alone decides ingestion.
// Channels nominate; verification decides. Results that do not
// resolve to a GitHub repo or an npm package become "lead"
// nominations — watchlist-only, never ingestable.
//
// Providers are plain HTML search pages (no API key): DuckDuckGo's
// html endpoint first, Bing as fallback. A provider that throws or
// returns non-200 makes run() try the next provider; only when
// every provider fails for every query is the run blocked, and even
// then the module returns cleanly. All HTTP goes through
// ctx.fetchFn paced by ctx.pacer.

import type { Scout, ScoutContext, ScoutNomination, ScoutResult } from "./types.js";
import { SCOUT_VIA } from "./types.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  name: string;
  search(query: string, ctx: ScoutContext): Promise<WebSearchResult[]>;
}

/** A search result tagged by run() with the query that produced it
 *  and its rank within that query's results. */
export interface TaggedWebResult extends WebSearchResult {
  query?: string;
  rank?: number;
}

export const WEB_SCOUT_QUERIES: string[] = [
  "\"agent skills\" SKILL.md github",
  "\"claude\" plugin marketplace github new",
  "\"SKILL.md\" github skills",
  "mcp server directory new servers",
  "awesome claude skills github",
  "agent skills registry new",
];

// ---------------------------------------------------------------------------
// Small HTML helpers (no dependencies; tolerant regex parsing)
// ---------------------------------------------------------------------------

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    });
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(tagAttrs: string, name: string): string | null {
  const m = tagAttrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i")) ?? tagAttrs.match(new RegExp(`\\b${name}='([^']*)'`, "i"));
  return m ? decodeHtmlEntities(m[1]) : null;
}

/** Resolve a DuckDuckGo result href: the real target hides in the
 *  `uddg=` redirect parameter of //duckduckgo.com/l/?uddg=… links. */
function ddgTarget(href: string): string {
  let h = href.trim();
  if (h.startsWith("//")) h = `https:${h}`;
  const uddg = h.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try { return decodeURIComponent(uddg[1]); } catch { return uddg[1]; }
  }
  return h;
}

/** Resolve a Bing redirect href (bing.com/ck/a?…&u=a1<base64url>). */
function bingTarget(href: string): string {
  let h = href.trim();
  if (h.startsWith("//")) h = `https:${h}`;
  if (h.includes("/ck/a")) {
    const u = h.match(/[?&]u=([^&]+)/);
    if (u) {
      try {
        const b64 = u[1].replace(/^a1/, "").replace(/-/g, "+").replace(/_/g, "/");
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        if (/^https?:\/\//.test(decoded)) return decoded;
      } catch { /* keep the redirect URL */ }
    }
  }
  return h;
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/**
 * Parse DuckDuckGo html-endpoint results. Result anchors carry
 * class "result__a" (href via the uddg redirect); snippets carry
 * class "result__snippet". Pure — exported for tests.
 */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const anchors: { url: string; title: string; end: number; start: number }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const cls = attr(m[1], "class") ?? "";
    if (!cls.split(/\s+/).includes("result__a")) continue;
    const href = attr(m[1], "href");
    if (!href) continue;
    anchors.push({ url: ddgTarget(href), title: stripTags(m[2]), start: m.index, end: m.index + m[0].length });
  }
  return anchors.map((a, i) => {
    const segEnd = i + 1 < anchors.length ? anchors[i + 1].start : html.length;
    const seg = html.slice(a.end, segEnd);
    const snip = seg.match(/result__snippet[^>]*>([\s\S]*?)(?:<\/a>|<\/td>|<\/div>)/i);
    return { title: a.title, url: a.url, snippet: snip ? stripTags(snip[1]) : "" };
  });
}

/**
 * Parse Bing search results: each result is an <li class="b_algo">
 * block whose <h2> anchor is the target and whose first <p> is the
 * snippet. Pure — exported for tests.
 */
export function parseBingHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blocks = html.split(/<li\s+class="b_algo"/i).slice(1);
  for (const block of blocks) {
    const h2 = block.match(/<h2[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    const anyAnchor = h2 ?? block.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!anyAnchor) continue;
    const href = attr(anyAnchor[1], "href");
    if (!href || href.startsWith("#")) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ title: stripTags(anyAnchor[2]), url: bingTarget(href), snippet: p ? stripTags(p[1]) : "" });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** One paced HTTP GET; throws on transport failure or non-200 so
 *  run() can fall through to the next provider. */
async function pacedSearchHtml(ctx: ScoutContext, url: string): Promise<string> {
  const res = await ctx.pacer.call(async () => {
    try {
      const r = await ctx.fetchFn(url, {
        headers: { "user-agent": "talents-discovery-scouts", accept: "text/html" },
      });
      let text = "";
      try { text = await r.text(); } catch { text = ""; }
      return { status: r.status, value: { status: r.status, text } };
    } catch {
      return { status: 0, value: { status: 0, text: "" } };
    }
  });
  if (res.status !== 200) throw new Error(`search fetch HTTP ${res.status} for ${url}`);
  return res.text;
}

export const DuckDuckGoHtmlProvider: WebSearchProvider = {
  name: "duckduckgo-html",
  async search(query: string, ctx: ScoutContext): Promise<WebSearchResult[]> {
    const html = await pacedSearchHtml(ctx, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    return parseDuckDuckGoHtml(html);
  },
};

export const BingProvider: WebSearchProvider = {
  name: "bing",
  async search(query: string, ctx: ScoutContext): Promise<WebSearchResult[]> {
    const html = await pacedSearchHtml(ctx, `https://www.bing.com/search?q=${encodeURIComponent(query)}`);
    return parseBingHtml(html);
  },
};

export const DEFAULT_WEB_PROVIDERS: WebSearchProvider[] = [DuckDuckGoHtmlProvider, BingProvider];

// ---------------------------------------------------------------------------
// Candidate extraction
// ---------------------------------------------------------------------------

/** github.com first segments that are site pages, not owners. */
const GITHUB_RESERVED = new Set([
  "about", "account", "assets", "blog", "collections", "contact",
  "codespaces", "customer-stories", "education", "enterprise",
  "events", "explore", "features", "gist", "github", "home",
  "issues", "join", "login", "logout", "marketplace", "new",
  "notifications", "orgs", "pricing", "pulls", "readme", "search",
  "security", "settings", "signup", "site", "sponsors", "team",
  "topics", "trending", "users", "watching",
]);

const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const REPO_RE = /^[a-z0-9._-]+$/i;
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/** Repo names that LOOK like curated lists (awesome-*, *-awesome-*,
 *  best-of-*). Only a claim: the runner's list classification checks
 *  the tree first — a repo that actually carries skills resolves as
 *  a normal source and the claim is discarded (records win). */
const LIST_NAME_RE = /^(?:awesome|best-of)(?:[-_]|$)|[-_]awesome[-_]/i;

interface Classified { kind: ScoutNomination["kind"]; locator: string; url: string }

function classifyUrl(rawUrl: string): Classified {
  let parsed: URL | null = null;
  try { parsed = new URL(rawUrl); } catch { parsed = null; }
  if (parsed) {
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const segs = parsed.pathname.split("/").filter((s) => s.length > 0).map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
    if (host === "github.com" && segs.length >= 2) {
      const owner = segs[0].toLowerCase();
      const repo = segs[1].toLowerCase().replace(/\.git$/, "");
      if (OWNER_RE.test(owner) && REPO_RE.test(repo) && !GITHUB_RESERVED.has(owner)) {
        const locator = `${owner}/${repo}`;
        return {
          kind: LIST_NAME_RE.test(repo) ? "list" : "skill-repo",
          locator,
          url: `https://github.com/${locator}`,
        };
      }
    }
    if (host === "npmjs.com" && segs[0] === "package" && segs.length >= 2) {
      const name = segs[1].startsWith("@") && segs.length >= 3 ? `${segs[1]}/${segs[2]}` : segs[1];
      const locator = name.toLowerCase();
      if (NPM_NAME_RE.test(locator)) {
        return { kind: "npm-package", locator, url: `https://www.npmjs.com/package/${locator}` };
      }
    }
  }
  // Anything else is an unresolved lead — watchlist-only.
  return { kind: "lead", locator: rawUrl, url: rawUrl };
}

/**
 * Turn tagged search results into nominations. Pure — exported for
 * tests. github.com/{owner}/{repo} (any deeper path, e.g. /blob/…,
 * stripped) → "skill-repo" (or a "list" claim when the repo name
 * looks like a curated list — the runner resolves the claim);
 * npmjs.com/package/{name} (scoped names supported) → "npm-package";
 * anything else → "lead" with a watchlist note. Deduped within the
 * run by (kind, locator), first (highest-ranked) occurrence wins.
 * signalScore is rank-based: earlier result within its query →
 * higher (10 − index).
 */
export function extractWebCandidates(
  results: TaggedWebResult[],
  at: string = new Date().toISOString(),
): ScoutNomination[] {
  const byKey = new Map<string, ScoutNomination>();
  const perQueryIndex = new Map<string, number>();
  for (const r of results) {
    const queryKey = r.query ?? "";
    const idx = r.rank ?? perQueryIndex.get(queryKey) ?? 0;
    perQueryIndex.set(queryKey, (perQueryIndex.get(queryKey) ?? 0) + 1);
    const { kind, locator, url } = classifyUrl(r.url);
    const key = `${kind}:${locator}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      kind,
      locator,
      url,
      provenance: {
        via: SCOUT_VIA["web-search"],
        at,
        ref: r.url,
        ...(r.query ? { signals: { query: r.query } } : {}),
        ...(kind === "lead" ? { note: "unresolved lead — not a repo/package" } : {}),
      },
      signalScore: Math.max(1, 10 - idx),
    });
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Scout
// ---------------------------------------------------------------------------

function numOpt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export const webSearchScout: Scout = {
  name: "web-search",
  async run(ctx: ScoutContext, opts: Record<string, unknown>): Promise<ScoutResult> {
    const queries = (Array.isArray(opts.queries) ? opts.queries.filter((q): q is string => typeof q === "string") : WEB_SCOUT_QUERIES);
    const providers = (Array.isArray(opts.providers) && opts.providers.length > 0
      ? (opts.providers as WebSearchProvider[])
      : DEFAULT_WEB_PROVIDERS);
    const perQuery = numOpt(opts.perQuery, 8);
    const cap = numOpt(opts.cap, 100);
    const rateBefore = ctx.pacer.rateLimitHits;
    let calls = 0;
    let examined = 0;
    let anySuccess = false;
    const failures: string[] = [];
    const tagged: TaggedWebResult[] = [];

    for (const query of queries) {
      let results: WebSearchResult[] | null = null;
      let lastError = "no providers configured";
      for (const provider of providers) {
        calls++; // each provider attempt is exactly one paced HTTP call
        try {
          results = await provider.search(query, ctx);
          break;
        } catch (e) {
          lastError = `${provider.name}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      if (results === null) {
        failures.push(`${query} — ${lastError}`);
        continue;
      }
      anySuccess = true;
      const top = results.slice(0, perQuery);
      examined += top.length;
      top.forEach((r, i) => tagged.push({ ...r, query, rank: i }));
    }

    const nominations = extractWebCandidates(tagged, ctx.now().toISOString()).slice(0, cap);
    const blocked = !anySuccess
      ? `all web search providers failed for every query (${failures[0] ?? "no queries run"})`
      : undefined;

    return {
      nominations,
      stats: {
        examined,
        nominated: nominations.length,
        skipped: Math.max(0, examined - nominations.length),
        calls,
        rateLimitHits: ctx.pacer.rateLimitHits - rateBefore,
        ...(blocked ? { blocked } : {}),
        ...(failures.length > 0 && anySuccess
          ? { note: `${failures.length} quer${failures.length === 1 ? "y" : "ies"} failed on all providers` }
          : {}),
      },
    };
  },
};

export default webSearchScout;
