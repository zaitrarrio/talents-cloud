// Queue + Workflow drain orchestrator — the STEP LOGIC (gate-queue-workflow).
//
// Design (ARCHITECTURE-v2 §7): the queue STAYS the per-candidate work
// distributor (candidate-mode consumer: verify → ingest, retries, DLQ —
// proven 500/500 in the slice). This module is the Workflow side: a
// durable orchestrator that replaces the producer cron + flag + watchdog
// as the backlog feeder. It pages candidates from D1, enqueues batches
// onto the queue, sleeps between batches (pacing + GitHub budget
// awareness — the same math as the hardening build's producer tick),
// sweeps the DLQ, and tracks completion via drain-health state.
//
// This file holds ONLY the testable logic. It never imports
// "cloudflare:workers" — the WorkflowEntrypoint subclass lives in
// cf/src/drain-workflow.ts (thin adapter) so `npm test` (plain Node)
// can import this file directly. Every function here takes `env: Env`
// and reuses the existing exported pieces (drainHealth, sweepDlq,
// enqueueCandidatePage, checkRateBudget) — no forked pacing logic.
//
// State (all in D1 sync_state — no KV dependency):
//   drain:workflow:live     — JSON {id, startedAt, batchSize,
//     sleepMinutes, maxBatches, cursor, enqueued, batches}: the
//     single-instance guard + durable progress checkpoint. Written
//     by the admin start route, re-verified by the instance's init
//     step, cleared by its finish step.
//   drain:workflow:active   — ISO timestamp of the live instance's
//     start. The cron producer tick stands down while it is fresh
//     (< 24h) so the Workflow is the only feeder (see
//     runDrainProducerTick / runQueueDrainProducerStep in
//     discovery.ts); stale after 24h so a crashed instance never
//     blocks the tick forever.
//   drain:workflow:last_run — JSON summary written by the finish step.
//
// Replay rules (Cloudflare Workflows replays run() from the top on
// resume): every branching decision reads a STEP RESULT (never a
// fresh D1 read outside a step), and every step name is built from
// the loop counter — never Date.now() — so a replay returns the
// stored result instead of re-executing. Step results are ≤1 MiB
// by construction (small JSON summaries, never record lists).

import {
  decodeCandidateCursor, drainHealth, enqueueCandidatePage,
  queueDrainEnabled, readGithubRateSnapshot, sweepDlq,
  INFLIGHT_THRESHOLD, PRODUCER_TICK_PAGE, RATE_BUDGET_RESERVE_CALLS,
  type DrainHealth,
} from "./discovery.js";
import type { Env } from "./db.js";
import {
  D1DiscoveryStore, LEASE_TTL_MINUTES, type DiscoveryStore,
} from "../../src/discovery/store.js";

/** Workflow name in wrangler config (binding DRAIN_WORKFLOW). */
export const DRAIN_WORKFLOW_NAME = "talent-drain";
/** Single-instance guard + progress checkpoint (sync_state). */
export const DRAIN_WORKFLOW_LIVE_KEY = "drain:workflow:live";
/** Fresh-start timestamp the cron producer tick stands down on. */
export const DRAIN_WORKFLOW_ACTIVE_KEY = "drain:workflow:active";
/** Last completed run's summary (sync_state). */
export const DRAIN_WORKFLOW_LAST_RUN_KEY = "drain:workflow:last_run";

/** One batch per Workflow cycle (== the producer tick page). */
export const DRAIN_WORKFLOW_BATCH_SIZE = PRODUCER_TICK_PAGE;
/** Pace between batches (== the producer tick cadence). */
export const DRAIN_WORKFLOW_SLEEP_MINUTES = 10;
/** Batch cap per instance: 300 × 100 = 30k candidates — the
 *  current ~20k backlog with headroom. An instance that hits the
 *  cap finishes with reason "max-batches"; the operator re-starts
 *  (the cursor persists in the live marker). */
export const DRAIN_WORKFLOW_MAX_BATCHES = 300;
/** Drain-phase check cap: 144 × 10 min ≈ 24h of waiting for
 *  inflight messages to complete. */
