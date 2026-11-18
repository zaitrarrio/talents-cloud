#!/usr/bin/env python3
"""Deploy the drain/queue hardening to production.

Ships (additive-only over the queue-drain + D1-size Workers):
  - migration 0007_harden_drain.sql (APPLIED FIRST, before the
    deploy): processing-lease columns on sources (claimed_at /
    claimed_by, nullable) + the dlq_entries manifest table. The
    consumer's lease claim and the DLQ manifest both require it;
    the migration is additive and idempotent (CREATE TABLE IF NOT
    EXISTS / CREATE INDEX IF NOT EXISTS; ALTER TABLE ADD COLUMN
    on a table that has never carried those columns).
  - the dedicated producer tick (own */10 * * * * cron, dispatched
    in index.ts scheduled(); gated by QUEUE_DRAIN_ENABLED, which
    this deploy does NOT set — the flag stays off until cutover),
  - POST /admin/dlq-sweep + GET /admin/drain-health (both
    ADMIN_TOKEN-gated, 404 when the secret is unset),
  - GitHub rate-limit backpressure (exhausted-until recording in
    the Worker fetch wrapper; producer halt + consumer throw),
  - the processing lease in the candidate consumer (claim before
    verify/ingest, clear on terminal outcomes; LeaseConflictError
    → queue retry), the DLQ manifest write on the queue
    handler's final attempt, and the daily cron's DLQ-depth log,
  - consumer retry_delay 60s (wrangler.deploy.jsonc).

It NEVER seeds — production D1 holds the live catalog. The
consumer's verify/ingest behavior is unchanged (the lease claim
and rate check sit before the existing code path; the slice is
verified complete, and the sandbox drain keeps running in
parallel — ingest/upsert paths are idempotent, proven
repeatedly). Safe to run while the sandbox drain is active.

Credential pattern (identical to deploy_queuedrain.py): the stored
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
        # Migration FIRST: the new bundle reads dlq_entries and the
        # lease columns on its first candidate message.
        ["npx", "wrangler", "d1", "migrations", "apply", "talents", "--remote", "-c", "wrangler.deploy.jsonc"],
        ["npx", "wrangler", "deploy", "-c", "wrangler.deploy.jsonc"],
    ]
    for cmd in steps:
        rc = run(cmd, env)
        if rc != 0:
            print(f"FAIL: {' '.join(cmd)} exited {rc}")
            return 1
    print("DEPLOY OK (drain hardening; QUEUE_DRAIN_ENABLED left unset/off; migration 0007 applied; no seed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
