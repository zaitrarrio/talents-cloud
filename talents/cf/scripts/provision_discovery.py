#!/usr/bin/env python3
"""Provision the P5 discovery resources on Cloudflare: the ingest
Queue (talents-ingest) and the Vectorize index (talents-skills,
768-dim cosine for @cf/baai/bge-base-en-v1.5).

Credential pattern identical to deploy_preview.py: the stored
custom.cloudflare surrogate goes to wrangler ONLY as the
CLOUDFLARE_API_TOKEN subprocess env var — never printed or filed.
Idempotent: "already exists" is success.
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
    return r


def main() -> int:
    token = dynamic_credential_entry("custom.cloudflare", "access_token")["surrogate"]
    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": token,
        "CLOUDFLARE_ACCOUNT_ID": "0cd06fd37ee4e07de370821cb3852a8a",
        "WRANGLER_SEND_METRICS": "false",
        "CI": "true",
    }
    ok = True
    r = run(["npx", "wrangler", "queues", "create", "talents-ingest"], env)
    if r.returncode != 0 and "already exists" not in (r.stdout + r.stderr):
        ok = False
    r = run(["npx", "wrangler", "vectorize", "create", "talents-skills",
             "--dimensions=768", "--metric=cosine"], env)
    if r.returncode != 0 and "already exists" not in (r.stdout + r.stderr):
        ok = False
    run(["npx", "wrangler", "queues", "list"], env)
    run(["npx", "wrangler", "vectorize", "list"], env)
    print("PROVISION OK" if ok else "PROVISION FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
