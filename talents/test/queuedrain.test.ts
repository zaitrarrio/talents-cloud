// Queue-based backfill drain (2026-11-11) — the talents-ingest
// consumer in CANDIDATE mode (verify → ingest per message), the
// candidate producer (admin paging + flag-gated cron step), and
// back-compat for the verified-source messages the cron/webhook
// paths have always sent.
//
// Semantics under test (parity with scripts/backfill-drain.mjs,
// upgraded by queue retry semantics):
//   - deterministic failures (not-a-skill, repo gone 404,
//     oversized-deterministic ingest errors) mark the source
//     rejected with the reason in D1 and the handler RESOLVES
//     (the consumer acks — no retry);
//   - transient failures (network, GitHub 403/429/5xx) THROW
//     (the consumer retries, then the DLQ) and the source row
//     stays a candidate throughout;
//   - the list-classification heuristic rescues no-skill-files
//     candidates whose markdown links to ≥10 repos;
//   - twin rows for a locator retire when the canonical row
//     reaches a terminal state.
//
// All network is faked at the global fetch (the Worker paths run
// on defaultFetch); the store is the REAL D1DiscoveryStore over a
// real SQLite database built from the production migrations.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import type { RegistryKey } from "../src/attest.js";
import type { D1Like, D1StatementLike } from "../src/search-d1.js";
import {
  D1DiscoveryStore, InMemoryDiscoveryStore, type SourceRow,
} from "../src/discovery/store.js";
import { Pacer } from "../src/discovery/sweep.js";
import {
  enqueueCandidatePage, handleAdminEnqueueCandidates, handleQueueMessage,
  queueDrainEnabled, runQueueDrainProducerStep, QUEUE_DRAIN_PAGE_SIZE,
  type IngestQueueMessage,
} from "../cf/src/discovery.js";
import type { Env } from "../cf/src/db.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function testKey(): RegistryKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

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

function makeDb(opts: { failRun?: (sql: string) => boolean } = {}): D1Like {
  const raw = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_discovery.sql", "0003_vector_id.sql", "0004_scouts.sql", "0007_harden_drain.sql"]) {
    raw.exec(readFileSync(new URL(`../../cf/migrations/${f}`, import.meta.url), "utf8"));
  }
  return {
    prepare(sql: string): D1StatementLike {
      const stmt = raw.prepare(sql);
      let params: unknown[] = [];
      const self: D1StatementLike = {
        bind(...p: unknown[]) { params = p; return self; },
        async all<T>() { return { results: stmt.all(...params) as T[] }; },
        async run() {
          if (opts.failRun?.(sql)) throw new Error("statement too long: SQLITE_TOOBIG (test-injected)");
          stmt.run(...params);
          return {};
        },
        async first<T>() { return (stmt.get(...params) as T | undefined) ?? null; },
      };
      return self;
    },
  };
}

interface FetchCall { url: string; headers: Record<string, string> }
type StubResult = { status: number; body?: unknown } | "throw";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function installFetch(handler: (url: string) => StubResult): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
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
  return calls;
}

const resp = (status: number, body?: unknown): StubResult => ({ status, body });

/** Serves repo metadata, recursive trees (HEAD + main), and raw
 *  files for one locator; returns null for URLs that aren't its. */
function serveRepo(
  locator: string,
  opts: { tree?: { path: string; type: string }[]; files?: Record<string, string>; headStatus?: number } = {},
): (url: string) => StubResult | null {
  const tree = opts.tree ?? [];
  return (url: string) => {
    if (url === `https://api.github.com/repos/${locator}`) return resp(200, { default_branch: "main" });
    if (url === `https://api.github.com/repos/${locator}/git/trees/HEAD?recursive=1`) {
      if (opts.headStatus) return resp(opts.headStatus, { message: "stubbed" });
      return resp(200, { tree, truncated: false });
    }
    if (url === `https://api.github.com/repos/${locator}/git/trees/main?recursive=1`) {
      return resp(200, { tree, truncated: false });
    }
    const rawPrefix = `https://raw.githubusercontent.com/${locator}/main/`;
    if (url.startsWith(rawPrefix)) {
      const path = url.slice(rawPrefix.length);
      const files = opts.files ?? {};
      if (path in files) return resp(200, files[path]);
      return resp(404, "not found");
    }
    return null;
  };
}

