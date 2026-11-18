// Namespace claim rules for the web (Creator Experience, P4).
// Pure decision logic — the D1/HTTP glue lives in cf/src/creator.ts.
//
// The namespace is the trust anchor (ARCHITECTURE-v2 §2): `owner` in
// `owner/name`. Claims are first-come-first-served (engine model,
// src/namespace.ts). The WEB claim path's ownership proof is the
// signed-in Clerk user's verified GitHub identity (Clerk GitHub
// social connection):
//
//   * The GitHub login IS the namespace (case-insensitive) → claim
//     succeeds with method "github-login-match". This is the web
//     equivalent of the engine's "self" ownership result.
//   * Any other owner (an org the user admins, a name that merely
//     resembles their login, an MCP-registry label) → NOT claimable
//     by login match. Org claims run through the engine's token proof
//     (verifyGithubOwnership, method "org-admin-token") — a separate
//     flow, not this one.
//   * Owners whose catalog presence comes ONLY from the MCP Registry
//     feed (reverse-DNS labels like "usefulapi" from io.usefulapi.*)
//     are not GitHub logins at all: no GitHub sign-in can ever match
//     them, so the UI must say "claim not available via GitHub
//     sign-in" instead of offering a claim that cannot succeed.
//     Detection is data-driven: an owner is GitHub-backed iff at
//     least one of its records lives in a repo OWNED BY that same
//     GitHub account (sourceRepo's owner segment == the namespace).
//     Registry records pointing at a third party's repo (the
//     usefulapi label → m190's repo) do not count.

import { isValidOwnerSlug } from "../namespace.js";
import type { SkillRecord } from "../types.js";

export type ClaimMethod = "github-login-match" | "org-admin-token";

export interface Claim {
  owner: string;
  clerkUserId: string;
  githubLogin: string;
  method: ClaimMethod;
  claimedAt: string;
}

/** Is this owner backed by GitHub (claimable in principle), or is it
 *  a registry-label namespace with no GitHub identity behind it?
 *  Backed means: at least one record's source repo is owned BY this
 *  namespace (repo owner segment == owner). A record that merely
 *  POINTS at someone else's repo — e.g. MCP-Registry records under
 *  the label "usefulapi" whose repository is m190/usefulapi-mcp —
 *  does not make the label a GitHub identity. */
export function ownerIsGithubBacked(owner: string, records: Pick<SkillRecord, "sourceRepo">[]): boolean {
  const want = owner.toLowerCase();
  return records.some((r) =>
    typeof r.sourceRepo === "string" && r.sourceRepo.split("/")[0]?.toLowerCase() === want);
}

export type ClaimDecision =
  | { ok: true; method: "github-login-match" }
  | { ok: false; reason: string; code: "invalid-owner" | "not-github-backed" | "no-github-login" | "login-mismatch" | "already-claimed" };

export interface ClaimContext {
  /** The signed-in Clerk user's verified GitHub login (null when the
   *  Clerk user has no GitHub external account linked). */
  githubLogin: string | null;
  /** Existing claim on this owner, if any. */
  existingClaim: Claim | null;
  /** Whether the owner's catalog records include a GitHub-backed one. */
  githubBacked: boolean;
}

/**
 * Decide a web claim attempt. `claimantClerkId` is the signed-in
 * user's Clerk id (used only for the already-claimed-by-self case).
 */
export function decideClaim(ownerRaw: string, claimantClerkId: string, ctx: ClaimContext): ClaimDecision {
  const owner = ownerRaw.toLowerCase();
  if (!isValidOwnerSlug(owner)) {
    return { ok: false, code: "invalid-owner", reason: `"${ownerRaw}" is not a valid namespace slug` };
  }
  if (ctx.existingClaim) {
    if (ctx.existingClaim.clerkUserId === claimantClerkId) {
      return { ok: true, method: ctx.existingClaim.method === "org-admin-token" ? "github-login-match" : "github-login-match" };
    }
    return {
      ok: false,
      code: "already-claimed",
      reason: `namespace "${owner}" is already claimed`,
    };
  }
  if (!ctx.githubBacked) {
    return {
      ok: false,
      code: "not-github-backed",
      reason: `namespace "${owner}" comes from the MCP Registry, not a GitHub account — claim is not available via GitHub sign-in`,
    };
  }
  if (!ctx.githubLogin) {
    return {
      ok: false,
      code: "no-github-login",
      reason: "your account has no GitHub login linked — sign in with GitHub to claim a namespace",
    };
  }
  if (ctx.githubLogin.toLowerCase() !== owner) {
    return {
      ok: false,
      code: "login-mismatch",
      reason: `your GitHub login is "${ctx.githubLogin}", which does not match namespace "${owner}"`,
    };
  }
  return { ok: true, method: "github-login-match" };
}

/** The namespace a signed-in user could claim with one click: their
 *  own GitHub login, when it exists as a catalog owner and is not yet
 *  claimed by someone else. */
export function claimableOwner(
  githubLogin: string | null,
  owners: Iterable<string>,
  claims: Map<string, Claim>,
  claimantClerkId: string,
): string | null {
  if (!githubLogin) return null;
  const owner = githubLogin.toLowerCase();
  const set = new Set([...owners].map((o) => o.toLowerCase()));
  if (!set.has(owner)) return null;
  const existing = claims.get(owner);
  if (existing && existing.clerkUserId !== claimantClerkId) return null;
  return owner;
}
