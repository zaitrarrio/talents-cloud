# Talents — Scalability & Durability Audit + Build Plan

Audit date: **2026-11-12 ~01:40–02:00 UTC** (19:40–20:00 CST 2026-11-11).
Method: read-only. Code read in `talents/` + `cf/src/`; live measurements
against production D1 (read-only `SELECT`s via `cf/scripts/d1_remote.py`),
live curls against talents.sh, Cloudflare API reads (D1, Vectorize,
Queues, R2, Worker versions). No code changed, nothing deployed, no
secrets touched, no D1 writes. Every number below carries its source
and time; estimates are labelled as estimates with the arithmetic shown.
Limits are quoted from Cloudflare's published docs (D1 limits page,
updated 2026-10-30; Workers limits; Vectorize changelog 2026-01-23)
and cross-checked against live measurements where the platform lets
us measure (100 KB statement and 50 MB result were both measured
live on 2026-11-11).

## 0. Headline: what breaks next

The catalog went **872 → 22,407 listed records in ~40 hours**
(first ingest 2026-11-10T13:44Z; 21,648 records ingested in the
last 24 h alone). Four platform limits have already bitten in the
last 24 h; one is still live as this audit is written:

| # | Limit hit | Status at audit time |
|---|-----------|----------------------|
| 1 | D1 50 MB single-query result (`allRecords`) — home + trending 500, search degraded | **Fixed in-tree and live** (Worker v59, deployed 2026-11-12T01:47Z; home 200, trending 200, search `d1+vectorize`) |
| 2 | Workers 1,000 subrequests/invocation (`catalogOwners` N+1, 1,075 calls) | Fixed in the auth task (single-scan rewrite) |
| 3 | D1 100 KB single statement (drain crash) | Fixed via chunked writes, both transports (`src/d1-limits.ts`) |
| 4 | D1 50 MB result + 1,000/invocation inside `refreshRecordStats` | **STILL LIVE — P0-1.** Every verified-queue message and every daily cron cycle calls it; it cannot complete at current scale (see §1.4) |
| 5 | Aggregate `marketplace.json` rebuilt live per request: 8.9 MB / 19.3 s wall | **LIVE — P0-2.** Breaks at 2x catalog on memory/CPU |
| 6 | Sandbox drain dies ~hourly (VM restarts, proxy failures) | Queue migration built; 500-slice **complete 500/500 in 26 min** (see §1.6); cutover pending |

The next two breaks after those are per-message subrequest exhaustion
on large collections (~250-skill collections, P1-1) and the
`listSources()` full-table load in the Monday list refresh (P1-3).
The 10 GB D1 ceiling is **not** the near-term constraint.

## 1. Measured state (2026-11-12 ~01:40 UTC unless noted)

### 1.1 Catalog and database

| Metric | Value | Source |
|---|---|---|
| Listed records | 22,407 | D1 `records` count |
| `record_json` total | 53,475,879 B (53.5 MB) | `SUM(LENGTH(record_json))` |
| `search_text` total | 20,949,704 B (21.0 MB) | `SUM(LENGTH(search_text))` |
| Avg / max `record_json` | 2,386 B / 62,569 B (aaron-he-zhu/aaron-marketing) | D1 |
| Max `search_text` | 45,025 B (same record) | D1 |
| Sources rows | 22,112 total: candidate 20,141 · ingested 1,224 · stale 609 · verified 21 · rejected 76 · watchlist 36 · mined 5 | D1 `sources` by status |
| Sources text columns | ~9.0 MB total | `SUM(LENGTH(...))` over locator/url/reason/provenance |
| Enrichment rows | 543 (2.4% of catalog), 2.1 MB JSON total | D1 `enrichment` |
| `embedding_meta` rows | 21,099 (1,308 listed records unembedded) | D1 |
| `record_stats` rows | 12,582 (9,825 listed records with no stats row — 44% stale) | D1 |
| `gateway_calls` rows | 7 | D1 |
| `installs` rows | 1 | D1 |
| Unlisted skills | 0 | D1 |
| D1 file size | 233,865,216 B (233.9 MB), 26 tables, created 2026-11-10T14:34Z, read replication **disabled** | Cloudflare API |
| Largest owner | nvidia, 510 records; next reason-machines 483, jeremylongshore 427 | D1 `GROUP BY owner` |
| Growth | 2026-11-10: 759 · 2026-11-11: 15,325 · 2026-11-12 (partial): 6,323 records/day | D1 `ingested_at` by day |
| All-in bytes per record | 233.9 MB / 22,407 ≈ **10.4 KB/record** (data + FTS + indexes + free pages) | derived |

FTS index size (estimate, labelled): DB file 233.9 MB − record_json
53.5 − search_text 21.0 − sources ~9.0 − enrichment 2.1 − other
tables ~2 ≈ **~146 MB for FTS5-trigram indexes + SQLite indexes +
free pages**. `dbstat` is not exposed by D1, so this is arithmetic,
not a measurement. The trigram index is the dominant storage
multiplier (~6.5x the `record_json` bytes it indexes).

### 1.2 Live latency and response sizes (curl, 2026-11-12 ~01:35 UTC)

| Route | Status | Size | Wall time |
|---|---|---|---|
| `/` home | 200 | 14,188 B | 2.10 s |
| `/api/trending` | 200 | 918 B | 1.38 s |
| `/api/search?q=pdf` | 200, engine `d1+vectorize` | 13,728 B | 3.27 s |
| `/api/search?q=security` | 200, engine `d1+vectorize` | — | — |
| `/.claude-plugin/marketplace.json` | 200 | **8,922,195 B (8.9 MB)** | **19.31 s** |
| `/skills/anthropics/pdf` | 200 | 21,795 B | 5.01 s |
| `/api/suggest?skill=anthropics/pdf` | 200 | 3,182 B | 2.89 s |
| MCP `initialize` at mcp.talents.sh | 200 | — | — |

