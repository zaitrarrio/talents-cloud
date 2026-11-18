#!/usr/bin/env python3
"""Run one Phase 2 scout against the PRODUCTION D1:
`talents discover <scout> --remote` with the stored Cloudflare
credential in the subprocess environment only (same surrogate
pattern as discover_remote.py — never printed, never filed).

Usage: python3 scripts/scouts_remote.py <codesearch|mcp|npm|skillssh|web|x> [flags...]
  e.g. python3 scripts/scouts_remote.py mcp --cap 25 --max-ingest 5
       python3 scripts/scouts_remote.py x --posts data/x-posts.json

GitHub code search auth: if GITHUB_TOKEN is present in this
process's environment it is passed through to the child (env only);
otherwise the child falls back to the ghapi connector helper.
"""

import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

CF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(CF_DIR)

SCOUTS = {"codesearch", "mcp", "npm", "skillssh", "web", "x"}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in SCOUTS:
        print(f"usage: scouts_remote.py <{'|'.join(sorted(SCOUTS))}> [flags...]", file=sys.stderr)
        return 2
    token = dynamic_credential_entry("custom.cloudflare", "access_token")["surrogate"]
    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": token,
        "CLOUDFLARE_ACCOUNT_ID": "0cd06fd37ee4e07de370821cb3852a8a",
        "WRANGLER_SEND_METRICS": "false",
        "CI": "true",
    }
    args = ["node", os.path.join(ROOT, "dist", "src", "cli.js"), "discover", sys.argv[1], "--remote", *sys.argv[2:]]
    print("+", " ".join(args))
    r = subprocess.run(args, cwd=ROOT, env=env, text=True)
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
