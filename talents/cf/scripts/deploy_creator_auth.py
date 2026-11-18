#!/usr/bin/env python3
"""Deploy the Talents creator-auth swap to production.

Ships: @clerk/backend verifyToken as the primary session verifier
in cf/src/auth.ts (hand-rolled RS256/JWKS verifier kept as the
fallback), CLERK_PUBLISHABLE_KEY as a [vars] entry in
wrangler.deploy.jsonc, and the swap's test coverage. CLERK_SECRET_KEY
was set ahead of the deploy (`wrangler secret put CLERK_SECRET_KEY`
via cf/scripts/set_clerk_secret.py); this deploy sets no secrets.
No migrations (no DDL). It NEVER seeds — production D1 holds the
live catalog. Safe to run while the sandbox backfill drain and the
queue drain are active (auth is orthogonal to ingest).

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
