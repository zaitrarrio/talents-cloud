# Skills Marketplace — DESIGN.md (contract for all 4 UI options)
Every option (Claude Code A/B, Stitch A/B) is built to this contract.
If a screen violates a rule here, the screen is wrong — not the rule.
Host context: Gia OS (Chat / Canvas / Store shell) + standalone Talents site.

## 1. Essence
- A registry you can *trust at a glance*: every card shows what a skill can touch
  before you ever click install. Permissions are a headline feature, not fine print.
- Feels like: a well-run tool library crossed with an app store. Never: a crypto
  marketplace, a plugin dump, or a dense admin table as the home screen.
- Voice: short, plain, verb-first. "Install", "Try in Playground", "See declaration".

## 2. Gia tokens (host system — Claude Code options use these exactly)
```
--bg:#EDEAE4  --bg-warm:#F5F1EA  --card:#FCFBF9  --ink:#1A1714  --ink-soft:#4A443D
--muted:#837A72  --border:rgba(26,23,20,.08)  --accent:#B4762A  --accent-deep:#8A5A1F
--accent-soft:rgba(180,118,42,.10)  --good:#2F7D4F  --warn:#B4762A  --bad:#B3402A
Serif display: Newsreader/Georgia · Sans: Instrument Sans/Inter · Mono: JetBrains Mono (ids, versions)
Radius 12–16px cards · 999px pills · warm subtle shadows · stroke icons only, NO emoji icons in UI chrome
```
Stitch options may explore a dark storefront variant (Talents Marquee/Hangar)
but must keep: amber accent family, serif display for names, mono for ids/versions,
and the trust elements below on every card.

## 3. Trust elements — REQUIRED on every entry card, every option
Kind chip (Workflow / Playbook / MCP / Agent) · canonical id in mono (`owner/name`) ·
version · price or FREE · install count · publisher + trust badge
(Verified / Listed / Unclaimed) · **permission summary line** in plain words
(e.g. "Reads email · Writes files · No network") · max tier chip when above Read.

## 4. Core components (name them exactly this in prompts and code)
- **EntryCard** — icon, name (serif), id (mono), 1-line outcome description,
  trust elements (§3), two actions: Try / Install.
- **DeclarationSheet** — the install ceremony: plain-language list of tools,
  scopes, tier, price + per-run cap, pinned version; Confirm is the only primary
  button; nothing installs before it.
- **GoalStack** — a bundle answering one goal: entries listed, ONE combined
  declaration, one total price, creator split shown.
- **PlaygroundPanel** — sample-input run with live steps, cost so far, and the
  label "Playground — sample data, no access to your files".
- **VersionLedger** — version rows: semver, changelog, hash (short, mono),
  status (Published / Revoked in red), Pin action.
- **PublisherCard** — avatar/initials, name, trust badge, signing-key fingerprint
  (mono, short), entries count, sales/runs.
- **ProvenanceChain** (Lineage) — source → signed by → reviewed → published →
  installed-as-pinned, as a vertical chain with hashes.
- **LibraryRow / HangarCard** — installed entries: pinned version, update
  available?, revoked flag, offline-ready mark, Run / Manage.

## 5. Screens every option must show (its own posture, all journeys reachable)
1. Home / Discover (search-first or storefront-first, per posture)
2. Search results with facets (kind, price, trust, tier)
3. Entry detail (manifest summary, declaration preview, VersionLedger, reviews)
4. Install flow (DeclarationSheet as modal/sheet)
5. Playground (on detail or its own panel)
6. My Library / Hangar (installed, pins, updates, revoked flags)
7. Creator Studio (publish form + listings + earnings summary)
8. Publisher profile (PublisherCard + ProvenanceChain)

## 6. Content rules
- Descriptions are outcomes, not tech: "Reconciles Stripe invoices against your
  books" — not "Uses the Stripe API with webhook handlers".
- Prices: total always; per-run shows the cap the buyer sets ("≤ $0.40/run, your cap").
- Unclaimed (mined) entries: greyed, "Unclaimed — discovery only", NO Install button.
- Revoked: red status, no Run button, explanation in one sentence.
- Max 3 stats per card (installs, rating, runs) — full data lives on detail.

## 7. Accessibility / anti-patterns
Contrast ink-on-bg ≥ 7:1 for body; tap targets ≥ 44px; focus states visible;
reduced-motion respected. Reject on sight: white-on-white plugin grids with no
trust data · one-click Install anywhere · emoji as icons · a price without the
creator share or cap context on Studio screens · hiding permissions below the fold
on the detail page.
