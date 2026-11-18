# Skills Marketplace & Registry — System Architecture
Consolidated from Talents (Cloudflare build), Kaplit, SkillHub v2, Threads.dev,
and the Gia registry merge plan (M0–M6). Product design: `CONSOLIDATED-DESIGN.md`.

## 1. Shape

```
                         ┌─────────────────────────────┐
   Creators ──CLI/web──▶ │  Publish API (Worker, Hono) │──▶ Review checks
                         └──────────────┬──────────────┘    (manifest≡declaration,
                                        │                    signature, scan)
                                        ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ REGISTRY (source of truth)                                   │
   │ D1: entries · versions (immutable) · installs (pinned)       │
   │     publishers · pricing · runs (metering) · reviews         │
   │     workspaces (enterprise approvals/pins) · audit log       │
   │ R2: package blobs (<id>@<version>.tar) · icons · cover art   │
   │ D1 FTS5 + vector index: unified discovery                    │
   └───────┬──────────────────┬───────────────────┬───────────────┘
           │                  │                   │
           ▼                  ▼                   ▼
   Store layout export   Discovery API       Marketplace web
   GET /store/catalog.json  GET /api/directory  (browse, detail,
   GET /store/packages/…    /search (tokenized,  Playground, Studio,
           │                 hybrid, paginated)  Library, Admin)
           ▼                  ▲
   gia-core local agent ──────┘  (skill.store.search mirror)
   · client-side verify: signature + hash + revoked check
   · prepare → declaration → confirm install
   · gate enforces requires{} on every call
   · workflow runs as local tasks; works offline once installed
```

## 2. Stack (decided by convergence, not preference)

- **Edge/API:** Cloudflare Workers + Hono (Talents July + Gia both landed here).
- **Data:** D1 (registry, FTS5 discovery), R2 (blobs), KV (catalog.json cache,
  kill-switch hot list), Queues (crawler/miner + review pipeline), Durable Objects
  only where a run needs coordination (Playground sessions).
- **Auth:** Clerk (Gia assistant + SkillHub v3 both used it) — users, creators,
  enterprise workspaces/orgs.
- **Payments:** Stripe Connect Express; per-run metering settles against the
  buyer's install-time cap; creator share 85/88%.
- **Local runtime:** gia-core (Rust) — registry mirror, gate, task engine;
  `kernel-knowledge` Rust/WASM crate for portable agent bundles (Talents July).
- **Desktop:** Tauri super-agent client (Kaplit) = gia-core in a tray app.
- **Web app:** Next.js or the Gia assistant's Vite/React shell — the marketplace
  ships inside Gia's 3-tab shell (Chat / Canvas / Store) for in-product use and
  as the standalone Talents site for the public directory. Same API either way.

## 3. Data model (D1, extends merge-plan migration 0002)

- `publishers` (id, clerk_user_id, display_name, stripe_connect_id, signing_pubkey,
  trust_status: unverified|verified|suspended, created_at)
- `entries` (id `skill.<name>|mcp.<name>|agent.<name>`, publisher_id, kind:
  workflow|playbook|mcp|agent|connector, owner_slug, name, description, tags,
  icon_r2_key, cover_r2_key, latest_version, install_count, status:
  draft|listed|unlisted|suspended|unclaimed, pricing_model: free|one_time|
  subscription|per_run, price_cents, run_cap_cents)
- `entry_versions` (id+version PK, manifest_json, content_hash, signature,
  changelog, status: published|revoked, created_at) — immutable rows; revoke is
  a status flip, never a delete.
- `installs` (user_id, entry_id, pinned_version, declaration_shown_hash, source:
  web|local|workspace, installed_at) — the declaration hash proves what was consented to.
- `runs` (id, entry_id, version, user_id, surface: playground|web|local, tokens,
  cost_cents, duration_ms, outcome, created_at) — metering + analytics + billing.
- `reviews` (entry_id, user_id, rating, body, run_verified, created_at)
- `workspaces` / `workspace_approvals` (workspace_id, entry_id, pinned_version,
  max_tier_cap, approved_by, approved_at) — enterprise layer (SkillHub v2's
  three-layer access, third layer).
- `discovery_index` — FTS5 virtual table over name/description/tags/publisher,
  + embedding column for hybrid ranking (SkillHub v2): score = FTS rank →
  semantic similarity → install_count → recency.
- `audit_log` (actor, action, entry_id, version, detail_json, created_at) —
  publish, install, revoke, approve, refund.
