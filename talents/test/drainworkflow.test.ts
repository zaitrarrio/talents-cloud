// Queue + Workflow drain (2026-11-11, gate-queue-workflow) —
// the TalentDrainWorkflow orchestrator's step logic: batch
// pacing, rate-budget halts, completion tracking, the DLQ sweep
// trigger, the single-instance guard, and the run loop. The
// Workflow runtime itself is not exercised here: the loop takes
// a minimal step interface {do, sleep} and the tests pass a fake
// that executes immediately and records step names (a replay
// returns the stored step result, so immediate execution is the
// faithful model for step logic). The adapter
// (cf/src/drain-workflow.ts) is a thin WorkflowEntrypoint shell
// over these functions. Same harness as hardendrain.test.ts:
// the REAL D1DiscoveryStore over a real SQLite database built
// from the production migrations (0001–0004 + 0007).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import type { RegistryKey } from "../src/attest.js";
import type { D1Like, D1StatementLike } from "../src/search-d1.js";
import {
  D1DiscoveryStore, LEASE_TTL_MINUTES, type SourceRow,
} from "../src/discovery/store.js";
import {
  DRAIN_WORKFLOW_ACTIVE_KEY, DRAIN_WORKFLOW_LIVE_KEY,
  DrainWorkflowAbortError, DrainWorkflowDisabledError,
  DrainWorkflowLiveError, DrainWorkflowNoBindingError,
  drainWorkflowBatch, drainWorkflowCheck, drainWorkflowSleepMs,
  drainWorkflowStatus, finishDrainWorkflowRun, getLiveDrainWorkflow,
  initDrainWorkflowRun, normalizeDrainWorkflowParams, runDrainLoop,
  startDrainWorkflow, type DrainWorkflowStep,
} from "../cf/src/drain-workflow-steps.js";
import {
  bumpDrainCounter, drainWorkflowActive, runDrainProducerTick,
  runQueueDrainProducerStep, type IngestQueueMessage,
} from "../cf/src/discovery.js";
import type { Env } from "../cf/src/db.js";

// ---------------------------------------------------------------------------
// Fixtures (mirrors hardendrain.test.ts)
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

function makeStore(): { db: D1Like; store: D1DiscoveryStore } {
  const db = makeDb();
  return { db, store: new D1DiscoveryStore(db) };
}

async function seedCandidates(store: D1DiscoveryStore, locators: string[], priorities?: number[]): Promise<void> {
  for (let i = 0; i < locators.length; i++) {
    await store.upsertSource(sourceRow({ locator: locators[i], priority: priorities?.[i] ?? 0 }));
  }
}

function fakeStep(): { step: DrainWorkflowStep; names: string[]; sleeps: number[] } {
  const names: string[] = [];
  const sleeps: number[] = [];
  const step: DrainWorkflowStep = {
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      names.push(name);
      return fn();
    },
    async sleep(name: string, ms: number): Promise<void> {
      names.push(name);
      sleeps.push(ms);
    },
  };
  return { step, names, sleeps };
}

function fakeBinding(
  statusById: Record<string, string> = {},
  created: { id: string; params?: unknown }[] = [],
): unknown {
  return {
    create: async (opts: { id: string; params?: unknown }) => {
      created.push(opts);
      return { status: async () => ({ status: statusById[opts.id] ?? "queued" }) };
    },
    // NOTE (cutover fix, 2026-11-11): the real binding's get() is
    // ASYNC (Promise<WorkflowInstance>). A sync fake here masked
    // the missing await in getLiveDrainWorkflow, which made live
    // detection always report stale in production.
    get: async (id: string) => ({ status: async () => ({ status: statusById[id] ?? "unknown" }) }),
  };
}

const PARAMS = { batchSize: 100, sleepMinutes: 10, maxBatches: 300 };

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

test("drainworkflow: normalize clamps to the documented ranges, defaults otherwise", () => {
  const d = normalizeDrainWorkflowParams(undefined);
  assert.equal(d.batchSize, 100);
  assert.equal(d.sleepMinutes, 10);
  assert.equal(d.maxBatches, 300);
  assert.equal(d.instanceId, undefined);
  const clamped = normalizeDrainWorkflowParams({ batchSize: 0, sleepMinutes: 999, maxBatches: -5 });
  assert.equal(clamped.batchSize, 1);
  assert.equal(clamped.sleepMinutes, 60);
  assert.equal(clamped.maxBatches, 1);
  const capped = normalizeDrainWorkflowParams({ batchSize: 9999, sleepMinutes: 0, maxBatches: 99999, instanceId: "drain-x" });
  assert.equal(capped.batchSize, 500);
  assert.equal(capped.sleepMinutes, 1);
  assert.equal(capped.maxBatches, 2000);
  assert.equal(capped.instanceId, "drain-x");
});

