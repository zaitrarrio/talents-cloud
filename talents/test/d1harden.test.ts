// Worker-path D1 hardening (2026-11-11, gate-d1harden.txt): the
// drain fix chunked the OPERATOR path (wrangler adapter + the shared
// record store). The Worker's native D1 binding shares D1's
// 100,000-byte per-statement limit (SQLITE_TOOBIG) but two shared
// write paths did not chunk:
//
//   - D1EnrichmentStore.upsertLayer — one INSERT carrying a whole
//     layer payload (B sub-inventories / C introspection dumps are
//     source-shaped and unbounded in total);
//   - appendSearchExtras — one UPDATE writing the record's full
//     recomputed search_text (already past the limit for the
//     biggest collections, which ingest deliberately stores chunked)
//     plus one FTS INSERT with the full declaration text.
//
// These tests run the REAL stores against a real SQLite database
// (the actual migration SQL) behind a strict D1Like that enforces
// the measured D1 limit exactly as production does: any statement
// whose estimated size (SQL + bound values, via
// src/d1-limits.ts estimateStatementBytes) exceeds
// MAX_D1_STATEMENT_BYTES throws "statement too long: SQLITE_TOOBIG".
// If a write path regresses to a single oversized statement, these
// tests fail the way production would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { SkillRecord } from "../src/types.js";
import type { D1Like, D1StatementLike } from "../src/search-d1.js";
import {
  MAX_D1_STATEMENT_BYTES, TEXT_CHUNK_BYTES,
  estimateStatementBytes, statementExceedsLimit, utf8ByteLength,
} from "../src/d1-limits.js";
import { D1DiscoveryStore, searchTextOf } from "../src/discovery/store.js";
import { D1EnrichmentStore, appendSearchExtras } from "../src/enrichment/store.js";
import { toSearchDocument } from "../src/search.js";

// ---------------------------------------------------------------------------
// SQLite-backed D1Like with the production statement limit enforced
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

interface Run { sql: string; params: unknown[]; bytes: number }

function makeStrictDb(): { db: D1Like; raw: InstanceType<typeof DatabaseSync>; runs: Run[] } {
  const raw = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_discovery.sql", "0006_enrichment.sql"]) {
    raw.exec(readFileSync(new URL(`../../cf/migrations/${f}`, import.meta.url), "utf8"));
  }
  const runs: Run[] = [];
  const db = {
    prepare(sql: string): D1StatementLike {
      const stmt = raw.prepare(sql);
      let params: unknown[] = [];
      const self: D1StatementLike = {
        bind(...p: unknown[]) { params = p; return self; },
        async all<T>() { return { results: stmt.all(...params) as T[] }; },
        async run() {
          const bytes = estimateStatementBytes(sql, params);
          if (bytes > MAX_D1_STATEMENT_BYTES) {
            throw new Error(`statement too long: SQLITE_TOOBIG (${bytes} bytes)`);
          }
          runs.push({ sql, params: [...params], bytes });
          stmt.run(...params);
          return {};
        },
        async first<T>() { return (stmt.get(...params) as T | undefined) ?? null; },
      };
      return self;
    },
  } as D1Like;
  return { db, raw, runs };
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

// ---------------------------------------------------------------------------
// The shared estimator (the split trigger every path now uses)
// ---------------------------------------------------------------------------

test("estimateStatementBytes sizes bound values as inlined, conservatively", () => {
  const sql = "INSERT INTO t (v) VALUES (?)";
  assert.ok(estimateStatementBytes(sql, ["x".repeat(50_000)]) < MAX_D1_STATEMENT_BYTES);
  // Multibyte: 50,000 CJK chars are ~150,000 UTF-8 bytes.
  assert.ok(utf8ByteLength("語".repeat(50_000)) > 140_000);
  assert.ok(statementExceedsLimit(sql, ["語".repeat(50_000)]));
  // Single quotes count double (the operator transport escapes '').
  const quoted = estimateStatementBytes(sql, ["it's"]);
  assert.equal(quoted, utf8ByteLength(sql) + 4 + 2 + 1);
  // Numbers/null are literal-sized, never inflated.
  assert.equal(estimateStatementBytes(sql, [42]), utf8ByteLength(sql) + 2);
  assert.equal(estimateStatementBytes(sql, [null]), utf8ByteLength(sql) + 4);
});

// ---------------------------------------------------------------------------
// (a) Worker record upsert path (shared D1DiscoveryStore over the
//     native-binding-shaped adapter) with a ≥120 KB record
// ---------------------------------------------------------------------------

test("upsertRecord via the Worker path: ≥120 KB record, every statement bounded, byte-identical", async () => {
  const { db, raw, runs } = makeStrictDb();
  const store = new D1DiscoveryStore(db);
  const lines = Array.from({ length: 400 }, (_, i) => ({
    kind: "component" as const,
    text: `Skill "skill-${i}": ${"y".repeat(200)}`,
  }));
  const big = record({
    id: "test/big-collection",
    kind: "plugin",
    description: "x".repeat(120_000),
    declaration: { lines, summary: [], undeclared: [], derivedFrom: [] },
  });
  assert.ok(utf8ByteLength(JSON.stringify(big)) >= 120_000, "fixture record_json is ≥120 KB");
  // Pre-hardening this shape threw SQLITE_TOOBIG on the native path
  // whenever the drain's adapter chunking wasn't in the loop; the
  // strict harness throws on any oversized statement, so completing
  // at all is the first assertion.
  await store.upsertRecord(big);
  assert.ok(runs.length > 3, "chunked path emitted multiple statements");
  for (const r of runs) assert.ok(r.bytes <= MAX_D1_STATEMENT_BYTES, `statement ${r.bytes} bytes`);
  const row = raw.prepare("SELECT record_json, search_text FROM records WHERE id = ?")
    .get(big.id) as { record_json: string; search_text: string };
  assert.equal(row.record_json, JSON.stringify(big), "stored record_json is byte-identical");
  assert.equal(row.search_text, searchTextOf(big), "stored search_text is complete");
  const fts = raw.prepare("SELECT declaration_text FROM skills_fts WHERE id = ?")
    .get(big.id) as { declaration_text: string };
  assert.equal(fts.declaration_text, toSearchDocument(big).declarationText, "FTS declaration_text is complete");
});

