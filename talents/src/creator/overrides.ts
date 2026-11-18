// Listing overrides (Creator Experience, P4) — the web layer.
//
// The attested record (records.record_json) is derived from the
// publisher's SOURCE and signed by the registry. Creator edits NEVER
// touch it. They live in listing_overrides and are merged at render
// time into a DISPLAY COPY of the record:
//
//   * description_override replaces the displayed description; the
//     skill page labels it "Publisher description" because the
//     attestation vouches for the source text, not the publisher's
//     rewrite. Search cards use the override too (labelled on the
//     detail page, where trust context lives).
//   * tags are display/search metadata only.
//   * price_cents / exclusive are Talents-native commercial metadata
//     (ARCHITECTURE-v2 §2.3: pricing is the only registry-native
//     data, always optional, always web-set — never a repo file).
//   * The aggregated marketplace.json is NOT merged: it publishes
//     source metadata verbatim (its entries point at origins), with
//     the single exception that owner-unlisted records are excluded.
//
// Owner unlisting is a display status, not a record mutation: the
// verified record stays in D1 for audit, and every surface we
// operate (search, pages, aggregate, gateway) filters it out.

import type { SkillRecord } from "../types.js";

export interface ListingOverride {
  skillId: string;
  descriptionOverride: string | null;
  tags: string[] | null;
  /** null = free / not for sale. */
  priceCents: number | null;
  currency: string;
  exclusive: boolean;
  updatedAt: string;
  updatedBy: string;
}

/** A record prepared for display: the record itself, plus the
 *  creator-layer facts the templates need (kept OUT of the record so
 *  nothing here can leak into the attested JSON). */
export interface DisplayRecord {
  record: SkillRecord;
  /** The description to show (override when set). */
  description: string;
  /** True when `description` came from the publisher, not the source. */
  descriptionIsPublisher: boolean;
  tags: string[];
  priceCents: number | null;
  currency: string;
  exclusive: boolean;
  hasOverride: boolean;
}

export function toDisplayRecord(record: SkillRecord, override?: ListingOverride | null): DisplayRecord {
  const hasOverride = Boolean(override);
  const description = override?.descriptionOverride?.trim()
    ? override.descriptionOverride
    : record.description;
  return {
    record,
    description,
    descriptionIsPublisher: Boolean(override?.descriptionOverride?.trim()),
    tags: override?.tags ?? [],
    priceCents: override?.priceCents ?? null,
    currency: override?.currency ?? "usd",
    exclusive: override?.exclusive ?? false,
    hasOverride,
  };
}

/** Merge a batch of records for search results / cards. Returns new
 *  record objects with the display description swapped in — the
 *  underlying attested records are not mutated (shallow copies; the
 *  nested declaration/attestation objects are shared by reference
 *  and never written). */
export function mergeForDisplay(
  records: SkillRecord[],
  overrides: Map<string, ListingOverride>,
): SkillRecord[] {
  return records.map((r) => {
    const o = overrides.get(r.id);
    if (!o?.descriptionOverride?.trim()) return r;
    return { ...r, description: o.descriptionOverride };
  });
}

/** Filter out owner-unlisted records. Applied at every read surface:
 *  search, profile/home listings, the aggregate builder input, and
 *  the MCP gateway's record lookup. */
export function excludeUnlisted<T extends { id: string }>(items: T[], unlisted: Set<string>): T[] {
  if (unlisted.size === 0) return items;
  return items.filter((i) => !unlisted.has(i.id));
}

export function isPriced(o?: ListingOverride | null): boolean {
  return Boolean(o && o.priceCents !== null && o.priceCents > 0);
}

/** Validate + normalize a listing-edit form submission. Returns the
 *  fields to persist, or an error message. Price input is dollars as
 *  typed by the publisher ("12.50"); empty = free. */
export function normalizeListingEdit(input: {
  description?: string | null;
  tags?: string | null;
  price?: string | null;
  exclusive?: boolean;
}): { ok: true; descriptionOverride: string | null; tags: string[] | null; priceCents: number | null; exclusive: boolean }
  | { ok: false; error: string } {
  const descriptionOverride = (input.description ?? "").trim() || null;
  if (descriptionOverride && descriptionOverride.length > 600) {
    return { ok: false, error: "description override is limited to 600 characters" };
  }
  let tags: string[] | null = null;
  if (input.tags !== undefined && input.tags !== null) {
    const parsed = input.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const deduped = [...new Set(parsed)].slice(0, 8);
    tags = deduped.length ? deduped : null;
    if (deduped.some((t) => t.length > 32)) return { ok: false, error: "tags are limited to 32 characters each" };
  }
  let priceCents: number | null = null;
  const priceRaw = (input.price ?? "").trim();
  if (priceRaw) {
    if (!/^\d+(\.\d{1,2})?$/.test(priceRaw)) {
      return { ok: false, error: "price must be a dollar amount like 12 or 12.50" };
    }
    priceCents = Math.round(Number(priceRaw) * 100);
    if (priceCents <= 0) return { ok: false, error: "price must be at least $0.01 — leave it empty for a free listing" };
    if (priceCents > 100_000_00) return { ok: false, error: "price is capped at $100,000 for now" };
  }
  return { ok: true, descriptionOverride, tags, priceCents, exclusive: Boolean(input.exclusive) };
}
