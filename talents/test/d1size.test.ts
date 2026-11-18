// D1 50 MB response-limit regression (2026-11-11, gate-d1size):
// at 22,407 listed records the records table holds 53.5 MB of
// record_json, so SELECT record_json over the whole catalog 500s
// home (/), /api/trending, the search vector block and suggest.
// These tests run the REAL read paths against a real SQLite database
// (the actual migration SQL) behind a D1Like that enforces a
// configurable RESPONSE byte cap exactly the way production D1 does:
// any .all() whose result payload exceeds the cap throws the same
// "exceeded the maximum response size limit" error. The seeded
// catalog (400 records × ~2 KB ≈ 800 KB) exceeds the 512 KB cap, so
// a full-table scan throws here the way it 500s in production —
// every bounded path below must complete without tripping it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { SkillRecord } from "../src/types.js";
import type { D1Like, D1StatementLike } from "../src/search-d1.js";
import { D1SearchEngine } from "../src/search-d1.js";
import { buildAggregatedMarketplace, createAggregateBuilder } from "../src/aggregate.js";
import { trending as staticTrending } from "../src/render.js";
import { computeTrending } from "../src/discovery/ranking.js";
import {
  hybridSearch, suggestForSkill, trendingRecords,
} from "../cf/src/discovery.js";
import {
  listedStats, recordsByIds, recordsPage,
} from "../cf/src/db.js";
import type { Env } from "../cf/src/db.js";

// ---------------------------------------------------------------------------
// SQLite-backed D1Like with a production-style RESPONSE byte cap
// ---------------------------------------------------------------------------

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

/** D1's measured single-query response limit is 50 MB; the test cap
 *  is scaled down so a 1,500-record synthetic catalog trips it.
 *  The cap must still admit a 500-record pool (the static trending
 *  fallback) — 500 × ~2 KB ≈ 1 MB — so the cap sits at 2 MB. */
const RESPONSE_CAP_BYTES = 2 * 1024 * 1024;

function makeCappedDb(): { db: D1Like; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_discovery.sql", "0003_vector_id.sql", "0004_scouts.sql", "0005_creator.sql", "0006_enrichment.sql"]) {
    raw.exec(readFileSync(new URL(`../../cf/migrations/${f}`, import.meta.url), "utf8"));
  }
  const db = {
    prepare(sql: string): D1StatementLike {
      const stmt = raw.prepare(sql);
      let params: unknown[] = [];
      const self: D1StatementLike = {
        bind(...p: unknown[]) { params = p; return self; },
        async all<T>() {
          const results = stmt.all(...params) as T[];
          const bytes = Buffer.byteLength(JSON.stringify(results), "utf8");
          if (bytes > RESPONSE_CAP_BYTES) {
            throw new Error(
              `D1_ERROR: D1 query result exceeded the maximum response size limit of 50 MB (${bytes} bytes in test)`,
            );
          }
          return { results };
        },
        async run() { stmt.run(...params); return {}; },
        async first<T>() {
          const row = stmt.get(...params) as T | undefined;
          if (row !== undefined && Buffer.byteLength(JSON.stringify(row), "utf8") > RESPONSE_CAP_BYTES) {
            throw new Error("D1_ERROR: D1 query result exceeded the maximum response size limit of 50 MB");
          }
          return row ?? null;
        },
      };
      return self;
    },
  } as D1Like;
  return { db, raw };
}

function record(partial: Partial<SkillRecord> & { id: string }): SkillRecord {
  const [owner, name] = partial.id.split("/");
  return {
    owner, name,
    url: `https://talents.sh/skills/${partial.id}`,
    profileUrl: `https://talents.sh/${owner}`,
    kind: "skill",
    description: "a description",
    sourceType: "github",
    source: "./skills/x",
    sourceRepo: "acme/widgets",
    sourcePath: "skills/x",
    sourceMarketplace: "acme/widgets",
    ref: "main",
    pointerOnly: false,
    components: { skills: [], commands: [], agents: [], hooks: false, mcpServers: [] },
    declaration: { lines: [], summary: [], undeclared: [], derivedFrom: [] },
    validation: { entryName: name, ok: true, issues: [] },
    attestation: null,
    filesHashed: [],
    status: "listed",
    ingestedAt: "2026-11-10T00:00:00.000Z",
    ...partial,
  };
}

interface Seeded {
  db: D1Like;
  raw: InstanceType<typeof DatabaseSync>;
  records: SkillRecord[];
  env: Env;
  engine: D1SearchEngine;
}

/** 1,500 records × ~2 KB record_json ≈ 3 MB > 2 MB cap, so any
 *  full-table SELECT record_json throws — exactly the production
 *  failure at 22,407 records / 53.5 MB. The 500-record fallback
 *  pool (≈1 MB) stays under the cap, as it does in production. */
