// Layer C — LIVE MCP INTROSPECTION (ENRICHMENT.md §C), class:
// derived. For remote MCP servers with a public endpoint we perform
// a READ-ONLY handshake — `initialize`, then `tools/list`, plus
// `resources/list` / `prompts/list` when the server advertises those
// capabilities. We NEVER call a tool. What comes back is the real
// tool inventory, stored with the probe date: it is a point-in-time
// observation, and the UI labels it with that date.
//
// Discipline:
//   - ≤10s total per probe (one abort budget across all requests).
//   - Response bodies capped at 1MB; tool lists capped at 200.
//   - NO auth headers are ever sent. server.json sometimes declares
//     header templates (values are credential placeholders); a
//     server that answers 401/403 is recorded c_state=none with
//     reason "requires auth" — skipped, never forced.
//   - Failures are probe outcomes, never errors against the record.

import type { SkillRecord } from "../types.js";
import type { LayerC, McpToolInfo } from "./types.js";

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_BODY_CAP = 1_000_000;
export const PROBE_TOOL_CAP = 200;

export interface McpHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type McpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<McpHttpResponse>;

export const defaultMcpFetch: McpFetch = (url, init) => fetch(url, init) as Promise<McpHttpResponse>;

/** The public remote endpoint for a record, when one exists:
 *  server.json `remotes` first (the registry-declared endpoint),
 *  then a URL named in the record's own declaration lines. */
export function remoteEndpointOf(record: SkillRecord): string | null {
  const src = record.source as Record<string, unknown> | null;
  if (src && typeof src === "object" && Array.isArray(src.remotes)) {
    for (const r of src.remotes as Record<string, unknown>[]) {
      if (typeof r.url === "string" && /^https?:\/\//.test(r.url)) return r.url;
    }
  }
  for (const line of record.declaration.lines) {
    if (!/remote/i.test(line.text)) continue;
    const m = line.text.match(/\((https?:\/\/[^)\s]+)\)/);
    if (m) return m[1];
  }
  return null;
}

interface JsonRpcResponse {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/** Parse a JSON-RPC response body that may be plain JSON or an SSE
 *  stream (Streamable HTTP servers answer either). Returns the
 *  response whose id matches, else the last result-bearing frame. */
export function parseRpcBody(body: string, contentType: string, id: number): JsonRpcResponse | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (contentType.includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    let matched: JsonRpcResponse | null = null;
    let last: JsonRpcResponse | null = null;
    for (const line of trimmed.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data) as JsonRpcResponse & { id?: number };
        if (j.result || j.error) {
          last = j;
          if (j.id === id) matched = j;
        }
      } catch { /* keep scanning */ }
    }
    return matched ?? last;
  }
  try {
    const j = JSON.parse(trimmed) as JsonRpcResponse & { id?: number };
    if (Array.isArray(j)) {
      const hit = (j as (JsonRpcResponse & { id?: number })[]).find((x) => x.id === id);
      return hit ?? null;
    }
    return j;
  } catch {
    return null;
  }
}

export interface ProbeDeps {
  fetchImpl?: McpFetch;
  timeoutMs?: number;
}