// ---------------------------------------------------------------------------
// (b) Enrichment store with a ≥120 KB layer payload
// ---------------------------------------------------------------------------

test("upsertLayer: ≥120 KB payload chunked, byte-identical round-trip, small payload stays one statement", async () => {
  const { db, runs } = makeStrictDb();
  const store = new D1EnrichmentStore(db);
  // Layer B shape at pathological scale: 600 sub-inventory entries
  // with multibyte text (code-point safety matters — a split inside
  // a surrogate pair would corrupt the JSON).
  const payload = {
    subInventory: Array.from({ length: 600 }, (_, i) => ({
      name: `skill-${i}-😀`,
      description: `説明テキスト ${"詳".repeat(60)} ${i}`,
    })),
    truncated: false,
  };
  const payloadJson = JSON.stringify(payload);
  assert.ok(utf8ByteLength(payloadJson) >= 120_000, `fixture payload is ≥120 KB (${utf8ByteLength(payloadJson)})`);
  const before = runs.length;
  await store.upsertLayer("test/big-collection", "hash1", "b", "done", payload, "2026-11-11T00:00:00.000Z");
  const layerRuns = runs.slice(before);
  assert.ok(layerRuns.length > 1, "oversized payload took the chunked path");
  for (const r of layerRuns) assert.ok(r.bytes <= MAX_D1_STATEMENT_BYTES, `statement ${r.bytes} bytes`);
  // The appends are the splitter: every chunk param respects the
  // text-chunk cap, and INSERT chunk + appends reassemble exactly.
  const appends = layerRuns.filter((r) => /\|\|/.test(r.sql));
  assert.ok(appends.length >= 2, `expected ≥2 chunk appends, got ${appends.length}`);
  for (const r of appends) {
    assert.ok(utf8ByteLength(String(r.params[0])) <= TEXT_CHUNK_BYTES, "chunk param within TEXT_CHUNK_BYTES");
  }
  const first = layerRuns.find((r) => /INSERT INTO enrichment/.test(r.sql));
  assert.ok(first);
  const reassembled = String(first.params[3]) + appends.map((r) => String(r.params[0])).join("");
  assert.equal(reassembled, payloadJson, "chunk sequence reassembles the payload byte-identically");
  const row = await store.get("test/big-collection");
  assert.ok(row);
  assert.equal(JSON.stringify(row.b), payloadJson, "read-back payload is byte-identical");
  assert.equal(row.bState, "done");

  // Same guarantee for a D/E-shape layer (no *_at column).
  const dPayload = { oneLine: "s", blob: "z".repeat(150_000) };
  const dJson = JSON.stringify(dPayload);
  await store.upsertLayer("test/big-collection", "hash1", "d", "done", dPayload, "2026-11-11T00:00:00.000Z");
  const row2 = await store.get("test/big-collection");
  assert.equal(JSON.stringify(row2?.d), dJson, "layer D chunked round-trip is byte-identical");

  // Fast path unchanged: a small payload is exactly one statement,
  // and overwriting a chunked value with a small one leaves no
  // appended residue.
  const beforeSmall = runs.length;
  await store.upsertLayer("test/big-collection", "hash2", "b", "done", { small: true }, "2026-11-11T01:00:00.000Z");
  assert.equal(runs.length - beforeSmall, 1, "small payload = one statement");
  const row3 = await store.get("test/big-collection");
  assert.equal(JSON.stringify(row3?.b), JSON.stringify({ small: true }), "overwrite replaces, never appends");
});

// ---------------------------------------------------------------------------
// (c) appendSearchExtras over an oversized stored record
// ---------------------------------------------------------------------------

test("appendSearchExtras: oversized search_text + FTS written chunked and complete", async () => {
  const { db, raw, runs } = makeStrictDb();
  const store = new D1DiscoveryStore(db);
  const big = record({
    id: "test/big-collection",
    kind: "plugin",
    description: "x".repeat(120_000),
  });
  await store.upsertRecord(big);
  const before = runs.length;
  await appendSearchExtras(db, big, ["pine", "bellman_start"], ["generated tag"]);
  const extraRuns = runs.slice(before);
  assert.ok(extraRuns.some((r) => /search_text = search_text \|\|/.test(r.sql)), "search_text took the chunked path");
  assert.ok(extraRuns.some((r) => /description = description \|\|/.test(r.sql)), "FTS description took the chunked path");
  for (const r of extraRuns) assert.ok(r.bytes <= MAX_D1_STATEMENT_BYTES, `statement ${r.bytes} bytes`);
  const row = raw.prepare("SELECT search_text FROM records WHERE id = ?")
    .get(big.id) as { search_text: string };
  const expected = [searchTextOf(big), "pine bellman_start", "generated tag"].filter(Boolean).join(" ");
  assert.equal(row.search_text, expected, "search_text = bare text + derived extras + generated extras, complete");
  const fts = raw.prepare("SELECT components, declaration_text FROM skills_fts WHERE id = ?")
    .get(big.id) as { components: string; declaration_text: string };
  assert.ok(fts.components.includes("pine") && fts.components.includes("bellman_start"), "extras landed in FTS components");
  assert.equal(fts.declaration_text, toSearchDocument(big).declarationText, "FTS declaration_text complete");
});