function seed(): Seeded {
  const { db, raw } = makeCappedDb();
  const filler = "filler ".repeat(280); // ~2 KB of record_json per row
  const records: SkillRecord[] = [];
  const insertRecord = raw.prepare(
    `INSERT INTO records (id, owner, name, kind, status, source_repo, ref, record_json, search_text, attestation_hash, ingested_at)
     VALUES (?, ?, ?, ?, 'listed', ?, 'main', ?, ?, NULL, ?)`,
  );
  const insertFts = raw.prepare(
    "INSERT INTO skills_fts (id, name, description, components, declaration_text) VALUES (?, ?, ?, ?, '')",
  );
  for (let i = 0; i < 1500; i++) {
    const owner = i < 5 ? "acme" : `owner${i % 40}`;
    const name = `skill-${i}`;
    const id = `${owner}/${name}`;
    const isPdf = i === 0;
    const r = record({
      id,
      owner,
      name,
      description: isPdf
        ? `Works with pdf files. ${filler}`
        : `Skill number ${i} for general work. ${filler}`,
      kind: i % 10 === 0 ? "mcp" : "skill",
      components: isPdf
        ? { skills: ["pdf-tools", "convert"], commands: [], agents: [], hooks: false, mcpServers: [] }
        : { skills: [`tool-${i % 7}`], commands: [], agents: [], hooks: false, mcpServers: [] },
      attestation: i % 3 === 0 ? { algorithm: "ed25519", contentHash: "abc", signature: "sig", publicKeyPem: "pem", signedAt: "2026-11-10T00:00:00.000Z" } : null,
      filesHashed: i % 3 === 0 ? ["a", "b", "c"] : [],
      ingestedAt: new Date(Date.UTC(2026, 10, 1 + (i % 10), 0, 0, 0)).toISOString(),
    });
    records.push(r);
    const json = JSON.stringify(r);
    insertRecord.run(r.id, r.owner, r.name, r.kind, r.sourceRepo, json, `${r.name} ${r.description}`.toLowerCase(), r.ingestedAt);
    insertFts.run(r.id, r.name, r.description, r.components.skills.join(" "));
  }
  // Same-owner sibling + component-sharing record for suggest tests.
  const sibling = record({
    id: "acme/other",
    description: `Another acme skill. ${filler}`,
    components: { skills: ["pdf-tools"], commands: [], agents: [], hooks: false, mcpServers: [] },
  });
  records.push(sibling);
  insertRecord.run(sibling.id, sibling.owner, sibling.name, sibling.kind, sibling.sourceRepo, JSON.stringify(sibling), `${sibling.name} ${sibling.description}`.toLowerCase(), sibling.ingestedAt);
  insertFts.run(sibling.id, sibling.name, sibling.description, "pdf-tools");
  const sharer = record({
    id: "elsewhere/reader",
    description: `Reads pdf files too. ${filler}`,
    components: { skills: ["pdf-tools"], commands: [], agents: [], hooks: false, mcpServers: [] },
  });
  records.push(sharer);
  insertRecord.run(sharer.id, sharer.owner, sharer.name, sharer.kind, sharer.sourceRepo, JSON.stringify(sharer), `${sharer.name} ${sharer.description}`.toLowerCase(), sharer.ingestedAt);
  insertFts.run(sharer.id, sharer.name, sharer.description, "pdf-tools");

  const env = {
    DB: db,
    AI: { run: async (_m: string, input: { text: string[] }) => ({ data: input.text.map(() => [0.1, 0.2, 0.3]) }) },
    VECTORIZE: {
      upsert: async () => undefined,
      query: async (_v: number[], _o: { topK: number }) => ({
        matches: [
          { id: "acme/pdf-tool", score: 0.95 },
          { id: "elsewhere/reader", score: 0.8 },
        ],
      }),
    },
  } as unknown as Env;
  return { db, raw, records, env, engine: new D1SearchEngine(db) };
}

function seedGatewayCalls(raw: Seeded["raw"], calls: { id: string; daysAgo: number; n: number }[]): void {
  const ins = raw.prepare("INSERT INTO gateway_calls (tool, skill_id, called_at) VALUES ('search_skill', ?, ?)");
  const now = Date.now();
  for (const c of calls) {
    for (let i = 0; i < c.n; i++) {
      ins.run(c.id, new Date(now - c.daysAgo * 86_400_000 - i * 1000).toISOString());
    }
  }
}

// ---------------------------------------------------------------------------
// The harness models the incident: a full-table scan throws
// ---------------------------------------------------------------------------

test("d1size: a full-table SELECT record_json exceeds the response cap (the incident, in miniature)", async () => {
  const { db } = seed();
  await assert.rejects(
    db.prepare("SELECT record_json FROM records WHERE status = 'listed' ORDER BY id").all(),
    /exceeded the maximum response size limit/,
  );
});

// ---------------------------------------------------------------------------
// Trending: velocity path is bounded and exact
// ---------------------------------------------------------------------------

