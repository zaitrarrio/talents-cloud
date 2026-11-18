// Component-shape defect (found 2026-11-11): a marketplace entry may
// carry a component collection as a BARE STRING — the plugin spec
// allows `commands: "./commands/"` — and ingest stored it verbatim,
// so the renderer crashed with `c2.commands.map is not a function`
// (aaron-he-zhu/aaron-marketing's page 500'd). Production sweep over
// 16,096 listed records found exactly ONE stored record with a
// non-array component field (commands, text "./commands/"); every
// other renderer-consumed array field was clean. These tests pin:
//   1. the shared normalizer (stringArray / normalizeComponents),
//   2. ingest storing arrays (end-to-end marketplace ingest),
//   3. declaration derivation not char-spreading bare strings,
//   4. the search/store flatten path not char-spreading,
//   5. renderer tolerance: malformed stored shapes NEVER throw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { RegistryKey } from "../src/attest.js";
import type { FetchFn, SkillRecord } from "../src/types.js";
import { stringArray, normalizeComponents } from "../src/validate.js";
import { deriveDeclaration } from "../src/declaration.js";
import { flattenComponents, toSearchDocument } from "../src/search.js";
import { renderSkillPage, renderHome, renderProfile, skillCard, trendingScore } from "../src/render.js";
import { ingestGithubRepo } from "../src/ingest.js";

// ---------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------

test("stringArray: bare string becomes a one-element array", () => {
  assert.deepEqual(stringArray("./commands/"), ["./commands/"]);
  assert.deepEqual(stringArray(""), []);
  assert.deepEqual(stringArray(undefined), []);
  assert.deepEqual(stringArray(null), []);
  assert.deepEqual(stringArray(42), []);
  assert.deepEqual(stringArray({ 0: "x" }), []);
});

test("stringArray: arrays keep their non-empty string elements, in order", () => {
  assert.deepEqual(stringArray(["a", "b"]), ["a", "b"]);
  assert.deepEqual(stringArray(["a", "", 7, null, "b"]), ["a", "b"]);
  assert.deepEqual(stringArray([]), []);
});

test("normalizeComponents: the aaron-marketing shape is coerced", () => {
  const c = normalizeComponents({ skills: ["a", "b"], commands: "./commands/", agents: [], hooks: false, mcpServers: [] });
  assert.deepEqual(c.commands, ["./commands/"]);
  assert.deepEqual(c.skills, ["a", "b"]);
  assert.deepEqual(c.agents, []);
  assert.equal(c.hooks, false);
});

test("normalizeComponents: garbage in, typed shape out; idempotent on good shapes", () => {
  const good = { skills: ["x"], commands: ["y"], agents: [], hooks: true, mcpServers: ["srv"] };
  assert.deepEqual(normalizeComponents(good), good);
  assert.deepEqual(normalizeComponents(null), { skills: [], commands: [], agents: [], hooks: false, mcpServers: [] });
  assert.deepEqual(normalizeComponents("nope"), { skills: [], commands: [], agents: [], hooks: false, mcpServers: [] });
  const mixed = normalizeComponents({ skills: "one", commands: { a: 1 }, agents: 7, hooks: "yes", mcpServers: ["s", 3] });
  assert.deepEqual(mixed, { skills: ["one"], commands: [], agents: [], hooks: true, mcpServers: ["s"] });
});

// ---------------------------------------------------------------------
// Declaration + search flatten: no char-spreading of bare strings
// ---------------------------------------------------------------------

test("deriveDeclaration: bare-string entryComponents are single components, not characters", () => {
  const d = deriveDeclaration({
    pluginJson: null,
    entryComponents: { skills: "./skills/", commands: "./commands/", agents: "./agents/" },
    pluginJsonSource: "test",
  });
  const text = d.lines.map((l) => l.text).join("\n");
  assert.ok(text.includes("Provides 1 slash command(s): ./commands/"), text);
  assert.ok(text.includes("Provides 1 skill(s): skills/"), text);
  assert.ok(text.includes("Provides 1 sub-agent(s): ./agents/"), text);
});

test("flattenComponents/toSearchDocument: string commands flatten whole, not per-character", () => {
  const r = record({ id: "aaron-he-zhu/aaron-marketing" });
  (r.components as unknown as Record<string, unknown>).commands = "./commands/";
  assert.deepEqual(flattenComponents(r), ["aaron-marketing", "./commands/"]);
  const doc = toSearchDocument(r);
  assert.ok(doc.components.includes("./commands/"));
  assert.ok(!doc.components.includes("c"), "no per-character tokens");
});

// ---------------------------------------------------------------------
// Renderer tolerance — the regression class
// ---------------------------------------------------------------------

