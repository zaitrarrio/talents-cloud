// Description-extraction defect (found 2026-11-11): the frontmatter
// parser had no YAML block-scalar support, so `description: |` / `>`
// values were stored with the indicator as debris ("| Routes any…",
// 1,585 listed records), and literal debris descriptions a source
// carries (`description: ---` in dnyoussef/context-cascade) were stored
// verbatim. These tests pin the parser fix, the usability guard, the
// body fallthrough chain, and re-ingest updating an existing record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { RegistryKey } from "../src/attest.js";
import type { FetchFn } from "../src/types.js";
import {
  parseSkillFrontmatter, isUsableDescription, usableDescription, bodyDescription,
} from "../src/validate.js";
import { scanGithubRepoSkills } from "../src/repo-scan.js";
import { ingestSource } from "../src/discovery/pipeline.js";
import { InMemoryDiscoveryStore, type SourceRow } from "../src/discovery/store.js";

function testKey(): RegistryKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

// ---------------------------------------------------------------------
// Parser: block scalars
// ---------------------------------------------------------------------

test("parser: literal block scalar yields the text, not the '|' indicator", () => {
  const md = [
    "---",
    "name: xhs-auth",
    "description: |",
    "  小红书认证管理技能。检查登录状态、登录（二维码或手机号）、退出登录。",
    "  当用户要求登录小红书、检查登录状态、退出登录时触发。",
    "version: 2.0.0",
    "---",
    "# body",
  ].join("\n");
  const { frontmatter, issue } = parseSkillFrontmatter(md);
  assert.equal(issue, undefined);
  assert.equal(
    frontmatter?.description,
    "小红书认证管理技能。检查登录状态、登录（二维码或手机号）、退出登录。\n当用户要求登录小红书、检查登录状态、退出登录时触发。",
  );
  // The following key is parsed as a key, not swallowed into the scalar.
  assert.equal((frontmatter as unknown as Record<string, unknown>)?.version, "2.0.0");
});

test("parser: folded block scalar folds wrapped lines into one line", () => {
  const md = [
    "---",
    "name: router",
    "description: >",
    "  Routes any game-development request to the right specialized",
    "  skill(s): it detects the engine and the task, then reads the",
    "  chosen skill before acting.",
    "---",
  ].join("\n");
  const { frontmatter } = parseSkillFrontmatter(md);
  assert.equal(
    frontmatter?.description,
    "Routes any game-development request to the right specialized skill(s): it detects the engine and the task, then reads the chosen skill before acting.",
  );
});

test("parser: block scalar chomping and indent indicators", () => {
  const strip = parseSkillFrontmatter("---\nname: a\ndescription: |-\n  Line one\n  Line two\n---\n");
  assert.equal(strip.frontmatter?.description, "Line one\nLine two");
  const indented = parseSkillFrontmatter("---\nname: a\ndescription: |2\n  Line one\n   Line two\n---\n");
  assert.equal(indented.frontmatter?.description, "Line one\n Line two");
  const foldedStrip = parseSkillFrontmatter("---\nname: a\ndescription: >-\n  Folded one\n  folded two\n---\n");
  assert.equal(foldedStrip.frontmatter?.description, "Folded one folded two");
});

test("parser: plain, quoted and continuation scalars are unchanged", () => {
  const plain = parseSkillFrontmatter("---\nname: a\ndescription: A plain description.\n---\n");
  assert.equal(plain.frontmatter?.description, "A plain description.");
  const quoted = parseSkillFrontmatter('---\nname: a\ndescription: "A quoted description."\n---\n');
  assert.equal(quoted.frontmatter?.description, "A quoted description.");
  const cont = parseSkillFrontmatter("---\nname: a\ndescription: A long description that\n  continues on a second line.\n---\n");
  assert.equal(cont.frontmatter?.description, "A long description that continues on a second line.");
});

