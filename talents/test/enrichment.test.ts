// Enrichment Tranche 1 (ENRICHMENT.md layers A–C):
//   - pure parsers (SKILL.md full parse, sub-inventory, MCP package
//     facts, README excerpt/icon extraction);
//   - the Layer C introspection client against a LOCAL fixture MCP
//     server stood up in-test (JSON + SSE transports, session
//     header, auth refusal) — asserting the probe NEVER calls a tool;
//   - the pipeline state machine over a real SQLite-backed D1Like
//     (the actual migration SQL), incl. hash-keyed idempotency,
//     stale-on-hash-change, and the search-extras append;
//   - traffic-order paging (keyset cursor over record_stats).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { FetchFn, SkillRecord } from "../src/types.js";
import type { D1Like, D1StatementLike } from "../src/search-d1.js";
import {
  analyzeSkillBody, buildSubInventory, collectInventoryCandidates,
  mcpFactsFromPluginJson, mcpFactsFromServerJson, parseSkill, parseSkillMdFull,
} from "../src/enrichment/layer-b.js";
import { firstReadmeImage, npmPackageOf, readmeExcerpt } from "../src/enrichment/layer-a.js";
import { probeMcpServer, remoteEndpointOf } from "../src/enrichment/layer-c.js";
import { D1EnrichmentStore, decodeTrafficCursor, encodeTrafficCursor, extrasForIds, trafficPage } from "../src/enrichment/store.js";
import { enrichPage, enrichRecord } from "../src/enrichment/pipeline.js";
import { InMemoryAssetStore } from "../src/enrichment/types.js";
import { searchTextOf } from "../src/discovery/store.js";

// ---------------------------------------------------------------------------
// SQLite-backed D1Like (real SQL, real migrations — no mocking of the
// store's query shapes)
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