Wall time ≠ CPU time (D1 I/O waits don't consume CPU), but the
record page at 5 s and the aggregate at 19 s are the latency
outliers. No SLO exists for any route.

### 1.3 Platform limits that apply (Cloudflare docs, paid plan)

| Limit | Value | Current use | Headroom |
|---|---|---|---|
| D1 max database size | 10 GB | 233.9 MB | 2.3% used; ~43x |
| D1 max query result size | 50 MB (enforced 2026-11-04) | 53.5 MB full-table `record_json` | **exceeded — hit 2026-11-11** |
| D1 max SQL statement | 100,000 B | max single write chunked to ≤90,000 B | guarded by `src/d1-limits.ts` |
| D1 max row / string / BLOB | 2,000,000 B | max `record_json` 62,569 B | 32x |
| D1 queries per Worker invocation | 1,000 | `refreshStats`: 22,407+ writes | **exceeded — live (P0-1)** |
| D1 max query duration | 30 s | FTS MATCH indexed; LIKE fallback is a full-table scan | watch |
| D1 bound parameters / query | 100 | `recordsByIds` chunks at 50 ids | guarded |
| Workers memory / isolate | 128 MB | aggregate doc 8.9 MB + parsed records in memory | see P0-2 |
| Workers CPU time | 30 s HTTP (15 min cron / queue consumer duration) | aggregate 19.3 s wall (CPU portion unmeasured) | see P0-2 |
| Workers subrequests | 1,000 / request | same as D1 queries/invocation | see P1-1 |
| Workers script size | 10 MB gzipped | not measured this audit | check at P1-8 gate |
| Vectorize max vectors / index | 10 M (changelog 2026-01-23; limits page still says 5 M) | ~21,099 vectors | 0.2% |
| Vectorize topK | 100 | queries use topK 30 / 12 | fine |
| Queues message retention | 4 days (`message_retention_period` 345600 s, API-read) | — | see §2.4 |
| Queues consumer | max_batch_size 1, max_retries 3, max_concurrency 5, DLQ `talents-ingest-dlq` | — | see §1.6 |
| GitHub core API | 5,000 req/hr (verified live: limit 5000, remaining 4981) | slice pace implies ~3,500/hr typical | see §1.6 |
| GitHub search API | 30 req/min | code-search scout, 1 page/run | fine |

### 1.4 The live P0: `refreshRecordStats` cannot complete anywhere in the Worker

`refreshRecordStats` (`src/discovery/store.ts:693`) does two things
that each independently exceed a per-invocation platform limit at
current scale:

1. `SELECT record_json FROM records WHERE status = 'listed'` —
   53.5 MB > the 50 MB query-result limit. It throws before any
   work happens.
2. One `INSERT … ON CONFLICT` per listed record — 22,407 sequential
   D1 writes > the 1,000 queries/invocation cap. It could never
   finish even if the SELECT passed.

Callers (all in the Worker or on the Worker-triggered paths):
`cf/src/discovery.ts:779` (queue consumer, verified path — runs
**after** `ingestSource` succeeds), `src/discovery/pipeline.ts:357`
(end of every discovery cycle, incl. the daily cron),
`src/discovery/scouts/runner.ts:225` (end of every scout funnel).
The operator drain also calls it (`scripts/backfill-drain.mjs:212,224`)
but on the wrangler transport, which has no per-invocation cap —
that is why `record_stats` has 12,582 rows at all.

Consequences, measured: `record_stats` covers only 12,582 of 22,407
records (44% stale), so behavioral ranking and the trending
velocity path run on stale/missing scores for nearly half the
catalog. The verified-queue path ingests the record and *then*
throws in `refreshStats`, so the message retries 3x and dead-letters
— the record is listed, the message lands in the DLQ, and stats
never refresh. DLQ depth is not observable through the Cloudflare
API (see §2.4), so the accumulation is unconfirmed by direct
measurement; the mechanism is certain and the dashboard check is
P0-4's first step.

### 1.5 Remaining full-table loads (grep-verified, 2026-11-12)

| Site | What it loads | Current size | Breaks at |
|---|---|---|---|
| `refreshRecordStats` | full `record_json` table (53.5 MB) + 22,407 writes | 53.5 MB / 22,407 stmts | **already broken (P0-1)** |
| `listSources()` in `refreshAllLists` (`src/discovery/lists.ts:518`) | ALL sources rows (~9 MB), filters to `kind='list'` (5 rows) in JS | 22,112 rows | ~5–6x sources (~120k rows, ~50 MB) — Monday cron |
| `vectorIdMap()` (`src/discovery/store.ts:553`) | ALL `embedding_meta` rows (21,099) on **every vector search** | ~1.3 MB/response | ~10x catalog (~13 MB/search, plus per-search latency) |
| `recordsByOwner` / `listingsForOwner` (no LIMIT) (`cf/src/db.ts:314`, `cf/src/creator.ts:485`) | all of one owner's records | nvidia 510 recs ≈ 1.2 MB | ~10x owner size (~5k recs, ~12 MB) |
| `catalogOwners` (`cf/src/creator.ts:84`) | `(owner, source_repo)` for all listed | 22,407 rows ≈ 1 MB | ~10x (~10 MB per dashboard load) |
| FTS pass `LIMIT 500` (`src/search-d1.ts:215`) | up to 500 full `record_json` rows per token | 500 × 2.4 KB avg ≈ 1.2 MB; pathological 500 × 62 KB ≈ 31 MB | a token matching many max-size collections (~1.6x max-record growth) |
| `existingRecordIds()` (`src/discovery/store.ts:431`) | all record ids | 22,407 ids ≈ 0.4 MB | ~100x catalog |
| `LIKE_SQL` / `ALL_SQL` (`src/search-d1.ts:223`) | `LIMIT 50` each — bounded; but `LIKE '%token%'` is a full-table scan per token | one scan per token pass | latency grows with table size; watch, not a break |

Bounded already (verified in this audit): home (`listedStats` +
`trendingRecords`, 8 ids), trending (ids-only + 500-record pool),
search vector block (`recordsByIds`, chunked 50), suggest (capped
pools 100/100/100), aggregate (paged 500 reads — but whole doc held
in memory, §1.7), admin embed/enrich/enqueue (paged), cron embed
sweep (100/invocation budget).

### 1.6 Queue and drain (measured 2026-11-12 ~01:30 UTC)

- Queue slice **complete**: 500/500 candidates terminal in 26 min
  (01:07:59–01:33:54Z) — 182 ingested, 305 stale (twin collapse),
  13 rejected, 5,236 new records. Throughput ≈ **1,154
  candidates/hr**, 2.9x the gate's 400/hr target.
- GitHub budget implication: at 3 calls/candidate (typical) the
  slice pace burns ~3,500 core calls/hr (70% of the 5,000 budget,
  shared with scouts/enrichment/webhooks); at the 8-call worst case
  it would need ~9,200/hr — **over budget**. The consumer's
  `max_concurrency: 5` does not know about the token budget.
- Remaining backlog: 20,141 candidates → at slice pace ~18 h of
  queue time; at the gate's conservative 400/hr ~50 h. Completing
  it adds ~20k records ≈ +210 MB to the DB file (at 10.4 KB/record
  all-in).
- Per-message D1 load: `upsertRecord` is ~3 statements/record
  (drainfix gate), so the largest current collection (134 skills,
  nomadamas/k-skill) costs ~400 record statements + ~200 embed
  statements + source/twin writes ≈ **~600 subrequests in one
  message** — under the 1,000 cap with 1.7x headroom on collection
  size. Collections above ~250 skills break the consumer (P1-1).
- Queue settings (API-read): retention 4 days both queues;
  `talents-ingest` 1 producer / 1 consumer; `talents-ingest-dlq`
  0 producers / 0 consumers (nothing consumes it, by design).
  Queue *depth* is not exposed by the Cloudflare API — there is no
  programmatic depth metric today.
- Sandbox drain: progress frozen at 27 batches / 10,825 new records
  for most of 2026-11-11 (died within minutes of every hourly
  watchdog relaunch); the watchdog only verifies "process exists
  after 25 s" and never diagnoses why it died. The drain's only
  durable state is `data/backfill-drain-progress.json` in the
  workspace (durable) plus the D1 `sources` table.

### 1.7 Aggregate marketplace.json — the next break (measured)

- Live build per request: 8,922,195 B response, **19.31 s wall**,
  45 sequential paged reads (500/page). The doc is assembled whole
  in memory (`createAggregateBuilder` accumulates every entry; the
  response is one `Response.json(doc)`).
- At 2x catalog (~45k records): ~18 MB doc, ~40 s wall, in-memory
  peak roughly 2x today's — against the 128 MB isolate limit and
  the 30 s CPU limit (CPU portion of today's 19.3 s is unmeasured;
  JSON parse/serialize of 8.9 MB is CPU-bound work). At 10x
  (~224k records): ~89 MB doc — does not fit in an isolate.
- It is also the most expensive read on the platform: 22,407 rows
  read per call, and it is rebuilt from scratch on *every* request
  (no cache headers, no R2 copy). Every `/plugin marketplace add
  talents` fetch pays the full 19 s.

## 2. Durability audit — the gaps

### 2.1 D1 backup and restore

What exists today:
- **Time Travel is always on** (D1, paid plan): restore the whole
  database to any minute in the last 30 days. That is the *only*
  backup that exists, and it has never been tested (no restore drill
  on record).
- Its limits, from the docs: restore is **in-place and whole-DB**
  (it overwrites the live database — you cannot restore one table
  or one row, and you cannot clone/fork to a scratch DB to inspect
  first); rate-limited to 10 restores per 10 min; the restore point
  must be within the 30-day window (7 days on free).
- `wrangler d1 export` exists for a portable snapshot (SQL dump to
  a file); a full export to R2 is not scheduled anywhere.

What is missing:
- No scheduled export or snapshot of any kind (grep for
  backup/snapshot/export in the repo: nothing). Nothing survives
  past the 30-day Time Travel window; a corruption discovered at
  day 31 is unrecoverable.
- No recovery procedure written down: who runs the restore, which
  restore point to pick, what to do about writes that landed after
  the restore point (they are lost — a restore is a rewind), how to
  re-verify the catalog afterwards (the attestation hashes give a
  verification primitive, but no script re-verifies them en masse).
- No tested path for a bad migration: migrations are forward-only
  (no down migrations in the repo). A bad migration's only recovery
  is a whole-DB Time Travel restore, which also rewinds every
  legitimate write since the migration.
- Recovery time is unmeasured (no drill). A full export at current
  size is ~234 MB as a SQL dump (order of magnitude; the D1 API
  returns the file size as 233.9 MB — the export will be larger,
  SQL text vs binary).
- D1 read replication is disabled (API-read) — there is no
  read-replica fallback, and D1's single-writer model means all
  writes (queue consumer ×5 concurrency, daily cron, admin
  embeds/enriches, webhooks) serialize through one primary. No
  write-contention incident has been measured yet; it is a watch
  item, not a current break.

### 2.2 Registry ed25519 key

- The key exists in exactly two places: `talents/data/registry-key.json`
  (0600, gitignored, 276 B, created 2026-11-10) and as the
  `TALENTS_REGISTRY_KEY` Worker secret. The secret is the only
  off-disk copy and is **not documented as a backup**.
- No encrypted backup to R2 or any vault. No rotation procedure.
  If the key is lost, no new attestation can ever be issued; if it
  leaks, every stored attestation becomes suspect and there is no
  revocation story — rotating would invalidate all 22,407 stored
  attestations at once and require a full re-attestation pass
  (there is no re-attestation job; the drain/ingest path attests
  per-record on ingest, but a bulk re-attestation would need to be
  built).
- The key's fingerprint is not published anywhere the catalog
  consumer could verify against (the attestation is verified
  server-side only, in the gateway's install confirm path).

### 2.3 Secrets — inventory and rotation

| Secret | State | Rotation |
|---|---|---|
| `GITHUB_TOKEN` | Set (Worker secret, 2026-11-11). Classic PAT. Expiry unknown. | None documented |
| `ANTHROPIC_API_KEY` (advisor) | Set 2026-11-10. **Transited chat** — rotation still outstanding (user advised, not done). | None |
| `CLERK_SECRET_KEY` + publishable | Set; **TEST keys** (`pk_test_`/`sk_test_`). Live keys pending (user step). | None |
| `ADMIN_TOKEN` | Set; re-minted per gate via the secrets script, then the /tmp copy is deleted. | Ad-hoc (per gate) |
| `TALENTS_REGISTRY_KEY` | Set (see §2.2). | None — no procedure |
| `WEBHOOK_SECRET` | **Unset.** `/webhooks/github` is in accept-and-log dev mode (`signatureChecked: false`) — anyone can trigger re-ingest work by POSTing to it. | n/a |
| `STRIPE_*` | Unset (platform account decision pending with the user). | n/a |

No secret has a documented rotation schedule, owner, or procedure.
The sandbox `/tmp` admin-token sink is a recurring fragility (wiped
by VM restarts at least twice on 2026-11-11), but it is a
per-gate operational file, not a durability dependency for the
platform itself.

### 2.4 Queues — retention, expiry, observability

- **Retention 4 days**: a message that sits unprocessed for 4 days
  is dropped by the platform. The durable state is the D1 `sources`
  row (still `candidate`), so a dropped message is recoverable by
  re-enqueueing — but nothing today detects that a message was
  dropped, and there is no re-enqueue sweep.
- **DLQ**: `talents-ingest-dlq` has no consumer and no alert.
  **DLQ depth is not exposed by the Cloudflare API** (verified
  2026-11-12: queue objects carry no depth field) — the only depth
  signal is the Cloudflare dashboard, which no human watches on a
  schedule.
- **At-least-once delivery**: the consumer's failure classification
  (deterministic → reject, transient → throw/retry) is sound, but
  retries can duplicate ingest work; the hardening build adds
  processing leases to close this (in flight, §3).
- The sandbox drain and the queue consumer can both work the same
  candidate (no shared lease yet) — the hardening build adds the
  lease; until it lands, twin-collapse logic is the only
  deconfliction.

### 2.5 Release safety

- **No staging Worker.** `cf/wrangler.jsonc` is a local-dev config
  (placeholder D1 id, same custom-domain routes). Every deploy goes
  straight to production: 59 Worker versions in ~2 days
  (v57 auth swap 2026-11-12T01:29Z, v59 d1size fix 01:47Z).
- **Rollback exists but is undocumented and undrilled**: Worker
  versions are retained, so `wrangler rollback` (or deploying a
  previous version id) works in principle. Nobody has run it, and
  no deploy script invokes it. Rollback reverts code, not D1 —
  a bad migration deployed forward cannot be rolled back by a code
  rollback.
- **No deploy gate**: deploys are manual `wrangler deploy` runs
  from the sandbox; the gate files are written by hand after live
  verification. There is no canary, no smoke suite wired into any
  deploy script, and no pre-deploy check that the deployed version
  matches the tested tree.
- Migration safety: migrations are applied with `wrangler d1
  migrations apply --remote` and are additive-only by convention;
  nothing in the repo validates that a migration is backwards
  compatible with the live code (the office-hours PR #148 preview
  failure on SmartER is the cautionary example in the user's other
  project).

### 2.6 Monitoring and alerting — what detects a failure today

| Failure | Detector today |
|---|---|
| Home / search / trending 500 | **The user, reporting it in chat** (that is how the 50 MB incident surfaced, 2026-11-11 19:44 CST). No alert. |
| Stalled queue (no terminal transitions while candidates remain) | None. Queue depth is not API-visible; no stall check exists. |
| DLQ backlog | None (dashboard-only, unwatched). |
| Dead sandbox drain | Hourly watchdog cron (process-exists check only; verifies "alive after 25 s", never diagnoses cause; up to 1 h dead per death). |
| Embedding lag (1,308 listed records unembedded) | None — no gauge. |
| Enrichment coverage (2.4%) | None — no gauge. |
| D1 size / query-result pressure | None — no gauge. |
| GitHub budget exhaustion | None — the 403/429 signal exists in the consumer's error path but is not recorded anywhere. |
| A 500 on the record page, MCP gateway, or advisor | None. |

There is no Sentry, no Logpush, no uptime check, no health
endpoint, no SLO, and no on-call channel anywhere in the repo
(grep-clean). The only scheduled observers are the hourly drain
watchdog and the two Cloudflare crons (daily discovery 04:23 UTC,
weekly enrichment 05:41 Mon).

### 2.7 Other durability dependencies

- **Sandbox drain progress file** (`data/backfill-drain-progress.json`):
  the checkpoint for the drain; D1 is the durable state and the
  file is recoverable from it, but the drain's resume logic reads
  the file, and a corrupted or stale file re-queues work or skips
  it. It lives in the workspace (durable across VM restarts).
- **Advisor Durable Object** (`TalentAdvisor`): session-scoped
  SQLite state; loss is acceptable (advisor sessions are
  ephemeral) — document it, don't back it up.
- **Creator data** (claims, listing overrides, purchases,
  entitlements) lives in the same D1 — covered by the §2.1 backup
  plan; no separate store exists, which is the correct call for
  now.
- **Single points of failure**: one D1 database, one Worker script,
  one GitHub token shared by every GitHub-consuming path (drain,
  scouts, enrichment layer A, webhooks), one Cloudflare account.
  None of these is fixable cheaply at this scale; the plan
  addresses the ones that bite first (token budget governor,
  backup, staging).

### 2.8 Enrichment and embedding cost scaling (measured)

- **Layer D (Anthropic, generated)**: final payloads 2,862,645 in /
  425,431 out tokens over the tranche-2 slice = $4.99; **$9.78 per
  1k generated records, ≈$11.46 per 1k slice records** all-rounds
  (Haiku 5.5: $1.00/M in, $5.00/M out). Full catalog (22,407):
  **≈$219 (generated-only) to ≈$257 (slice basis) per full pass**.
  At 10x catalog (~224k): **≈$2,190–$2,570 per full pass**.
  Cost scales linearly with records; the withholding rule (31 of
  541 withheld for insufficient material) is the only throttle.
- **Embeddings (Workers AI `bge-base-en-v1.5`)**: per-call cost is
  small and not separately metered in any gate — the scaling risk
  is throughput, not dollars: the daily cron embed budget is
  100/invocation, while backfill ingests up to ~6,300 records/day
  (1,308 listed records are unembedded right now). Per-message
  embeds cover queue-ingested records only; the sandbox drain's
  records are embedded by the same cron sweep.
- **Enrichment coverage**: 543/22,407 (2.4%) — the backfill outran
  enrichment by design (bounded slices). A full-catalog pass is
  unbudgeted and unplanned; at 10x it is a $2.5k line item.

## 3. The plan

Order: by what breaks next. P0 = live break or breaks within weeks
at the current backlog pace. P1 = breaks at ~2x catalog (~45k
records) or ~2x collection sizes. P2 = breaks at ~10x (~224k
records) or is structural. Each item names the concrete fix shape,
the files/routes, the gate, and its dependency on in-flight work.

In-flight work at audit time (2026-11-12 ~02:00 UTC):
- **D1-size fix** — bounded reads; **landed and live (Worker v59)**.
- **Queue slice** — **complete**: 500/500 terminal in 26 min.
- **Drain/queue hardening build** — in flight (paced producer, DLQ
  recovery, rate-limit backpressure, leases, stall detection). Gate
  file `data/gate-harden-drain.txt` pending.
- **Sandbox drain + hourly watchdog** — still running; cutover not
  yet done.

### P0 — live breaks (do first)

**P0-1. Replace `refreshRecordStats` with an incremental stats path**
- Why first: it is the only item that is *already failing in
  production* on every verified queue message and every cron cycle.
  It also poisons the DLQ (§1.4).
- Fix shape: (a) on ingest, update `record_stats` for exactly the
  records that changed — one `INSERT … ON CONFLICT` per record,
  computed from the record's own fields (no table scan); (b) a new
  paged rebuild job `POST /admin/stats-rebuild {limit, cursor}`
  that recomputes stats 500 records at a time (keyset-paged, same
  contract as `/admin/embed`), run by the daily cron to heal drift;
  (c) delete `refreshRecordStats` entirely (no caller may keep a
  full-scan fallback).
- Files: `src/discovery/store.ts` (`refreshRecordStats` → new
  `upsertStatsFor(record)` + paged `rebuildStatsPage`),
  `cf/src/discovery.ts` (queue verified path),
  `src/discovery/pipeline.ts:357` (cycle end), `src/discovery/scouts/runner.ts:225`
  (scout end), `scripts/backfill-drain.mjs` (its per-5-batch call),
  `cf/src/index.ts` (new admin route), `test/` (strict-harness
  test: 60k-record synthetic store, any single query > 50 MB or
  any invocation > 900 statements fails the test).
- Gate: a verified-queue message for a 100-skill collection
  completes with < 100 D1 statements total and no error; after the
  rebuild job runs to completion, `record_stats` rows == listed
  records (within the same hour); trending velocity no longer
  reads stale rows for >1% of listed records.
- Dependency: coordinate with the hardening build — it owns the
  consumer path right now. Either fold P0-1 into that build or
  land it immediately after its freeze lifts. Do **not** land two
  consumer changes in the same deploy.

**P0-2. Stop rebuilding the aggregate marketplace.json live per request**
- Fix shape: build the aggregate incrementally into R2 (object
  `talents-aggregate/marketplace.json` in the existing
  `talents-assets` bucket, or a new `talents-public` bucket) on a
  cron (every 15 min) and on demand after a verified ingest lands
  a record (debounced — at most one rebuild per 5 min); the route
  serves the R2 object with `Cache-Control: public, max-age=300`
  and an `ETag`; keep a live build only behind
  `?fresh=1` + ADMIN_TOKEN. Rebuild reads the catalog paged
  (500/page, as today) but writes the JSON in streaming chunks
  (R2 multipart / chunked put), never holding the whole doc in
  memory twice.
- Files: new `cf/src/aggregate-cache.ts`, `cf/src/index.ts`
  (route), `cf/wrangler.jsonc` + `wrangler.dev.jsonc` (R2 binding
  already exists as ASSETS — reuse it), `test/` (byte-identical
  doc vs the live builder on a fixture catalog).
- Gate: `/.claude-plugin/marketplace.json` p95 < 500 ms on the live
  site (measured over 10 curls); doc byte-identical to the live
  build for the same catalog snapshot; a rebuild at current scale
  completes in < 5 min of wall time; a stale copy is never older
  than 20 min after a record lands (cron + debounce).
- Dependency: none. Independent of the hardening build and the
  slice.

**P0-3. Scheduled D1 export to R2 + a restore drill + a runbook**
- Fix shape: a nightly Cloudflare cron (new `talents-ops` Worker
  or an added scheduled branch in the existing Worker) that runs
  `wrangler d1 export` (or the D1 export REST API) and stores the
  dump in R2 under `talents-backups/d1/YYYY-MM-DD.sql.zst` with
  30-day retention; a one-page runbook
  `docs/d1-recovery.md` (Time Travel restore steps, export-restore
  steps, restore-point selection rule: latest export before the
  incident + the writes-after-restore-point re-ingest procedure);
  a quarterly restore drill: restore the latest export into a
  scratch D1 database and run the read-only smoke suite against
  it (home, search, record page, aggregate byte-count).
- Files: new `cf/src/ops.ts` (scheduled export branch) or a cron
  script under `cf/scripts/`, `docs/d1-recovery.md`,
  `cf/scripts/restore-drill.sh`.
- Gate: 3 consecutive nightly exports land in R2 (object present,
  size within 20% of the live DB file size); one drill restores the
  export into a scratch D1 and the smoke suite passes against it;
  runbook reviewed by the user (it names the person who runs the
  restore — the user).
- Dependency: none. Cost: R2 storage ~234 MB × 30 days ≈ 7 GB
  (R2 storage is cheap; exact figure from the Cloudflare invoice
  at the first drill).

**P0-4. DLQ visibility and verified-path failure diagnosis**
- Fix shape: (a) read the current DLQ depth from the Cloudflare
  dashboard *now* and record it (the API cannot return it — this
  is a dashboard check, not code); (b) add the depth to the
  health endpoint (P0-5) once the hardening build's `dlq-sweep`
  endpoint lands (it reports DLQ depth); (c) confirm whether
  verified-source messages are in the DLQ because of P0-1 — after
  P0-1 lands, watch the DLQ for 24 h: new arrivals should drop to
  ~0.
- Files: none for the dashboard check; `cf/src/index.ts` (health
  endpoint) for the programmatic depth.
- Gate: DLQ depth is a number on a page the user can see (health
  endpoint), with a threshold (see P0-5); the 24 h post-P0-1
  window shows zero new DLQ arrivals from the verified path.
- Dependency: hardening build's `dlq-sweep` endpoint (do not build
  a second DLQ reader — reuse it).

**P0-5. Minimum viable monitoring and alerting**
- Fix shape — three concrete pieces, no vague "add monitoring":
  1. **`GET /api/health`** (public, no auth): returns
     `{ status, listed, candidates, unembedded, enrichmentRows,
       dlqDepth, lastCronAt, lastQueueTerminalAt, vectorOk,
       dbSizeBytes }` — every value from a bounded query (counts
     only; the candidate/terminal timestamps come from a new
     `ops_state` row the consumer and cron update on each run).
  2. **External uptime check**: a 5-minute interval check of
     `https://talents.sh/api/health` from an external checker
     (UptimeRobot free tier or the Cloudflare dashboard's own
     uptime monitor — pick one, record the choice) alerting the
     user's email on 2 consecutive failures.
  3. **Worker error alert**: Cloudflare dashboard alert "Workers
     error rate > 1% over 5 min" on the `talents` Worker, routed
     to the same email. Plus three threshold checks evaluated by
     the daily cron and logged to the health state: DLQ depth > 0
     for > 1 h; no terminal queue transition in 2 h while
     candidates > 0; home or search error rate > 0 in the last
     hour (counted from a new `ops_events` table the error handler
     writes to, capped at 1,000 rows).
- Files: `cf/src/index.ts` (`/api/health` + error-handler event
  writes), migration 0007 (`ops_state`, `ops_events`), a new
  `docs/ops-alerts.md` (the check, the threshold, the channel,
  the owner — the user — for each alert).
- Gate: each alert is *fired on purpose once* — (a) the health
  endpoint returns the full payload live; (b) a staged failure
  (stop the producer for 2 h, or force a 500 in a test deploy to
  a staging Worker once P1-8 exists) triggers the alert within
  its window; (c) the alert email is received. Until (b) is run,
  the alerts are unproven — record that in the gate file.
- Dependency: P0-4 for the DLQ signal; P1-8 (staging) for the
  safest staged-failure drill — the uptime check and the
  dashboard error alert can land before staging exists.

### P1 — breaks at ~2x catalog (~45k records) or ~2x collection sizes

**P1-1. Per-message subrequest budget for large collections**
- Fix shape: cap the records a single queue message ingests
  (measure the budget: ~3 statements/record + ~2 embed
  statements/record + ~10 overhead → a 200-record cap keeps a
  message under ~1,000 subrequests with margin; set the cap at
  150 records and re-enqueue the remainder as a continuation
  message with the same source id and a `part` marker). Add a
  strict test harness that counts D1 statements per message for
  a synthetic 300-skill collection.
- Files: `cf/src/discovery.ts` (candidate-mode consumer),
  `src/discovery/pipeline.ts` (`ingestSource` split),
  `test/queuedrain.test.ts` (new cases).
- Gate: a 300-skill fixture collection ingests completely with no
  single message exceeding 800 counted D1 statements; total
  ingest time for that collection is < 2x the single-message time.
- Dependency: hardening build's consumer freeze (coordinate;
  lands after it, or inside it if the builder takes it).