test("parser: the defect fixtures parse faithfully — the guard, not the parser, rejects them", () => {
  // dnyoussef/context-cascade writes `description: ---` literally.
  const dash = parseSkillFrontmatter("---\nname: agentdb\ndescription: ---\nallowed-tools: Read\n---\n");
  assert.equal(dash.frontmatter?.description, "---");
  assert.equal(isUsableDescription(dash.frontmatter?.description), false);
  // shivamchopra7's file carries a banner rule as the description value.
  const banner = parseSkillFrontmatter("---\nname: agent-creation\ndescription: /============================================================================/\n---\n");
  assert.equal(isUsableDescription(banner.frontmatter?.description), false);
});

// ---------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------

test("guard: debris is unusable, real content in any script is usable", () => {
  for (const bad of ["", "   ", "---", "***", "…", "___", "/====/", "|", ">", "| ", "- - -"]) {
    assert.equal(isUsableDescription(bad), false, JSON.stringify(bad));
  }
  for (const good of ["Use this skill when…", "小红书认证管理技能", "42", "A", "PDF tools — merge, split, OCR"]) {
    assert.equal(isUsableDescription(good), true, JSON.stringify(good));
  }
  assert.equal(isUsableDescription(undefined), false);
  assert.equal(isUsableDescription(null), false);
  assert.equal(isUsableDescription(42), false);
});

test("guard: usableDescription returns the first usable candidate", () => {
  assert.equal(usableDescription("---", "Real description."), "Real description.");
  assert.equal(usableDescription("", null, undefined), "");
  assert.equal(usableDescription("  Padded description.  "), "Padded description.");
  assert.equal(usableDescription(undefined, "小红书技能"), "小红书技能");
});

// ---------------------------------------------------------------------
// Body fallthrough
// ---------------------------------------------------------------------

test("body: first heading wins for the '---' fixture shape", () => {
  const md = "---\nname: agentdb-semantic-vector-search\ndescription: ---\n---\n\n# AgentDB Semantic Vector Search\n\n\n\n---\n\n## LIBRARY-FIRST PROTOCOL (MANDATORY)\n";
  assert.equal(bodyDescription(md), "AgentDB Semantic Vector Search");
});

test("body: banner-comment paragraphs are unwrapped, debris lines skipped", () => {
  const md = [
    "---",
    "name: agent-creation",
    "description: /============================================================================/",
    "---",
    "",
    "/*============================================================================*/",
    "/* AGENT-CREATION SKILL :: VERILINGUA x VERIX EDITION                      */",
    "/*============================================================================*/",
    "",
  ].join("\n");
  assert.equal(bodyDescription(md), "AGENT-CREATION SKILL :: VERILINGUA x VERIX EDITION");
});

test("body: first usable paragraph when there is no heading; null when nothing usable", () => {
  assert.equal(
    bodyDescription("---\nname: a\ndescription: ---\n---\n\nSome opening paragraph\nspanning two lines.\n\n## Later\n"),
    "Some opening paragraph spanning two lines.",
  );
  assert.equal(bodyDescription("---\nname: a\ndescription: ---\n---\n\n---\n\n***\n"), null);
  assert.equal(bodyDescription("---\nname: a\ndescription: x\n---\n"), null);
});

// ---------------------------------------------------------------------
// Repo scan end-to-end (the path all affected records took)
// ---------------------------------------------------------------------

interface FakeTreeItem { path: string; type: string; size: number }

