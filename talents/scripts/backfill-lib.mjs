// Shared deps for the backfill scripts (GitHub code-search +
// skills.sh full-coverage runs and the backlog drain).
//
// Imports the PREBUILT dist snapshot at /tmp/talents-dist (override
// with TALENTS_DIST) so a concurrent build in the repo can never
// swap modules under a running backfill. All D1 access goes through
// the established WranglerD1 remote adapter against production —
// the identical store code the CLI uses. No shared repo files are
// modified by anything in this folder.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = "/home/hatch/workspace/skills-marketplace/talents";
export const DIST = process.env.TALENTS_DIST ?? "/tmp/talents-dist";

const imp = (rel) => import(pathToFileURL(join(DIST, rel)).href);

export async function makeDeps({ pacerMs = 300 } = {}) {
  const { WranglerD1 } = await imp("src/discovery/wrangler-d1.js");
  const { D1DiscoveryStore } = await imp("src/discovery/store.js");
  const { Pacer } = await imp("src/discovery/sweep.js");
  const { ghapiBackedFetch } = await imp("src/discovery/scouts/ghapi-fetch.js");
  const { defaultFetch } = await imp("src/ingest.js");
  const { loadOrCreateRegistryKey } = await imp("src/attest.js");
  const { RegistryStore } = await imp("src/records.js");

  const d1 = new WranglerD1({
    cwd: join(ROOT, "cf"),
    config: "wrangler.deploy.jsonc",
    database: "talents",
    remote: true,
  });
  const store = new D1DiscoveryStore(d1);
  const key = loadOrCreateRegistryKey(join(ROOT, "data/registry-key.json"));
  const mirror = new RegistryStore(join(ROOT, "data/registry.json"));
  const pacer = new Pacer(pacerMs);
  const fetchFn = ghapiBackedFetch(defaultFetch);
  const onNewRecords = async (records) => {
    for (const r of records) mirror.upsert(r);
    mirror.save();
  };
  return { d1, store, key, mirror, pacer, fetchFn, onNewRecords };
}

export async function counts(d1) {
  const q = async (sql) => (await d1.query(sql));
  const recordsByStatus = await q("SELECT status, COUNT(*) AS n FROM records GROUP BY status ORDER BY status");
  const sourcesByStatus = await q("SELECT status, COUNT(*) AS n FROM sources GROUP BY status ORDER BY status");
  const sourcesByViaStatus = await q("SELECT discovered_via, status, COUNT(*) AS n FROM sources GROUP BY discovered_via, status ORDER BY discovered_via, status");
  const [{ n: embeddingMeta }] = await q("SELECT COUNT(*) AS n FROM embedding_meta");
  const [{ n: listedUnembedded }] = await q(
    "SELECT COUNT(*) AS n FROM records r WHERE r.status = 'listed' AND NOT EXISTS (SELECT 1 FROM embedding_meta e WHERE e.skill_id = r.id)",
  );
  const [{ n: recordStats }] = await q("SELECT COUNT(*) AS n FROM record_stats");
  return { recordsByStatus, sourcesByStatus, sourcesByViaStatus, embeddingMeta, listedUnembedded, recordStats };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();
