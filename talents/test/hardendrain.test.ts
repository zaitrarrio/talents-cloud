// Drain/queue hardening (2026-11-11, gate-harden-drain) — the
// producer pacing, processing leases, rate-limit backpressure,
// DLQ observability + recovery, and stall detection around the
// queue drain. Same harness as queuedrain.test.ts: all network is
// faked at the global fetch, the store is the REAL D1DiscoveryStore
// over a real SQLite database built from the production migrations
// (0001–0004 + 0007).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import type { RegistryKey } from "../src/attest.js";
import type { D1Like, D1StatementLike } from "../src/search-d1.js";
import {
  D1DiscoveryStore, InMemoryDiscoveryStore, LEASE_TTL_MINUTES, type DlqEntry, type SourceRow,
} from "../src/discovery/store.js";
import { Pacer } from "../src/discovery/sweep.js";
import {
  INFLIGHT_THRESHOLD, PRODUCER_TICK_PAGE, RATE_BUDGET_RESERVE_CALLS,
  RateBudgetExhaustedError, checkRateBudget, classifyDlqFailure,
  drainHealth, handleAdminEnqueueCandidates, handleQueueMessage,
  readGithubRateSnapshot, recordRateLimitHeaders, runDrainProducerTick, sweepDlq,
  type IngestQueueMessage,
} from "../cf/src/discovery.js";
import type { Env } from "../cf/src/db.js";

// ---------------------------------------------------------------------------
// Fixtures (mirrors queuedrain.test.ts)
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

function makeDb(): D1Like {
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
        async run() { stmt.run(...params); return {}; },
        async first<T>() { return (stmt.get(...params) as T | undefined) ?? null; },
      };
      return self;
    },
  };
}

interface FetchCall { url: string; headers: Record<string, string> }
type StubResult = { status: number; body?: unknown; headers?: Record<string, string> } | "throw";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function installFetch(handler: (url: string) => StubResult): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r = handler(url);
    if (r === "throw") throw new Error("network down (test stub)");
    const body = r.body ?? {};
    const headerMap = new Map(
      Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
      ...(r.headers ? { headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null } } : {}),
    };
  }) as typeof fetch;
  return calls;
}

const resp = (status: number, body?: unknown, headers?: Record<string, string>): StubResult => ({ status, body, headers });

