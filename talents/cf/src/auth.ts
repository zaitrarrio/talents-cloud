// Clerk session auth for the Worker (Creator Experience, P4).
//
// Env-driven (see db.ts Env): CLERK_PUBLISHABLE_KEY (public var),
// CLERK_SECRET_KEY + CLERK_JWT_KEY (Worker secrets). A Talents Clerk
// application is provisioned by the user in the Clerk dashboard —
// until its keys exist, clerkConfigured() is false, /sign-in renders
// the honest setup state, and protected routes redirect there.
//
// Verification paths (verifySessionToken):
//   PRIMARY — @clerk/backend verifyToken (3.27.0, installed
//   2026-11-11; cf/package.json). With CLERK_JWT_KEY it verifies
//   networklessly against the PEM; with CLERK_SECRET_KEY it loads
//   the JWKS from the Clerk Backend API (cached per isolate).
//   FALLBACK — the hand-rolled RS256/JWKS verifier in
//   src/creator/jwt.ts, the production path before the swap: the
//   JWKS URL derived from the publishable key (or CLERK_JWKS_URL),
//   issuer-checked. It runs only when verifyToken throws — it
//   checks the same signature against the same Clerk JWKS material,
//   so a package/environment failure degrades, never bypasses.
//   (The fallback needs no secret key and no package; it is also
//   what the test suite exercises against a mock issuer.)
// The GitHub login (the claim credential) is resolved from, in
// order: the users-table cache → a `github_login` session-token
// claim (when the Clerk session template is configured to include
// it) → the Clerk Backend API (needs CLERK_SECRET_KEY) → null.

import { verifyToken } from "@clerk/backend";
import {
  verifyRs256Token, jwksFromUrl, jwksUrlForPublishableKey,
  frontendApiFromPublishableKey, type TokenVerifyResult,
} from "../../src/creator/jwt.js";
import type { D1Like } from "../../src/search-d1.js";
import type { Env } from "./db.js";

export interface SessionUser {
  clerkUserId: string;
  githubLogin: string | null;
}

/** Is ANY Clerk verification material configured? */
export function clerkConfigured(env: Env): boolean {
  if (env.CLERK_JWT_KEY) return true;
  if (env.CLERK_JWKS_URL) return true;
  return jwksUrlForPublishableKey(env.CLERK_PUBLISHABLE_KEY) !== null;
}

export function authMockUser(env: Env): SessionUser | null {
  // Dev-only stub — see the Env comment. Hard-gated on Clerk being
  // unconfigured so it can never shadow real verification.
  if (clerkConfigured(env) || !env.TALENTS_AUTH_MOCK) return null;
  try {
    const parsed = JSON.parse(env.TALENTS_AUTH_MOCK) as { clerkUserId?: string; githubLogin?: string };
    if (parsed.clerkUserId) {
      return { clerkUserId: parsed.clerkUserId, githubLogin: parsed.githubLogin ?? null };
    }
  } catch { /* malformed stub = no session */ }
  return null;
}

/** Extract the Clerk session token: `__session` cookie first
 *  (browser flow), then an Authorization bearer (API clients). */