function compose(...handlers: ((url: string) => StubResult | null)[]): (url: string) => StubResult {
  return (url: string) => {
    for (const h of handlers) {
      const r = h(url);
      if (r) return r;
    }
    return resp(404, { message: "not found" });
  };
}

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# body\n`;

const AT = "2026-11-11T00:00:00.000Z";
function sourceRow(partial: Partial<SourceRow> & { locator: string }): SourceRow {
  return {
    kind: "skill-repo",
    url: `https://github.com/${partial.locator}`,
    discoveredVia: "backfill",
    status: "candidate",
    reason: null,
    firstSeen: AT, lastSeen: AT, lastIngested: null, recordCount: 0,
    provenance: [{ via: "backfill", at: AT }],
    priority: 0,
    ...partial,
  };
}

function makeEnv(db: D1Like, extra: Record<string, unknown> = {}): { env: Env; sent: IngestQueueMessage[] } {
  const sent: IngestQueueMessage[] = [];
  const env = {
    DB: db,
    TALENTS_REGISTRY_KEY: JSON.stringify(testKey()),
    INGEST_QUEUE: { send: async (m: unknown) => { sent.push(m as IngestQueueMessage); } },
    ...extra,
  } as unknown as Env;
  return { env, sent };
}

const fastPacer = () => new Pacer(0, async () => {}, () => 0);

const DEMO_TREE = [{ path: "SKILL.md", type: "blob" }];
const DEMO_FILES = { "SKILL.md": skillMd("demo-skill", "Demo skill does demo things for tests.") };

async function seedAndMessage(
  db: D1Like,
  row: SourceRow,
  message?: Partial<IngestQueueMessage>,
): Promise<{ env: Env; store: D1DiscoveryStore }> {
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(row);
  const { env } = makeEnv(db);
  await handleQueueMessage(env, { locator: row.locator, kind: row.kind, via: "backfill", ...message }, { pacer: fastPacer() });
  return { env, store };
}

// ---------------------------------------------------------------------------
// Consumer — candidate mode
// ---------------------------------------------------------------------------

test("queuedrain: candidate skill-repo verifies and ingests (happy path)", async () => {
  const db = makeDb();
  installFetch(compose(serveRepo("acme/demo", { tree: DEMO_TREE, files: DEMO_FILES })));
  const { store } = await seedAndMessage(db, sourceRow({ locator: "acme/demo" }));
  const row = await store.getSource("skill-repo", "acme/demo");
  assert.equal(row?.status, "ingested");
  assert.equal(row?.recordCount, 1);
  const record = await store.getRecord("acme/demo-skill");
  assert.ok(record, "record acme/demo-skill exists");
  assert.equal(record?.sourceRepo, "acme/demo");
});

test("queuedrain: candidate kind corrected at verification (skill claim, marketplace tree)", async () => {
  const db = makeDb();
  const tree = [
    { path: ".claude-plugin/marketplace.json", type: "blob" },
    { path: "SKILL.md", type: "blob" },
  ];
  const files = {
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "acme-mp",
      owner: { name: "Acme" },
      plugins: [{ name: "demo-skill", source: "./", description: "Demo plugin." }],
    }),
    ".claude-plugin/plugin.json": JSON.stringify({ name: "demo-skill", description: "Demo plugin." }),
    "SKILL.md": skillMd("demo-skill", "Demo skill does demo things for tests."),
  };
  installFetch(compose(serveRepo("acme/mp", { tree, files })));
  const { store } = await seedAndMessage(db, sourceRow({ locator: "acme/mp" }));
  // The provisional skill-repo row retires as a twin of the
  // canonical marketplace row that verification created.
  const provisional = await store.getSource("skill-repo", "acme/mp");
  assert.equal(provisional?.status, "stale");
  const canonical = await store.getSource("marketplace", "acme/mp");
  assert.equal(canonical?.status, "ingested");
});

test("queuedrain: not-a-skill candidate is rejected deterministically (resolves = ack)", async () => {
  const db = makeDb();
  installFetch(compose(serveRepo("acme/plain", {
    tree: [{ path: "src/index.ts", type: "blob" }, { path: "package.json", type: "blob" }],
  })));
  const { store } = await seedAndMessage(db, sourceRow({ locator: "acme/plain" }));
  const row = await store.getSource("skill-repo", "acme/plain");
  assert.equal(row?.status, "rejected");
  assert.match(row?.reason ?? "", /no marketplace\.json, SKILL\.md, or plugin\.json/);
});

