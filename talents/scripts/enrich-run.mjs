// Operator driver for Enrichment (Tranche 1: layers A–C; Tranche 2
// adds Layer E here and the "enriched" mode) — the PRIMARY
// execution site for A–C + E (see README "Enrichment"): GitHub
// fetches ride the ghapi helper (authenticated; the token never
// enters this process), README/icon bytes go to R2 via the
// Cloudflare REST API, D1 writes go through the repo's WranglerD1
// adapter. The pipeline code is the same src/enrichment/* the
// Worker's /admin/enrich route drives. Layer D is NOT run here —
// generation happens only inside the Worker (it holds the
// ANTHROPIC_API_KEY); the pipeline skips D without a generator.
//
// Run via the credential launcher (injects CLOUDFLARE_API_TOKEN):
//   python3 cf/scripts/backfill_remote.py enrich-run.mjs --mode remote-mcp
//   python3 cf/scripts/backfill_remote.py enrich-run.mjs --mode traffic --limit 500
//   python3 cf/scripts/backfill_remote.py enrich-run.mjs --mode traffic --limit 500 --shard 2 --of 5
//   python3 cf/scripts/backfill_remote.py enrich-run.mjs --mode page --limit 25 [--cursor X]
//   python3 cf/scripts/backfill_remote.py enrich-run.mjs --mode enriched --layers e
//
// Modes:
//   remote-mcp — every listed MCP record with a public remote
//     endpoint (all Layer C candidates), in id order.
//   traffic    — the top N listed records by record_stats traffic
//     order (behavior score, calls_30d, id). --shard k --of n takes
//     every n-th record of that order for parallel runs.
//   page       — one page through the shared enrichPage contract
//     (the same code path as POST /admin/enrich).
//   enriched   — every record holding an enrichment row (the exact
//     tranche-1 slice), in id order. The tranche-2 E run uses this.
//
// SPEED: a remote `wrangler d1 execute` round trip costs ~5-10s in
// this sandbox, so direct modes wrap the D1 enrichment store in a
// write-through cache over DOMAIN rows: the slice's enrichment
// rows are seeded with ONE bulk read, re-reads are served from
// memory (mirroring the store's replace + hash-reconcile semantics
// exactly), and the adapter's buffered writes flush in batches.
// The Worker route does not need this — D1 bindings are cheap.
//
// Idempotent: enrichment state lives in the `enrichment` table, so
// re-running skips layers that are still fresh. Per-record failures
// are retried (3 attempts) and counted, never fatal to the run.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/home/hatch/workspace/skills-marketplace/talents";
const DIST = join(ROOT, "dist");
const imp = (rel) => import(pathToFileURL(join(DIST, rel)).href);

const { WranglerD1 } = await imp("src/discovery/wrangler-d1.js");
const { D1EnrichmentStore } = await imp("src/enrichment/store.js");
const { enrichRecord, enrichPage } = await imp("src/enrichment/pipeline.js");
const { remoteEndpointOf } = await imp("src/enrichment/layer-c.js");
const { ghapiBackedFetch } = await imp("src/discovery/scouts/ghapi-fetch.js");

const ACCOUNT_ID = "0cd06fd37ee4e07de370821cb3852a8a";
const BUCKET = "talents-assets";
const cfToken = process.env.CLOUDFLARE_API_TOKEN;
if (!cfToken) { console.error("CLOUDFLARE_API_TOKEN missing — run via cf/scripts/backfill_remote.py"); process.exit(2); }

