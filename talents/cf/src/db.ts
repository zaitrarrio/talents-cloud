// D1 data access for the Talents Worker (P2). The Worker's DB binding
// is structurally compatible with the engine's D1Like interface
// (prepare/bind/all/run/first), so the shared D1SearchEngine drives it
// directly.

import type { SkillRecord } from "../../src/types.js";
import type { D1Like } from "../../src/search-d1.js";
import type { VectorizeBinding, WorkersAIBinding } from "../../src/discovery/embeddings.js";

// Minimal ambient stand-in for the Workers Durable Object namespace
// type: @cloudflare/workers-types is not in this project's type
// roots, and this module is also compiled by the root test build
// (no Workers types there at all). The real runtime object is the
// platform's; only the shape used in index.ts is declared.
declare global {
  interface DurableObjectNamespace<T = unknown> {
    newUniqueId(): unknown;
    idFromName(name: string): unknown;
    idFromString(id: string): unknown;
    get(id: unknown): T;
  }
}

/** Minimal structural shape of a Queue producer binding. */
export interface QueueLike {
  send(message: unknown): Promise<void>;
}

/** Minimal structural shape of a Cloudflare Workflow instance
 *  (only the status read the drain routes use is declared). */
export interface WorkflowInstanceLike {
  status(): Promise<{ status: string }>;
}

/** Minimal structural shape of a Workflow binding (the
 *  `workflow` binding in wrangler config, bound to a
 *  WorkflowEntrypoint class). Only the create/get surface the
 *  drain routes use is declared — the real runtime object is
 *  the platform's. */
export interface WorkflowBindingLike {
  create(opts: { id: string; params?: unknown }): Promise<WorkflowInstanceLike>;
  // NOTE: get() is ASYNC on the real binding (Cloudflare docs:
  // get(id): Promise<WorkflowInstance>) — callers must await it.
  // A sync fake here masked the missing await in production
  // (cutover 2026-11-11: live detection always reported stale).
  get(id: string): Promise<WorkflowInstanceLike>;
}

/** Minimal structural shape of an R2 object (enrichment assets). */
export interface R2ObjectLike {
  body: ReadableStream<Uint8Array> | null;
  httpMetadata?: { contentType?: string };
  size: number;
}