**P1-2. Replace `vectorIdMap()` full-table load with an id lookup**
- Fix shape: `translateVectorHits` queries
  `SELECT vector_id, record_id FROM embedding_meta WHERE
  vector_id IN (…≤30 ids)` instead of loading all 21,099 rows
  and mapping in JS. Keep `vectorIdMap()` for batch jobs only
  (embed sweep), and rename it to say so.
- Files: `src/discovery/store.ts`, `cf/src/discovery.ts`
  (`translateVectorHits`), `test/`.
- Gate: a vector search performs ≤ 3 D1 queries for the
  translation step at any catalog size (test with a synthetic
  100k-row `embedding_meta`); search latency unchanged at
  current scale.
- Dependency: none.

**P1-3. Filter the list refresh in SQL, not in JS**
- Fix shape: `refreshAllLists` queries `SELECT … FROM sources
  WHERE kind = 'list' ORDER BY last_seen LIMIT 10` instead of
  `listSources()` + JS filter. Add a `listSourcesByKind` store
  method (or a `listLists` query) used by the Monday cron path.
- Files: `src/discovery/lists.ts`, `src/discovery/store.ts`.
- Gate: the Monday refresh reads ≤ 50 rows from D1 (verified by
  the strict harness); the 5 known lists still refresh.
