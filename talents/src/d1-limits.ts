// Shared D1 write-size discipline — ONE home for the constants and
// helpers every D1 write path uses, on BOTH transports:
//
//   - the operator path (WranglerD1 adapter, src/discovery/
//     wrangler-d1.ts): statements are inlined and flushed via
//     `wrangler d1 execute --file`;
//   - the Worker path (native D1 binding): the shared stores
//     (src/discovery/store.ts, src/enrichment/store.ts) run against
//     env.DB with bound parameters.
//
// D1 rejects any single SQL statement over 100,000 bytes
// (SQLITE_TOOBIG, code 7500) — measured live 2026-11-11: a 90 KB
// statement succeeds, a 99 KB one fails. The drain crash
// (data/gate-drainfix.txt) proved the operator path; the Worker
// hardening pass (data/gate-d1harden.txt) brought the native-binding
// paths to the same discipline. Bound parameters are sized as if
// inlined (the conservative reading of the limit, and exactly what
// the operator transport does), so a statement that fits here fits
// on both transports.
//
// This module has NO transport dependencies (no node builtins, no
// Workers types) so the Worker bundle and the CLI import the same
// code — the paths cannot drift.

/** Hard cap for any one statement, sized as SQL + bound values:
 *  10% headroom under D1's measured 100,000-byte limit leaves room
 *  for SQL wrapper text and quote-escaping inflation. */
export const MAX_D1_STATEMENT_BYTES = 90_000;

/** Split-path trigger: a write whose estimated statement size
 *  exceeds this budget is written in bounded pieces instead of one
 *  statement (see D1DiscoveryStore.upsertRecord and
 *  D1EnrichmentStore.upsertLayer). */
export const STATEMENT_BUDGET_BYTES = 80_000;

/** Largest TEXT chunk written by one statement in a split path. */
export const TEXT_CHUNK_BYTES = 40_000;

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8ByteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Split a string into chunks of at most `maxBytes` UTF-8 bytes,
 *  never splitting a code point (for..of iterates code points, so a
 *  surrogate pair stays intact). Concatenating the chunks in order
 *  reproduces the input byte-identically — the property the chunked
 *  writes rely on (SQLite `||` appends rebuild the exact value). */
export function chunkTextByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const b = encoder.encode(ch).length;
    if (cur && curBytes + b > maxBytes) {
      chunks.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur || chunks.length === 0) chunks.push(cur);
  return chunks;
}

/** Conservative size of a statement as D1 sees it: the SQL text
 *  plus every bound value sized as if inlined (strings at their
 *  UTF-8 byte length + 2 for quotes + 1 per single-quote for the
 *  '' escaping the operator transport applies; numbers/booleans at
 *  their literal length; null/undefined as NULL). */
export function estimateStatementBytes(sql: string, params: readonly unknown[]): number {
  let total = utf8ByteLength(sql);
  for (const p of params) {
    if (p === null || p === undefined) total += 4;
    else if (typeof p === "string") {
      let quotes = 0;
      for (const ch of p) if (ch === "'") quotes++;
      total += utf8ByteLength(p) + 2 + quotes;
    } else if (typeof p === "number" || typeof p === "boolean") total += String(p).length;
    else total += utf8ByteLength(JSON.stringify(p) ?? "");
  }
  return total;
}

/** True when a statement (SQL + bound values) would exceed the cap
 *  and must be split before it is executed anywhere. */
export function statementExceedsLimit(sql: string, params: readonly unknown[]): boolean {
  return estimateStatementBytes(sql, params) > MAX_D1_STATEMENT_BYTES;
}
