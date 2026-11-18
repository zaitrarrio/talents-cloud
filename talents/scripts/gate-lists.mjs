// List-source GATE + seed run (ARCHITECTURE-v2 §7): classify the
// sources REJECTED with the no-skill-files reason (travisvn/
// awesome-claude-skills is the proof case), mine the ones that pass
// the ≥10-repo-link bar into the funnel, and prove the hard rules
// against production data + the live site:
//   · per-list mined links / unique locators / new candidates /
//     corroborations; total new candidates entering the funnel
//   · 10 hand-checked nominations: the locator resolves to a real
//     repo AND the stored section matches the list's actual markdown
//     (re-derived from the raw file by an independent line scan)
//   · ZERO records sourced from any classified list repo; no list
//     repo in the live aggregate; no list row ingestable
//   · a corroborated candidate carrying both a list provenance and
//     another channel's provenance on ONE row
//   · backlog before/after; drain state read from its progress file
//
// Throughput: nominations go through a preloaded mergeNomination
// (the backfill-nominate pattern — identical merge semantics), with
// a per-list batched freshness re-check: locators that turned
// terminal (ingested/rejected/stale/watchlist) or became lists
// since the preload are routed through store.nominate's fresh read
// instead, so a concurrent drain write can never be overwritten
// with a stale row.
//
// Usage: backfill_remote.py gate-lists.mjs
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DIST, makeDeps, counts, nowIso } from "./backfill-lib.mjs";

const ROOT = "/home/hatch/workspace/skills-marketplace/talents";
const { classifyAsList, isNoSkillFilesReason } = await import(pathToFileURL(join(DIST, "src/discovery/lists.js")).href);
const { mergeNomination } = await import(pathToFileURL(join(DIST, "src/discovery/store.js")).href);

const { d1, store, pacer, fetchFn } = await makeDeps({ pacerMs: 1000 });
const startedAt = nowIso();
const gate = { at: startedAt, before: null, after: null, seed: [], handChecks: [], proofs: {}, totals: {} };

const before = await counts(d1);
gate.before = {
  sourcesByStatus: Object.fromEntries(before.sourcesByStatus.map((r) => [r.status, r.n])),
  listed: before.recordsByStatus.find((r) => r.status === "listed")?.n ?? 0,
};
gate.backlogBefore = (gate.before.sourcesByStatus.candidate ?? 0) + (gate.before.sourcesByStatus.verified ?? 0);
console.log(`before: listed=${gate.before.listed} sources=${JSON.stringify(gate.before.sourcesByStatus)} backlog=${gate.backlogBefore}`);