export async function probeMcpServer(
  endpoint: string,
  now: Date,
  deps: ProbeDeps = {},
): Promise<{ state: "done" | "partial" | "none"; payload: LayerC }> {
  const fetchImpl = deps.fetchImpl ?? defaultMcpFetch;
  const payload: LayerC = { probedAt: now.toISOString(), endpoint, tools: [] };
  const fail = (state: "none" | "partial", reason: string) => {
    payload.reason = reason;
    return { state, payload } as const;
  };

  let url: URL;
  try {
    url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
  } catch {
    return fail("none", `not an http(s) endpoint: ${endpoint}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? PROBE_TIMEOUT_MS);
  let sessionId: string | null = null;
  let rpcId = 0;

  const rpc = async (method: string, params?: Record<string, unknown>): Promise<
    { ok: true; result: Record<string, unknown> } | { ok: false; status: number; message: string }
  > => {
    const id = ++rpcId;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "talents-registry-probe",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    let res: McpHttpResponse;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
        signal: controller.signal,
      });
    } catch (e) {
      return { ok: false, status: 0, message: `request failed: ${(e as Error).name === "AbortError" ? "timeout" : (e as Error).message}` };
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, message: "requires auth" };
    }
    let body = "";
    try {
      body = await res.text();
    } catch (e) {
      return { ok: false, status: res.status, message: `body read failed: ${(e as Error).message}` };
    }
    if (body.length > PROBE_BODY_CAP) {
      return { ok: false, status: res.status, message: `response too large (${body.length} bytes)` };
    }
    if (res.status >= 400) {
      return { ok: false, status: res.status, message: `HTTP ${res.status}` };
    }
    const parsed = parseRpcBody(body, res.headers.get("content-type") ?? "", id);
    if (!parsed) return { ok: false, status: res.status, message: "unparseable response (not JSON-RPC)" };
    if (parsed.error) {
      return { ok: false, status: res.status, message: `rpc error ${parsed.error.code ?? ""}: ${parsed.error.message ?? "unknown"}`.trim() };
    }
    if (!parsed.result) return { ok: false, status: res.status, message: "empty result" };
    return { ok: true, result: parsed.result };
  };

  const notify = async (method: string): Promise<void> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "talents-registry-probe",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    try {
      await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method }),
        signal: controller.signal,
      });
    } catch { /* notifications are fire-and-forget */ }
  };

  try {
    const init = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "talents-registry-probe", version: "1.0.0" },
    });
    if (!init.ok) {
      if (init.message === "requires auth") return fail("none", "requires auth");
      return fail("none", `unreachable or not an MCP endpoint: ${init.message}`);
    }
    const result = init.result;
    if (typeof result.protocolVersion === "string") payload.protocolVersion = result.protocolVersion;
    const serverInfo = result.serverInfo as { name?: string; version?: string } | undefined;
    if (serverInfo) payload.serverInfo = { name: serverInfo.name, version: serverInfo.version };
    const capabilities = (result.capabilities ?? {}) as Record<string, unknown>;

    if (sessionId) await notify("notifications/initialized");

    const errors: string[] = [];
    const toolsRes = await rpc("tools/list", {});
    if (!toolsRes.ok) {
      errors.push(`tools/list: ${toolsRes.message}`);
    } else {
      const tools = Array.isArray(toolsRes.result.tools) ? (toolsRes.result.tools as Record<string, unknown>[]) : [];
      payload.tools = tools.slice(0, PROBE_TOOL_CAP).map((t): McpToolInfo => ({
        name: String(t.name ?? ""),
        description: String(t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      })).filter((t) => t.name);
    }

    if (capabilities.resources) {
      const resRes = await rpc("resources/list", {});
      if (resRes.ok) {
        const resources = Array.isArray(resRes.result.resources) ? resRes.result.resources : [];
        payload.resourceCount = resources.length;
      } else errors.push(`resources/list: ${resRes.message}`);
    }
    if (capabilities.prompts) {
      const prRes = await rpc("prompts/list", {});
      if (prRes.ok) {
        const prompts = Array.isArray(prRes.result.prompts) ? (prRes.result.prompts as Record<string, unknown>[]) : [];
        payload.promptCount = prompts.length;
        payload.promptNames = prompts.slice(0, 50).map((p) => String(p.name ?? "")).filter(Boolean);
      } else errors.push(`prompts/list: ${prRes.message}`);
    }

    if (errors.length) payload.errors = errors;
    if (!toolsRes.ok) return { state: "partial", payload };
    return { state: errors.length ? "partial" : "done", payload };
  } finally {
    clearTimeout(timer);
  }
}