/** Minimal structural shape of the R2 bucket binding used by the
 *  enrichment pipeline (`talents-assets`: README + icon display
 *  assets keyed by skill id). */
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export interface Env {
  DB: D1Like;
  /** Workers AI binding (P5 embeddings). Optional: when absent, the
   *  semantic layer disables itself and search stays keyword-only. */
  AI?: WorkersAIBinding;
  /** Vectorize index binding (P5, `talents-skills`). Optional, same
   *  graceful-degradation rule as AI. */
  VECTORIZE?: VectorizeBinding;
  /** Ingest queue producer (P5 discovery pipeline). Optional: when
   *  absent, cron/webhook paths log instead of enqueueing. */
  INGEST_QUEUE?: QueueLike;
  /** R2 bucket for enrichment display assets (Enrichment Tranche 1:
   *  `talents-assets` — README text + icon images keyed by skill
   *  id). Optional: when absent, Layer A asset writes degrade to
   *  recorded partials and /assets/* routes 404. */
  ASSETS?: R2BucketLike;
  /** Worker secret — HMAC secret for POST /webhooks/github. When
   *  unset the webhook route accepts-and-logs (dev mode) and the
   *  README says so. Set via `wrangler secret put WEBHOOK_SECRET`. */
  WEBHOOK_SECRET?: string;
  /** Worker secret — bearer token for the /admin/* discovery routes.
   *  When unset those routes 404 (disabled). Set via
   *  `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN?: string;
  /** Worker secret — the registry attestation key (JSON), needed
   *  only by Worker-side ingest (cron/queue/webhook paths). When
   *  unset those paths disable themselves loudly; CLI ingest is
   *  unaffected. Set via cf/scripts/set_registry_key.py. */
  TALENTS_REGISTRY_KEY?: string;
  /** Worker secret — GitHub token. When set, Worker-side
   *  api.github.com calls authenticate with it (5,000 core req/hr
   *  instead of ~60 unauthenticated per egress IP): the verify /
   *  ingest fetch wrapper in discovery.ts attaches it, and the
   *  code-search cron scout reads it directly. When unset those
   *  paths run unauthenticated (the pre-2026-11-11 behavior).
   *  Set via secure entry + `wrangler secret put GITHUB_TOKEN`;
   *  never a wrangler var. */
  GITHUB_TOKEN?: string;
  /** Queue-drain producer switch: "1" / "true" enables the
   *  scheduled producer step that enqueues ONE bounded page of
   *  backfill candidates (status='candidate') onto INGEST_QUEUE per
   *  daily cron run. DEFAULT OFF — deliberately absent from both
   *  wrangler configs. The cutover from the sandbox drain flips it
   *  only after the queue drain proves out (data/gate-queuedrain.txt). */
  QUEUE_DRAIN_ENABLED?: string;
  /** Workflow binding for the drain orchestrator
   *  (TalentDrainWorkflow, gate-queue-workflow). Optional: when
   *  absent, the drain-workflow admin routes report the binding
   *  as missing and start refuses; the queue producer tick is
   *  unaffected. */
  DRAIN_WORKFLOW?: WorkflowBindingLike;
  /** Durable Object namespace for the Think advisor (cf/src/advisor.ts). */
  TalentAdvisor?: DurableObjectNamespace;
  /** Worker secret — Anthropic API key for the advisor's model calls.
   *  Set via `wrangler secret put ANTHROPIC_API_KEY` (see
   *  cf/scripts/set_advisor_secret.py); never a wrangler var. */
  ANTHROPIC_API_KEY?: string;
  /** Advisor model id (Anthropic). Defaults to claude-haiku-5-5. */
  TALENTS_ADVISOR_MODEL?: string;
  /** Enrichment Layer D model override (defaults to the advisor
   *  model — see cf/src/enrichment.ts enrichModelOf). */
  TALENTS_ENRICH_MODEL?: string;
  /** Clerk publishable key (PUBLIC by design — a wrangler var, safe
   *  to expose; it identifies the Clerk instance to browsers). When
   *  unset, /sign-in renders the honest awaiting-keys setup state
   *  and protected routes redirect there. */
  CLERK_PUBLISHABLE_KEY?: string;
  /** Worker secret — Clerk secret key (sk_…). Enables the Clerk
   *  Backend API lookup that resolves a session's GitHub login.
   *  Set via secure entry + `wrangler secret put CLERK_SECRET_KEY`;
   *  never a wrangler var. */
  CLERK_SECRET_KEY?: string;
  /** Worker secret — the Clerk instance's JWT public key (PEM), for
   *  networkless session verification. Alternative/complement to the
   *  JWKS URL derived from the publishable key. */
  CLERK_JWT_KEY?: string;
  /** Optional explicit JWKS URL override (defaults to the one
   *  derived from CLERK_PUBLISHABLE_KEY). */
  CLERK_JWKS_URL?: string;
  /** Worker secret — Stripe platform secret key (sk_test_… /
   *  sk_live_…). When unset, payments are DISABLED: priced pages
   *  render the honest not-yet-enabled state and checkout/connect
   *  endpoints refuse. Set via `wrangler secret put
   *  STRIPE_SECRET_KEY`. */
  STRIPE_SECRET_KEY?: string;
  /** Worker secret — Stripe webhook signing secret (whsec_…) for
   *  POST /webhooks/stripe. */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * DEV-ONLY session stub for local `vite dev` runs: a JSON object
   * {"clerkUserId":"…","githubLogin":"…"} that auth treats as the
   * signed-in user. Honored ONLY when no Clerk publishable key is
   * configured. NEVER set this on the deploy config — production
   * must use real Clerk verification.
   */
  TALENTS_AUTH_MOCK?: string;
  /**
   * DEV-ONLY escape hatch: when set (e.g. wrangler dev --var), source
   * re-fetches for attestation verification are routed through a local
   * relay (scripts/source-relay.mjs). Needed only where workerd has no
   * direct egress (this build sandbox routes egress via a proxy that
   * workerd cannot use). Production leaves it unset — Workers fetch
   * GitHub directly.
   */
  TALENTS_SOURCE_RELAY?: string;
}

function parse(json: string): SkillRecord {
  return JSON.parse(json) as SkillRecord;
}

/** Owner-unlisted skill ids (Creator Experience, P4). Owner opt-out
 *  is absolute on every read surface, so the filtering lives HERE —
 *  in the shared read path — not in each route. The verified record
 *  rows stay in `records` for audit; they are simply never returned.
 *  Tolerates the pre-0005 schema (table absent → empty set) so a
 *  deploy can never 500 on a missing migration. */