// ---------------------------------------------------------------------------
// Preloaded fast nominate (freshness-guarded)
// ---------------------------------------------------------------------------
const RANK = { ingested: 0, verified: 1, candidate: 2, watchlist: 3, mined: 4, stale: 5, rejected: 6 };
const preload = new Map();
for (const r of await store.listSources()) {
  const prev = preload.get(r.locator);
  if (!prev || (RANK[r.status] ?? 9) < (RANK[prev.status] ?? 9)) preload.set(r.locator, r);
}
console.log(`preloaded ${preload.size} source rows`);
const guarded = new Set(); // locators that must use the fresh-read path
async function fastNominate(input, at) {
  if (guarded.has(input.locator)) return store.nominate(input, at);
  const res = mergeNomination(preload.get(input.locator) ?? null, input, at);
  preload.set(input.locator, res.row);
  await store.upsertSource(res.row);
  return res;
}
async function refreshGuards(locators) {
  guarded.clear();
  const esc = (s) => s.replace(/'/g, "''");
  for (let i = 0; i < locators.length; i += 200) {
    const chunk = locators.slice(i, i + 200);
    const rows = await d1.query(
      `SELECT locator, status, kind FROM sources WHERE locator IN (${chunk.map((l) => `'${esc(l)}'`).join(",")})`,
    );
    for (const r of rows) {
      if (["ingested", "rejected", "stale", "watchlist", "mined"].includes(r.status) || r.kind === "list") {
        guarded.add(r.locator);
        preload.delete(r.locator);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Seed: classify every rejected row with the no-skill-files reason
// ---------------------------------------------------------------------------
const rejected = (await store.listSources("rejected"))
  .filter((r) => r.kind !== "list" && isNoSkillFilesReason(r.reason));
console.log(`seed set: ${rejected.length} rejected rows with the no-skill-files reason`);
const deps = { store, fetchFn, pacer, nominate: fastNominate, now: () => new Date() };

// classifyAsList fetches the scan itself; to freshness-guard the
// nominations we pre-scan here only to know the locator set — the
// classify call re-scans (bounded, rare path) and mines with the
// guarded nominate.
const { scanListRepo } = await import(pathToFileURL(join(DIST, "src/discovery/lists.js")).href);
for (const row of rejected) {
  const scan = await scanListRepo(fetchFn, pacer, row.locator).catch(() => null);
  if (scan) await refreshGuards(scan.links.map((l) => l.locator));
  const outcome = await classifyAsList(deps, row);
  const entry = {
    locator: row.locator,
    via: row.discoveredVia,
    isList: outcome.isList,
    reason: outcome.reason,
    mine: outcome.mine ?? null,
  };
  gate.seed.push(entry);
  console.log(`  ${outcome.isList ? "LIST " : "stay "} ${row.locator} — ${outcome.isList && outcome.mine
    ? `${outcome.mine.repoLocators} repo links, ${outcome.mine.nominated} nominated (${outcome.mine.created} new, ${outcome.mine.corroborated} corroborated, ${outcome.mine.alreadyKnown} already known)`
    : outcome.reason}`);
  await d1.flush();
}
await d1.flush();

const lists = gate.seed.filter((s) => s.isList);
gate.totals = {
  seedExamined: gate.seed.length,
  listsClassified: lists.length,
  staysRejected: gate.seed.length - lists.length,
  nominated: lists.reduce((a, s) => a + (s.mine?.nominated ?? 0), 0),
  newCandidates: lists.reduce((a, s) => a + (s.mine?.created ?? 0), 0),
  corroborated: lists.reduce((a, s) => a + (s.mine?.corroborated ?? 0), 0),
  alreadyKnown: lists.reduce((a, s) => a + (s.mine?.alreadyKnown ?? 0), 0),
};

// ---------------------------------------------------------------------------
// Hand-checks: 10 list nominations verified against live GitHub +
// the list's actual markdown (independent upward-heading scan)
// ---------------------------------------------------------------------------
const listLocators = lists.map((s) => s.locator);
const picks = [];
for (const r of await d1.query("SELECT locator, kind, status, provenance FROM sources WHERE provenance LIKE '%\"via\": \"list\"%' OR provenance LIKE '%\"via\":\"list\"%'")) {
  let prov = [];
  try { prov = JSON.parse(r.provenance ?? "[]"); } catch { /* skip */ }
  for (const p of prov) {
    if (p.via === "list" && p.list && listLocators.includes(p.list)) {
      picks.push({ locator: r.locator, status: r.status, list: p.list, section: p.section ?? "", note: p.note ?? "" });
    }
  }
}
picks.sort((a, b) => (a.list === "travisvn/awesome-claude-skills" ? 0 : 1) - (b.list === "travisvn/awesome-claude-skills" ? 0 : 1));
const chosen = picks.slice(0, 10);

function cleanHeadingIndependent(raw) {
  return raw.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 120);
}
const readmeCache = new Map();
async function listDocText(listLocator, docPath) {
  const cacheKey = `${listLocator}:${docPath}`;
  if (readmeCache.has(cacheKey)) return readmeCache.get(cacheKey);
  // default branch via the API, then the raw file
  let branch = "main";
  try {
    const meta = await fetchFn(`https://api.github.com/repos/${listLocator}`);
    if (meta.ok) branch = (await meta.json()).default_branch ?? "main";
  } catch { /* keep main */ }
  let text = null;
  try {
    const res = await fetchFn(`https://raw.githubusercontent.com/${listLocator}/${branch}/${docPath}`);
    if (res.ok) text = await res.text();
  } catch { /* null */ }
  readmeCache.set(cacheKey, text);
  return text;
}

for (const pick of chosen) {
  const check = { ...pick, repoExists: false, sectionMatches: false, foundHeading: null };
  try {
    const res = await fetchFn(`https://api.github.com/repos/${pick.locator}`);
    check.repoExists = res.ok;
  } catch { check.repoExists = false; }
  const docPath = (pick.note.match(/\(([^()]+\.md)\)/) ?? [])[1] ?? "README.md";
  const text = await listDocText(pick.list, docPath);
  if (text) {
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex((l) => l.toLowerCase().includes(`github.com/${pick.locator}`));
    if (idx >= 0) {
      let heading = "";
      for (let i = idx - 1; i >= 0; i--) {
        if (/^#{1,6}\s+/.test(lines[i])) { heading = cleanHeadingIndependent(lines[i]); break; }
      }
      check.foundHeading = heading;
      check.sectionMatches = heading === pick.section;
    }
  }
  gate.handChecks.push(check);
  console.log(`  check ${pick.locator} (from ${pick.list} § "${pick.section}"): exists=${check.repoExists} sectionMatch=${check.sectionMatches}`);
}

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------
// 1) No records sourced from any classified list repo.
let recordsFromLists = 0;
for (const loc of listLocators) recordsFromLists += (await store.recordIdsBySourceRepo(loc)).length;
gate.proofs.recordsFromListRepos = recordsFromLists;

// 2) List rows are mined, recordCount 0, and not candidates/verified.
const listRows = (await store.listSources()).filter((s) => s.kind === "list");
gate.proofs.listRows = listRows.map((r) => ({ locator: r.locator, status: r.status, recordCount: r.recordCount }));

// 3) Live aggregate contains no entry sourced from a list repo.
let aggregateHits = [];
try {
  const res = await fetch("https://talents.sh/.claude-plugin/marketplace.json");
  const agg = await res.json();
  const urls = (agg.plugins ?? []).map((p) => JSON.stringify(p.source ?? {}).toLowerCase());
  aggregateHits = listLocators.filter((loc) => urls.some((u) => u.includes(`github.com/${loc}`)));
} catch (e) { aggregateHits = [`aggregate fetch failed: ${e.message}`]; }
gate.proofs.listReposInLiveAggregate = aggregateHits;

// 4) A corroborated candidate carrying list + another channel on ONE row.
let corroborationProof = null;
for (const r of await d1.query("SELECT locator, provenance FROM sources WHERE provenance LIKE '%\"via\":\"list\"%' OR provenance LIKE '%\"via\": \"list\"%'")) {
  let prov = [];
  try { prov = JSON.parse(r.provenance ?? "[]"); } catch { continue; }
  const vias = [...new Set(prov.map((p) => p.via))];
  const listEntry = prov.find((p) => p.via === "list");
  if (listEntry && vias.some((v) => v !== "list")) {
    corroborationProof = { locator: r.locator, channels: vias, list: listEntry.list, section: listEntry.section ?? "" };
    break;
  }
}
gate.proofs.corroboratedCandidate = corroborationProof;

// 5) Drain state (progress file only — the drain is not disturbed).
try {
  const p = JSON.parse(readFileSync(join(ROOT, "data/backfill-drain-progress.json"), "utf8"));
  const st = statSync(join(ROOT, "data/backfill-drain-progress.json"));
  gate.proofs.drain = { batches: p.batches, newRecords: p.newRecords, progressFileAgeSec: Math.round((Date.now() - st.mtimeMs) / 1000) };
} catch { gate.proofs.drain = null; }

await store.recordScoutRun("lists", startedAt, nowIso(), {
  seedExamined: gate.totals.seedExamined,
  listsClassified: gate.totals.listsClassified,
  nominated: gate.totals.nominated,
  newCandidates: gate.totals.newCandidates,
  corroborated: gate.totals.corroborated,
});
await d1.flush();

const after = await counts(d1);
gate.after = {
  sourcesByStatus: Object.fromEntries(after.sourcesByStatus.map((r) => [r.status, r.n])),
  listed: after.recordsByStatus.find((r) => r.status === "listed")?.n ?? 0,
};
gate.backlogAfter = (gate.after.sourcesByStatus.candidate ?? 0) + (gate.after.sourcesByStatus.verified ?? 0);

writeFileSync(join(ROOT, "data/gate-lists.json"), JSON.stringify(gate, null, 2));
console.log(JSON.stringify({
  totals: gate.totals,
  handChecks: gate.handChecks.map((h) => ({ locator: h.locator, exists: h.repoExists, sectionMatch: h.sectionMatches })),
  proofs: gate.proofs,
  backlog: { before: gate.backlogBefore, after: gate.backlogAfter },
  listed: { before: gate.before.listed, after: gate.after.listed },
}, null, 2));
