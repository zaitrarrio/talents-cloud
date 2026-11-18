// Scout tests (Discovery Phase 2) — MCP identity mapping + quality
// bar + record build, npm repo parsing + packument normalize +
// pointer records, code-search dedup, store corroboration merge,
// watermark/cursor sync logic, runner funnel (dedup across
// channels, watchlist quarantine, skills.sh external installs).
// All network is faked; all stores are in-memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { FetchFn } from "../src/types.js";
import type { RegistryKey } from "../src/attest.js";
import { verifyAttestation, contentHash } from "../src/attest.js";
import { InMemoryDiscoveryStore } from "../src/discovery/store.js";
import { Pacer } from "../src/discovery/sweep.js";
import {
  mapMcpIdentity, mcpQualityBar, buildMcpRecord, type McpServerJson,
} from "../src/discovery/scouts/mcp-record.js";
import {
  parseGithubRepo, normalizePackument, buildNpmPointerRecord, looksLikeMcp,
} from "../src/discovery/scouts/npm-record.js";
import { nominationsFromCodeSearch } from "../src/discovery/scouts/github-code.js";
import { mcpRegistryScout, nominationFromRegistryEntry, parseSyncState } from "../src/discovery/scouts/mcp-registry.js";
import { nominationFromNpmPackage } from "../src/discovery/scouts/npm.js";
import { runScoutNominations } from "../src/discovery/scouts/runner.js";
import type { ScoutContext, ScoutResult } from "../src/discovery/scouts/types.js";
import { stableStringify } from "../src/discovery/scouts/canonical-json.js";

function testKey(): RegistryKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
const key = testKey();
const fastPacer = () => new Pacer(0, async () => {}, () => 0);
const resp = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});
const AT = "2026-11-10T20:00:00.000Z";

// ---------------------------------------------------------------------------
// MCP identity mapping + quality bar
// ---------------------------------------------------------------------------

test("scouts: MCP identity mapping — last namespace label is the owner", () => {
  assert.deepEqual(mapMcpIdentity("io.github.dba-i/webcal-mcp"), { owner: "dba-i", name: "webcal-mcp" });
  assert.deepEqual(mapMcpIdentity("com.airtable/mcp-server"), { owner: "airtable", name: "mcp-server" });
  assert.deepEqual(mapMcpIdentity("io.modelcontextprotocol/server-everything"), { owner: "modelcontextprotocol", name: "server-everything" });
  assert.deepEqual(mapMcpIdentity("ai.bowmark/watchtower-mcp"), { owner: "bowmark", name: "watchtower-mcp" });
});

test("scouts: MCP quality bar — needs a channel AND a real description", () => {
  const base: McpServerJson = { name: "io.github.x/y", description: "a perfectly reasonable description here" };
  assert.equal(mcpQualityBar({ ...base, repository: { url: "https://github.com/x/y" } }).ok, true);
  assert.equal(mcpQualityBar({ ...base, remotes: [{ type: "streamable-http", url: "https://api.example.com/mcp" }] }).ok, true);
  assert.equal(mcpQualityBar({ ...base, packages: [{ registryType: "npm", identifier: "@x/y" }] }).ok, true);
  assert.equal(mcpQualityBar(base).ok, false); // no channel
  assert.equal(mcpQualityBar({ ...base, description: "short", repository: { url: "https://github.com/x/y" } }).ok, false); // thin description
});

const SERVER: McpServerJson = {
  name: "io.github.acme/weather-mcp",
  description: "Weather forecasts and alerts as MCP tools for any client",
  version: "1.2.0",
  repository: { url: "https://github.com/acme/weather-mcp", source: "github" },
  packages: [{ registryType: "npm", identifier: "@acme/weather-mcp", version: "1.2.0" }],
  remotes: [{ type: "streamable-http", url: "https://weather.example.com/mcp" }],
};

