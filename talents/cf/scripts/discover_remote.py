#!/usr/bin/env python3
"""Run one discovery cycle against the PRODUCTION D1:
`talents discover --remote` with the stored Cloudflare credential in
the subprocess environment only (same surrogate pattern as
deploy_preview.py — never printed, never filed).

Usage: python3 scripts/discover_remote.py [--limit N] [--per-query N]
       [--max-ingest N] [extra discover flags...]
"""

import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

CF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(CF_DIR)


def main() -> int:
    token = dynamic_credential_entry("custom.cloudflare", "access_token")["surrogate"]
    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": token,
        "CLOUDFLARE_ACCOUNT_ID": "0cd06fd37ee4e07de370821cb3852a8a",
        "WRANGLER_SEND_METRICS": "false",
        "CI": "true",
    }
    args = ["node", os.path.join(ROOT, "dist", "src", "cli.js"), "discover", "--remote", *sys.argv[1:]]
    print("+", " ".join(args))
    r = subprocess.run(args, cwd=ROOT, env=env, text=True)
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
