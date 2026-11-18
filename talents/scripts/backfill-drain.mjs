// Backfill DRAIN: run the existing verification → ingest pipeline
// over the WHOLE candidate/verified backlog in production D1, in
// priority order, in sustained batches — including candidates
// nominated by earlier scout runs (P5/gate backlog), not just this
// backfill's. Mirrors the scout runner's verify/ingest semantics
// using the pipeline primitives themselves (verifyRepo +
// ingestSource); terminal states are read back from D1 after every
// batch (never trusted from in-memory tallies alone).
//
// Usage: backfill_remote.py backfill-drain.mjs [--batch 25] [--max-batches N]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DIST, makeDeps, counts, nowIso, sleep } from "./backfill-lib.mjs";

const args = process.argv.slice(2);
const batchSize = args.includes("--batch") ? Number(args[args.indexOf("--batch") + 1]) : 25;
const maxBatches = args.includes("--max-batches") ? Number(args[args.indexOf("--max-batches") + 1]) : Infinity;
const progressPath = "/home/hatch/workspace/skills-marketplace/talents/data/backfill-drain-progress.json";

const { verifyRepo } = await import(pathToFileURL(join(DIST, "src/discovery/sweep.js")).href);
const { ingestSource } = await import(pathToFileURL(join(DIST, "src/discovery/pipeline.js")).href);
const { classifyAsList, isNoSkillFilesReason } = await import(pathToFileURL(join(DIST, "src/discovery/lists.js")).href);
const { FlushError, isOversizedStatementError } = await import(pathToFileURL(join(DIST, "src/discovery/wrangler-d1.js")).href);
// Drain hardening: the queue consumer claims a processing lease
// (claimed_at/claimed_by, migration 0007) before verifying a
// candidate. The drain reads the same leases so the two transports
// never verify the same repo twice. Namespace import + fallback:
// the lease methods only exist in a dist snapshot built after the
// hardening change — against an older snapshot the drain degrades
// to its previous (unleased) behavior instead of crashing.
const storeModule = await import(pathToFileURL(join(DIST, "src/discovery/store.js")).href);
const LEASE_TTL_MINUTES = storeModule.LEASE_TTL_MINUTES ?? 30;
const REPO_KINDS = ["marketplace", "plugin-repo", "skill-repo"];

const { d1, store, key, pacer, fetchFn, onNewRecords } = await makeDeps({ pacerMs: 1000 });
const deps = { store, registryKey: key, fetchFn, pacer, onNewRecords };

const progress = existsSync(progressPath)
  ? JSON.parse(readFileSync(progressPath, "utf8"))
  : { startedAt: nowIso(), batches: 0, verified: 0, ingestedSources: 0, newRecords: 0, existingSkipped: 0, deadLetter: 0, rejected: 0, rejectReasons: {}, ingestErrors: 0, newRecordIdsByVia: {}, twinsRetired: 0 };
progress.twinsRetired ??= 0;
progress.listsClassified ??= 0;
progress.listNominated ??= 0;
const saveProgress = () => writeFileSync(progressPath, JSON.stringify(progress, null, 2));
const tallyReason = (r) => {
  const key = r.replace(/https?:\/\/\S+/g, "<url>").slice(0, 110);
  progress.rejectReasons[key] = (progress.rejectReasons[key] ?? 0) + 1;
};