test("scouts: MCP record — pointer, derived declaration, verifiable attestation", () => {
  const rec = buildMcpRecord(SERVER, key, { now: new Date(AT) });
  assert.equal(rec.id, "acme/weather-mcp");
  assert.equal(rec.kind, "mcp");
  assert.equal(rec.pointerOnly, true);
  assert.equal(rec.sourceMarketplace, "mcp-registry");
  assert.equal(rec.ref, "1.2.0");
  assert.ok(rec.declaration.lines.some((l) => l.text.includes("Connects to a remote MCP server at weather.example.com")));
  assert.ok(rec.declaration.lines.some((l) => l.text.includes("Runs an MCP server package (npm:@acme/weather-mcp@1.2.0)")));
  assert.ok(rec.declaration.undeclared.some((u) => /tool list/i.test(u)));
  assert.equal(verifyAttestation(rec.attestation!, rec.id, rec.ref, [{ path: "server.json", content: stableStringify(SERVER) }]).ok, true);
  // Attestation signs the canonical server.json: key order irrelevant.
  const deepReverse = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(deepReverse);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, deepReverse(x)]));
    }
    return v;
  };
  const rec2 = buildMcpRecord(deepReverse(SERVER) as McpServerJson, key, { now: new Date(AT) });
  assert.equal(rec2.attestation?.contentHash, rec.attestation?.contentHash);
});

test("scouts: MCP record — collision moves to the -mcp namespace with a warning", () => {
  const rec = buildMcpRecord(SERVER, key, { collides: true });
  assert.equal(rec.id, "acme-mcp/weather-mcp");
  assert.ok(rec.validation.issues.some((i) => i.code === "namespace-collision"));
});

test("scouts: registry entry nomination — skips non-latest / inactive / below-bar", () => {
  const good = nominationFromRegistryEntry({ server: SERVER, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true, status: "active" } } }, AT);
  assert.equal(good.nomination?.kind, "mcp-server");
  assert.equal(good.nomination?.locator, "io.github.acme/weather-mcp");
  const old = nominationFromRegistryEntry({ server: SERVER, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } }, AT);
  assert.ok(old.skip);
  const thin = nominationFromRegistryEntry({ server: { name: "io.github.x/y", description: "tiny" } }, AT);
  assert.ok(thin.skip);
});

// ---------------------------------------------------------------------------
// npm parsing / normalization / pointer records
// ---------------------------------------------------------------------------