test("queuedrain: gone repo (404) is rejected deterministically", async () => {
  const db = makeDb();
  installFetch(compose(serveRepo("acme/gone", { headStatus: 404 })));
  const { store } = await seedAndMessage(db, sourceRow({ locator: "acme/gone" }));
  const row = await store.getSource("skill-repo", "acme/gone");
  assert.equal(row?.status, "rejected");
  assert.match(row?.reason ?? "", /git tree fetch failed/);
});

test("queuedrain: rate-limited verify (403) throws for retry and the row stays candidate", async () => {
  const db = makeDb();
  installFetch(compose(serveRepo("acme/limited", { headStatus: 403 })));
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "acme/limited" }));
  const { env } = makeEnv(db);
  await assert.rejects(
    handleQueueMessage(env, { locator: "acme/limited", kind: "skill-repo", via: "backfill" }, { pacer: fastPacer() }),
    /transient verify failure/,
  );
  const row = await store.getSource("skill-repo", "acme/limited");
  assert.equal(row?.status, "candidate");
});

test("queuedrain: network failure during verify throws and the row stays candidate", async () => {
  const db = makeDb();
  installFetch((url) => (url.includes("/git/trees/HEAD") ? "throw" : resp(404, { message: "not found" })));
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "acme/flaky" }));
  const { env } = makeEnv(db);
  await assert.rejects(
    handleQueueMessage(env, { locator: "acme/flaky", kind: "skill-repo", via: "backfill" }, { pacer: fastPacer() }),
    /transient verify failure/,
  );
  const row = await store.getSource("skill-repo", "acme/flaky");
  assert.equal(row?.status, "candidate");
});

test("queuedrain: deterministic ingest failure (oversized) dead-letters the candidate without throwing", async () => {
  const db = makeDb({ failRun: (sql) => sql.includes("INSERT INTO records") });
  installFetch(compose(serveRepo("acme/demo", { tree: DEMO_TREE, files: DEMO_FILES })));
  const { store } = await seedAndMessage(db, sourceRow({ locator: "acme/demo" }));
  const row = await store.getSource("skill-repo", "acme/demo");
  assert.equal(row?.status, "rejected");
  assert.match(row?.reason ?? "", /ingest failed \(deterministic\)/);
});

test("queuedrain: list heuristic rescues a no-skill-files candidate (mined, never ingested)", async () => {
  const db = makeDb();
  const links = Array.from({ length: 12 }, (_, i) => `- [r${i + 1}](https://github.com/o${i + 1}/r${i + 1})`).join("\n");
  installFetch(compose(serveRepo("acme/awesome", {
    tree: [{ path: "README.md", type: "blob" }],
    files: { "README.md": `# Awesome Test List\n\n## Skills\n${links}\n` },
  })));
  const { store } = await seedAndMessage(db, sourceRow({ locator: "acme/awesome" }));
  const listRow = await store.getSource("list", "acme/awesome");
  assert.equal(listRow?.status, "mined");
  assert.equal(await store.getSource("skill-repo", "acme/awesome"), null);
  assert.equal(await store.getRecord("acme/awesome"), null);
  const counts = await store.countSourcesByStatus();
  assert.ok((counts.candidate ?? 0) >= 12, `mined candidates nominated (got ${counts.candidate})`);
});

test("queuedrain: twin rows retire when the canonical row ingests", async () => {
  const db = makeDb();
  installFetch(compose(serveRepo("acme/twin", { tree: DEMO_TREE, files: DEMO_FILES })));
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "acme/twin", kind: "skill-repo", priority: 5 }));
  await store.upsertSource(sourceRow({ locator: "acme/twin", kind: "plugin-repo", priority: 1 }));
  const { env } = makeEnv(db);
  await handleQueueMessage(env, { locator: "acme/twin", kind: "skill-repo", via: "backfill" }, { pacer: fastPacer() });
  assert.equal((await store.getSource("skill-repo", "acme/twin"))?.status, "ingested");
  assert.equal((await store.getSource("plugin-repo", "acme/twin"))?.status, "stale");
});

