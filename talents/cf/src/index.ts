// Talents Worker (P2) — the full Cloudflare stack (ARCHITECTURE-v2 §6):
// built and served through @cloudflare/vite-plugin, data in D1, search
// via the Cloudflare-native FTS5-trigram engine, consumption via the
// aggregated marketplace + the MCP gateway at /mcp.
//
// The P1 pages are rendered by the SAME templates as the node:http
// server (../../src/render.ts — one design contract, two shells).

import {
  render404, renderHome, renderProfile, renderSearchPage, renderSkillPage,
} from "../../src/render.js";
import type { SkillRecord } from "../../src/types.js";
import { D1SearchEngine } from "../../src/search-d1.js";
import type { SearchQueryInput } from "../../src/search.js";
import { createAggregateBuilder, externalSourceViolations } from "../../src/aggregate.js";
import {
  createInstall, getRecord, installsFor, listedStats, logGatewayCall, recordsByOwner,
  recordsPage, unlistedSkillIds, type Env,
} from "./db.js";
import { handleMcpRequest, type GatewayDeps } from "./mcp.js";
import { clerkConfigured, resolveSession, type SessionUser } from "./auth.js";
import {
  allClaims, allOverrides, analyticsForOwner, catalogOwners, claimsByUser,
  gatewayPricing, gatewaySpendToken, gatewayTokenCheck, getClaim, getCreatorAccount,
  getOverride, getPurchaseBySession, handleCheckout, handleClaim, handleListingEdit,
  handlePayoutConnect, handlePayoutReturn, handleStripeWebhook, hasEntitlement,
  listingsForOwner, overridesFor, pickupInstallToken, type CreatorAccount,
} from "./creator.js";
import {
  renderAnalytics, renderCheckoutSuccess, renderDashboardHome, renderDashboardListings,
  renderListingEdit, renderSignIn, renderSignOut,
} from "./render-creator.js";
import { claimableOwner } from "../../src/creator/claims.js";
import { formatPrice } from "../../src/creator/fees.js";
import { isPriced, mergeForDisplay, toDisplayRecord } from "../../src/creator/overrides.js";
import { paymentsEnabledFor, stripeClientFromEnv } from "./stripe.js";
import { verifyRecordAttestation } from "./verify.js";
import { ENRICHMENT_REFRESH_CRON, enrichmentViewFor, handleAdminEnrich, handleEnrichmentRefresh, serveAsset } from "./enrichment.js";
import { enrichmentForIds } from "../../src/enrichment/store.js";
import { apiEnrichment, type ApiEnrichment } from "../../src/enrichment/display.js";
import { getAgentByName, routeAgentRequest } from "agents";
import { parseAdvisorGoal, type AdvisorReply } from "../../src/advisor.js";
import { TalentAdvisor } from "./advisor.js";
import {
  adminAuthorized, bumpDrainCounter, classifyDlqFailure, handleAdminDiscover, handleAdminDrainHealth, handleAdminEmbed, handleAdminEnqueueCandidates, handleAdminStatsRebuild, handleQueueMessage,
  handleScheduled, handleWebhook, hybridSearch, runDrainProducerTick, sweepDlq, suggestForSkill, trendingRecords,
  verifyWebhookSignature, DRAIN_PRODUCER_CRON, type IngestQueueMessage,
} from "./discovery.js";
import { D1DiscoveryStore } from "../../src/discovery/store.js";
import {
  DrainWorkflowDisabledError, DrainWorkflowLiveError, DrainWorkflowNoBindingError,
  drainWorkflowStatus, startDrainWorkflow,
} from "./drain-workflow-steps.js";
import type { PushPayload } from "../../src/webhook.js";

export type { Env };
export { TalentAdvisor };
export { TalentDrainWorkflow } from "./drain-workflow.js";

function html(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Fetch used for source re-verification: direct in production; via
 *  the local relay when TALENTS_SOURCE_RELAY is set (dev sandbox). */
function sourceFetch(env: Env): typeof fetch {
  const relay = env.TALENTS_SOURCE_RELAY;
  if (!relay) return fetch;
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(`${relay}/fetch?url=${encodeURIComponent(String(input))}`, init)) as typeof fetch;
}

