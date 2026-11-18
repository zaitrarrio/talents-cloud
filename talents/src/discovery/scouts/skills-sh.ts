// skills.sh scout — nominates candidates found on skills.sh
// (Vercel's skills directory / leaderboard).
//
// ONE FUNNEL: this scout only NOMINATES candidates (canonical
// locator + provenance + signals). It never writes records, never
// marks anything verified, and its signals (install counts) affect
// queue priority only — never trust. Verification elsewhere (the
// pipeline's git-tree / content checks) alone decides ingestion.
// Channels nominate; verification decides.
//
// Source shape, investigated live on 2026-11-10:
//   - GET https://skills.sh/api/v1/skills returns 401
//     {"error":"authentication_required", …} — the public API needs
//     a Vercel OIDC token, which this scout does not hold. The code
//     detects any non-200 / auth failure and falls back WITHOUT
//     failing; if the API ever answers 200 with a JSON list, it is
//     parsed defensively (unknown shape).
//   - Fallback pages are Next.js App Router pages whose RSC flight
//     payload (self.__next_f pushes, backslash-escaped JSON) embeds
//     the listings:
//       / , /trending , /hot — "initialSkills":[{ "source":
//         "owner/repo", "skillId": "…", "name": "…",
//         "installs": 4297566, "weeklyInstalls":[…] }, …]
//       /official — "owner":"…", "repos":[{ "repo": "owner/repo",
//         "totalInstalls": N, "skills":[{ "name":…, "installs":… }] }]
//     The rendered HTML also carries one row per skill with
//     href="/{owner}/{repo}/{skill}" and the owner/repo as text.
//   - https://skills.sh/ 308-redirects to https://www.skills.sh/.
//
// Bounded: 1 API call + at most ~4 listing pages, top ~200 repos.

import type { Scout, ScoutContext, ScoutNomination, ScoutResult } from "./types.js";
import { SCOUT_VIA } from "./types.js";

export interface SkillsShListing {
  /** Canonical locator, lowercase owner/repo. */
  locator: string;
  /** Total installs for the listing, when the channel reports it.
   *  When a repo carries several skills, this is the largest single
   *  listing's count (never a sum — the same users install several
   *  skills from one repo, so summing would double-count). */
  installs?: number;
}

export const SKILLS_SH_API_URL = "https://skills.sh/api/v1/skills";

export const SKILLS_SH_PAGES: string[] = [
  "https://www.skills.sh/",
  "https://www.skills.sh/trending",
  "https://www.skills.sh/hot",
  "https://www.skills.sh/official",
];

/** First path segments on skills.sh that are site sections, not
 *  GitHub owners. */
const RESERVED_OWNERS = new Set([
  "agent", "agents", "api", "about", "audits", "contact", "docs",
  "hot", "official", "packs", "privacy", "search", "site", "terms",
  "topic", "topics", "trending", "_next",
]);

const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const REPO_RE = /^[a-z0-9._-]+$/;

/** Validate + canonicalize an owner/repo pair; null when implausible. */
function normalizeLocator(ownerRaw: string, repoRaw: string): string | null {
  const owner = ownerRaw.trim().toLowerCase();
  const repo = repoRaw.trim().toLowerCase().replace(/\.git$/, "");
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  if (RESERVED_OWNERS.has(owner)) return null;
  if (repo === "." || repo === "..") return null;
  return `${owner}/${repo}`;
}

