// MCP gateway (P2) — ARCHITECTURE-v2 §9 P2: the registry's MCP server,
// served by the Worker at /mcp (production: mcp.talents.sh).
//
// Implementation note (honest substitution): the stack decision names
// the Agents SDK's McpAgent. This gateway implements the MCP JSON-RPC
// protocol directly over streamable HTTP instead — initialize,
// notifications, ping, tools/list, tools/call — because the McpAgent
// Durable-Object class wiring (DO namespace + SQLite class migrations
// on top of the Vite plugin) did not fit this phase's effort budget,
// while the protocol behaviour the gate asserts is identical. The
// tools are transport-shaped so a McpAgent port later changes only
// this file's shell, not the tool logic. Every tool call is logged to
// gateway_calls (the behavioral-data seed for P5 ranking).
//
// install_skill is a TWO-STEP ceremony — there is no one-shot install:
//   step 1 (no confirm): returns the PREPARE payload — plain-language
//     declaration, pinned ref, attestation hash, source resolution, and
//     the notice that installation fetches source-direct.
//   step 2 (confirm:true + the attestation hash echoed back): the
//     gateway RE-FETCHES the source files from GitHub at the pinned
//     ref, recomputes the content hash, and compares it to the signed
//     attestation. Mismatch or missing attestation → REFUSED. Match →
//     a pinned installs row + receipt.

import type { SkillRecord } from "../../src/types.js";
import type { SearchQueryInput } from "../../src/search.js";
import { paymentRequiredPayload } from "../../src/creator/access.js";
import type { InstallRow } from "./db.js";
import type { VerifyOutcome } from "./verify.js";

export interface GatewayDeps {
  search(input: SearchQueryInput): Promise<SkillRecord[]>;
  get(id: string): Promise<SkillRecord | undefined>;
  log(tool: string, skillId: string | null): Promise<void>;
  createInstall(row: Omit<InstallRow, "installed_at">): Promise<InstallRow>;
  verify(record: SkillRecord): Promise<VerifyOutcome>;
  /** P4 (optional): the listing's price, or null when free. When a
   *  dep set omits these, every skill behaves as free — the P2
   *  behaviour, unchanged. */
  pricing?(id: string): Promise<{ priceCents: number; currency: string } | null>;
  /** P4: validate a presented purchase token for a skill. */
  checkToken?(id: string, token: unknown): Promise<{ ok: boolean; tokenHash?: string }>;
  /** P4: spend a validated token after a successful paid install. */
  spendToken?(tokenHash: string): Promise<void>;
}

export const GATEWAY_TOOLS = [
  {
    name: "search_skill",
    description:
      "Search the Talents catalog (skills, plugins, MCP servers) by keyword. Returns owner/name ids, canonical talents.sh URLs, kind, a one-line declaration summary, and attestation presence.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords, e.g. \"pdf\" or \"api security\"" },
        kind: { type: "string", enum: ["skill", "plugin", "mcp", "agent"], description: "Optional kind filter" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_skill",
    description:
      "Full registry record summary for one skill: description, components, the derived plain-language declaration, validation state, and the signed attestation.",
    inputSchema: {
      type: "object",
      properties: { skill: { type: "string", description: "Canonical id, owner/name" } },
      required: ["skill"],
    },
  },
  {
    name: "install_skill",
    description:
      "Install a skill — a TWO-STEP ceremony, never one-shot. Call once without `confirm` to get the prepare payload (declaration, pinned ref, attestation hash). Call again with confirm:true and that attestationHash echoed back: the gateway re-verifies the source against the signed attestation before recording the pinned install. The skill itself is always fetched source-direct from its original repo; Talents never serves a copy.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Canonical id, owner/name" },
        confirm: { type: "boolean", description: "Step 2 only: true after reviewing the prepare payload" },
        attestationHash: { type: "string", description: "Step 2 only: the attestation hash from the prepare payload, echoed back" },
        purchaseToken: { type: "string", description: "Priced listings only: the one-time install token shown after web checkout (tix_…). Present it at prepare to unlock the payload, and again at confirm; it is spent by one successful install." },
        installer: { type: "string", description: "Who/what is installing (recorded on the install row)" },
      },
      required: ["skill"],
    },
  },
] as const;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function sourceResolution(r: SkillRecord): Record<string, unknown> {
  return {
    repo: r.sourceRepo ?? null,
    path: r.sourcePath ?? "",
    ref: r.ref,
    url: r.sourceRepo ? `https://github.com/${r.sourceRepo}` : null,
    via: r.sourceMarketplace,
  };
}

export function preparePayload(r: SkillRecord): Record<string, unknown> {
  return {
    status: "prepared",
    skill: r.id,
    url: r.url,
    kind: r.kind,
    declaration: r.declaration.summary,
    undeclared: r.declaration.undeclared,
    pinnedRef: r.ref,
    attestationHash: r.attestation?.contentHash ?? null,
    attestedAt: r.attestation?.signedAt ?? null,
    source: sourceResolution(r),
    notice:
      "Review the declaration above. Installation fetches the skill SOURCE-DIRECT from its original repo at the pinned ref — Talents stores only metadata and this attestation, never a copy. To proceed, call install_skill again with confirm:true and attestationHash set to the attestationHash above; the gateway re-verifies the live source against the signed attestation before recording the install.",
    confirmWith: { skill: r.id, confirm: true, attestationHash: r.attestation?.contentHash ?? null },
  };
}

