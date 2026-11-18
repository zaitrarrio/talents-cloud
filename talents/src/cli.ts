#!/usr/bin/env node
// talents CLI (P0)
//   talents ingest <owner/repo | https://…marketplace.json> [--limit N] [--ref R] [--out data/registry.json] [--summary data/gate-x.json]
//   talents ingest-repo <owner/repo> [--ref R] [--out data/registry.json] [--summary data/gate-x.json]
//   talents show <owner/name> [--from data/registry.json]
//   talents claim <owner> [--token-env GITHUB_TOKEN] [--store data/namespaces.json]
//   talents index [--from data/registry.json]           (P1: build the search index)
//   talents search <query> [--kind K] [--owner O] [--limit N] [--from F]
//   talents serve [--port 4317] [--from data/registry.json]  (P1: SSR pages)
// `ingest` on an owner/repo with no marketplace.json falls back to a
// standalone repo scan (ingest-repo) — skills need no marketplace or plugin.
// Tokens are read from the environment only, never from arguments, never logged.
// Search talks to Typesense at TALENTS_TYPESENSE_URL (default
// http://127.0.0.1:8108) with TALENTS_TYPESENSE_KEY (labelled dev default).

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ingestGithubRepo, ingestMarketplaceUrl } from "./ingest.js";
import { scanGithubRepoSkills } from "./repo-scan.js";
import type { IngestSummary, SkillRecord } from "./types.js";
import { RegistryStore } from "./records.js";
import { loadOrCreateRegistryKey } from "./attest.js";
import { NamespaceStore, verifyGithubOwnership } from "./namespace.js";
import {
  LocalSearchEngine, ensureIndexed, openSearchEngine, typesenseConfigFromEnv,
  type SearchEngine,
} from "./search.js";
import { createWebServer, depsFromRecords } from "./web.js";
import { buildAggregatedMarketplace, externalSourceViolations } from "./aggregate.js";
import { runDiscoveryCycle } from "./discovery/pipeline.js";
import {
  classifyAsList, isNoSkillFilesReason, refreshAllLists,
  type ListMineStats,
} from "./discovery/lists.js";
import { D1DiscoveryStore, type SourceRow } from "./discovery/store.js";
import { WranglerD1 } from "./discovery/wrangler-d1.js";
import { Pacer } from "./discovery/sweep.js";
import { defaultFetch } from "./ingest.js";
import { runScoutNominations } from "./discovery/scouts/runner.js";
import { ghapiBackedFetch } from "./discovery/scouts/ghapi-fetch.js";
import { githubCodeScout } from "./discovery/scouts/github-code.js";
import { mcpRegistryScout } from "./discovery/scouts/mcp-registry.js";
import { npmScout } from "./discovery/scouts/npm.js";
import { skillsShScout } from "./discovery/scouts/skills-sh.js";
import { webSearchScout } from "./discovery/scouts/web.js";
import { xScout } from "./discovery/scouts/x.js";
import type { Scout, ScoutContext } from "./discovery/scouts/types.js";
import { readFileSync } from "node:fs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DATA = resolve(ROOT, "data");
const KEY_FILE = resolve(DATA, "registry-key.json");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Shared tail of ingest / ingest-repo: persist records + dead letters, report, write the summary file. */
function finishIngest(summary: IngestSummary, out: string, summaryPath?: string): void {
  const store = new RegistryStore(out);
  for (const r of summary.records) store.upsert(r);
  store.addDeadLetters(summary.deadLetters);
  store.save();

  console.log(`target:        ${summary.target}`);
  console.log(`marketplace:   ${summary.marketplaceName ?? "(unknown)"}`);
  console.log(`entries seen:  ${summary.total}`);
  console.log(`ingested ok:   ${summary.ok}`);
  console.log(`dead-letter:   ${summary.deadLetter}`);
  if (summary.note) console.log(`note:          ${summary.note}`);
  for (const d of summary.deadLetters.slice(0, 10)) console.log(`  ✗ ${d.entryName}: ${d.reason}`);
  console.log(`registry file: ${out} (${store.all().length} total records)`);

  if (summaryPath) {
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, JSON.stringify({
      target: summary.target,
      marketplaceName: summary.marketplaceName,
      fetchedAt: summary.fetchedAt,
      total: summary.total,
      ok: summary.ok,
      deadLetter: summary.deadLetter,
      note: summary.note ?? null,
      sampleRecords: summary.records.slice(0, 5).map((r) => ({
        id: r.id, url: r.url, kind: r.kind, sourceType: r.sourceType, pointerOnly: r.pointerOnly,
        ref: r.ref, filesHashed: r.filesHashed,
        declarationSummary: r.declaration.summary,
        attestationHash: r.attestation?.contentHash ?? null,
      })),
      deadLetters: summary.deadLetters.map((d) => ({ entryName: d.entryName, reason: d.reason })),
    }, null, 2));
    console.log(`summary file:  ${summaryPath}`);
  }
}