function serveRepo(
  locator: string,
  opts: { tree?: { path: string; type: string }[]; files?: Record<string, string>; headStatus?: number; headHeaders?: Record<string, string> } = {},
): (url: string) => StubResult | null {
  const tree = opts.tree ?? [];
  return (url: string) => {
    if (url === `https://api.github.com/repos/${locator}`) return resp(200, { default_branch: "main" });
    if (url === `https://api.github.com/repos/${locator}/git/trees/HEAD?recursive=1`) {
      if (opts.headStatus) return resp(opts.headStatus, { message: "stubbed" }, opts.headHeaders);
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DEMO_TREE = [{ path: "SKILL.md", type: "blob" }];
const DEMO_FILES = { "SKILL.md": skillMd("demo-skill", "Demo skill does demo things for tests.") };

async function seedCandidates(store: D1DiscoveryStore, locators: string[], priorities?: number[]): Promise<void> {
  for (let i = 0; i < locators.length; i++) {
    await store.upsertSource(sourceRow({ locator: locators[i], priority: priorities?.[i] ?? 0 }));
  }
}

// ---------------------------------------------------------------------------
// Rate-limit budget recording (unit level)
// ---------------------------------------------------------------------------

function headerRes(status: number, headers: Record<string, string>) {
  return { status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
}

test("hardendrain: 429 with retry-after records exhausted-until (retry-after wins)", async () => {
  const store = new InMemoryDiscoveryStore();
  const before = Date.now();
  await recordRateLimitHeaders(store, headerRes(429, {
    "retry-after": "120",
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String(Math.floor(before / 1000) + 3600),
  }));
  const until = await store.getSyncState("github_rate_exhausted_until");
  assert.ok(until, "exhausted-until recorded");
  const untilMs = Date.parse(until!);
  assert.ok(untilMs >= before + 115_000 && untilMs <= before + 125_000, `until ~now+120s, got ${until}`);
  const rate = JSON.parse((await store.getSyncState("github_rate"))!);
  assert.equal(rate.remaining, 0);
});

test("hardendrain: 403 without headers gets the 60s default hold", async () => {
  const store = new InMemoryDiscoveryStore();
  const before = Date.now();
  await recordRateLimitHeaders(store, { status: 403, headers: { get: () => null } });
  const until = await store.getSyncState("github_rate_exhausted_until");
  assert.ok(until);
  const untilMs = Date.parse(until!);
  assert.ok(untilMs >= before + 55_000 && untilMs <= before + 65_000, `until ~now+60s, got ${until}`);
});

test("hardendrain: 200 with remaining below the low-water mark records the snapshot", async () => {
  const store = new InMemoryDiscoveryStore();
  await recordRateLimitHeaders(store, headerRes(200, { "x-ratelimit-remaining": "500", "x-ratelimit-reset": "1790000000" }));
  const rate = JSON.parse((await store.getSyncState("github_rate"))!);
  assert.equal(rate.remaining, 500);
  assert.equal(await store.getSyncState("github_rate_exhausted_until"), null);
});

test("hardendrain: 200 with healthy remaining writes nothing", async () => {
  const store = new InMemoryDiscoveryStore();
  await recordRateLimitHeaders(store, headerRes(200, { "x-ratelimit-remaining": "4000" }));
  assert.equal(await store.getSyncState("github_rate"), null);
  assert.equal(await store.getSyncState("github_rate_exhausted_until"), null);
});

test("hardendrain: responses without headers are a no-op", async () => {
  const store = new InMemoryDiscoveryStore();
  await recordRateLimitHeaders(store, { status: 429 });
  assert.equal(await store.getSyncState("github_rate_exhausted_until"), null);
});

test("hardendrain: checkRateBudget throws while exhausted, passes after expiry", async () => {
  const store = new InMemoryDiscoveryStore();
  await store.setSyncState("github_rate_exhausted_until", new Date(Date.now() + 60_000).toISOString());
  await assert.rejects(checkRateBudget(store), (e: unknown) => {
    assert.ok(e instanceof RateBudgetExhaustedError);
    assert.equal((e as RateBudgetExhaustedError).name, "RateBudgetExhaustedError");
    return true;
  });
  await store.setSyncState("github_rate_exhausted_until", new Date(Date.now() - 1000).toISOString());
  await checkRateBudget(store); // passes once the timestamp is past
});

// Snapshot expiry (drain stall, 2026-11-15): a low-water
// {remaining, reset} snapshot past its reset epoch must read as
// unknown — the Nov 15 stall was a 27-remaining snapshot whose
// reset had passed hours earlier, read as gospel forever.
test("hardendrain: expired rate snapshot reads as unknown and is cleared", async () => {
  const store = new InMemoryDiscoveryStore();
  const reset = Math.floor(Date.now() / 1000) - 3600; // reset 1h ago
  await store.setSyncState("github_rate", JSON.stringify({ remaining: 27, reset }));
  const snap = await readGithubRateSnapshot(store);
  assert.equal(snap.remaining, null);
  assert.equal(snap.reset, reset);
  assert.ok(!(await store.getSyncState("github_rate")), "expired row cleared");
});

test("hardendrain: fresh rate snapshot is trusted", async () => {
  const store = new InMemoryDiscoveryStore();
  const reset = Math.floor(Date.now() / 1000) + 3600; // reset 1h ahead
  await store.setSyncState("github_rate", JSON.stringify({ remaining: 27, reset }));
  const snap = await readGithubRateSnapshot(store);
  assert.equal(snap.remaining, 27);
  assert.equal(snap.reset, reset);
  assert.ok(await store.getSyncState("github_rate"), "fresh row kept");
});

test("hardendrain: rate snapshot without a reset cannot expire, kept as-is", async () => {
  const store = new InMemoryDiscoveryStore();
  await store.setSyncState("github_rate", JSON.stringify({ remaining: 600 }));
  assert.equal((await readGithubRateSnapshot(store)).remaining, 600);
  await store.setSyncState("github_rate", JSON.stringify({ remaining: 600, reset: null }));
  assert.equal((await readGithubRateSnapshot(store)).remaining, 600);
});

test("hardendrain: malformed rate snapshot reads as unknown", async () => {
  const store = new InMemoryDiscoveryStore();
  await store.setSyncState("github_rate", "{not json");
  assert.deepEqual(await readGithubRateSnapshot(store), { remaining: null, reset: null });
});

test("hardendrain: classifyDlqFailure maps error classes", () => {
  assert.equal(classifyDlqFailure(new RateBudgetExhaustedError("2099-01-01T00:00:00.000Z")), "rate-limit");
  assert.equal(classifyDlqFailure(new Error("GitHub API 429: rate limit exceeded")), "rate-limit");
  assert.equal(classifyDlqFailure(new Error("fetch failed: socket hang up")), "network");
  assert.equal(classifyDlqFailure(new Error("500 Internal Server Error")), "server");
  assert.equal(classifyDlqFailure(new Error("something entirely new")), "unknown");
});

// ---------------------------------------------------------------------------
// Processing leases — store level
// ---------------------------------------------------------------------------

test("hardendrain: lease acquire / conflict / expiry / clear", async () => {
  const store = new D1DiscoveryStore(makeDb());
  await store.upsertSource(sourceRow({ locator: "acme/demo" }));
  const t0 = new Date("2026-11-11T02:00:00.000Z");
  assert.equal(await store.tryClaimLease("skill-repo", "acme/demo", "holder-a", LEASE_TTL_MINUTES, t0), true);
  // A rival holder inside the TTL loses.
  assert.equal(await store.tryClaimLease("skill-repo", "acme/demo", "holder-b", LEASE_TTL_MINUTES, new Date(t0.getTime() + 60_000)), false);
  // The same holder re-claiming inside the TTL also loses (the
  // lease is exclusive until it expires — a redelivery must wait).
  assert.equal(await store.tryClaimLease("skill-repo", "acme/demo", "holder-a", LEASE_TTL_MINUTES, new Date(t0.getTime() + 60_000)), false);
  // Past the TTL the lease is reclaimable by anyone.
  assert.equal(await store.tryClaimLease("skill-repo", "acme/demo", "holder-b", LEASE_TTL_MINUTES, new Date(t0.getTime() + (LEASE_TTL_MINUTES + 1) * 60_000)), true);
  await store.clearLease("skill-repo", "acme/demo");
  assert.equal(await store.tryClaimLease("skill-repo", "acme/demo", "holder-a", LEASE_TTL_MINUTES, t0), true);
  assert.equal(LEASE_TTL_MINUTES, 30);
});

test("hardendrain: listCandidatePage skips actively-leased rows, keeps stale ones", async () => {
  const store = new D1DiscoveryStore(makeDb());
  await seedCandidates(store, ["acme/a", "acme/b", "acme/c"], [3, 2, 1]);
  const now = new Date("2026-11-11T02:00:00.000Z");
  await store.tryClaimLease("skill-repo", "acme/b", "holder-a", LEASE_TTL_MINUTES, now);
  // Stale lease on acme/c (claimed 31 min ago) must NOT hide it.
  await store.tryClaimLease("skill-repo", "acme/c", "holder-a", LEASE_TTL_MINUTES, new Date(now.getTime() - 31 * 60_000));
  const cutoff = new Date(now.getTime() - LEASE_TTL_MINUTES * 60_000).toISOString();
  const page = await store.listCandidatePage({ limit: 10, leaseCutoff: cutoff });
  assert.deepEqual(page.rows.map((r) => r.locator), ["acme/a", "acme/c"]);
  // No cutoff = the old behavior (all three).
  const unfiltered = await store.listCandidatePage({ limit: 10 });
  assert.equal(unfiltered.rows.length, 3);
  // listActiveLeases returns only the live one.
  const active = await store.listActiveLeases(cutoff);
  assert.deepEqual(active.map((l) => l.locator), ["acme/b"]);
});

// ---------------------------------------------------------------------------
// Consumer — leases + terminal bookkeeping + rate backpressure
// ---------------------------------------------------------------------------

test("hardendrain: terminal outcome clears the lease and records the drain counter", async () => {
  const db = makeDb();
  installFetch(compose(serveRepo("acme/demo", { tree: DEMO_TREE, files: DEMO_FILES })));
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "acme/demo" }));
  const { env } = makeEnv(db);
  await handleQueueMessage(env, { locator: "acme/demo", kind: "skill-repo", via: "backfill" }, { pacer: fastPacer(), messageId: "msg-1" });
  assert.equal((await store.getSource("skill-repo", "acme/demo"))?.status, "ingested");
  assert.equal(await store.getSyncState("drain:terminal"), "1");
  assert.ok(await store.getSyncState("drain:last_terminal_at"), "last_terminal_at stamped");
  // All leases ever held (cutoff in the distant past) — none remain.
  assert.deepEqual(await store.listActiveLeases("1970-01-01T00:00:00.000Z"), []);
});

test("hardendrain: redelivered duplicate loses the lease and throws (no double ingest)", async () => {
  const db = makeDb();
  installFetch(compose(serveRepo("acme/demo", { tree: DEMO_TREE, files: DEMO_FILES })));
  // Slow the winner's tree fetch so it still holds the lease when
  // the duplicate arrives — otherwise the winner finishes in
  // <10ms and the loser re-ingests an already-ingested row.
  const stubFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    if (String(url).includes("/git/trees/HEAD")) await sleep(50);
    return stubFetch(url, init);
  }) as typeof fetch;
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "acme/demo" }));
  const { env } = makeEnv(db);
  const winner = handleQueueMessage(env, { locator: "acme/demo", kind: "skill-repo", via: "backfill" }, { pacer: fastPacer(), messageId: "msg-1" });
  await sleep(10); // the winner claims its lease before any fetch
  const loser = handleQueueMessage(env, { locator: "acme/demo", kind: "skill-repo", via: "backfill" }, { pacer: fastPacer(), messageId: "msg-2" });
  const [w, l] = await Promise.allSettled([winner, loser]);
  assert.equal(w.status, "fulfilled");
  assert.equal(l.status, "rejected");
  assert.equal((l as PromiseRejectedResult).reason?.name, "LeaseConflictError");
  // Exactly one terminal completion was recorded.
  assert.equal(await store.getSyncState("drain:terminal"), "1");
  assert.equal((await store.getSource("skill-repo", "acme/demo"))?.status, "ingested");
});