- Dependency: none.

**P1-4. Paginate owner record loads (profile + dashboard listings)**
- Fix shape: `recordsByOwner` / `listingsForOwner` take
  `{limit: 500, cursor}` (keyset on `id`); the profile page
  renders the first 500 with a "show more" link, the creator
  dashboard lists paginate the same way.
- Files: `cf/src/db.ts`, `cf/src/creator.ts`, `src/render.ts`.
- Gate: the nvidia profile (510 records) loads in 2 pages with no
  single response over 3 MB; a synthetic 5,000-record owner
  stays under 10 MB per page.
- Dependency: none.

**P1-5. Byte-aware cap on the FTS candidate pass**
- Fix shape: lower `FTS_SQL` `LIMIT 500` to `LIMIT 200` and add a
  byte-budget guard in `searchDetailed` — if the returned
  `record_json` payload exceeds 20 MB, re-run with `LIMIT 100`.
  (The 500-row pass exists for ranking breadth; 200 preserves
  it for every realistic query — the widest real token today
  matches far fewer than 200.)
- Files: `src/search-d1.ts`, `test/`.
- Gate: a token matching 500 max-size synthetic records returns
  ≤ 20 MB; the five gate queries' top-5 results are unchanged.
- Dependency: none.

**P1-6. GitHub budget governor (producer + consumer)**
- Fix shape: a budget ledger in D1 (`ops_state` row:
  `gh_calls_this_hour`, reset hourly by the cron) — the consumer
  records its api.github.com calls per message; the producer
  pauses enqueueing when the hour's usage passes 80% of 5,000
  (4,000); the consumer honours `Retry-After` and a
  budget-exhausted-until timestamp (the hardening build's
  backpressure piece — build on it, don't duplicate it).
- Files: `cf/src/discovery.ts` (consumer + producer), `src/d1-limits.ts`
  (budget constants).
- Gate: a 1,000-candidate burst never exceeds 4,800 core calls in
  any rolling hour (measured from the ledger); a forced 403
  pauses the producer for the `Retry-After` window and resumes
  after.
- Dependency: hardening build's rate-limit backpressure (P0-4's
  sibling) — sequence after it lands.

