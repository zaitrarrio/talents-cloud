#!/usr/bin/env python3
"""Deploy the Talents D1 50 MB response-limit fix to production.

Ships: bounded reads everywhere the Worker loaded the whole catalog
(allRecords deleted; trending by id, search vector block by id,
bounded suggest pool, paged marketplace aggregate, paged cron embed
sweep, aggregate home header), the trendingRows snake->camel
mapping fix (velocity path was dead), and the d1size regression
tests. No secrets set by this deploy. No migrations (no DDL). It
NEVER seeds — production D1 holds the live catalog. Safe to run
while the sandbox backfill drain and the queue drain are active
(read paths are orthogonal to ingest).

Credential pattern (identical to deploy_creator_auth.py): the stored
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
    token = dynamic_credential_entry("custom.cloudflare", "access_token")["surrogate"]
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
    print("DEPLOY OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