// ---------------------------------------------------------------------------
// Batch step: pacing + budget
// ---------------------------------------------------------------------------

test("drainworkflow: batch with the flag off enqueues nothing", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/one", "acme/two"]);
  const { env, sent } = makeEnv(db);
  const out = await drainWorkflowBatch(env, null, PARAMS);
  assert.equal(out.skipped, "flag-off");
  assert.equal(out.enqueued, 0);
  assert.equal(sent.length, 0);
});

test("drainworkflow: batch without a queue binding reports no-queue", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/one"]);
  const { env, sent } = makeEnv(db, { INGEST_QUEUE: undefined, QUEUE_DRAIN_ENABLED: "1" });
  const out = await drainWorkflowBatch(env, null, PARAMS);
  assert.equal(out.skipped, "no-queue");
  assert.equal(out.enqueued, 0);
  assert.equal(sent.length, 0);
});

test("drainworkflow: batch halts while the rate budget is exhausted", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/one"]);
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  await store.setSyncState("github_rate_exhausted_until", until);
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await drainWorkflowBatch(env, null, PARAMS);
  assert.equal(out.skipped, "rate-budget-exhausted");
  assert.equal(out.until, until);
  assert.equal(out.enqueued, 0);
  assert.equal(sent.length, 0);
});

test("drainworkflow: batch caps the page by (remaining − reserve) / 8", async () => {
  const { db, store } = makeStore();
  const locators = Array.from({ length: 20 }, (_, i) => `acme/c${i}`);
  await seedCandidates(store, locators);
  await store.setSyncState("github_rate", JSON.stringify({ remaining: 600 }));
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await drainWorkflowBatch(env, null, PARAMS);
  // (600 − 500 reserve) / 8 worst-case calls = 12 candidates.
  assert.equal(out.enqueued, 12);
  assert.equal(sent.length, 12);
  assert.equal(out.done, false);
});

test("drainworkflow: batch ignores an expired low snapshot (2026-11-15 stall)", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/one", "acme/two"]);
  // The exact stall shape: 27 remaining, reset 1h in the past.
  const reset = Math.floor(Date.now() / 1000) - 3600;
  await store.setSyncState("github_rate", JSON.stringify({ remaining: 27, reset }));
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await drainWorkflowBatch(env, null, PARAMS);
  assert.notEqual(out.skipped, "rate-budget-low");
  assert.equal(out.enqueued, 2);
  assert.equal(sent.length, 2);
  assert.ok(!(await store.getSyncState("github_rate")), "expired row cleared by the batch");
});

test("drainworkflow: batch stops when the queue is at the inflight threshold", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/one"]);
  await bumpDrainCounter(store, "drain:enqueued", 500);
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await drainWorkflowBatch(env, null, PARAMS);
  assert.equal(out.skipped, "queue-depth");
  assert.equal(out.inflight, 500);
  assert.equal(sent.length, 0);
});

test("drainworkflow: batch pages in priority order without duplicates and reports done", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/low", "acme/high", "acme/mid"], [10, 30, 20]);
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const first = await drainWorkflowBatch(env, null, { batchSize: 2 });
  assert.equal(first.enqueued, 2);
  assert.equal(first.done, false);
  assert.ok(first.nextCursor, "a cursor continues the page");
  assert.deepEqual(sent.map((m) => m.locator), ["acme/high", "acme/mid"]);
  assert.ok(sent.every((m) => m.via === "backfill-workflow"));
  const second = await drainWorkflowBatch(env, first.nextCursor, { batchSize: 2 });
  assert.equal(second.enqueued, 1);
  assert.equal(second.done, true);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(sent.map((m) => m.locator).sort(), ["acme/high", "acme/low", "acme/mid"]);
});

test("drainworkflow: batch skips rows another transport has leased", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/leased", "acme/free"], [30, 10]);
  assert.equal(
    await store.tryClaimLease("skill-repo", "acme/leased", "sandbox", LEASE_TTL_MINUTES, new Date()),
    true,
  );
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await drainWorkflowBatch(env, null, { batchSize: 2 });
  assert.equal(out.enqueued, 1);
  assert.deepEqual(sent.map((m) => m.locator), ["acme/free"]);
});

// ---------------------------------------------------------------------------
// Sleep math (pure)
// ---------------------------------------------------------------------------