test("queuedrain: GITHUB_TOKEN rides api.github.com calls only", async () => {
  const db = makeDb();
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "qd-test-token";
  try {
    const calls = installFetch(compose(serveRepo("acme/demo", { tree: DEMO_TREE, files: DEMO_FILES })));
    const store = new D1DiscoveryStore(db);
    await store.upsertSource(sourceRow({ locator: "acme/demo" }));
    const { env } = makeEnv(db, { GITHUB_TOKEN: "qd-test-token" });
    await handleQueueMessage(env, { locator: "acme/demo", kind: "skill-repo", via: "backfill" }, { pacer: fastPacer() });
    const gh = calls.filter((c) => c.url.startsWith("https://api.github.com/"));
    assert.ok(gh.length >= 2, "verify + ingest made api.github.com calls");
    for (const c of gh) assert.equal(c.headers.authorization, "Bearer qd-test-token", c.url);
    const raw = calls.filter((c) => c.url.startsWith("https://raw.githubusercontent.com/"));
    assert.ok(raw.length >= 1, "ingest fetched the SKILL.md from raw");
    for (const c of raw) assert.equal(c.headers.authorization, undefined, c.url);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
});

// ---------------------------------------------------------------------------
// Consumer — back-compat paths
// ---------------------------------------------------------------------------

test("queuedrain: verified-source message keeps the legacy path (no verify call)", async () => {
  const db = makeDb();
  const calls = installFetch(compose(serveRepo("acme/demo", { tree: DEMO_TREE, files: DEMO_FILES })));
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "acme/demo", status: "verified", reason: "1 SKILL.md file(s) present" }));
  const { env } = makeEnv(db);
  // Cron messages carry no kind — the probe must find the row.
  await handleQueueMessage(env, { locator: "acme/demo", via: "cron" }, { pacer: fastPacer() });
  assert.equal((await store.getSource("skill-repo", "acme/demo"))?.status, "ingested");
  assert.ok(await store.getRecord("acme/demo-skill"));
  assert.equal(calls.filter((c) => c.url.includes("/git/trees/HEAD")).length, 0, "no verification call on the verified path");
});

test("queuedrain: unknown locator records a candidate and returns (webhook behavior)", async () => {
  const db = makeDb();
  const calls = installFetch(() => resp(404, { message: "not found" }));
  const { env } = makeEnv(db);
  await handleQueueMessage(env, { locator: "acme/brand-new", via: "webhook" });
  const store = new D1DiscoveryStore(db);
  const row = await store.getSource("skill-repo", "acme/brand-new");
  assert.equal(row?.status, "candidate");
  assert.match(row?.reason ?? "", /queued before verification/);
  assert.equal(calls.length, 0);
});

test("queuedrain: rejected row's message is a no-op", async () => {
  const db = makeDb();
  const calls = installFetch(() => resp(404, { message: "not found" }));
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "acme/dead", status: "rejected", reason: "no skill files" }));
  const { env } = makeEnv(db);
  await handleQueueMessage(env, { locator: "acme/dead", kind: "skill-repo", via: "backfill" }, { pacer: fastPacer() });
  assert.equal((await store.getSource("skill-repo", "acme/dead"))?.status, "rejected");
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

test("queuedrain: producer pages candidates in verification-priority order", async () => {
  const store = new InMemoryDiscoveryStore();
  const seed: SourceRow[] = [
    sourceRow({ locator: "c/c", kind: "marketplace", priority: 9 }),
    sourceRow({ locator: "a/a", kind: "skill-repo", priority: 5 }),
    sourceRow({ locator: "b/b", kind: "skill-repo", priority: 5 }),
    sourceRow({ locator: "h/h", kind: "skill-repo", priority: 5 }),
    sourceRow({ locator: "h/h", kind: "marketplace", priority: 5 }),
    sourceRow({ locator: "d/d", kind: "skill-repo", priority: 3 }),
    sourceRow({ locator: "e/e", kind: "npm-package", priority: 0 }),
    sourceRow({ locator: "f/f", kind: "skill-repo", priority: 99, status: "verified" }),
    sourceRow({ locator: "g/g", kind: "skill-repo", priority: 99, status: "rejected", reason: "x" }),
  ];
  for (const r of seed) await store.upsertSource(r);
  const sent: IngestQueueMessage[] = [];
  const queue = { send: async (m: unknown) => { sent.push(m as IngestQueueMessage); } };

  const seen: string[] = [];
  let cursor = null as Parameters<typeof enqueueCandidatePage>[2]["cursor"];
  let done = false;
  for (let page = 0; page < 6 && !done; page++) {
    const out = await enqueueCandidatePage(store, queue, { limit: 3, cursor, via: "backfill" });
    seen.push(...out.items.map((i) => `${i.kind}:${i.locator}`));
    cursor = out.nextCursor ? JSON.parse(Buffer.from(out.nextCursor, "base64url").toString("utf8")) : null;
    done = out.done;
  }
  assert.ok(done, "paging terminated");
  assert.deepEqual(seen, [
    "marketplace:c/c",
    "skill-repo:a/a",
    "skill-repo:b/b",
    "marketplace:h/h",
    "skill-repo:h/h",
    "skill-repo:d/d",
    "npm-package:e/e",
  ]);
  assert.equal(sent.length, 7);
  assert.ok(sent.every((m) => m.via === "backfill"));
});