test("hardendrain: pre-leased candidate throws LeaseConflictError and stays a candidate", async () => {
  const db = makeDb();
  installFetch(compose(serveRepo("acme/demo", { tree: DEMO_TREE, files: DEMO_FILES })));
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "acme/demo" }));
  assert.equal(await store.tryClaimLease("skill-repo", "acme/demo", "sandbox-drain", LEASE_TTL_MINUTES, new Date()), true);
  const { env } = makeEnv(db);
  await assert.rejects(
    handleQueueMessage(env, { locator: "acme/demo", kind: "skill-repo", via: "backfill" }, { pacer: fastPacer(), messageId: "msg-9" }),
    (e: unknown) => (e as Error).name === "LeaseConflictError",
  );
  assert.equal((await store.getSource("skill-repo", "acme/demo"))?.status, "candidate");
});

test("hardendrain: 429 from GitHub records the budget and the consumer throws transient", async () => {
  const db = makeDb();
  const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
  installFetch(compose(serveRepo("acme/rl", {
    headStatus: 429,
    headHeaders: { "retry-after": "120", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpoch) },
  })));
  const store = new D1DiscoveryStore(db);
  await store.upsertSource(sourceRow({ locator: "acme/rl" }));
  // GITHUB_TOKEN set so the worker fetch wrapper (which records
  // the headers) is the one under test.
  const { env } = makeEnv(db, { GITHUB_TOKEN: "test-token" });
  await assert.rejects(
    handleQueueMessage(env, { locator: "acme/rl", kind: "skill-repo", via: "backfill" }, { pacer: fastPacer() }),
    /transient verify failure/,
  );
  assert.equal((await store.getSource("skill-repo", "acme/rl"))?.status, "candidate");
  const until = await store.getSyncState("github_rate_exhausted_until");
  assert.ok(until && Date.parse(until) > Date.now(), `exhausted-until in the future: ${until}`);
  const rate = JSON.parse((await store.getSyncState("github_rate"))!);
  assert.equal(rate.remaining, 0);
});