export const DRAIN_WORKFLOW_MAX_DRAIN_CHECKS = 144;
/** The producer tick treats the active marker as stale after this
 *  long, so a crashed instance never blocks the tick forever. */
export const DRAIN_WORKFLOW_ACTIVE_STALE_MINUTES = 24 * 60;
/** One sleep never exceeds this (a rate-limit hold longer than
 *  an hour just sleeps again next cycle). */
export const DRAIN_WORKFLOW_MAX_SLEEP_MINUTES = 60;

/** Instance statuses the start guard treats as live (the
 *  Cloudflare Workflow instance lifecycle). Everything else
 *  (complete, errored, terminated, unknown) is a stale marker. */
export const DRAIN_WORKFLOW_LIVE_STATUSES = new Set([
  "queued", "running", "waiting", "paused", "waitingForPause",
]);

export interface DrainWorkflowParams {
  /** Candidates per batch (1–500, default 100). */
  batchSize?: number;
  /** Pace between batches in minutes (1–60, default 10). */
  sleepMinutes?: number;
  /** Batch cap per instance (1–2000, default 300). */
  maxBatches?: number;
  /** Instance id (set by the start route; the adapter falls back
   *  to a generated id when absent). */
  instanceId?: string;
}

export function normalizeDrainWorkflowParams(raw: unknown): Required<Omit<DrainWorkflowParams, "instanceId">> & { instanceId?: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt;
    return Math.min(Math.max(n, lo), hi);
  };
  return {
    batchSize: clamp(o.batchSize, 1, 500, DRAIN_WORKFLOW_BATCH_SIZE),
    sleepMinutes: clamp(o.sleepMinutes, 1, 60, DRAIN_WORKFLOW_SLEEP_MINUTES),
    maxBatches: clamp(o.maxBatches, 1, 2000, DRAIN_WORKFLOW_MAX_BATCHES),
    ...(typeof o.instanceId === "string" && o.instanceId ? { instanceId: o.instanceId } : {}),
  };
}

export interface DrainWorkflowLive {
  id: string;
  startedAt: string;
  batchSize: number;
  sleepMinutes: number;
  maxBatches: number;
  /** Encoded keyset cursor (encodeCandidateCursor) — a plain
   *  string, so the marker stays JSON-safe and step results stay
   *  small. Null = start from the head of the priority order. */
  cursor: string | null;
  enqueued: number;
  batches: number;
}

export class DrainWorkflowDisabledError extends Error {
  constructor() {
    super("drain workflow disabled: QUEUE_DRAIN_ENABLED is not on");
    this.name = "DrainWorkflowDisabledError";
  }
}

export class DrainWorkflowNoBindingError extends Error {
  constructor() {
    super("DRAIN_WORKFLOW binding not configured on this Worker");
    this.name = "DrainWorkflowNoBindingError";
  }
}

export class DrainWorkflowLiveError extends Error {
  readonly id: string;
  readonly status: string;
  constructor(id: string, status: string) {
    super(`a drain workflow is already live: ${id} (${status})`);
    this.name = "DrainWorkflowLiveError";
    this.id = id;
    this.status = status;
  }
}

/** Thrown by the init step when another live instance owns the
 *  marker. The adapter converts it to NonRetryableError — a
 *  duplicate instance must die, not retry forever. */
export class DrainWorkflowAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrainWorkflowAbortError";
  }
}

function storeOf(env: Env): DiscoveryStore {
  return new D1DiscoveryStore(env.DB);
}

/** Read the live marker and verify it against the Workflow
 *  binding. A marker naming an instance the binding reports as
 *  queued/running/waiting/paused is live; anything else (complete,
 *  errored, terminated, unknown, get() throwing, unparseable
 *  marker, missing binding) is stale — the marker is a claim, the
 *  binding is the truth. */
export async function getLiveDrainWorkflow(env: Env): Promise<
  | { live: true; id: string; status: string; startedAt: string }
  | { live: false; stale: boolean; status?: string; bindingMissing?: boolean }
