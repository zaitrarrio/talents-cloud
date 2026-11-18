// Webhook freshness: GitHub push events re-index only when they touch the
// files the registry actually reads — marketplace.json, any plugin.json,
// or any SKILL.md. Everything else is ignored (no wasted ingest jobs).

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface PushPayload {
  ref?: string;
  commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
  head_commit?: { added?: string[]; modified?: string[]; removed?: string[] } | null;
}

export interface WebhookDeps {
  /** Called when a reindex is warranted (P0: the CLI/server logs + records intent; BullMQ in production). */
  onReindex?: (info: { repo: string | null; reason: string }) => void;
}

const REINDEX_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(^|\/)\.claude-plugin\/marketplace\.json$/, label: "marketplace.json changed" },
  { re: /(^|\/)\.claude-plugin\/plugin\.json$/, label: "plugin.json changed" },
  { re: /(^|\/)SKILL\.md$/, label: "SKILL.md changed" },
];

export function touchedFiles(payload: PushPayload): string[] {
  const files = new Set<string>();
  const commits = [...(payload.commits ?? []), ...(payload.head_commit ? [payload.head_commit] : [])];
  for (const c of commits) {
    for (const f of [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]) files.add(f);
  }
  return [...files];
}

export function handleGithubPush(
  payload: PushPayload,
  deps: WebhookDeps = {},
): { reindex: boolean; reason: string } {
  const files = touchedFiles(payload);
  for (const f of files) {
    for (const p of REINDEX_PATTERNS) {
      if (p.re.test(f)) {
        const reason = `${p.label}: ${f}`;
        deps.onReindex?.({ repo: null, reason });
        return { reindex: true, reason };
      }
    }
  }
  return { reindex: false, reason: files.length ? "no registry-relevant files in push" : "push carried no file lists" };
}

/** Verify an X-Hub-Signature-256 header against the raw request body. */
export function verifyGithubSignature(rawBody: Buffer | string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Tiny HTTP wiring: POST /webhooks/github.
 * If TALENTS_WEBHOOK_SECRET is set, the HMAC signature is required and
 * verified; if unset (local dev), requests are accepted and the handler
 * still applies the file-relevance filter. The secret comes from env only.
 */
export function createWebhookServer(deps: WebhookDeps = {}): Server {
  return createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/webhooks/github") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const secret = process.env.TALENTS_WEBHOOK_SECRET;
      if (secret) {
        const sig = req.headers["x-hub-signature-256"] as string | undefined;
        if (!verifyGithubSignature(raw, sig, secret)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "signature verification failed" }));
          return;
        }
      }
      let payload: PushPayload;
      try {
        payload = JSON.parse(raw.toString("utf8")) as PushPayload;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      const result = handleGithubPush(payload, deps);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    });
  });
}
