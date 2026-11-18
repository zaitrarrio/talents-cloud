#!/usr/bin/env python3
"""Launcher for the discovery BACKFILL scripts (scripts/backfill-*.mjs):
runs one node script against the PRODUCTION D1 with the stored
Cloudflare credential in the subprocess environment only (same
surrogate pattern as scouts_remote.py — never printed, never filed).

Usage: python3 scripts/backfill_remote.py <script.mjs> [args...]
  e.g. python3 scripts/backfill_remote.py backfill-counts.mjs
"""

import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

CF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(CF_DIR)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: backfill_remote.py <script.mjs> [args...]", file=sys.stderr)
        return 2
    token = dynamic_credential_entry("custom.cloudflare", "access_token")["surrogate"]
    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": token,
        "CLOUDFLARE_ACCOUNT_ID": "0cd06fd37ee4e07de370821cb3852a8a",
        "WRANGLER_SEND_METRICS": "false",
        "CI": "true",
    }
    script = os.path.join(ROOT, "scripts", sys.argv[1])
    args = ["node", script, *sys.argv[2:]]
    print("+", " ".join(args), flush=True)
    r = subprocess.run(args, cwd=ROOT, env=env, text=True)
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
