# Talents Registry — P0 (core engine + CLI) + P1 (SSR pages + search) + P2 (consumption on Cloudflare)

The meta-registry behind **talents.sh**: a catalog, not a CDN. It indexes
skills **in place** from their original sources (GitHub repos, marketplace.json
files), validates them, derives a plain-language declaration from what already
exists, and signs an attestation over the source hash. Developers change
nothing: no import, no export, no repackage, no new manifest.

Spec: `../ARCHITECTURE-v2.md` (P0/P1 = §9 build order).

## Run it

```bash
npm install
npm run gate        # reproducible P0 gate: ingest both targets + run tests
npm test            # 30 tests, node:test, zero runtime dependencies
```

Individual commands:

```bash
node dist/src/cli.js ingest anthropics/skills
node dist/src/cli.js ingest anthropics/claude-plugins-official --limit 25
node dist/src/cli.js ingest https://raw.githubusercontent.com/<owner>/<repo>/<ref>/.claude-plugin/marketplace.json
node dist/src/cli.js ingest-repo anthropics/skills   # standalone SKILL.md scan, no marketplace needed
node dist/src/cli.js show anthropics/document-skills
GITHUB_TOKEN=… node dist/src/cli.js claim <owner>   # token from env only, never logged
node dist/src/cli.js   # (webhook server: import createWebhookServer from src/webhook.ts)
```

## P1 — pages + search

```bash
scripts/dev-typesense.sh start     # real Typesense 29.0 binary, 127.0.0.1:8108 (see below)
npm run index                      # build the `skills` collection from data/registry.json
npm run serve                      # SSR pages on http://127.0.0.1:4317
npm run gate:p1                    # reproducible P1 gate → data/gate-p1-*.{txt,json}
TALENTS_TYPESENSE_LIVE=1 npm test  # also runs the Typesense integration test
```

**Routes** (`src/web.ts`, `node:http`, server-rendered, no client JS needed
for content; styling is one inline `<style>` in the CC-B "Grove" v2 palette):

| Route | What |
|---|---|
| `GET /` | Goal hero + search box; trending = P1 ranking (below) as Grove-style cards |
| `GET /skills/{owner}/{name}` | Repo-style skill page: source line ("indexed in place"), components, full derived declaration, validation issues (warnings visible), attestation block, files hashed, "Use this skill" panel (`/plugin marketplace add talents` · `/plugin install {owner}/{name}` · `Use {owner}/{name}@{ref}`), JSON-LD `SoftwareApplication` |
| `GET /{owner}` | Publisher profile: that owner's cards + namespace stats (count by kind, sources) |
| `GET /search?q=&kind=&owner=` | Results backed by Typesense, kind/owner facet filters |
| `GET /s/{owner}/{name}` | 301 → `/skills/{owner}/{name}` |
| anything else | 404 page |

All record-derived text is HTML-escaped — descriptions and declarations come
from third-party repos and are treated as untrusted (covered by a test with a
malicious-description fixture, including a JSON-LD `</script>` breakout
attempt).

**Search** (`src/search.ts`): one `skills` collection in **Typesense** —
fields `id, owner, name, kind, description, components` (flattened),
`declarationText, sourceRepo, status`; facets `kind/owner/status`. Queries
run over `name,description,components,declarationText` (weights 5/2/3/1)
with Typesense typo tolerance on, then a documented **re-rank pass**: exact
name match → attested → fewer validation warnings. Keyword + this re-rank
is the honest P1 ranking: **vector/semantic hybrid and behavioral ranking
(30-day retention, review velocity, publisher trust) land in P5** —
Typesense embeddings need a model config and P1 has no behavioral data to
rank on, so neither is faked. The home page's trending uses the same P1
rule (attestation → catalog substance = hashed files + declared components
→ fewest warnings) for the same reason.

**Typesense here is REAL, not a stub:** the official server binary
(Typesense 29.0, linux amd64, from dl.typesense.org) runs as a plain
process from `.tools/` (gitignored) with its data dir in `.tools/typesense-data`
— no container (containers cannot run in this sandbox; a binary can, and
its `/health` answers `{"ok":true}`). Config: `TALENTS_TYPESENSE_URL`
(default `http://127.0.0.1:8108`), `TALENTS_TYPESENSE_KEY` (default is the
clearly-labelled local dev key `talents-dev-key-p1` — a dev default, not a
credential). If no Typesense answers health, the CLI/serve fall back to a
local in-memory engine behind the **same interface** and print that they
did — the fallback is never silent. `serve` indexes at startup only when
the collection is empty; `talents index` forces a rebuild.

**Production targets (not what runs here):** the Next.js app (ARCHITECTURE-v2
§6) will consume these exact route shapes and rendering contract; Postgres
replaces the JSON record store; Typesense Cloud / a managed cluster replaces
the local binary. The P1 deliverable is the routes + rendering + search
behaving correctly against real P0 records. *(Superseded the same day by
the §6 full-Cloudflare decision: P2 below ported these exact routes and
templates to a Cloudflare Worker + D1, and search went Cloudflare-native —
the local Typesense remains only as the P1 benchmark/fallback.)*

## P2 — consumption on the full Cloudflare stack

The app now lives in **`cf/`** (its own package.json/wrangler config): a
Cloudflare Worker built with **@cloudflare/vite-plugin**, data in **D1**,
search **Cloudflare-native** — the stack the user decided 2026-11-10
(ARCHITECTURE-v2 §6). The root engine stays the source of truth for
ingest/validation/attestation; the Worker reuses its code (rendering,
aggregate builder, D1 search) rather than forking it. (The P1 rendering
was extracted to `src/render.ts` so both the node:http server and the
Worker render from one template set.)

```bash
cd cf && npm install
npm run seed     # migrations + seed local D1 from ../data/*.json (557 records)
npm run dev      # vite dev → http://localhost:5173 (Worker + local D1)
npm run build    # vite build via @cloudflare/vite-plugin
cd .. && npm run gate:p2   # full P2 gate → data/gate-p2.{txt,json}
```

**Routes** (`cf/src/index.ts`): the P1 pages ported 1:1 (`/`,
`/skills/{owner}/{name}` with JSON-LD, `/{owner}`, `/search`, `/s/…` 301,
404) backed by D1 instead of the JSON store, plus:

| Route | What |
|---|---|
| `GET /.claude-plugin/marketplace.json` | The **aggregated marketplace** (below) |
| `GET /api/search?q=&kind=&owner=` | JSON search over the D1 engine |
| `GET /api/installs?skill=owner/name` | Install receipts written by the gateway |
| `POST /mcp` | The **MCP gateway** (below) |
| `POST /advisor` `{goal}` | The **Think advisor** (below) — goal in plain language, matching skills out |
| `/agents/talent-advisor/{name}` | The advisor's native Think WebSocket chat transport |

**D1** (`cf/migrations/0001_init.sql`): `records` (scalar filter columns +
full `record_json` for rendering + flattened `search_text`), `namespaces`,
`installs` (pinned installs from the ceremony), `gateway_calls` (every MCP
tool call logged — the behavioral-data seed for P5 ranking), and
`skills_fts`, an **FTS5 virtual table with the trigram tokenizer**.

**Search** (`src/search-d1.ts`): engine name `d1`, same interface shape as
the P1 engines, same shared re-rank pass (exact name → attested → fewest
warnings). Trigram gives substring matching (`document` matches
`document-skills`); **typo tolerance is the broadening fallback**: when the
primary MATCH returns nothing, the engine retries with broadened tokens
(drop last char / drop first char / 3-char prefix — `pdff` → `pdf`), then a
LIKE scan over `search_text` as last resort. BM25 weights mirror the P1
Typesense weights (name 5, description 2, components 3, declaration 1).
Vectorize (semantic half) lands in P5, per the decision.

**Aggregated marketplace** (`src/aggregate.ts`, `talents aggregate` →
`data/aggregated-marketplace.json`, also served live by the Worker): a
spec-shaped marketplace named `talents` whose entries **point at the
original sources** — object sources are reused verbatim; relative string
sources are rewritten as `git-subdir` entries against the repo they live
in, pinned by SHA or ref; standalone repo-scan skills get the git-subdir
form plus `strict:false` + `skills:["./"]`. Nothing resolves to a
Talents-hosted copy (asserted programmatically: zero origin violations).
The output passes the project's own `validateMarketplace`/`validateEntry`
— our mirror of `claude plugin validate`. **Honest limit:** the Claude
Code CLI is not installed in this sandbox, so the live
`/plugin marketplace add talents` → install run is a user-machine step;
the spec-mirror validation is what the gate asserts here.

