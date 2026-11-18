// Repair pass for the component-shape defect (2026-11-11).
//
// A marketplace entry may carry a component collection as a BARE
// STRING (the plugin spec allows `commands: "./commands/"`), and the
// pre-fix ingest passed entry values through unchecked, producing
// two stored corruption shapes:
//   (1) components.commands stored as TEXT — the renderer crashed
//       on `commands.map` (aaron-he-zhu/aaron-marketing page 500);
//   (2) components.skills stored as a CHAR ARRAY ("./skills/"
//       spread into [".","/","s","k",...]) — array-shaped, so a
//       json_type sweep misses it (jeffallan/fullstack-dev-skills).
// In both records the derived DECLARATION is polluted by the same
// spread ("Provides 10 slash command(s): ./commands/, ., /, c, ..."),
// so in-place normalization is NOT enough: each affected record is
// REBUILT through its original builder with the fixed code and
// upserted via D1DiscoveryStore.upsertRecord — the refresh/re-attest
// flow the description repair used (the rebuilt record carries the
// builder's fresh attestation; record_json, search_text and the FTS
// row stay consistent). Records whose builder can no longer produce
// them fall back to in-place normalizeComponents (shape-only, noted
// in the result file).
//
// Enumeration (production sweep, 16,096 listed at sweep time):
//   - any of components.{skills,commands,agents,mcpServers} with
//     json_type IS NOT 'array', OR
//   - any of components.{skills,commands,agents} an array of >=5
//     entries ALL of length <= 1 (char-spread detector).
// Result: exactly 2 records (listed in data/repair-components-result.json).
//
// Run with TALENTS_DIST=<repo>/dist so imports resolve to the fixed
// build (the backfill drain keeps its own snapshot; untouched).
// Resumable: progress checkpointed to
// data/repair-components-progress.json.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/home/hatch/workspace/skills-marketplace/talents";
const DIST = process.env.TALENTS_DIST ?? join(ROOT, "dist");
const imp = (rel) => import(pathToFileURL(join(DIST, rel)).href);

const PROGRESS_PATH = join(ROOT, "data/repair-components-progress.json");
const RESULT_PATH = join(ROOT, "data/repair-components-result.json");

const { makeDeps } = await import(pathToFileURL(join(ROOT, "scripts/backfill-lib.mjs")).href);
const { normalizeComponents } = await imp("src/validate.js");
const { ingestGithubRepo } = await imp("src/ingest.js");
const { scanGithubRepoSkills } = await imp("src/repo-scan.js");

const deps = await makeDeps();
const { d1, store } = deps;

const progress = existsSync(PROGRESS_PATH)
  ? JSON.parse(readFileSync(PROGRESS_PATH, "utf8"))
  : { doneIds: [], repaired: [], unrepaired: [], unchanged: [] };
const saveProgress = () => writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));

// --- enumerate affected records -------------------------------------
const FIELDS = ["skills", "commands", "agents", "mcpServers"];
const typeBad = FIELDS.map((f) => `json_type(record_json,'$.components.${f}') IS NOT 'array'`).join(" OR ");
const spreadBad = ["skills", "commands", "agents"].map((f) =>
  `(json_type(record_json,'$.components.${f}')='array' AND json_array_length(record_json,'$.components.${f}')>=5 AND NOT EXISTS (SELECT 1 FROM json_each(record_json,'$.components.${f}') WHERE length(value)>1))`,
).join(" OR ");
const listedRows = await d1.query(`SELECT COUNT(*) AS n FROM records WHERE status='listed'`);
const listedTotal = listedRows[0].n;
const affected = await d1.query(
  `SELECT id, record_json FROM records WHERE status='listed' AND (${typeBad} OR ${spreadBad}) ORDER BY id`,
);
console.log(`listed=${listedTotal} affected=${affected.length}`);
for (const r of affected) console.log(`  ${r.id}`);

if (process.argv.includes("--enumerate-only")) {
  console.log("ENUMERATE ONLY — no scans, no writes.");
  process.exit(0);
}

// --- rebuild + repair, one record at a time --------------------------
for (const row of affected) {
  if (progress.doneIds.includes(row.id)) {
    console.log(`skip (done): ${row.id}`);
    continue;
  }
  const stored = JSON.parse(row.record_json);
  const before = { components: stored.components, declaration: stored.declaration };

  // Pick the original builder from the record's provenance.
  let rebuilt = null;
  let via = "";
  try {
    if (typeof stored.sourceMarketplace === "string" && stored.sourceMarketplace.startsWith("direct-repo-scan:")) {
      const summary = await scanGithubRepoSkills(stored.sourceRepo, { registryKey: deps.key, fetchFn: deps.fetchFn, ref: stored.ref });
      rebuilt = summary.records.find((r) => r.id === row.id) ?? null;
      via = "repo-scan rebuild";
    } else if (typeof stored.sourceMarketplace === "string" && /^[^/]+\/[^/]+$/.test(stored.sourceMarketplace)) {
      const summary = await ingestGithubRepo(stored.sourceMarketplace, { registryKey: deps.key, fetchFn: deps.fetchFn });
      rebuilt = summary.records.find((r) => r.id === row.id) ?? null;
      via = "marketplace rebuild";
    }
  } catch (e) {
    console.log(`rebuild threw for ${row.id}: ${e.message}`);
  }

  if (rebuilt) {
    const after = { components: rebuilt.components, declaration: rebuilt.declaration };
    if (JSON.stringify(before) === JSON.stringify(after)) {
      progress.unchanged.push({ id: row.id, via });
    } else {
      await store.upsertRecord(rebuilt);
      progress.repaired.push({ id: row.id, via, before, after });
    }
  } else {
    // Fallback: shape-only normalization of the stored record.
    const after = normalizeComponents(stored.components);
    if (JSON.stringify(stored.components) === JSON.stringify(after)) {
      progress.unrepaired.push({ id: row.id, reason: "not present in rebuild and components already array-shaped (declaration pollution, if any, needs a source rebuild)" });
    } else {
      stored.components = after;
      await store.upsertRecord(stored);
      progress.repaired.push({ id: row.id, via: "in-place normalize (fallback)", before, after: { components: after, declaration: stored.declaration } });
    }
  }
  await d1.flush();
  // NOTE: the local data/registry.json mirror is deliberately NOT
  // touched — the running backfill drain owns it. D1 is authoritative.
  progress.doneIds.push(row.id);
  saveProgress();
  console.log(`done ${row.id} via ${via || "fallback"}`);
}

writeFileSync(RESULT_PATH, JSON.stringify({
  at: new Date().toISOString(),
  listedTotal,
  affectedTotal: affected.length,
  repaired: progress.repaired,
  unrepaired: progress.unrepaired,
  unchanged: progress.unchanged,
}, null, 2));
console.log(`REPAIR DONE: repaired=${progress.repaired.length} unrepaired=${progress.unrepaired.length} unchanged=${progress.unchanged.length}`);
