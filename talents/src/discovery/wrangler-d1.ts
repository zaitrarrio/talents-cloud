// Wrangler-backed D1 adapter for the CLI: implements the structural
// D1Like interface by shelling to `wrangler d1 execute`, so the
// discovery pipeline runs the IDENTICAL store code against a local
// Miniflare D1 (--local) or the production D1 (--remote) without a
// Worker in the loop. Credentials, when needed, come from the
// process environment (CLOUDFLARE_API_TOKEN) — wrangler reads them;
// this module never sees or logs them.
//
// Writes are BUFFERED and flushed in batches via --file (one
// subprocess per flush, not per statement); reads auto-flush first,
// so ordering semantics match a direct binding.
//
// D1 rejects any single SQL statement over 100,000 bytes
// (SQLITE_TOOBIG; measured 2026-11-11: a 90 KB statement succeeds,
// a 99 KB statement fails). flush() therefore never emits a
// statement over MAX_D1_STATEMENT_BYTES and never puts more than
// MAX_FLUSH_FILE_BYTES into one --file call; a statement that is
// oversized on its own is reported in FlushError.failed instead of
// being executed, and a failed chunk is retried statement by
// statement so one bad statement can never lose a whole batch.

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Like, D1StatementLike } from "../search-d1.js";
import { MAX_D1_STATEMENT_BYTES } from "../d1-limits.js";

export { MAX_D1_STATEMENT_BYTES };

export interface WranglerD1Options {
  /** Directory containing the wrangler config (cf/). */
  cwd: string;
  /** Wrangler -c config file name. */
  config: string;
  /** D1 database name as wrangler knows it. */
  database: string;
  /** true → production D1; false → local Miniflare D1. */
  remote: boolean;
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Bound for one wrangler --file (import) call: keeps the request
 *  well under any import size limit and each subprocess fast. */
export const MAX_FLUSH_FILE_BYTES = 512_000;
/** Bound on statements per --file call, on top of the byte bound. */
export const MAX_FLUSH_STATEMENTS = 500;

export interface FailedStatement {
  sql: string;
  bytes: number;
  error: string;
}

/** Thrown by flush() when some buffered statements could not be
 *  executed. Statements that succeeded ARE committed (the D1 import
 *  executes in order and the one-by-one retry commits the good
 *  ones), so callers must NOT re-flush — they must attribute the
 *  failed statements (see FlushError.failed) and move on. */
export class FlushError extends Error {
  readonly failed: FailedStatement[];
  readonly flushed: number;
  constructor(failed: FailedStatement[], flushed: number) {
    super(
      `D1 flush failed for ${failed.length} statement(s): ${failed[0]?.error ?? "unknown"} (${failed[0]?.bytes ?? 0} bytes)`,
    );
    this.name = "FlushError";
    this.failed = failed;
    this.flushed = flushed;
  }
}

/** True when the error is a deterministic oversized-statement
 *  failure: retrying the same statement can never succeed, so the
 *  caller should dead-letter the record/candidate rather than retry. */
export function isOversizedStatementError(e: unknown): boolean {
  if (e instanceof FlushError) return e.failed.some((f) => f.bytes > MAX_D1_STATEMENT_BYTES);
  const msg = e instanceof Error ? e.message : String(e);
  return /statement too long|SQLITE_TOOBIG/i.test(msg);
}

/** Inline bound params into a SQL template (replaces ? in order).
 *  The templates used by the discovery store contain no literal ?
 *  outside placeholders. */
export function inlineParams(sql: string, params: unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => literal(params[i++]));
}

class WranglerStatement implements D1StatementLike {
  private params: unknown[] = [];
  constructor(private owner: WranglerD1, private sql: string) {}
  bind(...params: unknown[]): D1StatementLike {
    this.params = params;
    return this;
  }
  async run(): Promise<unknown> {
    this.owner.bufferWrite(inlineParams(this.sql, this.params));
    return {};
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: await this.owner.query<T>(inlineParams(this.sql, this.params)) };
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const rows = await this.owner.query<T>(inlineParams(this.sql, this.params));
    return rows[0] ?? null;
  }
}

export class WranglerD1 implements D1Like {
  private pending: string[] = [];
  constructor(private opts: WranglerD1Options) {}

  prepare(sql: string): D1StatementLike {
    return new WranglerStatement(this, sql);
  }

  bufferWrite(sql: string): void {
    this.pending.push(sql.endsWith(";") ? sql : `${sql};`);
  }

  private wrangler(args: string[]): string {
    return execFileSync("npx", ["wrangler", ...args], {
      cwd: this.opts.cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
    });
  }

  private baseArgs(): string[] {
    return ["d1", "execute", this.opts.database, this.opts.remote ? "--remote" : "--local", "-c", this.opts.config];
  }

  /** Flush buffered writes in bounded --file executions.
   *
   *  Each call is chunked to MAX_FLUSH_FILE_BYTES / MAX_FLUSH_STATEMENTS
   *  and no single statement over MAX_D1_STATEMENT_BYTES is ever
   *  executed (it is reported in FlushError.failed instead). When a
   *  chunk fails, its statements are retried one by one — the good
   *  ones are idempotent upserts, so they commit, and only the bad
   *  ones are reported. A failed flush therefore never loses a whole
   *  batch and never kills the caller: inspect the thrown
   *  FlushError.failed to attribute the bad statements. */
  async flush(): Promise<void> {
    if (!this.pending.length) return;
    const stmts = this.pending.splice(0, this.pending.length);
    const failed: FailedStatement[] = [];
    let flushed = 0;
    const encoder = new TextEncoder();
    // Group into bounded chunks; oversized singles never execute.
    const chunks: string[][] = [];
    let cur: string[] = [];
    let curBytes = 0;
    for (const s of stmts) {
      const b = encoder.encode(s).length;
      if (b > MAX_D1_STATEMENT_BYTES) {
        failed.push({
          sql: s,
          bytes: b,
          error: `statement too long: ${b} bytes exceeds the D1 per-statement limit of 100,000 bytes`,
        });
        continue;
      }
      // +1 per statement for the "\n" separator join() adds (and the
      // trailing newline), so the written file stays inside the cap.
      if (cur.length && (curBytes + b + 1 > MAX_FLUSH_FILE_BYTES || cur.length >= MAX_FLUSH_STATEMENTS)) {
        chunks.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(s);
      curBytes += b + 1;
    }
    if (cur.length) chunks.push(cur);
    for (const chunk of chunks) {
      try {
        this.executeFile(chunk);
        flushed += chunk.length;
      } catch (e) {
        // One retry, statement by statement: isolates the bad
        // statement(s) and commits everything else in the chunk.
        for (const s of chunk) {
          try {
            this.executeFile([s]);
            flushed++;
          } catch (e2) {
            failed.push({ sql: s, bytes: encoder.encode(s).length, error: (e2 as Error).message });
          }
        }
      }
    }
    if (failed.length) throw new FlushError(failed, flushed);
  }

  private executeFile(stmts: string[]): void {
    const file = join(tmpdir(), `talents-d1-flush-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sql`);
    try {
      writeFileSync(file, stmts.join("\n") + "\n");
      this.wrangler([...this.baseArgs(), `--file=${file}`]);
    } finally {
      try { unlinkSync(file); } catch { /* best effort */ }
    }
  }

  async query<T>(sql: string): Promise<T[]> {
    await this.flush();
    const out = this.wrangler([...this.baseArgs(), "--json", "--command", sql]);
    const parsed = JSON.parse(out) as { results?: T[] }[] | { results?: T[] };
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return (first?.results ?? []) as T[];
  }
}
