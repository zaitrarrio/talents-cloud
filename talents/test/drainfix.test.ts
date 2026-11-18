// Drain-fix tests (2026-11-11 SQLITE_TOOBIG crash): D1's per-statement
// limit is 100,000 bytes, and collection records (record_json +
// search_text in one INSERT) crossed it — nomadamas/k-skill 100,314
// bytes, swift-ios-skills 108,975, superkit-agents 103,121,
// ecommerce-skills 105,563. One oversized statement poisoned every
// flush it shared and the uncaught batch-end flush killed the drain.
// Covered here: chunked flushes with per-statement isolation, the
// chunked record write (byte-identical round-trip), and the
// oversized-error classifier the drain uses to dead-letter.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SkillRecord } from "../src/types.js";
import {
  WranglerD1,
  FlushError,
  isOversizedStatementError,
  inlineParams,
  MAX_D1_STATEMENT_BYTES,
  MAX_FLUSH_FILE_BYTES,
} from "../src/discovery/wrangler-d1.js";
import {
  D1DiscoveryStore,
  chunkTextByBytes,
} from "../src/discovery/store.js";
import type { D1Like, D1StatementLike } from "../src/search-d1.js";

const encoder = new TextEncoder();
const byteLen = (s: string) => encoder.encode(s).length;

// --- Fake D1 that records bound statements instead of executing them.
class CapturingD1 implements D1Like {
  /** { sql, params } per run() call, in order. */
  runs: { sql: string; params: unknown[] }[] = [];
  prepare(sql: string): D1StatementLike {
    const self = this;
    let params: unknown[] = [];
    return {
      bind(...p: unknown[]) { params = p; return this; },
      async run() { self.runs.push({ sql, params }); return {}; },
      async all() { return { results: [] }; },
      async first() { return null; },
    };
  }
}

function syntheticRecord(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: "test/big-collection",
    owner: "test",
    name: "big-collection",
    url: "https://talents.sh/skills/test/big-collection",
    profileUrl: "https://talents.sh/test",
    kind: "plugin",
    description: "A big collection",
    sourceType: "github",
    source: null,
    sourceRepo: "test/big-collection",
    sourcePath: "",
    sourceMarketplace: "test/big-collection",
    ref: "main",
    pointerOnly: false,
    components: { skills: ["a", "b"], commands: [], agents: [], hooks: false, mcpServers: [] },
    declaration: { lines: [{ kind: "component", text: "Provides 2 skill(s): a, b" }], summary: [], undeclared: [], derivedFrom: [] },
    validation: { entryName: "big-collection", ok: true, issues: [] },
    attestation: null,
    filesHashed: ["SKILL.md"],
    status: "listed",
    ingestedAt: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}

test("chunkTextByBytes never splits a code point and respects the byte cap", () => {
  const text = "a😀b".repeat(100) + "x".repeat(50);
  const chunks = chunkTextByBytes(text, 10);
  assert.equal(chunks.join(""), text);
  for (const c of chunks) assert.ok(byteLen(c) <= 10, `chunk ${byteLen(c)} bytes`);
  assert.deepEqual(chunkTextByBytes("", 10), [""]);
  assert.deepEqual(chunkTextByBytes("abc", 10), ["abc"]);
});

test("upsertRecord fast path emits exactly the three historic statements", async () => {
  const db = new CapturingD1();
  const store = new D1DiscoveryStore(db);
  await store.upsertRecord(syntheticRecord());
  assert.equal(db.runs.length, 3);
  assert.match(db.runs[0].sql, /INSERT INTO records/);
  assert.match(db.runs[1].sql, /DELETE FROM skills_fts/);
  assert.match(db.runs[2].sql, /INSERT INTO skills_fts/);
  for (const r of db.runs) {
    assert.ok(byteLen(inlineParams(r.sql, r.params)) <= MAX_D1_STATEMENT_BYTES);
  }
});