test("drainworkflow: sleep math — rate hold until its target (capped 1h), interval otherwise", () => {
  const now = new Date("2026-11-11T12:00:00.000Z");
  const until30 = new Date(now.getTime() + 30 * 60_000).toISOString();
  assert.equal(
    drainWorkflowSleepMs({ skipped: "rate-budget-exhausted", until: until30, enqueued: 0, done: false, nextCursor: null, inflight: 0, candidates: 1, dlqDepth: 0 }, 10, now),
    30 * 60_000,
  );
  const until3h = new Date(now.getTime() + 3 * 60 * 60_000).toISOString();
  assert.equal(
    drainWorkflowSleepMs({ skipped: "rate-budget-exhausted", until: until3h, enqueued: 0, done: false, nextCursor: null, inflight: 0, candidates: 1, dlqDepth: 0 }, 10, now),
    60 * 60_000,
  );
  const normal = { enqueued: 100, done: false, nextCursor: null, inflight: 100, candidates: 900, dlqDepth: 0 };
  assert.equal(drainWorkflowSleepMs(normal, 10, now), 10 * 60_000);
  assert.equal(drainWorkflowSleepMs({ ...normal, skipped: "queue-depth" }, 10, now), 10 * 60_000);
});

// ---------------------------------------------------------------------------
// Check step: completion tracking + DLQ sweep trigger
// ---------------------------------------------------------------------------

test("drainworkflow: check is done only when no candidates remain AND nothing is inflight", async () => {
  const { db, store } = makeStore();
  const { env } = makeEnv(db);
  // Empty backlog: done immediately.
  let out = await drainWorkflowCheck(env);
  assert.equal(out.done, true);
  assert.equal(out.swept, 0);
  // Candidates remain: not done.
  await seedCandidates(store, ["acme/one"]);
  out = await drainWorkflowCheck(env);
  assert.equal(out.done, false);
  assert.equal(out.candidates, 1);
  // Candidates gone but messages inflight: still not done.
  await store.upsertSource(sourceRow({ locator: "acme/one", status: "ingested" }));
  await bumpDrainCounter(store, "drain:enqueued", 2);
  out = await drainWorkflowCheck(env);
  assert.equal(out.done, false);
  assert.equal(out.inflight, 2);
});

test("drainworkflow: check sweeps a recoverable DLQ entry and reports it", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/dlq"]);
  await store.recordDlqEntry({
    kind: "skill-repo", locator: "acme/dlq", failureClass: "network",
    attempts: 4, firstSeen: AT, lastSeen: AT, error: "fetch failed",
  });
  const { env, sent } = makeEnv(db);
  const out = await drainWorkflowCheck(env);
  assert.equal(out.swept, 1);
  assert.equal(out.dlqDepth, 0);
  assert.equal(out.done, false); // the swept candidate is still a candidate
  assert.equal(sent.length, 1);
  assert.equal(sent[0].locator, "acme/dlq");
  assert.equal(sent[0].via, "dlq-sweep");
  assert.deepEqual(await store.listDlqEntries(), []);
});

// ---------------------------------------------------------------------------
// Run loop (fake step)
// ---------------------------------------------------------------------------

test("drainworkflow: loop on an empty backlog finishes after one batch + one check", async () => {
  const { db, store } = makeStore();
  const { env } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const { step, names, sleeps } = fakeStep();
  const out = await runDrainLoop(env, PARAMS, step);
  assert.equal(out.reason, "done");
  assert.equal(out.batches, 1);
  assert.equal(out.enqueued, 0);
  assert.equal(out.checks, 1);
  assert.deepEqual(names, ["batch-0", "drain-check-0"]);
  assert.deepEqual(sleeps, []);
});

test("drainworkflow: loop stops immediately when the flag goes off", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/one"]);
  const { env } = makeEnv(db); // flag off
  const { step, names } = fakeStep();
  const out = await runDrainLoop(env, PARAMS, step);
  assert.equal(out.reason, "flag-off");
  assert.equal(out.batches, 1);
  assert.equal(out.enqueued, 0);
  assert.deepEqual(names, ["batch-0"]);
});

test("drainworkflow: loop stops immediately when the queue binding is missing", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/one"]);
  const { env } = makeEnv(db, { INGEST_QUEUE: undefined, QUEUE_DRAIN_ENABLED: "1" });
  const { step, names } = fakeStep();
  const out = await runDrainLoop(env, PARAMS, step);
  assert.equal(out.reason, "no-queue");
  assert.equal(out.batches, 1);
  assert.deepEqual(names, ["batch-0"]);
});

