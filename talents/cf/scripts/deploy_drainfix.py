#!/usr/bin/env python3
"""Deploy the SQLITE_TOOBIG drain fix to production talents.sh.

Incremental deploy ONLY: no migrations (no DDL — the fix is
chunked writes in the store + chunked/isolating flushes in the
wrangler adapter + per-candidate flushes in the drain script).
Build with the Vite plugin, `wrangler deploy` with the deploy
config. It NEVER seeds — production D1 holds the live catalog.
Safe to run while the backfill drain is active (proven repeatedly).

Credential pattern (identical to deploy_lists.py): the stored
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
    print("DEPLOY OK (drain SQLITE_TOOBIG fix; no migrations needed; no seed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