async function cmdIngest(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) throw new Error("usage: talents ingest <owner/repo | marketplace-json-url>");
  const limit = flag(args, "--limit") ? Number(flag(args, "--limit")) : undefined;
  const ref = flag(args, "--ref");
  const out = resolve(ROOT, flag(args, "--out") ?? "data/registry.json");
  const summaryPath = flag(args, "--summary") ? resolve(ROOT, flag(args, "--summary")!) : undefined;

  const key = loadOrCreateRegistryKey(KEY_FILE);
  let summary = /^https?:\/\//.test(target)
    ? await ingestMarketplaceUrl(target, { registryKey: key, limit, ref })
    : await ingestGithubRepo(target, { registryKey: key, limit, ref });

  // No marketplace.json in this repo ≠ no skills: fall back to a standalone
  // repo scan (SKILL.md directories need no marketplace and no plugin.json).
  if (!/^https?:\/\//.test(target) && summary.total === 0 && summary.note?.startsWith("marketplace.json not found")) {
    console.log(`no marketplace.json at ${target} — falling back to a standalone repo scan (SKILL.md directories)`);
    summary = await scanGithubRepoSkills(target, { registryKey: key, limit, ref });
  }

  finishIngest(summary, out, summaryPath);
}

async function cmdIngestRepo(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) throw new Error("usage: talents ingest-repo <owner/repo>");
  const limit = flag(args, "--limit") ? Number(flag(args, "--limit")) : undefined;
  const ref = flag(args, "--ref");
  const out = resolve(ROOT, flag(args, "--out") ?? "data/registry.json");
  const summaryPath = flag(args, "--summary") ? resolve(ROOT, flag(args, "--summary")!) : undefined;

  const key = loadOrCreateRegistryKey(KEY_FILE);
  const summary = await scanGithubRepoSkills(target, { registryKey: key, limit, ref });
  finishIngest(summary, out, summaryPath);
}

