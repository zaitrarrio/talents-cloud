// Queue-slice poll driver: reports terminal-state progress for exactly the
// 500 source ids returned by POST /admin/enqueue-candidates, from live D1.
// Usage: TALENTS_DIST=<snapshot> python3 cf/scripts/backfill_remote.py queueslice-poll.mjs
// (runs the SQL through d1_remote.py; read-only).
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENQUEUE_FILE = path.join(ROOT, "data", "queueslice-enqueue.json");

function esc(s) {
  return String(s).replace(/'/g, "''");
}

function runSql(sql) {
  const out = execFileSync(
    "python3",
    ["cf/scripts/d1_remote.py", "--command", sql],
    { cwd: ROOT, encoding: "utf8", timeout: 120000 },
  );
  // wrangler --json returns [{results:[...], success, meta}] per statement.
  const idx = out.indexOf("[");
  if (idx < 0) throw new Error("no JSON in d1 output: " + out.slice(-500));
  const parsed = JSON.parse(out.slice(idx));
  if (!Array.isArray(parsed) || !parsed[0] || !Array.isArray(parsed[0].results)) {
    throw new Error("unexpected d1 JSON shape: " + out.slice(idx, idx + 300));
  }
  return parsed[0].results;
}

function main() {
  if (!existsSync(ENQUEUE_FILE)) {
    console.log("NO ENQUEUE FILE — slice not started");
    return 1;
  }
  const enq = JSON.parse(readFileSync(ENQUEUE_FILE, "utf8"));
  const items = enq.items ?? [];
  const pairs = items.map((i) => `('${esc(i.kind)}','${esc(i.locator)}')`).join(",");
  const where = `(kind, locator) IN (${pairs})`;

  const byStatus = runSql(
    `SELECT status, COUNT(*) AS n FROM sources WHERE ${where} GROUP BY status ORDER BY n DESC`,
  );
  const byReason = runSql(
    `SELECT status, reason, COUNT(*) AS n FROM sources WHERE ${where} AND status IN ('rejected','stale') GROUP BY status, reason ORDER BY n DESC`,
  );
  const recSum = runSql(
    `SELECT COALESCE(SUM(record_count),0) AS records FROM sources WHERE ${where} AND status='ingested'`,
  );
  const stillCandidate = runSql(
    `SELECT kind, locator FROM sources WHERE ${where} AND status='candidate' LIMIT 10`,
  );

  const terminal = byStatus
    .filter((r) => r.status !== "candidate")
    .reduce((a, r) => a + r.n, 0);
  console.log(
    JSON.stringify(
      {
        atUtc: new Date().toISOString(),
        total: items.length,
        terminal,
        byStatus,
        byReason: byReason.slice(0, 20),
        recordsFromIngested: recSum[0]?.records ?? 0,
        stillCandidateSample: stillCandidate.map((r) => `${r.kind}:${r.locator}`),
      },
      null,
      2,
    ),
  );
  return 0;
}

process.exit(main());
