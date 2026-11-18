// Search-fix tests (2026-11-10) — the "build games" defect:
//   1. plural/singular normalization (games ≡ game),
//   2. per-token rarity ranking (rare token beats common-token filler),
//   3. partial-match honesty metadata,
//   4. the typo broadening fallback still works (pdff → pdf).
// Driven through a fake D1 that simulates trigram substring matching,
// same approach as test/p2.test.ts (with correct per-SQL param parsing).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { SkillRecord, RegistryFile } from "../src/types.js";
import {
  D1SearchEngine, queryTokens, tokenWeight, type D1Like, type D1StatementLike,
} from "../src/search-d1.js";
import { normalizeToken } from "../src/search.js";
import { toSearchDocument } from "../src/search.js";

const DATA = resolve(dirname(new URL(import.meta.url).pathname), "../../data");

// ---------------------------------------------------------------------------
// Fixtures + fake D1
// ---------------------------------------------------------------------------

function record(partial: Partial<SkillRecord> & { id: string }): SkillRecord {
  const [owner, name] = partial.id.split("/");
  return {
    owner, name,
    url: `https://talents.sh/skills/${partial.id}`,
    profileUrl: `https://talents.sh/${owner}`,
    kind: "skill",
    description: "a description",
    sourceType: "github",
    source: "./plugins/x",
    sourceRepo: "acme/marketplace",
    sourcePath: "plugins/x",
    sourceMarketplace: "acme/marketplace",
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

const FIXTURES: SkillRecord[] = [
  record({ id: "acme/game-forge", description: "Build a game with sprites, levels and bosses", components: { skills: ["game-forge"], commands: [], agents: [], hooks: false, mcpServers: [] } }),
  record({ id: "acme/game-jam", description: "Tools for game jams, prototypes and game nights" }),
  record({ id: "acme/site-builder", description: "Build websites quickly with blocks" }),
  record({ id: "acme/app-builder", description: "Build mobile apps from templates" }),
  record({ id: "acme/doc-builder", description: "Build documents and reports" }),
  record({ id: "acme/test-builder", description: "Build test suites for pipelines" }),
  record({ id: "acme/pdf-tools", description: "Work with PDF files: merge, split, sign" }),
];

interface FakeRow { record: SkillRecord; fields: string[]; searchText: string }

class FakeStatement implements D1StatementLike {
  private params: unknown[] = [];
  constructor(private rows: FakeRow[], private sql: string) {}
  bind(...params: unknown[]): D1StatementLike { this.params = params; return this; }
  async run(): Promise<unknown> { return {}; }
  async first<T>(): Promise<T | null> { const { results } = await this.all<T>(); return results[0] ?? null; }
  async all<T>(): Promise<{ results: T[] }> {
    const p = this.params as (string | null)[];
    let out = this.rows.filter((r) => r.record.status === "listed");
    if (this.sql.includes("skills_fts MATCH")) {
      const kind = p[1]; const owner = p[3];
      if (kind) out = out.filter((r) => r.record.kind === kind);
      if (owner) out = out.filter((r) => r.record.owner === owner);
      const tokens = [...String(p[0]).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      out = out.filter((r) => tokens.some((t) => r.fields.some((f) => f.includes(t))));
      const weights = [5, 2, 3, 1];
      const score = (r: FakeRow) => tokens.reduce((s, t) =>
        s + r.fields.reduce((fs, f, i) => fs + weights[i] * (f.split(t).length - 1), 0), 0);
      out = [...out].sort((a, b) => score(b) - score(a));
    } else if (this.sql.includes("LIKE")) {
      const kind = p[0]; const owner = p[2];
      if (kind) out = out.filter((r) => r.record.kind === kind);
      if (owner) out = out.filter((r) => r.record.owner === owner);
      const like = String(p[p.length - 1]).replace(/%/g, "");
      out = out.filter((r) => r.searchText.includes(like));
    } else {
      const kind = p[0]; const owner = p[2];
      if (kind) out = out.filter((r) => r.record.kind === kind);
      if (owner) out = out.filter((r) => r.record.owner === owner);
    }
    return { results: out.map((r) => ({ record_json: JSON.stringify(r.record) })) as T[] };
  }
}

class FakeD1 implements D1Like {
  private rows: FakeRow[];
  constructor(records: SkillRecord[]) {
    this.rows = records.map((record) => {
      const d = toSearchDocument(record);
      const fields = [d.name, d.description, d.components.join(" "), d.declarationText].map((s) => s.toLowerCase());
      return { record, fields, searchText: fields.join(" ") };
    });
  }
  prepare(sql: string): D1StatementLike { return new FakeStatement(this.rows, sql); }
}

const engine = new D1SearchEngine(new FakeD1(FIXTURES));
const ids = (rs: SkillRecord[]) => rs.map((r) => r.id);

// ---------------------------------------------------------------------------
// 1. Normalization
// ---------------------------------------------------------------------------

test("searchfix: normalizeToken singularizes trailing s, spares ss-endings and short tokens", () => {
  assert.equal(normalizeToken("games"), "game");
  assert.equal(normalizeToken("skills"), "skill");
  assert.equal(normalizeToken("class"), "class");
  assert.equal(normalizeToken("business"), "business");
  assert.equal(normalizeToken("gas"), "gas");
  assert.equal(normalizeToken("pdf"), "pdf");
  assert.deepEqual(queryTokens("Build Games"), ["build", "game"]);
});

test("searchfix: tokenWeight is rarity-monotone", () => {
  assert.ok(tokenWeight(1) > tokenWeight(5));
  assert.ok(tokenWeight(5) > tokenWeight(50));
});

test("searchfix: 'games' and 'game' return the same set (fixtures)", async () => {
  const a = ids(await engine.search({ q: "games" })).sort();
  const b = ids(await engine.search({ q: "game" })).sort();
  assert.deepEqual(a, b);
  assert.ok(a.includes("acme/game-forge") && a.includes("acme/game-jam"));
  const det = await engine.searchDetailed({ q: "games" });
  assert.equal(det.meta.partial, false);
});

test("searchfix: 'games' and 'game' return the same set (real catalog)", async () => {
  const byId = new Map<string, SkillRecord>();
  for (const f of ["registry.json", "fallback-registry.json"]) {
    const parsed = JSON.parse(readFileSync(resolve(DATA, f), "utf8")) as RegistryFile;
    for (const r of Object.values(parsed.records)) if (!byId.has(r.id)) byId.set(r.id, r);
  }
  const real = new D1SearchEngine(new FakeD1([...byId.values()]));
  // Compare full matched SETS: limit above the pool size, since the
  // default page of 20 legitimately slices a >20-record pool by rank
  // (and rank keys use the raw query form). Matching itself must be
  // identical — that is the normalization contract.
  const a = ids(await real.search({ q: "games", limit: 500 })).sort();
  const b = ids(await real.search({ q: "game", limit: 500 })).sort();
  assert.deepEqual(a, b);
  assert.ok(b.length > 0, "the loose 'game' matches must still be found");
});

// ---------------------------------------------------------------------------
// 2. Rare-token dominance
// ---------------------------------------------------------------------------

test("searchfix: rare token outranks common-token-only filler ('build games')", async () => {
  const out = ids(await engine.search({ q: "build games" }));
  assert.equal(out[0], "acme/game-forge", "the record matching BOTH tokens leads");
  const jam = out.indexOf("acme/game-jam");
  assert.ok(jam > 0, "game-only record present");
  for (const filler of ["acme/site-builder", "acme/app-builder", "acme/doc-builder", "acme/test-builder"]) {
    assert.ok(jam < out.indexOf(filler), `game-only record must outrank build-only ${filler}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Partial-match honesty
// ---------------------------------------------------------------------------

test("searchfix: partial flag + note when the rarest token matches nothing", async () => {
  const det = await engine.searchDetailed({ q: "build zzzquest" });
  assert.equal(det.meta.partial, true);
  assert.deepEqual(det.meta.missingTokens, ["zzzquest"]);
  assert.ok(det.meta.note?.includes("'zzzquest'"), `note names the token: ${det.meta.note}`);
  assert.ok(det.results.length > 0, "the matched token's results are still shown");
});

test("searchfix: zero matches at all → empty results, still honestly noted", async () => {
  const det = await engine.searchDetailed({ q: "zzzquest" });
  assert.equal(det.results.length, 0);
  assert.equal(det.meta.partial, true);
  assert.ok(det.meta.note?.includes("'zzzquest'"));
});

// ---------------------------------------------------------------------------
// 4. Typo broadening regression
// ---------------------------------------------------------------------------

test("searchfix: typo broadening still works — pdff finds the pdf record, not partial", async () => {
  const det = await engine.searchDetailed({ q: "pdff" });
  assert.equal(det.results[0]?.id, "acme/pdf-tools");
  assert.equal(det.meta.partial, false);
});