> {
  const store = storeOf(env);
  const raw = await store.getSyncState(DRAIN_WORKFLOW_LIVE_KEY);
  if (!raw) return { live: false, stale: false };
  let marker: DrainWorkflowLive;
  try {
    marker = JSON.parse(raw) as DrainWorkflowLive;
  } catch {
    return { live: false, stale: true };
  }
  if (!marker || typeof marker.id !== "string") return { live: false, stale: true };
  if (!env.DRAIN_WORKFLOW) return { live: false, stale: true, bindingMissing: true };
  let status: string;
  try {
    // NOTE (cutover fix, 2026-11-11): get() is ASYNC on the real
    // binding (docs: get(id): Promise<WorkflowInstance>). The
    // pre-fix code called it without await, so `inst` was a
    // Promise, `inst.status()` threw, and getLiveDrainWorkflow
    // always reported stale — the status route showed live:null
    // for a running instance and the single-instance guard was
    // blind. The test fake below is async for the same reason.
    const inst = await env.DRAIN_WORKFLOW.get(marker.id);
    status = (await inst.status()).status;
  } catch {
    return { live: false, stale: true };
  }
  if (DRAIN_WORKFLOW_LIVE_STATUSES.has(status)) {
    return { live: true, id: marker.id, status, startedAt: marker.startedAt };
  }
  return { live: false, stale: true, status };
}

/** Start one drain Workflow instance (admin route). Flag-gated
 *  the same way QUEUE_DRAIN_ENABLED gates the producer tick, and
 *  single-instance guarded: a live instance refuses with
 *  DrainWorkflowLiveError. The live marker is written AFTER the
 *  create() call, so a failed create leaves no claim behind; a
 *  concurrent start that slips past the guard is killed by the
 *  instance's init step (DrainWorkflowAbortError). */
