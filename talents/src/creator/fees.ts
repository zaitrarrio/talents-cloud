// Creator money math (P4) — pure functions, no platform imports.
//
// Fee schedule (ARCHITECTURE-v2 §9 P4 gate: "payout split 85/15"):
//   standard listing  → creator keeps 85%, platform fee 15%
//   exclusive listing → creator keeps 88%, platform fee 12%
// The publisher marks a listing exclusive in Creator Studio (the
// `exclusive` flag in listing_overrides) — it means the publisher
// sells that listing only on Talents.
//
// Rounding rule (documented, unit-tested): the platform fee is
// FLOORED to whole cents and the creator receives the remainder.
// fee = floor(amount * feeRate); creator = amount - fee.
// Flooring the fee (never the creator's share) means rounding dust
// always lands in the creator's favour, and fee + creator always
// equals the amount charged — no cent is created or lost.

export const STANDARD_FEE_BPS = 1500; // 15.00%
export const EXCLUSIVE_FEE_BPS = 1200; // 12.00%

export interface PriceSplit {
  amountCents: number;
  feeCents: number;
  creatorCents: number;
  feeBps: number;
  exclusive: boolean;
}

export function splitPrice(amountCents: number, exclusive: boolean): PriceSplit {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new Error(`amount must be a non-negative integer of cents, got ${amountCents}`);
  }
  const feeBps = exclusive ? EXCLUSIVE_FEE_BPS : STANDARD_FEE_BPS;
  const feeCents = Math.floor((amountCents * feeBps) / 10000);
  return {
    amountCents,
    feeCents,
    creatorCents: amountCents - feeCents,
    feeBps,
    exclusive,
  };
}

/** Format cents as a USD price string for display ("$12.50"). */
export function formatPrice(cents: number, currency = "usd"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  // Only USD is enabled in P4; other currencies fall back to a
  // code-prefixed rendering rather than a wrong symbol.
  return currency === "usd" ? `${sign}$${dollars}.${rest}` : `${sign}${currency.toUpperCase()} ${dollars}.${rest}`;
}