test("queuedrain: admin enqueue handler — binding check, cursor check, happy page", async () => {
  const db = makeDb();
  const noQueue = { DB: db, TALENTS_REGISTRY_KEY: JSON.stringify(testKey()) } as unknown as Env;
  assert.deepEqual(await handleAdminEnqueueCandidates(noQueue, {}), { error: "INGEST_QUEUE binding not configured" });

  const { env, sent } = makeEnv(db);
  assert.deepEqual(await handleAdminEnqueueCandidates(env, { cursor: "!!!not-a-cursor!!!" }), { error: "invalid cursor" });

  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "a/a", priority: 2 }));
  await store.upsertSource(sourceRow({ locator: "b/b", priority: 1 }));
  const page1 = await handleAdminEnqueueCandidates(env, { limit: 1 }) as { enqueued: number; nextCursor: string | null; done: boolean };
  assert.equal(page1.enqueued, 1);
  assert.equal(page1.done, false);
  assert.ok(page1.nextCursor);
  const page2 = await handleAdminEnqueueCandidates(env, { limit: 1, cursor: page1.nextCursor! }) as { enqueued: number; nextCursor: string | null; done: boolean };
  assert.equal(page2.enqueued, 1);
  // A FULL page always yields a cursor (the keyset contract, same
  // as /admin/embed): `done` arrives on the following empty page.
  assert.equal(page2.done, false);
  const page3 = await handleAdminEnqueueCandidates(env, { limit: 1, cursor: page2.nextCursor! }) as { enqueued: number; done: boolean };
  assert.equal(page3.enqueued, 0);
  assert.equal(page3.done, true);
  assert.deepEqual(sent.map((m) => m.locator), ["a/a", "b/b"]);
});

test("queuedrain: scheduled producer step is a no-op while the flag is off", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "a/a" }));

  const off = makeEnv(db);
  assert.equal(queueDrainEnabled(off.env), false);
  assert.equal(await runQueueDrainProducerStep(off.env), null);
  assert.equal(off.sent.length, 0);

  assert.equal(queueDrainEnabled(makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" }).env), true);
  assert.equal(queueDrainEnabled(makeEnv(db, { QUEUE_DRAIN_ENABLED: "true" }).env), true);
  assert.equal(queueDrainEnabled(makeEnv(db, { QUEUE_DRAIN_ENABLED: "0" }).env), false);
  assert.equal(queueDrainEnabled(makeEnv(db, { QUEUE_DRAIN_ENABLED: "yes" }).env), false);

  const on = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await runQueueDrainProducerStep(on.env);
  assert.deepEqual(out, { enqueued: 1, done: true });
  assert.equal(on.sent.length, 1);
  assert.equal(on.sent[0].via, "backfill-cron");
  assert.ok(QUEUE_DRAIN_PAGE_SIZE >= 1 && QUEUE_DRAIN_PAGE_SIZE <= 500);
});

// ---------------------------------------------------------------------------
// Deploy config: the DLQ + concurrency contract is in the config the
// production deploy actually uses.
// ---------------------------------------------------------------------------

test("queuedrain: deploy config wires max_concurrency 5 + the DLQ", () => {
  const text = readFileSync(new URL("../../cf/wrangler.deploy.jsonc", import.meta.url), "utf8");
  assert.match(text, /"dead_letter_queue":\s*"talents-ingest-dlq"/);
  assert.match(text, /"max_concurrency":\s*5/);
  assert.match(text, /"max_retries":\s*3/);
});
