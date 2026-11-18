// Backfill NOMINATION: feed a harvest checkpoint (GitHub code
// search or skills.sh) into the one funnel — production D1 sources
// rows with provenance + priority, deduped by canonical locator,
// corroboration merged. Nomination ONLY: no verification, no
// ingest (that is backfill-drain.mjs).
//
// Throughput note: store.nominate() re-reads the row per call (one
// wrangler subprocess per nomination at remote scale). This script
// preloads all sources ONCE and drives the store's own exported
// mergeNomination() + buffered upsertSource() — byte-identical
// merge semantics, batch-flushed. The funnel is the same; only the
// redundant per-row SELECT is skipped.
//
// Usage: backfill_remote.py backfill-nominate.mjs --channel github|skillssh [--state F] [--limit N]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DIST, makeDeps, nowIso } from "./backfill-lib.mjs";

const args = process.argv.slice(2);
const channel = args[args.indexOf("--channel") + 1];
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const statePath = args.includes("--state")
  ? args[args.indexOf("--state") + 1]
  : channel === "github" ? "/tmp/backfill-github-harvest.json" : "/tmp/backfill-skillssh-harvest.json";

const { mergeNomination } = await import(pathToFileURL(join(DIST, "src/discovery/store.js")).href);
const CHANNEL_WEIGHT = { "github-code-search": 3, "skills.sh": 3 };
const bump = (s) => (!s || s <= 0 ? 0 : Math.min(3, Math.log10(1 + s)));

const harvest = JSON.parse(readFileSync(statePath, "utf8"));
const at = nowIso();

function* nominations() {
  if (channel === "github") {
    for (const [locator, agg] of Object.entries(harvest.repos)) {
      const total = agg.skill + agg.marketplace + agg.plugin;
      yield {
        kind: agg.marketplace > 0 ? "marketplace" : "skill-repo",
        locator,
        url: agg.url,
        provenance: {
          via: "github-code-search", at, ref: "https://github.com/search?type=code",
          signals: { skillMdHits: agg.skill, marketplaceHits: agg.marketplace, pluginHits: agg.plugin, totalHits: total, backfillWindows: agg.shards.length },
          note: "code search FULL BACKFILL — repo nominated, contents unverified",
        },
        priorityDelta: CHANNEL_WEIGHT["github-code-search"] + bump(total),
        signal: total,
      };
    }
  } else if (channel === "skillssh") {
    for (const [locator, agg] of Object.entries(harvest.repos)) {
      yield {
        kind: "skill-repo",
        locator,
        url: `https://github.com/${locator}`,
        provenance: {
          via: "skills.sh", at, ref: "https://www.skills.sh/sitemap.xml",
          signals: { ...(agg.installs !== undefined ? { installs: agg.installs } : {}), listings: agg.listings },
          note: "skills.sh FULL BACKFILL (sitemap enumeration) — repo nominated, contents unverified",
        },
        priorityDelta: CHANNEL_WEIGHT["skills.sh"] + bump(agg.installs ?? agg.listings),
        signal: agg.installs ?? 0,
        installs: agg.installs,
      };
    }
  } else {
    throw new Error(`unknown --channel ${channel}`);
  }
}

const { d1, store } = await makeDeps();
const startedAt = nowIso();
console.log("preloading sources…");
const existing = await store.listSources();
const byLocator = new Map(existing.map((r) => [r.locator, r]));
console.log(`preloaded ${byLocator.size} sources`);

// --resume: skip locators this channel's backfill already landed
// (a prior run may have died on a D1 import-lock flush error).
const resume = args.includes("--resume");
const via = channel === "github" ? "github-code-search" : "skills.sh";
const alreadyLanded = (locator) => {
  const row = byLocator.get(locator);
  return Boolean(row?.provenance?.some((p) => p.via === via && String(p.note ?? "").includes("FULL BACKFILL")));
};
// D1 rejects --file imports while another import is processing
// (concurrent drain flushes): retry with backoff instead of dying.
const flushRetry = async () => {
  for (let attempt = 0; ; attempt++) {
    try { await d1.flush(); return; }
    catch (e) {
      if (attempt >= 6) throw e;
      console.log(`flush blocked (${String(e.message).slice(0, 80)}…) — retry ${attempt + 1} in 45s`);
      await new Promise((r) => setTimeout(r, 45_000));
    }
  }
};

let created = 0, corroborated = 0, processed = 0, installsAttached = 0;
let recordIdsByRepo = null;
if (channel === "skillssh") {
  const rows = await d1.query("SELECT id, source_repo FROM records WHERE source_repo IS NOT NULL");
  recordIdsByRepo = new Map();
  for (const r of rows) {
    const arr = recordIdsByRepo.get(r.source_repo) ?? [];
    arr.push(r.id);
    recordIdsByRepo.set(r.source_repo, arr);
  }
}

const sorted = [...nominations()].sort((a, b) => (b.signal ?? 0) - (a.signal ?? 0));
let skippedLanded = 0;
for (const n of sorted) {
  if (processed >= limit) break;
  if (resume && alreadyLanded(n.locator)) { skippedLanded++; continue; }
  const res = mergeNomination(byLocator.get(n.locator) ?? null, {
    kind: n.kind, locator: n.locator, url: n.url ?? null,
    discoveredVia: n.provenance.via, provenance: n.provenance,
    priorityDelta: n.priorityDelta, reason: n.provenance.note,
  }, at);
  byLocator.set(n.locator, res.row);
  await store.upsertSource(res.row);
  if (res.created) created++;
  if (res.corroborated) corroborated++;
  if (channel === "skillssh" && n.installs !== undefined) {
    for (const id of recordIdsByRepo.get(n.locator) ?? []) {
      await store.setExternalInstalls(id, n.installs, "skills.sh");
      installsAttached++;
    }
  }
  processed++;
  if (processed % 150 === 0) {
    await flushRetry();
    console.log(`nominated ${processed} (created ${created}, corroborated ${corroborated})`);
  }
}
await flushRetry();
await store.recordScoutRun(
  channel === "github" ? "github-code-search" : "skills.sh",
  startedAt, nowIso(),
  { backfill: true, harvest: statePath, funnel: { nominated: processed, created, corroborated, ...(channel === "skillssh" ? { externalInstallsAttached: installsAttached } : {}) } },
);
await flushRetry();
const byStatus = await store.countSourcesByStatus();
console.log(JSON.stringify({ channel, processed, created, corroborated, skippedLanded, ...(channel === "skillssh" ? { installsAttached } : {}), sourcesByStatus: byStatus }, null, 2));