export async function unlistedSkillIds(db: D1Like): Promise<Set<string>> {
  try {
    const { results } = await db
      .prepare("SELECT skill_id FROM unlisted_skills")
      .all<{ skill_id: string }>();
    return new Set(results.map((r) => r.skill_id));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Bounded reads (gate-d1size, 2026-11-11).
//
// D1 enforces a 50 MB single-query RESPONSE limit. At 22,407 listed
// records the records table holds 53.5 MB of record_json, so any
// SELECT record_json over the whole catalog 500s every surface that
// runs it (home, /api/trending, the search vector block, suggest).
// Every helper below is bounded by construction — an explicit id
// list, a LIMIT, or an aggregate — and the old allRecords() full
// scan was deleted outright, so a future full-table load fails at
// compile time instead of in production. The regression test
// (test/d1size.test.ts) enforces the response cap against a
// synthetic catalog large enough that a full scan would throw.
// ---------------------------------------------------------------------------

/** Chunk size for id-list IN queries: 50 ids × ~2.3 KB record_json
 *  ≈ 115 KB per response, far under the 50 MB limit. */
export const RECORDS_BY_IDS_CHUNK = 50;

/** Fetch listed records for an explicit id list, in the caller's
 *  order. Owner-unlisted ids never resolve. */
export async function recordsByIds(db: D1Like, ids: string[]): Promise<SkillRecord[]> {
  const unlisted = await unlistedSkillIds(db);
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => !unlisted.has(id));
  const found = new Map<string, SkillRecord>();
  for (let i = 0; i < wanted.length; i += RECORDS_BY_IDS_CHUNK) {
    const chunk = wanted.slice(i, i + RECORDS_BY_IDS_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT record_json FROM records WHERE id IN (${placeholders}) AND status = 'listed'`)
      .bind(...chunk)
      .all<{ record_json: string }>();
    for (const r of results) {
      const record = parse(r.record_json);
      found.set(record.id, record);
    }
  }
  return wanted.map((id) => found.get(id)).filter((r): r is SkillRecord => Boolean(r));
}

/** Catalog totals for the home-page header line, as aggregates —
 *  never a record load. Owner-unlisted records are excluded, as
 *  they are on every read surface. */
export async function listedStats(db: D1Like): Promise<{ count: number; owners: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT owner) AS owners
       FROM records
       WHERE status = 'listed' AND id NOT IN (SELECT skill_id FROM unlisted_skills)`,
    )
    .first<{ count: number; owners: number }>();
  return { count: row?.count ?? 0, owners: row?.owners ?? 0 };
}

/** Bounded pool for the static trending fallback: the most recently
 *  ingested listed records. The fallback ranks with the same
 *  trending() function as before — only the pool is bounded (the
 *  whole catalog was the pool until the 50 MB limit made that a
 *  500). */
export async function recentListedRecords(db: D1Like, limit: number): Promise<SkillRecord[]> {
  const { results } = await db
    .prepare("SELECT record_json FROM records WHERE status = 'listed' ORDER BY ingested_at DESC, id LIMIT ?")
    .bind(Math.max(1, Math.floor(limit)))
    .all<{ record_json: string }>();
  const unlisted = await unlistedSkillIds(db);
  const records = results.map((r) => parse(r.record_json));
  return unlisted.size ? records.filter((r) => !unlisted.has(r.id)) : records;
}

/** Bounded same-kind sample for suggestions (newest first). */
export async function recordsByKindSample(db: D1Like, kind: string, limit: number): Promise<SkillRecord[]> {
  const { results } = await db
    .prepare("SELECT record_json FROM records WHERE kind = ? AND status = 'listed' ORDER BY ingested_at DESC, id LIMIT ?")
    .bind(kind, Math.max(1, Math.floor(limit)))
    .all<{ record_json: string }>();
  const unlisted = await unlistedSkillIds(db);
  const records = results.map((r) => parse(r.record_json));
  return unlisted.size ? records.filter((r) => !unlisted.has(r.id)) : records;
}

/** Ids ONLY of listed records whose stored JSON contains one of the
 *  given component names as a quoted string value — the cross-owner
 *  signal for suggestions, without loading the catalog. Quoted
 *  matching keeps description prose out: a component appears in
 *  record_json as `"name"` inside a components array, while a
 *  description mention is unquoted prose inside a longer string.
 *  The response is ids only, so the query stays tiny at any catalog
 *  size; callers fetch the records themselves via recordsByIds. */
export async function recordIdsSharingComponents(db: D1Like, components: string[], limit: number): Promise<string[]> {
  const terms = [...new Set(components.map((c) => c.trim()).filter((c) => c.length >= 3))].slice(0, 8);
  if (!terms.length) return [];
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const where = terms.map(() => `record_json LIKE ? ESCAPE '\\'`).join(" OR ");
  const { results } = await db
    .prepare(`SELECT id FROM records WHERE status = 'listed' AND (${where}) ORDER BY id LIMIT ?`)
    .bind(...terms.map((t) => `%"${esc(t)}"%`), Math.max(1, Math.floor(limit)))
    .all<{ id: string }>();
  const unlisted = await unlistedSkillIds(db);
  return results.map((r) => r.id).filter((id) => !unlisted.has(id));
}

/**
 * One bounded page of listed records for whole-catalog consumers
 * that page through the catalog instead of loading it: ordered by
 * id ascending, strictly after `cursor` (null = first page). The
 * aggregated marketplace route and the cron embed sweep use this
 * (gate-d1size) — a full-table SELECT record_json is 53.5 MB at
 * current scale and 500s under D1's 50 MB response limit.
 *
 * Unlike the read surfaces above, this deliberately does NOT filter
 * owner-unlisted ids: it is an indexer, not a read path, and cursor
 * arithmetic has to stay exact over the records table. Vectors for
 * unlisted records are inert — search, suggest, and pages all filter
 * unlisted ids on read — and if a record is re-listed its embedding
 * is already fresh.
 */
export async function recordsPage(db: D1Like, cursor: string | null, limit: number): Promise<SkillRecord[]> {
  const { results } = cursor
    ? await db
        .prepare("SELECT record_json FROM records WHERE status = 'listed' AND id > ? ORDER BY id LIMIT ?")
        .bind(cursor, limit)
        .all<{ record_json: string }>()
    : await db
        .prepare("SELECT record_json FROM records WHERE status = 'listed' ORDER BY id LIMIT ?")
        .bind(limit)
        .all<{ record_json: string }>();
  return results.map((r) => parse(r.record_json));
}

export async function getRecord(db: D1Like, id: string): Promise<SkillRecord | undefined> {
  const key = id.toLowerCase();
  const unlisted = await unlistedSkillIds(db);
  if (unlisted.has(key)) return undefined;
  const row = await db
    .prepare("SELECT record_json FROM records WHERE id = ?")
    .bind(key)
    .first<{ record_json: string }>();
  return row ? parse(row.record_json) : undefined;
}

export async function recordsByOwner(db: D1Like, owner: string, limit?: number): Promise<SkillRecord[]> {
  const { results } =
    limit === undefined
      ? await db
          .prepare("SELECT record_json FROM records WHERE owner = ? AND status = 'listed' ORDER BY id")
          .bind(owner.toLowerCase())
          .all<{ record_json: string }>()
      : await db
          .prepare("SELECT record_json FROM records WHERE owner = ? AND status = 'listed' ORDER BY id LIMIT ?")
          .bind(owner.toLowerCase(), Math.max(1, Math.floor(limit)))
          .all<{ record_json: string }>();
  const unlisted = await unlistedSkillIds(db);
  const records = results.map((r) => parse(r.record_json));
  return unlisted.size ? records.filter((r) => !unlisted.has(r.id)) : records;
}

export async function logGatewayCall(db: D1Like, tool: string, skillId: string | null): Promise<void> {
  await db
    .prepare("INSERT INTO gateway_calls (tool, skill_id, called_at) VALUES (?, ?, ?)")
    .bind(tool, skillId, new Date().toISOString())
    .run();
}

export interface InstallRow {
  id: string;
  skill_id: string;
  pinned_ref: string;
  attestation_hash: string;
  installed_at: string;
  installer: string;
}

export async function createInstall(
  db: D1Like,
  row: Omit<InstallRow, "installed_at">,
): Promise<InstallRow> {
  const full: InstallRow = { ...row, installed_at: new Date().toISOString() };
  await db
    .prepare(
      "INSERT INTO installs (id, skill_id, pinned_ref, attestation_hash, installed_at, installer) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(full.id, full.skill_id, full.pinned_ref, full.attestation_hash, full.installed_at, full.installer)
    .run();
  return full;
}

export async function installsFor(db: D1Like, skillId: string): Promise<InstallRow[]> {
  const { results } = await db
    .prepare("SELECT id, skill_id, pinned_ref, attestation_hash, installed_at, installer FROM installs WHERE skill_id = ? ORDER BY installed_at")
    .bind(skillId)
    .all<InstallRow>();
  return results;
}
