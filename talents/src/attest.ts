// Attestation: registry-signed statement over the content hash of the
// source files fetched at a pinned ref. The developer signs nothing and adds
// no keys — the registry hashes what already exists in the source repo and
// signs with its own ed25519 key (Gia trust layer, ARCHITECTURE-v2 §5).

import {
  createHash, generateKeyPairSync, createPrivateKey, createPublicKey,
  sign as cryptoSign, verify as cryptoVerify,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SourceFile, Attestation } from "./types.js";

/**
 * sha256 over a canonical concatenation: for each file (sorted by path),
 * `path \0 sha256(content)hex \n`. Sorting + per-file digests make the hash
 * independent of fetch order and unambiguous about file boundaries.
 */
export function contentHash(files: SourceFile[]): string {
  const h = createHash("sha256");
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const fh = createHash("sha256").update(f.content, "utf8").digest("hex");
    h.update(`${f.path}\0${fh}\n`, "utf8");
  }
  return h.digest("hex");
}

export interface RegistryKey {
  privateKeyPem: string;
  publicKeyPem: string;
}

/** Load the registry key from `filePath`, generating it (0600) on first use. */
export function loadOrCreateRegistryKey(filePath: string): RegistryKey {
  if (existsSync(filePath)) {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as RegistryKey;
    return raw;
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key: RegistryKey = {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(key), { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return key;
}

export function attestationPayload(identity: string, ref: string, hash: string): string {
  return `${identity}@${ref}:${hash}`;
}

export function signAttestation(key: RegistryKey, identity: string, ref: string, hash: string): Attestation {
  const sig = cryptoSign(null, Buffer.from(attestationPayload(identity, ref, hash), "utf8"), createPrivateKey(key.privateKeyPem));
  return {
    algorithm: "ed25519",
    contentHash: hash,
    signature: sig.toString("base64"),
    publicKeyPem: key.publicKeyPem,
    signedAt: new Date().toISOString(),
  };
}

/**
 * Verify an attestation against a fresh set of source files: recomputes the
 * content hash (tamper detection — any changed file changes the hash) and
 * verifies the ed25519 signature.
 */
export function verifyAttestation(
  att: Attestation,
  identity: string,
  ref: string,
  currentFiles: SourceFile[],
): { ok: boolean; reason: string; recomputedHash: string } {
  const recomputedHash = contentHash(currentFiles);
  if (recomputedHash !== att.contentHash) {
    return { ok: false, reason: "content hash mismatch — source changed since attestation", recomputedHash };
  }
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(attestationPayload(identity, ref, att.contentHash), "utf8"),
      createPublicKey(att.publicKeyPem),
      Buffer.from(att.signature, "base64"),
    );
    return ok
      ? { ok: true, reason: "hash matches and signature verifies", recomputedHash }
      : { ok: false, reason: "signature verification failed", recomputedHash };
  } catch (e) {
    return { ok: false, reason: `signature verification error: ${(e as Error).message}`, recomputedHash };
  }
}