test("upsertRecord chunked path: every statement bounded, stored row byte-identical", async () => {
  const db = new CapturingD1();
  const store = new D1DiscoveryStore(db);
  // A 120 KB description — far past the old single-statement limit.
  const big = syntheticRecord({ description: "x".repeat(120_000) });
  await store.upsertRecord(big);
  // Every inlined statement must fit the D1 limit.
  for (const r of db.runs) {
    const inlined = inlineParams(r.sql, r.params);
    assert.ok(byteLen(inlined) <= MAX_D1_STATEMENT_BYTES, `statement ${byteLen(inlined)} bytes`);
  }
  // Reassemble the record_json from the INSERT + UPDATE|| params.
  const recordRuns = db.runs.filter((r) => /records/.test(r.sql));
  const insert = recordRuns.find((r) => /INSERT INTO records/.test(r.sql));
  assert.ok(insert, "chunked path still starts with the records INSERT");
  const jsonParamIdx = 7; // record_json is the 8th bound value
  let json = String(insert.params[jsonParamIdx]);
  assert.equal(insert.params[8], "", "search_text starts empty in the chunked path");
  for (const r of recordRuns.filter((x) => /record_json = record_json \|\|/.test(x.sql))) {
    json += String(r.params[0]);
  }
  assert.equal(json, JSON.stringify(big), "reassembled record_json is byte-identical");
  // Reassemble search_text the same way.
  let search = "";
  const searchSet = recordRuns.find((r) => /SET search_text = \?/.test(r.sql));
  assert.ok(searchSet, "search_text is written by its own UPDATE in the chunked path");
  search = String(searchSet.params[0]);
  for (const r of recordRuns.filter((x) => /search_text = search_text \|\|/.test(x.sql))) {
    search += String(r.params[0]);
  }
  assert.ok(search.length > 120_000, "search_text carries the full description");
  assert.ok(search.includes("x".repeat(1000)));
  // FTS declaration_text: reassemble from its INSERT + UPDATE|| params.
  const ftsRuns = db.runs.filter((r) => /skills_fts/.test(r.sql) && !/DELETE/.test(r.sql));
  let decl = String(ftsRuns[0].params[4]);
  for (const r of ftsRuns.filter((x) => /declaration_text = declaration_text \|\|/.test(x.sql))) {
    decl += String(r.params[0]);
  }
  assert.ok(decl.includes("Provides 2 skill(s)"));
});

test("upsertRecord chunked path handles an over-long declaration_text", async () => {
  const db = new CapturingD1();
  const store = new D1DiscoveryStore(db);
  const lines = Array.from({ length: 400 }, (_, i) => ({ kind: "component" as const, text: `Skill "skill-${i}": ${"y".repeat(200)}` }));
  const big = syntheticRecord({ declaration: { lines, summary: [], undeclared: [], derivedFrom: [] } });
  await store.upsertRecord(big);
  for (const r of db.runs) {
    assert.ok(byteLen(inlineParams(r.sql, r.params)) <= MAX_D1_STATEMENT_BYTES);
  }
  const ftsRuns = db.runs.filter((r) => /skills_fts/.test(r.sql) && !/DELETE/.test(r.sql));
  let decl = String(ftsRuns[0].params[4]);
  for (const r of ftsRuns.filter((x) => /declaration_text = declaration_text \|\|/.test(x.sql))) {
    decl += String(r.params[0]);
  }
  assert.equal(decl.length, lines.map((l) => l.text).join(" ").length);
});

