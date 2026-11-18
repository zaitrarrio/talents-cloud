// TalentDrainWorkflow — the Workflow orchestrator for the
// Talents backfill drain (gate-queue-workflow). The queue STAYS
// the per-candidate work distributor (verify → ingest, retries,
// DLQ — proven 500/500 in the slice); this Workflow replaces the
// producer cron + flag + watchdog as the backlog feeder. It pages
// candidates from D1, enqueues batches onto the queue, sleeps
// between batches (pacing + GitHub budget awareness), sweeps the
// DLQ, and resumes from its durable checkpoint after any
// interruption. One live instance at a time (single-instance
// guard in the step logic + the admin start route).
//
// This file is a THIN adapter: the WorkflowEntrypoint subclass
// and nothing else. All step logic lives in
// drain-workflow-steps.ts (no "cloudflare:workers" import there)
// so `npm test` can exercise it directly in Node. The instance
// id travels in the params (written by the start route) so the
// init step can verify ownership without depending on the
// WorkflowEvent shape.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
// NOTE: NonRetryableError lives in "cloudflare:workflows", NOT
// "cloudflare:workers" — the deploy failed (10021) until this
// split import was used (docs: workflows/build/sleeping-and-retrying).
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "./db.js";
import {
  DrainWorkflowAbortError,
  finishDrainWorkflowRun,
  initDrainWorkflowRun,
  normalizeDrainWorkflowParams,
  runDrainLoop,
} from "./drain-workflow-steps.js";

// Minimal ambient stand-in for the "cloudflare:workers" module
// (same convention as the DurableObjectNamespace stand-in in
// db.ts): the root `tsc` build has no @cloudflare/workers-types
// and never imports this file, while `vite build` resolves the
// real module. Kept intentionally small — only the surface the
// adapter uses.
declare module "cloudflare:workers" {
  export interface WorkflowEvent<Params> {
    instanceId: string;
    payload: Params;
  }
  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
    sleep(name: string, duration: string | number): Promise<void>;
  }
  export class WorkflowEntrypoint<EnvType, Params> {
    protected env: EnvType;
    run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}

declare module "cloudflare:workflows" {
  export class NonRetryableError extends Error {
    constructor(message?: string, options?: ErrorOptions);
  }
}

export class TalentDrainWorkflow extends WorkflowEntrypoint<Env, Record<string, unknown>> {
  override async run(
    event: WorkflowEvent<Record<string, unknown>>,
    step: WorkflowStep,
  ): Promise<void> {
    const params = normalizeDrainWorkflowParams(event.payload);
    const id = params.instanceId ?? `drain-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    await step.do("init", async () => {
      try {
        return await initDrainWorkflowRun(this.env, id, params);
      } catch (e) {
        // A duplicate instance must die, not retry forever.
        if (e instanceof DrainWorkflowAbortError) throw new NonRetryableError(e.message);
        throw e;
      }
    });
    const outcome = await runDrainLoop(this.env, params, {
      do: <T>(name: string, fn: () => Promise<T>) => step.do(name, fn),
      sleep: (name: string, ms: number) => step.sleep(name, ms),
    });
    await step.do("finish", () => finishDrainWorkflowRun(this.env, id, outcome));
  }
}
