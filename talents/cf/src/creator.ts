// Creator Experience (P4) — D1 store + route handlers for claims,
// listing overrides, unlisting, Stripe Connect, purchases,
// entitlements and install tokens. All DECISION logic lives in the
// pure modules under ../../src/creator/ (unit-tested); this file is
// the I/O glue: SQL + HTTP shapes + the Stripe client seam.

import type { SkillRecord } from "../../src/types.js";
import type { D1Like } from "../../src/search-d1.js";
import { decideClaim, ownerIsGithubBacked, type Claim } from "../../src/creator/claims.js";
import {
  normalizeListingEdit, type ListingOverride,
} from "../../src/creator/overrides.js";
import {
  verifyStripeSignature, parseStripeEvent, purchaseFromCheckoutSession,
  type CheckoutSessionObject,
} from "../../src/creator/stripe.js";
import {
  checkPurchaseToken, generatePurchaseToken, sha256Hex, TOKEN_TTL_DAYS,
  type TokenRow,
} from "../../src/creator/access.js";
import { splitPrice } from "../../src/creator/fees.js";
import { enrichmentForIds } from "../../src/enrichment/store.js";
import { apiEnrichment, type ApiEnrichment } from "../../src/enrichment/display.js";
import type { EnrichmentRow } from "../../src/enrichment/types.js";
import {
  aggregateOwnerAnalytics, type ListingStatsRow, type OwnerAnalytics,
} from "../../src/creator/analytics.js";
import type { SessionUser } from "./auth.js";
import { paymentsEnabledFor, type StripeClient } from "./stripe.js";
import type { Env } from "./db.js";

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

interface ClaimRow { owner: string; clerk_user_id: string; github_login: string; method: string; claimed_at: string }

const claimFromRow = (r: ClaimRow): Claim => ({
  owner: r.owner, clerkUserId: r.clerk_user_id, githubLogin: r.github_login,
  method: r.method as Claim["method"], claimedAt: r.claimed_at,
});

export async function getClaim(db: D1Like, owner: string): Promise<Claim | null> {
  try {
    const row = await db
      .prepare("SELECT owner, clerk_user_id, github_login, method, claimed_at FROM claims WHERE owner = ?")
      .bind(owner.toLowerCase())
      .first<ClaimRow>();
    return row ? claimFromRow(row) : null;
  } catch { return null; }
}

export async function claimsByUser(db: D1Like, clerkUserId: string): Promise<Claim[]> {
  try {
    const { results } = await db
      .prepare("SELECT owner, clerk_user_id, github_login, method, claimed_at FROM claims WHERE clerk_user_id = ? ORDER BY owner")
      .bind(clerkUserId)
      .all<ClaimRow>();
    return results.map(claimFromRow);
  } catch { return []; }
}

export async function allClaims(db: D1Like): Promise<Map<string, Claim>> {
  try {
    const { results } = await db
      .prepare("SELECT owner, clerk_user_id, github_login, method, claimed_at FROM claims")
      .all<ClaimRow>();
    return new Map(results.map((r) => [r.owner, claimFromRow(r)]));
  } catch { return new Map(); }
}

/** All catalog owners + whether each is GitHub-backed (claimable in
 *  principle). Records are the source of truth — see claims.ts.
 *
 *  Single query, not one per owner: the per-owner loop issued
 *  1 + DISTINCT-owner-count D1 calls per dashboard/claim request
 *  (1,075 at 22,407 listed records, 2026-11-11) — past the Workers
 *  1,000-subrequest-per-request ceiling, so /dashboard 500'd for
 *  every signed-in user once the catalog grew past ~1,000 owners.
 *  One (owner, source_repo) scan is ~1 MB at this catalog size and
 *  groups to the identical Map. */
export async function catalogOwners(db: D1Like): Promise<Map<string, boolean>> {
  const { results } = await db
    .prepare("SELECT owner, source_repo FROM records WHERE status = 'listed'")
    .all<{ owner: string; source_repo: string | null }>();
  const byOwner = new Map<string, { sourceRepo?: string }[]>();
  for (const r of results) {
    const list = byOwner.get(r.owner) ?? [];
    list.push({ sourceRepo: r.source_repo ?? undefined });
    byOwner.set(r.owner, list);
  }
  const out = new Map<string, boolean>();
  for (const [owner, recs] of byOwner) {
    out.set(owner, ownerIsGithubBacked(owner, recs));
  }
  return out;
}