test("scouts: parseGithubRepo handles npm's URL zoo", () => {
  assert.equal(parseGithubRepo("git+https://github.com/Acme/Widgets.git"), "acme/widgets");
  assert.equal(parseGithubRepo("https://github.com/acme/widgets"), "acme/widgets");
  assert.equal(parseGithubRepo("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(parseGithubRepo("github:acme/widgets"), "acme/widgets");
  assert.equal(parseGithubRepo("https://gitlab.com/acme/widgets"), null);
  assert.equal(parseGithubRepo(undefined), null);
});

test("scouts: normalizePackument reads abbreviated + full shapes", () => {
  const abbr = normalizePackument({
    name: "@acme/tool", "dist-tags": { latest: "2.0.0" },
    versions: { "2.0.0": { description: "d", repository: { url: "git+https://github.com/acme/tool.git" } } },
    maintainers: [{ name: "acme" }],
  });
  assert.equal(abbr?.version, "2.0.0");
  assert.equal(parseGithubRepo(abbr?.repositoryUrl), "acme/tool");
  const full = normalizePackument({
    name: "plain", description: "top level", keywords: ["mcp"],
    "dist-tags": { latest: "0.1.0" }, versions: { "0.1.0": {} },
  });
  assert.equal(full?.description, "top level");
  assert.equal(normalizePackument({}), null);
});

test("scouts: npm pointer record — scoped owner, MCP detection, attestation", () => {
  const meta = { name: "@modelcontextprotocol/server-x", version: "1.0.0", description: "an mcp server", keywords: ["mcp-server"], maintainer: "someone" };
  assert.equal(looksLikeMcp(meta), true);
  const rec = buildNpmPointerRecord(meta, key, { now: new Date(AT) });
  assert.equal(rec.id, "modelcontextprotocol/server-x");
  assert.equal(rec.kind, "mcp");
  assert.equal(rec.pointerOnly, true);
  assert.equal(rec.sourceType, "npm");
  const signedFiles = [{ path: "package.json", content: stableStringify({ name: meta.name, version: meta.version, description: meta.description, repository: null, keywords: meta.keywords }) }];
  assert.equal(verifyAttestation(rec.attestation!, rec.id, rec.ref, signedFiles).ok, true);
  assert.equal(rec.attestation?.contentHash, contentHash(signedFiles));
});

test("scouts: npm pointer record — empty packument description gets a signed factual fallback", () => {
  const meta = { name: "@hubspot/mcp-server", version: "1.0.0", description: "", keywords: ["mcp", "hubspot"] };
  const rec = buildNpmPointerRecord(meta, key, { now: new Date(AT) });
  assert.ok(rec.description.length > 24);
  assert.ok(rec.description.includes("@hubspot/mcp-server"));
  // The fallback is inside the signed subset: hash recomputes from it.
  const subset = { name: meta.name, version: meta.version, description: rec.description, repository: null, keywords: meta.keywords };
  assert.equal(rec.attestation?.contentHash, contentHash([{ path: "package.json", content: stableStringify(subset) }]));
});

test("scouts: npm search nomination — repo-linked wins, else pointer kind", () => {
  const repoNom = nominationFromNpmPackage(
    { name: "pkg-a", description: "x", links: { repository: "https://github.com/acme/widgets" } }, 500, AT,
  );
  assert.equal(repoNom?.kind, "skill-repo");
  assert.equal(repoNom?.locator, "acme/widgets");
  assert.equal(repoNom?.signalScore, 500);
  const mcpNom = nominationFromNpmPackage({ name: "pkg-b", description: "an MCP server for things", keywords: [] }, undefined, AT);
  assert.equal(mcpNom?.kind, "mcp-server");
  const skillNom = nominationFromNpmPackage({ name: "pkg-c", description: "a claude skill bundle", keywords: ["claude-skill"] }, undefined, AT);
  assert.equal(skillNom?.kind, "skill-package");
});

// ---------------------------------------------------------------------------
// Code search dedup
// ---------------------------------------------------------------------------

test("scouts: code search dedups hits to unique repos with per-query counts", () => {
  const item = (repo: string) => ({ repository: { full_name: repo, html_url: `https://github.com/${repo}` } });
  const byTag = new Map<string, ReturnType<typeof item>[]>([
    ["skill", [item("Acme/Widgets"), item("acme/widgets"), item("acme/widgets"), item("other/thing")]],
    ["marketplace", [item("acme/widgets")]],
  ]);
  const noms = nominationsFromCodeSearch(byTag, AT);
  assert.equal(noms.length, 2);
  const w = noms.find((n) => n.locator === "acme/widgets")!;
  assert.equal(w.kind, "marketplace"); // marketplace hit classifies the candidate
  assert.equal(w.provenance.signals?.skillMdHits, 3);
  assert.equal(w.provenance.signals?.marketplaceHits, 1);
  assert.equal(w.signalScore, 4);
});

// ---------------------------------------------------------------------------
// Store: corroboration merge, watchlist, sync state, scout runs
// ---------------------------------------------------------------------------

test("scouts: store corroboration — second channel appends provenance, bumps priority, one row", async () => {
  const store = new InMemoryDiscoveryStore();
  const r1 = await store.nominate({
    kind: "mcp-server", locator: "io.github.acme/x", discoveredVia: "mcp-registry", priorityDelta: 3,
    provenance: { via: "mcp-registry", at: AT },
  }, AT);
  assert.equal(r1.created, true);
  const r2 = await store.nominate({
    kind: "skill-repo", locator: "io.github.acme/x", discoveredVia: "npm", priorityDelta: 2,
    provenance: { via: "npm", at: AT, signals: { weeklyDownloads: 42 } },
  }, AT);
  assert.equal(r2.created, false);
  assert.equal(r2.corroborated, true);
  assert.equal(r2.row.provenance.length, 2);
  assert.equal(r2.row.discoveredVia, "mcp-registry"); // first channel kept
  assert.ok(r2.row.priority > r1.row.priority);
  assert.equal((await store.listSources()).length, 1);
  // Same channel again: no corroboration credit, tiny priority bump.
  const r3 = await store.nominate({
    kind: "mcp-server", locator: "io.github.acme/x", discoveredVia: "mcp-registry", priorityDelta: 3,
    provenance: { via: "mcp-registry", at: AT },
  }, AT);
  assert.equal(r3.corroborated, false);
  assert.equal(r3.row.provenance.length, 3);
  // Watchlist never resurrects / downgrades.
  const r4 = await store.nominate({
    kind: "x-post", locator: "io.github.acme/x", discoveredVia: "x", priorityDelta: 1, watchlist: true,
    provenance: { via: "x", at: AT },
  }, AT);
  assert.equal(r4.row.status, "candidate");
  // Sync state + scout runs round-trip.
  await store.setSyncState("mcp-registry", "{\"updatedSince\":\"2026-11-10T00:00:00Z\"}");
  assert.equal(await store.getSyncState("mcp-registry"), "{\"updatedSince\":\"2026-11-10T00:00:00Z\"}");
  await store.recordScoutRun("npm", AT, AT, { nominated: 3 });
  assert.deepEqual(parseSyncState(await store.getSyncState("mcp-registry")), { updatedSince: "2026-11-10T00:00:00Z" });
});

// ---------------------------------------------------------------------------
// MCP sync: cursor resume + watermark incrementality
// ---------------------------------------------------------------------------

function registryFetch(pages: Map<string, unknown>): FetchFn {
  return async (url) => {
    const u = new URL(url);
    const since = u.searchParams.get("updated_since");
    const cursor = u.searchParams.get("cursor");
    const key = `${since ?? ""}|${cursor ?? ""}`;
    const body = pages.get(key);
    if (!body) return resp(404, { message: `no fixture page for ${key}` });
    return resp(200, body);
  };
}
const entry = (name: string, updatedAt: string, extra: Partial<McpServerJson> = {}) => ({
  server: {
    name, description: "a sufficiently long description for the bar", version: "1.0.0",
    repository: { url: `https://github.com/${name.split(".").pop() ?? "x"}/r` }, ...extra,
  },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true, updatedAt } },
});

