# Google Stitch — Prompt Pack for Options ST-A and ST-B
Run order, same lesson as Rose League: paste the system prompt first in ONE
Stitch project per option, generate screens in order, verify against DESIGN.md
canvas text (never Stitch's summaries), correct at generation — never patch
after. Reference frame: desktop web 1440 wide (this is a web marketplace;
mobile is a stacked variant, not the reference).

Shared constraints for BOTH options (append to every screen prompt):
"Every skill card must show: kind chip (Workflow/Playbook/MCP/Agent), the id in
monospace like owner/name, version, price or FREE, install count, a publisher
trust badge (Verified/Listed/Unclaimed), and one plain-language permission line
such as 'Reads email · Writes files · No network'. No emoji icons. Amber
#B4762A is the only accent. Skill names in a serif display face, ids and
versions in monospace."

Sample catalog: use the catalog in CLAUDE-CODE-PROMPTS.md verbatim (same six
entries) so Stitch options are directly comparable to the Claude Code options.

---

## Project ST-A — "Marquee" (storefront)
System prompt: "Design a web marketplace for agent skills called Talents —
the Marquee direction: a cinematic storefront, dark charcoal background,
warm amber accent #B4762A, huge serif headlines, skills presented like film
posters with cover gradients. Navigation: Discover, Library, Studio,
Publishers. Trust is visible everywhere: permission lines and publisher badges
on every card, never hidden."

Screens:
1. Discover home: "Hero: one featured skill full-width like a film marquee —
   'Invoice Reconciler' in huge serif, outcome line 'Reconciles Stripe invoices
   against your books', price $19, Try and Install buttons, permission line
   beneath. Below: a search bar, kind facet pills, then curated rows
   'Trending workflows', 'New MCP servers', 'Portable agents' as poster cards."
2. Entry detail (poster-first): "Same featured skill as a detail page: poster
   header, outcome first, a Playground panel 'Try it on sample data' with steps
   and cost, a declaration preview box listing exactly what it can touch, a
   version ledger table (version, changelog, hash, status), reviews below."
3. Library: "My installed skills as poster cards in a dark hangar shelf: pinned
   version, 'Update available' tag on one, red 'Revoked' tag on one with a
   one-line explanation, offline-ready mark on the portable agent."
4. Creator Studio: "Creator dashboard: earnings headline number, a listings
   table with version/status/sales, an 85% revenue-share note, and a Publish
   form (name, kind, manifest upload, price)."

## Project ST-B — "Hangar + Lineage" (owner's fleet & provenance)
System prompt: "Design a web app for managing installed agent skills called
Talents Hangar — light warm paper background #EDEAE4, amber accent #B4762A,
serif names, monospace ids. Posture: an owner's hangar — your installed fleet
first, the store second — and every skill carries a visible provenance chain:
source, signed by, reviewed, published, pinned. Calm, precise, trustworthy."

Screens:
1. Hangar home: "My fleet: installed skills as hangar cards in a grid, each
   with pinned version, health status (Up to date / Update ready / Revoked),
   last run, offline mark; header shows fleet count and total run cost this
   month; a search bar to the store sits at the top, secondary to the fleet."
2. Entry detail (lineage-first): "Skill detail led by its ProvenanceChain:
   vertical chain Source repo → Signed by @ledgerline (key fingerprint in
   monospace) → Reviewed → Published v2.0.1 → You pinned v2.0.1. Beside it the
   declaration box, version ledger, and Install/Try actions."
3. Discover (store, secondary): "Search-first catalog: tokenized search bar,
   facet pills (kind, price, trust, tier), result cards with full trust lines;
   one result is greyed 'Unclaimed — discovery only' with no Install button."
4. Publisher profile: "Publisher page: PublisherCard with trust badge and
   signing-key fingerprint, their entries as cards, and a provenance summary
   'All versions signed · 0 revocations'."

## Review gate (do not skip)
Score every generated screen against DESIGN.md §3/§7: trust elements present?
declaration gate shown? unclaimed has no Install? revoked explained? Log the
run (project URL, what generated, violations, corrections) in
`ui-stitch/STITCH-RUN.md` — verify against canvas text, not Stitch summaries.
