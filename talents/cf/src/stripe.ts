// Minimal Stripe API client (Creator Experience, P4) — REST over
// fetch, form-encoded, no SDK (the sandbox has no npm egress and the
// Worker bundle stays lean). Everything the creator flows need:
// Connect Express accounts + account links, account status, and
// Checkout Sessions as DESTINATION charges.
//
// The client sits behind the StripeClient interface so route
// handlers take it as a dependency and unit tests inject a fake.
// stripeClientFromEnv returns null when STRIPE_SECRET_KEY is unset —
// callers render/refuse with the honest payments-disabled state.

import type { CheckoutSessionObject } from "../../src/creator/stripe.js";
import type { Env } from "./db.js";

export interface StripeAccountState {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}

export interface CheckoutSessionResult {
  id: string;
  url: string | null;
}

export interface StripeClient {
  createConnectAccount(owner: string): Promise<{ id: string }>;
  createAccountLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<{ url: string }>;
  retrieveAccount(accountId: string): Promise<StripeAccountState>;
  createCheckoutSession(params: {
    skillId: string;
    owner: string;
    amountCents: number;
    feeCents: number;
    currency: string;
    destinationAccount: string;
    exclusive: boolean;
    buyerClerkId: string | null;
    successUrl: string;
    cancelUrl: string;
    productName: string;
  }): Promise<CheckoutSessionResult>;
  retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionObject & { payment_status?: string | null }>;
}

/** Stripe form-encoding with bracket nesting: {a: {b: 1}} → a[b]=1. */
export function formEncode(obj: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") {
      parts.push(formEncode(v as Record<string, unknown>, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

export function createStripeClient(secretKey: string, fetchFn: typeof fetch = fetch): StripeClient {
  async function call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetchFn(`https://api.stripe.com${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: body ? formEncode(body) : undefined,
    });
    const json = (await res.json()) as T & { error?: { message?: string } };
    if (!res.ok) {
      throw new Error(`Stripe ${path} failed (${res.status}): ${json.error?.message ?? "unknown error"}`);
    }
    return json;
  }

  return {
    async createConnectAccount(owner) {
      const acct = await call<{ id: string }>("/v1/accounts", {
        type: "express",
        metadata: { talents_owner: owner },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      return { id: acct.id };
    },
    async createAccountLink(accountId, refreshUrl, returnUrl) {
      const link = await call<{ url: string }>("/v1/account_links", {
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding",
      });
      return { url: link.url };
    },
    async retrieveAccount(accountId) {
      const acct = await call<{ id: string; charges_enabled: boolean; payouts_enabled: boolean }>(
        `/v1/accounts/${encodeURIComponent(accountId)}`,
      );
      return { id: acct.id, chargesEnabled: Boolean(acct.charges_enabled), payoutsEnabled: Boolean(acct.payouts_enabled) };
    },
    async createCheckoutSession(p) {
      const session = await call<{ id: string; url: string | null }>("/v1/checkout/sessions", {
        mode: "payment",
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        line_items: {
          "0": {
            quantity: 1,
            price_data: {
              currency: p.currency,
              unit_amount: p.amountCents,
              product_data: { name: p.productName },
            },
          },
        },
        payment_intent_data: {
          application_fee_amount: p.feeCents,
          transfer_data: { destination: p.destinationAccount },
        },
        metadata: {
          skill_id: p.skillId,
          talents_owner: p.owner,
          exclusive: p.exclusive ? "1" : "0",
          ...(p.buyerClerkId ? { buyer_clerk_id: p.buyerClerkId } : {}),
        },
      });
      return { id: session.id, url: session.url };
    },
    async retrieveCheckoutSession(sessionId) {
      return call(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
    },
  };
}

export function stripeClientFromEnv(env: Env): StripeClient | null {
  return env.STRIPE_SECRET_KEY ? createStripeClient(env.STRIPE_SECRET_KEY) : null;
}

/** Payments are usable for a listing only when the platform key
 *  exists AND the creator's Connect account can take charges. */
export function paymentsEnabledFor(env: Env, account: { chargesEnabled: boolean } | null): boolean {
  return Boolean(env.STRIPE_SECRET_KEY) && Boolean(account?.chargesEnabled);
}
