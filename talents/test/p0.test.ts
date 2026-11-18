import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  isValidOwnerSlug, isValidSkillName, parseIdentity,
  NamespaceStore, verifyGithubOwnership,
} from "../src/namespace.js";
import { handleGithubPush, verifyGithubSignature } from "../src/webhook.js";
import { deriveDeclaration, type PluginJson } from "../src/declaration.js";
import { contentHash, signAttestation, verifyAttestation, type RegistryKey } from "../src/attest.js";
import { generateKeyPairSync } from "node:crypto";
import type { FetchFn } from "../src/types.js";

function testKey(): RegistryKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("owner slug rules follow GitHub login rules", () => {
  assert.equal(isValidOwnerSlug("anthropics"), true);
  assert.equal(isValidOwnerSlug("42Crunch-AI"), true);
  assert.equal(isValidOwnerSlug("-bad"), false);
  assert.equal(isValidOwnerSlug("bad-"), false);
  assert.equal(isValidOwnerSlug("ba--d"), false);
  assert.equal(isValidOwnerSlug("has space"), false);
  assert.equal(isValidOwnerSlug("under_score"), false);
  assert.equal(isValidOwnerSlug(""), false);
  assert.equal(isValidOwnerSlug("a".repeat(40)), false);
});

test("skill name + identity parsing", () => {
  assert.equal(isValidSkillName("invoice-reconciler"), true);
  assert.equal(isValidSkillName("42crunch-api-security-testing"), true);
  assert.equal(isValidSkillName("Bad Name"), false);
  assert.equal(isValidSkillName("..evil"), false);
  assert.deepEqual(parseIdentity("Anthropics/Document-Skills"), { owner: "anthropics", name: "document-skills" });
  assert.equal(parseIdentity("noslash"), null);
  assert.equal(parseIdentity("a/b/c"), null);
});

test("namespace claims are first-come-first-served", () => {
  const store = new NamespaceStore(); // in-memory
  const c = store.claim("ledgerline", "ledgerline", true);
  assert.equal(c.owner, "ledgerline");
  // Same claimant re-claiming is idempotent.
  assert.equal(store.claim("Ledgerline", "ledgerline", true).owner, "ledgerline");
  // A different claimant conflicts.
  assert.throws(() => store.claim("ledgerline", "someone-else", false), /already claimed/);
});

function fakeGithub(routes: Record<string, { status: number; body: unknown }>): FetchFn {
  return async (url) => {
    const r = routes[url] ?? { status: 404, body: { message: "not found" } };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => JSON.stringify(r.body),
      json: async () => r.body,
    };
  };
}

test("verifyGithubOwnership: self namespace", async () => {
  const fetchFn = fakeGithub({ "https://api.github.com/user": { status: 200, body: { login: "zay" } } });
  const res = await verifyGithubOwnership("zay", "tok", fetchFn);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.via, "self");
});

test("verifyGithubOwnership: org admin via membership", async () => {
  const fetchFn = fakeGithub({
    "https://api.github.com/user": { status: 200, body: { login: "zay" } },
    "https://api.github.com/user/memberships/orgs/anthropics": { status: 200, body: { role: "admin", state: "active" } },
  });
  const res = await verifyGithubOwnership("anthropics", "tok", fetchFn);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.via, "org-admin");
});

test("verifyGithubOwnership: plain org member is refused", async () => {
  const fetchFn = fakeGithub({
    "https://api.github.com/user": { status: 200, body: { login: "zay" } },
    "https://api.github.com/user/memberships/orgs/anthropics": { status: 200, body: { role: "member", state: "active" } },
  });
  const res = await verifyGithubOwnership("anthropics", "tok", fetchFn);
  assert.equal(res.ok, false);
});

test("webhook: marketplace.json change triggers reindex", () => {
  const r = handleGithubPush({ commits: [{ modified: [".claude-plugin/marketplace.json"] }] });
  assert.equal(r.reindex, true);
});

test("webhook: plugin.json and SKILL.md changes trigger reindex", () => {
  assert.equal(handleGithubPush({ commits: [{ added: ["plugins/x/.claude-plugin/plugin.json"] }] }).reindex, true);
  assert.equal(handleGithubPush({ commits: [{ modified: ["skills/pdf/SKILL.md"] }] }).reindex, true);
});

test("webhook: unrelated change does not trigger reindex", () => {
  const r = handleGithubPush({ commits: [{ modified: ["README.md", "src/index.ts"] }] });
  assert.equal(r.reindex, false);
});

test("webhook HMAC helper accepts good and rejects bad signatures", () => {
  const secret = "test-secret";
  const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));
  const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyGithubSignature(body, good, secret), true);
  assert.equal(verifyGithubSignature(body, "sha256=" + "0".repeat(64), secret), false);
  assert.equal(verifyGithubSignature(body, undefined, secret), false);
  assert.equal(verifyGithubSignature(Buffer.from("tampered"), good, secret), false);
});

test("declaration derivation from plugin.json with mcpServers + hooks", () => {
  const pj: PluginJson = {
    name: "fixture",
    version: "1.0.0",
    description: "fixture plugin",
    skills: ["./skills/do-thing"],
    mcpServers: {
      db: { command: "npx", args: ["-y", "@fixture/db-mcp"], env: { DB_URL: "postgres://example" } },
      remote: { url: "https://mcp.example.com/sse" },
    },
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
  };
  const d = deriveDeclaration({ pluginJson: pj, pluginJsonSource: "fixture plugin.json" });
  const all = d.lines.map((l) => l.text).join("\n");
  assert.match(all, /Runs a local MCP server process "db": npx -y @fixture\/db-mcp/);
  assert.match(all, /environment variables: DB_URL/);
  assert.match(all, /Connects to remote MCP server "remote" at https:\/\/mcp\.example\.com\/sse/);
  assert.match(all, /Registers hooks on: PreToolUse/);
  assert.equal(d.undeclared.length, 0);
  assert.ok(d.summary.some((s) => s.includes("Starts a local process")));
});

test("declaration with nothing derivable is labelled undeclared, not guessed", () => {
  const d = deriveDeclaration({ pluginJson: null, pluginJsonSource: "none" });
  assert.ok(d.undeclared.length >= 1);
  assert.ok(d.lines.some((l) => l.kind === "undeclared"));
});

test("attestation verifies and detects tampering", () => {
  const key = testKey();
  const files = [
    { path: "SKILL.md", content: "---\nname: x\ndescription: y\n---\nbody" },
    { path: ".claude-plugin/plugin.json", content: '{"name":"x","version":"1.0.0"}' },
  ];
  const hash = contentHash(files);
  const att = signAttestation(key, "owner/x", "v1.0.0", hash);
  const good = verifyAttestation(att, "owner/x", "v1.0.0", files);
  assert.equal(good.ok, true);
  // File order does not change the hash.
  assert.equal(contentHash([...files].reverse()), hash);
  // Tampered content fails.
  const tampered = [{ ...files[0], content: files[0].content + " evil" }, files[1]];
  const bad = verifyAttestation(att, "owner/x", "v1.0.0", tampered);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /hash mismatch/);
  // Wrong identity fails signature even with the right files.
  const wrongId = verifyAttestation(att, "owner/y", "v1.0.0", files);
  assert.equal(wrongId.ok, false);
});
