# Skills Marketplace — Source Extract
What the attached Claude share actually contains, plus the Gia registry work already on disk.
Share: https://claude.ai/share/68d1b551-7030-42af-99a5-4ef6f238b171 (shared by Zay, snapshot crawled 2026-11-10)

## 1. From the shared Claude session — six versions, four names

The shared session is itself a synthesis ("how many different versions of talents or the
monetizable skills marketplace did I develop"). Its count:

| # | Version | Era | What it was |
|---|---------|-----|-------------|
| 1 | **SkillHub v1** | early | Meta-registry for Claude Code skills pulling from Plugin Marketplace sources. `owner/skill` namespacing. Stripe Connect Express. 85/88% creator revenue share. |
| 2 | **SkillHub v2** | — | Hono + Turborepo monorepo on Fly.io. Hybrid search, mining of undeclared repos, three-layer access control, seven-screen UI spec. |
| 3 | **SkillHub v3** | — | Same product collapsed into a single Next.js 16 app — Inngest, Mastra, Drizzle, Clerk — deployed only on Vercel. |
| 4 | **Kaplit** | late May | MCP servers become first-class entries next to skills. Tauri "super agent" desktop client planned. Next.js 15 + Prisma scaffold, crawlers, 62-task Taskfile. |
| 5 | **Talents — three-sided marketplace** | late June | SkillHub renamed. Adds consumer goal-driven workflows + enterprise deployments. PRD v1.0/v1.1 (~120 features), a Playground, a Desktop Client, a spec kit. |
| 6 | **Talents — portable agents** | July | Rebuilt on Cloudflare Workers, Hono, D1 + `kernel-knowledge` Rust/WASM crate. Deployed agents run offline. UI explored five directions: **Marquee, Hangar, Atlas, Grove, Lineage**. |

Related, not marketplaces themselves:
- **Kaplit → Threads.dev** — now a discovery pipeline for agents, skills and MCP servers, not a monetization marketplace.
- **skill-manager-mcp** and the **Portable Agent Bundle spec** — fed the same thesis.

Session's own caveat: counting only working codebases (not PRD revisions), there were two —
the Kaplit scaffold and the Cloudflare build of Talents.

Sources cited inside the shared session (verified by opening the share in a
browser, 2026-11-10): "Agent skills marketplace platform design",
"Talents Monorepo Architecture", "Kaplit Design", "Threads.dev".
LIMITATION: those four are private `/chat/` links — opening one redirects to a
Claude login page. Their bodies are NOT accessible from the share, and no sign-in
was attempted. This consolidation therefore rests on (a) the shared session's own
synthesis above, and (b) the Gia registry code audit already on disk (§2). If you
want the four source chats' full content folded in, share each of them the same
way you shared this one and the docs will be revised against them.

## 1b. The ORIGINAL SkillHub architecture (second share, added 2026-11-10)
Share: https://claude.ai/share/71c8d8a9-48c4-4e0a-9764-54aa3b506b52 — a long multi-turn
SkillHub conversation (blueprint → Design 2 → TDD v1/v2/v3 → research → business
case → 90-day plan → Talents spec kit). NOTE: the first fetch of this share
surfaced only its discovery-optimization answer; the full scroll shows the whole
conversation. No Sources list; it ends with the Talents spec kit ZIP.

The user's original brief, in substance: meta-registry for agent skills +
monetization, built on the npm skills package and the Claude Plugin Marketplace
spec; 3 UX designs; "repository/owner namespace style of GitHub"; a meta-registry
that searches skills + other plugin marketplaces and stays up to date; TypeScript
architecture; monetization design/business case.

Load-bearing originals (restored in ARCHITECTURE-v2.md):
- Meta-registry: "you never store the skills themselves — only the metadata and
  pointers… the catalog, not the CDN." Sources: GitHub, npm, git URLs, direct
  marketplace.json. Installs resolve direct from original sources.
- Namespace: `skillhub.dev/skills/{owner}/{skill-name}` canonical; namespace is
  first-come-first-served and "the trust anchor".
- Formats: skill = directory + SKILL.md; plugin = .claude-plugin/plugin.json;
  marketplace = .claude-plugin/marketplace.json. Freshness via GitHub webhooks
  (push changing marketplace.json → re-validate + re-index in seconds);
  validation ≡ `claude plugin validate`; failures → dead-letter + publisher mail.
- Zero-tooling consumption: registry publishes an aggregated marketplace.json
  pointing back to original sources (`/plugin marketplace add …`), plus an MCP
  gateway with search_skill / install_skill tools.
- Original stack: Next.js 15 + tRPC, Postgres 16 + Prisma, BullMQ + Redis,
  Typesense, Stripe Connect Express, Clerk, R2 (icons/READMEs/screenshots only),
  Vercel + Railway/Fly workers.
- Discovery companion answer: Typesense hybrid with query-length keyword/vector
  weighting, intent enrichment + synonyms, behavioral ranking (30-day retention
  via gateway call frequency, review velocity ×3 recent, publisher trust),
  implicit-profile personalization, cohort trending, workflow-gap surfacing,
  in-context suggestions in Claude Code, publisher health score, SSR + JSON-LD
  SEO pages, cross-marketplace dedup, cold-start program.

## 2. From this workspace — the Gia skills registry (already built/audited)

Full audit: `~/workspace/gia-skills-registry-merge-plan.md` (2026-11-05, muse-clone @3ee5751, gia-os @20a5fac)

- **Cloud (muse-clone)** has TWO registries: (a) per-user markdown `skills` in D1 —
  UUID ids, edited in place, no version history, `Gia.invokeSkill` just returns the
  markdown to a model; (b) `agent_packages` — the real marketplace: `author/name` slugs,
  draft|published|suspended, pinned installs, sandboxed runs, per-run metering,
  search at `GET /api/packages?q=`. Plus a Unified Directory over agents+skills+connectors
  whose search is whole-phrase substring only (no tokenization), capped, unpaginated.
- **Local (gia-os/agent, gia-core)** has ONE registry with the strong trust model and
  NO search: `skill.json` manifest (`skill.<name>` + semver), declared
  `requires {tools, scopes, maxTier}` enforced in the gate *before* grants, ed25519
  signing + content hash + local publisher trust + kill switch (`revoked` in catalog),
  prepare → plain-language declaration → confirm install ceremony, declarative workflow
  execution as tasks. Phase 5G added `gia-store-server` serving the same store layout
  over HTTP. Starters: research-tabs, fill-form, summarize-and-file.
- **Current Gia assistant** has NO registry: Store is a static 6-agent shell,
  installs in localStorage; Canvas lists "Skills & MCP" as a seam.
- **Merge plan already written** (awaiting 3 decisions): canonical = local manifest
  extended to v1.1 (`kind: workflow|playbook`, tags, author, icon); registry in the
  assistant Worker's D1+R2 serving the local store layout unchanged; unified discovery
  = tokenized FTS5 behind `/api/directory[/search]`; declaration-before-confirm
  everywhere; phases M0–M6 with verification gates.

## 3. What this consolidation does

The Talents line and the Gia line are the same product seen from two sides:
Talents = marketplace/monetization/discovery ambition; Gia = enforceable package
contract, trust, and a live host app (Canvas/Store) that needs a real registry.
The consolidated proposal in `CONSOLIDATED-DESIGN.md` + `ARCHITECTURE.md` merges them:
Talents' three-sided marketplace and monetization on top of Gia's signed,
declaration-enforced package format and Cloudflare deployment shape — which is also
exactly where Talents v6 had already landed (Workers + Hono + D1 + Rust/WASM).
