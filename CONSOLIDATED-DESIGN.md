# Skills Marketplace & Registry — Consolidated Product Design
Working name: **Talents** (the marketplace) running as the **Gia Store / Registry**
inside Gia OS. One product, two surfaces: a public marketplace and the registry
that makes every listing installable, verifiable, and revocable.

Consolidates: SkillHub v1–v3, Kaplit, Talents (both builds), Threads.dev discovery,
and the Gia skills-registry audit + merge plan (2026-11-05). Source detail:
`SOURCE-EXTRACT.md`. Architecture: `ARCHITECTURE-v2.md`.

> **REVISION 2026-11-10 (user direction, after reviewing the original SkillHub
> architecture):** UI base = **CC-B Grove**. Developer experience = **GitHub**:
> `owner/name` named identities and predictable URLs
> (`talents.sh/skills/{owner}/{name}`) are the only public identity. Skills are
> **available with minimal changes and NO import/export**: the product is a
> meta-registry that indexes skills in place from their original sources
> (GitHub / npm / git / marketplace.json) — it stores metadata, pointers and
> attestations, never the skill as source of truth, and installs resolve from
> the developer's source. Where §§2–6 below describe package uploads, registry
> R2 blobs, internal `skill.<name>` ids, or legacy import, **ARCHITECTURE-v2
> supersedes them**; the journeys, trust ceremony, pricing and scope stand.

---

## 1. The product in one paragraph

A three-sided marketplace where **creators** publish agent skills, MCP servers,
and portable agent bundles; **users** discover them by the goal they want done —
not by tool name — try them in a Playground, and install them only after seeing a
plain-language declaration of exactly what the skill can touch; and **enterprises**
deploy approved, pinned, signed versions into their own workspaces with an audit
trail. Every package is signed, versioned immutably, metered per run, and kill-
switchable. Creators earn 85–88% via Stripe Connect.

## 2. What each ancestor contributes (nothing good is dropped)

| Keep | From | Why it survives |
|------|------|-----------------|
| `owner/skill` namespacing | SkillHub v1 | Human, ownable, collision-free identity |
| Stripe Connect Express, 85/88% creator share | SkillHub v1 | The monetization thesis, unchanged |
| Hybrid search (keyword + semantic) | SkillHub v2 | Discovery is the product (Threads.dev proved it standalone) |
| Mining/crawling undeclared repos | SkillHub v2 + Kaplit | Cold-start supply: the registry indexes what already exists |
| Three-layer access control (public / workspace / enterprise) | SkillHub v2 | Maps cleanly onto consumer → team → enterprise |
| MCP servers as first-class entries | Kaplit | A skill, an MCP server, and an agent bundle are one catalog, three kinds |
| Three-sided model + goal-driven consumer flows | Talents (June) | Consumers buy outcomes ("close my books"), not tools |
| Playground (try before install) | Talents (June) | Trust + conversion; sandboxed, metered, no local access |
| Enterprise deployments (pinned, approved sets) | Talents (June) | The revenue anchor; needs signing + audit, which Gia has |
| Portable bundles + offline run | Talents (July) + Gia local | A purchased skill must work in the desktop/local agent, offline |
| Cloudflare Workers + Hono + D1 (+ Rust/WASM kernel) | Talents (July) | Also Gia's stack — one deployment target, edge discovery |
| Signed manifest, declared permissions enforced in the gate | Gia local (gia-core) | The trust model no Talents version ever had — the differentiator |
| Prepare → declaration → confirm install | Gia local | No one-click installs, anywhere, ever |
| Kill switch / revoked versions | Gia local | Marketplace safety that can actually be enforced client-side |
| Unified directory (skills + agents + MCP + connectors) | Gia cloud + Threads.dev | One search box over everything installable |

**Explicitly retired:** SkillHub v3's Vercel-only single-app collapse (the product
outgrew one app), per-user markdown skills edited in place with no version history
(Gia cloud registry A), whole-phrase substring search, and localStorage "installs".

## 3. Users & sides

- **Creators** — indie skill authors, agencies, MCP server maintainers.
  Need: publish in minutes (CLI + web), versioning, pricing, analytics, payout.
- **Consumers (goal-driven)** — non-developer users of Gia. Arrive with a goal,
  get a recommended stack (skill + MCP + agent), try it, install it.
- **Pro / developer users** — browse by capability, read the manifest and the
  declaration before install, pin versions, run locally/offline.
- **Enterprise admins** — approve a catalog subset, pin versions, set tier caps,
  read run/audit logs, revoke instantly.

## 4. Core concepts (the contract vocabulary)

- **Entry kinds (one catalog):** `skill/workflow` (declarative steps, engine-run),
  `skill/playbook` (SKILL.md a model follows), `mcp` (server endpoint + tool list),
  `agent` (portable agent bundle, sandboxed code), `connector` (listed, not sold v1).
- **Identity:** `owner/name` for display; canonical id `skill.<name>` / `mcp.<name>` /
  `agent.<name>` + immutable semver per version. A version, once published, never changes.
- **Manifest v1.1** (Gia local `skill.json` extended): `kind`, `tags[]`, `author`,
  `icon`, typed `inputs/outputs`, and `requires {tools, scopes, maxTier}` — declared
  up front, enforced at run time, rendered in plain language at install.
- **Declaration:** the human-readable permission sheet generated from the manifest.
  Install = prepare → read declaration → confirm. Signature (ed25519) + content hash
  verified client-side on every install, on every transport.