test("drainworkflow: loop hits the batch cap with deterministic step names", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/a", "acme/b", "acme/c", "acme/d", "acme/e"]);
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const { step, names, sleeps } = fakeStep();
  const out = await runDrainLoop(env, { batchSize: 1, sleepMinutes: 10, maxBatches: 2 }, step);
  assert.equal(out.reason, "max-batches");
  assert.equal(out.batches, 2);
  assert.equal(out.enqueued, 2);
  assert.equal(sent.length, 2);
  assert.deepEqual(names, ["batch-0", "pace-0", "batch-1", "pace-1"]);
  assert.deepEqual(sleeps, [10 * 60_000, 10 * 60_000]);
});

test("drainworkflow: loop waits out the drain-check cap when inflight never drains", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/a", "acme/b"]);
  const { env } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const { step, names } = fakeStep();
  const out = await runDrainLoop(env, { batchSize: 2, sleepMinutes: 10, maxBatches: 300 }, step, { maxDrainChecks: 2 });
  assert.equal(out.reason, "check-limit");
  // A full page never proves done (listCandidatePage returns a
  // cursor whenever rows.length === limit), so the loop runs one
  // empty confirmation batch before entering the drain phase.
  assert.equal(out.batches, 2);
  assert.equal(out.enqueued, 2);
  assert.equal(out.checks, 2);
  // No sleep after the final check.
  assert.deepEqual(names, ["batch-0", "pace-0", "batch-1", "drain-check-0", "drain-wait-0", "drain-check-1"]);
});

// ---------------------------------------------------------------------------
// Single-instance guard: start / status / init / finish
// ---------------------------------------------------------------------------

test("drainworkflow: start refuses when the flag is off", async () => {
  const { env } = makeEnv(makeDb(), { DRAIN_WORKFLOW: fakeBinding() });
  await assert.rejects(startDrainWorkflow(env, {}), (e: unknown) => e instanceof DrainWorkflowDisabledError);
});

test("drainworkflow: start refuses when the binding is missing", async () => {
  const { env } = makeEnv(makeDb(), { QUEUE_DRAIN_ENABLED: "1" });
  await assert.rejects(startDrainWorkflow(env, {}), (e: unknown) => e instanceof DrainWorkflowNoBindingError);
});

test("drainworkflow: start refuses while another instance is live", async () => {
  const { db, store } = makeStore();
  await store.setSyncState(DRAIN_WORKFLOW_LIVE_KEY, JSON.stringify({
    id: "drain-live-1", startedAt: AT, batchSize: 100, sleepMinutes: 10,
    maxBatches: 300, cursor: null, enqueued: 0, batches: 0,
  }));
  const { env } = makeEnv(db, {
    QUEUE_DRAIN_ENABLED: "1",
    DRAIN_WORKFLOW: fakeBinding({ "drain-live-1": "running" }),
  });
  await assert.rejects(startDrainWorkflow(env, {}), (e: unknown) => {
    assert.ok(e instanceof DrainWorkflowLiveError);
    assert.equal((e as DrainWorkflowLiveError).id, "drain-live-1");
    return true;
  });
});

test("drainworkflow: start succeeds over a stale marker and writes the live claim", async () => {
  const { db, store } = makeStore();
  await store.setSyncState(DRAIN_WORKFLOW_LIVE_KEY, JSON.stringify({
    id: "drain-old-1", startedAt: AT, batchSize: 100, sleepMinutes: 10,
    maxBatches: 300, cursor: null, enqueued: 0, batches: 0,
  }));
  const created: { id: string; params?: unknown }[] = [];
  const { env } = makeEnv(db, {
    QUEUE_DRAIN_ENABLED: "1",
    DRAIN_WORKFLOW: fakeBinding({ "drain-old-1": "complete" }, created),
  });
  const out = await startDrainWorkflow(env, { batchSize: 50 }, {
    id: "drain-test-1",
    now: new Date("2026-11-11T12:00:00.000Z"),
  });
  assert.equal(out.id, "drain-test-1");
  assert.equal(out.status, "created");
  assert.equal(created.length, 1);
  assert.equal(created[0].id, "drain-test-1");
  assert.equal((created[0].params as { instanceId: string }).instanceId, "drain-test-1");
  assert.equal((created[0].params as { batchSize: number }).batchSize, 50);
  const marker = JSON.parse((await store.getSyncState(DRAIN_WORKFLOW_LIVE_KEY))!);
  assert.equal(marker.id, "drain-test-1");
  assert.equal(marker.batchSize, 50);
  assert.equal(await store.getSyncState(DRAIN_WORKFLOW_ACTIVE_KEY), "2026-11-11T12:00:00.000Z");
});

