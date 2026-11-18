#!/usr/bin/env python3
"""Deploy the queue + Workflow drain orchestrator to production.

Ships (additive-only over the drain-hardening Worker):
  - TalentDrainWorkflow (cf/src/drain-workflow.ts, step logic in
    cf/src/drain-workflow-steps.ts): the Workflow orchestrator that
    replaces the producer cron + flag + watchdog as the backlog
    feeder — pages candidates from D1 in verification-priority
    order, enqueues bounded batches onto talents-ingest, sleeps
    between batches (pacing + GitHub budget awareness, the same
    math as the producer tick), sweeps the DLQ, and tracks
    completion via drain-health state. Single-instance guarded.
  - POST /admin/drain-workflow/start + GET
    /admin/drain-workflow/status (both ADMIN_TOKEN-gated; start is
    flag-gated by QUEUE_DRAIN_ENABLED and refuses while one is
    live). The `talent-drain` workflow binding in
    wrangler.deploy.jsonc.
  - The cron producer tick + daily trickle stand down while a
    Workflow instance is live (drainWorkflowActive in
    discovery.ts) — the single-producer invariant.

NO migration: all Workflow state lives in the existing sync_state
table (drain:workflow:live / :active / :last_run), so there is no
migration step in this deploy.

It NEVER starts a live Workflow instance, NEVER sets
QUEUE_DRAIN_ENABLED, NEVER stops the sandbox drain, and NEVER
removes the watchdog cron — cutover is a separate, operator-run
step (data/gate-queue-workflow.txt). The queue consumer's
verify/ingest body is untouched; the producer tick's behavior is
unchanged while no Workflow instance is live. Safe to run while
the sandbox drain is active.

Credential pattern (identical to deploy_hardendrain.py): the stored
custom.cloudflare surrogate is passed to wrangler ONLY as the
CLOUDFLARE_API_TOKEN env var of the subprocess — never printed,
never written to disk.
"""

import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

CF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(cmd, env):
    print("+", " ".join(cmd))
    r = subprocess.run(cmd, cwd=CF_DIR, env=env, text=True, capture_output=True)
    tail = (r.stdout + r.stderr).strip().splitlines()
    for line in tail[-8:]:
        print("   ", line)
    return r.returncode


def main() -> int:
    token = dynamic_credential_entry("custom.cloudflare")["surrogate"]
    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": token,
        "CLOUDFLARE_ACCOUNT_ID": "0cd06fd37ee4e07de370821cb3852a8a",
        "WRANGLER_SEND_METRICS": "false",
        "CI": "true",
    }
    steps = [
        ["npm", "run", "build"],
        ["npx", "wrangler", "deploy", "-c", "wrangler.deploy.jsonc"],
    ]
    for cmd in steps:
        rc = run(cmd, env)
        if rc != 0:
            print(f"FAIL: {' '.join(cmd)} exited {rc}")
            return 1
    print("DEPLOY OK (queue + Workflow drain; no live instance started; QUEUE_DRAIN_ENABLED untouched; no migration)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