export async function startDrainWorkflow(
  env: Env,
  rawParams: unknown,
  opts?: { now?: Date; id?: string },
): Promise<{ id: string; status: string; startedAt: string }> {
  if (!queueDrainEnabled(env)) throw new DrainWorkflowDisabledError();
  if (!env.DRAIN_WORKFLOW) throw new DrainWorkflowNoBindingError();
  const existing = await getLiveDrainWorkflow(env);
  if (existing.live) throw new DrainWorkflowLiveError(existing.id, existing.status);
  const params = normalizeDrainWorkflowParams(rawParams);
  const id = opts?.id ?? params.instanceId ?? `drain-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const startedAt = (opts?.now ?? new Date()).toISOString();
  await env.DRAIN_WORKFLOW.create({ id, params: { ...params, instanceId: id } });
  const store = storeOf(env);
  const marker: DrainWorkflowLive = {
    id, startedAt, batchSize: params.batchSize, sleepMinutes: params.sleepMinutes,
    maxBatches: params.maxBatches, cursor: null, enqueued: 0, batches: 0,
  };
  await store.setSyncState(DRAIN_WORKFLOW_LIVE_KEY, JSON.stringify(marker));
  await store.setSyncState(DRAIN_WORKFLOW_ACTIVE_KEY, startedAt);
  return { id, status: "created", startedAt };
}

/** Status for the admin route: the live instance (if any), the
 *  last run's summary, and the drain-health snapshot. Never
 *  throws for a missing binding or a stale marker. */
export async function drainWorkflowStatus(env: Env): Promise<{
  live: { id: string; status: string; startedAt: string } | null;
  bindingMissing: boolean;
  lastRun: unknown;
  health: DrainHealth;
}> {
  const store = storeOf(env);
  const live = await getLiveDrainWorkflow(env);
  let lastRun: unknown = null;
  try {
    const raw = await store.getSyncState(DRAIN_WORKFLOW_LAST_RUN_KEY);
    lastRun = raw ? JSON.parse(raw) : null;
  } catch {
    lastRun = null;
  }
  return {
    live: live.live ? { id: live.id, status: live.status, startedAt: live.startedAt } : null,
    bindingMissing: !env.DRAIN_WORKFLOW,
    lastRun,
    health: await drainHealth(env),
  };
}

// ---------------------------------------------------------------------------
// Batch step: one paced page of candidates onto the queue.
// ---------------------------------------------------------------------------

export interface DrainWorkflowBatchOutcome {
  /** Why no page was enqueued (absent = a page went out). */
  skipped?: "flag-off" | "no-queue" | "rate-budget-exhausted" | "rate-budget-low" | "queue-depth";
  enqueued: number;
  /** True when the page came back empty because no candidates
   *  remain (the loop moves to the drain phase). */
  done: boolean;
  /** Encoded keyset cursor for the next page (null = finished). */
  nextCursor: string | null;
  inflight: number;
  candidates: number;
  dlqDepth: number;
  /** Rate-budget hold target (rate-budget-exhausted only). */
  until?: string;
  /** Remaining GitHub calls snapshot (rate paths only). */
  remaining?: number | null;
}

/** Enqueue ONE bounded page, paced exactly like the producer tick
 *  (hardening gate): flag → rate budget → queue depth → page cap
 *  by (remaining − reserve) / 8 worst-case calls. The lease
 *  cutoff skips rows another transport is already processing.
 *  Updates the live marker's progress (best-effort, observability
 *  only — the step result is the durable checkpoint). */
export async function drainWorkflowBatch(
  env: Env,
  cursor: string | null,
  params: { batchSize: number },
): Promise<DrainWorkflowBatchOutcome> {
  const store = storeOf(env);
  const now = new Date();
  const base = { enqueued: 0, done: false, nextCursor: cursor, inflight: 0, candidates: 0, dlqDepth: 0 };
  if (!queueDrainEnabled(env)) return { ...base, skipped: "flag-off" };
  if (!env.INGEST_QUEUE) return { ...base, skipped: "no-queue" };
  const exhaustedUntil = await store.getSyncState("github_rate_exhausted_until");
  if (exhaustedUntil && Date.parse(exhaustedUntil) > now.getTime()) {
    return { ...base, skipped: "rate-budget-exhausted", until: exhaustedUntil };
  }
  // Expired snapshots read as unknown (see readGithubRateSnapshot).
  const { remaining } = await readGithubRateSnapshot(store, now);
  if (remaining !== null && remaining < RATE_BUDGET_RESERVE_CALLS) {
    return { ...base, skipped: "rate-budget-low", remaining };
  }
  const health = await drainHealth(env);
  if (health.candidates === 0) {
    return {
      enqueued: 0, done: true, nextCursor: null,
      inflight: health.inflight, candidates: 0, dlqDepth: health.dlqDepth,
    };
  }
  const headroom = INFLIGHT_THRESHOLD - health.inflight;
  if (headroom <= 0) {
    return {
      ...base, skipped: "queue-depth",
      inflight: health.inflight, candidates: health.candidates, dlqDepth: health.dlqDepth,
    };
  }
  let page = Math.min(params.batchSize, headroom);
  if (remaining !== null) {
    page = Math.min(page, Math.max(0, Math.floor((remaining - RATE_BUDGET_RESERVE_CALLS) / 8)));
  }
  if (page <= 0) {
    return {
      ...base, skipped: "rate-budget-low", remaining,
      inflight: health.inflight, candidates: health.candidates, dlqDepth: health.dlqDepth,
    };
  }
  const leaseCutoff = new Date(now.getTime() - LEASE_TTL_MINUTES * 60_000).toISOString();
  const out = await enqueueCandidatePage(store, env.INGEST_QUEUE, {
    limit: page, cursor: decodeCandidateCursor(cursor), via: "backfill-workflow", leaseCutoff,
  });
  const after = await drainHealth(env);
  // Progress in the live marker (best-effort — the step result
  // is the checkpoint; a failed marker write never fails the batch).
  try {
    const raw = await store.getSyncState(DRAIN_WORKFLOW_LIVE_KEY);
    if (raw) {
      const marker = JSON.parse(raw) as DrainWorkflowLive;
      marker.cursor = out.nextCursor;
      marker.enqueued += out.enqueued;
      marker.batches += 1;
      await store.setSyncState(DRAIN_WORKFLOW_LIVE_KEY, JSON.stringify(marker));
    }
  } catch { /* best-effort */ }
  return {
    enqueued: out.enqueued, done: out.done, nextCursor: out.nextCursor,
    inflight: after.inflight, candidates: after.candidates, dlqDepth: after.dlqDepth,
  };
}

/** Sleep after a batch: a rate-budget hold sleeps until its
 *  target (capped at one hour per sleep — the loop re-checks);
 *  every other outcome sleeps the batch interval. Pure function
 *  of the batch outcome, so the loop's pacing is unit-testable. */
export function drainWorkflowSleepMs(
  outcome: DrainWorkflowBatchOutcome,
  sleepMinutes: number,
  now: Date = new Date(),
): number {
  const intervalMs = Math.max(1, sleepMinutes) * 60_000;
  if (outcome.skipped === "rate-budget-exhausted" && outcome.until) {
    const untilMs = Date.parse(outcome.until) - now.getTime();
    if (Number.isFinite(untilMs) && untilMs > 0) {
      return Math.min(untilMs, DRAIN_WORKFLOW_MAX_SLEEP_MINUTES * 60_000);
    }
  }
  return intervalMs;
}

// ---------------------------------------------------------------------------
// Check step: is the backlog done, and is the DLQ clean?
// ---------------------------------------------------------------------------

export interface DrainWorkflowCheckOutcome {
  done: boolean;
  candidates: number;
  inflight: number;
  dlqDepth: number;
  /** Recoverable DLQ entries re-enqueued by this check. */
  swept: number;
  stalled: boolean;
  reasons: string[];
}

/** One completion check: read drain health; when the DLQ is
 *  non-empty, sweep the recoverable entries first (they re-enter
 *  the queue, so inflight rises again and done stays false until
 *  they complete). Done only when no candidates remain AND
 *  nothing is inflight. */
export async function drainWorkflowCheck(env: Env): Promise<DrainWorkflowCheckOutcome> {
  let health = await drainHealth(env);
  let swept = 0;
  if (health.dlqDepth > 0) {
    const sweep = await sweepDlq(env, { limit: 25 });
    swept = sweep.reenqueued.length;
    health = await drainHealth(env);
  }
  return {
    done: health.candidates === 0 && health.inflight === 0,
    candidates: health.candidates,
    inflight: health.inflight,
    dlqDepth: health.dlqDepth,
    swept,
    stalled: health.stalled,
    reasons: health.reasons,
  };
}

// ---------------------------------------------------------------------------
// Init / finish steps (run inside the Workflow instance).
// ---------------------------------------------------------------------------

/** Init step: verify this instance owns the live marker — a
 *  concurrent start that slipped past the admin guard is aborted
 *  here (the adapter converts the abort to NonRetryableError).
 *  Re-writes the marker + active flag (idempotent: the start
 *  route already wrote them). */
export async function initDrainWorkflowRun(
  env: Env,
  instanceId: string,
  params: { batchSize: number; sleepMinutes: number; maxBatches: number },
): Promise<{ id: string; startedAt: string }> {
  const live = await getLiveDrainWorkflow(env);
  if (live.live && live.id !== instanceId) {
    throw new DrainWorkflowAbortError(
      `another drain workflow is live: ${live.id} (${live.status})`,
    );
  }
  const startedAt = new Date().toISOString();
  const store = storeOf(env);
  const marker: DrainWorkflowLive = {
    id: instanceId, startedAt, batchSize: params.batchSize,
    sleepMinutes: params.sleepMinutes, maxBatches: params.maxBatches,
    cursor: null, enqueued: 0, batches: 0,
  };
  await store.setSyncState(DRAIN_WORKFLOW_LIVE_KEY, JSON.stringify(marker));
  await store.setSyncState(DRAIN_WORKFLOW_ACTIVE_KEY, startedAt);
  return { id: instanceId, startedAt };
}

/** Finish step: clear the live marker (only when it still names
 *  this instance) + the active flag, and record the run summary
 *  for the status route. Idempotent — a retried finish rewrites
 *  the same values. */
export async function finishDrainWorkflowRun(
  env: Env,
  instanceId: string,
  outcome: DrainWorkflowRunOutcome,
): Promise<void> {
  const store = storeOf(env);
  const finishedAt = new Date().toISOString();
  try {
    const raw = await store.getSyncState(DRAIN_WORKFLOW_LIVE_KEY);
    if (raw) {
      const marker = JSON.parse(raw) as DrainWorkflowLive;
      if (marker.id === instanceId) {
        await store.setSyncState(DRAIN_WORKFLOW_LIVE_KEY, "");
      }
    }
  } catch { /* a stale marker is cleared by the next start guard */ }
  await store.setSyncState(DRAIN_WORKFLOW_ACTIVE_KEY, "");
  await store.setSyncState(
    DRAIN_WORKFLOW_LAST_RUN_KEY,
    JSON.stringify({ id: instanceId, finishedAt, ...outcome }),
  );
}

// ---------------------------------------------------------------------------
// The run loop (drives the Workflow adapter; testable with a fake
// step implementation — see test/drainworkflow.test.ts).
// ---------------------------------------------------------------------------

/** Minimal step surface the loop needs (a subset of the real
 *  WorkflowStep: do/sleep only). */
export interface DrainWorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, durationMs: number): Promise<void>;
}

export interface DrainWorkflowRunOutcome {
  reason: "done" | "flag-off" | "max-batches" | "check-limit" | "no-queue";
  batches: number;
  enqueued: number;
  checks: number;
}

/** Enqueue phase then drain phase. Step names come from the loop
 *  counters only, so a replay returns the stored result instead
 *  of re-executing; every branch reads a step result. The loop
 *  ends when the backlog is enqueued AND the queue has drained
 *  (done), when the flag goes off, when the batch cap is hit, or
 *  when the drain phase waits out its check cap — all four are
 *  terminal reasons the finish step records. */
export async function runDrainLoop(
  env: Env,
  params: { batchSize: number; sleepMinutes: number; maxBatches: number },
  step: DrainWorkflowStep,
  opts?: { maxDrainChecks?: number },
): Promise<DrainWorkflowRunOutcome> {
  const maxDrainChecks = opts?.maxDrainChecks ?? DRAIN_WORKFLOW_MAX_DRAIN_CHECKS;
  const sleepMs = Math.max(1, params.sleepMinutes) * 60_000;
  let cursor: string | null = null;
  let batches = 0;
  let enqueued = 0;
  for (let i = 0; i < params.maxBatches; i++) {
    const batch = await step.do(`batch-${i}`, () => drainWorkflowBatch(env, cursor, params));
    cursor = batch.nextCursor;
    batches += 1;
    enqueued += batch.enqueued;
    if (batch.skipped === "flag-off") {
      return { reason: "flag-off", batches, enqueued, checks: 0 };
    }
    if (batch.skipped === "no-queue") {
      return { reason: "no-queue", batches, enqueued, checks: 0 };
    }
    if (!batch.done) {
      await step.sleep(`pace-${i}`, drainWorkflowSleepMs(batch, params.sleepMinutes));
      continue;
    }
    // No more candidates to enqueue — wait for the inflight
    // queue to drain, sweeping the DLQ as it goes.
    for (let j = 0; j < maxDrainChecks; j++) {
      const check = await step.do(`drain-check-${j}`, () => drainWorkflowCheck(env));
      if (check.done) {
        return { reason: "done", batches, enqueued, checks: j + 1 };
      }
      // No sleep after the final check — the loop returns
      // "check-limit" immediately instead of waiting one more
      // interval for nothing.
      if (j + 1 < maxDrainChecks) {
        await step.sleep(`drain-wait-${j}`, sleepMs);
      }
    }
    return { reason: "check-limit", batches, enqueued, checks: maxDrainChecks };
  }
  return { reason: "max-batches", batches, enqueued, checks: 0 };
}