**P1-7. Embed sweep budget matched to ingest pace + an unembedded gauge**
- Fix shape: raise the daily cron embed budget from 100 to 1,000
  records/invocation (the paged sweep already exists) and add
  `unembedded` to `/api/health` (P0-5); if unembedded > 5% of
  listed for > 24 h, the cron logs a warning the health check
  surfaces.
- Files: `cf/src/discovery.ts` (`embedCatalogBounded` call site),
  `cf/src/index.ts` (health).
- Gate: after a 5,000-record ingest day, unembedded listed is
  < 1% within 24 h.
- Dependency: P0-5 (health endpoint).

**P1-8. Staging Worker + deploy gate + documented rollback**
- Fix shape: a `talents-staging` Worker (separate wrangler config
  `cf/wrangler.staging.jsonc`, its own D1 `talents-staging` seeded
  from a 1,000-record export of production, its own Vectorize
  index, no custom domains); deploy script
  `cf/scripts/deploy_staging.py` (deploy to staging → run the
  smoke suite against it → promote the same version to production
  via `wrangler deploy --env production`); `docs/deploy.md`
  documenting `wrangler rollback` (code) vs Time Travel restore
  (data) and the migration rule (additive-only, never destructive
  in the same deploy as the code that depends on it).
- Files: `cf/wrangler.staging.jsonc`, `cf/scripts/deploy_staging.py`,
  `docs/deploy.md`, smoke suite (reuse the gate's live checks).
- Gate: one full staging → production promotion where a
  deliberately broken build is caught in staging and never reaches
  production; one `wrangler rollback` drill on staging.
- Dependency: none, but it is the safest place to run P0-5's
  staged-failure drill.

### P2 — breaks at ~10x catalog (~224k records) or is structural

**P2-1. D1 10 GB ceiling plan (design only — no migration yet)**
- At the backfill pace (~160 MB/day at 15,325 records/day) the
  ceiling is ~2 months out; at steady scout pace (~0.5–2 MB/day)
  it is ~13+ years out. The backlog adds only ~210 MB. The
  ceiling is not a near-term constraint — but the per-query and
  per-invocation limits are, and they are already addressed above.
- Fix shape: a design doc `docs/d1-sharding.md` (shard key:
  owner-hash into N databases, with a router interface in code)
  and the router seam implemented with a single-database
  implementation (no behaviour change). Revisit when the DB file
  passes 2 GB or any single-query pattern cannot be bounded.
- Gate: design doc written and reviewed; router interface in the
  codebase with the single-DB implementation passing the full
  test suite.
- Dependency: none.

**P2-2. Registry key backup + rotation procedure**
- Fix shape: an encrypted backup of `registry-key.json` to R2
  (separate `talents-secrets` bucket, access-logged) + a rotation
  procedure (new key → re-attest the catalog in a paged job
  reusing the ingest attestation path → old key revoked after a
  30-day overlap) + a re-attestation job (`POST /admin/reattest
  {limit, cursor}`) tested on 100 records.
- Gate: backup exists and restores to a working key; the
  re-attestation job completes 100 records with byte-identical
  declarations and new valid signatures; the rotation procedure
  is documented in `docs/registry-key.md`.
- Dependency: P0-3 (the backup bucket/runbook pattern).

**P2-3. Secrets rotation schedule + close the webhook hole**
- Fix shape: set `WEBHOOK_SECRET` (Worker secret) and verify the
  webhook route rejects unsigned pushes (live test: unsigned
  POST → 401); a rotation runbook `docs/secrets.md` naming each
  secret, its owner, and its rotation interval (GITHUB_TOKEN
  90 days, Anthropic 90 days, ADMIN_TOKEN per gate + quarterly,
  Clerk on live-key swap); rotate the chat-transited Anthropic
  key now (outstanding since 2026-11-10).
- Gate: unsigned webhook POST returns 401 live; `docs/secrets.md`
  exists with dates; the Anthropic key rotation is done or the
  user has explicitly deferred it in writing.
- Dependency: user (Clerk live keys, Anthropic rotation choice).

**P2-4. Enrichment cost control at scale**
- Fix shape: a cost budget on the enrich driver
  (`--max-usd` flag + a D1 `enrichment_budget` row the Worker
  checks per record) that stops a run cleanly at the cap, and a
  coverage target written into ENRICHMENT.md (100% of the top-500
  traffic records, then breadth by verification priority). At
  10x, a full D pass is ~$2,190–$2,570 — the budget makes that a
  decision, not a surprise.
- Gate: an enrich run with a $1 cap stops after ≤ $1.10 of usage
  with a clean "budget exhausted" status and no partial-layer
  writes.
- Dependency: none.

**P2-5. Search quality at 10x (regression suite + escape-hatch check)**
- Fix shape: a search-quality regression suite (the five gate
  queries + latency budget p95 < 5 s) run against a synthetic
  10x catalog in a scratch D1; re-evaluate the Typesense escape
  hatch (documented behind the search interface) only if the
  suite fails on latency or recall.
- Gate: suite green at 10x synthetic scale, or a written decision
  to build the Typesense adapter.
- Dependency: P1-8 (staging/scratch D1 to run it in).

**P2-6. Document the acceptable losses**
- The advisor Durable Object state (session-scoped) and the
  sandbox drain's local progress file are acceptable losses —
  write that down in `docs/durability.md` so a future incident
  doesn't trigger a hunt for a backup that was never intended.
- Gate: `docs/durability.md` exists, listing every store, its
  backup, and its recovery point objective (D1: 30 days via Time
  Travel + nightly export after P0-3; R2 assets: versioned
  bucket, no backup needed; Vectorize: rebuildable from D1
  `embedding_meta` + the embed sweep; registry key: P2-2).

**P2-7. Cutover: retire the sandbox drain + watchdog**
- The slice is done (500/500 in 26 min, 2.9x the throughput bar),
  so the cutover decision is the main session's, not this plan's.
  The plan's conditions for a safe cutover: P0-1 landed (the
  verified path stops DLQing), P1-1 landed (big collections can't
  kill a message), and the hardening build's producer is running
  for 24 h with DLQ depth at 0. Then: stop the drain, remove the
  watchdog cron, and keep `data/backfill-drain-progress.json` as
  a historical checkpoint.