// ---------------------------------------------------------------------------
// Producer pacing
// ---------------------------------------------------------------------------

test("hardendrain: producer tick is a no-op when the flag is off", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a"]);
  const { env } = makeEnv(db); // no QUEUE_DRAIN_ENABLED
  assert.equal(await runDrainProducerTick(env), null);
  const { env: env0 } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "0" });
  assert.equal(await runDrainProducerTick(env0), null);
});

test("hardendrain: producer tick enqueues one page and counts inflight", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a", "acme/b", "acme/c"], [3, 2, 1]);
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await runDrainProducerTick(env);
  assert.equal(out?.enqueued, 3);
  assert.equal(out?.done, true);
  assert.equal(out?.inflight, 3);
  // Enqueueing does not change source status — the rows are still
  // candidates in D1 until the consumer reaches a terminal state.
  assert.equal(out?.candidates, 3);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((m) => m.locator), ["acme/a", "acme/b", "acme/c"]);
  assert.equal(await store.getSyncState("drain:enqueued"), "3");
});

test("hardendrain: producer tick halts above the inflight threshold", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a"]);
  await store.setSyncState("drain:enqueued", String(INFLIGHT_THRESHOLD + 100));
  await store.setSyncState("drain:terminal", "50");
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await runDrainProducerTick(env);
  assert.equal(out?.skipped, "queue-depth");
  assert.equal(sent.length, 0);
});

