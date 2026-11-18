// Repair pass for the description-extraction defect (2026-11-11).
//
// Enumerates every LISTED record whose stored description is debris —
// content-free per isUsableDescription ("---", "/====/", …) or carrying
// block-scalar residue ("| …" / "> …" from the pre-fix frontmatter
// parser) — groups them by (sourceRepo, ref), rebuilds each repo with
// the pipeline's own scanner (scanGithubRepoSkills, the exact builder
// that produced these records) using the FIXED dist, and upserts only
// the records whose description actually changes. Writes go through
// D1DiscoveryStore.upsertRecord — the same store write the pipeline
// uses — so record_json, search_text and the FTS row stay consistent,
// and each upserted record carries the builder's fresh attestation.
//
// Run with TALENTS_DIST=<repo>/dist so imports resolve to the fixed
// build (the backfill drain keeps its own snapshot; untouched).
// Resumable: per-repo progress is checkpointed to
// data/repair-descriptions-progress.json; re-running skips done repos.
// Final per-record before/after lands in
// data/repair-descriptions-result.json.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/home/hatch/workspace/skills-marketplace/talents";
const DIST = process.env.TALENTS_DIST ?? join(ROOT, "dist");
const imp = (rel) => import(pathToFileURL(join(DIST, rel)).href);

const PROGRESS_PATH = join(ROOT, "data/repair-descriptions-progress.json");
const RESULT_PATH = join(ROOT, "data/repair-descriptions-result.json");

const { makeDeps } = await import(pathToFileURL(join(ROOT, "scripts/backfill-lib.mjs")).href);
const { isUsableDescription } = await imp("src/validate.js");
const { scanGithubRepoSkills } = await imp("src/repo-scan.js");

const deps = await makeDeps();
const { d1, store } = deps;

const progress = existsSync(PROGRESS_PATH)
  ? JSON.parse(readFileSync(PROGRESS_PATH, "utf8"))
  : { doneRepos: [], repaired: [], unrepaired: [], unchangedAfterRebuild: [] };
const saveProgress = () => writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));

// --- enumerate affected records -------------------------------------
async function fetchAllListed() {
  const rows = [];
  const page = 3000;
  for (let offset = 0; ; offset += page) {
    const batch = await d1.query(
      `SELECT id, json_extract(record_json,'$.description') AS descr, ` +
      `json_extract(record_json,'$.sourceRepo') AS repo, json_extract(record_json,'$.ref') AS ref, ` +
      `json_extract(record_json,'$.sourceMarketplace') AS mp ` +
      `FROM records WHERE status='listed' ORDER BY rowid LIMIT ${page} OFFSET ${offset}`,
    );
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return rows;
}

const all = await fetchAllListed();
const affected = all.filter((r) => {
  const d = r.descr ?? "";
  if (d.startsWith("| ") || d.startsWith("> ")) return true; // block-scalar residue
  if (d !== "" && !isUsableDescription(d)) return true; // content-free debris
  return false;
});
console.log(`listed=${all.length} affected=${affected.length}`);

const groups = new Map();
for (const r of affected) {
  const key = `${r.repo}@${r.ref}`;
  if (!groups.has(key)) groups.set(key, { repo: r.repo, ref: r.ref, rows: [] });
  groups.get(key).rows.push(r);
}
console.log(`repos to rebuild: ${groups.size}`);
for (const { repo, ref, rows } of groups.values()) console.log(`  ${repo}@${ref}: ${rows.length}`);

if (process.argv.includes("--enumerate-only")) {
  console.log("ENUMERATE ONLY — no scans, no writes.");
  process.exit(0);
}

// --- rebuild + repair, one repo at a time ----------------------------
for (const { repo, ref, rows } of groups.values()) {
  const groupKey = `${repo}@${ref}`;
  if (progress.doneRepos.includes(groupKey)) {
    console.log(`skip (done): ${groupKey}`);
    continue;
  }
  const affectedIds = new Map(rows.map((r) => [r.id, r.descr ?? ""]));
  let summary;
  try {
    summary = await scanGithubRepoSkills(repo, { registryKey: deps.key, fetchFn: deps.fetchFn, ref });
  } catch (e) {
    console.log(`FAIL scan ${groupKey}: ${e.message}`);
    for (const [id, before] of affectedIds) progress.unrepaired.push({ id, before, reason: `scan threw: ${e.message}` });
    progress.doneRepos.push(groupKey);
    saveProgress();
    continue;
  }
  if (summary.note) console.log(`  note for ${groupKey}: ${summary.note}`);
  progress.repoNotes = progress.repoNotes ?? {};
  progress.repoNotes[groupKey] = {
    scanned: summary.total, rebuilt: summary.records.length, deadLetter: summary.deadLetter,
    ...(summary.note ? { note: summary.note } : {}),
  };
  const rebuiltById = new Map(summary.records.map((r) => [r.id, r]));
  for (const [id, before] of affectedIds) {
    const rebuilt = rebuiltById.get(id);
    if (!rebuilt) {
      progress.unrepaired.push({ id, before, reason: "not present in rebuild (renamed/removed upstream, or dead-lettered on revalidation)" });
      continue;
    }
    if (rebuilt.description === before) {
      progress.unchangedAfterRebuild.push({ id, before });
      continue;
    }
    await store.upsertRecord(rebuilt);
    progress.repaired.push({ id, before, after: rebuilt.description });
  }
  await d1.flush();
  // NOTE: the local data/registry.json mirror is deliberately NOT
  // touched — the running backfill drain owns it (its own in-memory
  // copy saves over the file per batch). D1 is the authoritative
  // store; the mirror is an operator convenience copy.
  progress.doneRepos.push(groupKey);
  saveProgress();
  console.log(`done ${groupKey}: ${rows.length} affected, repaired so far=${progress.repaired.length}, unrepaired=${progress.unrepaired.length}`);
}

writeFileSync(RESULT_PATH, JSON.stringify({
  at: new Date().toISOString(),
  listedTotal: all.length,
  affectedTotal: affected.length,
  repoGroups: groups.size,
  repaired: progress.repaired,
  unrepaired: progress.unrepaired,
  unchangedAfterRebuild: progress.unchangedAfterRebuild,
}, null, 2));
console.log(`REPAIR DONE: repaired=${progress.repaired.length} unrepaired=${progress.unrepaired.length} unchanged=${progress.unchangedAfterRebuild.length}`);