**MCP gateway** (`cf/src/mcp.ts`): MCP JSON-RPC over streamable HTTP —
`initialize`, `ping`, `tools/list`, `tools/call`. Tools: `search_skill`
(top results with declaration one-liner + attestation presence),
`get_skill` (full record summary), and `install_skill` — a **two-step
ceremony, no one-shot installs**. Step 1 returns the prepare payload
(plain-language declaration, pinned ref, attestation hash, source
resolution, source-direct notice). Step 2 (`confirm:true` + the hash
echoed back) **re-fetches the source files from GitHub at the pinned
ref, recomputes the content hash (WebCrypto — proven byte-identical to
the engine's node:crypto hash by a unit test), and compares it to the
signed attestation**: mismatch or missing attestation → refused; match →
a pinned `installs` row + receipt with source-direct fetch instructions.
*Substitution, stated plainly:* the gateway implements the MCP protocol
directly instead of via the Agents SDK's `McpAgent` — the Durable-Object
class wiring (DO namespace + SQLite class migrations on top of the Vite
plugin) didn't fit this phase's budget; the protocol behaviour the gate
asserts is identical, and the tools are shaped so a McpAgent port later
changes only the shell.

**Sandbox egress note:** workerd in this sandbox has no direct internet
egress (the sandbox routes egress through a proxy workerd can't use), so
locally the gateway's re-fetch can be routed through a dev-only Node
relay (`scripts/source-relay.mjs`, GitHub hosts only) by setting
`TALENTS_SOURCE_RELAY` — the P2 gate runs `wrangler dev` with that var.
Production Workers fetch GitHub directly; the deployed preview below
verified the confirm path with **native** egress, no relay.

**Think advisor — P2 remainder, INTEGRATED 2026-11-10** (`cf/src/advisor.ts`,
pure shaping logic in `src/advisor.ts` + `test/advisor.test.ts`): a
`@cloudflare/think` Durable Object (`TalentAdvisor`, SQLite-backed,
migration `v1`). **Anthropic is the model provider** (user decision
2026-11-10): `getModel()` returns a constructed `@ai-sdk/anthropic`
model — `TALENTS_ADVISOR_MODEL` var, default **claude-haiku-5-5** (the
cost-appropriate tier; sonnet-5-5/opus-5-5 exist on the account). The
agent's one usable tool is `search_skills` over the same D1 engine as
`/api/search` (`beforeTurn` restricts `activeTools` to it, muting
Think's built-in workspace tools). `POST /advisor {"goal": "…"}` runs
one turn on a fresh instance per request via the `@callable` `advise()`
and returns `{goal, model, answer, matches}` — the structured matches
come from the turn's tool output, not from parsing prose. Think's
native WebSocket chat transport also answers at
`/agents/talent-advisor/{name}`. Integration notes: Think 0.23 needs
`agents@^0.32` (0.28 lacks the `agents/skills/runner` export Think
re-exports) plus its optional `just-bash` peer to bundle — both bumped
in `cf/package.json`. **Key status — BLOCKED on a real key:** the
`ANTHROPIC_API_KEY` Worker secret was set from the stored
`custom.anthropic` credential surrogate (`cf/scripts/set_advisor_secret.py`,
surrogate via stdin only, never printed/logged). The whole chain works
— request → Think turn → Anthropic — but Anthropic rejects the call:
the surrogate is only swapped for the real key on requests originating
in the build sandbox, so a deployed Worker sends the literal `hsurr:`
string and gets an auth error (gate evidence `data/gate-advisor.json`:
both goals → HTTP 502, `errorKind: "auth"`). The endpoint **fails
closed** — `advisor not configured` (503, no secret) / `advisor request
failed` (502, coarse errorKind only; upstream text never leaks). To
unblock: the user supplies the Anthropic key once via secure entry and
it is re-set as the Worker secret — the same wrinkle as the muse-clone
and containerd app copies (2026-11-05). Never paste a key in chat.

**Preview deployment — LIVE:** `python3 cf/scripts/deploy_preview.py`
(credential via the stored-surrogate pattern, token only in the
subprocess env) created the remote D1 `talents`, applied migrations,
seeded it, and deployed: **https://talents.maximalize.workers.dev**
(version `f628b7e8-1175-4394-a047-02dd540588a4`). Verified live after
deploy: home 200, JSON-LD present, `q=pdff` → `anthropics/pdf` first,
aggregate = 49 entries, and an MCP install confirm for `anthropics/pdf`
→ **installed** with native-egress re-verification (row in remote D1).
Redeployed 2026-11-10 with the Think advisor (version
`2559cb27-3b9f-4ad1-981e-717a29723c95`); all P2 live checks re-run green
against the new version.

**Custom domain — talents.sh ATTACHED + LIVE 2026-11-10** (user's
explicit direction): the zone sits on the Maximal account (registered
at GoDaddy). Both `talents.sh` (apex) and `mcp.talents.sh` were
attached to the `talents` Worker through the Workers custom-domains
API (enabled, edge certs issued; the two GoDaddy parking A records that
blocked the apex attach were deleted — contents noted in the run log).
The zone showed `pending` (`ns_delegated_from_provider`) at attach
time and flipped to **active** the same day once the registrar
nameservers pointed at Cloudflare (`archer`/`joyce.ns.cloudflare.com`).
Verified live on the real domain: `https://talents.sh/` 200,
`/search?q=pdff` → `anthropics/pdf` first, aggregate = 49 entries,
`/skills/anthropics/xlsx` 200, and the MCP initialize handshake answers
at both `https://talents.sh/mcp` and `https://mcp.talents.sh/mcp`. The
hostnames are recorded as `custom_domain` routes in both wrangler
configs (dry-run validated), so future deploys keep them.

**P2 gate** (`npm run gate:p2`, evidence `data/gate-p2.txt` +
`data/gate-p2.json`): **23/23 checks pass** — vite build; pages (200s,
JSON-LD, 301, 404); all five D1 search queries (`pdf`, `document`,
`pdff`, `security`, `pdf`+`kind=skill`) with the same first-hits as the
P1 Typesense gate; aggregate = 49 entries, 0 origin violations, own
validator clean; MCP handshake + tools; install prepare → confirm →
receipt + D1 installs row; tamper fixture (stored hash corrupted)
**refused** with a content-hash-mismatch reason. Regressions: root tests
**41/41** (with `TALENTS_TYPESENSE_LIVE=1`; 40 + 1 skip without), P0 gate
unchanged (5/5, 24/1), P1 gate still passes (19 checks).

### Search fix + catalog growth (2026-11-10)

A user search for **"build games"** returned useless results (top hits
were generic "build"-token matches: mcp-builder, web-artifacts-builder,
frontend-design). Three root causes, all fixed in `src/search-d1.ts`:

1. **Catalog gap** — the 49-record catalog contained zero game-dev
   skills. Fixed by growing the catalog (below).
2. **Plural/singular miss** — FTS5 trigram needs every trigram of a
   token, so "games" matched nothing while "game" matched loosely.
   Query tokens are now normalized (`normalizeToken` in
   `src/search.ts`: trailing "s" stripped on tokens ≥4 chars not
   ending in "ss" — games→game, skills→skill), applied at query time
   for the D1 engine (trigram substring matching then covers both
   forms in the text) and to indexed tokens in the local fallback
   engine. "games" and "game" now return identical sets (171 records
   live).
3. **Common-token flooding** — one OR-MATCH ranked by bm25 alone let
   "build" (present in many dev-tool descriptions) swamp the
   distinctive token. The engine now works per token and ranks by, in
   order: **distinct tokens matched → Σ rarity weights 1/(1+df)**
   (df = the token's document frequency within the active filters) →
   **name relevance** (exact name → contains query → contains a
   token) → **whole-word relevance** (query tokens as standalone
   words in name/description — separates "document" from
   "documentation") → **description aboutness** (whole-word
   occurrences in the description, capped per token) → **best bm25
   rank** across the token passes → attested → fewest warnings. The
   bm25 candidate order itself weights only name (5) and description
   (2): components/declaration are derived, echo-prone text (a scanned
   skill's declaration repeats its own name/description; an
   undeclared marketplace plugin contributes nothing there), so
   weighting them made the tiebreak compare ingest paths, not
   relevance. Matching/recall still searches every column.
   **Partial-match honesty:** when the query's rarest token matches
   no document (df = 0 after the per-token typo-broadening/LIKE
   fallbacks, which still rescue e.g. `pdff` → `pdf`), the response
   is marked partial: `/api/search` gains `partial`, `missingTokens`
   and `note`, and the `/search` page renders the note ("No skills
   match 'zzzquest' yet — showing closest matches for the rest of
   your search") instead of dressing up weak matches as answers.
   The detailed API is `D1SearchEngine.searchDetailed`; `search()`
   keeps its old signature for the MCP gateway and other callers.
   Tests: `test/searchfix.test.ts` (normalization, set equivalence,
   rare-token dominance, partial flag/note, typo regression) plus the
   five original gate queries over the grown catalog.

**Catalog growth** (ingested into `data/registry.json` with the usual
dead-letter discipline; no GitHub rate-limit incidents — the full
official ingest ran in persisted slices of 80/170/260/full):

| Source | Seen | OK | Dead |
|---|---|---|---|
| anthropics/claude-plugins-official (FULL, was limit 25) | 317 | 310 | 7 |
| garrytan/gstack (repo scan, was limit 3) | 71 | 70 | 1 |
| Donchitos/Claude-Code-Game-Studios (repo scan, NEW) | 78 | 78 | 0 |
| gamedev-skills/awesome-gamedev-agent-skills (repo scan, NEW) | 78 | 78 | 0 |
| brockmartin/roblox-game-skill (repo scan, NEW) | 1 | 1 | 0 |

The three game sources were found via bounded GitHub repository
search and **verified by fetching their trees** (78, 78 and 1
`SKILL.md` files respectively) before ingest — no source was taken on
its README's word. Dead letters are genuine source defects (missing
`plugin.json` ×6, missing description ×1, one duplicate skill name in
gstack). **Catalog: 49 → 557 records** (157 of them from the three
game sources); aggregated marketplace rebuilt (**555 entries** — 2
reported duplicate-name skips: `donchitos/code-review`,
`garrytan/design-review`; 0 origin violations, validator clean);
remote D1 re-seeded and the Worker redeployed (version `ffd9d07c`;
a code-only follow-up `ae17f3fb` shipped the bm25 weight change
without re-seeding, so discovery-ingested records were not wiped).
Live result for the original complaint: `build games` → all-game-dev
top 5 (`gamedev-skills/ebitengine-game`, `game-jam`, `game-ui-ux`,
`card-game`, `defold-core`). Gate evidence: `data/gate-searchfix.json`
/ `.txt`. Two live-catalog notes: the P5 discovery pipeline sweeps
autonomously, so live counts keep growing past the seeded 557 (605
aggregate entries at final verification); and `security` — 42Crunch
first at the seeded deploy — now returns the discovery-ingested
`code-yeongyu/security-research` first (42Crunch second): it ties on
every engineered ranking key and edges bm25 on name/description
density. That is catalog growth, not a ranking regression (the
pre-fix engine ranks it first too); no editorial boost was faked.
Details in the gate file. One test-intent note: the P2 aggregate test now asserts
`entryCount + skipped == listed` (its original one-entry-per-record
form predates duplicate plugin names in the catalog; the builder's
skip-and-report behaviour is unchanged).

**What remains production work:** supply a real Anthropic key via
secure entry so `/advisor` turns succeed (see the Think advisor note —
everything else about the advisor is deployed and verified up to the
provider boundary); the McpAgent port; Clerk auth on publisher
actions; P3 trust hardening, P4 Stripe Connect. (Queues webhook
re-index, engine→D1 direct ingest and P5 discovery depth all landed —
next section.)

## P5 — broader discovery: source pipeline + discovery depth (2026-11-10)

Implements ARCHITECTURE-v2 §7 in full: the registry now FINDS skills
on its own instead of only indexing what it is handed, and search
ranks with semantics + behaviour, not keywords alone. Code:
`src/discovery/` (engine side) + `cf/src/discovery.ts` (Worker glue).
Gate: `npm run gate:discovery` → `data/gate-discovery.json` / `.txt`
(all checks against the live deployment) — **PASS** on 2026-11-10.

### The source-discovery pipeline (the crawler)

- **`sources` table** (`cf/migrations/0002_discovery.sql`): candidate
  sources with kind (`marketplace` | `plugin-repo` | `skill-repo`),
  locator (`owner/repo`), `discovered_via`, status (`candidate` |
  `verified` | `ingested` | `rejected` | `stale`), rejection reason,
  first/last seen, last ingested, record count.
- **Sweeps**: GitHub repository search over a documented query set
  (`src/discovery/sweep.ts: SWEEP_QUERIES`) — topics `claude-skills`,
  `claude-code-plugin`, `claude-code-skills`, `agent-skills`,
  `mcp-server`, plus name/description terms ("claude skill",
  "agent skills", "marketplace.json", `"SKILL.md" in:readme`).
  Requests are paced (≥1.2 s apart) with backoff honouring
  `retry-after` on 403/429; a run is capped (default 40 candidates,
  8 per query; the Worker cron uses 16/6). Runs unauthenticated
  (~10 search/min, ~60 core/hr) unless `GITHUB_TOKEN` is in the env.
- **Cheap verification before queueing**: ONE recursive git-trees
  call per candidate decides: `.claude-plugin/marketplace.json` →
  marketplace; any `SKILL.md` → skill-repo; root
  `.claude-plugin/plugin.json` → plugin-repo; otherwise **rejected
  with the reason recorded**. Archived repos are rejected.
  Rejections are sticky (never re-verified) — including
  fetch-failure rejections, a known sharp edge: a repo rejected
  during a GitHub rate-limit window stays rejected until an operator
  clears its row.
- **Dedup**: a known (kind, locator) source only gets `last_seen`
  touched; at ingest, records whose `owner/name` already exist are
  never overwritten (the first source keeps provenance).
- **Ingest**: verified sources flow through the EXISTING engine
  (`ingest.ts` / `repo-scan.ts`) and land **directly in D1** —
  records + FTS rows + search text, same row shape as the cf seed.
  This replaces the seed-file step for discovered sources (the P2
  remainder "engine→D1 ingest"). Dead-letter discipline unchanged:
  one bad entry never fails a source (cycle 1: paperclipai/paperclip
  landed 74 records with 9 dead-letters).
- **Scheduling**: Worker Cron `23 4 * * *` (daily) runs a bounded
  sweep → enqueues verified sources on the **talents-ingest** Queue
  → the queue consumer ingests into D1 and embeds new records.
  Worker-side ingest needs the registry signing key as the
  `TALENTS_REGISTRY_KEY` Worker secret; without it the cron skips
  and the consumer throws (retry) rather than minting an ephemeral
  key — attestations must stay verifiable.
- **Same code path locally**: `talents discover [--remote] [--limit N]
  [--per-query N] [--max-ingest N]` runs one sweep + verify + ingest
  cycle from the CLI (inline instead of via the Queue), writing
  `data/gate-discovery-cycle.json` and mirroring new records into
  `data/registry.json` so re-seeds stay lossless.
  `cf/scripts/discover_remote.py` runs it against production D1 with
  the stored credential in the subprocess env only.
- **Webhook freshness**: `POST /webhooks/github` — when
  `WEBHOOK_SECRET` is set, the HMAC signature is verified first;
  **it is currently NOT set, so the route runs in accept-and-log dev
  mode** (`signatureChecked: false` in the response) and only
  enqueues a re-ingest when the push touched `marketplace.json`,
  `plugin.json`, or a `SKILL.md` (the P0 handler's relevance rules).
  Set the secret before trusting it in production.
- **Admin routes**: `POST /admin/discover` (one inline cycle) and
  `POST /admin/embed` (index stale records), gated by the
  `ADMIN_TOKEN` Worker secret via the `x-talents-admin` header —
  404 when unconfigured, 401 when the token is wrong.
  `/admin/embed` is **paged**: the body accepts `{ limit, cursor }`
  (limit = page size, default 100, max 500; cursor = the previous
  response's `nextCursor`) and each call embeds the stale records
  of ONE bounded page of the catalog, ordered by record id,
  returning `{ considered, embedded, skippedFresh, nextCursor,
  done }`. A no-body call processes just the first page — it never
  scans the whole catalog in one invocation. (The original
  all-records scan hung and 500'd once the catalog passed a few
  thousand records under D1 import contention, leaving Vectorize
  covering a minority of the catalog — see data/gate-backfill.txt
  and data/gate-embed.txt.) `embedding_meta` is the checkpoint: a
  failed page is retried as-is, and `scripts/backfill-embed.mjs`
  drives the paging loop (with backoff and repeat straggler sweeps)
  for full-catalog catch-ups.

**First production cycles (2026-11-10, `--remote`)**: cycle 1 —
9 sweep queries, 17 hits, 16 candidates → 6 verified, 8 rejected,
3 sources ingested, **78 genuinely new records** (incl.
paperclipai/paperclip +74). Cycle 2 (same day, overlapping sweep) —
2 more sources, +3 records. Sources after both: **8 ingested,
13 verified awaiting ingest, 16 rejected**. The catalog grows on
its own now; the daily cron + webhook keep it fresh.

### Discovery depth (ranking & intelligence)

- **Embeddings**: the LLM provider is Anthropic, but **Anthropic has
  no embeddings API** — embeddings are Workers AI
  `@cf/baai/bge-base-en-v1.5` (768-dim) in the **Vectorize** index
  `talents-skills`. Each record is embedded as
  `owner/name + description + kind/components + declaration summary`.
  Vectorize caps ids at 64 bytes and some `owner/name` ids are
  longer, so vectors are keyed by the record id's sha256 hex;
  `embedding_meta.vector_id` maps back (migration 0003). Staleness is
  tracked by text hash + model in `embedding_meta`; the indexer
  (ingest hooks, cron, `/admin/embed`) only embeds what changed.
  A deterministic hash embedder exists for local tests ONLY — it is
  a stub with no learned semantics and is never used in production.
- **Hybrid merge** (`/api/search`, `/search`): keyword results
  (D1 FTS5-trigram pipeline, unchanged — typo/plural/expansion
  behaviour intact) merge with vector neighbours by query length,
  per the original design: ≤2 tokens → keyword .85 / vector .15;
  3–4 → .65/.35; 5–7 → .45/.55; ≥8 → .30/.70. Scores are
  rank-normalized (`1/(1+rank)` keyword, cosine clamped 0..1
  vector). The response `engine` field reports `d1+vectorize` when
  the vector layer actually contributed; if the layer is configured
  but fails, the message appears as `vectorError` and keyword order
  stands — a dead semantic layer can never masquerade as healthy
  (this caught a real bug during the build: the binding rejected
  `returnMetadata: false` on every query).
- **Intent expansion**: curated table in `src/discovery/synonyms.ts`
  (~34 triggers: games ↔ game development/three.js/phaser/godot/
  unity/webgl; spreadsheets ↔ excel/xlsx/csv/sheets; meetings ↔
  notes/transcription/minutes; watch/monitor ↔ changes/diff/alerts;
  security ↔ audit/owasp; …). Expansions run as a demoted second FTS
  pass that can add candidates but never changes partial-match
  honesty, and as augmented embedding text.
- **Behavioral re-rank** (never a filter): `record_stats` (migration
  0002, refreshed at ingest + cron + consumer) computes
  `behaviorScore = log1p(gateway calls 30d) + 0.7·log1p(installs
  total) + 0.6·owner attested share − 0.4·min(owner warning rate, 1)`,
  applied as a bounded post-rank shift together with the
  **cold-start rule**: records <14 days old get an exploration boost
  `0.5·(1 − ageDays/14)` so new skills are not buried by incumbents.
- **Trending**: `GET /api/trending` ranks by gateway-call velocity
  (7-day vs prior 7-day, `velocity = calls7d + 2·max(0, calls7d −
  callsPrev7d)`) with a minimum-activity floor of 3 calls in 7 days;
  below the floor it returns the documented `static-fallback` mode
  (the P1 curated order) and says so in the payload — the home page
  uses it and labels the fallback honestly.
- **In-context suggestions**: `GET /api/suggest?skill={owner/name}`
  blends vector neighbours with same-owner (+0.25), shared-component
  (+0.08 each, capped) and same-kind (+0.05) matches, excluding the
  record itself; the skill page renders it as the "Related skills"
  rail. `GET /api/suggest?goal=…` reuses the hybrid search (no LLM).
- **Goal stacks**: when a multi-token query's top 8 span ≥2 kinds,
  `/api/search` adds a `stack`: the top pick per kind with a
  one-line rationale. Rule-based and documented in
  `src/discovery/ranking.ts: buildStack`.

### Live quality, judged honestly (gate, 2026-11-10)

- Original five queries: all correct (`pdf`/typo `pdff` →
  anthropics/pdf; `document` → anthropics/document-skills;
  `security` → 42crunch first; `pdf&kind=skill` all skills).
- `build games`: top 5 game-relevant (gamedev-skills family),
  `partial: false`, engine `d1+vectorize`.
- "make my spreadsheets talk to each other" → **anthropics/xlsx
  first** — a genuine hit keyword search alone historically missed.
- "turn my meetings into notes" → patch-notes / monday-crm / pdf:
  **a reported miss** — word-adjacent, no true meeting-notes skill
  in the top 3 (none is prominent in the catalog yet); results are
  shown as closest matches, not dressed up as relevant.
- "keep an eye on websites for changes" → hackernews-frontpage /
  **firecrawl** / design-review: partial — firecrawl is genuinely
  website-data; no dedicated change-watcher surfaced.
- Suggest for anthropics/pdf: document-skills, docx, pptx among
  ≥3 related, never itself. Trending: 200, `static-fallback` (live
  gateway activity is still below the velocity floor — honest, not
  faked).

### Gate maintenance notes (same day)

Re-running the older gates against the grown catalog surfaced three
expectations written for 49 records; each was re-expressed as the
invariant it actually protected, with the reason recorded in the
gate scripts: P2's aggregate count is now `listed − name-collision
skips` (a Claude Code marketplace cannot carry two plugins with one
name — the 4 collisions are code-review, slack, design-review,
test-audit; all 638 records stay in D1, searchable and installable
via the gateway; only the single-file export picks one per name,
first by id order). P1's home check now asserts ≥4 trending cards
all linking to listed records (the static score legitimately
promotes richer bundles at this catalog size). The P2 gate's local
boot also required removing the AI/Vectorize/Queue bindings from
the LOCAL wrangler config (deploy config keeps them): an `ai`
binding makes unauthenticated `wrangler dev` demand a remote-proxy
session. After these: **P0, P1, P2 and discovery gates all pass;
root suite 73 tests, 72 pass + 1 env-gated skip.**

### What remains after P5

**Personalization is NOT implemented** — only its data collection
exists (`gateway_calls`, `installs` are recorded per call). Ranking
is global, not per-user; per-user signals need identity (Clerk,
still future work) before they can mean anything. Also remaining:
the McpAgent port, P3 trust hardening, P4 Stripe Connect, and
setting `WEBHOOK_SECRET` + rotating the chat-transited Anthropic
key when convenient.

## Discovery Phase 2 — multi-channel scouts (2026-11-10)

P5's pipeline had exactly one sense: GitHub repository search.
Phase 2 adds six more, under one rule — **one funnel**: a scout
only *nominates*. Every channel writes candidates into the same
`sources` table (`src/discovery/scouts/` + the shared funnel in
`scouts/runner.ts`), and from there the P5 machinery decides:
verification (git-tree/content checks, or the registry/packument
refetch at ingest), engine ingest, attestation. **Signals are
priority only, never trust** — stars, installs and engagement move
a candidate up the verification queue; they never change what
verification checks, and a watchlist nomination can never be
ingested at all.

Each nomination carries `discovered_via` + a `provenance` JSON
array (migration `0004_scouts.sql`: `sources.provenance`,
`sources.priority`, `sync_state`, `scout_runs`,
`record_stats.external_installs`). When a second channel nominates
a locator that already exists, there is **no second row**: the
provenance is appended and priority grows (corroboration bonus +
the channel's weight + a log-scaled signal) — verification order
is priority order, so the crowd's agreement literally sorts the
queue. Per-run stats land in `scout_runs`.

| Scout | Module | How it finds candidates |
|---|---|---|
| GitHub Code Search | `scouts/github-code.ts` | `filename:SKILL.md`, `filename:marketplace.json`, `path:.claude-plugin filename:plugin.json` via `GET /search/code`; hits dedup to unique repos, per-query hit counts as signals. Auth required — see secrets below. |
| MCP Registry sync | `scouts/mcp-registry.ts` | `GET registry.modelcontextprotocol.io/v0.1/servers`, cursor pagination + `updated_since` watermark in `sync_state` (cursor persisted when a run caps mid-feed; whole pages always processed — cursors are page-granular). Only latest versions nominate; the quality bar (repository OR remote OR package, plus a real description) filters before nomination. |
| npm | `scouts/npm.ts` | `/-/v1/search` over `keywords:mcp-server`, `keywords:claude-skill`, `keywords:agent-skills`, `"mcp server"`. Repo-linked packages nominate the REPO (npm = corroboration, weekly downloads = signal); repo-less packages nominate themselves for pointer ingest. |
| skills.sh | `scouts/skills-sh.ts` | The public API demands Vercel OIDC auth (401, verified live) → fallback extracts listings from the leaderboard pages' RSC payloads: source repo + install counts. Repos already in the catalog attach their installs to `record_stats.external_installs` — external traction only; our own gateway/install counters are never overwritten. |
| Web search | `scouts/web.ts` | Provider-pluggable (`query → [{title,url,snippet}]`); bundled adapters scrape DuckDuckGo HTML, then Bing. GitHub/npm links nominate; anything else (blogs, new directories) nominates as kind `lead` → **watchlist**. |
| X | `scouts/x.ts` | **Signal only.** Posts arrive via an operator/provider (`talents discover x --posts file.json`); repo/package links nominate with engagement as priority, linkless posts become kind `x-post` → **watchlist**, never ingestable. Shortened links are not followed. |

**MCP identity mapping** (`scouts/mcp-record.ts`): the registry
name's namespace splits on `.` and the **last label is the
owner** — `io.github.{user}` → `{user}` (the GitHub login, so
publishers land in their own namespace), `com.airtable` →
`airtable`; the name is the part after the first `/`, slugified.
If the mapped `owner/name` is already held by a non-registry
record, the MCP record moves to `{owner}-mcp/{name}` and says so
in its validation warnings. The record itself is a pointer:
declaration derived from server.json (remote → "Connects to a
remote MCP server at {host}"; package → "Runs an MCP server
package ({registry}:{identifier})"; the tool list is explicitly
**undeclared** — the registry doesn't publish it), attestation =
ed25519 over the sha256 of the canonicalized server.json.
Repo-less npm packages get the analogous pointer record from
packument metadata (`scouts/npm-record.ts`).

**Watchlist**: kinds `lead` and `x-post` are stored with status
`watchlist`. They are leads for a human or a future resolver, not
candidates — the funnel skips them for verification and ingest,
and a watchlist nomination can never resurrect or alter an
existing candidate row.

**List sources** (`src/discovery/lists.ts`): curated list repos
(`awesome-*` style) are a channel of their own — kind `list`,
status `mined`. A list is an *entry point*, never a listing: it is
**mined** for the outbound links in its README / curated markdown
(root `*.md` + `docs/**.md`, bounded), and each link is nominated
into the same funnel with provenance `{via: "list", list,
section}` — the section is the nearest preceding markdown
heading, stored on the candidate as a category hint only (never
auto-applied as a record category). Classification is by claim +
evidence: an explicit nomination (operator CLI `talents discover
lists --mine <owner/repo>`, or the web scout flagging an
awesome-*/best-of-* name) is only a claim, and the
verification-time heuristic rescues the no-skill-files rejection
when a repo's markdown links to ≥10 distinct GitHub repos. In
both paths the tree check runs first — a repo with records, or a
tree with skill files, is never a list ("records win"), and the
same check runs on every refresh, graduating a list that grew
skills back to a normal verified source. Hard rules: a list never
produces a record, never appears in search or the aggregate, and
`ingestSource` throws on kind `list`; list inclusion never
verifies anything (mined candidates face the same verify →
ingest → attest path); when a list *removes* a link, nothing
happens — re-mining only ever adds. Corroboration reuses the
existing machinery with one refinement: each list is its own
channel (`provenanceChannelKey`), so two lists naming the same
repo corroborate it and raise its queue priority, while the same
list twice does not. Refresh is weekly: the discovery cron
re-mines known lists on Mondays (limit 8), a push webhook to a
known list re-mines it through the ingest queue, and
`talents discover lists` scans past no-skill-files rejections /
re-mines on demand. Seed run (2026-11-11, `data/gate-lists.json`
/ `.txt`): of 12 rejected rows examined, 5 classified as lists
(travisvn/awesome-claude-skills among them — 20 repo links, 8 new
candidates + 12 corroborations) and 7 correctly stayed rejected;
94 nominations total, 75 new candidates, 19 corroborations, 0
records from list repos, 10/10 hand-checked nominations verified
against the lists' live markdown.

**Cron rotation** (Worker, daily `23 4 * * *`, `cf/src/discovery.ts`):
Sun sweep · Mon sweep · Tue code-search · Wed mcp-registry ·
Thu npm · Fri skills.sh · Sat web-search. One channel per day so
no run leans on every upstream; the sweep keeps two days because
it also refreshes known sources. X is not in the Worker rotation
(no posts provider there). Verified sources go to the same
ingest queue as sweep finds.

**Production secrets still needed**: `GITHUB_TOKEN` (code search
returns 401 without it — in the sandbox the ghapi connector
helper carries CLI runs, so no token exists in-process there);
a search API key if the web scout's scraped adapters prove too
fragile in production (the provider interface is the seam);
`WEBHOOK_SECRET` (from P5 — the GitHub webhook still runs in
accept-and-log dev mode until set).

### First-run stats (gate, 2026-11-10)

Production D1, bounded first runs (`data/gate-scouts.json` /
`data/gate-scouts.txt` for the full evidence). Catalog: **638 →
872 listed records (+234)**.

| Scout | Examined | Nominated | Created | Corroborated | Verified | New records |
|---|---|---|---|---|---|---|
| mcp-registry (resume run) | 100 | 100 | 100 | 0 | at ingest | 5 (`usefulapi/localazy`, `usefulapi/loops`, …) |
| github-code-search | 300 | 40 (of 296 unique repos) | 40 | 0 | 11 | 37 (`dnyoussef/cognitive-mode`, …) |
| npm (2 runs) | 80 | 78 | 39 | 0 | 10 | 73 (`vercel-labs/find-skills`; pointers `hubspot/mcp-server`, `antoneeo/agentic-sdlc-skill`) |
| skills.sh | 81 | 60 | 58 | 2 | 10 | 1 (`heygen-com/core-skills`) + external installs attached to 30 records |
| web-search | 48 | 43 | 43 (36 watchlist leads) | 0 | 6 | 118 (`skillmds/agents-mcp`, `wshobson/*`) |
| x | 0 | 0 | — | — | — | 0 — **blocked**: no X posts provider in the sandbox (social search has no X platform; web search returned no x.com posts). Recorded honestly in `scout_runs`; mechanics unit-tested with fixtures. |

Corroboration, proven in production: `vercel-labs/skills` is a
**single sources row** carrying npm provenance (package `skills`,
5,235,462 weekly downloads) **and** skills.sh provenance
(4,298,935 installs); `anthropics/skills` carries webhook +
skills.sh (1,101,738 installs). MCP incrementality, proven two
ways: production cursor resume across runs (cursor advanced
`io.usefulapi/eventzilla` → `io.usefulapi/parsio`; ~181 registry
sources accumulated — the ~40k backlog drains in bounded runs),
and a watermark cycle against the real feed on the local D1
(run 1 `--since` window: 3 examined, exhausted, watermark set;
run 2: only the 2 servers changed since — this registry churns
~1–2 updates/minute, so "incremental" is a trickle, not zero).
One honest rejection worth naming: `travisvn/awesome-claude-skills`
(web-search nomination) failed verification — a list repo with no
skill files. Signals never substitute for verification.

Gate-maintenance notes: the grown catalog legitimately changed
one old expectation — `skillmds/security` (a genuine exact-name
security-audit plugin from the web scout) took #1 for "security"
over 42crunch (still top-3). Following the P5 pattern, the
expectations in `test/p2.test.ts` + `scripts/gate-p2.mjs` were
re-expressed as the invariant (security-relevant winner + 42crunch
in top 3); no editorial pin was faked. The same growth exposed a
real defect: three npm pointer records whose packuments have
empty descriptions — the pointer builder now derives a signed
factual fallback, and the three records were rebuilt + re-signed
(live aggregate verified: 863 entries, zero description-less).

Operational note: remote CLI runs are slow (minutes) — the
operator store shells out to wrangler per read. The Worker cron
path uses the D1 binding directly and doesn't pay this.

## Creator Experience — identity, listings, money, analytics (P4, 2026-11-10)

The publisher side of the marketplace: **claim a namespace → manage
listings → get paid → see analytics**. Built and LIVE on talents.sh
(Worker version a83cb0d4); the parts that need the user's own
accounts (Clerk app, Stripe platform account) are deployed in an
honest awaiting-keys state — see "Provisioning" below. Gate
evidence: `data/gate-creator.json` / `data/gate-creator.txt`
(35 local checks + 19 live checks, all PASS; run
`npm run gate:creator` then `npm run gate:creator-live`).

### Identity + claims

- Auth is **Clerk**, env-driven: `CLERK_PUBLISHABLE_KEY` (public
  var), `CLERK_SECRET_KEY` + `CLERK_JWT_KEY` (Worker secrets).
  Session tokens are verified RS256 against the instance JWKS (or
  networklessly against the JWT public key) on the pure WebCrypto
  core in `src/creator/jwt.ts` — the seam where @clerk/backend's
  verifyToken drops in (the package could not be installed in the
  build sandbox: no npm egress; the verification logic is identical
  and is unit-tested against a MOCK Clerk issuer — a test-generated
  RSA keypair served as a JWKS, with expired/tampered/wrong-issuer/
  wrong-key refusals).
- Sign-in is **GitHub-first** (Clerk GitHub social connection): the
  creator's verified GitHub login is the ownership proof.
- **Claim rule** (`src/creator/claims.ts`, mirrors the P0 engine):
  your GitHub login IS the namespace → one-click claim, method
  `github-login-match`, first-come-first-served on the owner PK,
  mirrored into the P0 `namespaces` table. Claimed owners get the
  **Verified publisher** badge on profile + skill pages.
- A namespace is claimable only when it is **GitHub-backed**: at
  least one of its records lives in a repo owned by that same
  GitHub account. MCP-Registry label namespaces (e.g. `usefulapi`,
  whose records point at `m190/usefulapi-mcp`) show "claim is not
  available via GitHub sign-in" — no proof is invented for them.
  (The live gate caught exactly this: the first heuristic — "has
  any sourceRepo" — was wrong, and was fixed to owner-segment
  equality.) Org namespaces the user admins claim via the engine's
  token proof (`verifyGithubOwnership`) — a later UI flow.
- Migration `0005_creator.sql`: `users`, `claims`,
  `listing_overrides`, `unlisted_skills`, `creator_accounts`,
  `purchases`, `entitlements`, `install_tokens`,
  `pending_token_pickups`.

### Listing management (web layer only)

Creator edits live in `listing_overrides` and merge at render time.
**The attested `record_json` is never mutated** — not by edits, not
by unlisting. An overridden description renders with a **"Publisher
description"** label (the attestation covers the source text; the
override is the publisher's words). Overrides apply to skill pages,
search cards, `/api/search`, and home cards. The aggregated
marketplace.json keeps SOURCE metadata verbatim — its one creator
exception is exclusion (below).

**Unlisting is absolute**: an `unlisted_skills` row removes the
skill from search (keyword + hybrid + advisor), its page, profile
listings, the aggregate, and the MCP gateway (prepare/get/search),
while the verified record stays in D1 for audit. Re-listing deletes
the row and restores everything. Proven live with a synthetic
fixture record (`talents-gate/fixture-skill`, created for the gate
and deleted after; exclusion verified by identity, not counts,
because the parallel backfill was ingesting concurrently).

### Money — Stripe Connect Express, 85/88

- **Fee math** (`src/creator/fees.ts`, pure + unit-tested):
  standard listings pay the creator **85%** (15% platform fee);
  Talents-exclusive listings **88%** (12%). The fee is FLOORED to
  whole cents and the creator keeps the remainder — rounding dust
  always lands in the creator's favour and fee + creator always
  equals the charge.
- **Onboarding**: POST /api/payouts/connect creates a Connect
  Express account + hosted onboarding link; the return URL refreshes
  `charges_enabled`/`payouts_enabled` from Stripe. The dashboard
  payouts panel shows the state honestly (not connected / pending /
  active / platform-not-enabled).
- **Checkout**: priced skill page → POST /api/checkout/{owner}/{name}
  → Checkout Session as a **destination charge**
  (`transfer_data.destination` = creator account,
  `application_fee_amount` = the computed fee), metadata carrying
  skill_id + exclusivity + buyer. The split is recomputed server-
  side at fulfilment from the amount actually charged.
- **Webhook**: POST /webhooks/stripe verifies the Stripe signature
  (HMAC over the raw body, 5-minute tolerance) before parsing;
  `checkout.session.completed` writes the purchase (idempotent on
  the session id), the entitlement, and a one-time install token.
  Unconfigured → 503, never an unverified accept.
- **Entitlement model**: gateway callers are anonymous, so a paid
  install uses a **bearer purchase token** (`tix_…`, shown exactly
  once on the post-checkout success page; only its SHA-256 is
  stored). `install_skill` prepare for a priced skill returns
  `payment_required` (price + checkout URL — the attestation hash
  is NOT leaked) unless a valid token is presented; confirm
  re-checks the token, runs the **unchanged hash ceremony**, and
  spends the token only after the install is recorded (a refused
  verification never burns a token). Signed-in web buyers with an
  entitlement see the skill page's install panel unlocked. Free
  skills: the install path is byte-identical to P2 (proven by unit
  test + the P2 gate re-run).
- Stripe access is a small REST client behind an interface
  (`cf/src/stripe.ts`) — tests inject a fake; no SDK dependency.
  The Stripe connector in this environment is **not connected**
  (OAuth) and exposes no API keys, so no test-mode key path exists:
  everything runs on `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
  Worker secrets when the user provides them.

### Analytics

`/dashboard/analytics` (and the listing manager's snapshots) read
the behavioral data collected since P5: per-listing calls 7d/30d,
installs total/30d, behavior score, trend (calls_7d vs prev_7d),
and `record_stats.external_installs` shown as "installs on
skills.sh — external" — labelled, never summed into our own
install counts. Aggregation is pure (`src/creator/analytics.ts`);
an unclaimed-by-traffic namespace shows honest zeros.

### Provisioning — the exact user steps that unblock live auth + money

1. **Clerk** (dashboard only — cannot be delegated): create a Clerk
   application for talents.sh → enable the **GitHub** social
   connection → optionally add a `github_login` claim to the
   session token template (speeds claim resolution; the Backend API
   lookup works without it) → provide via secure entry:
   `CLERK_PUBLISHABLE_KEY` (wrangler var in both configs),
   `CLERK_SECRET_KEY` and/or `CLERK_JWT_KEY` (Worker secrets via
   `wrangler secret put`). Until then /sign-in renders the setup
   state and protected routes redirect there — deployed, not broken.
2. **Stripe** (platform account decision — AdvancedAI vs Saije
   Ventures — is the user's; KYC is a user step): create/choose the
   platform Stripe account → enable Connect (Express) → provide via
   secure entry: `STRIPE_SECRET_KEY` (Worker secret) and, after
   registering the webhook endpoint `https://talents.sh/webhooks/stripe`
   for `checkout.session.completed`, `STRIPE_WEBHOOK_SECRET`.
   Until then priced pages render the honest disabled-Buy state.
3. Still outstanding from earlier phases: `WEBHOOK_SECRET`
   (GitHub freshness webhook) and `GITHUB_TOKEN` (code-search
   scout in the Worker).

## Enrichment — layers A–C (Tranche 1, 2026-11-11)

The spec is `../ENRICHMENT.md` (user requirement, 2026-11-10:
"enrichment is a critical requirement"). Enrichment is a pipeline
stage of its own — discover → verify → ingest → attest → **enrich**
→ embed → rank — keyed by `(skill_id, source hash)`: an unchanged
hash means no rework, except Layers A and C, which describe the
*living* origin and refresh on a **weekly cadence**. Enrichment
failures degrade a record's completeness; they never unlist it.
Storage: the `enrichment` table (migration `0006_enrichment.sql`) —
per-layer state (`pending | done | partial | none | stale`), JSON
payload, layer timestamps — plus the R2 bucket **`talents-assets`**
for display assets (README text + icon images, keyed
`readme/{skill_id}` / `icon/{skill_id}`, served by the Worker at
`/assets/{icon|readme}/{owner}/{name}`; the source URL of every
asset is recorded in `a_json`, and pages never hot-link the origin).
The D/E columns already exist in the schema (default `none`) so
Tranche 2 slots in without another migration.

**Layer A — source facts (class: source).** GitHub repo metadata
via the API (stars, forks, watchers, open issues, license SPDX,
topics, primary language + language mix, created/pushed, archived,
default branch, contributor count from one bounded page of 100 —
capped counts are floors and are stored flagged as such, latest
release/tag). npm facts for records pointing at a package (weekly +
monthly downloads, latest version + publish date, version count,
maintainer count, deprecated flag). README fetched raw (the
record's own directory first, then the repo root), stored in R2 at
a 64KB cap with a plain-text excerpt in `a_json`; the icon is the
repo's GitHub social-preview image, falling back to the first
content image in the README (badges skipped), stored in R2 at a
512KB cap with content type + byte size + source URL recorded.

**Layer B — structural deepening (class: derived).** Collections
and plugins expand into a **sub-inventory**: every contained
skill/agent/command with name + one-line description, from a fresh
git-tree fetch of the pinned source (bounded: 60 description
fetches, 200 entries). SKILL.md gets a full parse — frontmatter
beyond the validator's flat scalars (allowed-tools in inline,
block-list, and comma forms; model; license), instruction
line/token estimate (chars/4, labelled an estimate), referenced
local files, external URLs. plugin.json yields author / homepage /
repository / keywords. MCP package records yield transport +
required **environment variable names — never values** (from
server.json `environmentVariables` or a plugin.json `env` block —
only the keys are read into output). Known ingest artifact: some
records' stored description is literally `"---"`; when the B parse
reads the real frontmatter description for such a record it is
stored as `b_json.skillParse.parsedDescription` — a candidate for
the later ingest fix, never silently substituted (the count is in
the gate evidence).

**Layer C — live MCP introspection (class: derived).** For records
with a public remote (http) MCP endpoint (server.json `remotes`,
or a URL named in the record's declaration): a read-only handshake
— `initialize`, then `tools/list`, plus `resources/list` /
`prompts/list` when the server advertises those capabilities.
**A tool is never invoked.** One 10s abort budget per probe, 1MB
response cap, 200-tool cap; **no auth headers are ever sent** — a
server answering 401/403 is recorded `c_state=none`, reason
"requires auth". The inventory is stored with its probe date and
rendered in the Declaration panel as "Tools (live, introspected
{date})" — point-in-time, and the UI says so.

**Pipeline machinery + execution sites (deliberate).** Shared code
in `src/enrichment/` (types, store, layer-a/b/c, pipeline,
display). The **operator script is the primary driver**
(`scripts/enrich-run.mjs`, via `cf/scripts/backfill_remote.py`):
its GitHub fetches go through the ghapi helper (authenticated —
the token never enters the process), its R2 writes through the
REST API, its D1 writes through the WranglerD1 adapter; runs are
checkpointed by the enrichment table itself (re-running skips
fresh layers), and `--shard k --of n` parallelizes a slice.
Because a remote `wrangler d1 execute` round trip costs ~5–10s,
the driver wraps the store in a write-through cache (one bulk
seed read per slice; batched write flushes) — an operator-only
optimization; the store semantics are unchanged. The
Worker route **POST /admin/enrich** (ADMIN_TOKEN-gated, 404 when
unset) drives the identical code paged in **traffic order**
(record_stats behavior score → calls_30d → id; keyset cursor,
`{limit, cursor, layers?}` → page stats + `nextCursor`/`done`,
mirroring /admin/embed) with the Worker's own fetch + R2 binding —
fully functional for npm/README/probe work, but GitHub-API facts
are rate-limited unauthenticated from the Worker, so Layer A
bulk runs belong to the operator script. A source-hash change
marks done/partial/none layers `stale` (payloads stay visible
until replaced).

**Search integration.** Sub-inventory names + introspected tool
names (derived class) are appended to the record's search text:
the FTS `components` field and `records.search_text`, recomputed
from the bare record on every pass (idempotent; a re-ingest
rewrites them away until the next enrich pass). Weighting choice:
extras land in `components` (bm25 weight 3.0, equal to declared
components — a contained skill's name *is* a component-level fact
about its parent), never in `name` (5.0) or `description` (2.0).
The same extras string joins the embedding text
(`embeddingText(record, extra)`), so enriched records go stale in
`embedding_meta` and are re-embedded by the existing paged
/admin/embed route; unenriched records' text (and hash) is
bit-identical to before.

**Display (skill pages, Grove — additive panels only).** Icon
image (our R2 copy) in the page header when stored; a "From the
README" excerpt panel; an "Inside this package (derived)" panel
(sub-inventory, instruction facts, MCP transport + env var names,
plugin metadata); the introspected tool list inside the
Declaration panel; and a right-column "Source facts" panel
(stars/forks/contributors/license/language/last push/release, npm
downloads/version/deprecation) labelled with its fetch date.
Unenriched records render exactly as before.

**First run (gate: `data/gate-enrich1.json` / `.txt`).** Slice:
ALL remote-MCP records (Layer C candidates) + the top 500 records
by traffic for A/B. Coverage is reported per layer over that slice
with top partial/none reasons, plus the full-catalog percentage
the slice's enrichment rows represent; 10 sampled records are
hand-checked against live sources (stars re-fetched, README
excerpt fidelity, one introspection compared against an
independent manual MCP client session). What remained after
Tranche 1 — Layers D and E — is Tranche 2, below.

## Enrichment — layers D–E + completeness (Tranche 2, 2026-11-11)

**Layer D — generated editorial (class: generated, Anthropic).**
A model writes, per record: a one-line summary, a short paragraph,
categories from a **fixed taxonomy** (18 values in
`src/enrichment/layer-d.ts`: development, devops, data, documents,
communication, security, agents, games, media, productivity,
finance, health, education, science, business, testing, design,
other), up to 6 free tags, 2–4 use cases phrased as user goals,
and an audience (`developer | ops | data | creative | general |
mixed`). Prompt inputs are ONLY the record's own artefacts — the
source description, the stored README (R2), the Layer B parse
(frontmatter description, sub-inventory, components) and the
declaration summary. No outside knowledge, no web. **Generation
runs only inside the Worker** (it holds the `ANTHROPIC_API_KEY`
secret): `POST /admin/enrich` accepts `{layers:["d"]}` and an
optional `{ids:[…]}` explicit-slice mode; the model is
`TALENTS_ENRICH_MODEL` (default: the advisor's Haiku-class model,
`claude-haiku-5-5`). The operator script never generates — without
an injected generator the pipeline skips D rather than faking it.
Output is validated (taxonomy membership, shape, length bounds)
with one repair retry; the payload in `d_json` carries the model
id, the source hash, `generatedAt`, and the **real token usage**
(input/output, summed over attempts) so gates report actual
Anthropic spend. **Withholding rule:** no README AND effective
description < 120 chars AND no sub-inventory → `d_state=none` with
reason "insufficient source material" — never padded; a stored
description of literally `"---"` (the known ingest artifact)
counts as no description unless the B parse or README carries the
record. The verdict is sticky until the source hash changes.
Generated content is stored ONLY in `d_json` and surfaced ONLY
under a `generated` key / "Generated summary" panel with the
permanent label **"Generated by the registry from the source —
not the publisher's words"** — it never overwrites or merges into
source description fields anywhere (page, API, dashboard).

**Layer E — trust signals (class: derived).** A static
risky-pattern scan (v1) over the pinned source text — SKILL.md
bodies + up to 8 bundled script files fetched at the pinned ref,
or the `server.json` descriptor for registry records. Pattern
classes: `remote-code-execution` (curl|bash, wget|sh,
process-substitution pipes, PowerShell irm|iex / DownloadString,
eval of fetched content), `credential-access` (credential FILE
locations: ~/.ssh, ~/.aws/credentials, ~/.gnupg, ~/.kube/config,
~/.docker/config.json, ~/.netrc, macOS keychain CLI, /etc/shadow),
`persistence` (crontab, cron dirs, launchd, systemd user units,
shell rc appends), `obfuscation` (base64-decode piped to shell,
eval(atob), xxd -r -p | sh), `network-exfil` (curl -F file=@,
-T/--upload-file, --data-binary @, wget --post-file, scp to a
remote host). Output = factual flags
`[{class, evidence ≤120 chars, file}]` in `e_json` — **neutral
facts, no verdicts, no scores**; an empty flag list with
`e_state=done` is a result ("scanned, nothing found"), not a
failure. **Precision choices (deliberate):** READMEs/docs are
never scanned (a mention there is documentation); the executable
classes require code context (fenced block, inline code span, or
a script file); a negation on the same line ("never run …",
"do not …") suppresses the match — a warning about a pattern is
not the pattern; environment-variable reads are NOT flagged (env
is the declared config channel — variable NAMES surface via
Layer B). `e_json` also carries freshness: `lastVerifiedAt`
(attestation `signedAt`, else ingest time) and **drift** — one
GitHub call compares the default-branch head with the pinned ref
when the ref is a commit SHA (`current` / `changed`); branch/tag
refs, pointer-only records and failed checks record
`drift: "unknown"` with the reason — drift is never fabricated.
`changed` records are the re-verify list (counted in the gate).

**Completeness.** Computed at read (no stored column) by
`completenessOf` in `src/enrichment/display.ts`: weights
**A 25 · B 25 · C 15 · D 20 · E 15**; credit is 1 for `done`,
½ for `partial`/`stale`, 0 for `pending`/`none`. Layer C is not
applicable to records without a public remote MCP endpoint — for
those its weight is redistributed (the rest renormalize to 100),
so a skill is never penalized for a layer that cannot exist for
it. Surfaced three ways: (a) the skill page's Record panel gets a
factual line — `Registry enrichment: A ✓ · B ✓ · C — · D ✓ · E ✓`
(marks: ✓ done, ◐ partial, ↻ stale, · pending, — none) — no
gamified score on public pages; (b) `/api/search` and
`/api/suggest` results carry a structured `enrichment`
`{layers, completeness, trust?}` object plus generated content
under a top-level `generated` key; (c) creator-dashboard listings
carry the same fragment (per-listing completeness % + layer marks
+ trust-flag count in the manager view).

**Display + search (Tranche 2 additions).** The skill page gains
the "Generated summary" panel (one-line + paragraph, use-case
list, category/tag chips, permanent label with model + date) and,
inside the Declaration panel, the "Source pattern scan" block:
one neutral line per flag ("Source references: downloads and
executes a remote script (install.sh)" + the evidence excerpt),
an explicit "no v1 risky patterns found" line when the scan was
clean, and a drift note when the source changed since pinning.
Search weighting (documented tiers): source text ranks first
(FTS name 5.0 / description 2.0); Tranche-1 derived extras sit in
FTS `components` + `search_text`; **generated tags + use cases
are appended to `records.search_text` ONLY** — reachable via the
engine's per-token LIKE last-resort pass and via the embedding
text (after the derived extras), so generated vocabulary can
recall a record but can never outrank a source or derived match.
Re-embedding flows through the existing paged `/admin/embed`.

**Weekly refresh cron.** The Worker's cron set gains
`41 5 * * 1` (Mondays 05:41 UTC); `scheduled()` dispatches by
trigger expression to `handleEnrichmentRefresh`, which walks the
catalog in traffic order (4 pages × 25) running layers A + C
through the same pipeline — only records whose weekly cadence
expired actually re-fetch. D is deliberately NOT in the cron
(generation is hash-keyed and operator-gated for cost
visibility); B/E re-run inside the same passes whenever a hash
change has marked them stale.

**First run (gate: `data/gate-enrich2.json` / `.txt`).** D + E ran
over the SAME slice as Tranche 1 (every record holding an
enrichment row — 541 records at run time). The gate reports D
coverage (done/withheld + reasons) and the REAL Anthropic cost
(tokens in/out, USD at the model's list prices, per-1k-records),
E flag counts by class, drift counts, a 10-summary faithfulness
hand-check against the sources, E spot-checks (3 flagged verified,
3 unflagged verified clean), label-presence checks, a use-case
search spot-check, and the standard smoke suite.

## Identity rule (implemented in `src/ingest.ts: resolveSource`)

A plugin's canonical identity is `owner/name` where **owner = the GitHub
owner of the plugin's source repo**:

- string relative source (`./plugins/x`, `./`) → the marketplace repo's owner
- object source with a github.com URL (`url`, `git-subdir`, `github`) → that URL's owner
- anything else (npm, non-GitHub git, `command`) → the marketplace owner, and
  the record is **pointer-only** (metadata + pointer, no file fetches)

Canonical URL: `https://talents.sh/skills/{owner}/{name}` · profile:
`https://talents.sh/{owner}`.

## Entry paths — three ways a skill becomes available

1. **A marketplace** — a repo (or direct URL) with
   `.claude-plugin/marketplace.json`. `ingest <owner/repo | url>` validates and
   indexes every entry.
2. **Plugin repos referenced by a marketplace** — each entry's source is
   resolved (relative path, GitHub repo, git-subdir, …) and its `plugin.json`
   + `SKILL.md` files are fetched in place, under the identity rule above.
3. **Standalone repo scan** — a GitHub repo whose skills are plain `SKILL.md`
   directories, with **no marketplace.json and no plugin.json at all**
   (`src/repo-scan.ts`, `ingest-repo <owner/repo>`). One recursive git-tree
   call finds every `SKILL.md` (cap 200; truncation is noted in the summary);
   each skill is validated, declared, hashed (SKILL.md + sibling files in the
   same directory, cap 20, files >200 KB skipped) and attested exactly like a
   marketplace entry. `ingest <owner/repo>` falls back to this scan
   automatically when the repo has no marketplace.json.

**Standalone identity rule:** owner = repo owner. name = the SKILL.md
frontmatter `name` when it is a clean slug, else the directory name; for a
root `SKILL.md`, the repo name when the frontmatter name is not a clean slug.
Two skills in one repo resolving to the same name: the first (in path order)
is kept, the rest dead-letter with reason `duplicate skill name in repo scan`.
Records carry `sourceMarketplace: direct-repo-scan:{owner}/{repo}` and
`ref` = the resolved branch name (the git-trees response carries no SHA for a
branch, so SHA pinning for standalone skills arrives with release tags).

**Description extraction (fixed 2026-11-11):** the SKILL.md frontmatter
parser handles YAML block scalars (`|` literal / `>` folded) and every
ingest path picks its record description through a usability guard
(`usableDescription` in `src/validate.ts`): a candidate with no letter or
digit in any script is rejected as debris and extraction falls through
(frontmatter → SKILL.md body heading/paragraph → plugin.json → none).
Re-ingesting a source refreshes an already-listed record when its rebuilt
attestation hash or description differs. The pre-fix parser had stored
block-scalar indicators and literal `description: ---` values as
descriptions on 1,588 records; all were repaired in place the same day
(`data/gate-descfix.txt`).

## What is real vs stubbed (P0 honesty)

**Real, running code:**
- `src/namespace.ts` — GitHub-like slug rules, first-come claim store (JSON
  file), and `verifyGithubOwnership(owner, token, fetchFn?)` against the real
  GitHub REST API shape (`GET /user`, `GET /user/memberships/orgs/{org}`,
  admin role required). Fetch is injectable; the CLI refuses a claim without
  a token in the environment.
- `src/ingest.ts` — GitHub adapter via `raw.githubusercontent.com` +
  `api.github.com` (default branch), direct marketplace.json URLs, source
  resolution (relative + github fully; npm/git/command recorded pointer-only),
  plugin.json + SKILL.md fetching.
- `src/repo-scan.ts` — standalone repo scan (entry path 3): one recursive
  git-tree call per repo, per-skill validate → declaration → hash →
  attestation, duplicate-name dead-letters. Wired as `ingest-repo` and as the
  automatic `ingest` fallback when marketplace.json is missing.
- `src/validate.ts` — marketplace / entry / plugin.json / SKILL.md-frontmatter
  validation, per-entry results, dead letters with publisher-notice payloads.
  One bad entry never fails an ingest.
- `src/declaration.ts` — derived declaration: components, MCP server configs
  (command/args/env keys/url), hooks — mapped to permission lines; anything
  underivable is labelled `undeclared`. No developer-authored manifest.
- `src/attest.ts` — sha256 over a canonical per-file-digest concatenation +
  ed25519 sign/verify (`node:crypto`); registry key auto-generated to
  `data/registry-key.json` with **0600** perms, never printed.
- `src/webhook.ts` — pure `handleGithubPush` (reindex only when a push touches
  `marketplace.json`, any `plugin.json`, or any `SKILL.md`) + a `node:http`
  server for `POST /webhooks/github` with X-Hub-Signature-256 HMAC
  verification when `TALENTS_WEBHOOK_SECRET` is set in the environment.
- `src/records.ts` — canonical records persisted to `data/registry.json`.
- `src/search.ts` — (P1) Typesense client over HTTP + collection schema +
  indexer + re-rank pass, and a local fallback engine behind the same
  interface (selected only when Typesense health fails, and announced).
- `src/web.ts` — (P1) SSR server: the five routes above, Grove v2 styling,
  full HTML escaping of record-derived text, JSON-LD on skill pages.
  Handler deps are injectable (`createHandler`/`depsFromRecords`) so route
  behaviour is unit-tested without a network.

**Stubbed / production targets (not live in P0):**
- **Storage:** P0 runtime store is a JSON file + in-memory index.
  `prisma/schema.prisma` models the production Postgres schema (§4) but is
  **not connected to a database**.
- **Publisher notices:** dead-letter notice payloads are produced and stored;
  no email is sent.
- **Webhook → ingest:** the handler decides and reports `{reindex, reason}`;
  the production queue (BullMQ) and GitHub App registration are P0-later.
  Wiring `onReindex` to `ingestGithubRepo` is a one-liner in the server deps.
- **Validation strictness (policy, user decision 2026-11-10):** plugin.json
  `version` is a **warning**, not an error — requiring it would force
  publishers to change their repos, which breaks the zero-change availability
  principle. Versionless entries stay listed, pinned by commit SHA (the
  record's `ref`) instead of a version tag; the warning is carried on the
  record's validation and feeds the health score.
- **Kind classification** is heuristic (mcp/agent/plugin from components).
- No payments (P4). Aggregated marketplace + MCP gateway landed in P2;
  the vector/semantic hybrid and the discovery pipeline landed in P5
  (see the P5 section).

## Gate results (2026-11-10, `npm run gate`, outputs in `data/`)

| Target | Seen | OK | Dead-letter |
|---|---|---|---|
| `anthropics/skills` (full) | 5 | 5 | 0 |
| `anthropics/claude-plugins-official` (`--limit 25`) | 25 | 24 | 1 |
| `anthropics/skills` standalone repo scan (`ingest-repo`) | 20 | 20 | 0 |
| `garrytan/gstack` via `ingest` fallback (`--limit 3`) | 3 | 3 | 0 |

Dead letter (official): `atomic-agents` — plugin.json not found at the pinned
sha. (Before the 2026-11-10 policy change there were 4 more — `ai-plugins`,
`amplitude`, `asana`, `atlassian`, all missing `version`; they are now listed
with the version warning, pinned by commit SHA.) Tests: **30/30 pass** with
`TALENTS_TYPESENSE_LIVE=1` (29 + 1 env-gated skip without it).

Standalone scan (summary in `data/gate-reposcan.json`): all 20 SKILL.md
skills in `anthropics/skills` listed with no marketplace involved — samples:
`anthropics/xlsx`, `anthropics/pdf`, `anthropics/skill-creator`. Fallback
proof, live: `garrytan/gstack` has no marketplace.json (71 SKILL.md files);
`ingest garrytan/gstack --limit 3` printed the fallback line and scanned —
samples `garrytan/gstack` (root skill → repo name), `garrytan/autoplan`,
`garrytan/benchmark-models` (summary in `data/gate-fallback.json`).

### Drain crash fix (2026-11-11, evidence in `data/gate-drainfix.txt`)

The backfill drain crashed deterministically on large collection
records: D1 rejects any single statement over 100,000 bytes
(`SQLITE_TOOBIG`), and `record_json` + `search_text` in one INSERT
reached 100–109 KB for the biggest collections (`nomadamas/k-skill`
100,314 bytes). Fixed with chunked flushes (90,000-byte statement
cap, 512,000-byte file cap) and chunked `upsertRecord` (80,000-byte
budget, 40,000-byte text chunks — stored rows are byte-identical to
the fast path), plus per-candidate flushes so one candidate's
failure dead-letters that candidate and never kills the drain.
Verified live: batches 23 → 25 (+827 records), zero new ingest
errors, all five poisoned candidates ingested.

**Worker path hardened to parity (2026-11-11, evidence in
`data/gate-d1harden.txt`):** the drain fix covered the operator
(wrangler-adapter) path; the Worker's native D1 binding shares the
same 100,000-byte statement limit, and two shared write paths did
not chunk — `D1EnrichmentStore.upsertLayer` (one INSERT carrying a
whole layer payload; B sub-inventories and C introspection dumps
are source-shaped and unbounded in total) and `appendSearchExtras`
(one UPDATE writing the full recomputed `search_text` + one FTS
INSERT with the full declaration text — the records ingest
deliberately stores past the limit are exactly the ones enrichment
rewrites). The constants and helpers now live in one shared module
(`src/d1-limits.ts`: 90,000-byte cap, 80,000-byte split budget,
40,000-byte text chunks, `estimateStatementBytes`), and both
enrichment writes use the same split pattern as `upsertRecord`
(first bounded chunk + `||` appends, byte-identical results). The
record upsert the Worker runs (cron/queue/webhook ingest) already
chunked via the shared `D1DiscoveryStore`; every other Worker D1
write was audited and is bounded by construction (see the gate
file's audit table). Verified live: the two largest-by-`search_text`
fixtures enriched through `POST /admin/enrich` with complete,
valid rows and fully rendered pages; suite 222 tests green.

**Component-shape fix (2026-11-11, evidence in
`data/gate-shapefix.txt`):** a marketplace entry may carry a
component collection as a bare string (the plugin spec allows
`commands: "./commands/"`) and ingest stored it verbatim —
`aaron-he-zhu/aaron-marketing`'s page 500'd on `commands.map`, and
`jeffallan/fullstack-dev-skills` stored its skills as a char array
(`"./skills/"` spread) with the same spread polluting both
records' derived declarations. Discipline now: every component
collection is built through `normalizeComponents`/`stringArray`
(`src/validate.ts`) at ingest and declaration derivation, the
store/search flatten path normalizes before writing, and the
render paths coerce stored collections defensively — a page never
throws on stored shape again. Production sweep + repair: exactly
2 affected records of 16,096 listed, both rebuilt through their
original builder with fresh attestations; class-wide re-scan 0.

### Queue-based backfill drain (2026-11-11, evidence in `data/gate-queuedrain.txt`)

The candidate backlog (~20.6k `sources.status='candidate'` rows)
moves from the sandbox operator drain to the **talents-ingest
Queue**. The consumer now handles CANDIDATE messages with the
drain's exact semantics — verify → ingest per message (shared
pipeline primitives, no fork), the list-classification heuristic
on the no-skill-files rejection path, and the locator collapse
(twin rows retire when the canonical row reaches a terminal
state) — upgraded by queue retry semantics: failure CLASS decides
the outcome. Deterministic failures (not-a-skill, repo gone/404,
oversized-deterministic ingest errors) mark the source rejected
with the reason in D1 and the message acks; transient failures
(network, GitHub 5xx / 403 / 429, our own bad credential) throw,
retry 3×, and land in the new **talents-ingest-dlq** — the source
row stays a candidate throughout, so a DLQ'd candidate is
recoverable by re-enqueueing, never silently rejected for an
operator-side problem (`verifyRepo` now classifies its failures:
404 deterministic, everything else transient). Verified-source
messages (cron sweep, webhook re-ingests) keep the original path
byte-for-byte. Producer: `POST /admin/enqueue-candidates`
(ADMIN_TOKEN-gated, paged `{limit ≤ 500, cursor}` in
verification-priority order, returns the exact enqueued source
ids) plus a scheduled step gated by `QUEUE_DRAIN_ENABLED`
(default OFF, deliberately unset) that enqueues one bounded page
(100) per daily cron run. Consumer `max_concurrency: 5` is the
rate governor (≤8 api.github.com calls/candidate against the
5,000/hr token budget ⇒ ~400 candidates/hr target; math in the
gate). Worker-side GitHub calls authenticate when the
`GITHUB_TOKEN` secret is set: one fetch wrapper in
`cf/src/discovery.ts` attaches it to api.github.com only, and the
code-search scout already read it from env. **Status: built,
tested (suite 249: 248 pass + 1 skip), deployed (Worker
aca4e6b7) — but the cutover slice has NOT run: the token is not
yet set** (the `talents-github` connector's policy denies sandbox
surrogate retrieval; the secret must be set from the real value
via secure entry). Until then the sandbox drain + watchdog remain
the backlog's engine, untouched; the flag stays off.

### P1 gate (2026-11-10, `npm run gate:p1`, evidence in `data/gate-p1-pages.txt` + `data/gate-p1-search.json`)

Real Typesense 29.0 binary, health `{"ok":true}`; `talents index` loaded
**49 documents** (46 registry + 3 fallback-registry records). All page
checks passed: `/` 200 with trending cards · `/skills/anthropics/xlsx` 200
with parseable JSON-LD, derived declaration, attestation hash and use panel ·
`/anthropics` 200 · `/s/anthropics/xlsx` 301 → `/skills/anthropics/xlsx` ·
unknown skill 404. All five search checks passed through the running server:

| Query | Result |
|---|---|
| `pdf` | `anthropics/pdf` first of 5 |
| `document` | `anthropics/document-skills` first of 8 |
| `pdff` (typo) | `anthropics/pdf` first of 5 |
| `pdf` + `kind=skill` | 3 results, all kind `skill` |
| `security` | `42crunch-ai/42crunch-api-security-testing` first of 3 |

P0 gate re-run after P1 landed: unchanged (5/5, 24/1).

## Layout

```
src/  namespace.ts ingest.ts repo-scan.ts validate.ts declaration.ts
      attest.ts records.ts webhook.ts cli.ts types.ts
      search.ts (P1) web.ts (P1 node shell) render.ts (P1 templates, extracted P2)
      aggregate.ts (P2) search-d1.ts (P2) advisor.ts (P2 remainder, pure shaping)
      discovery/ (P5) sweep.ts store.ts pipeline.ts embeddings.ts
      ranking.ts synonyms.ts wrangler-d1.ts
      creator/ (P4, pure + unit-tested) fees.ts claims.ts overrides.ts
      jwt.ts stripe.ts access.ts analytics.ts
cf/   the Cloudflare app (P2): src/index.ts (Worker) src/db.ts src/mcp.ts
      src/verify.ts · src/advisor.ts (Think TalentAdvisor DO)
      src/discovery.ts (P5 Worker glue: hybrid search, trending,
      suggest, webhook, cron, queue consumer, admin routes)
      src/auth.ts (P4 Clerk session verification) · src/creator.ts
      (P4 store + handlers) · src/stripe.ts (P4 REST client) ·
      src/render-creator.ts (P4 dashboard pages, shared Grove shell)
      migrations/0001_init.sql · 0002_discovery.sql · 0003_vector_id.sql
      · 0004_scouts.sql · 0005_creator.sql
      scripts/seed.mjs
      scripts/deploy_preview.py · scripts/set_advisor_secret.py
      scripts/provision_discovery.py · scripts/set_discovery_secrets.py
      scripts/discover_remote.py (P5 cycle against production D1)
      scripts/deploy_creator.py (P4 incremental deploy: migrations +
      build + deploy, NEVER seeds) · scripts/d1_remote.py (remote SQL)
      wrangler.jsonc (local; placeholder D1 id; NO ai/vectorize/queues
      bindings — see the P5 gate-maintenance note)
      wrangler.deploy.jsonc (deploy config; real D1 id, custom-domain routes)
prisma/schema.prisma   production Postgres model (superseded by D1 in P2; kept for reference)
scripts/dev-typesense.sh   start/stop the local dev Typesense binary
scripts/gate-p1.mjs        the P1 gate (pages + search evidence)
scripts/gate-p2.mjs        the P2 gate (Worker + D1 + aggregate + MCP evidence)
scripts/gate-advisor.mjs   the advisor gate (live /advisor goals → data/gate-advisor.json)
scripts/gate-discovery.mjs the P5 gate (live discovery + depth → data/gate-discovery.json)
scripts/gate-creator.mjs   the P4 gate, local half (auth-stub boot + fixture webhook → data/gate-creator.json/.txt)
scripts/gate-creator-live.mjs the P4 gate, live half (public smoke + production fixture unlist cycle, appends to the same evidence)
scripts/source-relay.mjs   dev-only GitHub fetch relay for sandbox workerd
test/p0.test.ts        namespace · ownership · webhook+HMAC · declaration · attestation
test/reposcan.test.ts  standalone scan · duplicates · fallback trigger
test/p1.test.ts        escaping · JSON-LD · routes · rerank · local engine · Typesense integration (env-gated)
test/p2.test.ts        aggregate builder · origin assertions · D1 search plan/engine · WebCrypto≡node hash
test/advisor.test.ts   advisor shaping · reply extraction · goal validation · error classification
test/discovery.test.ts sweep verification · dedup · hybrid weights · behavior · cold-start · stack · synonyms · indexer
test/creator.test.ts   claims · overrides/unlist · fee math · mock-Clerk JWT · Stripe webhook · purchase tokens · gateway gating · analytics
data/                  registry.json (records) · gate-*.json · gate-p1-pages.txt · gate-p1-search.json
                       gate-p2.txt · gate-p2.json · aggregated-marketplace.json · test-output.txt
                       registry-key.json (0600, gitignored — never commit)
.tools/                Typesense binary + data dir (gitignored)
```