test("hardendrain: producer tick halts while the rate budget is exhausted", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a"]);
  await store.setSyncState("github_rate_exhausted_until", new Date(Date.now() + 300_000).toISOString());
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await runDrainProducerTick(env);
  assert.equal(out?.skipped, "rate-budget-exhausted");
  assert.ok(out?.until);
  assert.equal(sent.length, 0);
});

test("hardendrain: producer tick caps the page by the remaining budget minus reserve", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  const locators = Array.from({ length: 20 }, (_, i) => `acme/c${i}`);
  await seedCandidates(store, locators);
  // remaining 600, reserve 500 → 100 calls ÷ 8 worst-case = 12.
  await store.setSyncState("github_rate", JSON.stringify({ remaining: 600, reset: null }));
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await runDrainProducerTick(env);
  assert.equal(out?.enqueued, Math.floor((600 - RATE_BUDGET_RESERVE_CALLS) / 8));
  assert.equal(sent.length, 12);
});

test("hardendrain: producer tick ignores an expired low snapshot (2026-11-15 stall)", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a", "acme/b", "acme/c"]);
  // The exact stall shape: 27 remaining, reset 1h in the past.
  const reset = Math.floor(Date.now() / 1000) - 3600;
  await store.setSyncState("github_rate", JSON.stringify({ remaining: 27, reset }));
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await runDrainProducerTick(env);
  assert.notEqual(out?.skipped, "rate-budget-low");
  assert.equal(out?.enqueued, 3);
  assert.equal(sent.length, 3);
  assert.ok(!(await store.getSyncState("github_rate")), "expired row cleared by the tick");
});