/** Attempt a web claim for the signed-in user. The decision itself
 *  is decideClaim (pure); this adds persistence + the FCFS race
 *  guard (PRIMARY KEY on owner). */
export async function attemptClaim(
  db: D1Like,
  user: SessionUser,
  ownerRaw: string,
): Promise<{ ok: true; claim: Claim } | { ok: false; reason: string }> {
  const owner = ownerRaw.toLowerCase();
  const owners = await catalogOwners(db);
  if (!owners.has(owner)) return { ok: false, reason: `namespace "${owner}" has no listings in the catalog yet` };
  const existing = await getClaim(db, owner);
  const decision = decideClaim(owner, user.clerkUserId, {
    githubLogin: user.githubLogin,
    existingClaim: existing,
    githubBacked: owners.get(owner) ?? false,
  });
  if (!decision.ok) return { ok: false, reason: decision.reason };
  if (existing && existing.clerkUserId === user.clerkUserId) return { ok: true, claim: existing };
  const claim: Claim = {
    owner,
    clerkUserId: user.clerkUserId,
    githubLogin: user.githubLogin ?? "",
    method: decision.method,
    claimedAt: new Date().toISOString(),
  };
  try {
    await db
      .prepare("INSERT INTO claims (owner, clerk_user_id, github_login, method, claimed_at) VALUES (?, ?, ?, ?, ?)")
      .bind(claim.owner, claim.clerkUserId, claim.githubLogin, claim.method, claim.claimedAt)
      .run();
  } catch {
    // Lost a first-come-first-served race between check and insert.
    const now = await getClaim(db, owner);
    if (now && now.clerkUserId === user.clerkUserId) return { ok: true, claim: now };
    return { ok: false, reason: `namespace "${owner}" is already claimed` };
  }
  // Mirror into the P0 namespaces table so the engine's original
  // claim model and the web claims never diverge.
  try {
    await db
      .prepare(
        `INSERT INTO namespaces (owner, claimed_by, claimed_at, verified) VALUES (?, ?, ?, 1)
         ON CONFLICT(owner) DO NOTHING`,
      )
      .bind(owner, claim.githubLogin, claim.claimedAt)
      .run();
  } catch { /* namespaces mirror is best-effort */ }
  return { ok: true, claim };
}

// ---------------------------------------------------------------------------
// Listing overrides + unlisting
// ---------------------------------------------------------------------------

interface OverrideRow {
  skill_id: string; description_override: string | null; tags: string | null;
  price_cents: number | null; currency: string; exclusive: number;
  updated_at: string; updated_by: string;
}

