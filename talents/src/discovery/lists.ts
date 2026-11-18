// List sources (ARCHITECTURE-v2 §7): curated "awesome-*" repos are
// ENTRY POINTS, not listings. A list repo carries no skills of its
// own — its value is the outbound links in its README / curated
// markdown. Talents therefore treats a list as its own source kind:
//
//   - a list is MINED: its links are nominated into the same funnel
//     as every other channel's finds, with provenance
//     {via:"list", list, section} — the section heading is a
//     category hint stored on the candidate, never an auto-applied
//     record category;
//   - a list NEVER produces a record, never appears in search or
//     the aggregate, and is never ingested (ingestSource throws on
//     kind "list");
//   - list inclusion NEVER verifies anything: mined candidates pass
//     the normal verify → ingest → attest path like everyone else;
//   - when a list REMOVES a link, nothing happens — removals are
//     ignored entirely (no unlisting, no demotion, no provenance
//     rewrite); re-mining only ever adds;
//   - a repo that yields real records is never a list: if the tree
//     check finds skill files — at classification time or on a
//     later refresh — its own records win and the list claim is
//     discarded / graduated back to a normal verified source.
//
// Classification happens two ways: explicit nomination (operator
// CLI, or a scout flagging an awesome-* repo — a CLAIM like every
// other kind claim) and the verification-time heuristic: a repo
// whose tree has NO skill files and whose markdown links to ≥10
// distinct GitHub repos is a list instead of a rejection.
// Corroboration runs through the existing machinery — each list is
// its own channel (store.provenanceChannelKey), so a candidate
// named by two lists is corroborated by both.

import type { FetchFn } from "../types.js";
import { defaultFetch, defaultBranch, fetchText, rawUrl } from "../ingest.js";
import {
  classifyTree, fetchTreePaths, Pacer, type SourceKind,
} from "./sweep.js";
import type {
  DiscoveryStore, NominateInput, NominateResult, SourceRow,
} from "./store.js";

/** Minimum distinct outbound GitHub repo links for the list bar. */
export const LIST_MIN_REPO_LINKS = 10;
/** Per-list, per-run nomination cap. */
export const LIST_NOMINATION_CAP = 500;
/** Funnel weight for a list nomination (cf. CHANNEL_WEIGHT). */
export const LIST_CHANNEL_WEIGHT = 2;
/** Markdown files fetched per list repo (README first). */
export const LIST_MAX_MD_FILES = 16;
/** Bytes kept per markdown file. */
export const LIST_MAX_MD_BYTES = 256_000;

export const LIST_VIA = "list";

/** The exact classifyTree rejection for a tree without skill
 *  payload — the only rejection the list heuristic may rescue. */
export const NO_SKILL_FILES_REASON = "no marketplace.json, SKILL.md, or plugin.json in tree";

export function isNoSkillFilesReason(reason: string | null | undefined): boolean {
  return reason === NO_SKILL_FILES_REASON;
}

export interface ListDeps {
  store: DiscoveryStore;
  fetchFn?: FetchFn;
  pacer?: Pacer;
  now?: () => Date;
  /** Funnel-entrance override: operator scripts preload the sources
   *  table and drive mergeNomination + upsertSource directly for
   *  throughput (identical merge semantics — see
   *  scripts/backfill-nominate.mjs). Defaults to store.nominate. */
  nominate?: (input: NominateInput, at: string) => Promise<NominateResult>;
}

// ---------------------------------------------------------------------------
// Link extraction (pure)
// ---------------------------------------------------------------------------

export interface ExtractedListLink {
  kind: "skill-repo" | "marketplace" | "npm-package";
  /** Canonical locator: owner/repo · npm package name. */
  locator: string;
  url: string;
  /** Nearest preceding markdown heading in the same document
   *  ("" when the link precedes any heading). */
  section: string;
  /** The markdown file the link was found in. */
  docPath: string;
}