- `claims` (entry_id unclaimed → publisher_id, proof method, status) — miner pipeline.

## 4. Key flows

**Publish:** upload/CLI → manifest schema-validate (v1.1) → declaration rendered
from manifest and diffed against any author-supplied text (mismatch = reject) →
signature verified against publisher key → malware/prompt-injection scan queue →
version row + R2 blob + index update → catalog.json regenerated (KV-cached).

**Install (web):** detail → Install → server `prepare` returns the rendered
declaration + pinned version + price/cap summary → user confirms → install row
(declaration hash stored) → entry appears in Canvas/Library.
**Install (local):** gia-core fetches catalog.json + package tar from the Worker
store export → verifies signature + hash + not-revoked *client-side* → same
prepare → declaration → confirm ceremony → SQLite ledger `(id, version)`.

**Run:** playbook → SKILL.md injected into model context, gated by `skills:invoke`
+ the declared requires; workflow → delegated to the paired local agent's
`skill.run`, cloud never touches local tools; agent bundle → WASM sandbox;
MCP → proxied endpoint with scoped credentials. Every run writes a `runs` row.

**Playground:** same run paths, sandbox profile: sample data only, no local
tools, hard token/time caps, results labelled Playground.

**Revoke/kill switch:** version status → revoked → catalog.json + KV hot list
update → web refuses new runs, local refuses at next catalog refresh (and at
run start for pinned-revoked installs, flagged in Library, never silently run).

**Discovery/mining (Threads.dev pipeline):** crawlers mine public repos
(SkillHub v2/Kaplit) → candidate entries created as `unclaimed` (name, source,
manifest-if-found) → searchable, not installable → owner claims with repo proof
→ signs → becomes a normal listed entry.

## 5. Search (done properly this time)

`GET /api/directory` + `GET /api/directory/search?q=&kind=&price=&trust=&limit=&cursor=`
over entries of all kinds + connectors. Tokenized FTS5 (fixes Gia cloud's
whole-phrase flaw), hybrid with semantic re-rank, faceted, paginated, installed
marked not filtered. Local mirror: `skill.store.search` over catalog.json fields.

## 6. Security & trust

- ed25519 signing, publisher key registry, content hash — verified client-side
  on every transport; a hostile store server cannot get an unsigned package in.
- Declaration enforcement in the local gate (`Core::gated_call`): a skill is
  refused for any call outside its `requires`, even under a standing user grant.
- Per-run caps consented at install; Stripe holds for per-run overages.
- Enterprise: workspace pins + tier caps enforced at run time, audit export.
- Review pipeline: manifest/declaration diff, undeclared-tool scan, prompt-
  injection heuristics on playbooks; human review for Verified Publisher grants.

## 7. Build phases (merge plan M0–M6, extended with marketplace)

- **M0 Contract freeze** — manifest v1.1 spec + schema + API contract; 3 Gia
  starter skills re-manifested with tags/kind. Gate: Rust + TS parsers accept it.
- **M1 Registry** — D1 schema above + publish/install APIs on the assistant
  Worker. Gate: live publish→install round-trip, 401 unauthenticated.
- **M2 Discovery** — FTS5 + hybrid index, `/api/directory[/search]`, miner
  pipeline v1 (unclaimed listings). Gate: real-browser search run.
- **M3 Store UI goes real** — chosen UI direction (CC/ST) implemented against
  M1+M2; declaration-before-confirm. Gate: real-browser publish→search→install.
- **M4 Hosted store transport** — Worker serves catalog.json + tars; gia-core
  installs from it. Gate: tampered refused, revoked refused, both transports.
- **M5 Execution + Playground** — task `skill` field, playbook injection,
  workflow delegation, Playground sandbox. Gate: 3 starter skills end-to-end.
- **M6 Money** — Stripe Connect, pricing models, per-run metering + caps,
  Creator Studio analytics/payouts. Gate: test-mode purchase → run → payout split.
- **M7 Enterprise + portability** — workspaces/approvals/audit, portable bundles
  + WASM kernel, Tauri client mirror. Gate: revoke in workspace propagates.

## 8. Explicitly not doing

- No merging agent packages into the skills table (shared index, separate tables).
- No one-click installs. No inferred permission grants from prose.
- No new search service — FTS5 + embeddings in D1 until scale proves it wrong.
- No Vercel/Fly split deployments — Cloudflare only (the v2/v3 lesson).
