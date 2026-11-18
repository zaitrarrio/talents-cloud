// Creator Experience (P4) tests — claims, listing overrides + unlist
// propagation, fee math, Clerk session verification against a MOCK
// issuer (test-generated RSA keypair served as a JWKS), Stripe
// webhook signature verification + purchase shaping, purchase-token
// entitlement logic, MCP gateway payment gating, and analytics
// aggregation. All pure/fixture-driven: no network, no real keys.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { SkillRecord } from "../src/types.js";
import { buildAggregatedMarketplace } from "../src/aggregate.js";
import { splitPrice, formatPrice } from "../src/creator/fees.js";
import {
  decideClaim, ownerIsGithubBacked, claimableOwner, type Claim,
} from "../src/creator/claims.js";
import {
  toDisplayRecord, mergeForDisplay, excludeUnlisted, isPriced, normalizeListingEdit,
  type ListingOverride,
} from "../src/creator/overrides.js";
import {
  verifyRs256Token, jwksFromStatic, frontendApiFromPublishableKey,
  jwksUrlForPublishableKey, type Jwk,
} from "../src/creator/jwt.js";
import {
  verifyStripeSignature, purchaseFromCheckoutSession,
} from "../src/creator/stripe.js";
import {
  checkPurchaseToken, generatePurchaseToken, isPurchaseToken, sha256Hex,
  paymentRequiredPayload,
} from "../src/creator/access.js";
import {
  aggregateOwnerAnalytics, type ListingStatsRow,
} from "../src/creator/analytics.js";
import { handleMcpRequest, type GatewayDeps } from "../cf/src/mcp.js";
import { formEncode } from "../cf/src/stripe.js";
import { verifySessionToken, clerkConfigured } from "../cf/src/auth.js";
import type { Env } from "../cf/src/db.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function record(partial: Partial<SkillRecord> & { id: string }): SkillRecord {
  const [owner, name] = partial.id.split("/");
  return {
    owner, name,
    url: `https://talents.sh/skills/${partial.id}`,
    profileUrl: `https://talents.sh/${owner}`,
    kind: "plugin",
    description: "source description",
    sourceType: "github",
    source: "./plugins/x",
    sourceRepo: `${owner}/repo`,
    sourcePath: "plugins/x",
    sourceMarketplace: `${owner}/repo`,
    ref: "main",
    pointerOnly: false,
    components: { skills: [], commands: [], agents: [], hooks: false, mcpServers: [] },
    declaration: { lines: [], summary: ["Runs skills in your agent"], undeclared: [], derivedFrom: [] },
    validation: { entryName: name, ok: true, issues: [] },
    attestation: {
      algorithm: "ed25519", contentHash: "a".repeat(64), signature: "c2ln",
      publicKeyPem: "pem", signedAt: "2026-11-10T00:00:00.000Z",
    },
    filesHashed: ["SKILL.md"],
    status: "listed",
    ingestedAt: "2026-11-10T00:00:00.000Z",
    ...partial,
  };
}

