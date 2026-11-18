#!/usr/bin/env python3
"""Execute SQL against the PRODUCTION talents D1 (surrogate pattern).

Usage: python3 scripts/d1_remote.py --file <sql-file>
       python3 scripts/d1_remote.py --command "<sql>"

The stored custom.cloudflare surrogate is passed to wrangler ONLY
as the CLOUDFLARE_API_TOKEN env var — never printed, never filed.
Used by the creator gate for its insert/unlist/restore fixture cycle
on production; treat any other use with the same care.
"""

import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

CF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] not in ("--file", "--command"):
        print(__doc__)
        return 2
    token = dynamic_credential_entry("custom.cloudflare", "access_token")["surrogate"]
    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": token,
        "CLOUDFLARE_ACCOUNT_ID": "0cd06fd37ee4e07de370821cb3852a8a",
        "WRANGLER_SEND_METRICS": "false",
        "CI": "true",
    }
    flag = "--file" if sys.argv[1] == "--file" else "--command"
    cmd = ["npx", "wrangler", "d1", "execute", "talents", "--remote",
           "-c", "wrangler.deploy.jsonc", flag, sys.argv[2], "--json"]
    r = subprocess.run(cmd, cwd=CF_DIR, env=env, text=True, capture_output=True)
    sys.stdout.write(r.stdout[-6000:])
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-2000:])
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