function record(partial: Partial<SkillRecord> & { id: string }): SkillRecord {
  const { id, ...rest } = partial;
  const [owner, name] = id.split("/");
  return {
    id,
    owner,
    name,
    url: `https://talents.sh/skills/${id}`,
    profileUrl: `https://talents.sh/${owner}`,
    kind: "plugin",
    description: "A marketing plugin.",
    sourceType: "github",
    source: "./",
    sourceRepo: `${owner}/repo`,
    sourcePath: "",
    sourceMarketplace: `${owner}/repo`,
    ref: "main",
    pointerOnly: false,
    components: { skills: [name], commands: [], agents: [], hooks: false, mcpServers: [] },
    declaration: {
      lines: [{ kind: "component", text: `Provides 1 skill(s): ${name}` }],
      summary: [`Runs 1 skill(s): ${name}`],
      undeclared: [],
      derivedFrom: ["test fixture"],
    },
    validation: { entryName: name, ok: true, issues: [] },
    attestation: {
      algorithm: "ed25519",
      contentHash: "a".repeat(64),
      signature: "c2ln",
      publicKeyPem: "pem",
      signedAt: "2026-11-10T00:00:00.000Z",
    },
    filesHashed: [".claude-plugin/plugin.json"],
    status: "listed",
    ingestedAt: "2026-11-10T00:00:00.000Z",
    ...rest,
  };
}

test("renderer regression: components.commands as a bare string renders, never throws", () => {
  const r = record({ id: "aaron-he-zhu/aaron-marketing" });
  (r.components as unknown as Record<string, unknown>).commands = "./commands/";
  let html = "";
  assert.doesNotThrow(() => { html = renderSkillPage(r); });
  assert.ok(html.includes("<strong>Commands</strong> — ./commands/"), "commands row renders the string as one component");
  assert.doesNotThrow(() => skillCard(r));
  assert.doesNotThrow(() => trendingScore(r));
  assert.doesNotThrow(() => renderHome([r]));
  assert.doesNotThrow(() => renderProfile("aaron-he-zhu", [r]));
});

test("renderer tolerance: every stored collection malformed at once still renders", () => {
  const r = record({ id: "bad/shapes" });
  const raw = r as unknown as Record<string, unknown>;
  raw.components = { skills: "one", commands: { dir: "./c" }, agents: 7, hooks: "yes", mcpServers: null };
  raw.declaration = { lines: "nope", summary: "nope", undeclared: "nope", derivedFrom: { x: 1 } };
  raw.validation = { entryName: "shapes", ok: true, issues: "nope" };
  raw.filesHashed = "plugin.json";
  let html = "";
  assert.doesNotThrow(() => { html = renderSkillPage(r); });
  assert.ok(html.includes("No validation issues"), "malformed issues degrade to the clean state");
  assert.doesNotThrow(() => skillCard(r));
  assert.doesNotThrow(() => trendingScore(r));
});

test("renderer tolerance: components object missing entirely still renders", () => {
  const r = record({ id: "bad/nocomponents" });
  (r as unknown as Record<string, unknown>).components = undefined;
  assert.doesNotThrow(() => renderSkillPage(r));
  assert.doesNotThrow(() => skillCard(r));
});

// ---------------------------------------------------------------------
// Ingest end-to-end: bare-string entry collections are stored as arrays
// ---------------------------------------------------------------------

function testKey(): RegistryKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function fakeRepoFetch(files: Record<string, string>): FetchFn {
  return async (url) => {
    if (url === "https://api.github.com/repos/acme/widgets") {
      const body = { default_branch: "main" };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    if (url.startsWith("https://api.github.com/repos/acme/widgets/git/trees/")) {
      const body = { tree: Object.keys(files).map((path) => ({ path, type: "blob", size: 10 })), truncated: false };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    const rawPrefix = "https://raw.githubusercontent.com/acme/widgets/main/";
    if (url.startsWith(rawPrefix)) {
      const path = url.slice(rawPrefix.length);
      if (path in files) {
        return { ok: true, status: 200, text: async () => files[path], json: async () => ({}) };
      }
    }
    return { ok: false, status: 404, text: async () => "not found", json: async () => ({ message: "not found" }) };
  };
}

test("ingest: marketplace entry with bare-string commands/skills/agents stores arrays", async () => {
  const marketplace = {
    name: "acme",
    plugins: [{
      name: "marketer",
      description: "Marketing plugin with string-shaped component fields.",
      source: "./",
      skills: "./skills/",
      commands: "./commands/",
      agents: "./agents/",
    }],
  };
  const pluginJson = { name: "marketer", version: "1.0.0", description: "Marketing plugin." };
  const fetchFn = fakeRepoFetch({
    ".claude-plugin/marketplace.json": JSON.stringify(marketplace),
    ".claude-plugin/plugin.json": JSON.stringify(pluginJson),
  });
  const s = await ingestGithubRepo("acme/widgets", { registryKey: testKey(), fetchFn });
  assert.equal(s.deadLetter, 0, JSON.stringify(s.deadLetters));
  assert.equal(s.records.length, 1);
  const r = s.records[0];
  assert.deepEqual(r.components.commands, ["./commands/"]);
  assert.deepEqual(r.components.agents, ["./agents/"]);
  assert.ok(r.components.skills.includes("./skills/"));
  for (const k of ["skills", "commands", "agents", "mcpServers"] as const) {
    assert.ok(Array.isArray(r.components[k]), `${k} stored as an array`);
  }
  // And the stored record renders.
  assert.doesNotThrow(() => renderSkillPage(r));
});
