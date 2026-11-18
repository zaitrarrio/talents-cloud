// Stats fix (P0-1, 2026-11-12) — refreshRecordStats loaded the whole
// catalog (53.5 MB > D1's 50 MB result limit) and then issued one
// INSERT per listed record (22,407 > the 1,000 queries/invocation
// cap), so it could not complete anywhere in the Worker: every
// verified queue message threw after ingest and dead-lettered.
// Stats are now maintained incrementally (upsertStatsForRecords)
// plus a paged rebuild job (rebuildStatsPage / /admin/stats-rebuild).
//
// These tests run against the REAL D1DiscoveryStore over a real
// SQLite database built from the production migrations, behind a
// STRICT D1Like that enforces the two platform caps the old code
// violated: a per-query response-size cap and a per-invocation
// statement cap. The 60k-record store is literal (the plan's
// 60k-record synthetic store); the caps are the production values
// (50 MB / 900 statements).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import type { RegistryKey } from "../src/attest.js";
import type { D1Like, D1StatementLike } from "../src/search-d1.js";
import {
  D1DiscoveryStore, type SourceRow,
} from "../src/discovery/store.js";
import { behaviorScore } from "../src/discovery/ranking.js";
import type { SkillRecord } from "../src/types.js";
import { Pacer } from "../src/discovery/sweep.js";
import {
  handleAdminStatsRebuild, handleQueueMessage, type IngestQueueMessage,
} from "../cf/src/discovery.js";
import type { Env } from "../cf/src/db.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...p: unknown[]): Record<string, unknown>[];
      get(...p: unknown[]): Record<string, unknown> | undefined;
      run(...p: unknown[]): unknown;
    };
  };
};
type RawDb = InstanceType<typeof DatabaseSync>;

const MIGRATIONS = ["0001_init.sql", "0002_discovery.sql", "0003_vector_id.sql", "0004_scouts.sql", "0007_harden_drain.sql"];

function makeRawDb(): RawDb {
  const raw = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) {
    raw.exec(readFileSync(new URL(`../../cf/migrations/${f}`, import.meta.url), "utf8"));
  }
  return raw;
}

/** Strict D1Like: counts statements per invocation window and
 *  enforces a per-query response-size cap (measured as the JSON
 *  byte length of the returned rows — the same quantity D1 caps
 *  at 50 MB). */
function makeStrictDb(raw: RawDb, opts: { responseCapBytes: number; statementCap: number }): {
  db: D1Like;
  count: () => number;
  reset: () => void;
} {
  let statements = 0;
  const db: D1Like = {
    prepare(sql: string): D1StatementLike {
      statements++;
      if (statements > opts.statementCap) {
        throw new Error(`statsfix test: statement cap ${opts.statementCap} exceeded at: ${sql.slice(0, 120)}`);
      }
      const stmt = raw.prepare(sql);
      let params: unknown[] = [];
      const self: D1StatementLike = {
        bind(...p: unknown[]) { params = p; return self; },
        async all<T>() {
          const results = stmt.all(...params) as T[];
          const bytes = Buffer.byteLength(JSON.stringify(results), "utf8");
          if (bytes > opts.responseCapBytes) {
            throw new Error(`statsfix test: response cap ${opts.responseCapBytes} exceeded (${bytes} bytes) at: ${sql.slice(0, 120)}`);
          }
          return { results };
        },
        async run() { stmt.run(...params); return {}; },
        async first<T>() { return (stmt.get(...params) as T | undefined) ?? null; },
      };
      return self;
    },
  };
  return { db, count: () => statements, reset: () => { statements = 0; } };
}

const NOW = new Date("2026-11-12T02:00:00.000Z");

/** Minimal record_json (~jsonBytes) for raw seeding. Only the
 *  fields the stats path reads are material: id, owner, status,
 *  validation.issues. */
