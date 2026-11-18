// Enrichment orchestration for the Worker (Tranche 1: layers A–C;
// Tranche 2: layers D–E): the paged POST /admin/enrich route
// (mirrors /admin/embed's contract), the /assets/* serving route
// for the R2 display assets, the skill page's enrichment lookup,
// and the weekly enrichment-refresh cron slot. All layer logic
// lives in ../../src/enrichment/* (pure + shared with the operator
// script); this module is only the I/O glue, like cf/src/discovery.ts.
//
// Execution-site note (deliberate): this route drives the same code
// with the Worker's own unauthenticated fetch — fine for npm facts,
// README/icon fetches and MCP probes, but GitHub API facts are
// rate-limited unauthenticated (≈60/hr/IP), so the OPERATOR script
// (ghapi-authenticated) is the primary Layer A driver. Layer D is
// the opposite: generation runs ONLY here, because the Worker holds
// the ANTHROPIC_API_KEY secret and the operator never sees it.

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { SkillRecord } from "../../src/types.js";
import { defaultFetch } from "../../src/ingest.js";
import { ADVISOR_MODEL_DEFAULT } from "../../src/advisor.js";
import { D1EnrichmentStore } from "../../src/enrichment/store.js";
import { enrichIds, enrichPage, type EnrichDeps } from "../../src/enrichment/pipeline.js";
import { enrichmentView, type EnrichmentView } from "../../src/enrichment/display.js";
import type { GenerateFn } from "../../src/enrichment/layer-d.js";
import type { AssetStore, EnrichLayer } from "../../src/enrichment/types.js";
import { getRecord, type Env } from "./db.js";

/** AssetStore over the R2 binding; a missing binding degrades to
 *  recorded errors in Layer A rather than a route failure. */
export function r2AssetStore(env: Env): AssetStore {
  if (!env.ASSETS) {
    return {
      async put(): Promise<void> {
        throw new Error("ASSETS R2 binding not configured");
      },
    };
  }
  const bucket = env.ASSETS;
  return {
    async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
      await bucket.put(key, data, { httpMetadata: { contentType } });
    },
  };
}

/** The enrichment model: TALENTS_ENRICH_MODEL, falling back to the
 *  advisor's model var, then the shared Haiku-class default. */
export function enrichModelOf(env: Env): string {
  return env.TALENTS_ENRICH_MODEL ?? env.TALENTS_ADVISOR_MODEL ?? ADVISOR_MODEL_DEFAULT;
}

/** The Anthropic generator for Layer D, bound to this Worker's
 *  secret. Returns null when no key is configured — the route then
 *  reports the D layer as unavailable instead of skipping silently. */
export function anthropicGenerator(env: Env): GenerateFn | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const modelId = enrichModelOf(env);
  return async ({ system, user }) => {
    const res = await generateText({
      model: anthropic(modelId),
      system,
      prompt: user,
      maxOutputTokens: 1600,
      temperature: 0.2,
    });
    return {
      text: res.text,
      model: modelId,
      inputTokens: res.usage?.inputTokens ?? 0,
      outputTokens: res.usage?.outputTokens ?? 0,
    };
  };
}

const README_PROMPT_CAP = 12_000;

/** Layer D's README reader: the record's stored R2 copy (never a
 *  live origin fetch — generation grounds on what Layer A stored). */
export function r2ReadmeReader(env: Env): (skillId: string) => Promise<string | null> {
  return async (skillId: string) => {
    if (!env.ASSETS) return null;
    try {
      const obj = await env.ASSETS.get(`readme/${skillId}`);
      if (!obj || !obj.body) return null;
      const text = await new Response(obj.body).text();
      return text ? text.slice(0, README_PROMPT_CAP) : null;
    } catch {
      return null;
    }
  };
}

function enrichDeps(env: Env): EnrichDeps {
  const generate = anthropicGenerator(env);
  return {
    store: new D1EnrichmentStore(env.DB),
    db: env.DB,
    fetchFn: defaultFetch,
    assets: r2AssetStore(env),
    ...(generate ? { generateD: generate } : {}),
    readReadme: r2ReadmeReader(env),
    loadRecord: (id) => getRecord(env.DB, id),
  };
}

const ALL_LAYERS: EnrichLayer[] = ["a", "b", "c", "d", "e"];

