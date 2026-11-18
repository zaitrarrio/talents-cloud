// RS256 session-token verification against a JWKS (Creator
// Experience, P4) — pure WebCrypto, no platform imports, so the SAME
// code runs in the Worker and in Node unit tests.
//
// This is the verification core for Clerk session tokens: Clerk
// publishes its signing keys as a JWKS at
//   https://{frontendApi}/.well-known/jwks.json
// where {frontendApi} is encoded in the publishable key. The Worker
// glue (cf/src/auth.ts) prefers @clerk/backend's verifyToken when
// that package is available; this module is the dependency-free
// verifier behind the same interface, and it is what the test suite
// exercises against a MOCK Clerk issuer (a test-generated RSA keypair
// whose public half is served as a JWKS by an injected fetch).

export interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

export interface VerifiedToken {
  /** Clerk user id (the JWT `sub` claim). */
  subject: string;
  issuer: string | null;
  expiresAt: number;
  claims: Record<string, unknown>;
}

export type TokenVerifyResult =
  | { ok: true; token: VerifiedToken }
  | { ok: false; reason: string };

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s: string): Record<string, unknown> {
  const bytes = b64urlToBytes(s);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** Decode a Clerk publishable key (pk_test_… / pk_live_…) into the
 *  instance's frontend API host. The key body is base64 of
 *  "{host}$". Returns null for anything malformed — callers treat
 *  that as "Clerk not configured", never as an error page. */
export function frontendApiFromPublishableKey(pk: string | undefined | null): string | null {
  if (!pk) return null;
  const m = /^pk_(test|live)_(.+)$/.exec(pk.trim());
  if (!m) return null;
  try {
    const decoded = new TextDecoder().decode(b64urlToBytes(m[2]));
    const host = decoded.replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function jwksUrlForPublishableKey(pk: string | undefined | null): string | null {
  const host = frontendApiFromPublishableKey(pk);
  return host ? `https://${host}/.well-known/jwks.json` : null;
}

export interface JwksSource {
  /** Fetch (or otherwise produce) the current JWKS document. */
  fetchJwks(): Promise<{ keys: Jwk[] }>;
}

export function jwksFromUrl(url: string, fetchFn: typeof fetch = fetch): JwksSource {
  let cache: { at: number; keys: Jwk[] } | null = null;
  return {
    async fetchJwks() {
      // JWKS keys rotate rarely; a 10-minute cache matches Clerk's
      // own cache headers' spirit and keeps auth checks cheap. On a
      // fetch failure with a warm cache, serve the cache.
      if (cache && Date.now() - cache.at < 10 * 60_000) return { keys: cache.keys };
      try {
        const res = await fetchFn(url);
        if (!res.ok) throw new Error(`JWKS fetch returned ${res.status}`);
        const doc = (await res.json()) as { keys: Jwk[] };
        cache = { at: Date.now(), keys: doc.keys };
        return { keys: doc.keys };
      } catch (e) {
        if (cache) return { keys: cache.keys };
        throw e;
      }
    },
  };
}

export function jwksFromStatic(keys: Jwk[]): JwksSource {
  return { fetchJwks: async () => ({ keys }) };
}

/**
 * Verify an RS256 JWT against a JWKS source. Checks: structure,
 * alg=RS256, kid present in the JWKS, signature, exp (required),
 * nbf when present, and — when `issuer` is given — iss equality.
 */
export async function verifyRs256Token(
  token: string,
  source: JwksSource,
  opts: { issuer?: string; now?: Date } = {},
): Promise<TokenVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "token is not a JWT" };
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64urlToJson(parts[0]);
    claims = b64urlToJson(parts[1]);
  } catch {
    return { ok: false, reason: "token segments are not valid base64url JSON" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: `unexpected alg: ${String(header.alg)}` };
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) return { ok: false, reason: "token header has no kid" };

  let keys: Jwk[];
  try {
    keys = (await source.fetchJwks()).keys;
  } catch (e) {
    return { ok: false, reason: `JWKS unavailable: ${(e as Error).message}` };
  }
  const jwk = keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (!jwk) return { ok: false, reason: `no JWKS key for kid ${kid}` };

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch (e) {
    return { ok: false, reason: `JWKS key import failed: ${(e as Error).message}` };
  }
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let signature: Uint8Array;
  try {
    signature = b64urlToBytes(parts[2]);
  } catch {
    return { ok: false, reason: "signature is not valid base64url" };
  }
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, signed as BufferSource);
  if (!valid) return { ok: false, reason: "signature verification failed" };

  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (exp === null) return { ok: false, reason: "token has no exp claim" };
  if (exp <= nowSec) return { ok: false, reason: "token expired" };
  const nbf = typeof claims.nbf === "number" ? claims.nbf : null;
  if (nbf !== null && nbf > nowSec + 10) return { ok: false, reason: "token not yet valid" };
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) return { ok: false, reason: "token has no sub claim" };
  const iss = typeof claims.iss === "string" ? claims.iss : null;
  if (opts.issuer && iss !== opts.issuer) {
    return { ok: false, reason: `issuer mismatch: ${iss ?? "(none)"}` };
  }
  return { ok: true, token: { subject: sub, issuer: iss, expiresAt: exp, claims } };
}
