#!/usr/bin/env python3
"""Set the GITHUB_TOKEN Worker secret for the Talents queue drain.

Credential pattern (same as set_advisor_secret.py): the Cloudflare
token is fetched via the dynamic-credentials surrogate and used ONLY
inside subprocess env — never printed, never written to disk. The
GitHub token itself is read from THIS script's stdin (supplied by the
operator from the user's own paste) and piped to `wrangler secret put`
over stdin — never printed, never written to disk.
"""

import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

CF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACCOUNT_ID = "0cd06fd37ee4e07de370821cb3852a8a"


def main() -> int:
    token = sys.stdin.read().strip()
    if not token:
        print("FAIL: no token on stdin")
        return 1
    if not (token.startswith("ghp_") or token.startswith("github_pat_")):
        print("FAIL: token does not look like a GitHub PAT (ghp_ / github_pat_)")
        return 1

    cf_token = dynamic_credential_entry("custom.cloudflare", "access_token")["surrogate"]

    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": cf_token,
        "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID,
        "WRANGLER_SEND_METRICS": "false",
        "CI": "true",
    }
    r = subprocess.run(
        ["npx", "wrangler", "secret", "put", "GITHUB_TOKEN", "-c", "wrangler.deploy.jsonc"],
        cwd=CF_DIR, env=env, input=token, text=True, capture_output=True,
    )
    tail = (r.stdout + r.stderr).strip().splitlines()
    for line in tail[-4:]:
        print("   ", line)
    if r.returncode != 0:
        print(f"FAIL: wrangler secret put exited {r.returncode}")
        return 1
    print("SECRET SET (GITHUB_TOKEN)")

    r = subprocess.run(
        ["npx", "wrangler", "secret", "list", "-c", "wrangler.deploy.jsonc"],
        cwd=CF_DIR, env=env, capture_output=True, text=True,
    )
    names = [line.strip() for line in (r.stdout + r.stderr).splitlines()]
    print("GITHUB_TOKEN present in secret list:", any("GITHUB_TOKEN" in n for n in names))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