test("drainworkflow: status reports no live instance and the binding state", async () => {
  const { env } = makeEnv(makeDb());
  const out = await drainWorkflowStatus(env);
  assert.equal(out.live, null);
  assert.equal(out.bindingMissing, true);
  assert.equal(out.lastRun, null);
  assert.equal(typeof out.health.candidates, "number");
  const withBinding = makeEnv(makeDb(), { DRAIN_WORKFLOW: fakeBinding() });
  const out2 = await drainWorkflowStatus(withBinding.env);
  assert.equal(out2.bindingMissing, false);
});

test("drainworkflow: status reports the live instance when the binding says running", async () => {
  const { db, store } = makeStore();
  await store.setSyncState(DRAIN_WORKFLOW_LIVE_KEY, JSON.stringify({
    id: "drain-live-2", startedAt: AT, batchSize: 100, sleepMinutes: 10,
    maxBatches: 300, cursor: null, enqueued: 0, batches: 0,
  }));
  const { env } = makeEnv(db, { DRAIN_WORKFLOW: fakeBinding({ "drain-live-2": "running" }) });
  const out = await drainWorkflowStatus(env);
  assert.equal(out.live?.id, "drain-live-2");
  assert.equal(out.live?.status, "running");
  const live = await getLiveDrainWorkflow(env);
  assert.equal(live.live, true);
});

test("drainworkflow: init aborts a duplicate instance, finish clears the claim and writes last_run", async () => {
  const { db, store } = makeStore();
  await store.setSyncState(DRAIN_WORKFLOW_LIVE_KEY, JSON.stringify({
    id: "drain-live-3", startedAt: AT, batchSize: 100, sleepMinutes: 10,
    maxBatches: 300, cursor: null, enqueued: 0, batches: 0,
  }));
  const { env } = makeEnv(db, { DRAIN_WORKFLOW: fakeBinding({ "drain-live-3": "running" }) });
  // A different instance starting under the live marker must die.
  await assert.rejects(
    initDrainWorkflowRun(env, "drain-other", PARAMS),
    (e: unknown) => e instanceof DrainWorkflowAbortError,
  );
  // The owning instance re-verifies and (re)writes its claim.
  const init = await initDrainWorkflowRun(env, "drain-live-3", PARAMS);
  assert.equal(init.id, "drain-live-3");
  assert.ok(await store.getSyncState(DRAIN_WORKFLOW_ACTIVE_KEY));
  // Finish clears the claim + active flag and records the summary.
  await finishDrainWorkflowRun(env, "drain-live-3", { reason: "done", batches: 2, enqueued: 10, checks: 1 });
  assert.equal(await store.getSyncState(DRAIN_WORKFLOW_LIVE_KEY), "");
  assert.equal(await store.getSyncState(DRAIN_WORKFLOW_ACTIVE_KEY), "");
  const lastRun = JSON.parse((await store.getSyncState("drain:workflow:last_run"))!);
  assert.equal(lastRun.reason, "done");
  assert.equal(lastRun.batches, 2);
  assert.equal(lastRun.enqueued, 10);
});

// ---------------------------------------------------------------------------
// Producer deconfliction: the cron tick stands down while a
// Workflow instance is live.
// ---------------------------------------------------------------------------

test("drainworkflow: producer tick stands down while a workflow instance is live", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/a", "acme/b"]);
  await store.setSyncState(DRAIN_WORKFLOW_ACTIVE_KEY, new Date().toISOString());
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await runDrainProducerTick(env);
  assert.equal(out?.skipped, "workflow-active");
  assert.equal(sent.length, 0);
  assert.equal(await drainWorkflowActive(store), true);
});

test("drainworkflow: producer tick resumes once the workflow marker is stale", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/a", "acme/b"]);
  await store.setSyncState(DRAIN_WORKFLOW_ACTIVE_KEY, new Date(Date.now() - 25 * 60 * 60_000).toISOString());
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  assert.equal(await drainWorkflowActive(store), false);
  const out = await runDrainProducerTick(env);
  assert.equal(out?.skipped, undefined);
  assert.equal(out?.enqueued, 2);
  assert.equal(sent.length, 2);
});

test("drainworkflow: daily trickle step stands down while a workflow instance is live", async () => {
  const { db, store } = makeStore();
  await seedCandidates(store, ["acme/a"]);
  await store.setSyncState(DRAIN_WORKFLOW_ACTIVE_KEY, new Date().toISOString());
  const { env, sent } = makeEnv(db, { QUEUE_DRAIN_ENABLED: "1" });
  const out = await runQueueDrainProducerStep(env);
  assert.equal(out, null);
  assert.equal(sent.length, 0);
});