function gatewayDeps(env: Env, engine: D1SearchEngine): GatewayDeps {
  return {
    // The engine reads `records` directly; owner-unlisted skills
    // (P4 opt-out) are filtered here as at every other surface.
    search: async (input) => {
      const results = await engine.search(input);
      const unlisted = await unlistedSkillIds(env.DB);
      return unlisted.size ? results.filter((r) => !unlisted.has(r.id)) : results;
    },
    get: (id) => getRecord(env.DB, id),
    log: (tool, skillId) => logGatewayCall(env.DB, tool, skillId),
    createInstall: (row) => createInstall(env.DB, row),
    verify: (record) => verifyRecordAttestation(record, sourceFetch(env)),
    pricing: (id) => gatewayPricing(env.DB, id),
    checkToken: (id, token) => gatewayTokenCheck(env.DB, id, token),
    spendToken: (tokenHash) => gatewaySpendToken(env.DB, tokenHash),
  };
}

/** Creator dashboard routes (P4) — the caller has already resolved
 *  (and required) the session. A namespace is manageable only by
 *  the user who claimed it. */
async function handleDashboard(env: Env, req: Request, url: URL, user: SessionUser): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p).toLowerCase());
  const claims = await claimsByUser(env.DB, user.clerkUserId);
  const claimedOwners = new Set(claims.map((c) => c.owner));
  const pickOwner = (): string | null => {
    const asked = url.searchParams.get("owner")?.toLowerCase();
    if (asked && claimedOwners.has(asked)) return asked;
    return claims[0]?.owner ?? null;
  };

  // /dashboard — identity, claim state, payouts panel.
  if (parts.length === 1) {
    if (req.method !== "GET") return html(405, render404("Method not allowed"));
    const owners = await catalogOwners(env.DB);
    const claimsMap = await allClaims(env.DB);
    const claimable = claimableOwner(user.githubLogin, owners.keys(), claimsMap, user.clerkUserId);
    const loginOwner = user.githubLogin?.toLowerCase() ?? null;
    const loginOwnerNotGithubBacked = Boolean(
      loginOwner && owners.has(loginOwner) && owners.get(loginOwner) === false && !claimedOwners.has(loginOwner),
    );
    const accounts = new Map<string, CreatorAccount>();
    for (const c of claims) {
      const account = await getCreatorAccount(env.DB, c.owner);
      if (account) accounts.set(c.owner, account);
    }
    return html(200, renderDashboardHome({
      user,
      claims,
      claimableOwner: claimable && owners.get(claimable) !== false ? claimable : null,
      loginOwnerNotGithubBacked,
      accounts,
      paymentsConfigured: Boolean(env.STRIPE_SECRET_KEY),
    }));
  }

  // /dashboard/payouts/return — refresh Connect status from Stripe.
  if (parts.length === 3 && parts[1] === "payouts" && parts[2] === "return") {
    return handlePayoutReturn(env, user, stripeClientFromEnv(env));
  }
  // /dashboard/payouts/refresh — Stripe sent us back because the
  // onboarding link expired: mint a fresh one.
  if (parts.length === 3 && parts[1] === "payouts" && parts[2] === "refresh") {
    return handlePayoutConnect(env, user, stripeClientFromEnv(env), url.origin);
  }

  // /dashboard/listings — the claimed namespace's listing manager.
  if (parts.length === 2 && parts[1] === "listings") {
    if (req.method !== "GET") return html(405, render404("Method not allowed"));
    const owner = pickOwner();
    if (!owner) return redirect("/dashboard");
    const listings = await listingsForOwner(env.DB, owner);
    return html(200, renderDashboardListings(owner, listings));
  }

  // /dashboard/listings/{owner}/{name} — edit one listing.
  if (parts.length === 4 && parts[1] === "listings") {
    const owner = parts[2];
    const name = parts[3];
    if (!claimedOwners.has(owner)) {
      return html(403, render404(`namespace "${owner}" is not claimed by you`));
    }
    const listings = await listingsForOwner(env.DB, owner);
    const listing = listings.find((l) => l.record.id === `${owner}/${name}`);
    if (!listing) return html(404, render404(`${owner}/${name}`));
    if (req.method === "POST") {
      const result = await handleListingEdit(env, user, owner, name, req);
      if (!result.ok) {
        return html(400, renderListingEdit(owner, listing, { error: result.error }));
      }
      return redirect(`/dashboard/listings/${owner}/${name}?saved=1`);
    }
    if (req.method !== "GET") return html(405, render404("Method not allowed"));
    return html(200, renderListingEdit(owner, listing, { saved: url.searchParams.get("saved") === "1" }));
  }

  // /dashboard/analytics — per-listing + totals for the namespace.
  if (parts.length === 2 && parts[1] === "analytics") {
    if (req.method !== "GET") return html(405, render404("Method not allowed"));
    const owner = pickOwner();
    if (!owner) return redirect("/dashboard");
    const analytics = await analyticsForOwner(env.DB, owner);
    return html(200, renderAnalytics(owner, analytics));
  }

  return html(404, render404(url.pathname));
}