- Gate: 24 h of queue-only operation with DLQ 0 and the candidate
  count falling at ≥ 300/hr.
- Dependency: P0-1, P1-1, hardening build.

## 4. What NOT to do

- **Do not shard D1 now.** The 10 GB ceiling is ~2 months away at
  a pace that will not be sustained (the backlog is finite), and
  the per-query limits are the real constraint — they are fixed by
  bounding reads, not by sharding.
- **Do not add a second database or a KV cache for hot paths.**
  Every hot path is bounded by P0–P1; a cache would add a
  consistency problem (attestations, unlist/relist) for a latency
  gain nobody has measured a need for.
- **Do not build a custom monitoring stack.** The Cloudflare
  dashboard alerts + one external uptime check + one health
  endpoint cover the failure modes that exist; a Sentry/Logpush
  rollout is a P2 convenience, not a P0 gap.
- **Do not re-derive or re-filter the catalog for performance.**
  Staging is the authoritative dataset; the explorer must keep
  re-syncing from it (standing rule, 2026-11-11).

## 5. Sequence summary

| Order | Item | Breaks when | Depends on |
|---|---|---|---|
| 1 | P0-1 incremental stats | **now** | hardening build's consumer freeze |
| 2 | P0-2 aggregate → R2 | 2x catalog | — |
| 3 | P0-3 nightly D1 export + drill | day 31 (Time Travel window) | — |
| 4 | P0-4 DLQ visibility | now | hardening `dlq-sweep` |
| 5 | P0-5 health + alerts | now | P0-4 (DLQ signal) |
| 6 | P1-1 per-message budget | ~250-skill collections | hardening consumer freeze |
| 7 | P1-2 vectorIdMap lookup | 10x catalog | — |
| 8 | P1-3 list refresh in SQL | ~5x sources | — |
| 9 | P1-4 owner pagination | ~10x owner size | — |
| 10 | P1-5 FTS byte cap | ~1.6x max-record growth | — |
| 11 | P1-6 GitHub governor | sustained slice pace | hardening backpressure |
| 12 | P1-7 embed budget + gauge | now (1,308 unembedded) | P0-5 |
| 13 | P1-8 staging + deploy gate | next bad deploy | — |
| 14 | P2-1 sharding design | 2 GB DB file | — |
| 15 | P2-2 key backup + rotation | key loss/leak | P0-3 |
| 16 | P2-3 secrets rotation + webhook | now (webhook open) | user (keys) |
| 17 | P2-4 enrichment cost budget | 10x catalog | — |
| 18 | P2-5 search quality at 10x | 10x catalog | P1-8 |
| 19 | P2-6 acceptable-losses doc | — | — |
| 20 | P2-7 drain cutover | after P0-1 + P1-1 + 24 h clean | P0-1, P1-1, hardening |

