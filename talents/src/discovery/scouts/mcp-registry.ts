// Scout: official MCP Registry sync (Phase 2). The registry's
// REST API is unauthenticated and explicitly built for downstream
// aggregators: GET /v0.1/servers with cursor pagination and an
// updated_since filter. This scout keeps an incremental sync:
//
//   sync_state "mcp-registry" = JSON {updatedSince?, cursor?}
//   - cursor present → a previous run was capped mid-feed; resume.
//   - feed exhausted → watermark advances to the newest updatedAt
//     examined; later runs ask only for what changed since.
//
// The ~40k-server backlog therefore drains in bounded runs, and a
// steady-state run nominates only changed servers. Per-version
// duplicates collapse here: only isLatest entries nominate, and the
// quality bar (mcpQualityBar) filters before nomination — below-bar
// entries are counted, never nominated.

import {
  MCP_REGISTRY_BASE, mcpQualityBar, type McpServerJson,
} from "./mcp-record.js";
import {
  SCOUT_VIA, type Scout, type ScoutContext, type ScoutNomination, type ScoutResult,
} from "./types.js";

export const MCP_SYNC_KEY = "mcp-registry";

export interface McpSyncState {
  updatedSince?: string;
  cursor?: string;
}

export function parseSyncState(raw: string | null): McpSyncState {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as McpSyncState;
    return typeof j === "object" && j ? j : {};
  } catch {
    return {};
  }
}

interface RegistryEntry {
  server?: McpServerJson;
  _meta?: Record<string, { status?: string; updatedAt?: string; isLatest?: boolean }>;
}

interface RegistryPage {
  servers: RegistryEntry[];
  nextCursor: string | null;
}

export function entryMeta(e: RegistryEntry): { status?: string; updatedAt?: string; isLatest?: boolean } {
  return e._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
}

/** One entry → nomination, or a skip with reason. Pure. */
export function nominationFromRegistryEntry(
  entry: RegistryEntry,
  at: string,
): { nomination?: ScoutNomination; skip?: string } {
  const server = entry.server;
  if (!server?.name) return { skip: "entry without a server name" };
  const meta = entryMeta(entry);
  if (meta.status && meta.status !== "active") return { skip: `status ${meta.status}` };
  if (meta.isLatest === false) return { skip: "not the latest version" };
  const bar = mcpQualityBar(server);
  if (!bar.ok) return { skip: bar.reason };
  return {
    nomination: {
      kind: "mcp-server",
      locator: server.name,
      url: server.repository?.url ?? null,
      provenance: {
        via: SCOUT_VIA["mcp-registry"],
        at,
        ref: `${MCP_REGISTRY_BASE}/v0.1/servers/${encodeURIComponent(server.name)}/versions/latest`,
        signals: {
          version: server.version ?? "latest",
          remotes: server.remotes?.length ?? 0,
          packages: server.packages?.length ?? 0,
        },
        note: "official MCP registry entry — passes the nomination quality bar",
      },
      signalScore: (server.remotes?.length ?? 0) + (server.packages?.length ?? 0),
    },
  };
}

async function fetchRegistryPage(
  ctx: ScoutContext,
  params: { cursor?: string; updatedSince?: string },
): Promise<RegistryPage | null> {
  const qs = new URLSearchParams({ limit: "100" });
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.updatedSince) qs.set("updated_since", params.updatedSince);
  const url = `${MCP_REGISTRY_BASE}/v0.1/servers?${qs.toString()}`;
  return ctx.pacer.call(async () => {
    try {
      const res = await ctx.fetchFn(url, { headers: { accept: "application/json", "user-agent": "talents-discovery-scouts" } });
      if (!res.ok) return { status: res.status, value: null };
      const j = (await res.json()) as { servers?: RegistryEntry[]; metadata?: { nextCursor?: string } };
      return {
        status: res.status,
        value: {
          servers: Array.isArray(j.servers) ? j.servers : [],
          nextCursor: j.metadata?.nextCursor ?? null,
        },
      };
    } catch {
      return { status: 0, value: null };
    }
  });
}

export const mcpRegistryScout: Scout = {
  name: "mcp-registry",
  async run(ctx: ScoutContext, opts: Record<string, unknown>): Promise<ScoutResult> {
    const cap = Number(opts.cap ?? 200) || 200;
    const rateBefore = ctx.pacer.rateLimitHits;
    const state = parseSyncState(await ctx.getSyncState(MCP_SYNC_KEY));
    // Operator bootstrap: --since seeds the watermark on first run.
    if (typeof opts.since === "string" && !state.updatedSince && !state.cursor) {
      state.updatedSince = opts.since;
    }
    const at = ctx.now().toISOString();
    const nominations: ScoutNomination[] = [];
    const seenNames = new Set<string>();
    let examined = 0;
    let skipped = 0;
    let calls = 0;
    let maxUpdatedAt = state.updatedSince ?? "";
    let cursor: string | undefined = state.cursor;
    let exhausted = false;
    let blocked: string | undefined;

    for (let page = 0; page < 50; page++) {
      const res = await fetchRegistryPage(ctx, { cursor, updatedSince: state.updatedSince });
      calls++;
      if (!res) { blocked = "MCP registry request failed (network or HTTP error)"; break; }
      // The whole page is always processed: registry cursors are
      // page-granular, so stopping mid-page would silently skip the
      // page's tail forever once the watermark passes it. The cap
      // is therefore soft by less than one page.
      for (const entry of res.servers) {
        examined++;
        const meta = entryMeta(entry);
        if (meta.updatedAt && meta.updatedAt > maxUpdatedAt) maxUpdatedAt = meta.updatedAt;
        const name = entry.server?.name;
        if (name) {
          if (seenNames.has(name)) { skipped++; continue; }
          seenNames.add(name);
        }
        const { nomination, skip } = nominationFromRegistryEntry(entry, at);
        if (skip || !nomination) { skipped++; continue; }
        nominations.push(nomination);
      }
      if (nominations.length >= cap) {
        // Cap reached at a page boundary: persist the resume
        // cursor, watermark stays where it was.
        if (res.nextCursor) {
          await ctx.setSyncState(MCP_SYNC_KEY, JSON.stringify({ updatedSince: state.updatedSince, cursor: res.nextCursor } satisfies McpSyncState));
        } else {
          exhausted = true;
        }
        break;
      }
      if (!res.nextCursor) { exhausted = true; break; }
      cursor = res.nextCursor;
      if (res.servers.length === 0) { exhausted = true; break; }
    }

    if (exhausted) {
      await ctx.setSyncState(MCP_SYNC_KEY, JSON.stringify({ updatedSince: maxUpdatedAt || undefined } satisfies McpSyncState));
    }

    return {
      nominations,
      stats: {
        examined,
        nominated: nominations.length,
        skipped,
        calls,
        rateLimitHits: ctx.pacer.rateLimitHits - rateBefore,
        ...(blocked ? { blocked } : {}),
        note: exhausted
          ? `feed exhausted; watermark advanced to ${maxUpdatedAt || "(none)"}`
          : `capped at ${cap} nominations; resume cursor persisted`,
      },
    };
  },
};