const RESERVED = new Set([
  "search", "s", "skills", "mcp", "api", "advisor", "admin", "webhooks", ".claude-plugin",
  "dashboard", "sign-in", "sign-out", "checkout",
]);

function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { location } });
}

/** Enrichment fragments for API result sets (Tranche 2): structured
 *  layer state + completeness + trust, with generated content kept
 *  under its own `generated` key by the callers. Enrichment is
 *  additive only — any failure degrades to no fragments. */
async function enrichmentFragments(env: Env, records: SkillRecord[]): Promise<Map<string, ApiEnrichment>> {
  const out = new Map<string, ApiEnrichment>();
  if (!records.length) return out;
  try {
    const rows = await enrichmentForIds(env.DB, records.map((r) => r.id));
    for (const r of records) {
      const frag = apiEnrichment(r, rows.get(r.id) ?? null);
      if (frag) out.set(r.id, frag);
    }
  } catch {
    // Pre-0006 schema or a transient D1 error: APIs answer without.
  }
  return out;
}

/** Split a fragment into the `enrichment` object (state/trust) and
 *  the top-level `generated` object — generated fields are NEVER
 *  merged into source description fields. */
function splitFragment(frag: ApiEnrichment | undefined): Record<string, unknown> {
  if (!frag) return {};
  const { generated, ...rest } = frag;
  return { enrichment: rest, ...(generated ? { generated } : {}) };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const engine = new D1SearchEngine(env.DB);
    try {
      // --- Aggregated marketplace: entries point at original sources.
      // Source metadata is published verbatim (creator overrides do
      // NOT merge here); owner-unlisted records are excluded (P4).
      // Paged build (gate-d1size): the catalog is 53.5 MB of
      // record_json — a full-table load 500s under D1's 50 MB
      // response limit, so the doc is built 500 records at a time.
      if (url.pathname === "/.claude-plugin/marketplace.json") {
        const unlisted = await unlistedSkillIds(env.DB);
        const builder = createAggregateBuilder({ excludeIds: unlisted });
        let cursor: string | null = null;
        for (;;) {
          const page = await recordsPage(env.DB, cursor, 500);
          if (!page.length) break;
          builder.addPage(page);
          if (page.length < 500) break;
          cursor = page[page.length - 1].id;
        }
        const { doc } = builder.finish();
        const violations = externalSourceViolations(doc);
        return Response.json(doc, {
          headers: violations.length
            ? { "x-talents-origin-violations": String(violations.length) }
            : {},
        });
      }

      // --- MCP gateway.
      if (url.pathname === "/mcp") {
        return handleMcpRequest(req, gatewayDeps(env, engine));
      }

      // --- JSON search: hybrid (FTS + intent expansions + Vectorize,
      // query-length weighted, behaviorally re-ranked) — P5. Every
      // semantic/behavioral layer degrades gracefully to the D1
      // keyword order; see cf/src/discovery.ts.
      if (url.pathname === "/api/search") {
        const input: SearchQueryInput = {
          q: url.searchParams.get("q") ?? "",
          kind: url.searchParams.get("kind") || undefined,
          owner: url.searchParams.get("owner") || undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        };
        const hybrid = await hybridSearch(env, engine, input);
        // Creator overrides merge at render time (P4): the displayed
        // description is the publisher's when one is set.
        const overrides = await overridesFor(env.DB, hybrid.results.map((r) => r.id));
        // Enrichment fragments (Tranche 2): structured layer state
        // under `enrichment`, generated content under `generated` —
        // never merged into `description`.
        const fragments = await enrichmentFragments(env, hybrid.results);
        return Response.json({
          engine: hybrid.vectorUsed ? "d1+vectorize" : "d1",
          ...(hybrid.vectorError ? { vectorError: hybrid.vectorError } : {}),
          query: input,
          count: hybrid.results.length,
          partial: hybrid.partial,
          missingTokens: hybrid.missingTokens,
          note: hybrid.note,
          stack: hybrid.stack,
          results: hybrid.results.map((r) => {
            const display = toDisplayRecord(r, overrides.get(r.id));
            return {
              id: r.id,
              url: r.url,
              kind: r.kind,
              description: display.description,
              publisherDescription: display.descriptionIsPublisher,
              ...(display.priceCents ? { priceCents: display.priceCents, currency: display.currency } : {}),
              declaration: r.declaration.summary[0] ?? "",
              attested: r.attestation !== null,
              ...splitFragment(fragments.get(r.id)),
            };
          }),
        });
      }

      // --- Trending: gateway-call velocity with an honest static
      // fallback when activity is too thin (P5).
      if (url.pathname === "/api/trending") {
        const t = await trendingRecords(env);
        return Response.json({
          mode: t.mode,
          floor: t.floor,
          count: t.results.length,
          results: t.results.map((r) => ({ id: r.id, url: r.url, kind: r.kind })),
        });
      }

      // --- In-context suggestions: related skills for a record, or
      // goal matches (keyword+vector, no LLM) — P5.
      if (url.pathname === "/api/suggest") {
        const skill = url.searchParams.get("skill");
        const goal = url.searchParams.get("goal");
        if (skill) {
          const related = await suggestForSkill(env, skill.toLowerCase());
          if (!related) return Response.json({ error: `unknown skill: ${skill}` }, { status: 404 });
          const fragments = await enrichmentFragments(env, related);
          return Response.json({
            skill: skill.toLowerCase(),
            results: related.map((r) => ({
              id: r.id, url: r.url, kind: r.kind, description: r.description,
              ...splitFragment(fragments.get(r.id)),
            })),
          });
        }
        if (goal) {
          const hybrid = await hybridSearch(env, engine, { q: goal, limit: 8 });
          const fragments = await enrichmentFragments(env, hybrid.results);
          return Response.json({
            goal,
            stack: hybrid.stack,
            results: hybrid.results.map((r) => ({
              id: r.id, url: r.url, kind: r.kind, description: r.description,
              ...splitFragment(fragments.get(r.id)),
            })),
          });
        }
        return Response.json({ error: "pass ?skill={owner/name} or ?goal={text}" }, { status: 400 });
      }

      // --- GitHub webhook freshness: a push touching
      // marketplace.json / plugin.json / SKILL.md enqueues a
      // re-ingest of that repo. HMAC-verified when WEBHOOK_SECRET
      // is set; accept-and-log dev mode otherwise (README, P5).
      if (url.pathname === "/webhooks/github") {
        if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
        const raw = await req.text();
        if (env.WEBHOOK_SECRET) {
          const ok = await verifyWebhookSignature(env.WEBHOOK_SECRET, raw, req.headers.get("x-hub-signature-256"));
          if (!ok) return Response.json({ error: "signature verification failed" }, { status: 401 });
        }
        let payload: PushPayload & { repository?: { full_name?: string } };
        try {
          payload = JSON.parse(raw) as PushPayload & { repository?: { full_name?: string } };
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const outcome = await handleWebhook(env, payload);
        return Response.json({ ...outcome, signatureChecked: Boolean(env.WEBHOOK_SECRET) });
      }

      // --- Stripe webhook (P4): signature-verified purchase
      // fulfilment. Unconfigured (no STRIPE_WEBHOOK_SECRET) → 503,
      // never an unverified accept.
      if (url.pathname === "/webhooks/stripe") {
        if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
        return handleStripeWebhook(env, req);
      }

      // --- Creator Experience (P4): identity, claims, listings,
      // payouts, checkout. Auth-gated routes resolve the Clerk
      // session first; without one, pages redirect to /sign-in and
      // APIs answer 401.
      if (url.pathname === "/sign-in" && req.method === "GET") {
        return html(200, renderSignIn({ publishableKey: clerkConfigured(env) ? (env.CLERK_PUBLISHABLE_KEY ?? null) : null }));
      }
      if (url.pathname === "/sign-out" && req.method === "GET") {
        const res = html(200, renderSignOut(env.CLERK_PUBLISHABLE_KEY ?? null));
        // Expire the session cookie server-side as well (Clerk JS
        // sign-out on the page handles the Clerk-side state).
        res.headers.append("set-cookie", "__session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
        return res;
      }
      if (url.pathname === "/api/claims") {
        if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
        const user = await resolveSession(env, req);
        if (!user) return Response.json({ error: "sign-in required" }, { status: 401 });
        return handleClaim(env, user, req);
      }
      if (url.pathname === "/api/payouts/connect") {
        if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
        const user = await resolveSession(env, req);
        if (!user) return redirect("/sign-in");
        return handlePayoutConnect(env, user, stripeClientFromEnv(env), url.origin);
      }
      if (url.pathname.startsWith("/api/checkout/")) {
        if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
        const segs = url.pathname.split("/").filter(Boolean);
        if (segs.length !== 4) return Response.json({ error: "expected /api/checkout/{owner}/{name}" }, { status: 404 });
        const buyer = await resolveSession(env, req);
        return handleCheckout(
          env, stripeClientFromEnv(env), (id) => getRecord(env.DB, id), buyer,
          decodeURIComponent(segs[2]).toLowerCase(), decodeURIComponent(segs[3]).toLowerCase(), url.origin,
        );
      }
      if (url.pathname === "/checkout/success" && req.method === "GET") {
        const sessionId = url.searchParams.get("session_id") ?? "";
        if (!sessionId) return html(200, renderCheckoutSuccess({ kind: "unknown" }));
        const purchase = await getPurchaseBySession(env.DB, sessionId);
        if (!purchase) {
          // Webhook may lag the buyer's return by seconds.
          return html(200, renderCheckoutSuccess({ kind: "processing" }));
        }
        const pickup = await pickupInstallToken(env.DB, sessionId);
        if (!pickup) return html(200, renderCheckoutSuccess({ kind: "already-picked-up", skillId: purchase.skillId }));
        return html(200, renderCheckoutSuccess({ kind: "token", token: pickup.token, skillId: pickup.skillId }));
      }
      if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
        const user = await resolveSession(env, req);
        if (!user) return redirect("/sign-in");
        return handleDashboard(env, req, url, user);
      }

      // --- Admin discovery triggers (token-gated; 404 when the
      // ADMIN_TOKEN secret is unset, so the routes simply do not
      // exist on deployments that have not opted in).
      if (url.pathname === "/admin/drain-health") {
        if (!env.ADMIN_TOKEN) return html(404, render404(url.pathname));
        if (req.method !== "GET") return Response.json({ error: "GET only" }, { status: 405 });
        if (!adminAuthorized(env, req)) return Response.json({ error: "unauthorized" }, { status: 401 });
        try {
          return Response.json(await handleAdminDrainHealth(env) as Record<string, unknown>);
        } catch (e) {
          return Response.json({ error: `drain health failed: ${(e as Error).message}` }, { status: 500 });
        }
      }
      // --- Drain Workflow orchestrator (gate-queue-workflow): the
      // Workflow replaces the producer cron + flag + watchdog as
      // the backlog feeder. GET /admin/drain-workflow/status
      // reports the live instance + drain health; POST
      // /admin/drain-workflow/start starts ONE instance (flag-
      // gated by QUEUE_DRAIN_ENABLED, refuses while one is live).
      // Both are ADMIN_TOKEN-gated like the other admin routes.
      if (url.pathname === "/admin/drain-workflow/status") {
        if (!env.ADMIN_TOKEN) return html(404, render404(url.pathname));
        if (req.method !== "GET") return Response.json({ error: "GET only" }, { status: 405 });
        if (!adminAuthorized(env, req)) return Response.json({ error: "unauthorized" }, { status: 401 });
        try {
          return Response.json(await drainWorkflowStatus(env) as Record<string, unknown>);
        } catch (e) {
          return Response.json({ error: `drain workflow status failed: ${(e as Error).message}` }, { status: 500 });
        }
      }
      if (url.pathname === "/admin/drain-workflow/start") {
        if (!env.ADMIN_TOKEN) return html(404, render404(url.pathname));
        if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
        if (!adminAuthorized(env, req)) return Response.json({ error: "unauthorized" }, { status: 401 });
        let body: unknown = {};
        try { body = await req.json(); } catch { /* empty body = defaults */ }
        try {
          return Response.json(await startDrainWorkflow(env, body) as Record<string, unknown>);
        } catch (e) {
          if (e instanceof DrainWorkflowDisabledError || e instanceof DrainWorkflowLiveError) {
            return Response.json({ error: e.message }, { status: 409 });
          }
          if (e instanceof DrainWorkflowNoBindingError) {
            return Response.json({ error: e.message }, { status: 503 });
          }
          return Response.json({ error: `drain workflow start failed: ${(e as Error).message}` }, { status: 500 });
        }
      }
      if (url.pathname === "/admin/discover" || url.pathname === "/admin/embed" || url.pathname === "/admin/enrich" || url.pathname === "/admin/enqueue-candidates" || url.pathname === "/admin/dlq-sweep" || url.pathname === "/admin/stats-rebuild") {
        if (!env.ADMIN_TOKEN) return html(404, render404(url.pathname));
        if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
        if (!adminAuthorized(env, req)) return Response.json({ error: "unauthorized" }, { status: 401 });
        let body: { limit?: number; cursor?: string; sweepCap?: number; perQuery?: number; maxIngest?: number; layers?: string[] } = {};
        try { body = (await req.json()) as typeof body; } catch { /* empty body = defaults */ }
        try {
          const out = url.pathname === "/admin/discover"
            ? await handleAdminDiscover(env, body)
            : url.pathname === "/admin/enrich"
              ? await handleAdminEnrich(env, body)
              : url.pathname === "/admin/enqueue-candidates"
                ? await handleAdminEnqueueCandidates(env, body)
                : url.pathname === "/admin/dlq-sweep"
                  ? await sweepDlq(env, body)
                  : url.pathname === "/admin/stats-rebuild"
                    ? await handleAdminStatsRebuild(env, body)
                    : await handleAdminEmbed(env, body);
          return Response.json(out as Record<string, unknown>);
        } catch (e) {
          return Response.json({ error: `admin action failed: ${(e as Error).message}` }, { status: 500 });
        }
      }

      // --- Enrichment display assets (Tranche 1): README text and
      // icon images served from our R2 copies, keyed by skill id.
      if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const segs = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
        if (segs.length === 4 && (segs[1] === "icon" || segs[1] === "readme")) {
          return serveAsset(env, segs[1], `${segs[2].toLowerCase()}/${segs[3].toLowerCase()}`);
        }
        return html(404, render404(url.pathname));
      }

      // --- Install receipts (ops visibility for the gateway).
      if (url.pathname === "/api/installs") {
        const skill = url.searchParams.get("skill") ?? "";
        const rows = skill ? await installsFor(env.DB, skill.toLowerCase()) : [];
        return Response.json({ skill, installs: rows });
      }

      // --- Think advisor (Agents SDK routing: WebSocket chat transport).
      if (url.pathname.startsWith("/agents/")) {
        const routed = await routeAgentRequest(req, env);
        if (routed) return routed;
        return Response.json({ error: "unknown agent route" }, { status: 404 });
      }

      // --- Advisor: POST /advisor { goal } → matching skills.
      // Fails closed when the ANTHROPIC_API_KEY secret is absent or the
      // model call fails — the upstream error is never leaked.
      if (url.pathname === "/advisor") {
        if (req.method !== "POST") {
          return Response.json({ error: "POST a JSON body: { \"goal\": \"…\" }" }, { status: 405 });
        }
        if (!env.ANTHROPIC_API_KEY) {
          return Response.json({ error: "advisor not configured" }, { status: 503 });
        }
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "request body must be JSON" }, { status: 400 });
        }
        const parsed = parseAdvisorGoal(body);
        if (!parsed.goal) {
          return Response.json({ error: parsed.error ?? "invalid goal" }, { status: 400 });
        }
        const stub = (await getAgentByName(
          env.TalentAdvisor as DurableObjectNamespace<TalentAdvisor>,
          `advisor-${crypto.randomUUID()}`,
        )) as unknown as { advise(goal: string): Promise<AdvisorReply> };
        const reply = await stub.advise(parsed.goal);
        if (!reply.configured) {
          return Response.json({ error: "advisor not configured" }, { status: 503 });
        }
        if (!reply.ok) {
          return Response.json(
            { error: "advisor request failed", errorKind: reply.errorKind ?? "other" },
            { status: 502 },
          );
        }
        return Response.json({
          goal: parsed.goal,
          model: reply.model,
          answer: reply.answer ?? "",
          matches: reply.matches ?? [],
        });
      }

      // --- Pages (P1 templates, D1-backed).
      if (req.method !== "GET") return html(405, render404("Method not allowed"));
      const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p).toLowerCase());

      if (parts.length === 0) {
        // Bounded home (gate-d1size): the page renders only the
        // trending rail (8 records, by id) plus catalog totals as
        // aggregates — the old allRecords load is 53.5 MB and 500s.
        // The velocity rail is identical; the static fallback rail
        // comes from trendingRecords' bounded pool.
        const overrides = await allOverrides(env.DB);
        const stats = await listedStats(env.DB);
        const t = await trendingRecords(env);
        const display = mergeForDisplay(t.results, overrides);
        return html(200, renderHome(display, {
          trending: display,
          ...(t.mode === "velocity"
            ? { trendingNote: "ranked by gateway-call velocity — what agents actually used this week (P5 behavioral ranking)" }
            : {}),
          counts: { total: stats.count, owners: stats.owners },
        }));
      }
      if (parts[0] === "search" && parts.length === 1) {
        const input: SearchQueryInput = {
          q: url.searchParams.get("q") ?? "",
          kind: url.searchParams.get("kind") || undefined,
          owner: url.searchParams.get("owner") || undefined,
        };
        const hybrid = await hybridSearch(env, engine, input);
        const overrides = await overridesFor(env.DB, hybrid.results.map((r) => r.id));
        return html(200, renderSearchPage(input, mergeForDisplay(hybrid.results, overrides), hybrid.note));
      }
      if (parts[0] === "s" && parts.length === 3) {
        return new Response(null, { status: 301, headers: { location: `/skills/${parts[1]}/${parts[2]}` } });
      }
      if (parts[0] === "skills" && parts.length === 3) {
        const r = await getRecord(env.DB, `${parts[1]}/${parts[2]}`);
        if (!r) return html(404, render404(`${parts[1]}/${parts[2]}`));
        let related: Awaited<ReturnType<typeof suggestForSkill>> = null;
        try { related = await suggestForSkill(env, r.id); } catch { related = null; }
        // Creator layer (P4): display merge (attested record itself
        // is never mutated), verified-publisher badge, price panel.
        const override = await getOverride(env.DB, r.id);
        const display = toDisplayRecord(r, override);
        const claim = await getClaim(env.DB, r.owner);
        const displayRecord = display.descriptionIsPublisher
          ? { ...r, description: display.description }
          : r;
        let purchase: {
          priceFormatted: string; exclusive: boolean; paymentsEnabled: boolean;
          buyerEntitled: boolean; isOwner?: boolean;
        } | undefined;
        if (isPriced(override)) {
          const account = await getCreatorAccount(env.DB, r.owner);
          let buyerEntitled = false;
          let isOwner = false;
          const session = await resolveSession(env, req);
          if (session) {
            buyerEntitled = await hasEntitlement(env.DB, r.id, { clerkUserId: session.clerkUserId });
            isOwner = claim?.clerkUserId === session.clerkUserId;
          }
          purchase = {
            priceFormatted: formatPrice(display.priceCents!, display.currency),
            exclusive: display.exclusive,
            paymentsEnabled: paymentsEnabledFor(env, account),
            buyerEntitled,
            isOwner,
          };
        }
        // Enrichment (Tranche 1): source facts, README excerpt,
        // sub-inventory, introspected tools — additive panels,
        // absent entirely for unenriched records.
        const enrichment = await enrichmentViewFor(env, r);
        return html(200, renderSkillPage(displayRecord, {
          related: related ?? undefined,
          verifiedPublisher: Boolean(claim),
          publisherDescription: display.descriptionIsPublisher,
          purchase,
          enrichment: enrichment ?? undefined,
        }));
      }
      if (parts.length === 1 && !RESERVED.has(parts[0])) {
        const owned = await recordsByOwner(env.DB, parts[0]);
        if (owned.length === 0) return html(404, render404(parts[0]));
        const claim = await getClaim(env.DB, parts[0]);
        const overrides = await overridesFor(env.DB, owned.map((r) => r.id));
        // Registry-label namespaces (MCP feed) have no GitHub
        // identity: say plainly that GitHub claim doesn't apply.
        // Backed = a record whose repo is owned by THIS namespace
        // (an MCP record pointing at someone else's repo doesn't count).
        const githubBacked = owned.some(
          (r) => r.sourceRepo?.split("/")[0]?.toLowerCase() === parts[0],
        );
        return html(200, renderProfile(parts[0], mergeForDisplay(owned, overrides), {
          verified: Boolean(claim),
          claimNote: !claim && !githubBacked
            ? "This namespace comes from the MCP Registry, not a GitHub account — claim is not available via GitHub sign-in."
            : undefined,
        }));
      }
      return html(404, render404(url.pathname));
    } catch (e) {
      return html(500, render404(`Something went wrong: ${(e as Error).message}`));
    }
  },

  // Cron dispatch by trigger expression:
  //   - daily discovery (P5): sweep → verify → enqueue verified
  //     sources on INGEST_QUEUE; the consumer below ingests them.
  //   - weekly enrichment refresh (Tranche 2, Mondays 05:41 UTC):
  //     layers A + C cadence refresh in traffic order.
  async scheduled(event: { cron?: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    if (event?.cron === ENRICHMENT_REFRESH_CRON) {
      ctx.waitUntil(handleEnrichmentRefresh(env));
      return;
    }
    // Dedicated drain producer (hardening, 2026-11-11): its own
    // 10-minute trigger, dispatched separately from the daily
    // scout cron so the two never share a run.
    if (event?.cron === DRAIN_PRODUCER_CRON) {
      ctx.waitUntil(runDrainProducerTick(env));
      return;
    }
    ctx.waitUntil(handleScheduled(env));
  },

  // Ingest queue consumer (P5): one source per message.
  async queue(
    batch: { messages: { id: string; attempts?: number; body: IngestQueueMessage; ack(): void; retry(): void }[] },
    env: Env,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleQueueMessage(env, message.body, { messageId: message.id });
        message.ack();
      } catch (e) {
        console.error(`ingest queue: ${(e as Error).message}`);
        // DLQ manifest (drain hardening): on the FINAL attempt
        // (1 + max_retries 3 = 4), record the arrival in D1 with
        // its failure class and bump the drain:dlq counter — the
        // Cloudflare DLQ itself has no read API for the Worker,
        // so this manifest is the operator's view of it. The
        // source row stays a candidate, so the DLQ sweep can
        // re-enqueue it. Bookkeeping never breaks the retry.
        // (Cloudflare populates message.attempts; a missing value
        // degrades to 0, which only delays the manifest — the
        // message still dead-letters at the platform level.)
        const attempts = message.attempts ?? 0;
        if (attempts >= 4) {
          try {
            const store = new D1DiscoveryStore(env.DB);
            const found = await store.getSourceByLocator(message.body.locator);
            const kind = found?.kind ?? message.body.kind ?? "skill-repo";
            const now = new Date().toISOString();
            const existing = (await store.listDlqEntries()).find(
              (d) => d.kind === kind && d.locator === message.body.locator,
            );
            await store.recordDlqEntry({
              kind,
              locator: message.body.locator,
              failureClass: classifyDlqFailure(e),
              attempts,
              firstSeen: existing?.firstSeen ?? now,
              lastSeen: now,
              error: (e as Error).message.slice(0, 200),
            });
            await bumpDrainCounter(store, "drain:dlq", 1);
          } catch { /* DLQ bookkeeping must never break the retry */ }
        }
        message.retry();
      }
    }
  },
};
