// Stripe webhook verification + event shaping (Creator Experience,
// P4) — pure WebCrypto, no SDK, no platform imports.
//
// Signature scheme (Stripe "v1"): the Stripe-Signature header is
// `t={unix},v1={hex}` (possibly several v1 entries during key
// rotation); the signed payload is the string "{t}.{rawBody}" and
// the signature is HMAC-SHA256 with the webhook signing secret.
// Verification is constant-time and rejects timestamps older than a
// tolerance window (default 5 minutes, Stripe's own default) to
// bound replay. The RAW body must be verified — any JSON re-
// serialization breaks the signature, so handlers verify before
// parsing.

import { splitPrice } from "./fees.js";

const textEncoder = new TextEncoder();

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type SignatureResult = { ok: true } | { ok: false; reason: string };

export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  opts: { now?: Date; toleranceSec?: number } = {},
): Promise<SignatureResult> {
  if (!signatureHeader) return { ok: false, reason: "missing Stripe-Signature header" };
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") timestamp = v;
    if (k === "v1") signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) {
    return { ok: false, reason: "malformed Stripe-Signature header" };
  }
  const t = Number(timestamp);
  if (!Number.isFinite(t)) return { ok: false, reason: "non-numeric signature timestamp" };
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const tolerance = opts.toleranceSec ?? 300;
  if (Math.abs(nowSec - t) > tolerance) {
    return { ok: false, reason: `signature timestamp outside ${tolerance}s tolerance` };
  }
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  if (signatures.some((s) => constantTimeEqual(s, expected))) return { ok: true };
  return { ok: false, reason: "signature mismatch" };
}

// ---------------------------------------------------------------------------
// checkout.session.completed → purchase + entitlement
// ---------------------------------------------------------------------------

export interface CheckoutSessionObject {
  id: string;
  payment_intent?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null } | null;
  metadata?: Record<string, string> | null;
  payment_status?: string | null;
}

export interface PurchaseDraft {
  skillId: string;
  buyerClerkId: string | null;
  buyerEmail: string | null;
  checkoutSession: string;
  paymentIntent: string | null;
  amountCents: number;
  feeCents: number;
  creatorCents: number;
}

/**
 * Shape a completed checkout session into the purchase row to write.
 * The split is RECOMPUTED here from the amount actually charged and
 * the listing's exclusivity at purchase time (carried in session
 * metadata by our checkout creator) — never trusted from client
 * input. Returns null when the session is not one of ours (no
 * skill_id metadata) or carries no amount.
 */
export function purchaseFromCheckoutSession(session: CheckoutSessionObject): PurchaseDraft | null {
  const skillId = session.metadata?.skill_id;
  if (!skillId) return null;
  const amount = session.amount_total;
  if (typeof amount !== "number" || amount <= 0) return null;
  const exclusive = session.metadata?.exclusive === "1";
  const split = splitPrice(amount, exclusive);
  return {
    skillId,
    buyerClerkId: session.metadata?.buyer_clerk_id || null,
    buyerEmail: session.customer_details?.email ?? session.customer_email ?? null,
    checkoutSession: session.id,
    paymentIntent: session.payment_intent ?? null,
    amountCents: split.amountCents,
    feeCents: split.feeCents,
    creatorCents: split.creatorCents,
  };
}

/** Minimal structural view of a Stripe event envelope. */
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export function parseStripeEvent(rawBody: string): StripeEvent | null {
  try {
    const parsed = JSON.parse(rawBody) as StripeEvent;
    if (typeof parsed?.type !== "string" || typeof parsed?.data?.object !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