function fakeRepoFetch(files: Record<string, string>): FetchFn {
  const tree: FakeTreeItem[] = Object.keys(files).map((path) => ({ path, type: "blob", size: 100 }));
  return async (url) => {
    if (url === "https://api.github.com/repos/acme/widgets") {
      const body = { default_branch: "main" };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    if (url.startsWith("https://api.github.com/repos/acme/widgets/git/trees/")) {
      const body = { tree, truncated: false };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    const rawPrefix = "https://raw.githubusercontent.com/acme/widgets/main/";
    if (url.startsWith(rawPrefix)) {
      const path = url.slice(rawPrefix.length);
      if (path in files) return { ok: true, status: 200, text: async () => files[path], json: async () => ({}) };
    }
    return { ok: false, status: 404, text: async () => "not found", json: async () => ({ message: "not found" }) };
  };
}

test("repo scan: '---' frontmatter description falls through to the body heading", async () => {
  const md = "---\nname: agentdb-semantic-vector-search\ndescription: ---\nallowed-tools: Read, Write\n---\n\n# AgentDB Semantic Vector Search\n\n## LIBRARY-FIRST PROTOCOL\n";
  const s = await scanGithubRepoSkills("acme/widgets", {
    registryKey: testKey(),
    fetchFn: fakeRepoFetch({ "skills/agentdb/SKILL.md": md }),
  });
  assert.equal(s.ok, 1);
  assert.equal(s.records[0].description, "AgentDB Semantic Vector Search");
});

test("repo scan: block-scalar description is stored clean", async () => {
  const md = "---\nname: router\ndescription: >\n  Routes any request to the right\n  specialized skill before acting.\n---\n# Router\n";
  const s = await scanGithubRepoSkills("acme/widgets", {
    registryKey: testKey(),
    fetchFn: fakeRepoFetch({ "router/SKILL.md": md }),
  });
  assert.equal(s.ok, 1);
  assert.equal(s.records[0].description, "Routes any request to the right specialized skill before acting.");
});

test("repo scan: debris description with no usable body stores an honest empty description", async () => {
  const md = "---\nname: bare\ndescription: ---\n---\n\n---\n";
  const s = await scanGithubRepoSkills("acme/widgets", {
    registryKey: testKey(),
    fetchFn: fakeRepoFetch({ "bare/SKILL.md": md }),
  });
  assert.equal(s.ok, 1);
  assert.equal(s.records[0].description, "");
});

// ---------------------------------------------------------------------
// Re-ingest updates an existing record
// ---------------------------------------------------------------------

const sourceRow = (recordCount = 0): SourceRow => ({
  kind: "skill-repo",
  locator: "acme/widgets",
  url: "https://github.com/acme/widgets",
  discoveredVia: "test",
  status: "verified",
  reason: null,
  firstSeen: "2026-11-11T00:00:00.000Z",
  lastSeen: "2026-11-11T00:00:00.000Z",
  lastIngested: null,
  recordCount,
  provenance: [{ via: "test", at: "2026-11-11T00:00:00.000Z" }],
  priority: 0,
});

test("ingestSource: re-ingest refreshes a changed record and skips an identical one", async () => {
  const store = new InMemoryDiscoveryStore();
  const key = testKey();
  const v1 = "---\nname: widget\ndescription: ---\n---\n\n# Widget Thing\n";
  const fetchV1 = fakeRepoFetch({ "widget/SKILL.md": v1 });
  const first = await ingestSource({ store, registryKey: key, fetchFn: fetchV1 }, sourceRow());
  assert.equal(first.newRecords, 1);
  assert.equal((await store.getRecord("acme/widget"))?.description, "Widget Thing");

  // Same source bytes, but the stored record carries the pre-fix debris
  // description (the production repair scenario): the rebuild differs
  // only in description and must still replace the stored record.
  const stored = await store.getRecord("acme/widget");
  await store.upsertRecord({ ...stored!, description: "---" });
  const repaired = await ingestSource({ store, registryKey: key, fetchFn: fetchV1 }, sourceRow(1));
  assert.equal(repaired.newRecords, 0);
  assert.equal(repaired.existingUpdated, 1);
  assert.equal(repaired.existingSkipped, 0);
  assert.equal((await store.getRecord("acme/widget"))?.description, "Widget Thing");

  // Identical re-ingest: untouched, counted as skipped.
  const again = await ingestSource({ store, registryKey: key, fetchFn: fetchV1 }, sourceRow(1));
  assert.equal(again.existingUpdated, 0);
  assert.equal(again.existingSkipped, 1);

  // Source actually changes: hash + description change → updated.
  const v2 = "---\nname: widget\ndescription: A real widget description.\n---\n\n# Widget Thing\n";
  const changed = await ingestSource({ store, registryKey: key, fetchFn: fakeRepoFetch({ "widget/SKILL.md": v2 }) }, sourceRow(1));
  assert.equal(changed.existingUpdated, 1);
  assert.equal((await store.getRecord("acme/widget"))?.description, "A real widget description.");
});
