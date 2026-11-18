// SSR web server (P1) — node:http shell around the shared rendering
// in src/render.ts (the P2 Cloudflare Worker renders the same templates
// from D1). Kept working so the P1 gate stays reproducible.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SkillRecord } from "./types.js";
import type { SearchQueryInput } from "./search.js";
import { render404, renderHome, renderProfile, renderSearchPage, renderSkillPage } from "./render.js";

export * from "./render.js";

export interface WebDeps {
  all(): SkillRecord[];
  get(id: string): SkillRecord | undefined;
  byOwner(owner: string): SkillRecord[];
  search(input: SearchQueryInput): Promise<SkillRecord[]>;
}

export function depsFromRecords(records: SkillRecord[], search: WebDeps["search"]): WebDeps {
  const byId = new Map(records.map((r) => [r.id, r]));
  return {
    all: () => records,
    get: (id) => byId.get(id.toLowerCase()),
    byOwner: (owner) => records.filter((r) => r.owner === owner.toLowerCase()),
    search,
  };
}

// ---------------------------------------------------------------------------
// HTTP handler + server
// ---------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(body);
}

export function createHandler(deps: WebDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== "GET") {
        send(res, 405, render404("Method not allowed"));
        return;
      }
      const url = new URL(req.url ?? "/", "http://talents.local");
      const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p).toLowerCase());

      if (parts.length === 0) {
        send(res, 200, renderHome(deps.all()));
        return;
      }
      if (parts[0] === "search" && parts.length === 1) {
        const input: SearchQueryInput = {
          q: url.searchParams.get("q") ?? "",
          kind: url.searchParams.get("kind") || undefined,
          owner: url.searchParams.get("owner") || undefined,
        };
        const results = await deps.search(input);
        send(res, 200, renderSearchPage(input, results));
        return;
      }
      if (parts[0] === "s" && parts.length === 3) {
        send(res, 301, "", { location: `/skills/${parts[1]}/${parts[2]}` });
        return;
      }
      if (parts[0] === "skills" && parts.length === 3) {
        const r = deps.get(`${parts[1]}/${parts[2]}`);
        if (!r) {
          send(res, 404, render404(`${parts[1]}/${parts[2]}`));
          return;
        }
        send(res, 200, renderSkillPage(r));
        return;
      }
      if (parts.length === 1) {
        const owned = deps.byOwner(parts[0]);
        if (owned.length === 0) {
          send(res, 404, render404(parts[0]));
          return;
        }
        send(res, 200, renderProfile(parts[0], owned));
        return;
      }
      send(res, 404, render404(url.pathname));
    } catch (e) {
      send(res, 500, render404(`Something went wrong: ${(e as Error).message}`));
    }
  };
}

export function createWebServer(deps: WebDeps): Server {
  return createServer(createHandler(deps));
}