test("scouts: MCP sync — capped run persists cursor; resume exhausts and sets watermark; third run sees only new", async () => {
  const store = new InMemoryDiscoveryStore();
  const pages = new Map<string, unknown>([
    ["|", { servers: [entry("io.github.a/one", "2026-11-10T01:00:00Z"), entry("io.github.b/two", "2026-11-10T02:00:00Z")], metadata: { nextCursor: "c2", count: 2 } }],
    ["|c2", { servers: [entry("io.github.c/three", "2026-11-10T03:00:00Z")], metadata: { count: 1 } }],
    ["2026-11-10T03:00:00Z|", { servers: [entry("io.github.d/four", "2026-11-10T04:00:00Z")], metadata: { count: 1 } }],
  ]);
  const ctx: ScoutContext = {
    fetchFn: registryFetch(pages), pacer: fastPacer(), now: () => new Date(AT),
    getSyncState: (k) => store.getSyncState(k), setSyncState: (k, v) => store.setSyncState(k, v),
  };
  const run1 = await mcpRegistryScout.run(ctx, { cap: 1 });
  assert.equal(run1.nominations.length, 2); // whole first page processed (soft cap), cursor saved
  assert.ok((await store.getSyncState("mcp-registry"))?.includes("c2")); // resume cursor saved
  const run2 = await mcpRegistryScout.run(ctx, { cap: 200 });
  assert.equal(run2.nominations.length, 1); // only "three", from the cursor onward
  assert.equal(await store.getSyncState("mcp-registry"), JSON.stringify({ updatedSince: "2026-11-10T03:00:00Z" }));
  const run3 = await mcpRegistryScout.run(ctx, { cap: 200 });
  assert.equal(run3.nominations.length, 1); // only the server changed after the watermark
  assert.equal(run3.nominations[0].locator, "io.github.d/four");
});

