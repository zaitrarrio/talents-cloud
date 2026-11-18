// Discovery tests (P5) — sweep verification/classification, pipeline
// dedup, hybrid merge weighting, behavior re-rank + cold-start decay,
// trending floor/fallback, goal-stack rule, related blending,
// synonyms, stub-embedding indexer, wrangler param inlining.
// All network is faked; all stores are in-memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { FetchFn, SkillRecord } from "../src/types.js";
import { classifyTree, runSweep, Pacer } from "../src/discovery/sweep.js";
import { runDiscoveryCycle } from "../src/discovery/pipeline.js";
import { InMemoryDiscoveryStore } from "../src/discovery/store.js";
import {
  hybridWeights, mergeHybrid, behaviorScore, coldStartBoost, applyPostRank,
  computeTrending, buildStack, relatedBlend, type RecordBehavior,
} from "../src/discovery/ranking.js";
import { expansionTermsFor, augmentedEmbeddingText } from "../src/discovery/synonyms.js";
import {
  HashStubEmbedder, InMemoryVectorIndex, indexStaleRecords, embeddingText,
} from "../src/discovery/embeddings.js";
import { inlineParams } from "../src/discovery/wrangler-d1.js";
import { generateKeyPairSync } from "node:crypto";
import type { RegistryKey } from "../src/attest.js";

function testKey(): RegistryKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
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
    sourceRepo: "acme/repo",
    sourcePath: "skills/x",
    sourceMarketplace: "acme/repo",
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

const resp = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});

const fastPacer = () => new Pacer(0, async () => {}, () => 0);

// ---------------------------------------------------------------------------
// Sweep: classification + verification
// ---------------------------------------------------------------------------

test("discovery: classifyTree recognises marketplace / skill-repo / plugin-repo / nothing", () => {
  assert.equal(classifyTree([".claude-plugin/marketplace.json", "plugins/a/SKILL.md"]).kind, "marketplace");
  assert.equal(classifyTree(["skills/x/SKILL.md", "README.md"]).kind, "skill-repo");
  assert.equal(classifyTree([".claude-plugin/plugin.json", "index.js"]).kind, "plugin-repo");
  assert.equal(classifyTree(["src/index.ts", "README.md"]).ok, false);
});

test("discovery: sweep dedups across queries and keeps archived flags", async () => {
  const fetchFn: FetchFn = async (url) => {
    assert.ok(url.includes("/search/repositories"));
    return resp(200, {
      items: [
        { full_name: "Acme/Skills", html_url: "https://github.com/acme/skills", description: "d", archived: false },
        { full_name: "acme/old", html_url: "https://github.com/acme/old", description: "", archived: true },
      ],
    });
  };
  const { candidates, stats } = await runSweep({
    fetchFn, pacer: fastPacer(),
    queries: [{ q: "a", via: "a" }, { q: "b", via: "b" }],
    perQuery: 5, cap: 10,
  });
  assert.equal(candidates.length, 2); // same repos from both queries, deduped + lowercased
  assert.equal(candidates[0].locator, "acme/skills");
  assert.equal(candidates[1].archived, true);
  assert.equal(stats.uniqueCandidates, 2);
});

// ---------------------------------------------------------------------------
// Pipeline: verify → ingest → dedup
// ---------------------------------------------------------------------------

const SKILL_MD = `---\nname: game-forge\ndescription: Build games with sprites and levels\n---\n# Game Forge\n`;

function pipelineFetch(): FetchFn {
  return async (url) => {
    if (url.includes("/search/repositories")) {
      return resp(200, {
        items: [
          { full_name: "acme/game-skills", html_url: "https://github.com/acme/game-skills", description: "games", archived: false },
          { full_name: "acme/plain-lib", html_url: "https://github.com/acme/plain-lib", description: "lib", archived: false },
        ],
      });
    }
    if (url.includes("/repos/acme/game-skills/git/trees/")) {
      return resp(200, { tree: [{ path: "skills/game-forge/SKILL.md", type: "blob" }], truncated: false });
    }
    if (url.includes("/repos/acme/plain-lib/git/trees/")) {
      return resp(200, { tree: [{ path: "src/index.ts", type: "blob" }], truncated: false });
    }
    if (url.includes("/repos/acme/game-skills")) {
      return resp(200, { default_branch: "main" });
    }
    if (url.includes("raw.githubusercontent.com/acme/game-skills/main/skills/game-forge/SKILL.md")) {
      return resp(200, SKILL_MD);
    }
    return resp(404, "not found");
  };
}