function cmdShow(args: string[]): void {
  const id = args[0]?.toLowerCase();
  if (!id) throw new Error("usage: talents show <owner/name>");
  const from = resolve(ROOT, flag(args, "--from") ?? "data/registry.json");
  const store = new RegistryStore(from);
  const r = store.get(id);
  if (!r) {
    console.log(`not found: ${id}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${r.id}  →  ${r.url}`);
  console.log(`kind: ${r.kind} · source: ${r.sourceType}${r.sourceRepo ? ` ${r.sourceRepo}` : ""}${r.sourcePath ? `/${r.sourcePath}` : ""} @ ${r.ref}${r.pointerOnly ? " · pointer-only" : ""}`);
  console.log(`description: ${r.description}`);
  console.log(`validation: ${r.validation.ok ? "ok" : "FAILED"}${r.validation.issues.length ? " — " + r.validation.issues.map((i) => `[${i.severity}] ${i.message}`).join("; ") : ""}`);
  console.log(`declaration (derived from ${r.declaration.derivedFrom.join(", ")}):`);
  for (const s of r.declaration.summary) console.log(`  - ${s}`);
  for (const u of r.declaration.undeclared) console.log(`  - Undeclared: ${u}`);
  if (r.attestation) {
    console.log(`attestation: ed25519 · content hash ${r.attestation.contentHash.slice(0, 16)}… · signed ${r.attestation.signedAt}`);
    console.log(`  verify with: re-ingest ${r.sourceMarketplace} and compare hashes (P0: attestation re-computed at ingest; tamper = hash mismatch)`);
    console.log(`  files hashed: ${r.filesHashed.join(", ") || "(marketplace entry only)"}`);
  } else {
    console.log("attestation: none");
  }
}

async function cmdClaim(args: string[]): Promise<void> {
  const owner = args[0];
  if (!owner) throw new Error("usage: talents claim <owner>");
  const storePath = resolve(ROOT, flag(args, "--store") ?? "data/namespaces.json");
  const tokenEnv = flag(args, "--token-env") ?? "GITHUB_TOKEN";
  const token = process.env[tokenEnv] ?? "";
  const store = new NamespaceStore(storePath);
  // Proof check is injectable in the library API; the CLI wires the real one.
  const proof = await verifyGithubOwnership(owner, token);
  if (!proof.ok) {
    console.log(`claim refused for ${owner}: ${proof.reason}`);
    console.log(`(set ${tokenEnv} in the environment to a GitHub token for the owner/org admin)`);
    process.exitCode = 1;
    return;
  }
  const claim = store.claim(owner, proof.githubLogin, true);
  console.log(`claimed: ${claim.owner} by ${claim.claimedBy} (via ${proof.via}) at ${claim.claimedAt} → https://talents.sh/${claim.owner}`);
}

// ---------------------------------------------------------------------------
// P1: search + serve
// ---------------------------------------------------------------------------

/** Records for search/serve: --from F loads exactly that file; otherwise the
 *  P0 registry plus the standalone-scan fallback registry, merged (the main
 *  registry wins on id conflicts). */
function loadRecords(args: string[]): SkillRecord[] {
  const from = flag(args, "--from");
  const files = from
    ? [resolve(ROOT, from)]
    : [resolve(DATA, "registry.json"), resolve(DATA, "fallback-registry.json")].filter((f) => existsSync(f));
  const byId = new Map<string, SkillRecord>();
  for (const f of files) {
    for (const r of new RegistryStore(f).all()) if (!byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** Pick the search engine: real Typesense when it answers; the local
 *  fallback otherwise — and SAY SO on stdout, never silently. If Typesense
 *  is up but indexing fails (e.g. wrong key), fall back loudly too. */
async function buildSearch(records: SkillRecord[], forceIndex: boolean): Promise<SearchEngine> {
  const cfg = typesenseConfigFromEnv();
  const engine = await openSearchEngine(records, cfg);
  if (engine.name === "local") {
    console.log(`search engine: LOCAL fallback (no Typesense answered health at ${cfg.url})`);
    const n = await engine.indexAll(records);
    console.log(`search index:  ${n} documents (local)`);
    return engine;
  }
  try {
    const n = forceIndex ? await engine.indexAll(records) : await ensureIndexed(engine, records);
    console.log(`search engine: typesense at ${cfg.url}`);
    console.log(`search index:  ${n} documents`);
    return engine;
  } catch (e) {
    console.log(`search engine: Typesense at ${cfg.url} answered health but indexing failed (${(e as Error).message}) — LOCAL fallback`);
    const local = new LocalSearchEngine();
    const n = await local.indexAll(records);
    console.log(`search index:  ${n} documents (local)`);
    return local;
  }
}

async function cmdIndex(args: string[]): Promise<void> {
  const records = loadRecords(args);
  console.log(`records:       ${records.length}`);
  await buildSearch(records, true);
}

async function cmdSearch(args: string[]): Promise<void> {
  // Positional words = everything not consumed as a flag value.
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    positional.push(args[i]);
  }
  const q = positional.join(" ");
  const records = loadRecords(args);
  const engine = await buildSearch(records, false);
  const results = await engine.search({
    q,
    kind: flag(args, "--kind"),
    owner: flag(args, "--owner"),
    limit: flag(args, "--limit") ? Number(flag(args, "--limit")) : undefined,
  });
  console.log(`query:         ${JSON.stringify(q)}${flag(args, "--kind") ? ` kind=${flag(args, "--kind")}` : ""}${flag(args, "--owner") ? ` owner=${flag(args, "--owner")}` : ""}`);
  console.log(`results:       ${results.length}`);
  for (const [i, r] of results.entries()) {
    console.log(`  ${i + 1}. ${r.id} [${r.kind}]${r.attestation ? " ✓ attested" : ""} — ${(r.description ?? "").slice(0, 90)}`);
  }
}

async function cmdServe(args: string[]): Promise<void> {
  const port = Number(flag(args, "--port") ?? process.env.PORT ?? 4317);
  const records = loadRecords(args);
  const engine = await buildSearch(records, false);
  const deps = depsFromRecords(records, (input) => engine.search(input));
  const server = createWebServer(deps);
  await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));
  console.log(`records:       ${records.length}`);
  console.log(`talents.sh P1 SSR → http://127.0.0.1:${port}  (routes: / · /skills/{owner}/{name} · /{owner} · /search · /s/{owner}/{name})`);
}

function cmdAggregate(args: string[]): void {
  const out = resolve(ROOT, flag(args, "--out") ?? "data/aggregated-marketplace.json");
  const records = loadRecords(args);
  const result = buildAggregatedMarketplace(records);
  const violations = externalSourceViolations(result.doc);
  const errors = result.issues.filter((i) => i.severity === "error");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result.doc, null, 2));
  console.log(`records:       ${records.length} (${records.filter((r) => r.status === "listed").length} listed)`);
  console.log(`entries:       ${result.entryCount}`);
  for (const s of result.skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
  console.log(`validation:    ${errors.length} error(s), ${result.issues.length - errors.length} warning(s) (own validate mirror)`);
  for (const e of errors.slice(0, 10)) console.log(`  ✗ [${e.code}] ${e.message}`);
  console.log(`origin check:  ${violations.length} entr${violations.length === 1 ? "y" : "ies"} pointing at a Talents origin or unresolved`);
  for (const v of violations.slice(0, 10)) console.log(`  ✗ ${v}`);
  console.log(`written:       ${out}`);
  if (errors.length || violations.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// P5: discovery — one sweep + verify + ingest cycle against D1.
// Same code path as the Worker cron + queue consumer, minus the Queue
// transport: verified sources are ingested inline. Default target is
// the LOCAL Miniflare D1 (cf/wrangler.jsonc, talents-dev — run
// `npm run seed` in cf/ once so migrations exist); --remote targets
// the production D1 (needs CLOUDFLARE_API_TOKEN in the environment —
// wrangler reads it; it is never an argument and never logged).
// New records are ALSO mirrored into the registry file so the cf
// seed step stays lossless.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 2: scouts — `talents discover <codesearch|mcp|npm|skillssh|web|x>`.
// Every scout only NOMINATES into the same sources table the sweep
// uses (one funnel: nomination → verification → ingest →
// attestation); the runner applies dedup + corroboration and walks
// the priority queue. Same --remote semantics as the sweep cycle.
// ---------------------------------------------------------------------------

const SCOUT_SUBCOMMANDS: Record<string, { scout: Scout; pacerMs: number }> = {
  codesearch: { scout: githubCodeScout, pacerMs: 2500 },
  mcp: { scout: mcpRegistryScout, pacerMs: 300 },
  npm: { scout: npmScout, pacerMs: 300 },
  skillssh: { scout: skillsShScout, pacerMs: 500 },
  web: { scout: webSearchScout, pacerMs: 1000 },
  x: { scout: xScout, pacerMs: 0 },
};

async function cmdDiscoverScout(sub: string, args: string[]): Promise<void> {
  const remote = args.includes("--remote");
  const out = resolve(ROOT, flag(args, "--out") ?? "data/registry.json");
  const cfDir = resolve(ROOT, "cf");
  const d1 = new WranglerD1({
    cwd: cfDir,
    config: remote ? "wrangler.deploy.jsonc" : "wrangler.jsonc",
    database: remote ? "talents" : "talents-dev",
    remote,
  });
  const store = new D1DiscoveryStore(d1);
  const key = loadOrCreateRegistryKey(KEY_FILE);
  const mirror = new RegistryStore(out);
  const { scout, pacerMs } = SCOUT_SUBCOMMANDS[sub];
  const pacer = new Pacer(pacerMs);
  // All scout traffic to api.github.com goes through the
  // ghapi-backed fetch in the sandbox: code search REQUIRES auth,
  // and repo verification unauthenticated would burn the 60/hr
  // anonymous budget and falsely reject repos on 403s. The token
  // never enters this process (see scouts/ghapi-fetch.ts); other
  // hosts pass through untouched. GITHUB_TOKEN env, when set, is
  // used by the wrapped fetch directly.
  const fetchFn = ghapiBackedFetch(defaultFetch);

  const opts: Record<string, unknown> = {};
  if (flag(args, "--cap")) opts.cap = Number(flag(args, "--cap"));
  if (sub === "codesearch" && opts.cap) opts.maxRepos = opts.cap;
  if (flag(args, "--size")) opts.size = Number(flag(args, "--size"));
  if (flag(args, "--pages")) opts.pages = Number(flag(args, "--pages"));
  if (flag(args, "--since")) opts.since = flag(args, "--since");
  if (flag(args, "--posts")) {
    const raw = JSON.parse(readFileSync(flag(args, "--posts")!, "utf8")) as unknown;
    opts.posts = Array.isArray(raw) ? raw : (raw as { posts?: unknown[] }).posts;
  }

  const ctx: ScoutContext = {
    fetchFn,
    pacer,
    now: () => new Date(),
    getSyncState: (k) => store.getSyncState(k),
    setSyncState: (k, v) => store.setSyncState(k, v),
  };
  const result = await scout.run(ctx, opts);
  const funnel = await runScoutNominations(
    {
      store, registryKey: key, fetchFn, pacer,
      onNewRecords: async (records) => {
        for (const r of records) mirror.upsert(r);
        mirror.save();
      },
    },
    scout.name,
    result,
    {
      maxIngest: flag(args, "--max-ingest") ? Number(flag(args, "--max-ingest")) : 5,
      maxVerify: flag(args, "--max-verify") ? Number(flag(args, "--max-verify")) : 25,
    },
  );
  await d1.flush();
  console.log(JSON.stringify({
    target: remote ? "remote D1 (talents)" : "local D1 (talents-dev)",
    scout: scout.name,
    run: result.stats,
    funnel,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// List sources: `talents discover lists` — the operator entry point
// for curated-list handling.
//   (default)        scan sources REJECTED with the no-skill-files
//                    reason and run list classification over them
//                    (travisvn/awesome-claude-skills is the proof
//                    case): link-dense ones become mined list
//                    sources; the rest stay plain rejections.
//   --mine <o/r>     explicit nomination: flag a repo as a list and
//                    classify + mine it now (repeatable). If the
//                    repo turns out to carry skills, the claim is
//                    discarded and it verifies normally — records
//                    win.
//   --refresh        re-mine every known list (idempotent; list
//                    removals are ignored by design).
// Lists never produce records: mining only NOMINATES candidates
// into the funnel with {via:"list", list, section} provenance.
// ---------------------------------------------------------------------------

async function cmdDiscoverLists(args: string[]): Promise<void> {
  const remote = args.includes("--remote");
  const cfDir = resolve(ROOT, "cf");
  const d1 = new WranglerD1({
    cwd: cfDir,
    config: remote ? "wrangler.deploy.jsonc" : "wrangler.jsonc",
    database: remote ? "talents" : "talents-dev",
    remote,
  });
  const store = new D1DiscoveryStore(d1);
  const fetchFn = ghapiBackedFetch(defaultFetch);
  const pacer = new Pacer(1000);
  const deps = { store, fetchFn, pacer };
  const at = new Date().toISOString();
  const limit = flag(args, "--limit") ? Number(flag(args, "--limit")) : 25;
  const mines: ListMineStats[] = [];
  let classified = 0;
  let notLists = 0;

  const mineFlags: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--mine" && args[i + 1]) mineFlags.push(args[i + 1].toLowerCase());

  if (args.includes("--refresh")) {
    const out = await refreshAllLists(deps, { limit: flag(args, "--limit") ? Number(flag(args, "--limit")) : 10 });
    console.log(`refreshed ${out.refreshed} list(s); graduated: ${out.graduated.join(", ") || "none"}`);
    for (const m of out.mines) {
      mines.push(m);
      console.log(`  ${m.list}: ${m.repoLocators} repo links, ${m.nominated} nominated (${m.created} new, ${m.corroborated} corroborated)`);
    }
  }

  for (const locator of mineFlags) {
    let row = await store.getSourceByLocator(locator);
    if (!row) {
      row = {
        kind: "list",
        locator,
        url: `https://github.com/${locator}`,
        discoveredVia: "manual:list",
        status: "candidate",
        reason: "operator list nomination — unverified claim",
        firstSeen: at, lastSeen: at, lastIngested: null, recordCount: 0,
        provenance: [{ via: "manual", at, note: "operator nominated this repo as a curated list" }],
        priority: 0,
      } satisfies SourceRow;
      await store.upsertSource(row);
    }
    const outcome = await classifyAsList(deps, row);
    if (outcome.isList) {
      classified++;
      if (outcome.mine) mines.push(outcome.mine);
      console.log(`  ✓ ${locator}: LIST — ${outcome.mine ? `${outcome.mine.repoLocators} repo links, ${outcome.mine.nominated} nominated (${outcome.mine.created} new, ${outcome.mine.corroborated} corroborated)` : outcome.reason}`);
    } else {
      notLists++;
      console.log(`  ✗ ${locator}: not a list — ${outcome.reason}`);
    }
  }

  if (!args.includes("--refresh") && mineFlags.length === 0) {
    const rejected = (await store.listSources("rejected"))
      .filter((r) => r.kind !== "list" && isNoSkillFilesReason(r.reason))
      .slice(0, limit);
    console.log(`scanning ${rejected.length} no-skill-files rejection(s) for list shape…`);
    for (const row of rejected) {
      const outcome = await classifyAsList(deps, row);
      if (outcome.isList) {
        classified++;
        if (outcome.mine) mines.push(outcome.mine);
        console.log(`  ✓ ${row.locator}: LIST — ${outcome.mine ? `${outcome.mine.repoLocators} repo links, ${outcome.mine.nominated} nominated (${outcome.mine.created} new, ${outcome.mine.corroborated} corroborated)` : outcome.reason}`);
      } else {
        notLists++;
        console.log(`  ✗ ${row.locator}: stays rejected — ${outcome.reason}`);
      }
    }
  }

  const totals = mines.reduce(
    (a, m) => ({
      nominated: a.nominated + m.nominated,
      created: a.created + m.created,
      corroborated: a.corroborated + m.corroborated,
    }),
    { nominated: 0, created: 0, corroborated: 0 },
  );
  await store.recordScoutRun("lists", at, new Date().toISOString(), {
    classified, notLists, listsMined: mines.length, ...totals,
  });
  await d1.flush();
  console.log(JSON.stringify({
    target: remote ? "remote D1 (talents)" : "local D1 (talents-dev)",
    classified, notLists, listsMined: mines.length, ...totals,
    sourcesByStatus: await store.countSourcesByStatus(),
  }, null, 2));
}

async function cmdDiscover(args: string[]): Promise<void> {
  if (args[0] === "lists") return cmdDiscoverLists(args.slice(1));
  if (args[0] && args[0] in SCOUT_SUBCOMMANDS) return cmdDiscoverScout(args[0], args.slice(1));
  if (args[0] && !args[0].startsWith("--")) {
    throw new Error(`unknown discover subcommand: ${args[0]} (expected one of ${Object.keys(SCOUT_SUBCOMMANDS).join(", ")}, lists, or no subcommand for the sweep cycle)`);
  }
  const remote = args.includes("--remote");
  const sweepCap = flag(args, "--limit") ? Number(flag(args, "--limit")) : undefined;
  const perQuery = flag(args, "--per-query") ? Number(flag(args, "--per-query")) : undefined;
  const maxIngest = flag(args, "--max-ingest") ? Number(flag(args, "--max-ingest")) : undefined;
  const out = resolve(ROOT, flag(args, "--out") ?? "data/registry.json");
  const cfDir = resolve(ROOT, "cf");

  const d1 = new WranglerD1({
    cwd: cfDir,
    config: remote ? "wrangler.deploy.jsonc" : "wrangler.jsonc",
    database: remote ? "talents" : "talents-dev",
    remote,
  });
  const store = new D1DiscoveryStore(d1);
  const key = loadOrCreateRegistryKey(KEY_FILE);
  const mirror = new RegistryStore(out);

  const stats = await runDiscoveryCycle(
    {
      store,
      registryKey: key,
      onNewRecords: async (records) => {
        for (const r of records) mirror.upsert(r);
        mirror.save();
      },
    },
    { sweepCap, perQuery, maxIngest },
  );
  await d1.flush();

  console.log(`target:        ${remote ? "remote D1 (talents)" : "local D1 (talents-dev)"}`);
  console.log(`sweep:         ${stats.sweep.queriesRun} queries, ${stats.sweep.found} hits, ${stats.sweep.uniqueCandidates} unique candidates, ${stats.sweep.rateLimitHits} rate-limit hit(s)`);
  console.log(`candidates:    ${stats.candidatesSeen} seen, ${stats.alreadyKnown} already known, ${stats.verified} newly verified, ${stats.rejected.length} rejected`);
  for (const r of stats.rejected.slice(0, 10)) console.log(`  ✗ ${r.locator}: ${r.reason}`);
  for (const s of stats.ingestedSources) {
    console.log(`ingested:      ${s.locator} (${s.kind}) — ${s.newRecords} new record(s), ${s.existingUpdated} existing updated, ${s.existingSkipped} already in catalog, ${s.deadLetter} dead-letter`);
  }
  console.log(`new records:   ${stats.newRecords} (mirrored to ${out})`);
  console.log(`sources:       ${JSON.stringify(stats.sourcesByStatus)}`);
  // Machine-readable cycle evidence for the discovery gate.
  const evidencePath = resolve(ROOT, "data/gate-discovery-cycle.json");
  writeFileSync(evidencePath, JSON.stringify({
    at: new Date().toISOString(),
    target: remote ? "remote" : "local",
    sweep: stats.sweep,
    candidatesSeen: stats.candidatesSeen,
    alreadyKnown: stats.alreadyKnown,
    verified: stats.verified,
    rejected: stats.rejected,
    ingestedSources: stats.ingestedSources,
    newRecords: stats.newRecords,
    sourcesByStatus: stats.sourcesByStatus,
  }, null, 2));
  console.log(`cycle evidence: ${evidencePath}`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "ingest") await cmdIngest(rest);
  else if (cmd === "aggregate") cmdAggregate(rest);
  else if (cmd === "ingest-repo") await cmdIngestRepo(rest);
  else if (cmd === "show") cmdShow(rest);
  else if (cmd === "claim") await cmdClaim(rest);
  else if (cmd === "index") await cmdIndex(rest);
  else if (cmd === "search") await cmdSearch(rest);
  else if (cmd === "serve") await cmdServe(rest);
  else if (cmd === "discover") await cmdDiscover(rest);
  else {
    console.log("talents — skills meta-registry (P0+P1+P2+P5)\n  ingest <owner/repo | marketplace-json-url> [--limit N] [--ref R] [--out F] [--summary F]\n  ingest-repo <owner/repo> [--ref R] [--out F] [--summary F]\n  show <owner/name> [--from F]\n  claim <owner> [--token-env GITHUB_TOKEN] [--store F]\n  index [--from F]\n  search <query> [--kind K] [--owner O] [--limit N] [--from F]\n  serve [--port 4317] [--from F]\n  aggregate [--out data/aggregated-marketplace.json] [--from F]\n  discover [--remote] [--limit N] [--per-query N] [--max-ingest N] [--out F]\n  discover <codesearch|mcp|npm|skillssh|web|x> [--remote] [--cap N] [--max-ingest N] [--max-verify N] [--since ISO] [--posts F]\n  discover lists [--remote] [--scan rejects (default)] [--mine <owner/repo> …] [--refresh] [--limit N]");
    if (cmd) process.exitCode = 1;
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
}
