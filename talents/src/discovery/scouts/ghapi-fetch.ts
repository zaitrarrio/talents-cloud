// ghapi-backed fetch for the sandbox (operator tooling, not the
// Worker): the custom.github-api connector helper performs
// authenticated GitHub requests itself — the credential lives in
// the connector's secure storage and is swapped in by the platform
// on the way out. This adapter lets CLI scout runs use that access
// for api.github.com GETs WITHOUT any token entering this process:
// no env var, no argument beyond the request path, nothing logged.
// When GITHUB_TOKEN is set, or the URL is not api.github.com, the
// wrapped fetch is used unchanged (the production path).

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FetchFn } from "../../types.js";

const GHAPI = process.env.TALENTS_GHAPI_PATH
  ?? join(homedir(), "workspace/custom-connectors/custom.github-api/bin/ghapi");

function execGhapi(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(GHAPI, ["api-get", path], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(stderr?.toString().trim() || err.message) as Error & { status?: number };
        const m = (stderr?.toString() ?? "").match(/\b([45]\d\d)\b/);
        e.status = m ? Number(m[1]) : 0;
        reject(e);
      } else resolve(stdout);
    });
  });
}

export function ghapiBackedFetch(fallback: FetchFn): FetchFn {
  return async (url, init) => {
    if (!url.startsWith("https://api.github.com/") || process.env.GITHUB_TOKEN) {
      return fallback(url, init);
    }
    const u = new URL(url);
    try {
      const stdout = await execGhapi(u.pathname + u.search);
      let payload: unknown = null;
      try { payload = JSON.parse(stdout); } catch { /* keep null */ }
      return {
        ok: true,
        status: 200,
        text: async () => stdout,
        json: async () => payload,
      };
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 0;
      const message = (e as Error).message;
      return {
        ok: false,
        status,
        text: async () => message,
        json: async () => ({ message }),
      };
    }
  };
}