export function skillSummary(r: SkillRecord): Record<string, unknown> {
  return {
    id: r.id,
    url: r.url,
    kind: r.kind,
    description: r.description,
    components: r.components,
    declaration: {
      summary: r.declaration.summary,
      lines: r.declaration.lines,
      undeclared: r.declaration.undeclared,
    },
    validation: r.validation,
    attestation: r.attestation
      ? { algorithm: r.attestation.algorithm, contentHash: r.attestation.contentHash, signedAt: r.attestation.signedAt }
      : null,
    source: sourceResolution(r),
    status: r.status,
  };
}

async function callTool(deps: GatewayDeps, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === "search_skill") {
    const query = String(args.query ?? "");
    const kind = typeof args.kind === "string" ? args.kind : undefined;
    const results = await deps.search({ q: query, kind, limit: 10 });
    await deps.log("search_skill", null);
    return toolResult({
      query,
      results: results.map((r) => ({
        id: r.id,
        url: r.url,
        kind: r.kind,
        declaration: r.declaration.summary[0] ?? "",
        attested: r.attestation !== null,
      })),
    });
  }

  if (name === "get_skill") {
    const id = String(args.skill ?? "").toLowerCase();
    const r = await deps.get(id);
    await deps.log("get_skill", id || null);
    if (!r) return toolResult({ status: "not_found", skill: id }, true);
    return toolResult(skillSummary(r));
  }

  if (name === "install_skill") {
    const id = String(args.skill ?? "").toLowerCase();
    const r = await deps.get(id);
    await deps.log("install_skill", id || null);
    if (!r) return toolResult({ status: "not_found", skill: id }, true);
    if (r.status !== "listed") return toolResult({ status: "refused", reason: `skill is not listed (status: ${r.status})` }, true);

    // P4 — priced listings: entitlement gates BOTH steps. Without a
    // valid purchase token the caller gets the payment-required
    // payload (never the declaration/hash payload — that IS the
    // install path). With one, the ceremony proceeds exactly as for
    // a free skill, and the token is spent only after the install
    // is recorded. Free skills never touch this branch.
    let entitledTokenHash: string | null = null;
    const pricing = deps.pricing ? await deps.pricing(r.id) : null;
    if (pricing) {
      const check = deps.checkToken
        ? await deps.checkToken(r.id, args.purchaseToken)
        : { ok: false, tokenHash: undefined };
      if (!check.ok) {
        return toolResult(
          paymentRequiredPayload({
            skillId: r.id,
            priceCents: pricing.priceCents,
            currency: pricing.currency,
            checkoutUrl: r.url,
          }),
          true,
        );
      }
      entitledTokenHash = check.tokenHash ?? null;
    }

    // Step 1 — prepare.
    if (args.confirm !== true) {
      return toolResult(preparePayload(r));
    }

    // Step 2 — confirm: the caller must echo the attestation hash from
    // the prepare payload (proof the declaration was actually shown),
    // and the live source must still hash to the signed attestation.
    if (!r.attestation) {
      return toolResult({ status: "refused", skill: r.id, reason: "record has no registry attestation — cannot verify, refusing" }, true);
    }
    if (String(args.attestationHash ?? "") !== r.attestation.contentHash) {
      return toolResult({
        status: "refused",
        skill: r.id,
        reason: "attestationHash does not match the prepare payload for this skill — re-run step 1 and echo the current hash",
      }, true);
    }
    const outcome = await deps.verify(r);
    if (!outcome.ok) {
      return toolResult({ status: "refused", skill: r.id, reason: outcome.reason }, true);
    }
    const install = await deps.createInstall({
      id: crypto.randomUUID(),
      skill_id: r.id,
      pinned_ref: r.ref,
      attestation_hash: r.attestation.contentHash,
      installer: String(args.installer ?? "mcp-gateway"),
    });
    // Paid install succeeded — spend the one-time token (only now:
    // a refused verify above must never burn a buyer's token).
    if (entitledTokenHash && deps.spendToken) {
      await deps.spendToken(entitledTokenHash);
    }
    return toolResult({
      status: "installed",
      skill: r.id,
      installId: install.id,
      pinnedRef: install.pinned_ref,
      attestationHash: install.attestation_hash,
      installedAt: install.installed_at,
      source: sourceResolution(r),
      fetchInstructions: r.sourceRepo
        ? [
            `Fetch source-direct from the original repo (Talents serves no copy):`,
            `  git clone https://github.com/${r.sourceRepo} && git -C ${r.sourceRepo.split("/")[1]} checkout ${r.ref}`,
            ...(r.sourcePath ? [`  skill files live under: ${r.sourcePath}/`] : []),
            `  hashed files to verify against the attestation: ${r.filesHashed.join(", ")}`,
            `Or, in Claude Code: /plugin marketplace add talents, then /plugin install ${r.name}`,
          ].join("\n")
        : "Fetch from the original source recorded on the skill page; Talents serves no copy.",
    });
  }

  return toolResult({ status: "unknown_tool", tool: name }, true);
}

/** Handle one MCP JSON-RPC request (streamable HTTP, stateless). */
export async function handleMcpRequest(req: Request, deps: GatewayDeps): Promise<Response> {
  if (req.method === "GET") {
    return new Response("MCP gateway: POST JSON-RPC to this endpoint (streamable HTTP, stateless).", { status: 405 });
  }
  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error: body is not valid JSON");
  }
  const { id, method } = body;
  const params = body.params ?? {};

  // Notifications have no id and expect no body back.
  if (id === undefined || id === null) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "talents-gateway", version: "0.2.0" },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: GATEWAY_TOOLS });
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return rpcResult(id, await callTool(deps, name, args));
      } catch (e) {
        return rpcResult(id, toolResult({ status: "error", reason: (e as Error).message }, true));
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method ?? "(none)"}`);
  }
}