function override(partial: Partial<ListingOverride> & { skillId: string }): ListingOverride {
  return {
    descriptionOverride: null, tags: null, priceCents: null, currency: "usd",
    exclusive: false, updatedAt: "2026-11-10T00:00:00.000Z", updatedBy: "user_1",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Fee math (85/88, fee floored, creator takes the remainder)
// ---------------------------------------------------------------------------

test("fees: standard split is 85/15, exclusive is 88/12", () => {
  assert.deepEqual(splitPrice(1000, false), { amountCents: 1000, feeCents: 150, creatorCents: 850, feeBps: 1500, exclusive: false });
  assert.deepEqual(splitPrice(1000, true), { amountCents: 1000, feeCents: 120, creatorCents: 880, feeBps: 1200, exclusive: true });
});

test("fees: rounding floors the fee, creator keeps the dust", () => {
  // 999 * 15% = 149.85 → fee 149, creator 850 (never 849).
  assert.equal(splitPrice(999, false).feeCents, 149);
  assert.equal(splitPrice(999, false).creatorCents, 850);
  // 999 * 12% = 119.88 → fee 119, creator 880.
  assert.equal(splitPrice(999, true).feeCents, 119);
  assert.equal(splitPrice(999, true).creatorCents, 880);
  // Tiny amounts: a 1-cent sale pays the creator the full cent.
  assert.equal(splitPrice(1, false).feeCents, 0);
  assert.equal(splitPrice(1, false).creatorCents, 1);
  assert.equal(splitPrice(0, false).feeCents, 0);
  // Invariant across a sweep: fee + creator == amount, always.
  for (const amt of [1, 2, 3, 7, 33, 101, 499, 12345, 999999]) {
    for (const ex of [false, true]) {
      const s = splitPrice(amt, ex);
      assert.equal(s.feeCents + s.creatorCents, amt);
    }
  }
});

test("fees: invalid amounts throw; formatPrice renders USD", () => {
  assert.throws(() => splitPrice(-1, false));
  assert.throws(() => splitPrice(10.5, false));
  assert.equal(formatPrice(1250), "$12.50");
  assert.equal(formatPrice(5), "$0.05");
  assert.equal(formatPrice(100000), "$1000.00");
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

test("claims: GitHub-login match succeeds and is case-insensitive", () => {
  const d = decideClaim("Alice", "user_1", { githubLogin: "alice", existingClaim: null, githubBacked: true });
  assert.deepEqual(d, { ok: true, method: "github-login-match" });
});

test("claims: login mismatch and missing login are refused", () => {
  const mismatch = decideClaim("alice", "user_1", { githubLogin: "bob", existingClaim: null, githubBacked: true });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, "login-mismatch");
  const noLogin = decideClaim("alice", "user_1", { githubLogin: null, existingClaim: null, githubBacked: true });
  assert.equal(noLogin.ok, false);
  if (!noLogin.ok) assert.equal(noLogin.code, "no-github-login");
});

test("claims: registry-label namespaces are not claimable via GitHub sign-in", () => {
  const d = decideClaim("usefulapi", "user_1", { githubLogin: "usefulapi", existingClaim: null, githubBacked: false });
  assert.equal(d.ok, false);
  if (!d.ok) {
    assert.equal(d.code, "not-github-backed");
    assert.match(d.reason, /not available via GitHub sign-in/);
  }
});

test("claims: first-come-first-served — another user's claim blocks, own claim is idempotent", () => {
  const existing: Claim = { owner: "alice", clerkUserId: "user_2", githubLogin: "alice", method: "github-login-match", claimedAt: "2026-11-01T00:00:00.000Z" };
  const blocked = decideClaim("alice", "user_1", { githubLogin: "alice", existingClaim: existing, githubBacked: true });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, "already-claimed");
  const own = decideClaim("alice", "user_2", { githubLogin: "alice", existingClaim: existing, githubBacked: true });
  assert.equal(own.ok, true);
});

test("claims: github-backed detection requires the repo to be owned BY the namespace", () => {
  assert.equal(ownerIsGithubBacked("alice", [{ sourceRepo: "alice/repo" }]), true);
  assert.equal(ownerIsGithubBacked("alice", [{ sourceRepo: undefined }, { sourceRepo: "Alice/x" }]), true);
  assert.equal(ownerIsGithubBacked("alice", [{ sourceRepo: undefined }]), false);
  assert.equal(ownerIsGithubBacked("alice", []), false);
  // The usefulapi case: MCP-registry records under a reverse-DNS
  // label whose repository belongs to a DIFFERENT GitHub user do
  // not make the label GitHub-backed.
  assert.equal(ownerIsGithubBacked("usefulapi", [{ sourceRepo: "m190/usefulapi-mcp" }]), false);
});

test("claims: claimableOwner finds the one-click claim and respects other claims", () => {
  const claims = new Map<string, Claim>();
  assert.equal(claimableOwner("Alice", ["alice", "bob"], claims, "user_1"), "alice");
  assert.equal(claimableOwner(null, ["alice"], claims, "user_1"), null);
  assert.equal(claimableOwner("carol", ["alice"], claims, "user_1"), null);
  claims.set("alice", { owner: "alice", clerkUserId: "user_2", githubLogin: "alice", method: "github-login-match", claimedAt: "t" });
  assert.equal(claimableOwner("alice", ["alice"], claims, "user_1"), null);
  assert.equal(claimableOwner("alice", ["alice"], claims, "user_2"), "alice");
});

// ---------------------------------------------------------------------------
// Overrides: merge, label, validation
// ---------------------------------------------------------------------------

test("overrides: display merge labels publisher text and never mutates the record", () => {
  const r = record({ id: "alice/widget" });
  const before = r.description;
  const display = toDisplayRecord(r, override({ skillId: r.id, descriptionOverride: "publisher words", priceCents: 500 }));
  assert.equal(display.description, "publisher words");
  assert.equal(display.descriptionIsPublisher, true);
  assert.equal(display.priceCents, 500);
  const plain = toDisplayRecord(r, null);
  assert.equal(plain.description, "source description");
  assert.equal(plain.descriptionIsPublisher, false);
  const merged = mergeForDisplay([r], new Map([[r.id, override({ skillId: r.id, descriptionOverride: "publisher words" })]]));
  assert.equal(merged[0].description, "publisher words");
  assert.equal(r.description, before); // attested record untouched
});

test("overrides: normalizeListingEdit validates price/tags/description", () => {
  const ok = normalizeListingEdit({ description: " hi ", tags: "Pdf, pdf, API ", price: "12.50", exclusive: true });
  assert.deepEqual(ok, { ok: true, descriptionOverride: "hi", tags: ["pdf", "api"], priceCents: 1250, exclusive: true });
  const free = normalizeListingEdit({ price: "" });
  assert.equal(free.ok, true);
  if (free.ok) assert.equal(free.priceCents, null);
  assert.equal(normalizeListingEdit({ price: "12.505" }).ok, false);
  assert.equal(normalizeListingEdit({ price: "0" }).ok, false);
  assert.equal(normalizeListingEdit({ price: "-3" }).ok, false);
  assert.equal(normalizeListingEdit({ description: "x".repeat(601) }).ok, false);
  assert.equal(isPriced(override({ skillId: "a/b", priceCents: 100 })), true);
  assert.equal(isPriced(override({ skillId: "a/b", priceCents: null })), false);
  assert.equal(isPriced(null), false);
});

// ---------------------------------------------------------------------------
// Unlist propagation: aggregate exclusion + surface filter
// ---------------------------------------------------------------------------

test("unlist: aggregate excludes owner-unlisted records and reports the skip", () => {
  const a = record({ id: "alice/widget" });
  const b = record({ id: "bob/gadget", sourceRepo: "bob/repo" });
  const res = buildAggregatedMarketplace([a, b], { excludeIds: new Set(["alice/widget"]) });
  assert.equal(res.entryCount, 1);
  assert.equal(res.doc.plugins![0].name, "gadget");
  assert.deepEqual(res.skipped, [{ id: "alice/widget", reason: "owner-unlisted (creator opt-out)" }]);
  // Without the exclusion the same input yields both (default unchanged).
  assert.equal(buildAggregatedMarketplace([a, b]).entryCount, 2);
  // The surface filter used by search/pages/gateway wrappers:
  assert.deepEqual(excludeUnlisted([a, b], new Set(["bob/gadget"])).map((r) => r.id), ["alice/widget"]);
});

// ---------------------------------------------------------------------------
// Clerk session verification against a MOCK issuer
// ---------------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mockIssuer() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as unknown as Jwk;
  jwk.kid = "mock-key-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const sign = (claims: Record<string, unknown>): string => {
    const header = { alg: "RS256", typ: "JWT", kid: "mock-key-1" };
    const data = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(claims)))}`;
    const sig = createSign("RSA-SHA256").update(data).sign(privateKey);
    return `${data}.${b64url(sig)}`;
  };
  return { jwk, sign };
}

test("jwt: a mock-Clerk session token verifies against the mock JWKS", async () => {
  const { jwk, sign } = mockIssuer();
  const now = Math.floor(Date.now() / 1000);
  const token = sign({ sub: "user_123", iss: "https://clerk.example.com", exp: now + 600, iat: now });
  const r = await verifyRs256Token(token, jwksFromStatic([jwk]), { issuer: "https://clerk.example.com" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.token.subject, "user_123");
});

test("jwt: expired, tampered, wrong-issuer and wrong-key tokens are refused", async () => {
  const { jwk, sign } = mockIssuer();
  const other = mockIssuer();
  const now = Math.floor(Date.now() / 1000);
  const src = jwksFromStatic([jwk]);
  const expired = sign({ sub: "u", iss: "https://clerk.example.com", exp: now - 10 });
  assert.equal((await verifyRs256Token(expired, src)).ok, false);
  const good = sign({ sub: "u", iss: "https://clerk.example.com", exp: now + 600 });
  const tampered = good.split(".").slice(0, 2).join(".") + "." + good.split(".")[2].split("").reverse().join("");
  assert.equal((await verifyRs256Token(tampered, src)).ok, false);
  assert.equal((await verifyRs256Token(good, src, { issuer: "https://evil.example.com" })).ok, false);
  assert.equal((await verifyRs256Token(good, jwksFromStatic([other.jwk]))).ok, false);
  assert.equal((await verifyRs256Token("not-a-jwt", src)).ok, false);
});

test("jwt: publishable key decodes to the frontend API host + JWKS URL", () => {
  const pk = `pk_test_${Buffer.from("happy-otter-42.clerk.accounts.dev$").toString("base64")}`;
  assert.equal(frontendApiFromPublishableKey(pk), "happy-otter-42.clerk.accounts.dev");
  assert.equal(jwksUrlForPublishableKey(pk), "https://happy-otter-42.clerk.accounts.dev/.well-known/jwks.json");
  assert.equal(frontendApiFromPublishableKey("sk_test_nope"), null);
  assert.equal(frontendApiFromPublishableKey(undefined), null);
});

// ---------------------------------------------------------------------------
// Auth swap: @clerk/backend verifyToken as the primary verifier,
// hand-rolled JWKS verifier as the fallback. The mock Clerk issuer
// from above signs tokens; a local HTTP server stands in for the
// Clerk Backend API's /v1/jwks endpoint (verifyToken's apiUrl
// option), and an injected fetch stands in for the frontend-API
// JWKS fetch the fallback uses. No network, no real keys.
// ---------------------------------------------------------------------------

/** Publishable key that decodes to the mock issuer host. */
function mockPublishableKey(): string {
  return `pk_test_${Buffer.from("clerk.example.com$").toString("base64")}`;
}

function mockEnv(): Env {
  return {
    CLERK_PUBLISHABLE_KEY: mockPublishableKey(),
    CLERK_SECRET_KEY: "sk_test_mock",
  } as unknown as Env;
}

/** Local stand-in for the Clerk Backend API: serves the mock JWKS
 *  at /v1/jwks (the path verifyToken builds from apiUrl). Records
 *  the requests it saw so tests can assert the secret key was
 *  carried as a Bearer token. */
async function mockBapi(jwk: Jwk): Promise<{ url: string; seen: { path: string; auth: string | null }[]; close: () => Promise<void> }> {
  const seen: { path: string; auth: string | null }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization ?? null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Injected fetch for the fallback path: answers any JWKS URL with
 *  the mock keys, never touches the network. */
function mockJwksFetch(jwk: Jwk): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => ({ keys: [jwk] }),
  })) as unknown as typeof fetch;
}

test("auth swap: verifySessionToken verifies a mock-Clerk token via @clerk/backend", async () => {
  const { jwk, sign } = mockIssuer();
  const bapi = await mockBapi(jwk);
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = sign({
      sub: "user_123", iss: "https://clerk.example.com", exp: now + 600, iat: now,
      github_login: "alice",
    });
    const v = await verifySessionToken(token, mockEnv(), fetch, { clerkApiUrl: bapi.url });
    assert.ok(v, "a valid mock-Clerk token must verify");
    assert.equal(v!.subject, "user_123");
    assert.equal(v!.claims.github_login, "alice");
    // The JWKS fetch went to the mock BAPI at /v1/jwks, carrying
    // the secret key as a Bearer token.
    assert.equal(bapi.seen.length, 1);
    assert.equal(bapi.seen[0].path, "/v1/jwks");
    assert.equal(bapi.seen[0].auth, "Bearer sk_test_mock");
  } finally {
    await bapi.close();
  }
});

test("auth swap: verifyToken failure falls back to the hand-rolled JWKS path", async () => {
  const { jwk, sign } = mockIssuer();
  const now = Math.floor(Date.now() / 1000);
  const token = sign({ sub: "user_456", iss: "https://clerk.example.com", exp: now + 600, iat: now });
  // Dead BAPI endpoint: verifyToken retries (~2s) then throws; the
  // fallback verifies the same signature via the injected JWKS fetch.
  const v = await verifySessionToken(token, mockEnv(), mockJwksFetch(jwk), { clerkApiUrl: "http://127.0.0.1:1" });
  assert.ok(v, "fallback must verify when the BAPI is unreachable");
  assert.equal(v!.subject, "user_456");
});

test("auth swap: invalid and expired tokens are refused on both paths", async () => {
  const { jwk, sign } = mockIssuer();
  const bapi = await mockBapi(jwk);
  try {
    const now = Math.floor(Date.now() / 1000);
    const good = sign({ sub: "u", iss: "https://clerk.example.com", exp: now + 600, iat: now });
    const tampered = good.split(".").slice(0, 2).join(".") + "." + good.split(".")[2].split("").reverse().join("");
    assert.equal(await verifySessionToken(tampered, mockEnv(), mockJwksFetch(jwk), { clerkApiUrl: bapi.url }), null);
    const expired = sign({ sub: "u", iss: "https://clerk.example.com", exp: now - 10, iat: now - 700 });
    assert.equal(await verifySessionToken(expired, mockEnv(), mockJwksFetch(jwk), { clerkApiUrl: bapi.url }), null);
    assert.equal(await verifySessionToken("not-a-jwt", mockEnv(), mockJwksFetch(jwk), { clerkApiUrl: bapi.url }), null);
  } finally {
    await bapi.close();
  }
});

test("auth swap: no Clerk material → null, never throws", async () => {
  assert.equal(await verifySessionToken("a.b.c", {} as unknown as Env), null);
  assert.equal(await verifySessionToken("", mockEnv()), null);
});

test("auth swap: clerkConfigured reflects the publishable key", () => {
  assert.equal(clerkConfigured(mockEnv()), true);
  assert.equal(clerkConfigured({} as unknown as Env), false);
  assert.equal(clerkConfigured({ CLERK_PUBLISHABLE_KEY: "garbage" } as unknown as Env), false);
});

// ---------------------------------------------------------------------------
// catalogOwners: one query, not one per owner (2026-11-11 incident).
// The per-owner loop issued 1 + owner-count D1 calls per dashboard /
// claim request — 1,075 at 22,407 listed records — past the Workers
// 1,000-subrequest ceiling, so /dashboard 500'd for every signed-in
// user once the catalog passed ~1,000 owners.
// ---------------------------------------------------------------------------

test("catalogOwners: single query, identical map, no per-owner round-trips", async () => {
  const { catalogOwners } = await import("../cf/src/creator.js");
  const rows = [
    { owner: "alice", source_repo: "alice/widget" },
    { owner: "alice", source_repo: "other/thing" },
    { owner: "bob", source_repo: "someone-else/repo" },
    { owner: "carol", source_repo: null },
  ];
  let calls = 0;
  const db = {
    prepare() {
      calls++;
      return {
        bind() { return this; },
        async all() { return { results: rows }; },
        async run() { return {}; },
        async first() { return null; },
      };
    },
  } as unknown as import("../src/search-d1.js").D1Like;
  const out = await catalogOwners(db);
  assert.equal(calls, 1, "exactly one D1 query regardless of owner count");
  assert.equal(out.get("alice"), true, "alice has a repo under her own name");
  assert.equal(out.get("bob"), false, "bob's only repo belongs to someone else");
  assert.equal(out.get("carol"), false, "carol has no repo at all");
  assert.equal(out.size, 3);
});

// ---------------------------------------------------------------------------
// Stripe webhook: signature verification + purchase shaping
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_test_fixture_secret";

function stripeSign(body: string, secret: string, atSec: number): string {
  const sig = createHmac("sha256", secret).update(`${atSec}.${body}`).digest("hex");
  return `t=${atSec},v1=${sig}`;
}

function checkoutBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_1", type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_123", payment_intent: "pi_123", amount_total: 1000, currency: "usd",
        payment_status: "paid",
        customer_details: { email: "buyer@example.com" },
        metadata: { skill_id: "alice/widget", buyer_clerk_id: "user_9", exclusive: "0" },
        ...overrides,
      },
    },
  });
}

test("stripe webhook: a correctly signed event verifies; tampering and staleness fail", async () => {
  const body = checkoutBody();
  const now = new Date();
  const header = stripeSign(body, WEBHOOK_SECRET, Math.floor(now.getTime() / 1000));
  assert.deepEqual(await verifyStripeSignature(body, header, WEBHOOK_SECRET, { now }), { ok: true });
  const tampered = await verifyStripeSignature(body.replace("1000", "1"), header, WEBHOOK_SECRET, { now });
  assert.equal(tampered.ok, false);
  const stale = await verifyStripeSignature(body, header, WEBHOOK_SECRET, { now: new Date(now.getTime() + 10 * 60_000) });
  assert.equal(stale.ok, false);
  assert.equal((await verifyStripeSignature(body, null, WEBHOOK_SECRET, { now })).ok, false);
  assert.equal((await verifyStripeSignature(body, header, "whsec_wrong", { now })).ok, false);
});

test("stripe webhook: purchase shaping recomputes the split (idempotency key = session id)", () => {
  const session = JSON.parse(checkoutBody()).data.object;
  const draft = purchaseFromCheckoutSession(session);
  assert.ok(draft);
  assert.equal(draft.skillId, "alice/widget");
  assert.equal(draft.checkoutSession, "cs_test_123");
  assert.equal(draft.amountCents, 1000);
  assert.equal(draft.feeCents, 150);
  assert.equal(draft.creatorCents, 850);
  // Exclusive sessions split 88/12:
  const ex = purchaseFromCheckoutSession({ ...session, metadata: { ...session.metadata, exclusive: "1" } });
  assert.equal(ex?.feeCents, 120);
  assert.equal(ex?.creatorCents, 880);
  // Not ours (no skill metadata) → ignored, never throws:
  assert.equal(purchaseFromCheckoutSession({ id: "cs_x", amount_total: 100, metadata: {} }), null);
});

// ---------------------------------------------------------------------------
// Purchase tokens + gateway entitlement gating
// ---------------------------------------------------------------------------

test("access: token lifecycle — format, hash, spent/expired/wrong-skill refusals", async () => {
  const token = generatePurchaseToken(() => new Uint8Array(24).fill(7));
  assert.equal(isPurchaseToken(token), true);
  assert.equal(isPurchaseToken("tix_short"), false);
  assert.equal(isPurchaseToken(42), false);
  const hash = await sha256Hex(token);
  const row = { tokenHash: hash, skillId: "alice/widget", usedAt: null, expiresAt: "2999-01-01T00:00:00.000Z" };
  assert.deepEqual(checkPurchaseToken(token, hash, row, "alice/widget"), { ok: true });
  assert.equal(checkPurchaseToken(token, hash, row, "alice/other").ok, false);
  assert.equal(checkPurchaseToken(token, hash, { ...row, usedAt: "2026-01-01T00:00:00.000Z" }, "alice/widget").ok, false);
  assert.equal(checkPurchaseToken(token, hash, { ...row, expiresAt: "2000-01-01T00:00:00.000Z" }, "alice/widget").ok, false);
  assert.equal(checkPurchaseToken(token, hash, null, "alice/widget").ok, false);
  assert.equal(checkPurchaseToken("garbage", null, row, "alice/widget").ok, false);
  const payload = paymentRequiredPayload({ skillId: "alice/widget", priceCents: 1000, currency: "usd", checkoutUrl: "https://talents.sh/skills/alice/widget" });
  assert.equal(payload.status, "payment_required");
});

interface RpcResponse { result?: { content: { text: string }[]; isError?: boolean } }
async function rpc(deps: GatewayDeps, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const req = new Request("https://mcp.talents.sh/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleMcpRequest(req, deps);
  const body = (await res.json()) as RpcResponse;
  return JSON.parse(body.result!.content[0].text) as Record<string, unknown>;
}

test("gateway: priced skill refuses prepare without a token, proceeds with one, spends it on install", async () => {
  const priced = record({ id: "alice/widget" });
  const token = generatePurchaseToken(() => new Uint8Array(24).fill(3));
  const tokenHash = await sha256Hex(token);
  let spent: string | null = null;
  let installs = 0;
  const deps: GatewayDeps = {
    search: async () => [priced],
    get: async () => priced,
    log: async () => {},
    createInstall: async (row) => { installs++; return { ...row, installed_at: "2026-11-10T00:00:00.000Z" }; },
    verify: async () => ({ ok: true, reason: "", recomputedHash: "a".repeat(64) }),
    pricing: async () => ({ priceCents: 1000, currency: "usd" }),
    checkToken: async (_id, presented) =>
      presented === token ? { ok: true, tokenHash } : { ok: false },
    spendToken: async (h) => { spent = h; },
  };

  // No token → payment required, NO prepare payload leaks.
  const refused = await rpc(deps, "install_skill", { skill: "alice/widget" });
  assert.equal(refused.status, "payment_required");
  assert.equal(refused.attestationHash, undefined);
  assert.equal((refused.price as { amountCents: number }).amountCents, 1000);

  // Wrong token → still payment required.
  const wrong = await rpc(deps, "install_skill", { skill: "alice/widget", purchaseToken: "tix_wrongwrongwrongwrong" });
  assert.equal(wrong.status, "payment_required");

  // Valid token → the normal prepare payload.
  const prepared = await rpc(deps, "install_skill", { skill: "alice/widget", purchaseToken: token });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.attestationHash, "a".repeat(64));

  // Confirm without the token → refused at the gate, nothing spent.
  const confirmNoToken = await rpc(deps, "install_skill", { skill: "alice/widget", confirm: true, attestationHash: "a".repeat(64) });
  assert.equal(confirmNoToken.status, "payment_required");
  assert.equal(installs, 0);

  // Confirm with token + hash → ceremony runs, install written, token spent.
  const installed = await rpc(deps, "install_skill", {
    skill: "alice/widget", confirm: true, attestationHash: "a".repeat(64), purchaseToken: token,
  });
  assert.equal(installed.status, "installed");
  assert.equal(installs, 1);
  assert.equal(spent, tokenHash);
});

test("gateway: free skills are byte-identical to the pre-P4 ceremony (no pricing deps consulted)", async () => {
  const free = record({ id: "bob/gadget" });
  let pricingCalls = 0;
  const deps: GatewayDeps = {
    search: async () => [free],
    get: async () => free,
    log: async () => {},
    createInstall: async (row) => ({ ...row, installed_at: "2026-11-10T00:00:00.000Z" }),
    verify: async () => ({ ok: true, reason: "", recomputedHash: "a".repeat(64) }),
    pricing: async () => { pricingCalls++; return null; },
    checkToken: async () => ({ ok: false }),
    spendToken: async () => {},
  };
  const prepared = await rpc(deps, "install_skill", { skill: "bob/gadget" });
  assert.equal(prepared.status, "prepared");
  const installed = await rpc(deps, "install_skill", { skill: "bob/gadget", confirm: true, attestationHash: "a".repeat(64) });
  assert.equal(installed.status, "installed");
  assert.equal(pricingCalls, 2); // consulted, returned free, no gating
});

test("gateway: a priced skill whose source fails verification does NOT spend the token", async () => {
  const priced = record({ id: "alice/widget" });
  const token = generatePurchaseToken(() => new Uint8Array(24).fill(9));
  const tokenHash = await sha256Hex(token);
  let spent = false;
  const deps: GatewayDeps = {
    search: async () => [priced],
    get: async () => priced,
    log: async () => {},
    createInstall: async (row) => ({ ...row, installed_at: "t" }),
    verify: async () => ({ ok: false, reason: "source hash mismatch", recomputedHash: null }),
    pricing: async () => ({ priceCents: 100, currency: "usd" }),
    checkToken: async () => ({ ok: true, tokenHash }),
    spendToken: async () => { spent = true; },
  };
  const out = await rpc(deps, "install_skill", {
    skill: "alice/widget", confirm: true, attestationHash: "a".repeat(64), purchaseToken: token,
  });
  assert.equal(out.status, "refused");
  assert.equal(spent, false);
});

// ---------------------------------------------------------------------------
// Analytics aggregation
// ---------------------------------------------------------------------------

test("analytics: totals, trend direction, external signal kept separate, zeros are honest", () => {
  const stats = new Map<string, ListingStatsRow>([
    ["alice/a", { skillId: "alice/a", calls7d: 10, callsPrev7d: 4, calls30d: 40, installsTotal: 5, installs30d: 2, behaviorScore: 0.5, externalInstalls: 100, externalSource: "skills.sh" }],
    ["alice/b", { skillId: "alice/b", calls7d: 1, callsPrev7d: 3, calls30d: 9, installsTotal: 1, installs30d: 0, behaviorScore: 0.1, externalInstalls: 0, externalSource: null }],
  ]);
  const agg = aggregateOwnerAnalytics(["alice/a", "alice/b", "alice/quiet"], stats);
  assert.equal(agg.totals.listings, 3);
  assert.equal(agg.totals.calls30d, 49);
  assert.equal(agg.totals.calls7d, 11);
  assert.equal(agg.totals.trend, "up"); // 11 vs 7
  assert.equal(agg.totals.trendDelta, 4);
  assert.equal(agg.totals.installsTotal, 6);
  assert.equal(agg.totals.externalInstalls, 100); // separate bucket, not in installsTotal
  const quiet = agg.listings.find((l) => l.skillId === "alice/quiet")!;
  assert.equal(quiet.calls30d, 0);
  assert.equal(quiet.trend, "flat");
  assert.equal(agg.listings[0].skillId, "alice/a"); // most-called first
  const empty = aggregateOwnerAnalytics([], new Map());
  assert.equal(empty.totals.listings, 0);
  assert.equal(empty.totals.trend, "flat");
});

// ---------------------------------------------------------------------------
// Stripe client form encoding (destination-charge payload shape)
// ---------------------------------------------------------------------------

test("stripe client: formEncode nests checkout params the way the API expects", () => {
  const body = formEncode({
    mode: "payment",
    payment_intent_data: { application_fee_amount: 150, transfer_data: { destination: "acct_123" } },
    metadata: { skill_id: "alice/widget" },
  });
  assert.match(body, /payment_intent_data%5Bapplication_fee_amount%5D=150/);
  assert.match(body, /payment_intent_data%5Btransfer_data%5D%5Bdestination%5D=acct_123/);
  assert.match(body, /metadata%5Bskill_id%5D=alice%2Fwidget/);
});