test("d1size: trendingRecords velocity path fetches by id only, same ids as computeTrending", async () => {
  const s = seed();
  seedGatewayCalls(s.raw, [
    { id: "acme/skill-0", daysAgo: 1, n: 5 },
    { id: "acme/skill-1", daysAgo: 2, n: 4 },
    { id: "acme/skill-2", daysAgo: 3, n: 3 },
    { id: "acme/skill-3", daysAgo: 1, n: 2 }, // below the floor of 3
  ]);
  const t = await trendingRecords(s.env);
  assert.equal(t.mode, "velocity");
  assert.equal(t.floor, 3);
  assert.deepEqual(
    t.results.map((r) => r.id),
    ["acme/skill-0", "acme/skill-1", "acme/skill-2"],
  );
  assert.equal(t.results[0].description.slice(0, 20), "Works with pdf files");
});

test("d1size: trendingRecords static fallback is bounded and ranks like trending() over the pool", async () => {
  const s = seed();
  const t = await trendingRecords(s.env);
  assert.equal(t.mode, "static-fallback");
  assert.equal(t.results.length, 8);
  // The pool is the 500 most recently ingested records, so the
  // fallback must rank exactly like the old whole-catalog static
  // ranking restricted to that pool (same ORDER BY as the query).
  const pool = [...s.records]
    .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt) || a.id.localeCompare(b.id))
    .slice(0, 500);
  assert.deepEqual(
    t.results.map((r) => r.id),
    staticTrending(pool, 8).map((r) => r.id),
  );
});

// ---------------------------------------------------------------------------
// Search: the vector block no longer loads the catalog
// ---------------------------------------------------------------------------

test("d1size: hybridSearch uses the vector layer (d1+vectorize equivalent) with no over-cap query", async () => {
  const s = seed();
  const out = await hybridSearch(s.env, s.engine, { q: "pdf", limit: 20 });
  assert.equal(out.vectorUsed, true);
  assert.equal(out.vectorError, undefined);
  assert.ok(out.results.some((r) => r.id === "acme/skill-0"), "keyword pdf hit present");
  assert.ok(out.results.some((r) => r.id === "elsewhere/reader"), "vector neighbour present");
});

test("d1size: hybridSearch post-rank runs without a catalog load when the vector layer is off", async () => {
  const s = seed();
  const envNoVector = { DB: s.db } as unknown as Env;
  const out = await hybridSearch(envNoVector, s.engine, { q: "pdf", limit: 20 });
  assert.equal(out.vectorUsed, false);
  assert.equal(out.vectorError, undefined);
  assert.ok(out.results.some((r) => r.id === "acme/skill-0"));
});

// ---------------------------------------------------------------------------
// Suggest: bounded candidate pool
// ---------------------------------------------------------------------------

test("d1size: suggestForSkill blends vector + owner + component matches without a catalog load", async () => {
  const s = seed();
  const related = await suggestForSkill(s.env, "acme/skill-0");
  assert.ok(related, "returns picks for a known record");
  const ids = related!.map((r) => r.id);
  assert.ok(ids.includes("acme/other"), "same-owner sibling picked");
  assert.ok(ids.includes("elsewhere/reader"), "component-sharing record picked");
  assert.ok(!ids.includes("acme/skill-0"), "target excluded");
  assert.equal(await suggestForSkill(s.env, "nobody/nope"), null);
});

// ---------------------------------------------------------------------------
// Home data path + aggregate paging
// ---------------------------------------------------------------------------

test("d1size: listedStats + trendingRecords (the home data path) stay under the cap", async () => {
  const s = seed();
  const stats = await listedStats(s.db);
  assert.equal(stats.count, 1502);
  assert.ok(stats.owners > 1);
  const t = await trendingRecords(s.env);
  assert.ok(t.results.length > 0);
});

test("d1size: paged aggregate build matches the whole-catalog build", async () => {
  const s = seed();
  const { createAggregateBuilder } = await import("../src/aggregate.js");
  const builder = createAggregateBuilder({});
  let cursor: string | null = null;
  for (;;) {
    const page = await recordsPage(s.db, cursor, 50);
    if (!page.length) break;
    builder.addPage(page);
    if (page.length < 50) break;
    cursor = page[page.length - 1].id;
  }
  const paged = builder.finish();
  const whole = buildAggregatedMarketplace(s.records, {});
  assert.equal(paged.entryCount, whole.entryCount);
  assert.deepEqual(
    (paged.doc.plugins ?? []).map((p) => p.name),
    (whole.doc.plugins ?? []).map((p) => p.name),
  );
  assert.deepEqual(paged.skipped, whole.skipped);
});

test("d1size: recordsByIds returns caller order and filters unlisted ids", async () => {
  const s = seed();
  s.raw.prepare("INSERT INTO unlisted_skills (skill_id, unlisted_by, unlisted_at) VALUES ('acme/skill-1', 'user_1', '2026-11-11T00:00:00.000Z')").run();
  const got = await recordsByIds(s.db, ["acme/skill-2", "acme/skill-1", "acme/skill-0"]);
  assert.deepEqual(got.map((r) => r.id), ["acme/skill-2", "acme/skill-0"]);
});