// ---------------------------------------------------------------------------
// Runner: cross-channel dedup, watchlist quarantine, external installs
// ---------------------------------------------------------------------------

function githubFake(tree: string[]): FetchFn {
  return async (url) => {
    if (url.includes("/git/trees/")) return resp(200, { tree: tree.map((path) => ({ path, type: "blob" })), truncated: false });
    if (url.includes("/repos/")) return resp(200, { archived: false, default_branch: "main", html_url: "https://github.com/acme/widgets", description: "widgets" });
    if (url.includes("/contents/")) return resp(200, { content: Buffer.from("---\nname: w\ndescription: a widget skill\n---\nbody\n").toString("base64"), sha: "abc" });
    return resp(404, { message: "nf" });
  };
}

const result = (nominations: ScoutResult["nominations"]): ScoutResult => ({
  nominations, stats: { examined: nominations.length, nominated: nominations.length, skipped: 0, calls: 0, rateLimitHits: 0 },
});

test("scouts: runner — two channels, one row, two provenances; watchlist never verifies", async () => {
  const store = new InMemoryDiscoveryStore();
  const deps = {
    store, registryKey: key, fetchFn: githubFake(["skills/w/SKILL.md"]),
    pacer: fastPacer(), embedFn: async () => [], now: () => new Date(AT),
  };
  const codeNom = {
    kind: "skill-repo" as const, locator: "acme/widgets", url: "https://github.com/acme/widgets",
    provenance: { via: "github-code-search", at: AT, signals: { skillMdHits: 3 } }, signalScore: 3,
  };
  const npmNom = {
    kind: "skill-repo" as const, locator: "acme/widgets", url: "https://github.com/acme/widgets",
    provenance: { via: "npm", at: AT, signals: { weeklyDownloads: 900 } }, signalScore: 900,
  };
  const leadNom = {
    kind: "lead" as const, locator: "https://blog.example.com/new-directory", url: "https://blog.example.com/new-directory",
    provenance: { via: "web-search", at: AT }, signalScore: 0,
  };
  const s1 = await runScoutNominations(deps, "github-code-search", result([codeNom]), { maxIngest: 0 });
  const s2 = await runScoutNominations(deps, "npm", result([npmNom, leadNom]), { maxIngest: 0 });
  assert.equal(s1.verified, 1);
  assert.equal(s2.corroborated, 1);
  const sources = await store.listSources();
  assert.equal(sources.length, 2);
  const repo = sources.find((s) => s.locator === "acme/widgets")!;
  assert.equal(repo.provenance.length, 2);
  assert.deepEqual(repo.provenance.map((p) => p.via).sort(), ["github-code-search", "npm"]);
  const lead = sources.find((s) => s.kind === "lead")!;
  assert.equal(lead.status, "watchlist");
});

test("scouts: runner — skills.sh installs attach as external traction, own counters untouched", async () => {
  const store = new InMemoryDiscoveryStore();
  const existing = buildNpmPointerRecord(
    { name: "widgets-pkg", version: "1.0.0", description: "d", keywords: [], repositoryUrl: "https://github.com/acme/widgets" },
    key, { now: new Date(AT) },
  );
  await store.upsertRecord(existing);
  const deps = {
    store, registryKey: key, fetchFn: githubFake(["skills/w/SKILL.md"]),
    pacer: fastPacer(), embedFn: async () => [], now: () => new Date(AT),
  };
  const stats = await runScoutNominations(deps, "skills.sh", result([{
    kind: "skill-repo", locator: "acme/widgets", url: "https://github.com/acme/widgets",
    provenance: { via: "skills.sh", at: AT, signals: { installs: 4321 } }, signalScore: 4321,
  }]), { maxIngest: 0 });
  assert.equal(stats.externalInstallsAttached, 1);
  assert.equal(store.externalInstalls.get(existing.id)?.installs, 4321);
  assert.equal(store.externalInstalls.get(existing.id)?.source, "skills.sh");
  assert.equal(store.stats.get(existing.id)?.installsTotal ?? 0, 0); // our own counters never overwritten by a channel
});