function recordJson(id: string, owner: string, warnings: number, padBytes: number): string {
  const issues = Array.from({ length: warnings }, (_, i) => ({ severity: "warning", code: `w${i}`, message: "w" }));
  const base = JSON.stringify({
    id, owner, name: id.split("/")[1], description: "seed record",
    status: "listed", validation: { issues }, attestation: null,
  });
  const pad = Math.max(0, padBytes - base.length);
  // Pad inside the description so the JSON stays valid.
  const doc = JSON.parse(base) as Record<string, unknown>;
  doc.description = "seed record " + "x".repeat(pad);
  return JSON.stringify(doc);
}

/** Seed `n` listed records across `owners` owners via raw
 *  multi-row INSERTs (fast — no per-record store writes).
 *  Returns the seeded ids in id order. */
function seedRecords(raw: RawDb, n: number, owners: number, jsonBytes: number): string[] {
  const ids: string[] = [];
  const CHUNK = 500;
  for (let start = 0; start < n; start += CHUNK) {
    const rows: string[] = [];
    const params: unknown[] = [];
    for (let i = start; i < Math.min(start + CHUNK, n); i++) {
      const owner = `owner${i % owners}`;
      const id = `${owner}/skill-${String(i).padStart(5, "0")}`;
      ids.push(id);
      rows.push(`(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      params.push(id, owner, `skill-${String(i).padStart(5, "0")}`, "skill", "listed",
        `${owner}/repo`, "main", recordJson(id, owner, i % 3 === 0 ? 1 : 0, jsonBytes), "seed record",
        i % 2 === 0 ? "attest-hash" : null, NOW.toISOString());
    }
    raw.prepare(`INSERT INTO records (id, owner, name, kind, status, source_repo, ref, record_json, search_text, attestation_hash, ingested_at) VALUES ${rows.join(", ")}`).run(...params);
  }
  return ids.sort();
}

function testKey(): RegistryKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function makeEnv(db: D1Like): Env {
  return { DB: db, TALENTS_REGISTRY_KEY: JSON.stringify(testKey()) } as unknown as Env;
}

const fastPacer = () => new Pacer(0, async () => {}, () => 0);

// --- Fixture fetch stub (same shape as queuedrain.test.ts) -----------

type StubResult = { status: number; body?: unknown } | "throw";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function installFetch(handler: (url: string) => StubResult): void {
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    const r = handler(url);
    if (r === "throw") throw new Error("network down (test stub)");
    const body = r.body ?? {};
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    };
  }) as typeof fetch;
}

const resp = (status: number, body?: unknown): StubResult => ({ status, body });

function serveRepo(locator: string, tree: { path: string; type: string }[], files: Record<string, string>): (url: string) => StubResult | null {
  return (url: string) => {
    if (url === `https://api.github.com/repos/${locator}`) return resp(200, { default_branch: "main" });
    if (url === `https://api.github.com/repos/${locator}/git/trees/HEAD?recursive=1`) return resp(200, { tree, truncated: false });
    if (url === `https://api.github.com/repos/${locator}/git/trees/main?recursive=1`) return resp(200, { tree, truncated: false });
    const rawPrefix = `https://raw.githubusercontent.com/${locator}/main/`;
    if (url.startsWith(rawPrefix)) {
      const path = url.slice(rawPrefix.length);
      if (path in files) return resp(200, files[path]);
      return resp(404, "not found");
    }
    return null;
  };
}

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# body\n`;

function minimalRecord(partial: Partial<SkillRecord> & { id: string; owner: string }): SkillRecord {
  return {
    name: partial.id.split("/")[1],
    url: `https://talents.sh/skills/${partial.id}`,
    profileUrl: `https://talents.sh/${partial.owner}`,
    kind: "skill",
    description: "seed record",
    sourceType: "github",
    source: {},
    sourceMarketplace: "",
    ref: "main",
    pointerOnly: false,
    components: { skills: [], commands: [], agents: [], hooks: false, mcpServers: [] },
    declaration: { kind: "skill", name: partial.id.split("/")[1], description: "seed record", commands: [], skills: [], agents: [], mcpServers: [], hooks: [], files: [] } as unknown as SkillRecord["declaration"],
    validation: { issues: [] },
    attestation: null,
    filesHashed: [],
    status: "listed",
    ingestedAt: NOW.toISOString(),
    ...partial,
  } as SkillRecord;
}

async function statsRow(db: D1Like, id: string): Promise<Record<string, unknown> | null> {
  return db.prepare("SELECT * FROM record_stats WHERE skill_id = ?").bind(id).first<Record<string, unknown>>();
}

// ---------------------------------------------------------------------------
// The caps bite: the old full-table SELECT trips the 50 MB response cap
// on a 60k-record store, and the new incremental path stays under it.
// ---------------------------------------------------------------------------

test("statsfix: full-table record_json SELECT trips the 50 MB cap at 60k records; incremental stats stay under it", async () => {
  const raw = makeRawDb();
  const ids = seedRecords(raw, 60_000, 200, 1_000); // ~60 MB of record_json
  const total = raw.prepare("SELECT COALESCE(SUM(LENGTH(record_json)),0) AS n FROM records").get() as { n: number };
  assert.ok(total.n > 50_000_000, `seed total ${total.n} should exceed the 50 MB cap`);
  const strict = makeStrictDb(raw, { responseCapBytes: 50_000_000, statementCap: 900 });
  // The old shape: one unscoped SELECT over the whole table.
  await assert.rejects(
    strict.db.prepare("SELECT record_json FROM records WHERE status = 'listed'").all(),
    /response cap/,
  );
  // The new shape: stats for a 100-record single-owner batch.
  const store = new D1DiscoveryStore(strict.db);
  const batch = ids.slice(0, 100).map((id) => minimalRecord({ id, owner: id.split("/")[0] }));
  strict.reset();
  const n = await store.upsertStatsForRecords(batch, NOW);
  assert.equal(n, 100);
  assert.ok(strict.count() < 100, `incremental stats for 100 records took ${strict.count()} statements (cap 100)`);
  // And the rows actually landed.
  const row = await statsRow(strict.db, ids[0]);
  assert.ok(row, "stats row written for batch record");
  assert.equal(row!.owner_records, 300, "owner_records reflects the owner's full listed count");
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Correctness: exact stats incl. owner aggregates + external_installs
// preservation.
// ---------------------------------------------------------------------------

test("statsfix: incremental stats match the from-scratch formula exactly, and never clobber external_installs", async () => {
  const raw = makeRawDb();
  const strict = makeStrictDb(raw, { responseCapBytes: 50_000_000, statementCap: 900 });
  const store = new D1DiscoveryStore(strict.db);
  // Owners: acme has 3 records (2 attested; warnings 0+2+1), solo has 1 (unattested, 0 warnings).
  const recs = [
    minimalRecord({ id: "acme/a1", owner: "acme", attestation: { contentHash: "h1" } as SkillRecord["attestation"] }),
    minimalRecord({ id: "acme/a2", owner: "acme", attestation: { contentHash: "h2" } as SkillRecord["attestation"], validation: { issues: [{ severity: "warning", code: "w1", message: "w" }, { severity: "warning", code: "w2", message: "w" }] } as SkillRecord["validation"] }),
    minimalRecord({ id: "acme/a3", owner: "acme", validation: { issues: [{ severity: "warning", code: "w1", message: "w" }] } as SkillRecord["validation"] }),
    minimalRecord({ id: "solo/b1", owner: "solo" }),
  ];
  // Seed the DB rows the aggregates read from (raw, matching the objects).
  for (const r of recs) {
    const warnings = r.validation.issues.filter((i) => i.severity === "warning").length;
    raw.prepare("INSERT INTO records (id, owner, name, kind, status, source_repo, ref, record_json, search_text, attestation_hash, ingested_at) VALUES (?, ?, ?, 'skill', 'listed', ?, 'main', ?, '', ?, ?)")
      .run(r.id, r.owner, r.name, `${r.owner}/repo`, recordJson(r.id, r.owner, warnings, 200), r.attestation ? "hash" : null, NOW.toISOString());
  }
  // Gateway calls for a1: 3 in 7d, 2 in prev 7d, 1 older than 30d.
  const day = 86_400_000;
  const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * day).toISOString();
  for (const d of [1, 2, 3, 10, 11, 40]) {
    raw.prepare("INSERT INTO gateway_calls (tool, skill_id, called_at) VALUES ('search_skill', 'acme/a1', ?)").run(at(d));
  }
  // Installs for a1: 2 total, 1 in 30d.
  raw.prepare("INSERT INTO installs (id, skill_id, pinned_ref, attestation_hash, installed_at, installer) VALUES ('i1', 'acme/a1', 'main', 'h', ?, 'u1')").run(at(2));
  raw.prepare("INSERT INTO installs (id, skill_id, pinned_ref, attestation_hash, installed_at, installer) VALUES ('i2', 'acme/a1', 'main', 'h', ?, 'u1')").run(at(40));

  // External installs first: the stats upsert must preserve them.
  await store.setExternalInstalls("acme/a1", 7, "skills.sh");
  const n = await store.upsertStatsForRecords(recs, NOW);
  assert.equal(n, 4);

  const a1 = await statsRow(strict.db, "acme/a1");
  assert.ok(a1);
  assert.equal(a1!.calls_30d, 5);
  assert.equal(a1!.calls_7d, 3);
  assert.equal(a1!.calls_prev_7d, 2);
  assert.equal(a1!.installs_total, 2);
  assert.equal(a1!.installs_30d, 1);
  assert.equal(a1!.owner_records, 3);
  assert.equal(a1!.owner_attested_share, 2 / 3);
  assert.equal(a1!.owner_warning_rate, 1);
  assert.equal(a1!.behavior_score, behaviorScore({
    calls30d: 5, calls7d: 3, callsPrev7d: 2, installsTotal: 2, installs30d: 1,
    ownerAttestedShare: 2 / 3, ownerWarningRate: 1,
  }));
  assert.equal(a1!.external_installs, 7, "external_installs preserved across the stats upsert");
  assert.equal(a1!.external_source, "skills.sh");

  const b1 = await statsRow(strict.db, "solo/b1");
  assert.ok(b1);
  assert.equal(b1!.calls_30d, 0);
  assert.equal(b1!.owner_records, 1);
  assert.equal(b1!.owner_attested_share, 0);
  assert.equal(b1!.owner_warning_rate, 0);
  assert.equal(b1!.behavior_score, 0);

  // And the reverse order: external installs set AFTER the stats
  // upsert must not disturb the computed columns.
  await store.setExternalInstalls("solo/b1", 3, "skills.sh");
  const b1b = await statsRow(strict.db, "solo/b1");
  assert.equal(b1b!.external_installs, 3);
  assert.equal(b1b!.calls_30d, 0);
  assert.equal(b1b!.behavior_score, 0);
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Rebuild job: paged convergence + per-page statement bound.
// ---------------------------------------------------------------------------

test("statsfix: rebuildStatsPage converges coverage with bounded pages", async () => {
  const raw = makeRawDb();
  seedRecords(raw, 1_200, 4, 1_000);
  const strict = makeStrictDb(raw, { responseCapBytes: 50_000_000, statementCap: 900 });
  const store = new D1DiscoveryStore(strict.db);
  let cursor: string | null = null;
  let total = 0;
  let pages = 0;
  let done = false;
  while (!done) {
    strict.reset();
    const out = await store.rebuildStatsPage(500, cursor, NOW);
    assert.ok(strict.count() < 900, `rebuild page took ${strict.count()} statements (cap 900)`);
    total += out.processed;
    cursor = out.nextCursor;
    done = out.done;
    pages++;
    assert.ok(pages < 10, "rebuild should converge in a few pages");
  }
  assert.equal(total, 1_200);
  assert.equal(pages, 3);
  const count = raw.prepare("SELECT COUNT(*) AS n FROM record_stats").get() as { n: number };
  assert.equal(count.n, 1_200, "every listed record has a stats row after the rebuild");
  globalThis.fetch = realFetch;
});

test("statsfix: /admin/stats-rebuild pages with limit/cursor/done and reports coverage", async () => {
  const raw = makeRawDb();
  seedRecords(raw, 5, 2, 500);
  const strict = makeStrictDb(raw, { responseCapBytes: 50_000_000, statementCap: 900 });
  const env = makeEnv(strict.db);
  let cursor: string | undefined;
  let total = 0;
  let done = false;
  while (!done) {
    const out = await handleAdminStatsRebuild(env, { limit: 2, cursor }) as {
      processed: number; nextCursor: string | null; done: boolean; statsRows: number; listed: number;
    };
    total += out.processed;
    cursor = out.nextCursor ?? undefined;
    done = out.done;
    assert.equal(out.listed, 5);
  }
  assert.equal(total, 5);
  const last = await handleAdminStatsRebuild(env, { limit: 2, cursor: undefined }) as { statsRows: number };
  assert.equal(last.statsRows, 5);
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Consumer: a verified-queue message for a 100-skill collection
// completes with no error, stats rows for every record, and the
// whole message under the per-invocation statement cap. (The
// plan's "<100 statements" bar is the STATS portion — the ingest
// itself is ~3 statements/record by construction; the stats
// portion is asserted directly in the 60k test above.)
// ---------------------------------------------------------------------------

test("statsfix: verified queue message for a 100-skill collection completes without DLQing", async () => {
  const raw = makeRawDb();
  const strict = makeStrictDb(raw, { responseCapBytes: 50_000_000, statementCap: 900 });
  const store = new D1DiscoveryStore(strict.db);
  const tree = Array.from({ length: 100 }, (_, i) => ({ path: `skills/s${String(i).padStart(2, "0")}/SKILL.md`, type: "blob" }));
  const files: Record<string, string> = {};
  for (let i = 0; i < 100; i++) {
    files[`skills/s${String(i).padStart(2, "0")}/SKILL.md`] = skillMd(`skill-${String(i).padStart(3, "0")}`, `Skill number ${i} does things.`);
  }
  installFetch((url: string) => {
    const r = serveRepo("acme-big/big", tree, files)(url);
    return r ?? resp(404, { message: "not found" });
  });
  const row: SourceRow = {
    kind: "skill-repo",
    url: "https://github.com/acme-big/big",
    discoveredVia: "cron",
    status: "verified",
    reason: "100 SKILL.md file(s) present",
    firstSeen: "2026-11-12T00:00:00.000Z",
    lastSeen: "2026-11-12T00:00:00.000Z",
    lastIngested: null,
    recordCount: 0,
    provenance: [{ via: "cron", at: "2026-11-12T00:00:00.000Z" }],
    priority: 5,
    locator: "acme-big/big",
  };
  await store.upsertSource(row);
  const env = makeEnv(strict.db);
  strict.reset();
  await handleQueueMessage(env, { locator: "acme-big/big", kind: "skill-repo", via: "cron" } satisfies IngestQueueMessage, { pacer: fastPacer() });
  assert.ok(strict.count() < 900, `verified 100-skill message took ${strict.count()} statements (cap 900)`);
  assert.equal((await store.getSource("skill-repo", "acme-big/big"))?.status, "ingested");
  const listed = raw.prepare("SELECT COUNT(*) AS n FROM records WHERE status = 'listed'").get() as { n: number };
  assert.equal(listed.n, 100);
  const stats = raw.prepare("SELECT COUNT(*) AS n FROM record_stats").get() as { n: number };
  assert.equal(stats.n, 100, "every ingested record has a stats row — the message did not throw after ingest");
  const sample = await statsRow(strict.db, "acme-big/skill-000");
  assert.ok(sample);
  assert.equal(sample!.owner_records, 100);
  globalThis.fetch = realFetch;
});