/** github.com first segments that are site pages, not owners
 *  (mirrors the web scout's set — the two must agree on what a
 *  repo URL is). */
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

function cleanHeading(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** All http(s) URLs on one line: markdown link targets and bare
 *  URLs, with trailing sentence punctuation stripped. */
function urlsOnLine(line: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s)\]<>"']+/gi;
  for (const m of line.matchAll(re)) {
    let u = m[0];
    u = u.replace(/[.,;:!?]+$/, "");
    // A markdown link target ends at the first ')' (already excluded
    // by the char class); a bare URL may carry one balanced closer.
    if (u.endsWith(")") && !u.includes("(")) u = u.slice(0, -1);
    if (u.endsWith("]") && !u.includes("[")) u = u.slice(0, -1);
    out.push(u);
  }
  return out;
}

type ClassifiedUrl = { kind: ExtractedListLink["kind"]; locator: string; url: string } | null;

function classifyListUrl(rawUrl: string, selfLocator: string): ClassifiedUrl {
  let parsed: URL | null = null;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const segs = parsed.pathname.split("/").filter((s) => s.length > 0).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  if (host === "github.com" && segs.length >= 2) {
    const owner = segs[0].toLowerCase();
    const repo = segs[1].toLowerCase().replace(/\.git$/, "");
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || GITHUB_RESERVED.has(owner)) return null;
    const locator = `${owner}/${repo}`;
    if (locator === selfLocator) return null;
    const isMarketplaceFile = segs.slice(2).join("/").endsWith(".claude-plugin/marketplace.json");
    return {
      kind: isMarketplaceFile ? "marketplace" : "skill-repo",
      locator,
      url: `https://github.com/${locator}`,
    };
  }
  if (host === "raw.githubusercontent.com" && segs.length >= 4) {
    const owner = segs[0].toLowerCase();
    const repo = segs[1].toLowerCase().replace(/\.git$/, "");
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || GITHUB_RESERVED.has(owner)) return null;
    const locator = `${owner}/${repo}`;
    if (locator === selfLocator) return null;
    const rest = segs.slice(3).join("/");
    if (rest.endsWith(".claude-plugin/marketplace.json")) {
      return { kind: "marketplace", locator, url: `https://github.com/${locator}` };
    }
    if (rest === "SKILL.md" || rest.endsWith("/SKILL.md")) {
      return { kind: "skill-repo", locator, url: `https://github.com/${locator}` };
    }
    return null;
  }
  if (host === "npmjs.com" && segs[0] === "package" && segs.length >= 2) {
    const name = segs[1].startsWith("@") && segs.length >= 3 ? `${segs[1]}/${segs[2]}` : segs[1];
    const locator = name.toLowerCase();
    if (!NPM_NAME_RE.test(locator)) return null;
    return { kind: "npm-package", locator, url: `https://www.npmjs.com/package/${locator}` };
  }
  return null;
}

/**
 * Extract the outbound resource links of a list's markdown docs,
 * in document order, each tagged with the nearest preceding
 * heading. Deduped by canonical locator; a marketplace.json link
 * upgrades an earlier plain repo link for the same repo (kind
 * only — the first occurrence's section stands). Pure.
 */
export function extractListLinks(
  docs: { path: string; text: string }[],
  selfLocator: string,
): ExtractedListLink[] {
  const self = selfLocator.toLowerCase();
  const byKey = new Map<string, ExtractedListLink>();
  for (const doc of docs) {
    let section = "";
    for (const line of doc.text.split(/\r?\n/)) {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) { section = cleanHeading(heading[1]); continue; }
      for (const raw of urlsOnLine(line)) {
        const c = classifyListUrl(raw, self);
        if (!c) continue;
        const key = c.kind === "npm-package" ? `npm:${c.locator}` : `gh:${c.locator}`;
        const prev = byKey.get(key);
        if (prev) {
          if (prev.kind === "skill-repo" && c.kind === "marketplace") prev.kind = "marketplace";
          continue;
        }
        byKey.set(key, { kind: c.kind, locator: c.locator, url: c.url, section, docPath: doc.path });
      }
    }
  }
  return [...byKey.values()];
}