const overrideFromRow = (r: OverrideRow): ListingOverride => ({
  skillId: r.skill_id,
  descriptionOverride: r.description_override,
  tags: r.tags ? (JSON.parse(r.tags) as string[]) : null,
  priceCents: r.price_cents,
  currency: r.currency,
  exclusive: r.exclusive === 1,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

const OVERRIDE_COLS = "skill_id, description_override, tags, price_cents, currency, exclusive, updated_at, updated_by";

export async function getOverride(db: D1Like, skillId: string): Promise<ListingOverride | null> {
  try {
    const row = await db
      .prepare(`SELECT ${OVERRIDE_COLS} FROM listing_overrides WHERE skill_id = ?`)
      .bind(skillId.toLowerCase())
      .first<OverrideRow>();
    return row ? overrideFromRow(row) : null;
  } catch { return null; }
}

export async function overridesFor(db: D1Like, skillIds: string[]): Promise<Map<string, ListingOverride>> {
  const out = new Map<string, ListingOverride>();
  if (!skillIds.length) return out;
  try {
    const placeholders = skillIds.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT ${OVERRIDE_COLS} FROM listing_overrides WHERE skill_id IN (${placeholders})`)
      .bind(...skillIds.map((s) => s.toLowerCase()))
      .all<OverrideRow>();
    for (const r of results) out.set(r.skill_id, overrideFromRow(r));
  } catch { /* pre-0005 schema: no overrides */ }
  return out;
}

export async function allOverrides(db: D1Like): Promise<Map<string, ListingOverride>> {
  try {
    const { results } = await db.prepare(`SELECT ${OVERRIDE_COLS} FROM listing_overrides`).all<OverrideRow>();
    return new Map(results.map((r) => [r.skill_id, overrideFromRow(r)]));
  } catch { return new Map(); }
}

export async function setOverride(
  db: D1Like,
  skillId: string,
  user: SessionUser,
  input: { description?: string | null; tags?: string | null; price?: string | null; exclusive?: boolean },
): Promise<{ ok: true; override: ListingOverride } | { ok: false; error: string }> {
  const normalized = normalizeListingEdit(input);
  if (!normalized.ok) return normalized;
  const override: ListingOverride = {
    skillId: skillId.toLowerCase(),
    descriptionOverride: normalized.descriptionOverride,
    tags: normalized.tags,
    priceCents: normalized.priceCents,
    currency: "usd",
    exclusive: normalized.exclusive,
    updatedAt: new Date().toISOString(),
    updatedBy: user.clerkUserId,
  };
  await db
    .prepare(
      `INSERT INTO listing_overrides (${OVERRIDE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_id) DO UPDATE SET description_override = excluded.description_override,
         tags = excluded.tags, price_cents = excluded.price_cents, currency = excluded.currency,
         exclusive = excluded.exclusive, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(override.skillId, override.descriptionOverride,
      override.tags ? JSON.stringify(override.tags) : null,
      override.priceCents, override.currency, override.exclusive ? 1 : 0,
      override.updatedAt, override.updatedBy)
    .run();
  return { ok: true, override };
}

export async function setUnlisted(db: D1Like, skillId: string, user: SessionUser, unlist: boolean): Promise<void> {
  if (unlist) {
    await db
      .prepare(
        `INSERT INTO unlisted_skills (skill_id, unlisted_by, unlisted_at) VALUES (?, ?, ?)
         ON CONFLICT(skill_id) DO NOTHING`,
      )
      .bind(skillId.toLowerCase(), user.clerkUserId, new Date().toISOString())
      .run();
  } else {
    await db.prepare("DELETE FROM unlisted_skills WHERE skill_id = ?").bind(skillId.toLowerCase()).run();
  }
}

export async function unlistedSet(db: D1Like): Promise<Set<string>> {
  try {
    const { results } = await db.prepare("SELECT skill_id FROM unlisted_skills").all<{ skill_id: string }>();
    return new Set(results.map((r) => r.skill_id));
  } catch { return new Set(); }
}

// ---------------------------------------------------------------------------
// Creator (Stripe Connect) accounts + purchases + entitlements
// ---------------------------------------------------------------------------

export interface CreatorAccount {
  owner: string;
  stripeAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardedAt: string | null;
}

interface CreatorAccountRow {
  owner: string; stripe_account_id: string; charges_enabled: number;
  payouts_enabled: number; onboarded_at: string | null;
}

const accountFromRow = (r: CreatorAccountRow): CreatorAccount => ({
  owner: r.owner, stripeAccountId: r.stripe_account_id,
  chargesEnabled: r.charges_enabled === 1, payoutsEnabled: r.payouts_enabled === 1,
  onboardedAt: r.onboarded_at,
});

export async function getCreatorAccount(db: D1Like, owner: string): Promise<CreatorAccount | null> {
  try {
    const row = await db
      .prepare("SELECT owner, stripe_account_id, charges_enabled, payouts_enabled, onboarded_at FROM creator_accounts WHERE owner = ?")
      .bind(owner.toLowerCase())
      .first<CreatorAccountRow>();
    return row ? accountFromRow(row) : null;
  } catch { return null; }
}

export async function upsertCreatorAccount(db: D1Like, account: CreatorAccount): Promise<void> {
  await db
    .prepare(
      `INSERT INTO creator_accounts (owner, stripe_account_id, charges_enabled, payouts_enabled, onboarded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner) DO UPDATE SET stripe_account_id = excluded.stripe_account_id,
         charges_enabled = excluded.charges_enabled, payouts_enabled = excluded.payouts_enabled,
         onboarded_at = COALESCE(excluded.onboarded_at, creator_accounts.onboarded_at)`,
    )
    .bind(account.owner, account.stripeAccountId, account.chargesEnabled ? 1 : 0,
      account.payoutsEnabled ? 1 : 0, account.onboardedAt)
    .run();
}

export interface Purchase {
  id: string;
  skillId: string;
  buyerClerkId: string | null;
  buyerEmail: string | null;
  stripeCheckoutSession: string;
  amountCents: number;
  feeCents: number;
  creatorCents: number;
  status: string;
  createdAt: string;
}

export async function getPurchaseBySession(db: D1Like, sessionId: string): Promise<Purchase | null> {
  const row = await db
    .prepare(
      `SELECT id, skill_id, buyer_clerk_id, buyer_email, stripe_checkout_session,
              amount_cents, fee_cents, creator_cents, status, created_at
       FROM purchases WHERE stripe_checkout_session = ?`,
    )
    .bind(sessionId)
    .first<{
      id: string; skill_id: string; buyer_clerk_id: string | null; buyer_email: string | null;
      stripe_checkout_session: string; amount_cents: number; fee_cents: number;
      creator_cents: number; status: string; created_at: string;
    }>();
  return row
    ? {
        id: row.id, skillId: row.skill_id, buyerClerkId: row.buyer_clerk_id,
        buyerEmail: row.buyer_email, stripeCheckoutSession: row.stripe_checkout_session,
        amountCents: row.amount_cents, feeCents: row.fee_cents,
        creatorCents: row.creator_cents, status: row.status, createdAt: row.created_at,
      }
    : null;
}

export async function hasEntitlement(
  db: D1Like,
  skillId: string,
  buyer: { clerkUserId?: string | null; email?: string | null },
): Promise<boolean> {
  try {
    if (buyer.clerkUserId) {
      const row = await db
        .prepare("SELECT id FROM entitlements WHERE skill_id = ? AND buyer_clerk_id = ? LIMIT 1")
        .bind(skillId.toLowerCase(), buyer.clerkUserId)
        .first<{ id: string }>();
      if (row) return true;
    }
    if (buyer.email) {
      const row = await db
        .prepare("SELECT id FROM entitlements WHERE skill_id = ? AND lower(buyer_email) = lower(?) LIMIT 1")
        .bind(skillId.toLowerCase(), buyer.email)
        .first<{ id: string }>();
      if (row) return true;
    }
  } catch { /* pre-0005 schema */ }
  return false;
}

/**
 * Fulfil a completed checkout session: purchase row (idempotent on
 * the session id), entitlement, and a one-time install token parked
 * for pickup on the success page. Returns what happened so the
 * webhook handler (and tests) can report honestly. Calling this
 * twice with the same session changes nothing the second time.
 */
export async function fulfilCheckoutSession(
  db: D1Like,
  session: CheckoutSessionObject,
  now: Date = new Date(),
): Promise<{ status: "fulfilled"; purchaseId: string } | { status: "already" } | { status: "ignored"; reason: string }> {
  const draft = purchaseFromCheckoutSession(session);
  if (!draft) return { status: "ignored", reason: "session is not a Talents listing purchase" };
  const existing = await getPurchaseBySession(db, draft.checkoutSession);
  if (existing) return { status: "already" };

  const purchaseId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO purchases (id, skill_id, buyer_clerk_id, buyer_email, stripe_checkout_session,
                              payment_intent, amount_cents, fee_cents, creator_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
    )
    .bind(purchaseId, draft.skillId, draft.buyerClerkId, draft.buyerEmail, draft.checkoutSession,
      draft.paymentIntent, draft.amountCents, draft.feeCents, draft.creatorCents, now.toISOString())
    .run();
  await db
    .prepare(
      "INSERT INTO entitlements (id, skill_id, buyer_clerk_id, buyer_email, purchase_id, granted_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), draft.skillId, draft.buyerClerkId, draft.buyerEmail, purchaseId, now.toISOString())
    .run();

  // One-time install token: hash stored for the gateway; plaintext
  // parked under the checkout session id for the buyer's one pickup.
  const token = generatePurchaseToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_DAYS * 86_400_000).toISOString();
  await db
    .prepare(
      `INSERT INTO install_tokens (token_hash, skill_id, purchase_id, buyer_clerk_id, buyer_email, created_at, used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(tokenHash, draft.skillId, purchaseId, draft.buyerClerkId, draft.buyerEmail, now.toISOString(), expiresAt)
    .run();
  await db
    .prepare(
      "INSERT INTO pending_token_pickups (checkout_session_id, token_plain, skill_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(draft.checkoutSession, token, draft.skillId, now.toISOString())
    .run();
  return { status: "fulfilled", purchaseId };
}

/** One-time pickup of the plaintext install token on the success
 *  page. Returns the token exactly once; later calls return null. */
export async function pickupInstallToken(db: D1Like, sessionId: string): Promise<{ token: string; skillId: string } | null> {
  const row = await db
    .prepare("SELECT token_plain, skill_id FROM pending_token_pickups WHERE checkout_session_id = ?")
    .bind(sessionId)
    .first<{ token_plain: string; skill_id: string }>();
  if (!row) return null;
  await db.prepare("DELETE FROM pending_token_pickups WHERE checkout_session_id = ?").bind(sessionId).run();
  return { token: row.token_plain, skillId: row.skill_id };
}

// ---------------------------------------------------------------------------
// Gateway entitlement seam (used by cf/src/mcp.ts deps)
// ---------------------------------------------------------------------------

export async function gatewayPricing(db: D1Like, skillId: string): Promise<{ priceCents: number; currency: string } | null> {
  const o = await getOverride(db, skillId);
  if (!o || o.priceCents === null || o.priceCents <= 0) return null;
  return { priceCents: o.priceCents, currency: o.currency };
}

export async function gatewayTokenCheck(
  db: D1Like,
  skillId: string,
  presented: unknown,
): Promise<{ ok: boolean; tokenHash?: string }> {
  if (typeof presented !== "string") return { ok: false };
  const hash = await sha256Hex(presented);
  let row: TokenRow | null = null;
  try {
    const r = await db
      .prepare("SELECT token_hash, skill_id, used_at, expires_at FROM install_tokens WHERE token_hash = ?")
      .bind(hash)
      .first<{ token_hash: string; skill_id: string; used_at: string | null; expires_at: string }>();
    if (r) row = { tokenHash: r.token_hash, skillId: r.skill_id, usedAt: r.used_at, expiresAt: r.expires_at };
  } catch { return { ok: false }; }
  const check = checkPurchaseToken(presented, hash, row, skillId.toLowerCase());
  return check.ok ? { ok: true, tokenHash: hash } : { ok: false };
}

export async function gatewaySpendToken(db: D1Like, tokenHash: string): Promise<void> {
  await db
    .prepare("UPDATE install_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .bind(new Date().toISOString(), tokenHash)
    .run();
}

// ---------------------------------------------------------------------------
// Dashboard data: listings + analytics for a claimed namespace
// ---------------------------------------------------------------------------

export interface DashboardListing {
  record: SkillRecord;
  override: ListingOverride | null;
  unlisted: boolean;
  stats: ListingStatsRow | null;
  /** Enrichment fragment (Tranche 2): layer states + completeness +
   *  generated/trust detail, same shape as the API payload. Null
   *  when the record has no enrichment row (or pre-0006 schema). */
  enrichment: ApiEnrichment | null;
}

export async function listingsForOwner(db: D1Like, owner: string): Promise<DashboardListing[]> {
  const { results } = await db
    .prepare("SELECT record_json FROM records WHERE owner = ? AND status = 'listed' ORDER BY id")
    .bind(owner.toLowerCase())
    .all<{ record_json: string }>();
  const records = results.map((r) => JSON.parse(r.record_json) as SkillRecord);
  const overrides = await overridesFor(db, records.map((r) => r.id));
  const unlisted = await unlistedSet(db);
  const stats = await statsForSkills(db, records.map((r) => r.id));
  let enrichRows = new Map<string, EnrichmentRow>();
  try {
    enrichRows = await enrichmentForIds(db, records.map((r) => r.id));
  } catch { /* enrichment is additive only */ }
  return records.map((record) => ({
    record,
    override: overrides.get(record.id) ?? null,
    unlisted: unlisted.has(record.id),
    stats: stats.get(record.id) ?? null,
    enrichment: apiEnrichment(record, enrichRows.get(record.id) ?? null),
  }));
}

export async function statsForSkills(db: D1Like, skillIds: string[]): Promise<Map<string, ListingStatsRow>> {
  const out = new Map<string, ListingStatsRow>();
  if (!skillIds.length) return out;
  try {
    const placeholders = skillIds.map(() => "?").join(", ");
    const { results } = await db
      .prepare(
        `SELECT skill_id, calls_7d, calls_prev_7d, calls_30d, installs_total, installs_30d,
                behavior_score, external_installs, external_source
         FROM record_stats WHERE skill_id IN (${placeholders})`,
      )
      .bind(...skillIds)
      .all<{
        skill_id: string; calls_7d: number; calls_prev_7d: number; calls_30d: number;
        installs_total: number; installs_30d: number; behavior_score: number;
        external_installs: number; external_source: string | null;
      }>();
    for (const r of results) {
      out.set(r.skill_id, {
        skillId: r.skill_id, calls7d: r.calls_7d, callsPrev7d: r.calls_prev_7d,
        calls30d: r.calls_30d, installsTotal: r.installs_total, installs30d: r.installs_30d,
        behaviorScore: r.behavior_score, externalInstalls: r.external_installs,
        externalSource: r.external_source,
      });
    }
  } catch { /* stats table lag is fine — analytics shows zeros */ }
  return out;
}

export async function analyticsForOwner(db: D1Like, owner: string): Promise<OwnerAnalytics> {
  const { results } = await db
    .prepare("SELECT id FROM records WHERE owner = ? AND status = 'listed' ORDER BY id")
    .bind(owner.toLowerCase())
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  const stats = await statsForSkills(db, ids);
  return aggregateOwnerAnalytics(ids, stats);
}

// ---------------------------------------------------------------------------
// HTTP handlers (mounted by cf/src/index.ts)
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { location } });
}

/** POST /api/claims — claim the signed-in user's matching namespace
 *  (body: { owner } — must equal their GitHub login for the web path). */
export async function handleClaim(env: Env, user: SessionUser, req: Request): Promise<Response> {
  let owner = "";
  try {
    const body = (await req.json()) as { owner?: string };
    owner = String(body.owner ?? "");
  } catch {
    const form = await req.formData().catch(() => null);
    owner = String(form?.get("owner") ?? "");
  }
  if (!owner) return json(400, { error: "owner is required" });
  const result = await attemptClaim(env.DB, user, owner);
  if (!result.ok) return json(403, { error: result.reason });
  return json(200, { claimed: result.claim.owner, method: result.claim.method, claimedAt: result.claim.claimedAt });
}

/** POST /dashboard/listings/{owner}/{name} — save an override and/or
 *  an unlist/relist action. Owner + claim checked by the caller. */
export async function handleListingEdit(
  env: Env,
  user: SessionUser,
  owner: string,
  name: string,
  req: Request,
): Promise<{ ok: boolean; error?: string }> {
  const skillId = `${owner}/${name}`.toLowerCase();
  const form = await req.formData();
  const action = String(form.get("action") ?? "save");
  if (action === "unlist" || action === "relist") {
    await setUnlisted(env.DB, skillId, user, action === "unlist");
    return { ok: true };
  }
  const result = await setOverride(env.DB, skillId, user, {
    description: form.get("description") ? String(form.get("description")) : null,
    tags: form.get("tags") !== null ? String(form.get("tags")) : null,
    price: form.get("price") !== null ? String(form.get("price")) : null,
    exclusive: form.get("exclusive") === "on" || form.get("exclusive") === "1",
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** POST /api/payouts/connect — create (or resume) the claimed
 *  owner's Connect Express onboarding. Redirects to Stripe. */
export async function handlePayoutConnect(
  env: Env,
  user: SessionUser,
  stripe: StripeClient | null,
  origin: string,
): Promise<Response> {
  if (!stripe) return json(503, { error: "payments are not enabled on this deployment (STRIPE_SECRET_KEY is not set)" });
  const claims = await claimsByUser(env.DB, user.clerkUserId);
  if (!claims.length) return json(403, { error: "claim a namespace before connecting payouts" });
  const owner = claims[0].owner;
  let account = await getCreatorAccount(env.DB, owner);
  if (!account) {
    const created = await stripe.createConnectAccount(owner);
    account = {
      owner, stripeAccountId: created.id,
      chargesEnabled: false, payoutsEnabled: false, onboardedAt: null,
    };
    await upsertCreatorAccount(env.DB, account);
  }
  const link = await stripe.createAccountLink(
    account.stripeAccountId,
    `${origin}/dashboard/payouts/refresh`,
    `${origin}/dashboard/payouts/return`,
  );
  return redirect(link.url);
}

/** GET /dashboard/payouts/return — refresh Connect status from
 *  Stripe, then back to the dashboard. */
export async function handlePayoutReturn(env: Env, user: SessionUser, stripe: StripeClient | null): Promise<Response> {
  if (stripe) {
    const claims = await claimsByUser(env.DB, user.clerkUserId);
    for (const claim of claims) {
      const account = await getCreatorAccount(env.DB, claim.owner);
      if (!account) continue;
      try {
        const state = await stripe.retrieveAccount(account.stripeAccountId);
        await upsertCreatorAccount(env.DB, {
          ...account,
          chargesEnabled: state.chargesEnabled,
          payoutsEnabled: state.payoutsEnabled,
          onboardedAt: state.chargesEnabled && !account.onboardedAt ? new Date().toISOString() : account.onboardedAt,
        });
      } catch { /* status stays as last known; dashboard says so */ }
    }
  }
  return redirect("/dashboard");
}

/** POST /api/checkout/{owner}/{name} — destination-charge Checkout
 *  Session for a priced listing. Buyer may be signed in or not. */
export async function handleCheckout(
  env: Env,
  stripe: StripeClient | null,
  getVisibleRecord: (id: string) => Promise<SkillRecord | undefined>,
  buyer: SessionUser | null,
  owner: string,
  name: string,
  origin: string,
): Promise<Response> {
  const skillId = `${owner}/${name}`.toLowerCase();
  const record = await getVisibleRecord(skillId);
  if (!record) return json(404, { error: "listing not found" });
  const override = await getOverride(env.DB, skillId);
  if (!override || override.priceCents === null || override.priceCents <= 0) {
    return json(400, { error: "this listing is free — no checkout needed" });
  }
  const account = await getCreatorAccount(env.DB, record.owner);
  if (!stripe || !paymentsEnabledFor(env, account)) {
    return json(503, { error: "payments are not yet enabled for this listing" });
  }
  const split = splitPrice(override.priceCents, override.exclusive);
  const session = await stripe.createCheckoutSession({
    skillId,
    owner: record.owner,
    amountCents: split.amountCents,
    feeCents: split.feeCents,
    currency: override.currency,
    destinationAccount: account!.stripeAccountId,
    exclusive: override.exclusive,
    buyerClerkId: buyer?.clerkUserId ?? null,
    successUrl: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/skills/${record.owner}/${record.name}`,
    productName: `${record.owner}/${record.name} — Talents listing`,
  });
  if (!session.url) return json(502, { error: "Stripe did not return a checkout URL" });
  return redirect(session.url);
}

/** POST /webhooks/stripe — signature-verified; checkout completion
 *  fulfils purchase + entitlement + install token, idempotently. */
export async function handleStripeWebhook(env: Env, req: Request): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json(503, { error: "stripe webhook is not configured on this deployment" });
  }
  const raw = await req.text();
  const verified = await verifyStripeSignature(raw, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!verified.ok) return json(401, { error: `signature verification failed: ${verified.reason}` });
  const event = parseStripeEvent(raw);
  if (!event) return json(400, { error: "invalid event payload" });
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as unknown as CheckoutSessionObject;
    if (session.payment_status && session.payment_status !== "paid") {
      return json(200, { received: true, fulfilled: "skipped-unpaid" });
    }
    const outcome = await fulfilCheckoutSession(env.DB, session);
    return json(200, { received: true, fulfilled: outcome.status });
  }
  return json(200, { received: true, fulfilled: "ignored-event" });
}