// --- R2 via REST (the sandbox has no other R2 write path) -------------------
async function r2Put(key, bytes, contentType) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`,
    { method: "PUT", headers: { authorization: `Bearer ${cfToken}`, "content-type": contentType }, body: bytes },
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(`R2 PUT ${key} → HTTP ${res.status}`);
}
const assets = {
  async put(key, bytes, contentType) { await r2Put(key, bytes, contentType); },
};

// --- Fetch: ghapi-backed for api.github.com, plain elsewhere -----------------
const rawFetch = globalThis.fetch.bind(globalThis);
const ghapiFetch = ghapiBackedFetch(rawFetch);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pacedFetch(url, init) {
  const host = new URL(url).hostname;
  const res = await ghapiFetch(url, init);
  await sleep(host === "api.github.com" ? 250 : 120);
  return res;
}
const fetchBytes = async (url) => {
  const res = await pacedFetch(url);
  if (!res.ok) return null;
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
};

// --- Write-through caching store over domain rows (operator only) -------------
const parseJson = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
const toDomain = (r) => ({
  skillId: r.skill_id, sourceHash: r.source_hash,
  aState: r.a_state, bState: r.b_state, cState: r.c_state, dState: r.d_state, eState: r.e_state,
  a: parseJson(r.a_json), b: parseJson(r.b_json), c: parseJson(r.c_json),
  d: parseJson(r.d_json), e: parseJson(r.e_json),
  aAt: r.a_at, bAt: r.b_at, cAt: r.c_at, updatedAt: r.updated_at,
});
class CachingEnrichmentStore {
  constructor(inner) { this.inner = inner; this.cache = new Map(); }
  seed(rows) { for (const row of rows) this.cache.set(row.skillId, row); }
  async get(skillId) {
    if (this.cache.has(skillId)) return this.cache.get(skillId);
    const row = await this.inner.get(skillId);
    this.cache.set(skillId, row);
    return row;
  }
  async upsertLayer(skillId, sourceHash, layer, state, payload, at) {
    await this.inner.upsertLayer(skillId, sourceHash, layer, state, payload, at);
    const prev = this.cache.get(skillId) ?? {
      skillId, sourceHash,
      aState: "pending", bState: "pending", cState: "pending", dState: "none", eState: "none",
      a: null, b: null, c: null, d: null, e: null, aAt: null, bAt: null, cAt: null, updatedAt: at,
    };
    const next = { ...prev, sourceHash, updatedAt: at };
    if (layer === "a") { next.aState = state; next.a = payload; next.aAt = at; }
    if (layer === "b") { next.bState = state; next.b = payload; next.bAt = at; }
    if (layer === "c") { next.cState = state; next.c = payload; next.cAt = at; }
    if (layer === "d") { next.dState = state; next.d = payload; }
    if (layer === "e") { next.eState = state; next.e = payload; }
    this.cache.set(skillId, next);
  }
  async reconcileHash(skillId, newHash, at) {
    const changed = await this.inner.reconcileHash(skillId, newHash, at);
    const prev = this.cache.get(skillId);
    if (changed && prev) {
      const flip = (s) => (s === "done" || s === "partial" || s === "none" ? "stale" : s);
      // Mirror of the store's D/E rule: only an EVALUATED none
      // (payload present) goes stale; the bare schema default stays.
      const flipDE = (s, payload) => (s === "done" || s === "partial" || (s === "none" && payload !== null) ? "stale" : s);
      this.cache.set(skillId, {
        ...prev, sourceHash: newHash, updatedAt: at,
        aState: flip(prev.aState), bState: flip(prev.bState), cState: flip(prev.cState),
        dState: flipDE(prev.dState, prev.d), eState: flipDE(prev.eState, prev.e),
      });
    }
    return changed;
  }
}

// --- Args ----------------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const mode = argVal("--mode", "traffic");
const limit = Number(argVal("--limit", mode === "traffic" ? "500" : "25"));
const shardOf = Number(argVal("--of", "1"));
const shardIdx = Number(argVal("--shard", "0"));
const onlyLayers = args.includes("--layers") ? argVal("--layers", "a,b,c").split(",") : undefined;

const d1 = new WranglerD1({ cwd: join(ROOT, "cf"), config: "wrangler.deploy.jsonc", database: "talents", remote: true });
const innerStore = new D1EnrichmentStore(d1);
const store = new CachingEnrichmentStore(innerStore);
const deps = { store, db: d1, fetchFn: pacedFetch, fetchBytes, assets, probeFetch: rawFetch };
const progressPath = join(ROOT, shardOf > 1 ? `data/enrich-run-progress-${shardIdx}.json` : "data/enrich-run-progress.json");
const progress = {
  mode, shard: shardOf > 1 ? `${shardIdx}/${shardOf}` : undefined, startedAt: new Date().toISOString(),
  considered: 0, enriched: 0, skippedFresh: 0, layerRuns: { a: 0, b: 0, c: 0, d: 0, e: 0 },
  layerStates: { a: {}, b: {}, c: {}, d: {}, e: {} }, failures: 0, failureSamples: [],
};
const saveProgress = () => writeFileSync(progressPath, JSON.stringify(progress, null, 2));

// --- Page mode: the shared paged contract, one page per invocation ------------
if (mode === "page") {
  const stats = await enrichPage({ ...deps, store: innerStore }, {
    limit, cursor: argVal("--cursor", undefined), layers: onlyLayers,
  });
  await d1.flush();
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

// --- Slice selection -------------------------------------------------------------
let records;
if (mode === "remote-mcp") {
  const rows = await d1.query("SELECT record_json FROM records WHERE status = 'listed' AND kind = 'mcp' ORDER BY id");
  records = rows.map((r) => JSON.parse(r.record_json)).filter((r) => remoteEndpointOf(r));
  console.log(`remote-mcp slice: ${records.length} records with a public remote endpoint`);
} else if (mode === "enriched") {
  const rows = await d1.query(
    `SELECT r.record_json AS record_json FROM records r
     JOIN enrichment e ON e.skill_id = r.id
     WHERE r.status = 'listed' ORDER BY r.id`,
  );
  records = rows.map((r) => JSON.parse(r.record_json));
  console.log(`enriched slice: ${records.length} records holding enrichment rows`);
} else {
  const rows = await d1.query(
    `SELECT r.record_json AS record_json FROM records r
     LEFT JOIN record_stats rs ON rs.skill_id = r.id
     WHERE r.status = 'listed'
     ORDER BY COALESCE(rs.behavior_score, 0) DESC, COALESCE(rs.calls_30d, 0) DESC, r.id ASC
     LIMIT ${Math.max(1, Math.floor(limit))}`,
  );
  records = rows.map((r) => JSON.parse(r.record_json));
  if (shardOf > 1) {
    records = records.filter((_, i) => i % shardOf === shardIdx);
    console.log(`traffic slice shard ${shardIdx}/${shardOf}: ${records.length} records`);
  } else {
    console.log(`traffic slice: top ${records.length} records by behavior score / calls`);
  }
}

// Seed the cache with ONE bulk read of the slice's enrichment rows.
if (records.length) {
  const inList = records.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(",");
  const existing = await d1.query(
    `SELECT skill_id, source_hash, a_state, b_state, c_state, d_state, e_state, a_json, b_json, c_json, d_json, e_json, a_at, b_at, c_at, updated_at
     FROM enrichment WHERE skill_id IN (${inList})`,
  );
  store.seed(existing.map(toDomain));
  console.log(`seeded ${existing.length} existing enrichment rows`);
}

async function enrichWithRetry(record) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await enrichRecord(record, deps, { layers: onlyLayers }); }
    catch (e) { lastErr = e; await sleep(1500 * attempt); }
  }
  throw lastErr;
}

let sinceFlush = 0;
for (const record of records) {
  try {
    const outcome = await enrichWithRetry(record);
    progress.considered++;
    const ranLayers = Object.keys(outcome.ran);
    if (ranLayers.length) progress.enriched++;
    else progress.skippedFresh++;
    for (const l of ranLayers) progress.layerRuns[l]++;
    const row = await store.get(record.id);
    for (const l of ["a", "b", "c", "d", "e"]) {
      const s = row?.[`${l}State`];
      if (s) progress.layerStates[l][s] = (progress.layerStates[l][s] ?? 0) + 1;
    }
  } catch (e) {
    progress.considered++;
    progress.failures++;
    if (progress.failureSamples.length < 10) progress.failureSamples.push(`${record.id}: ${String(e?.message ?? e).slice(0, 160)}`);
    console.error(`FAIL ${record.id}: ${e?.message ?? e}`);
  }
  sinceFlush++;
  if (sinceFlush >= 10) {
    sinceFlush = 0;
    try { await d1.flush(); } catch (e) { console.error(`flush warning: ${e?.message ?? e}`); }
  }
  saveProgress();
  if (progress.considered % 25 === 0) console.log(`… ${progress.considered}/${records.length} (enriched ${progress.enriched}, fresh-skips ${progress.skippedFresh}, failures ${progress.failures})`);
}
await d1.flush();
progress.finishedAt = new Date().toISOString();
saveProgress();
console.log(JSON.stringify(progress, null, 2));