## Appendix — numbers that did not make the plan (for the record)

- Worker versions: v59 live at 2026-11-12T01:47:55Z (d1size fix);
  v57 auth swap 01:29:59Z; 59 versions in ~2 days, all straight
  to production.
- R2 `talents-assets`: 977 objects at the tranche-1 gate
  (2026-11-11); exact live count not obtainable in-audit (the `cf`
  CLI truncates API responses at 6,000 chars; this wrangler has no
  `r2 object list`). Objects are ~122–192 KB icons + READMEs; R2
  is not a bottleneck. At full enrichment coverage (~22k records)
  the bucket would hold ~22k objects ≈ 4 GB — fine.
- D1 rows-read pricing (paid): 25B rows read/month included.
  The aggregate reads 22,407 rows/call — pricing is not the
  constraint; latency and memory are.
- The queue slice's 1,154/hr pace vs the gate's 400/hr target:
  the consumer can outrun the GitHub token budget at sustained
  slice pace (P1-6), which is why the producer must be
  budget-aware rather than merely fast.
- Time Travel (D1, paid): 30-day window, always on, in-place
  whole-DB restore, 10 restores per 10 min, no clone/fork.
  `wrangler d1 export` exists for portable snapshots.
- No `dbstat` in D1, so the FTS index size (~146 MB) is an
  estimate by subtraction, not a measurement.
