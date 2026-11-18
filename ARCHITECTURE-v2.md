# Skills Marketplace & Registry — System Architecture v2
SUPERSEDES `ARCHITECTURE.md` (v1) where they conflict. Revised 2026-11-10 at the
user's direction after review of the ORIGINAL SkillHub architecture
(share 71c8d8a9 — the full SkillHub blueprint conversation: core concept, 3 UX
designs, TS architecture, TDD v1–v3, monetization, 90-day plan, Talents spec kit).

## 0. What v1 got wrong (owned, plainly)

v1 turned the product into an **upload store**: developers packaged skills into
tars, uploaded them to registry-owned R2, legacy skills went through an import,
and the public identity was an internal `skill.<name>` id. The original
architecture said the opposite on all three points, and the user has now
restated them as requirements:

1. **It is a meta-registry, not a store.** "You never store the skills
   themselves — only the metadata and pointers. Users still install directly
   from the original sources. The registry is the catalog, not the CDN."
2. **Identity is GitHub-style and public:** `owner/name`, first-come-first-
   served, the namespace is the trust anchor (`@anthropics/skills/pdf` — you
   install it because you trust the owner). Canonical address:
   `talents.sh/skills/{owner}/{name}`.
3. **Availability requires no developer work:** a skill that already exists in
   the standard formats (a `SKILL.md` directory, a `.claude-plugin/plugin.json`
   plugin, a `.claude-plugin/marketplace.json` marketplace) is available by
   being *indexed in place*. No import, no export, no repackage, no upload.

v2 restores those three as load-bearing principles and re-fits the Gia trust
layer (signing, declaration, gate, kill switch) so it needs **zero changes**
from developers (§5).

## 1. The original architecture (as reviewed — SkillHub blueprint + TDD v3)

- **Basis:** the npm skills package + the Claude Plugin Marketplace spec
  (code.claude.com/docs/en/plugin-marketplaces). Sources the spec supports:
  GitHub repos, npm packages, git URLs, direct `marketplace.json` files.
- **Formats (unchanged, never extended by requirement):**
  - Skill = a directory with `SKILL.md` at its root (+ optional `scripts/`,
    `references/`, `assets/`).
  - Plugin = a directory with `.claude-plugin/plugin.json` + components
    (skills, commands, agents, hooks, MCP servers).
  - Marketplace = `.claude-plugin/marketplace.json` listing plugins + sources.
- **Freshness:** GitHub Adapter registers webhooks on publishing repos; a push
  that changes `marketplace.json` fires a re-validate + re-index job within
  seconds. Validation pipeline on every ingest: parse `marketplace.json`,
  validate every reachable `plugin.json`, run the same checks as
  `claude plugin validate`, extract semantic metadata, update the search
  index; failures → dead-letter queue + publisher notification.
- **Consumption with zero new tooling:** the registry publishes its OWN
  aggregated `marketplace.json` whose entries point back at the original
  git/npm/URL sources — so any Plugin-Marketplace host gets the whole catalog
  with `/plugin marketplace add talents`, and installs still resolve from the
  developer's source. Plus an **MCP gateway** (`mcp.talents.sh`): the registry
  plugin adds `search_skill` / `install_skill` tools — "the agent becomes the
  user." Every search and install can flow through it (metering point).
- **Original stack:** Next.js 15 + tRPC, Postgres 16 + Prisma (system of
  record), BullMQ + Redis (queues/cache), **Typesense** (typo-tolerant,
  indexes for Skills/Plugins/Marketplaces/Users), Stripe Connect Express,
  Clerk, R2 **only for icons/READMEs/screenshots**, Vercel + Railway/Fly workers.
- **Discovery (from the companion discovery session):** hybrid Typesense
  ranking — keyword/vector weight flips by query length (short jargon queries:
  40/60 toward vector); pre-search intent enrichment + a curated synonym
  dictionary; behavioral ranking — **30-day install retention** (via MCP
  gateway call frequency), review velocity (recent ×3), publisher trust;
  implicit user profile → personalized re-ranking; cohort trending; "gaps in
  your workflow"; in-context suggestions inside Claude Code; publisher skill
  health score; SSR skill pages with JSON-LD for SEO; cross-marketplace
  dedup (namespace + semantic similarity, canonical = highest installs /
  freshest); cold-start: 72h launch boost, seeded trials, promo pricing,
  "Rising" surface, weekly Picks.

## 2. v2 principles

1. **Catalog, not CDN.** The registry stores metadata, pointers, attestations,
   and display assets — never the skill as the source of truth.