// --- WranglerD1.flush chunking, with executeFile stubbed to simulate D1.
test("flush splits a large buffer into bounded --file calls", async () => {
  // Spy on executeFile by replacing the private method through the
  // instance: WranglerD1.executeFile is private at compile time only.
  const d1 = new WranglerD1({ cwd: "/tmp", config: "wrangler.deploy.jsonc", database: "talents", remote: true });
  const files: string[] = [];
  (d1 as unknown as { executeFile: (stmts: string[]) => void }).executeFile = (stmts: string[]) => {
    files.push(stmts.join("\n"));
  };
  const stmt = `INSERT INTO t (v) VALUES ('${"z".repeat(1000)}');`;
  for (let i = 0; i < 600; i++) d1.bufferWrite(stmt);
  await d1.flush();
  assert.ok(files.length > 1, `expected several --file calls, got ${files.length}`);
  for (const f of files) {
    assert.ok(byteLen(f) <= MAX_FLUSH_FILE_BYTES, `file ${byteLen(f)} bytes`);
    assert.ok(f.split("\n").filter(Boolean).length <= 500, "at most 500 statements per file");
  }
  assert.equal(files.join("\n").split("\n").filter(Boolean).length, 600);
});

test("flush isolates an oversized statement: good ones commit, bad one reported, never executed", async () => {
  const d1 = new WranglerD1({ cwd: "/tmp", config: "wrangler.deploy.jsonc", database: "talents", remote: true });
  const executed: string[] = [];
  (d1 as unknown as { executeFile: (stmts: string[]) => void }).executeFile = (stmts: string[]) => {
    for (const s of stmts) {
      if (byteLen(s) > MAX_D1_STATEMENT_BYTES) throw new Error("statement too long: SQLITE_TOOBIG");
      executed.push(s);
    }
  };
  const good1 = "INSERT INTO t (v) VALUES ('a');";
  const bad = `INSERT INTO t (v) VALUES ('${"q".repeat(100_000)}');`;
  const good2 = "INSERT INTO t (v) VALUES ('b');";
  d1.bufferWrite(good1);
  d1.bufferWrite(bad);
  d1.bufferWrite(good2);
  await assert.rejects(() => d1.flush(), FlushError);
  // The good statements commit (good1 is re-executed once by the
  // one-by-one retry — harmless, the drain's writes are idempotent
  // upserts); the bad one is never executed.
  assert.ok(executed.includes(good1) && executed.includes(good2), "good statements committed despite the bad one");
  assert.equal(executed.filter((s) => s === bad).length, 0, "oversized statement never executed");
  // The oversized statement is reported, not executed, and the error
  // classifies as deterministic.
  let caught: unknown;
  d1.bufferWrite(bad);
  try { await d1.flush(); } catch (e) { caught = e; }
  assert.ok(caught instanceof FlushError);
  assert.equal((caught as FlushError).failed.length, 1);
  assert.equal((caught as FlushError).failed[0].bytes, byteLen(bad));
  assert.ok(isOversizedStatementError(caught));
  assert.equal((caught as FlushError).flushed, 0);
});

test("flush retries a failed chunk statement-by-statement", async () => {
  const d1 = new WranglerD1({ cwd: "/tmp", config: "wrangler.deploy.jsonc", database: "talents", remote: true });
  let calls = 0;
  (d1 as unknown as { executeFile: (stmts: string[]) => void }).executeFile = (stmts: string[]) => {
    calls++;
    // Simulate a transient failure on the first multi-statement call
    // only; single-statement retries succeed.
    if (stmts.length > 1 && calls === 1) throw new Error("transient network blip");
  };
  d1.bufferWrite("INSERT INTO t (v) VALUES ('a');");
  d1.bufferWrite("INSERT INTO t (v) VALUES ('b');");
  await d1.flush();
  assert.equal(calls, 3, "1 chunk attempt + 2 single-statement retries");
});

test("isOversizedStatementError classification", () => {
  assert.equal(isOversizedStatementError(new Error("statement too long: SQLITE_TOOBIG")), true);
  assert.equal(isOversizedStatementError(new Error("Command failed: SQLITE_TOOBIG")), true);
  assert.equal(isOversizedStatementError(new Error("network timeout")), false);
  assert.equal(
    isOversizedStatementError(new FlushError([{ sql: "x", bytes: 1, error: "boom" }], 2)),
    false,
  );
});
