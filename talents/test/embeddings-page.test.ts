// Paged embedding indexer (embeddings.indexStaleRecordsPage): the
// /admin/embed route pages through the catalog one bounded page per
// call instead of scanning every record in a single invocation.
// These tests drive the pager with an in-memory fetcher/store/index
// in the same style as discovery.test.ts — the stub embedder is a
// deterministic hash embedder (local tests only, never a model).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SkillRecord } from "../src/types.js";
import { InMemoryDiscoveryStore } from "../src/discovery/store.js";
import {
  DEFAULT_EMBED_PAGE,
  HashStubEmbedder,
  InMemoryVectorIndex,
  MAX_EMBED_PAGE,
  indexStaleRecordsPage,
  type EmbedPageFetcher,
} from "../src/discovery/embeddings.js";

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

/** Records acme/s001 .. acme/sNNN (zero-padded so id order is stable). */
function catalog(n: number): SkillRecord[] {
  return Array.from({ length: n }, (_, i) =>
    record({ id: `acme/s${String(i + 1).padStart(3, "0")}`, description: `skill number ${i + 1}` }));
}

/** Fetcher honoring the contract: id-ascending, strictly after cursor. */
function fetcher(records: SkillRecord[]): EmbedPageFetcher {
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : 1));
  return async (cursor, limit) => sorted.filter((r) => cursor === null || r.id > cursor).slice(0, limit);
}

async function sweepAll(
  store: InMemoryDiscoveryStore,
  embedder: HashStubEmbedder,
  index: InMemoryVectorIndex,
  fetchPage: EmbedPageFetcher,
  limit?: number,
) {
  const pages: { considered: number; embedded: number; skippedFresh: number; nextCursor: string | null; done: boolean }[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const stats = await indexStaleRecordsPage(store, embedder, index, fetchPage, { limit, cursor });
    pages.push(stats);
    if (stats.done) return pages;
    cursor = stats.nextCursor;
    assert.ok(cursor, "a non-done page must yield a cursor");
  }
  throw new Error("sweep did not terminate");
}

test("embeddings page: a full sweep embeds every record exactly once, page by page", async () => {
  const records = catalog(7);
  const store = new InMemoryDiscoveryStore();
  const embedder = new HashStubEmbedder();
  const index = new InMemoryVectorIndex();
  const pages = await sweepAll(store, embedder, index, fetcher(records), 3);
  assert.deepEqual(pages.map((p) => p.considered), [3, 3, 1]);
  assert.deepEqual(pages.map((p) => p.embedded), [3, 3, 1]);
  assert.equal(pages[0].nextCursor, "acme/s003");
  assert.equal(pages[1].nextCursor, "acme/s006");
  assert.equal(pages[2].done, true);
  assert.equal(pages[2].nextCursor, null);
  assert.equal(index.size, 7);
  for (const r of records) {
    const meta = await store.getEmbeddingMeta(r.id);
    assert.ok(meta?.vectorId, `${r.id} carries a vector id`);
  }
});

test("embeddings page: a second sweep finds everything fresh and embeds nothing", async () => {
  const records = catalog(5);
  const store = new InMemoryDiscoveryStore();
  const embedder = new HashStubEmbedder();
  const index = new InMemoryVectorIndex();
  await sweepAll(store, embedder, index, fetcher(records), 2);
  const pages = await sweepAll(store, embedder, index, fetcher(records), 2);
  assert.equal(pages.reduce((s, p) => s + p.embedded, 0), 0);
  assert.equal(pages.reduce((s, p) => s + p.skippedFresh, 0), 5);
});

test("embeddings page: a record whose text changed is re-embedded, others stay fresh", async () => {
  const records = catalog(4);
  const store = new InMemoryDiscoveryStore();
  const embedder = new HashStubEmbedder();
  const index = new InMemoryVectorIndex();
  await sweepAll(store, embedder, index, fetcher(records), 10);
  records[1] = { ...records[1], description: "an entirely different purpose now" };
  const pages = await sweepAll(store, embedder, index, fetcher(records), 10);
  assert.equal(pages.reduce((s, p) => s + p.embedded, 0), 1);
  assert.equal(pages.reduce((s, p) => s + p.skippedFresh, 0), 3);
});

test("embeddings page: cursor resumes strictly after the given id", async () => {
  const records = catalog(6);
  const store = new InMemoryDiscoveryStore();
  const embedder = new HashStubEmbedder();
  const index = new InMemoryVectorIndex();
  const stats = await indexStaleRecordsPage(store, embedder, index, fetcher(records), { limit: 2, cursor: "acme/s003" });
  assert.equal(stats.considered, 2);
  assert.equal(stats.embedded, 2);
  assert.equal(stats.nextCursor, "acme/s005");
  assert.equal(await store.getEmbeddingMeta("acme/s003"), null);
  assert.ok(await store.getEmbeddingMeta("acme/s004"));
});

test("embeddings page: default page size applies, and oversized limits clamp to the cap", async () => {
  const many = catalog(MAX_EMBED_PAGE + 25);
  const store = new InMemoryDiscoveryStore();
  const embedder = new HashStubEmbedder();
  const index = new InMemoryVectorIndex();
  const dflt = await indexStaleRecordsPage(store, embedder, index, fetcher(many), {});
  assert.equal(dflt.considered, DEFAULT_EMBED_PAGE);
  assert.equal(dflt.done, false);
  const clamped = await indexStaleRecordsPage(store, embedder, index, fetcher(many), { limit: 999_999 });
  assert.equal(clamped.considered, MAX_EMBED_PAGE);
  const zero = await indexStaleRecordsPage(store, embedder, index, fetcher(many), { limit: 0 });
  assert.equal(zero.considered, DEFAULT_EMBED_PAGE);
});

test("embeddings page: a failed page is never marked done — its cursor retries cleanly", async () => {
  const records = catalog(5);
  const store = new InMemoryDiscoveryStore();
  const embedder = new HashStubEmbedder();
  const index = new InMemoryVectorIndex();
  const real = fetcher(records);
  let failOnce = true;
  const flaky: EmbedPageFetcher = async (cursor, limit) => {
    if (cursor === "acme/s002" && failOnce) {
      failOnce = false;
      throw new Error("D1_ERROR: simulated import-lock contention");
    }
    return real(cursor, limit);
  };
  const page1 = await indexStaleRecordsPage(store, embedder, index, flaky, { limit: 2 });
  assert.equal(page1.nextCursor, "acme/s002");
  await assert.rejects(() => indexStaleRecordsPage(store, embedder, index, flaky, { limit: 2, cursor: page1.nextCursor }));
  // Page 1's work persisted as the checkpoint; page 2 left no trace.
  assert.ok(await store.getEmbeddingMeta("acme/s001"));
  assert.equal(await store.getEmbeddingMeta("acme/s003"), null);
  // Retrying the same cursor completes the sweep.
  const rest = await sweepAll(store, embedder, index, flaky, 2);
  assert.ok(rest.length >= 1);
  assert.equal(index.size, 5);
});