function makeDb(): { db: D1Like; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_discovery.sql", "0006_enrichment.sql"]) {
    // Tests run compiled (dist/test/), two levels below the repo root.
    raw.exec(readFileSync(new URL(`../../cf/migrations/${f}`, import.meta.url), "utf8"));
  }
  const db = {
    prepare(sql: string): D1StatementLike {
      const stmt = raw.prepare(sql);
      let params: unknown[] = [];
      const self: D1StatementLike = {
        bind(...p: unknown[]) { params = p; return self; },
        async all<T>() { return { results: stmt.all(...params) as T[] }; },
        async run() { stmt.run(...params); return {}; },
        async first<T>() { return (stmt.get(...params) as T | undefined) ?? null; },
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

function insertRecord(raw: InstanceType<typeof DatabaseSync>, r: SkillRecord): void {
  raw.prepare(
    "INSERT INTO records (id, owner, name, kind, status, source_repo, ref, record_json, search_text, attestation_hash, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(r.id, r.owner, r.name, r.kind, r.status, r.sourceRepo ?? null, r.ref, JSON.stringify(r), searchTextOf(r), r.attestation?.contentHash ?? null, r.ingestedAt);
  raw.prepare("INSERT INTO skills_fts (id, name, description, components, declaration_text) VALUES (?, ?, ?, ?, ?)")
    .run(r.id, r.name, r.description, "", "");
}

// ---------------------------------------------------------------------------
// Fake fetch router (exact match wins, else longest prefix)
// ---------------------------------------------------------------------------

function fakeFetch(routes: [string, { status?: number; body: unknown }][]): FetchFn {
  return async (url) => {
    let best: { status?: number; body: unknown } | undefined;
    let bestLen = -1;
    for (const [match, r] of routes) {
      if (url === match) { best = r; break; }
      if (url.startsWith(match) && match.length > bestLen) { best = r; bestLen = match.length; }
    }
    const status = best ? (best.status ?? 200) : 404;
    const body = best?.body ?? { message: "not found" };
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    };
  };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

test("parseSkillMdFull: arrays in all three YAML shapes + scalars", () => {
  const inline = parseSkillMdFull("---\nname: a\ndescription: d\nallowed-tools: [Read, Bash]\nmodel: opus\nlicense: MIT\n---\nBody.\n");
  assert.deepEqual(inline?.frontmatter.allowedTools, ["Read", "Bash"]);
  assert.equal(inline?.frontmatter.model, "opus");
  assert.equal(inline?.frontmatter.license, "MIT");
  assert.equal(inline?.body, "Body.\n");

  const block = parseSkillMdFull("---\nname: a\ndescription: d\nallowed-tools:\n  - Read\n  - Write\n---\nB");
  assert.deepEqual(block?.frontmatter.allowedTools, ["Read", "Write"]);

  const comma = parseSkillMdFull("---\nname: a\ndescription: d\nallowed-tools: Read, Glob\n---\nB");
  assert.deepEqual(comma?.frontmatter.allowedTools, ["Read", "Glob"]);

  assert.equal(parseSkillMdFull("no frontmatter"), null);
});

test("analyzeSkillBody: refs, urls, size", () => {
  const a = analyzeSkillBody("See [guide](docs/guide.md) and ![img](assets/x.png).\nVisit https://example.com/docs for more.\n");
  assert.deepEqual(a.referencedFiles, ["docs/guide.md", "assets/x.png"]);
  assert.deepEqual(a.externalUrls, ["https://example.com/docs"]);
  assert.ok(a.tokenEstimate > 0);
  assert.equal(a.instructionLines, 3);
});

test("parseSkill: the '---' ingest artifact yields parsedDescription, never otherwise", () => {
  const md = "---\nname: x\ndescription: The real description.\n---\nBody";
  const withArtifact = parseSkill("SKILL.md", md, "---");
  assert.equal(withArtifact?.parsedDescription, "The real description.");
  const normal = parseSkill("SKILL.md", md, "a stored description");
  assert.equal(normal?.parsedDescription, undefined);
});

test("sub-inventory: candidates from a tree + descriptions from contents", () => {
  const tree = [
    "skills/alpha/SKILL.md", "skills/beta/SKILL.md",
    "agents/helper.md", "commands/run.md", "README.md", "skills/alpha/extra.txt",
  ];
  const candidates = collectInventoryCandidates(tree, "");
  assert.deepEqual(candidates.map((c) => `${c.kind}:${c.name}`), [
    "agent:helper", "command:run", "skill:alpha", "skill:beta",
  ]);
  const contents = new Map([
    ["skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Alpha skill.\n---\n"],
    ["agents/helper.md", "# Helper Agent\nDoes helping.\n"],
  ]);
  const { entries, truncated } = buildSubInventory(candidates, contents);
  assert.equal(truncated, false);
  assert.equal(entries.find((e) => e.name === "alpha")?.description, "Alpha skill.");
  assert.equal(entries.find((e) => e.name === "helper")?.description, "Helper Agent");
  assert.equal(entries.find((e) => e.name === "beta")?.description, "");
});

test("mcp package facts: env var NAMES only, from server.json and plugin.json", () => {
  const fromServer = mcpFactsFromServerJson({
    packages: [{
      registryType: "npm", identifier: "@acme/server", version: "1.2.3",
      transport: { type: "stdio" },
      environmentVariables: [{ name: "ACME_API_KEY", isSecret: true }, { name: "ACME_REGION" }],
    }],
  });
  assert.equal(fromServer.packageName, "@acme/server");
  assert.equal(fromServer.transport, "stdio");
  assert.deepEqual(fromServer.envVars, ["ACME_API_KEY", "ACME_REGION"]);

  const fromPlugin = mcpFactsFromPluginJson({
    mcpServers: { db: { command: "npx", args: ["x"], env: { DB_URL: "postgres://secret", DB_POOL: "5" } } },
  });
  assert.equal(fromPlugin?.transport, "stdio");
  assert.deepEqual(fromPlugin?.envVars, ["DB_POOL", "DB_URL"]); // names sorted, values never read out
});

test("readme excerpt + first image", () => {
  const md = "# Title\n\n![badge](https://img.shields.io/badge/x)\n\n```\ncode\n```\n\nThe **real** prose starts here and explains the thing.\n";
  const ex = readmeExcerpt(md);
  assert.ok(ex.includes("The real prose starts here"));
  assert.ok(!ex.includes("code"));
  const img = firstReadmeImage("![shot](docs/shot.png)", "acme/widgets", "main");
  assert.equal(img, "https://raw.githubusercontent.com/acme/widgets/main/docs/shot.png");
  assert.equal(firstReadmeImage("![b](https://img.shields.io/badge/x)", "a/b", "main"), null);
});

test("npmPackageOf: pointer source and server.json packages", () => {
  assert.equal(npmPackageOf(record({ id: "acme/x", sourceType: "npm", source: { source: "npm", package: "left-pad", version: "1.0.0" } })), "left-pad");
  assert.equal(npmPackageOf(record({
    id: "acme/y", kind: "mcp", sourceType: "npm",
    source: { name: "io.github.acme/y", packages: [{ registryType: "npm", identifier: "@acme/y" }] },
  })), "@acme/y");
  assert.equal(npmPackageOf(record({ id: "acme/z" })), null);
});

// ---------------------------------------------------------------------------
// Layer C probe against a local fixture MCP server
// ---------------------------------------------------------------------------

interface Fixture { url: string; methods: string[]; close: () => Promise<void> }

async function startMcpFixture(opts: { sse?: boolean; auth?: boolean } = {}): Promise<Fixture> {
  const methods: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let msg: { id?: number; method?: string } = {};
      try { msg = JSON.parse(body) as typeof msg; } catch { /* notification etc. */ }
      if (msg.method) methods.push(msg.method);
      if (opts.auth) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (!msg.method || msg.id === undefined) { // notification
        res.writeHead(202);
        res.end();
        return;
      }
      let result: Record<string, unknown> = {};
      if (msg.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "fixture-server", version: "0.1.0" },
          capabilities: { tools: {}, prompts: {} },
        };
      } else if (msg.method === "tools/list") {
        result = {
          tools: [
            { name: "alpha_tool", description: "Does alpha things" },
            { name: "beta_tool", description: "Does beta things" },
          ],
        };
      } else if (msg.method === "prompts/list") {
        result = { prompts: [{ name: "greet" }] };
      } else if (msg.method === "tools/call") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [] } }));
        return;
      }
      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      if (opts.sse) {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
        res.end(`event: message\ndata: ${payload}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        res.end(payload);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    methods,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("probe: JSON transport — inventory captured, tools NEVER called", async () => {
  const fx = await startMcpFixture();
  try {
    const { state, payload } = await probeMcpServer(fx.url, new Date());
    assert.equal(state, "done");
    assert.deepEqual(payload.tools.map((t) => t.name), ["alpha_tool", "beta_tool"]);
    assert.equal(payload.serverInfo?.name, "fixture-server");
    assert.equal(payload.promptCount, 1);
    assert.deepEqual(payload.promptNames, ["greet"]);
    assert.ok(!fx.methods.includes("tools/call"), "probe must never invoke a tool");
    assert.ok(fx.methods.includes("initialize") && fx.methods.includes("tools/list"));
  } finally {
    await fx.close();
  }
});

test("probe: SSE transport parses event-stream frames", async () => {
  const fx = await startMcpFixture({ sse: true });
  try {
    const { state, payload } = await probeMcpServer(fx.url, new Date());
    assert.equal(state, "done");
    assert.equal(payload.tools.length, 2);
  } finally {
    await fx.close();
  }
});

test("probe: 401 → none with reason 'requires auth'", async () => {
  const fx = await startMcpFixture({ auth: true });
  try {
    const { state, payload } = await probeMcpServer(fx.url, new Date());
    assert.equal(state, "none");
    assert.equal(payload.reason, "requires auth");
  } finally {
    await fx.close();
  }
});

test("remoteEndpointOf: server.json remotes win; declaration URL is the fallback", () => {
  const fromSource = record({
    id: "acme/m", kind: "mcp",
    source: { name: "io.github.acme/m", remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }] },
  });
  assert.equal(remoteEndpointOf(fromSource), "https://mcp.example.com/mcp");
  const fromDecl = record({
    id: "acme/n", kind: "mcp", source: {},
    declaration: {
      lines: [{ kind: "network", text: "Connects to a remote MCP server at api.example.com (https://api.example.com/mcp)" }],
      summary: [], undeclared: [], derivedFrom: [],
    },
  });
  assert.equal(remoteEndpointOf(fromDecl), "https://api.example.com/mcp");
  assert.equal(remoteEndpointOf(record({ id: "acme/o" })), null);
});

// ---------------------------------------------------------------------------
// Pipeline state machine (real D1 store over SQLite)
// ---------------------------------------------------------------------------

const SKILL_MD = `---
name: do-thing
description: Does the thing from frontmatter.
allowed-tools:
  - Read
  - Bash
---
Read [the guide](docs/guide.md), then do the thing. See https://example.com/spec.
`;

function githubSkillRoutes(): [string, { status?: number; body: unknown }][] {
  return [
    ["https://api.github.com/repos/acme/widgets/contributors?per_page=100", { body: [{ login: "a" }, { login: "b" }] }],
    ["https://api.github.com/repos/acme/widgets/languages", { body: { TypeScript: 5000 } }],
    ["https://api.github.com/repos/acme/widgets/releases/latest", { status: 404, body: { message: "no release" } }],
    ["https://api.github.com/repos/acme/widgets/tags?per_page=1", { body: [{ name: "v1.0.0" }] }],
    ["https://api.github.com/repos/acme/widgets/git/trees/main?recursive=1", {
      body: { tree: [{ path: "skills/do-thing/SKILL.md", type: "blob" }, { path: "README.md", type: "blob" }], truncated: false },
    }],
    ["https://api.github.com/repos/acme/widgets", {
      body: {
        stargazers_count: 42, forks_count: 3, watchers_count: 42, open_issues_count: 1,
        license: { spdx_id: "MIT" }, topics: ["demo"], language: "TypeScript",
        created_at: "2025-01-01T00:00:00Z", pushed_at: "2026-01-02T00:00:00Z",
        archived: false, default_branch: "main",
      },
    }],
    ["https://raw.githubusercontent.com/acme/widgets/main/skills/do-thing/SKILL.md", { body: SKILL_MD }],
    ["https://raw.githubusercontent.com/acme/widgets/main/README.md", { body: "# Widgets\n\nWidgets do the thing well, for everyone.\n" }],
  ];
}

test("state machine: run → fresh skip → hash change re-runs; '---' candidate lands in b_json", async () => {
  const { db, raw } = makeDb();
  const store = new D1EnrichmentStore(db);
  const rec = record({
    id: "acme/do-thing",
    description: "---",
    sourcePath: "skills/do-thing",
    filesHashed: ["skills/do-thing/SKILL.md"],
    attestation: {
      algorithm: "ed25519", contentHash: "hash-v1", signature: "sig", publicKeyPem: "pem",
      signedAt: "2026-11-10T00:00:00.000Z",
    },
  });
  insertRecord(raw, rec);
  const deps = {
    store, db,
    fetchFn: fakeFetch(githubSkillRoutes()),
    fetchBytes: async () => null,
    assets: new InMemoryAssetStore(),
  };
  const t0 = new Date("2026-11-11T00:00:00.000Z");

  const first = await enrichRecord(rec, deps, { now: t0 });
  assert.equal(first.ran.a, "done");
  assert.equal(first.ran.b, "done");
  assert.equal(first.ran.c, "none"); // no remote endpoint — a verdict, recorded

  const row = await store.get("acme/do-thing");
  assert.equal(row?.a?.github?.stars, 42);
  assert.equal(row?.a?.github?.contributors, 2);
  assert.equal(row?.a?.readme?.excerpt.includes("Widgets do the thing well"), true);
  assert.equal(row?.b?.skillParse?.parsedDescription, "Does the thing from frontmatter.");
  assert.deepEqual(row?.b?.skillParse?.frontmatter.allowedTools, ["Read", "Bash"]);
  assert.equal(row?.b?.skillParse?.referencedFiles.includes("docs/guide.md"), true);
  // README bytes were stored as an asset (key readme/{id}).
  assert.equal((deps.assets as InMemoryAssetStore).objects.has("readme/acme/do-thing"), true);

  // Same hash, an hour later: everything is fresh — nothing runs.
  const second = await enrichRecord(rec, deps, { now: new Date(t0.getTime() + 3600_000) });
  assert.deepEqual(second.ran, {});
  assert.deepEqual([...second.skipped].sort(), ["a", "b", "c"]);

  // Hash change: reconcile flips verdicts to stale → layers re-run.
  const rec2 = { ...rec, attestation: { ...rec.attestation!, contentHash: "hash-v2" } };
  const third = await enrichRecord(rec2, deps, { now: new Date(t0.getTime() + 2 * 3600_000) });
  assert.equal(third.ran.a, "done");
  assert.equal(third.ran.b, "done");
  const row3 = await store.get("acme/do-thing");
  assert.equal(row3?.sourceHash, "hash-v2");
});

test("pipeline Layer C: probe result lands in c_json and tool names enter search text", async () => {
  const fx = await startMcpFixture();
  try {
    const { db, raw } = makeDb();
    const store = new D1EnrichmentStore(db);
    const rec = record({
      id: "acme/remote-mcp",
      kind: "mcp",
      sourceType: "command",
      source: {
        name: "io.github.acme/remote", description: "A remote MCP server for tests.", version: "1.0.0",
        remotes: [{ type: "streamable-http", url: fx.url }],
        packages: [],
      },
      sourceRepo: undefined,
      sourcePath: "",
      sourceMarketplace: "mcp-registry",
      pointerOnly: true,
      filesHashed: ["server.json"],
      attestation: {
        algorithm: "ed25519", contentHash: "mcp-h1", signature: "sig", publicKeyPem: "pem",
        signedAt: "2026-11-10T00:00:00.000Z",
      },
    });
    insertRecord(raw, rec);
    const deps = {
      store, db,
      fetchFn: fakeFetch([]),
      fetchBytes: async () => null,
      assets: new InMemoryAssetStore(),
    };
    const outcome = await enrichRecord(rec, deps, { now: new Date() });
    assert.equal(outcome.ran.c, "done");
    assert.equal(outcome.ran.b, "done"); // server.json facts without any fetch
    assert.equal(outcome.ran.a, "none"); // no repo, no npm package
    const row = await store.get("acme/remote-mcp");
    assert.deepEqual(row?.c?.tools.map((t) => t.name), ["alpha_tool", "beta_tool"]);
    assert.equal(row?.b?.mcpPackage?.transport, "streamable-http");

    const searchRow = raw.prepare("SELECT search_text FROM records WHERE id = ?").get("acme/remote-mcp") as { search_text: string };
    assert.ok(searchRow.search_text.includes("alpha_tool"), "tool names must be appended to search text");
    const ftsRow = raw.prepare("SELECT components FROM skills_fts WHERE id = ?").get("acme/remote-mcp") as { components: string };
    assert.ok(ftsRow.components.includes("beta_tool"), "tool names must land in the FTS components field");
  } finally {
    await fx.close();
  }
});

test("traffic paging: keyset cursor walks the traffic order exactly once", async () => {
  const { db, raw } = makeDb();
  const scores: [string, number, number][] = [
    ["acme/t1", 10, 5], ["acme/t2", 10, 9], ["acme/t3", 5, 0],
    ["acme/t4", 0, 3], ["acme/t5", 0, 2], ["acme/t6", 0, 1],
  ];
  for (const [id, score, calls] of scores) {
    insertRecord(raw, record({ id }));
    raw.prepare(
      "INSERT INTO record_stats (skill_id, calls_30d, calls_7d, calls_prev_7d, installs_total, installs_30d, owner_records, owner_attested_share, owner_warning_rate, behavior_score, refreshed_at) VALUES (?, ?, 0, 0, 0, 0, 1, 1, 0, ?, '2026-11-11T00:00:00Z')",
    ).run(id, calls, score);
  }
  const seen: string[] = [];
  let cursor = null as ReturnType<typeof decodeTrafficCursor>;
  for (let page = 0; page < 3; page++) {
    const items = await trafficPage(db, cursor, 2);
    seen.push(...items.map((i) => i.record.id));
    const last = items[items.length - 1];
    cursor = decodeTrafficCursor(encodeTrafficCursor({ s: last.behaviorScore, c: last.calls30d, id: last.record.id }));
  }
  assert.deepEqual(seen, ["acme/t2", "acme/t1", "acme/t3", "acme/t4", "acme/t5", "acme/t6"]);

  // enrichPage contract (layers: [] isolates the paging machinery).
  const store = new D1EnrichmentStore(db);
  const deps = { store, db, fetchFn: fakeFetch([]), fetchBytes: async () => null, assets: new InMemoryAssetStore() };
  const p1 = await enrichPage(deps, { limit: 4, layers: [] });
  assert.equal(p1.considered, 4);
  assert.equal(p1.done, false);
  assert.ok(p1.nextCursor);
  const p2 = await enrichPage(deps, { limit: 4, cursor: p1.nextCursor, layers: [] });
  assert.equal(p2.considered, 2);
  assert.equal(p2.done, true);
  assert.equal(p2.nextCursor, null);
});

test("extrasForIds: chunked lookup stays under D1's variable cap and returns every id", async () => {
  const { db } = makeDb();
  const store = new D1EnrichmentStore(db);
  const ids: string[] = [];
  for (let i = 0; i < 120; i++) {
    const id = `acme/x${i}`;
    ids.push(id);
    await store.upsertLayer(id, "hash", "b", "done", {
      derivedAt: "2026-11-11T00:00:00.000Z",
      subInventory: [{ kind: "skill", name: `sub_skill_${i}`, description: "", path: `skills/x${i}/SKILL.md` }],
    }, "2026-11-11T00:00:00.000Z");
  }
  // Guard wrapper: no single prepared statement may bind more than
  // 50 variables (production D1 caps ~100; embed pages run to 200).
  const guarded = {
    prepare(sql: string) {
      const placeholders = (sql.match(/\?/g) ?? []).length;
      assert.ok(placeholders <= 50, `statement binds ${placeholders} variables: ${sql.slice(0, 80)}`);
      return db.prepare(sql);
    },
  } as D1Like;
  const out = await extrasForIds(guarded, ids);
  assert.equal(out.size, 120);
  assert.equal(out.get("acme/x0"), "sub_skill_0");
  assert.equal(out.get("acme/x119"), "sub_skill_119");
  assert.deepEqual([...(await extrasForIds(guarded, [])).keys()], []);
});