2. **`owner/name` is the only public identity.** Internal ids stay internal.
   URLs: `talents.sh/skills/{owner}/{name}`, `talents.sh/{owner}` (profile),
   `talents.sh/skills/{owner}/{name}/releases/{tag}`, short form
   `talents.sh/s/{owner}/{name}`. Namespaces first-come-first-served;
   org namespaces verified like GitHub orgs.
3. **Zero-change availability.** If it parses under the Plugin Marketplace
   spec, it's listable. Developer effort to be *available*: **none** (already
   in an indexed marketplace/repo) to **one action** (submit a repo URL, or
   install the GitHub App so webhooks keep it fresh). Pricing is the only
   registry-native data, and it's optional metadata, set on the web — never a
   file the developer must add to their repo. (An optional `talents.json` is
   *supported* for those who want price/pins in-repo; never required.)
   **Three entry paths, all first-class (confirmed by the user 2026-11-10):**
   (1) through a marketplace's `marketplace.json`; (2) a plugin repo a
   marketplace points at; (3) **standalone skills in any GitHub repo — a
   `SKILL.md` at the repo root or in any subdirectory, with NO marketplace
   and NO plugin required.** Path 3 is how most skills actually exist today
   (SkillHub v2's "mining of undeclared repos" was exactly this). The repo
   scanner walks the git tree for `SKILL.md`, validates frontmatter, derives
   the declaration, and attests the same way; identity = repo owner +
   frontmatter `name` (else the directory name; a root skill takes the repo
   name).
4. **Installs resolve from source.** Hosts fetch from the original git/npm/URL
   at a pinned ref (tag/commit). The registry resolves + vouches; it does not
   re-host. Gia local installs work the same way gia-core already works over
   the store layout — the "store" is now a *resolution + attestation* service.
5. **Trust without developer homework** (§5): declaration + hash + signing are
   produced by the registry's validation pipeline from the artifacts that
   already exist, not by a new manifest the developer must author.

## 3. Shape

```
 DEVELOPER'S WORLD (unchanged)            REGISTRY (catalog + trust)
 ┌────────────────────────────┐           ┌──────────────────────────────────┐
 │ GitHub repo / npm / git URL│  webhook  │ Ingest: adapters (GitHub, npm,   │
 │  SKILL.md · plugin.json ·  │ ────────▶ │ git, marketplace.json) →         │
 │  marketplace.json · tags   │  + crawl  │ validate (≡ claude plugin        │
 └────────────────────────────┘           │ validate) → extract metadata →   │
        ▲ installs resolve                │ derive declaration → hash +      │
        │ from source, pinned             │ sign attestation → index         │
        │                                 │                                  │
 ┌──────┴─────────────────────┐           │ Postgres (record) · Typesense    │
 │ HOSTS                       │           │ (search) · R2 (icons/READMEs)    │
 │ Claude Code: /plugin        │ ◀──────── │ Publishes:                       │
 │  marketplace add talents    │  agg.     │  · aggregated marketplace.json   │
 │ MCP gateway: search_skill / │  mkt.json │    (sources → originals)         │
 │  install_skill              │ ◀──────── │  · mcp.talents.sh gateway       │
 │ Gia: Canvas/Store + gia-core│ ◀──────── │  · resolution + attestation API  │
 │  (declaration → confirm)    │  resolve  │  · SSR pages talents.sh/skills/…│
 └────────────────────────────┘           └──────────────────────────────────┘
```

## 4. Data model (Postgres; deltas from v1)

- `namespaces` (owner slug PK, type user|org, clerk/github identity, verified,
  stripe_connect_id) — claimed via GitHub OAuth: owning the GitHub owner is
  the proof, exactly like claiming a GitHub org.
- `skills` (owner/name PK, kind: skill|plugin|mcp|agent (from components),
  source_type: github|npm|git|marketplace, source_url, source_marketplace
  (the marketplace.json it was found through), description, tags, categories,
  icon/readme asset keys, latest_tag, stars, install_count, retention_30d,
  status: listed|unlisted|suspended|delisted, pricing (nullable — absence =
  free/not-for-sale), health_score).
- `skill_versions` (owner/name + tag PK, commit_sha, content_hash (registry-
  computed over the source tree at that ref), declaration_json (derived, §5),
  attestation (registry signature over hash+declaration), validated_at,
  status: ok|failed|revoked).
- `installs` (user, owner/name, pinned tag+sha, declaration_hash shown,
  surface: claude-code|mcp|gia-web|gia-local, via_gateway bool).
- `runs_metering` (via MCP gateway / Gia surfaces only — source-direct runs in
  third-party hosts are counted at install + retention pings, never faked).
- `reviews`, `stars` (GitHub-like social proof), `collections` (goal stacks —
  curated lists of owner/name refs with one combined declaration),
  `workspaces/approvals` (enterprise pins by owner/name@tag),
  `dedup_aliases` (same skill in multiple sources → canonical owner/name),
  `index_jobs/dead_letter` (validation failures + publisher notices).

## 5. The Gia trust layer, with zero developer changes

Gia's requirements survive; *who produces them* changes:

- **Declaration:** DERIVED by the validation pipeline — tools/scopes are read
  from `plugin.json` components, MCP server configs, hooks, and SKILL.md
  frontmatter that already exist; anything not derivable is labelled
  "undeclared — runs only in sandbox/Playground until the publisher confirms
  the derived declaration on the web (a click, not a code change)."
  Publisher confirmation/adjustment happens in Creator Studio, never as a
  required repo file.
- **Hash + signing:** the registry hashes the source tree at the pinned ref
  and signs an **attestation** (registry key, Sigstore-style transparency log
  entry). The developer signs nothing and adds no keys. Publishers MAY opt
  into co-signing with their own key later (Verified+), never required.
- **Enforcement:** hosts that integrate (Gia local gate, MCP gateway) check
  the attestation + declaration before running, exactly as gia-core's gate
  works today — the check moved from "package signature" to "registry
  attestation over the source hash," so a tampered source or a source changed
  after pinning fails the hash and is refused.
- **Kill switch:** registry marks owner/name@tag revoked → attestation API
  refuses, aggregated marketplace.json drops the entry, Gia/MCP surfaces
  refuse at run start. (Honest limit, stated: a user who installed source-
  direct outside any integrating host keeps what they fetched — same as npm/
  GitHub today. The switch is absolute on every surface we operate.)
- **Install ceremony:** unchanged — prepare → plain-language declaration
  (derived + labelled as such) → confirm → pinned install recorded.

## 6. Stack decision (reconciled)

**SUPERSEDED 2026-11-10 by the user's stated preferred stack — FULL
CLOUDFLARE.** The user directed: Cloudflare Workers with the Vite plugin
(@cloudflare/vite-plugin), the Cloudflare Agents SDK, and the Think runtime
(@cloudflare/think) — the same stack as their Muse clone and Smart
Healthcare builds. Mapping from the original SkillHub stack:

| Original (SkillHub TDD) | Talents on Cloudflare |
|---|---|
| Next.js + tRPC app | Worker built with @cloudflare/vite-plugin (SSR routes = the P1 route shapes) |
| Postgres + Prisma | D1 (records, namespaces, installs); Prisma schema translates, P0/P1 store is already an interface |
| BullMQ + Redis | Cloudflare Queues (re-index/validation jobs) + Durable Object alarms |
| Webhooks receiver | Worker route → Queue (HMAC handler from P0 ports as-is) |
| MCP gateway | Agents SDK (McpAgent) on a Worker at mcp.talents.sh; stateful install sessions as Durable Objects |
| Agent-driven surfaces (suggestions, install help, Gia) | Agents SDK + Think runtime (@cloudflare/think) |
| Clerk | Clerk (unchanged — already their Workers auth choice) |
| Stripe Connect Express | Stripe API + Worker webhook route (unchanged) |
| R2 display assets | R2 (unchanged) |
| Typesense | **Open — see below** |

The P0/P1 engine (ingest, validation, declaration, attestation, namespace,
search interface) is portable TypeScript with no Node-only dependencies in
its core paths, so it carries onto Workers unchanged; the P1 node:http
server and JSON store are the parts that get replaced.

**The one real trade-off — search.** Typesense is a server product; it
cannot run inside Workers. Options: (a) **Cloudflare-native** — D1 FTS5 for
keyword + Vectorize for semantic, typo tolerance handled in the query layer
(P1 proved the ranking/re-rank logic is engine-independent: its search sits
behind an interface with two engines already); (b) **Typesense Cloud** —
the specified engine, hosted, one non-Cloudflare service in an otherwise
full-Cloudflare stack. **Assistant recommendation
(2026-11-10): Cloudflare-native (a)** — it honors the full-Cloudflare
directive, adds no vendor/billing/ops surface, and the catalog's near-term
scale is far below where FTS5+Vectorize strains; typo tolerance is the one
real gap and is closable with the FTS5 trigram tokenizer + query broadening.
The search interface keeps Typesense as a no-redesign escape hatch if
discovery quality at large catalog scale ever becomes the bottleneck.
**DECIDED 2026-11-10: the user approved the recommendation ("go") — search
is D1 FTS5 (trigram) + Vectorize (P5); P2 proceeds on the full Cloudflare
stack.**

## 7. Discovery (restored in full)

Original discovery design (§1) adopted wholesale, with Gia additions:
declaration/tier as facets, revoked/attestation status as hard filters, goal
stacks as a first-class result type. Ranking = Typesense hybrid (query-length
weighting) → behavioral re-rank (retention, review velocity, publisher trust)
→ personalization (implicit profile + opt-in workspace scan) — install count
is demoted to a tiebreak, per the original's precision-failure analysis.

**List sources (added 2026-11-11).** Curated list repos (awesome-* style)
are discovery entry points, not listings: a list is its own source kind,
mined for outbound links that enter the same nomination funnel with
{via:"list", list, section} provenance (the section heading is a category
hint, never an auto-applied category). A repo that yields records is never
a list; a link-dense repo (≥10 distinct outbound repo links) with no skill
files classifies as a list instead of a rejection — via explicit
nomination or the verification-time heuristic. Lists never produce
records, are never ingested, and their removals are ignored: re-mining
(weekly) only adds. Each list is its own corroboration channel, so
multi-list corroboration raises a candidate's verification priority
through the existing machinery. Implementation: talents `src/discovery/
lists.ts`; gate evidence `talents/data/gate-lists.txt`.

**Queue-drain hardening (added 2026-11-11).** The backlog drain runs
on the ingest queue (candidate-mode consumer: verify → ingest per
message, deterministic failures rejected in D1, transient failures
retried to `talents-ingest-dlq`), and the hardening is what makes
that drain survivable: a dedicated producer tick (own `*/10 * * * *`
cron, gated by `QUEUE_DRAIN_ENABLED`) enqueues one bounded page per
tick, paced by queue depth (stop above 500 inflight), the GitHub
rate budget (halt while exhausted, page capped by remaining minus a
500-call reserve), and a single-producer lease; the consumer claims
a 30-minute processing lease (`claimed_at`/`claimed_by` on the
source row, migration 0007) before any GitHub call, so redelivered
duplicates and the sandbox drain skip actively-leased sources
(the drain also claims the same lease per batch); GitHub 403/429
responses record a budget-exhausted-until timestamp in D1
(`sync_state`, Retry-After honored) that halts the producer and
makes the consumer throw-to-retry; the queue handler writes a DLQ
manifest (`dlq_entries`) on the final attempt, `POST /admin/dlq-sweep`
re-enqueues recoverable (transient-class, still-candidate) entries
up to a cap and never deletes anything, and `GET /admin/drain-health`
reports candidates, inflight (enqueued − terminal − DLQ arrivals),
DLQ depth, and stall reasons (non-empty DLQ, no terminal completion
in 3h while inflight, producer starving the queue) — the daily cron
also logs DLQ depth. Consumer `retry_delay` is 60s. The sandbox
drain and the watchdog cron stay in place until cutover; the
producer flag stays off until then. Implementation: talents
`cf/src/discovery.ts` (producer tick, DLQ sweep, drain health,
rate budget), `src/discovery/store.ts` (leases + DLQ manifest),
`scripts/backfill-drain.mjs` (lease-aware selection + batch claims);
gate evidence `talents/data/gate-harden-drain.txt`.

**Queue + Workflow drain (added 2026-11-11).** The queue stays the
per-candidate work distributor; a `TalentDrainWorkflow` orchestrator
replaces the producer cron + flag + watchdog as the backlog feeder:
it pages candidates from D1 in verification-priority order, enqueues
bounded batches (default 100) onto `talents-ingest`, sleeps between
batches (default 10 min) with the hardening build's pacing and GitHub
budget math, sweeps the DLQ on every drain-phase check, and resumes
from its durable checkpoint after any interruption (every branch reads
a step result; step names come from the loop counter only). One live
instance at a time: `POST /admin/drain-workflow/start` is flag-gated
by `QUEUE_DRAIN_ENABLED` and refuses while one is live, and the
instance's init step aborts itself if another live instance owns the
marker; `GET /admin/drain-workflow/status` reports the live instance,
last run, and drain health. State lives in D1 `sync_state`
(`drain:workflow:live` / `:active` / `:last_run`); the cron producer
tick and daily trickle stand down while a Workflow instance is live
(the single-producer invariant). Estimated ~207 counted steps for
the ~20k backlog against the 10,000 paid default. Phase 2 (design
only, in the gate) is a per-candidate Workflow — verify → ingest →
attest → enrich → embed as durable steps — folding the separate
enrich/embed sweeps into ingest. Implementation: talents
`cf/src/drain-workflow.ts` (adapter) + `cf/src/drain-workflow-steps.ts`
(step logic), binding `DRAIN_WORKFLOW` in `wrangler.deploy.jsonc`;
gate evidence `talents/data/gate-queue-workflow.txt`.

## 8. Developer experience (the GitHub test)

- **Profile:** `talents.sh/{owner}` — avatar, pinned skills, stars, followers;
  a publisher profile reads like a GitHub profile because it is keyed to one.
- **Skill page = repo page:** `talents.sh/skills/{owner}/{name}` — README
  rendered from source, file tree (SKILL.md, plugin.json, scripts/…), Releases
  (= tags), stars/forks-style social proof, health score, declaration tab.
- **Publish:** push a tag. That's the whole flow for an already-indexed repo.
  New publishers: "Add a repo" (one URL) or install the GitHub App once.
- **Reference anywhere:** `owner/name`, `owner/name@tag`, install via
  `/plugin marketplace add talents`, `npx`-style one-liners, MCP
  `install_skill("owner/name")`, Gia task field `skill: owner/name@tag`.
- **No import/export anywhere in the product.** The words do not appear in
  any flow. Legacy Gia markdown skills are the single exception handled
  FOR the user: they are auto-wrapped as playbook entries under the user's
  namespace by the registry (registry does the work, user clicks confirm).

## 9. Build order (replaces v1 phases)

- **P0 Identity + ingest:** namespaces via GitHub OAuth, adapters + webhook
  freshness, validation pipeline, canonical record. Gate: a real public
  marketplace.json indexes end-to-end and stays fresh on push.
- **P1 Pages + search:** SSR skill/profile pages (JSON-LD), Typesense hybrid
  search + facets. Gate: real-browser search, SEO page renders.
- **P2 Consumption:** aggregated marketplace.json + MCP gateway
  (search/install) + Gia Store on CC-B v2. Gate: `/plugin marketplace add
  talents` → install a listed skill in Claude Code, source-direct.
- **P3 Trust:** derived declarations, attestation + transparency log, Gia
  gate check, kill switch. Gate: tampered source refused; revoke propagates.
- **P4 Money:** Stripe Connect, pricing metadata, per-run metering via
  gateway/Gia surfaces, Creator Studio (health score, analytics, payouts).
  Gate: test purchase → install → payout split 85/15.
  **STATUS 2026-11-10: BUILT + LIVE (Creator Experience).** Clerk
  identity (env-driven; awaiting the user's Clerk app keys — deployed
  in the honest setup state), namespace claims by GitHub-login proof,
  web-layer listing overrides + absolute owner unlist, Stripe Connect
  Express with the 85/88 fee split (fee floored, creator keeps the
  remainder), destination-charge checkout, signature-verified webhook
  fulfilment, bearer purchase-token entitlements gating gateway
  installs (hash ceremony unchanged; free path byte-identical), and
  the analytics dashboard over record_stats. Live money awaits the
  user's Stripe platform account (decision + KYC are theirs). Gate:
  124 unit tests (123 pass + 1 skip) + 35 local + 19 live checks —
  data/gate-creator.json. The gate's purchase → token → install →
  split path ran end-to-end locally with fixture Stripe events; the
  real test-mode run happens when the platform keys land.
- **P5 Discovery depth:** behavioral ranking, personalization, in-context
  suggestions, cohort trending, cold-start program.
- **P6 Enterprise:** workspace approvals/pins, audit export, org namespaces.

## 10. Decisions this revision settles / leaves open

SETTLED by your direction today: CC-B Grove as the UI base; GitHub-style
identity/URLs; meta-registry (no stored skills); zero-change availability;
**domain = talents.sh** (decided 2026-11-10) with `skills/{owner}/{name}`
paths and the MCP gateway at `mcp.talents.sh` (mirrors the original
skillhub.dev scheme on the new domain).
STILL OPEN (recommendations unchanged): two kinds vs workflow-only — recast
in v2 as *components, not kinds* (a plugin's components are listed/filterable;
no separate kind taxonomy needed).