test("hardendrain: producer tick skips actively-leased candidates", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a", "acme/b"], [2, 1]);
  await store.tryClaimLease("skill-repo", "acme/a", "queue:msg-x", LEASE_TTL_MINUTES, new Date());
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await runDrainProducerTick(env);
  assert.equal(out?.enqueued, 1);
  assert.deepEqual(sent.map((m) => m.locator), ["acme/b"]);
});

test("hardendrain: producer single-producer lease blocks a concurrent tick, expires after 15 min", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a"]);
  await store.setSyncState("drain:producer_lease", new Date().toISOString());
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  assert.equal((await runDrainProducerTick(env))?.skipped, "producer-lease-held");
  assert.equal(sent.length, 0);
  // A 20-minute-old lease is stale — the tick proceeds.
  await store.setSyncState("drain:producer_lease", new Date(Date.now() - 20 * 60_000).toISOString());
  const out = await runDrainProducerTick(env);
  assert.equal(out?.enqueued, 1);
  assert.equal(sent.length, 1);
});

test("hardendrain: producer tick reports done when the backlog is empty", async () => {
  const db = makeDb();
  const { env } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await runDrainProducerTick(env);
  assert.equal(out?.enqueued, 0);
  assert.equal(out?.done, true);
});

// ---------------------------------------------------------------------------
// Stall detection (drain health)
// ---------------------------------------------------------------------------

test("hardendrain: drain health flags no-terminal-3h while inflight", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a", "acme/b"]);
  await store.setSyncState("drain:enqueued", "2");
  await store.setSyncState("drain:last_terminal_at", new Date(Date.now() - 4 * 60 * 60_000).toISOString());
  const { env } = makeEnv(db);
  const health = await drainHealth(env);
  assert.equal(health.candidates, 2);
  assert.equal(health.inflight, 2);
  assert.equal(health.terminalAgeMin! > 180, true);
  assert.equal(health.stalled, true);
  assert.ok(health.reasons.includes("no-terminal-3h"));
});

test("hardendrain: drain health flags a non-empty DLQ", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await store.recordDlqEntry({
    kind: "skill-repo", locator: "acme/dlq", failureClass: "network",
    attempts: 4, firstSeen: AT, lastSeen: AT, error: "fetch failed",
  });
  const { env } = makeEnv(db);
  const health = await drainHealth(env);
  assert.equal(health.dlqDepth, 1);
  assert.equal(health.stalled, true);
  assert.ok(health.reasons.includes("dlq-nonempty"));
});

test("hardendrain: drain health flags a starving producer", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a"]);
  const { env } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const health = await drainHealth(env);
  assert.equal(health.inflight, 0);
  assert.equal(health.stalled, true);
  assert.ok(health.reasons.includes("producer-starved"));
});

test("hardendrain: drain health is clean with no backlog", async () => {
  const db = makeDb();
  const { env } = makeEnv(db);
  const health = await drainHealth(env);
  assert.equal(health.candidates, 0);
  assert.equal(health.stalled, false);
  assert.deepEqual(health.reasons, []);
});

// ---------------------------------------------------------------------------
// DLQ sweep
// ---------------------------------------------------------------------------

function dlqEntry(partial: Partial<DlqEntry> & { locator: string }): DlqEntry {
  return {
    kind: "skill-repo", failureClass: "rate-limit", attempts: 4,
    firstSeen: AT, lastSeen: AT, error: "429",
    ...partial,
  };
}