/** Distinct GitHub repo locators in an extraction (the bar metric —
 *  npm links are mined too but never count toward the bar). */
export function countRepoLocators(links: ExtractedListLink[]): number {
  return new Set(links.filter((l) => l.kind !== "npm-package").map((l) => l.locator)).size;
}

export function passesListBar(links: ExtractedListLink[]): boolean {
  return countRepoLocators(links) >= LIST_MIN_REPO_LINKS;
}

// ---------------------------------------------------------------------------
// Fetching a candidate list's markdown (bounded)
// ---------------------------------------------------------------------------

export interface ListScan {
  docs: { path: string; text: string }[];
  links: ExtractedListLink[];
  repoLocators: number;
}

/** Root-level *.md plus docs/**.md, README first. */
export function selectMarkdownPaths(paths: string[]): string[] {
  const md = paths.filter((p) => {
    if (!/\.md$/i.test(p)) return false;
    return !p.includes("/") || p.toLowerCase().startsWith("docs/");
  });
  md.sort((a, b) => {
    const rank = (p: string) => (/^readme\.md$/i.test(p) ? 0 : !p.includes("/") ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return md.slice(0, LIST_MAX_MD_FILES);
}

/** Fetch + extract a repo's list markdown. Null when the repo's
 *  tree cannot be fetched at all (gone/private/rate-limited) —
 *  callers must treat that as "unknown", never as "not a list". */
export async function scanListRepo(
  fetchFn: FetchFn,
  pacer: Pacer,
  locator: string,
): Promise<ListScan | null> {
  const branch = await defaultBranch(fetchFn, locator);
  const paths = await fetchTreePaths(fetchFn, pacer, locator, branch);
  if (paths === null) return null;
  const docs: { path: string; text: string }[] = [];
  for (const path of selectMarkdownPaths(paths)) {
    const text = await fetchText(fetchFn, rawUrl(locator, branch, path));
    if (text !== null) docs.push({ path, text: text.slice(0, LIST_MAX_MD_BYTES) });
  }
  const links = extractListLinks(docs, locator);
  return { docs, links, repoLocators: countRepoLocators(links) };
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

export interface ListMineStats {
  list: string;
  docsFetched: number;
  linksFound: number;
  uniqueLocators: number;
  repoLocators: number;
  nominated: number;
  created: number;
  corroborated: number;
  alreadyKnown: number;
  capped: boolean;
  barPassed: boolean;
}

const atIso = (deps: ListDeps) => (deps.now ? deps.now() : new Date()).toISOString();

/**
 * Nominate a list's extracted links into the funnel. Every
 * nomination carries {via:"list", list, section}; merging and
 * corroboration are store.mergeNomination's, unchanged. Writes NO
 * records and marks nothing verified — mined candidates face the
 * same verification as any other channel's.
 */
export async function nominateListLinks(
  deps: ListDeps,
  listRow: SourceRow,
  links: ExtractedListLink[],
  at: string,
  cap: number = LIST_NOMINATION_CAP,
): Promise<Pick<ListMineStats, "nominated" | "created" | "corroborated" | "alreadyKnown" | "capped">> {
  const nominate = deps.nominate ?? ((input, t) => deps.store.nominate(input, t));
  const picked = links.slice(0, cap);
  let created = 0, corroborated = 0, alreadyKnown = 0;
  for (const link of picked) {
    const res = await nominate({
      kind: link.kind,
      locator: link.locator,
      url: link.url,
      discoveredVia: LIST_VIA,
      provenance: {
        via: LIST_VIA,
        at,
        ref: listRow.url ?? `https://github.com/${listRow.locator}`,
        list: listRow.locator,
        section: link.section,
        note: `mined from list ${listRow.locator}${link.section ? ` § ${link.section}` : ""} (${link.docPath})`,
      },
      priorityDelta: LIST_CHANNEL_WEIGHT,
    }, at);
    if (res.created) created++;
    else if (res.corroborated) corroborated++;
    else alreadyKnown++;
  }
  return {
    nominated: picked.length, created, corroborated, alreadyKnown,
    capped: links.length > picked.length,
  };
}

/**
 * Mine one list source: scan its markdown, check the bar, nominate
 * its links, and stamp the row mined with a factual summary. The
 * row is expected to already BE the canonical list row (kind
 * "list"); classification/conversion lives in classifyAsList.
 */
export async function mineListSource(
  deps: ListDeps,
  row: SourceRow,
  preScan?: ListScan | null,
): Promise<ListMineStats> {
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const pacer = deps.pacer ?? new Pacer();
  const at = atIso(deps);
  const scan = preScan === undefined ? await scanListRepo(fetchFn, pacer, row.locator) : preScan;
  const base: ListMineStats = {
    list: row.locator,
    docsFetched: scan?.docs.length ?? 0,
    linksFound: scan?.links.length ?? 0,
    uniqueLocators: scan?.links.length ?? 0,
    repoLocators: scan?.repoLocators ?? 0,
    nominated: 0, created: 0, corroborated: 0, alreadyKnown: 0,
    capped: false, barPassed: false,
  };
  if (!scan || !passesListBar(scan.links)) {
    await deps.store.upsertSource({
      ...row,
      kind: "list",
      status: "mined",
      lastSeen: at,
      reason: scan
        ? `list source — below the mining bar on last scan (${base.repoLocators} outbound repo links < ${LIST_MIN_REPO_LINKS}); no nominations`
        : "list source — markdown fetch failed on last scan; no nominations",
    });
    return base;
  }
  const counts = await nominateListLinks(deps, row, scan.links, at);
  const stats: ListMineStats = { ...base, ...counts, barPassed: true };
  await deps.store.upsertSource({
    ...row,
    kind: "list",
    status: "mined",
    lastSeen: at,
    recordCount: 0,
    reason: `list source — mined ${at}: ${stats.repoLocators} outbound repo links, ${stats.nominated} nominated (${stats.created} new, ${stats.corroborated} corroborated)`,
  });
  return stats;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassifyOutcome {
  isList: boolean;
  reason: string;
  /** Set when the repo's tree yields skill files: the list claim
   *  is discarded and the repo belongs to the normal funnel under
   *  this verified kind ("records win"). */
  graduatedKind?: SourceKind;
  mine?: ListMineStats;
}

/**
 * Decide whether a repo row is a list, and if so convert it: the
 * superseded (kind, locator) row is deleted, the canonical
 * kind="list" row is written, and the list is mined. Safe to call
 * on any repo row (candidate / rejected / explicit list claim).
 * A repo with records, or a tree with skill files, is NEVER a
 * list; a repo under the link bar stays a plain rejection.
 */
export async function classifyAsList(
  deps: ListDeps,
  row: SourceRow,
): Promise<ClassifyOutcome> {
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const pacer = deps.pacer ?? new Pacer();
  const at = atIso(deps);
  const locator = row.locator;

  // Already the canonical list row (or a twin of one): refresh it
  // and retire the twin we were handed.
  const existingList = await deps.store.getSource("list", locator);
  if (existingList) {
    if (row.kind !== "list") await deps.store.deleteSource(row.kind, locator);
    const refresh = await refreshListSource(deps, existingList);
    return {
      isList: !refresh.graduated,
      reason: refresh.graduated
        ? `was a list; tree now carries skill files — graduated to ${refresh.kind}`
        : "already classified as a list — refreshed",
      graduatedKind: refresh.kind,
      mine: refresh.mine,
    };
  }

  // Records win, unconditionally.
  const recordIds = await deps.store.recordIdsBySourceRepo(locator);
  if (recordIds.length > 0) {
    return { isList: false, reason: `repo already has ${recordIds.length} record(s) — records win, never a list` };
  }

  // A tree with skill files belongs to the normal funnel.
  const paths = await fetchTreePaths(fetchFn, pacer, locator);
  if (paths === null) return { isList: false, reason: "git tree fetch failed — list status unknown, left as-is" };
  const tree = classifyTree(paths);
  if (tree.ok && tree.kind) {
    return { isList: false, graduatedKind: tree.kind, reason: `tree yields records (${tree.reason}) — not a list` };
  }

  const scan = await scanListRepo(fetchFn, pacer, locator);
  if (!scan) return { isList: false, reason: "markdown fetch failed — list status unknown, left as-is" };
  if (!passesListBar(scan.links)) {
    return { isList: false, reason: `not a list: ${scan.repoLocators} outbound repo links < ${LIST_MIN_REPO_LINKS}, no skill files` };
  }

  // Convert: the canonical row is (list, locator).
  if (row.kind !== "list") await deps.store.deleteSource(row.kind, locator);
  const listRow: SourceRow = {
    ...row,
    kind: "list",
    status: "mined",
    recordCount: 0,
    provenance: [
      ...row.provenance,
      {
        via: LIST_VIA, at, list: locator,
        note: `classified as list source: no skill files in tree; markdown links to ${scan.repoLocators} distinct repos`,
      },
    ],
    reason: `list source — classified ${at}: no skill files in tree, ${scan.repoLocators} outbound repo links`,
  };
  await deps.store.upsertSource(listRow);
  const mine = await mineListSource(deps, listRow, scan);
  return { isList: true, reason: listRow.reason ?? "classified as list source", mine };
}

// ---------------------------------------------------------------------------
// Refresh (weekly cadence): re-mine idempotently. Removals in the
// list are IGNORED — re-mining only adds nominations / provenance.
// If the repo has grown skill files since classification, it
// graduates back to a normal verified source (records win).
// ---------------------------------------------------------------------------

export interface RefreshOutcome {
  graduated: boolean;
  kind?: SourceKind;
  mine?: ListMineStats;
}

export async function refreshListSource(
  deps: ListDeps,
  row: SourceRow,
): Promise<RefreshOutcome> {
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const pacer = deps.pacer ?? new Pacer();
  const at = atIso(deps);
  const paths = await fetchTreePaths(fetchFn, pacer, row.locator);
  if (paths !== null) {
    const tree = classifyTree(paths);
    if (tree.ok && tree.kind) {
      await deps.store.deleteSource("list", row.locator);
      await deps.store.upsertSource({
        ...row,
        kind: tree.kind,
        status: "verified",
        reason: `graduated from list ${at}: ${tree.reason}`,
        lastSeen: at,
        provenance: [
          ...row.provenance,
          { via: LIST_VIA, at, list: row.locator, note: "list graduated — repo now carries skill files; normal funnel applies" },
        ],
      });
      return { graduated: true, kind: tree.kind };
    }
  }
  const mine = await mineListSource(deps, row);
  return { graduated: false, mine };
}

/** Refresh up to `limit` known lists (oldest-seen first). */
export async function refreshAllLists(
  deps: ListDeps,
  opts: { limit?: number } = {},
): Promise<{ refreshed: number; graduated: string[]; mines: ListMineStats[] }> {
  const limit = opts.limit ?? 10;
  const lists = (await deps.store.listSources())
    .filter((s) => s.kind === "list")
    .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))
    .slice(0, limit);
  const graduated: string[] = [];
  const mines: ListMineStats[] = [];
  for (const row of lists) {
    try {
      const out = await refreshListSource(deps, row);
      if (out.graduated) graduated.push(row.locator);
      else if (out.mine) mines.push(out.mine);
    } catch { /* one bad list never fails the refresh pass */ }
  }
  return { refreshed: lists.length, graduated, mines };
}