let consecutiveRateLimits = 0;
let batchNo = 0;
for (;;) {
  batchNo++;
  if (batchNo > maxBatches) { console.log("max-batches reached"); break; }
  const candidates = await store.listSources("candidate");
  const verified = await store.listSources("verified");
  const ingested = await store.listSources("ingested");
  const ingestedLocators = new Set(ingested.map((r) => r.locator));
  // Drain hardening: skip locators the queue consumer is actively
  // processing — an active lease on ANY row for the locator means
  // the queue owns that locator right now. Leases expire by TTL;
  // the drain re-selects the row in a later batch once the lease
  // lapses or the queue clears it on a terminal outcome.
  const leaseCutoff = new Date(Date.now() - LEASE_TTL_MINUTES * 60_000).toISOString();
  const leasedLocators = new Set();
  if (typeof store.listActiveLeases === "function") {
    try {
      for (const l of await store.listActiveLeases(leaseCutoff)) leasedLocators.add(l.locator);
    } catch (e) {
      console.log(`  lease read failed (continuing without deconfliction): ${e.message}`);
    }
  }
  // Sources are locator-canonical, but rows are keyed (kind,
  // locator): a repo nominated under a provisional kind leaves a
  // TWIN row when verification assigns the real kind. Collapse by
  // locator — process one keeper per locator, retire twins — or
  // the queue loops forever on already-ingested repos.
  const byLocator = new Map();
  for (const r of [...verified, ...candidates]) {
    const arr = byLocator.get(r.locator) ?? [];
    arr.push(r);
    byLocator.set(r.locator, arr);
  }
  const retire = async (row, status, reason) => {
    await store.upsertSource({ ...row, status, reason, lastSeen: nowIso() });
    progress.twinsRetired++;
  };
  const work = [];
  for (const [locator, rows] of byLocator) {
    if (leasedLocators.has(locator)) continue; // queue owns this locator right now (drain hardening)
    rows.sort((a, b) => (a.status === b.status ? b.priority - a.priority : a.status === "verified" ? -1 : 1));
    const [keeper, ...twins] = rows;
    if (ingestedLocators.has(locator)) {
      for (const t of rows) await retire(t, "stale", "twin row — locator already ingested under its verified kind");
      continue;
    }
    work.push({ keeper, twins });
  }
  work.sort((a, b) => b.keeper.priority - a.keeper.priority);
  if (!work.length && !byLocator.size) { console.log("queue exhausted"); break; }
  if (!work.length && leasedLocators.size > 0) {
    // Everything left is queue-leased: wait instead of hot-spinning
    // full-table reads while the consumer works through its queue.
    console.log(`batch: all ${leasedLocators.size} remaining locators are queue-leased — waiting 60s`);
    await sleep(60_000);
    continue;
  }
  if (!work.length) { console.log("batch: only twin rows retired"); }
  let batch = work.slice(0, batchSize);
  // Claim the batch (drain hardening): the queue skips
  // actively-leased sources, so claiming here — and clearing at
  // batch end — keeps the two transports from verifying the same
  // repo twice. A claim that loses the race drops the row from
  // this batch; a claim failure degrades to unleased (the old
  // behavior) rather than killing the drain.
  const claimed = [];
  if (typeof store.tryClaimLease === "function") {
    const kept = [];
    for (const entry of batch) {
      try {
        const ok = await store.tryClaimLease(entry.keeper.kind, entry.keeper.locator, "sandbox-drain", LEASE_TTL_MINUTES, new Date());
        if (ok) { kept.push(entry); claimed.push(entry.keeper); }
        else console.log(`  lease race on ${entry.keeper.locator} — skipping this batch`);
      } catch (e) {
        console.log(`  lease claim failed for ${entry.keeper.locator} (continuing unleased): ${e.message}`);
        kept.push(entry);
      }
    }
    batch = kept;
  }
  let batchNew = 0, batchVerified = 0, batchRejected = 0, batchIngested = 0;
  for (const { keeper: row0, twins } of batch) {
    let row = row0;
    let ready = row;
    // List rows are MINED, never verified or ingested (lists.ts):
    // classify the claim — mining converts the row in place; a
    // repo that turns out to carry skill files graduates to a
    // verified row and flows on to ingest below; a claim that is
    // neither is a plain rejection. Wrapped defensively: a list
    // failure must never break the drain — rejection is the
    // fallback, exactly as before lists existed.
    if (row.kind === "list") {
      let handled = false;
      try {
        const outcome = await classifyAsList(deps, row);
        if (outcome.isList) {
          progress.listsClassified++;
          if (outcome.mine) progress.listNominated += outcome.mine.nominated;
          handled = true;
        } else if (outcome.graduatedKind) {
          row = { ...row, kind: outcome.graduatedKind, status: "verified", reason: `list claim discarded: ${outcome.reason}` };
          ready = row;
          await store.upsertSource(ready);
        } else {
          progress.rejected++; batchRejected++;
          tallyReason(outcome.reason);
          await store.upsertSource({ ...row, status: "rejected", reason: outcome.reason, lastSeen: nowIso() });
          handled = true;
        }
      } catch (e) {
        console.log(`  list classify error ${row.locator}: ${(e).message} — falling back to rejection`);
        progress.rejected++; batchRejected++;
        await store.upsertSource({ ...row, status: "rejected", reason: `list classification failed: ${(e).message}`, lastSeen: nowIso() });
        handled = true;
      }
      if (handled) {
        for (const t of twins) await retire(t, "stale", "twin row — locator resolved via its list row");
        continue;
      }
    }
    if (row.status === "candidate" && REPO_KINDS.includes(row.kind)) {
      const v = await verifyRepo(fetchFn, pacer, {
        locator: row.locator, url: row.url ?? `https://github.com/${row.locator}`,
        description: "", discoveredVia: row.discoveredVia, archived: false,
      });
      if (!v.ok || !v.kind) {
        // List heuristic: no skill files + link-dense markdown = a
        // curated list to mine, not a rejection (lists.ts).
        if (isNoSkillFilesReason(v.reason)) {
          let rescued = false;
          try {
            const outcome = await classifyAsList(deps, row);
            if (outcome.isList) {
              progress.listsClassified++;
              if (outcome.mine) progress.listNominated += outcome.mine.nominated;
              rescued = true;
            }
          } catch { /* best-effort; rejection stands */ }
          if (rescued) {
            for (const t of twins) await retire(t, "stale", "twin row — locator classified as a list source");
            continue;
          }
        }
        progress.rejected++; batchRejected++;
        tallyReason(v.reason);
        if (/403|429|rate/i.test(v.reason)) consecutiveRateLimits++; else consecutiveRateLimits = 0;
        await store.upsertSource({ ...row, status: "rejected", reason: v.reason, lastSeen: nowIso() });
        for (const t of twins) await retire(t, "rejected", v.reason);
        continue;
      }
      batchVerified++; progress.verified++;
      ready = { ...row, kind: v.kind, status: "verified", reason: v.reason };
      await store.upsertSource(ready);
    }
    try {
      const res = await ingestSource(deps, ready);
      // Flush per candidate, not just at batch end: a flush failure
      // is then attributable to THIS candidate instead of poisoning
      // the whole batch's buffered writes (the 2026-11-11
      // SQLITE_TOOBIG crash: one oversized record INSERT discarded
      // every statement buffered with it, and the uncaught batch-end
      // flush killed the drain).
      await d1.flush();
      batchIngested++; progress.ingestedSources++;
      progress.newRecords += res.newRecords;
      progress.existingSkipped += res.existingSkipped;
      progress.deadLetter += res.deadLetter;
      batchNew += res.newRecords;
      if (res.newRecords > 0) {
        const via = ready.discoveredVia;
        progress.newRecordIdsByVia[via] = (progress.newRecordIdsByVia[via] ?? 0) + res.newRecords;
      }
      // If verification corrected the kind, the row we started
      // from is now a twin of the ingested canonical row.
      if (ready.kind !== row.kind) {
        await retire(row, "stale", `kind corrected at verification to ${ready.kind}; canonical row carries this locator`);
      }
      for (const t of twins) await retire(t, "stale", "twin row — locator ingested via its canonical-kind row");
    } catch (e) {
      progress.ingestErrors++;
      tallyReason(`ingest failed: ${(e).message}`);
      console.log(`  ingest error ${ready.locator}: ${(e).message}`);
      // Deterministic failure (an oversized statement can never
      // succeed on retry): dead-letter THIS candidate so the drain
      // never loops on it again. The dead-letter write is a single
      // small statement, flushed on its own. Anything else stays a
      // candidate for a later batch (transient failures may clear).
      if (isOversizedStatementError(e)) {
        try {
          await store.upsertSource({ ...ready, status: "rejected", reason: `ingest failed (oversized statement): ${(e).message.slice(0, 200)}`, lastSeen: nowIso() });
          await d1.flush();
          progress.rejected++; batchRejected++;
          for (const t of twins) await retire(t, "rejected", `twin of ${ready.locator}, rejected: oversized statement at ingest`);
          await d1.flush();
        } catch (e2) {
          console.log(`  dead-letter write failed for ${ready.locator}: ${(e2).message} — leaving as candidate`);
        }
      }
    }
  }
  // Release the batch leases (drain hardening): terminal rows
  // are already non-candidates (the queue ignores them), and
  // transient failures stay candidates the queue may pick up.
  // The batch-end flush below persists the clears; a crash
  // before it just leaves leases to expire by TTL.
  if (typeof store.clearLease === "function") {
    for (const row of claimed) {
      try { await store.clearLease(row.kind, row.locator); } catch { /* lease expires by TTL */ }
    }
  }
  // Guarded: with per-candidate flushes above, only the twin-retire
  // and stats writes remain buffered here, but a flush failure must
  // never kill the drain again.
  try {
    await d1.flush();
  } catch (e) {
    console.log(`  batch-end flush failed (continuing): ${(e).message}`);
    if (e instanceof FlushError) {
      for (const f of e.failed) console.log(`    failed statement (${f.bytes} bytes): ${f.sql.slice(0, 160).replace(/\s+/g, " ")}`);
    }
  }
  progress.batches++;
  // No batch stats refresh: ingestSource maintains record_stats
  // incrementally for every record it writes (P0-1); the paged
  // rebuild job heals drift. The old full-catalog refresh could
  // not complete at current scale (50 MB result + 22k statements).
  saveProgress();
  const c = await counts(d1);
  const listed = c.recordsByStatus.find((r) => r.status === "listed")?.n ?? 0;
  const byStatus = Object.fromEntries(c.sourcesByStatus.map((r) => [r.status, r.n]));
  console.log(`batch ${progress.batches}: verified ${batchVerified}, ingested ${batchIngested}, rejected ${batchRejected}, newRecords ${batchNew} | listed=${listed} sources=${JSON.stringify(byStatus)} pacerRateLimitHits=${pacer.rateLimitHits}`);
  if (consecutiveRateLimits >= 10) {
    console.log("10 consecutive rate-limit-flavoured rejections — backing off 180s");
    await sleep(180_000);
    consecutiveRateLimits = 0;
  }
}
try {
  await d1.flush();
} catch (e) {
  console.log(`final flush failed (progress still saved): ${(e).message}`);
}
saveProgress();
console.log(JSON.stringify(progress, null, 2));