test("hardendrain: DLQ sweep re-enqueues recoverable entries up to the cap", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a", "acme/c", "acme/d"]);
  await store.upsertSource(sourceRow({ locator: "acme/b", status: "ingested" }));
  await store.recordDlqEntry(dlqEntry({ locator: "acme/a", failureClass: "rate-limit", lastSeen: "2026-11-11T03:00:00.000Z" }));
  await store.recordDlqEntry(dlqEntry({ locator: "acme/b", failureClass: "network", lastSeen: "2026-11-11T02:00:00.000Z" }));
  await store.recordDlqEntry(dlqEntry({ locator: "acme/c", failureClass: "deterministic", lastSeen: "2026-11-11T01:00:00.000Z" }));
  await store.recordDlqEntry(dlqEntry({ locator: "acme/d", failureClass: "server", lastSeen: "2026-11-11T00:00:00.000Z" }));
  const { env, sent } = makeEnv(db);
  const out = await sweepDlq(env, { limit: 1 });
  assert.equal(out.dlqDepth, 4);
  assert.deepEqual(out.reenqueued.map((r) => r.locator), ["acme/a"]);
  assert.equal(out.needsReview.length, 2); // acme/b (ingested), acme/c (deterministic)
  assert.deepEqual(out.needsReview.map((r) => r.locator).sort(), ["acme/b", "acme/c"]);
  assert.equal(out.skippedCap, 1); // acme/d, past the cap
  assert.equal(sent.length, 1);
  assert.equal(sent[0].via, "dlq-sweep");
  // Re-enqueued entries leave the manifest; the rest stay.
  const remaining = await store.listDlqEntries();
  assert.deepEqual(remaining.map((e) => e.locator).sort(), ["acme/b", "acme/c", "acme/d"]);
});

test("hardendrain: DLQ sweep re-enqueues everything when under the cap", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a", "acme/b"]);
  await store.tryClaimLease("skill-repo", "acme/a", "queue:msg-old", LEASE_TTL_MINUTES, new Date());
  await store.recordDlqEntry(dlqEntry({ locator: "acme/a", failureClass: "network" }));
  await store.recordDlqEntry(dlqEntry({ locator: "acme/b", failureClass: "unknown" }));
  const { env, sent } = makeEnv(db);
  const out = await sweepDlq(env, { limit: 100 });
  assert.equal(out.reenqueued.length, 2);
  assert.equal(out.needsReview.length, 0);
  assert.equal(out.skippedCap, 0);
  assert.equal(sent.length, 2);
  assert.deepEqual(await store.listDlqEntries(), []);
  // The sweep clears the source's lease so the consumer sees a clean candidate.
  assert.deepEqual(await store.listActiveLeases("1970-01-01T00:00:00.000Z"), []);
});

test("hardendrain: DLQ sweep without a queue binding reviews everything, deletes nothing", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a"]);
  await store.recordDlqEntry(dlqEntry({ locator: "acme/a" }));
  const { env, sent } = makeEnv(db, { INGEST_QUEUE: undefined });
  const out = await sweepDlq(env, { limit: 10 });
  assert.equal(out.reenqueued.length, 0);
  assert.equal(out.needsReview.length, 1);
  assert.equal(sent.length, 0);
  assert.equal((await store.listDlqEntries()).length, 1);
});

// ---------------------------------------------------------------------------
// Admin route — lease-aware paging
// ---------------------------------------------------------------------------

test("hardendrain: admin enqueue skips leased rows across keyset pages", async () => {
  const db = makeDb();
  const store = new D1DiscoveryStore(db);
  await seedCandidates(store, ["acme/a", "acme/b", "acme/c"], [3, 2, 1]);
  await store.tryClaimLease("skill-repo", "acme/b", "queue:msg-x", LEASE_TTL_MINUTES, new Date());
  const { env, sent } = makeEnv(db);
  const page1 = (await handleAdminEnqueueCandidates(env, { limit: 2 })) as { enqueued: number; items: { locator: string }[]; nextCursor: string | null; done: boolean };
  assert.equal(page1.enqueued, 2);
  assert.deepEqual(page1.items.map((i) => i.locator), ["acme/a", "acme/c"]);
  const page2 = (await handleAdminEnqueueCandidates(env, { limit: 2, cursor: page1.nextCursor! })) as { enqueued: number; done: boolean };
  assert.equal(page2.enqueued, 0);
  assert.equal(page2.done, true);
  assert.equal(sent.length, 2);
});

test("hardendrain: producer tick page constant is 100", () => {
  assert.equal(PRODUCER_TICK_PAGE, 100);
  assert.equal(INFLIGHT_THRESHOLD, 500);
});
