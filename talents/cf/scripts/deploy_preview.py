#!/usr/bin/env python3
"""Preview-deploy the Talents Worker to Cloudflare (talents.maximalize.workers.dev).

Credential pattern (same as shc-manifests/deploy_control_plane.py): the
stored custom.cloudflare credential is fetched via the dynamic-
credentials surrogate and passed to wrangler ONLY as the
CLOUDFLARE_API_TOKEN env var of the subprocess — never printed, never
written to disk.

Steps: create the remote D1 (if the deploy config has no real id yet)
→ write wrangler.deploy.jsonc with the real database_id → apply
migrations remotely → seed the remote DB from the local seed.sql →
build (Vite plugin) → wrangler deploy -c wrangler.deploy.jsonc.
No custom domain is touched: talents.sh stays the user's call.
"""

import json
import os
import re
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

CF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(cmd, env, **kw):
    print("+", " ".join(cmd))
    return subprocess.run(cmd, cwd=CF_DIR, env=env, text=True, capture_output=True, **kw)


def main() -> int:
    entry = dynamic_credential_entry("custom.cloudflare", "access_token")
    # The surrogate (hsurr:…) is what subprocesses receive; the runtime
    # swaps it for the real token on api.cloudflare.com requests. This
    # is exactly the shc-manifests deploy pattern.
    token = entry["surrogate"]
    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": token,
        "CLOUDFLARE_ACCOUNT_ID": "0cd06fd37ee4e07de370821cb3852a8a",
        "WRANGLER_SEND_METRICS": "false",
        "CI": "true",
    }

    deploy_cfg_path = os.path.join(CF_DIR, "wrangler.deploy.jsonc")
    db_id = None
    if os.path.exists(deploy_cfg_path):
        m = re.search(r'"database_id":\s*"([0-9a-f-]{36})"', open(deploy_cfg_path).read())
        if m and not m.group(1).startswith("0000"):
            db_id = m.group(1)

    if not db_id:
        r = run(["npx", "wrangler", "d1", "create", "talents"], env)
        out = r.stdout + r.stderr
        m = re.search(r'"database_id":\s*"([0-9a-f-]{36})"', out) or re.search(
            r"database_id\s*=\s*\"([0-9a-f-]{36})\"", out)
        if not m:
            # Maybe it already exists from an earlier attempt.
            r2 = run(["npx", "wrangler", "d1", "list"], env)
            m2 = re.search(r"│\s*([0-9a-f-]{36})\s*│\s*talents\s*│", r2.stdout)
            if m2:
                m = m2
        if not m:
            print("FAIL: could not create or find remote D1 'talents'")
            print(out[-1500:])
            return 1
        db_id = m.group(1)
        cfg = open(os.path.join(CF_DIR, "wrangler.jsonc")).read()
        cfg = cfg.replace("00000000-0000-0000-0000-000000000000", db_id)
        cfg = cfg.replace('"database_name": "talents-dev"', '"database_name": "talents"')
        open(deploy_cfg_path, "w").write(cfg)
        print(f"remote D1 'talents' id recorded in wrangler.deploy.jsonc")

    steps = [
        ["npx", "wrangler", "d1", "migrations", "apply", "talents", "--remote", "-c", "wrangler.deploy.jsonc"],
        ["npx", "wrangler", "d1", "execute", "talents", "--remote", "--file=seed.sql", "-c", "wrangler.deploy.jsonc"],
        ["npm", "run", "build"],
        ["npx", "wrangler", "deploy", "-c", "wrangler.deploy.jsonc"],
    ]
    for cmd in steps:
        r = run(cmd, env)
        tail = (r.stdout + r.stderr).strip().splitlines()
        for line in tail[-6:]:
            print("   ", line)
        if r.returncode != 0:
            print(f"FAIL: {' '.join(cmd)} exited {r.returncode}")
            return 1
    print("DEPLOY OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
