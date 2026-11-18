#!/usr/bin/env python3
"""Set the P5 discovery Worker secrets: ADMIN_TOKEN (generated here)
and TALENTS_REGISTRY_KEY (the registry attestation key from
../../data/registry-key.json, so Worker-side ingest signs with the
SAME key as the CLI).

Values travel only via subprocess stdin — never printed, never
written anywhere except: the generated admin token is also written
to /tmp/talents-admin-token (mode 0600) so the discovery gate can
call the /admin/* routes; delete that file after gating. Rotate the
admin token by re-running this script (it overwrites the secret).
"""

import json
import os
import secrets
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

CF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_FILE = os.path.join(CF_DIR, "..", "data", "registry-key.json")
TOKEN_SINK = "/tmp/talents-admin-token"


def put(env, name, value):
    r = subprocess.run(
        ["npx", "wrangler", "secret", "put", name, "-c", "wrangler.deploy.jsonc"],
        cwd=CF_DIR, env=env, input=value, text=True, capture_output=True,
    )
    ok = r.returncode == 0
    print(f"{'OK ' if ok else 'FAIL'} secret put {name} (exit {r.returncode})")
    return ok


def main() -> int:
    token = dynamic_credential_entry("custom.cloudflare", "access_token")["surrogate"]
    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": token,
        "CLOUDFLARE_ACCOUNT_ID": "0cd06fd37ee4e07de370821cb3852a8a",
        "WRANGLER_SEND_METRICS": "false",
        "CI": "true",
    }
    admin_token = secrets.token_hex(24)
    with open(TOKEN_SINK, "w") as f:
        f.write(admin_token)
    os.chmod(TOKEN_SINK, 0o600)
    registry_key = open(KEY_FILE).read().strip()
    json.loads(registry_key)  # sanity: must be valid JSON, value not printed
    ok = put(env, "ADMIN_TOKEN", admin_token)
    ok = put(env, "TALENTS_REGISTRY_KEY", registry_key) and ok
    print("SECRETS SET" if ok else "SECRETS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