export function sessionTokenFromRequest(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "__session" && rest.length) return rest.join("=");
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Networkless verification against a PEM SPKI public key. */
export async function verifyWithPemKey(token: string, pem: string): Promise<TokenVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "token is not a JWT" };
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "token payload is not valid JSON" };
  }
  // PEM body is standard base64 — decode directly to the SPKI DER.
  const pemBody = pem.replace(/-----BEGIN PUBLIC KEY-----/, "").replace(/-----END PUBLIC KEY-----/, "").replace(/\s+/g, "");
  const derStd = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "spki", derStd as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
  } catch (e) {
    return { ok: false, reason: `CLERK_JWT_KEY import failed: ${(e as Error).message}` };
  }
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key,
    b64urlToBytes(parts[2]) as BufferSource,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`) as BufferSource,
  );
  if (!valid) return { ok: false, reason: "signature verification failed" };
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (exp === null || exp <= nowSec) return { ok: false, reason: "token expired or missing exp" };
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) return { ok: false, reason: "token has no sub claim" };
  return {
    ok: true,
    token: { subject: sub, issuer: typeof claims.iss === "string" ? claims.iss : null, expiresAt: exp, claims },
  };
}

/** Verify a session token with whatever Clerk material is
 *  configured. Returns null for "no valid session" — callers never
 *  distinguish bad-token from no-token (no oracle).
 *
 *  `opts.clerkApiUrl` exists only for tests: it points verifyToken's
 *  JWKS fetch at a mock Clerk Backend API. Production never sets it. */
export async function verifySessionToken(
  token: string,
  env: Env,
  fetchFn: typeof fetch = fetch,
  opts: { clerkApiUrl?: string } = {},
): Promise<{ subject: string; claims: Record<string, unknown> } | null> {
  const host = frontendApiFromPublishableKey(env.CLERK_PUBLISHABLE_KEY);
  const issuer = env.CLERK_JWKS_URL ? undefined : host ? `https://${host}` : undefined;
  // Primary: @clerk/backend verifyToken. Throws on any failure
  // (bad token, bad secret key, unreachable JWKS) — the fallback
  // below then gets its turn.
  try {
    const options: Parameters<typeof verifyToken>[1] = {};
    if (env.CLERK_JWT_KEY) options.jwtKey = env.CLERK_JWT_KEY;
    else if (env.CLERK_SECRET_KEY) options.secretKey = env.CLERK_SECRET_KEY;
    if (issuer) options.issuer = issuer;
    if (opts.clerkApiUrl) options.apiUrl = opts.clerkApiUrl;
    if (options.jwtKey || options.secretKey) {
      const payload = await verifyToken(token, options);
      if (payload && typeof payload.sub === "string" && payload.sub) {
        return { subject: payload.sub, claims: payload as unknown as Record<string, unknown> };
      }
      return null;
    }
  } catch {
    // Fall through to the hand-rolled verifier.
  }
  // Fallback: hand-rolled RS256/JWKS verification (pre-swap path).
  try {
    if (env.CLERK_JWT_KEY) {
      const r = await verifyWithPemKey(token, env.CLERK_JWT_KEY);
      return r.ok ? { subject: r.token.subject, claims: r.token.claims } : null;
    }
    const jwksUrl = env.CLERK_JWKS_URL ?? jwksUrlForPublishableKey(env.CLERK_PUBLISHABLE_KEY);
    if (!jwksUrl) return null;
    const r = await verifyRs256Token(token, jwksFromUrl(jwksUrl, fetchFn), { issuer });
    return r.ok ? { subject: r.token.subject, claims: r.token.claims } : null;
  } catch {
    return null;
  }
}

/** Clerk Backend API: the user's GitHub login from their linked
 *  external account. Needs CLERK_SECRET_KEY. Null on any failure —
 *  a missing login only disables claiming, never sign-in itself. */
export async function githubLoginViaClerkApi(
  env: Env,
  clerkUserId: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const res = await fetchFn(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`, {
      headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    });
    if (!res.ok) return null;
    const user = (await res.json()) as {
      external_accounts?: { provider?: string; username?: string | null }[];
    };
    const gh = (user.external_accounts ?? []).find(
      (a) => a.provider === "oauth_github" || a.provider === "github",
    );
    return gh?.username ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the request's session to a Talents user, mirroring the
 * user row into D1 on first sight. Returns null when there is no
 * valid session (or Clerk is unconfigured and no dev stub exists).
 */
export async function resolveSession(
  env: Env,
  req: Request,
  fetchFn: typeof fetch = fetch,
): Promise<SessionUser | null> {
  const mock = authMockUser(env);
  if (mock) {
    await upsertUser(env.DB, mock.clerkUserId, mock.githubLogin);
    return mock;
  }
  if (!clerkConfigured(env)) return null;
  const token = sessionTokenFromRequest(req);
  if (!token) return null;
  const verified = await verifySessionToken(token, env, fetchFn);
  if (!verified) return null;

  const clerkUserId = verified.subject;
  const existing = await getUser(env.DB, clerkUserId);
  if (existing?.githubLogin) return existing;

  let githubLogin = existing?.githubLogin ?? null;
  const claimLogin = verified.claims["github_login"];
  if (typeof claimLogin === "string" && claimLogin) githubLogin = claimLogin;
  if (!githubLogin) githubLogin = await githubLoginViaClerkApi(env, clerkUserId, fetchFn);
  await upsertUser(env.DB, clerkUserId, githubLogin);
  return { clerkUserId, githubLogin };
}

export async function getUser(db: D1Like, clerkUserId: string): Promise<SessionUser | null> {
  try {
    const row = await db
      .prepare("SELECT clerk_user_id, github_login FROM users WHERE clerk_user_id = ?")
      .bind(clerkUserId)
      .first<{ clerk_user_id: string; github_login: string | null }>();
    return row ? { clerkUserId: row.clerk_user_id, githubLogin: row.github_login } : null;
  } catch {
    return null; // pre-0005 schema: auth still verifies, cache just misses
  }
}

export async function upsertUser(db: D1Like, clerkUserId: string, githubLogin: string | null): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO users (clerk_user_id, github_login, created_at) VALUES (?, ?, ?)
         ON CONFLICT(clerk_user_id) DO UPDATE SET github_login = COALESCE(excluded.github_login, users.github_login)`,
      )
      .bind(clerkUserId, githubLogin, new Date().toISOString())
      .run();
  } catch { /* mirror is best-effort; the session itself already verified */ }
}