test("discovery: cycle verifies, rejects unverifiable, ingests a skill-repo end to end", async () => {
  const store = new InMemoryDiscoveryStore();
  const stats = await runDiscoveryCycle(
    { store, registryKey: testKey(), fetchFn: pipelineFetch(), pacer: fastPacer(), now: () => new Date() },
    { queries: [{ q: "x", via: "test" }], perQuery: 5, sweepCap: 10 },
  );
  assert.equal(stats.verified, 1);
  assert.equal(stats.rejected.length, 1);
  assert.equal(stats.rejected[0].locator, "acme/plain-lib");
  assert.equal(stats.newRecords, 1);
  assert.ok(store.records.has("acme/game-forge"));
  const src = await store.getSource("skill-repo", "acme/game-skills");
  assert.equal(src?.status, "ingested");
  assert.equal(src?.recordCount, 1);
  assert.equal(stats.sourcesByStatus.ingested, 1);
  assert.equal(stats.sourcesByStatus.rejected, 1);
});

test("discovery: second cycle dedups — known source touched, existing record not re-ingested", async () => {
  const store = new InMemoryDiscoveryStore();
  const deps = { store, registryKey: testKey(), fetchFn: pipelineFetch(), pacer: fastPacer(), now: () => new Date() };
  const opts = { queries: [{ q: "x", via: "test" }], perQuery: 5, sweepCap: 10 };
  await runDiscoveryCycle(deps, opts);
  const second = await runDiscoveryCycle(deps, opts);
  // Both repos are known on the second pass: the ingested skill-repo
  // AND the rejected one (rejections are sticky — a repo rejected for
  // having no skills is not re-verified every sweep).
  assert.equal(second.alreadyKnown, 2);
  assert.equal(second.newRecords, 0);
  assert.equal(store.records.size, 1);
});

test("discovery: enqueue mode hands verified sources to the queue instead of ingesting", async () => {
  const store = new InMemoryDiscoveryStore();
  const queued: string[] = [];
  const stats = await runDiscoveryCycle(
    {
      store, registryKey: testKey(), fetchFn: pipelineFetch(), pacer: fastPacer(),
      enqueue: async (s) => { queued.push(s.locator); },
      now: () => new Date(),
    },
    { queries: [{ q: "x", via: "test" }], perQuery: 5, sweepCap: 10 },
  );
  assert.deepEqual(queued, ["acme/game-skills"]);
  assert.equal(stats.enqueued, 1);
  assert.equal(stats.newRecords, 0);
});

// ---------------------------------------------------------------------------
// Ranking: hybrid weights + merge
// ---------------------------------------------------------------------------

test("discovery: hybrid weight shifts toward vector as queries lengthen", () => {
  const w1 = hybridWeights(1);
  const w3 = hybridWeights(3);
  const w6 = hybridWeights(6);
  const w9 = hybridWeights(9);
  assert.ok(w1.keyword > w3.keyword && w3.keyword > w6.keyword && w6.keyword > w9.keyword);
  assert.ok(Math.abs(w1.keyword + w1.vector - 1) < 1e-9);
  assert.ok(w1.keyword > 0.8, "short identifier queries stay keyword-dominant");
});

test("discovery: mergeHybrid blends rank-normalized keyword with cosine vector scores", () => {
  const merged = mergeHybrid(
    [{ id: "a/x", score: 99 }, { id: "a/y", score: 50 }],
    [{ id: "a/y", score: 0.9 }, { id: "a/z", score: 0.8 }],
    { keyword: 0.5, vector: 0.5 },
  );
  // y is in both lists → must win; x keyword-only; z vector-only.
  assert.equal(merged[0].id, "a/y");
  assert.deepEqual(merged.map((m) => m.id).sort(), ["a/x", "a/y", "a/z"]);
  assert.ok(merged.find((m) => m.id === "a/y")!.vectorScore === 0.9);
});

// ---------------------------------------------------------------------------
// Ranking: behavior + cold start
// ---------------------------------------------------------------------------

const zeroBehavior: RecordBehavior = {
  calls30d: 0, calls7d: 0, callsPrev7d: 0, installsTotal: 0, installs30d: 0,
  ownerAttestedShare: 0, ownerWarningRate: 0,
};

test("discovery: behaviorScore rewards retention + installs + trust, log-scaled", () => {
  const hot = behaviorScore({ ...zeroBehavior, calls30d: 100, installsTotal: 50, ownerAttestedShare: 1, ownerWarningRate: 0 });
  const cold = behaviorScore(zeroBehavior);
  const spammy = behaviorScore({ ...zeroBehavior, calls30d: 10000 });
  assert.ok(hot > cold);
  assert.ok(spammy < hot + 3, "log scale: 100× the calls must not swamp everything");
  const untrusted = behaviorScore({ ...zeroBehavior, ownerAttestedShare: 0, ownerWarningRate: 2 });
  assert.ok(untrusted < cold, "warning-heavy untrusted owners score below neutral");
});

test("discovery: coldStartBoost decays linearly to zero at 14 days", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  assert.equal(coldStartBoost(at(0), now), 0.5);
  assert.ok(Math.abs(coldStartBoost(at(7), now) - 0.25) < 1e-9);
  assert.equal(coldStartBoost(at(14), now), 0);
  assert.equal(coldStartBoost(at(30), now), 0);
});

