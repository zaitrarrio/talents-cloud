# Stitch Run — Talents ST-A Marquee + ST-B Hangar
Ran 2026-11-10 08:03–08:31 AST (browser session, signed in as Zay Collier;
nothing paid, no settings changed, no terms dialog). All screens verified
against canvas text, not Stitch's summaries (standing rule from Rose League).

## ST-A "Talents Marquee" — https://stitch.google.com/projects/8708602427453680413
Dark storefront, amber #B4762A, poster cards. 4 screens:
1. **Discover** — full-width Invoice Reconciler hero (huge serif, outcome line,
   $19 + ≤$0.40/run, Try/Install, permission line), search, facet pills,
   rows: Trending Workflow / New MCP Servers / Portable Agents. Catalog cards
   verified verbatim (Research Tabs, Invoice Reconciler, Site Watcher).
2. **Entry detail** — Playground ("Virtual Ledger Sandbox", steps + cost line),
   declaration preview, version ledger (v2.0.1 Published, v1.4.0 REVOKED red,
   hash in mono), reviews.
3. **Library** — pinned versions, "Update v0.8.1" on Site Watcher + offline
   mark, red REVOKED on pinned v1.4.0 with explanation + Upgrade action.
4. **Creator Studio** — earnings headline, "You keep 85%", listings table,
   Publish form (name, kind, price, declaration, manifest upload).

**Violations:** (a) MCP-row cards lack an explicit "MCP" kind chip in canvas
text (other kinds show theirs); (b) some badges render as icon+publisher, not
the words Verified/Listed; (c) Stitch invented extra skills beyond the catalog
(Contract Redline, Linear Dispatch, Postgres Lens…); (d) palette lists extra
ambers (#D18D36, #F5A623) beside #B4762A. One correction pass ran (fix MCP
chip + badge text on Discover) — Stitch claimed fixed; canvas text still shows
no MCP chip → **unresolved**.

## ST-B "Talents Hangar" — https://stitch.google.com/projects/9208503597238442400
Light warm paper #EDEAE4, fleet-first + provenance. 4 screens:
1. **Hangar home** — "4 Installed Units, 3 Active, 1 Revoked", run cost
   $24.60 of $50 quota; fleet grid: pinned version, health, last run, offline
   marks, provenance line per card. All 4 catalog cards verified verbatim.
2. **Entry detail (lineage-first)** — ProvenanceChain: source repo → signed by
   @ledgerline (SHA256 fingerprint, mono) → Reviewed PASS → Published v2.0.1 →
   pinned; declaration box, version ledger (v1.4.0 REVOKED UPSTREAM),
   "Migrate & Pin v2.0.1" + "Try in Sandbox".
3. **Discover** — search-first, facet pills, full trust lines; Legacy CRM Sync
   greyed "UNCLAIMED — DISCOVERY ONLY", install disabled, only "View raw code
   repo" — no Install button. Correct per contract.
4. **Publisher profile** — @ledgerline, VERIFIED, signing-key fingerprint in
   mono, "ALL VERSIONS SIGNED · 0 REVOCATIONS", entries as cards (+ one
   Stitch-invented entry, General Ledger Syncer).

**Violation:** Research Tabs card on Discover shows no "FREE" price in canvas
text (all other cards show prices). One correction pass ran — Stitch asserted
FREE is rendered; canvas text still shows none → **unresolved** (summary and
canvas disagree; canvas wins).

## Verdict for selection
ST-B is the cleaner run (Hangar home + lineage detail are the strongest trust
surfaces of all four options). ST-A has the stronger storefront hero. Both
carry the usual Stitch pattern: nails the look, drifts small contract details
(invented entries, 1–2 missing labels) that must be constrained at build time,
never patched after.