function parseLayers(input: unknown): EnrichLayer[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input
    .map((l) => (typeof l === "string" ? l.toLowerCase() : ""))
    .filter((l): l is EnrichLayer => (ALL_LAYERS as string[]).includes(l));
  return out.length ? [...new Set(out)] : undefined;
}

/**
 * POST /admin/enrich — enrich records (token-gated, same gate as
 * /admin/discover and /admin/embed). Two modes:
 *   - Paged (default): body `{ limit?, cursor?, layers? }` — one
 *     bounded page of the catalog in traffic order; loop on
 *     `nextCursor` until `done`.
 *   - Explicit ids: body `{ ids: [...], layers? }` — exactly those
 *     records (tranche runs over a named slice).
 * `layers` restricts to a subset of ["a","b","c","d","e"]
 * (case-insensitive). Asking for layer "d" without an
 * ANTHROPIC_API_KEY in the Worker returns an explicit error field —
 * never a silent skip.
 */
export async function handleAdminEnrich(
  env: Env,
  body: { limit?: number; cursor?: string; layers?: string[]; ids?: string[] },
): Promise<unknown> {
  const layers = parseLayers(body.layers);
  const deps = enrichDeps(env);
  const dNote = layers?.includes("d") && !deps.generateD
    ? { dError: "layer d requested but ANTHROPIC_API_KEY is not configured in the Worker — D not run" }
    : {};
  if (Array.isArray(body.ids) && body.ids.length) {
    const ids = body.ids.filter((x): x is string => typeof x === "string").slice(0, 100);
    const stats = await enrichIds(deps, ids, layers ? { layers } : {});
    return { mode: "ids", ...stats, outcomes: undefined, ...dNote };
  }
  const stats = await enrichPage(deps, {
    limit: body.limit,
    cursor: body.cursor ?? null,
    ...(layers?.length ? { layers } : {}),
  });
  return { mode: "page", ...stats, ...dNote };
}

/** The enrichment view for one record's page (null when unenriched). */
export async function enrichmentViewFor(env: Env, record: SkillRecord): Promise<EnrichmentView | null> {
  try {
    const store = new D1EnrichmentStore(env.DB);
    const row = await store.get(record.id);
    return enrichmentView(record, row);
  } catch {
    // Pre-0006 schema (migration not yet applied): pages must not
    // 500 — enrichment is additive only.
    return null;
  }
}

/** GET /assets/{icon|readme}/{owner}/{name} — serve the stored R2
 *  copy (never a redirect to the origin: pages must not hot-link,
 *  and the origin may move). 404 when nothing was stored. */
export async function serveAsset(env: Env, kind: string, id: string): Promise<Response> {
  if (!env.ASSETS) return new Response("assets not configured", { status: 404 });
  const obj = await env.ASSETS.get(`${kind}/${id}`);
  if (!obj || !obj.body) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=86400",
    },
  });
}

// ---------------------------------------------------------------------------
// Weekly enrichment-refresh cron slot (Tranche 2): the discovery
// rotation gains a weekly pass that refreshes the living-origin
// layers — A (source stats) and C (MCP introspection) — for records
// whose cadence has expired, walking the catalog in traffic order
// in bounded pages. Same pipeline functions as the admin route;
// D is deliberately NOT in the cron (generation is hash-keyed and
// operator-gated for cost visibility), and B/E re-run only when a
// hash change makes them stale inside the same pass.
// ---------------------------------------------------------------------------

export const ENRICHMENT_REFRESH_CRON = "41 5 * * 1"; // Mondays 05:41 UTC
export const REFRESH_PAGES = 4;
export const REFRESH_PAGE_SIZE = 25;

export async function handleEnrichmentRefresh(env: Env): Promise<void> {
  const deps = enrichDeps(env);
  let cursor: string | null = null;
  for (let page = 0; page < REFRESH_PAGES; page++) {
    const stats = await enrichPage(deps, {
      limit: REFRESH_PAGE_SIZE,
      cursor,
      layers: ["a", "c"],
    });
    console.log(
      `enrichment-refresh page ${page + 1}: considered=${stats.considered} enriched=${stats.enriched} ` +
      `a=${stats.layerRuns.a} c=${stats.layerRuns.c} done=${stats.done}`,
    );
    if (stats.done || !stats.nextCursor) break;
    cursor = stats.nextCursor;
  }
}