test("discovery: applyPostRank lets a brand-new record outrank an equal stale one", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  const hits = [
    { id: "a/old", score: 0.6 },
    { id: "a/new", score: 0.6 },
  ];
  const ingested = new Map([
    ["a/old", "2026-09-01T00:00:00Z"],
    ["a/new", "2026-11-09T00:00:00Z"],
  ]);
  const ranked = applyPostRank(hits, new Map(), ingested, now);
  assert.equal(ranked[0].id, "a/new");
});

// ---------------------------------------------------------------------------
// Trending + stacks + related
// ---------------------------------------------------------------------------

test("discovery: trending uses velocity above the floor, else declares fallback", () => {
  const thin = computeTrending([{ id: "a/x", calls7d: 1, callsPrev7d: 0, calls30d: 2 }]);
  assert.equal(thin.fallback, true);
  const rows = [
    { id: "a/rising", calls7d: 10, callsPrev7d: 2, calls30d: 20 },
    { id: "a/steady", calls7d: 9, callsPrev7d: 9, calls30d: 40 },
    { id: "a/third", calls7d: 5, callsPrev7d: 5, calls30d: 12 },
    { id: "a/quiet", calls7d: 0, callsPrev7d: 0, calls30d: 0 },
  ];
  const t = computeTrending(rows);
  assert.equal(t.fallback, false);
  assert.equal(t.ids[0], "a/rising", "growth beats raw volume");
  assert.ok(!t.ids.includes("a/quiet"));
});

test("discovery: goal stack needs a multi-token query AND ≥2 kinds in the top results", () => {
  const skill = record({ id: "a/do-it", kind: "skill" });
  const mcp = record({ id: "a/connect-it", kind: "mcp" });
  const stack = buildStack([skill, mcp], "reconcile my invoices");
  assert.ok(stack);
  assert.equal(stack!.picks.length, 2);
  assert.equal(buildStack([skill, record({ id: "a/other", kind: "skill" })], "reconcile invoices"), null);
  assert.equal(buildStack([skill, mcp], "invoices"), null);
});

test("discovery: relatedBlend excludes self and blends vector + owner + components", () => {
  const target = record({
    id: "anthropics/pdf", kind: "skill",
    components: { skills: ["pdf"], commands: [], agents: [], hooks: false, mcpServers: [] },
  });
  const docx = record({
    id: "anthropics/docx", kind: "skill",
    components: { skills: ["docx"], commands: [], agents: [], hooks: false, mcpServers: [] },
  });
  const other = record({ id: "zzz/random", kind: "agent" });
  const picks = relatedBlend(target, [target, docx, other], [{ id: "anthropics/docx", score: 0.8 }]);
  assert.ok(picks.length >= 1);
  assert.equal(picks[0].id, "anthropics/docx");
  assert.ok(!picks.some((p) => p.id === "anthropics/pdf"));
  assert.ok(picks[0].reasons.some((r) => r.includes("same publisher")));
});

// ---------------------------------------------------------------------------
// Synonyms + embeddings + inlining
// ---------------------------------------------------------------------------

test("discovery: synonyms expand intent terms, never echo the query's own words", () => {
  const terms = expansionTermsFor("build games");
  assert.ok(terms.some((t) => t.includes("game development")));
  assert.ok(!terms.includes("game"));
  assert.ok(augmentedEmbeddingText("build games").includes("three.js"));
  assert.deepEqual(expansionTermsFor("zzzz nothing"), []);
});

test("discovery: hash-stub indexer embeds once, then skips fresh records", async () => {
  const store = new InMemoryDiscoveryStore();
  const embedder = new HashStubEmbedder();
  const index = new InMemoryVectorIndex();
  const recs = [
    record({ id: "a/pdf", description: "Work with PDF files, merge and split documents" }),
    record({ id: "a/game", description: "Build games with sprites" }),
  ];
  const first = await indexStaleRecords(store, embedder, index, recs);
  assert.equal(first.embedded, 2);
  const second = await indexStaleRecords(store, embedder, index, recs);
  assert.equal(second.embedded, 0);
  assert.equal(second.skippedFresh, 2);
  const [q] = await embedder.embed(["pdf documents merge"]);
  const neighbours = await index.query(q, 2);
  // Vectors are keyed by sha256(record id) — translate back via the
  // store's map, exactly as the Worker does.
  const vmap = await store.vectorIdMap();
  assert.equal(vmap.get(neighbours[0].id), "a/pdf");
  assert.ok(embeddingText(recs[0]).includes("PDF files"));
});

test("discovery: inlineParams escapes quotes and types values", () => {
  assert.equal(
    inlineParams("SELECT * FROM t WHERE a = ? AND b = ? AND c = ?", ["o'brien", 42, null]),
    "SELECT * FROM t WHERE a = 'o''brien' AND b = 42 AND c = NULL",
  );
});
