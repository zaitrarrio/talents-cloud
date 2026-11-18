// Install access for priced listings (Creator Experience, P4) —
// pure decision logic used by the MCP gateway and the web panel.
//
// The gateway's install ceremony is unchanged for free skills: this
// module is only consulted when a listing has a price. For a priced
// skill, install_skill's PREPARE step must not hand out the
// declaration + attestation hash (that payload IS the product's
// install path) until the caller is entitled:
//
//   entitled = a signed-in buyer's web session (web panel only), or
//              a one-time PURCHASE TOKEN presented to the gateway.
//
// Purchase tokens: after checkout, the success page shows the buyer
// a token (format `tix_` + 32 base64url chars). Only its SHA-256
// hash is stored (install_tokens). The token authorizes ONE install
// confirm of its skill: prepare accepts it to unlock the payload,
// confirm re-checks it and the store marks it used after the hash
// ceremony succeeds. Entitlements (the durable right) are recorded
// separately in `entitlements`; the token is the anonymous-bearer
// bridge between a Stripe checkout and an MCP client that has no
// Talents account.
//
// NOTHING here weakens the hash ceremony: entitlement only decides
// whether prepare/confirm may START. Confirm still re-fetches the
// source and re-verifies the attestation, for everyone.

export const TOKEN_PREFIX = "tix_";
export const TOKEN_TTL_DAYS = 30;

export function isPurchaseToken(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(TOKEN_PREFIX) && value.length >= TOKEN_PREFIX.length + 20;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a fresh purchase token (plaintext shown once to the
 *  buyer; the caller stores sha256Hex(token)). */
export function generatePurchaseToken(random: (n: number) => Uint8Array = defaultRandom): string {
  const bytes = random(24);
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${TOKEN_PREFIX}${b64}`;
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export interface TokenRow {
  tokenHash: string;
  skillId: string;
  usedAt: string | null;
  expiresAt: string;
}

export type TokenCheck =
  | { ok: true }
  | { ok: false; reason: "malformed" | "unknown" | "wrong-skill" | "spent" | "expired" };

export function checkPurchaseToken(
  presented: unknown,
  presentedHash: string | null,
  row: TokenRow | null,
  skillId: string,
  now: Date = new Date(),
): TokenCheck {
  if (!isPurchaseToken(presented) || !presentedHash) return { ok: false, reason: "malformed" };
  if (!row) return { ok: false, reason: "unknown" };
  if (row.tokenHash !== presentedHash) return { ok: false, reason: "unknown" };
  if (row.skillId !== skillId) return { ok: false, reason: "wrong-skill" };
  if (row.usedAt) return { ok: false, reason: "spent" };
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true };
}

/** The payload the gateway returns at prepare-time for a priced
 *  skill when the caller is not entitled. `checkoutUrl` is the
 *  skill's public page — buying happens on the web (Stripe Checkout
 *  needs a browser); the gateway never collects payment details. */
export function paymentRequiredPayload(args: {
  skillId: string;
  priceCents: number;
  currency: string;
  checkoutUrl: string;
}): Record<string, unknown> {
  return {
    status: "payment_required",
    skill: args.skillId,
    price: { amountCents: args.priceCents, currency: args.currency },
    checkoutUrl: args.checkoutUrl,
    notice:
      "This listing is priced. Buy it on the web at checkoutUrl — after checkout you will be shown a one-time install token. Then call install_skill again with purchaseToken set to that token to receive the prepare payload, and confirm as usual. The attestation hash ceremony is unchanged for paid installs.",
  };
}
