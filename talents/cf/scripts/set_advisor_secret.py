#!/usr/bin/env python3
"""Set the ANTHROPIC_API_KEY Worker secret for the Talents advisor.

Credential pattern (same as deploy_preview.py): both credentials are
fetched via the dynamic-credentials surrogate and used ONLY inside
subprocess env/stdin — never printed, never written to disk.

  - custom.cloudflare  → CLOUDFLARE_API_TOKEN env for wrangler auth.
  - custom.anthropic   → the surrogate value itself is piped to
    `wrangler secret put` over stdin, so the Worker secret literally
    holds the surrogate string. Whether Anthropic accepts it at
    runtime is exactly what the advisor gate checks
    (scripts/gate-advisor.mjs): the sandbox egress layer swaps
    hsurr:* values for the real key on requests IT originates, but a
    deployed Worker's outbound calls do not pass through that layer —
    so a 401 from the live /advisor means the stored credential cannot
    be read back as a runtime key and the user must supply the key once
    via secure entry (the known wrinkle from muse-clone/containerd).
"""

import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry, DynamicCredentialError  # noqa: E402

CF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACCOUNT_ID = "0cd06fd37ee4e07de370821cb3852a8a"


def anthropic_surrogate() -> tuple[str, str]:
    """Return (entry_name, surrogate) for the first entry that resolves.
    Only the entry NAME is ever reported — never the value."""
    last_err: Exception | None = None
    for entry_name in ("access_token", "api_key", "api-key", "key"):
        try:
            entry = dynamic_credential_entry("custom.anthropic", entry_name)
            return entry_name, str(entry["surrogate"])
        except DynamicCredentialError as e:
            last_err = e
    raise SystemExit(f"FAIL: no anthropic credential entry resolved ({last_err})")


def main() -> int:
    cf_token = dynamic_credential_entry("custom.cloudflare", "access_token")["surrogate"]
    entry_name, api_key = anthropic_surrogate()
    print(f"anthropic credential entry resolved: custom.anthropic:{entry_name} (value not shown)")

    env = {
        **os.environ,
        "CLOUDFLARE_API_TOKEN": cf_token,
        "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID,
        "WRANGLER_SEND_METRICS": "false",
        "CI": "true",
    }
    r = subprocess.run(
        ["npx", "wrangler", "secret", "put", "ANTHROPIC_API_KEY", "-c", "wrangler.deploy.jsonc"],
        cwd=CF_DIR, env=env, input=api_key, text=True, capture_output=True,
    )
    tail = (r.stdout + r.stderr).strip().splitlines()
    for line in tail[-4:]:
        print("   ", line)
    if r.returncode != 0:
        print(f"FAIL: wrangler secret put exited {r.returncode}")
        return 1
    print("SECRET SET (ANTHROPIC_API_KEY)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