/** Parse a github.com URL (or bare owner/repo) into a locator. */
function locatorFromGithubish(value: string): string | null {
  const trimmed = value.trim();
  const gh = trimmed.match(/github\.com\/([^/?#]+)\/([^/?#]+)/i);
  if (gh) return normalizeLocator(gh[1], gh[2]);
  const bare = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (bare) return normalizeLocator(bare[1], bare[2]);
  return null;
}

function addListing(map: Map<string, SkillsShListing>, locator: string, installs?: number): void {
  const prev = map.get(locator);
  if (!prev) {
    map.set(locator, installs === undefined ? { locator } : { locator, installs });
    return;
  }
  if (installs !== undefined && (prev.installs === undefined || installs > prev.installs)) {
    prev.installs = installs;
  }
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d[\d,]*$/.test(v.trim())) {
    const n = Number(v.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

const INSTALL_KEYS = ["installs", "installCount", "install_count", "totalInstalls", "total_installs", "downloads", "weeklyDownloads"];
const LOCATOR_KEYS = ["source", "repo", "repository", "fullName", "full_name", "githubRepo", "github_repo"];
const URL_KEYS = ["github", "githubUrl", "github_url", "url", "html_url", "sourceUrl", "source_url"];

/** Try to read one listing out of a single (unknown-shaped) object. */
function listingFromObject(obj: Record<string, unknown>): SkillsShListing | null {
  let locator: string | null = null;
  for (const key of LOCATOR_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.includes("/")) {
      locator = locatorFromGithubish(v);
      if (locator) break;
    }
  }
  if (!locator) {
    for (const key of URL_KEYS) {
      const v = obj[key];
      if (typeof v === "string" && v.includes("github.com/")) {
        locator = locatorFromGithubish(v);
        if (locator) break;
      }
    }
  }
  if (!locator) {
    const owner = obj.owner;
    const repo = obj.repo ?? obj.repository ?? obj.name;
    if (typeof owner === "string" && typeof repo === "string") {
      // "repo" may already be the full owner/repo (the /official shape).
      locator = repo.includes("/") ? locatorFromGithubish(repo) : normalizeLocator(owner, repo);
    }
  }
  if (!locator) return null;
  let installs: number | undefined;
  for (const key of INSTALL_KEYS) {
    installs = asNumber(obj[key]);
    if (installs !== undefined) break;
  }
  return installs === undefined ? { locator } : { locator, installs };
}

function walkUnknown(node: unknown, map: Map<string, SkillsShListing>, depth: number): void {
  if (depth > 8 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) walkUnknown(item, map, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const listing = listingFromObject(obj);
    if (listing) addListing(map, listing.locator, listing.installs);
    for (const v of Object.values(obj)) walkUnknown(v, map, depth + 1);
  }
}

/**
 * Parse a skills.sh API payload of unknown shape into listings.
 * Pure — exported for tests. Looks for arrays anywhere in the
 * payload (top level, or under common keys like skills/items/data)
 * and reads owner/repo (or a github URL) + an installs count from
 * each entry, defensively. Deduped by locator, max installs kept.
 */
export function parseSkillsShApi(payload: unknown): SkillsShListing[] {
  const map = new Map<string, SkillsShListing>();
  walkUnknown(payload, map, 0);
  return [...map.values()];
}

/**
 * Extract listings from a skills.sh page (HTML with an embedded
 * RSC flight payload / __NEXT_DATA__, or a raw JSON body). Pure —
 * exported for tests. Handles, in order: a parseable JSON body (via
 * parseSkillsShApi); the flight-data shapes `"source":"owner/repo"`
 * + `"installs":N` and `"repo":"owner/repo"` + `"totalInstalls":N`;
 * rendered-row hrefs `/{owner}/{repo}/{skill}`; and any literal
 * github.com/owner/repo URLs. Deduped, max installs kept.
 */
export function extractSkillsShListings(htmlOrJsonText: string): SkillsShListing[] {
  const map = new Map<string, SkillsShListing>();
  const text = htmlOrJsonText ?? "";

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = parseSkillsShApi(JSON.parse(trimmed) as unknown);
      for (const l of parsed) addListing(map, l.locator, l.installs);
      if (map.size > 0) return [...map.values()];
    } catch { /* not JSON after all — fall through to text patterns */ }
  }

  // Unescape the flight payload's backslash-escaped JSON quotes.
  const norm = text.replace(/\\+"/g, '"').replace(/\\\//g, "/");

  // Flight shape 1 (/, /trending, /hot):
  //   {"source":"owner/repo","skillId":"…","name":"…","installs":N,…}
  for (const m of norm.matchAll(/"source"\s*:\s*"([^"/]+)\/([^"]+)"/g)) {
    const locator = normalizeLocator(m[1], m[2]);
    if (!locator) continue;
    const window = norm.slice(m.index, m.index + 400);
    const inst = window.match(/"installs"\s*:\s*(\d+)/);
    addListing(map, locator, inst ? Number(inst[1]) : undefined);
  }

  // Flight shape 2 (/official):
  //   {"repo":"owner/repo","totalInstalls":N,"skills":[…]}
  for (const m of norm.matchAll(/"repo"\s*:\s*"([^"/]+)\/([^"]+)"/g)) {
    const locator = normalizeLocator(m[1], m[2]);
    if (!locator) continue;
    const window = norm.slice(m.index, m.index + 200);
    const inst = window.match(/"totalInstalls"\s*:\s*(\d+)/) ?? window.match(/"installs"\s*:\s*(\d+)/);
    addListing(map, locator, inst ? Number(inst[1]) : undefined);
  }

  // Rendered rows: href="/{owner}/{repo}/{skill-name}".
  for (const m of norm.matchAll(/href="\/([a-z0-9._-]+)\/([a-z0-9._-]+)\/[a-z0-9._-]+"/gi)) {
    const locator = normalizeLocator(m[1], m[2]);
    if (locator) addListing(map, locator);
  }

  // Any literal GitHub URLs in the page.
  for (const m of norm.matchAll(/github\.com\/([a-z0-9-]+)\/([a-z0-9._-]+)/gi)) {
    const locator = normalizeLocator(m[1], m[2]);
    if (locator) addListing(map, locator);
  }

  return [...map.values()];
}

/** One paced HTTP GET returning {status, text}; never throws. */
async function pacedText(ctx: ScoutContext, url: string): Promise<{ status: number; text: string }> {
  return ctx.pacer.call(async () => {
    try {
      const res = await ctx.fetchFn(url, {
        headers: { "user-agent": "talents-discovery-scouts", accept: "text/html, application/json" },
      });
      let text = "";
      try { text = await res.text(); } catch { text = ""; }
      return { status: res.status, value: { status: res.status, text } };
    } catch {
      return { status: 0, value: { status: 0, text: "" } };
    }
  });
}

function numOpt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export const skillsShScout: Scout = {
  name: "skills.sh",
  async run(ctx: ScoutContext, opts: Record<string, unknown>): Promise<ScoutResult> {
    const cap = numOpt(opts.cap ?? opts.maxListings, 200);
    const pages = (Array.isArray(opts.pages) ? opts.pages.filter((p): p is string => typeof p === "string") : SKILLS_SH_PAGES)
      .slice(0, numOpt(opts.maxPages, SKILLS_SH_PAGES.length));
    const apiUrl = typeof opts.apiUrl === "string" ? opts.apiUrl : SKILLS_SH_API_URL;
    const rateBefore = ctx.pacer.rateLimitHits;
    let calls = 0;
    let examined = 0;

    const byLocator = new Map<string, { installs?: number; ref: string }>();
    const merge = (listings: SkillsShListing[], ref: string) => {
      for (const l of listings) {
        const prev = byLocator.get(l.locator);
        if (!prev) {
          byLocator.set(l.locator, { installs: l.installs, ref });
        } else if (l.installs !== undefined && (prev.installs === undefined || l.installs > prev.installs)) {
          prev.installs = l.installs;
          prev.ref = ref;
        }
      }
    };

    // 1) Public API first. As of 2026-11-10 this is 401
    //    authentication_required (Vercel OIDC) — detect and fall
    //    back without failing. A future 200 JSON list is parsed.
    let apiNote = "not tried";
    const apiRes = await pacedText(ctx, apiUrl);
    calls++;
    if (apiRes.status === 200) {
      let listings: SkillsShListing[] = [];
      try { listings = parseSkillsShApi(JSON.parse(apiRes.text) as unknown); } catch { listings = []; }
      if (listings.length > 0) {
        examined += listings.length;
        merge(listings, apiUrl);
        apiNote = "api ok";
      } else {
        apiNote = "api returned 200 but no parseable listings";
      }
    } else {
      const auth = apiRes.text.includes("authentication_required") ? " (authentication_required)" : "";
      apiNote = `api HTTP ${apiRes.status}${auth}`;
    }

    // 2) Fallback: listing pages' embedded payloads.
    let pagesFetched = 0;
    if (byLocator.size === 0) {
      for (const page of pages) {
        const res = await pacedText(ctx, page);
        calls++;
        pagesFetched++;
        if (res.text) {
          const listings = extractSkillsShListings(res.text);
          examined += listings.length;
          merge(listings, page);
        }
        if (byLocator.size >= cap) break;
      }
    }

    const at = ctx.now().toISOString();
    const nominations: ScoutNomination[] = [...byLocator.entries()]
      .map(([locator, v]) => ({ locator, installs: v.installs, ref: v.ref }))
      .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0))
      .slice(0, cap)
      .map(({ locator, installs, ref }) => ({
        kind: "skill-repo" as const,
        locator,
        url: `https://github.com/${locator}`,
        provenance: {
          via: SCOUT_VIA["skills.sh"],
          at,
          ref,
          ...(installs !== undefined ? { signals: { installs } } : {}),
        },
        ...(installs !== undefined ? { signalScore: installs } : {}),
      }));

    const blocked = nominations.length === 0
      ? `skills.sh API unavailable (${apiNote}) and ${pagesFetched} fallback listing page(s) yielded no listings`
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
        note: blocked
          ? apiNote
          : apiNote === "api ok"
            ? "listings from the skills.sh API"
            : `API unavailable (${apiNote}); listings extracted from ${pagesFetched} fallback page(s)`,
      },
    };
  },
};

export default skillsShScout;
