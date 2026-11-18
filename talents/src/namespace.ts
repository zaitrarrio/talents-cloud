// Namespace identity: GitHub-like owner/name rules, first-come-first-served
// claims, and GitHub-ownership proof. The namespace is the trust anchor:
// you install `anthropics/document-skills` because you trust `anthropics`.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FetchFn } from "./types.js";

/** GitHub login rules: 1–39 chars, alphanumeric or hyphen, no leading/trailing hyphen, no consecutive hyphens. */
export function isValidOwnerSlug(owner: string): boolean {
  if (typeof owner !== "string" || owner.length < 1 || owner.length > 39) return false;
  if (!/^[a-zA-Z0-9-]+$/.test(owner)) return false;
  if (owner.startsWith("-") || owner.endsWith("-")) return false;
  if (owner.includes("--")) return false;
  return true;
}

/** Skill name rules: lowercase slug, 1–100 chars, alphanumeric + hyphen/underscore/dot, no leading dot/hyphen. */
export function isValidSkillName(name: string): boolean {
  if (typeof name !== "string" || name.length < 1 || name.length > 100) return false;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return false;
  if (name.includes("..")) return false;
  return true;
}

export function parseIdentity(id: string): { owner: string; name: string } | null {
  const parts = id.split("/");
  if (parts.length !== 2) return null;
  // Canonical identities are lowercase; normalize before validating.
  const owner = parts[0].toLowerCase();
  const name = parts[1].toLowerCase();
  if (!isValidOwnerSlug(owner) || !isValidSkillName(name)) return null;
  return { owner, name };
}

export function canonicalUrl(owner: string, name: string): string {
  return `https://talents.sh/skills/${owner}/${name}`;
}
export function profileUrl(owner: string): string {
  return `https://talents.sh/${owner}`;
}

// ---------------------------------------------------------------------------
// Claim store (P0: JSON-file backed; production target is the Postgres
// `namespaces` table in prisma/schema.prisma).
// ---------------------------------------------------------------------------

export interface Claim {
  owner: string;
  claimedBy: string; // GitHub login of the claimant
  claimedAt: string;
  verified: boolean;
}

export class NamespaceStore {
  private claims = new Map<string, Claim>();

  constructor(private filePath?: string) {
    if (filePath && existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, Claim>;
      for (const [k, v] of Object.entries(raw)) this.claims.set(k, v);
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.claims), null, 2));
  }

  get(owner: string): Claim | undefined {
    return this.claims.get(owner.toLowerCase());
  }

  /** First-come-first-served. Throws ClaimConflict if another identity holds it. */
  claim(owner: string, claimedBy: string, verified: boolean): Claim {
    if (!isValidOwnerSlug(owner)) throw new Error(`invalid owner slug: ${owner}`);
    const key = owner.toLowerCase();
    const existing = this.claims.get(key);
    if (existing) {
      if (existing.claimedBy.toLowerCase() === claimedBy.toLowerCase()) return existing;
      const err = new Error(`namespace "${key}" is already claimed by ${existing.claimedBy}`);
      err.name = "ClaimConflict";
      throw err;
    }
    const c: Claim = { owner: key, claimedBy, claimedAt: new Date().toISOString(), verified };
    this.claims.set(key, c);
    this.persist();
    return c;
  }
}

// ---------------------------------------------------------------------------
// GitHub ownership proof.
// A token is proof for `owner` when the authenticated user IS the owner
// (user namespace) or is an org admin (role=admin) of the owner org.
// The fetch function is injectable; the token is only ever placed in an
// Authorization header for api.github.com — never logged, never stored.
// ---------------------------------------------------------------------------

export type OwnershipResult =
  | { ok: true; via: "self" | "org-admin"; githubLogin: string }
  | { ok: false; reason: string };

export async function verifyGithubOwnership(
  owner: string,
  token: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<OwnershipResult> {
  if (!isValidOwnerSlug(owner)) return { ok: false, reason: `invalid owner slug: ${owner}` };
  if (!token) return { ok: false, reason: "no token supplied" };
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "talents-registry-p0",
  };
  const meRes = await fetchFn("https://api.github.com/user", { headers });
  if (!meRes.ok) return { ok: false, reason: `GitHub /user returned ${meRes.status}` };
  const me = (await meRes.json()) as { login?: string };
  if (!me.login) return { ok: false, reason: "GitHub /user returned no login" };
  if (me.login.toLowerCase() === owner.toLowerCase()) {
    return { ok: true, via: "self", githubLogin: me.login };
  }
  // Org path: GET /user/memberships/orgs/{org} → { role: "admin" | "member", state }
  const memRes = await fetchFn(
    `https://api.github.com/user/memberships/orgs/${encodeURIComponent(owner)}`,
    { headers },
  );
  if (memRes.ok) {
    const mem = (await memRes.json()) as { role?: string; state?: string };
    if (mem.state === "active" && mem.role === "admin") {
      return { ok: true, via: "org-admin", githubLogin: me.login };
    }
    return { ok: false, reason: `${me.login} is not an admin of org ${owner}` };
  }
  if (memRes.status === 404) {
    return { ok: false, reason: `${owner} is not ${me.login} and no org membership exists` };
  }
  return { ok: false, reason: `GitHub membership check returned ${memRes.status}` };
}

const defaultFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, { headers: init?.headers });
  return { ok: res.ok, status: res.status, text: () => res.text(), json: () => res.json() };
};
