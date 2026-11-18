// Attestation re-verification for the install ceremony (P2), Worker
// edition. The root engine's attest.ts uses node:crypto; here the same
// canonical hash is computed with WebCrypto so the gateway can verify
// inside workerd:
//
//   sha256 over the concatenation, for each file sorted by path, of
//   `${path}\0${sha256(content)hex}\n`
//
// Equivalence with src/attest.ts contentHash is pinned by a unit test
// in the root suite (test/p2.test.ts).

import type { SkillRecord, SourceFile } from "../../src/types.js";

const enc = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function contentHashWeb(files: SourceFile[]): Promise<string> {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  let acc = "";
  for (const f of sorted) {
    acc += `${f.path}\0${await sha256Hex(f.content)}\n`;
  }
  return sha256Hex(acc);
}

/**
 * Re-fetch the record's hashed source files from GitHub at the pinned
 * ref. filesHashed paths are repo-relative (guaranteed by ingest /
 * repo-scan). Returns null when the record cannot be re-fetched
 * (pointer-only, no GitHub repo, or any file unreachable).
 */
export async function refetchSourceFiles(
  record: SkillRecord,
  fetchFn: typeof fetch = fetch,
): Promise<SourceFile[] | null> {
  if (record.pointerOnly || !record.sourceRepo || record.filesHashed.length === 0) return null;
  const files: SourceFile[] = [];
  for (const path of record.filesHashed) {
    const url = `https://raw.githubusercontent.com/${record.sourceRepo}/${record.ref}/${path}`;
    try {
      const res = await fetchFn(url, { headers: { "user-agent": "talents-gateway-p2" } });
      if (!res.ok) return null;
      files.push({ path, content: await res.text() });
    } catch {
      return null;
    }
  }
  return files;
}

export interface VerifyOutcome {
  ok: boolean;
  reason: string;
  recomputedHash: string | null;
}

/**
 * The install-time check (ARCHITECTURE-v2 §5): the source as it exists
 * NOW, at the pinned ref, must hash to exactly what the registry signed.
 * Any drift — edited SKILL.md, moved file, force-pushed ref — refuses.
 */
export async function verifyRecordAttestation(
  record: SkillRecord,
  fetchFn: typeof fetch = fetch,
): Promise<VerifyOutcome> {
  if (!record.attestation) {
    return { ok: false, reason: "record has no registry attestation — refusing", recomputedHash: null };
  }
  const files = await refetchSourceFiles(record, fetchFn);
  if (files === null) {
    return {
      ok: false,
      reason: "source files could not be re-fetched from the original repo at the pinned ref — refusing",
      recomputedHash: null,
    };
  }
  const recomputedHash = await contentHashWeb(files);
  if (recomputedHash !== record.attestation.contentHash) {
    return {
      ok: false,
      reason: `content hash mismatch — source changed since attestation (signed ${record.attestation.contentHash.slice(0, 12)}…, current ${recomputedHash.slice(0, 12)}…)`,
      recomputedHash,
    };
  }
  return { ok: true, reason: "recomputed hash matches the signed attestation", recomputedHash };
}