- **Trust tiers:** Unlisted (link-only) → Listed (reviewed manifest, signature valid)
  → Verified Publisher (identity + signing key registered) → Enterprise Approved
  (an admin's pin, per-workspace).
- **Pricing models:** Free · One-time · Subscription · Per-run (metered, capped by
  the buyer at install). Creator share 85% (standard) / 88% (exclusive launch tier),
  Stripe Connect Express payouts — SkillHub v1 terms, kept verbatim.
- **Playground:** every listed entry runs in the sandbox against sample or
  user-supplied input before install; runs are metered and shown as "Playground run",
  never granted local tools.

## 5. The five user journeys

1. **Goal → Stack → Done (consumer):** "Reconcile my invoices" → search returns a
   goal stack (1 playbook skill + 1 MCP server) → Playground runs it on a sample →
   one declaration covering the stack → install → it appears in Canvas, runnable.
2. **Search → Inspect → Install (pro):** tokenized hybrid search → detail page shows
   manifest, declaration, versions, publisher trust, run stats → pin a version →
   install ceremony → available in the local agent, offline-capable if workflow kind.
3. **Publish (creator):** `talents publish` (CLI) or web upload → manifest validated,
   package signed with the publisher key → review checks (manifest/declaration match,
   no undeclared tools) → listed → analytics + Stripe payouts in the Creator Studio.
4. **Curate → Deploy (enterprise):** admin approves entries, pins versions, caps
   tiers → workspace members see only the approved catalog → every run logged →
   revoke a version and every surface refuses it within one catalog refresh.
5. **Discover without buying (Threads.dev mode):** the public directory is crawlable
   and searchable with no account; mined external repos appear as *unclaimed listings*
   (discovery only, no install, no sale) until the owner claims and signs them.

## 6. Feature set (scoped; the 120-feature PRD, cut to what ships)

**V1 — Registry + Marketplace core**
- Unified catalog + FTS5/semantic hybrid search, tokenized, paginated, faceted
  (kind, price, tier, publisher trust), installed marked not hidden.
- Detail pages: manifest, declaration, versions + changelog, reviews/ratings,
  run stats, publisher card.
- Publish flow (CLI + web), signing, version ledger, kill switch.
- Install ceremony (declaration-before-confirm) on web + local agent.
- Playground (sandboxed trial runs, sample data, metered).
- Payments: Stripe Connect Express, free/one-time/subscription/per-run pricing.
- Creator Studio: listings, versions, sales/run analytics, payouts.
- My Library: installed, pinned versions, update & revoke notices, offline status.

**V1.5 — Sides widen**
- Goal Stacks (curated bundles, one declaration, revenue split across creators).
- Enterprise workspaces: approved catalogs, pins, tier caps, audit log export.
- Unclaimed-listing claiming (from the crawler/miner pipeline).
- Ratings abuse controls, publisher verification program.

**V2 — Portable & offline**
- Portable Agent Bundles as a paid kind with the Rust/WASM kernel runtime.
- Desktop (Tauri) super-agent client: local registry mirror, offline run.
- Cross-host portability: install the same pinned bundle in Gia web, desktop, and
  third-party hosts that speak the bundle spec.

## 7. Design directions offered for selection (4)

All four implement the same journeys and the same DESIGN contract tokens where
Gia is the host; they differ in *posture* — what the first screen optimises for.
Full prompts: `CLAUDE-CODE-PROMPTS.md`, `STITCH-PROMPTS.md`. Built prototypes:
`ui-claude-code/`, `ui-stitch/`.

| Option | Built on | Posture | First screen optimises for |
|--------|----------|---------|----------------------------|
| **CC-A "Atlas"** | Claude Code | Developer-first registry. Gia warm-editorial system, dense, search-first, manifest-forward. | Finding + vetting an entry fast |
| **CC-B "Grove"** | Claude Code | Consumer goal-driven marketplace. Card/poster-led, stacks and Playground front and centre. | "What do you want done?" |
| **ST-A "Marquee"** | Google Stitch | Storefront. Hero featured entry, curated rows, big cover art — Talents' Marquee direction. | Browsing + featured discovery |
| **ST-B "Hangar"** | Google Stitch | Owner's hangar + lineage. Installed fleet, versions, provenance chain — Talents' Hangar/Lineage directions. | Managing what you own + trust |

Recommendation (unchanged from the merge plan, restated): ship **CC-A's registry
core** (it is the Gia Store's real replacement) with **CC-B's goal-stack entry
point** as the consumer home; use ST-A/ST-B as the visual exploration to steal
cover-art and provenance treatments from. But the choice is yours — all four are
built to the same contract so screens can be mixed.

## 8. Decisions needed from you

1. **Pick a UI direction** (CC-A / CC-B / ST-A / ST-B, or a mix — name the screens).
2. **Two skill kinds vs workflow-only** (merge-plan decision, still open):
   recommendation — two kinds (`workflow` + `playbook`), plus `mcp`/`agent` as
   catalog kinds. Playbooks are how every other ecosystem's skills already work.
3. **Hosted store on the Gia assistant Worker (D1+R2)** vs standalone
   `gia-store-server`: recommendation — Worker (one auth system, Clerk; gia-core
   already speaks its layout over HTTP).
4. **Name:** Talents as the public marketplace brand with Gia Store inside Gia OS,
   or one name everywhere? Recommendation — Talents public, "Store" in-product.
5. **Legacy imports:** manual "Import from legacy Gia / SkillHub" action
   (recommended) vs automatic on first sign-in.

## 9. Non-negotiables (from the Gia trust model — no design may violate these)

- No install without the rendered declaration. No one-click installs.
- No cloud execution of workflow steps against local tools — enforcement stays
  in the local gate.
- A revoked version is refused on every surface; a tampered package never installs.
- Unclaimed/mined listings are discovery-only until claimed + signed.
- Prices always show the total and the per-run cap where metering applies.
