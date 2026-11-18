import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { scanGithubRepoSkills } from "../src/repo-scan.js";
import { ingestGithubRepo } from "../src/ingest.js";
import type { RegistryKey } from "../src/attest.js";
import type { FetchFn } from "../src/types.js";

function testKey(): RegistryKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

interface FakeTreeItem { path: string; type: string; size: number }

/** Serves repo metadata, one recursive tree, and raw files for acme/widgets@main. */
function fakeRepoFetch(tree: FakeTreeItem[], files: Record<string, string>): FetchFn {
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
      if (path in files) {
        return { ok: true, status: 200, text: async () => files[path], json: async () => ({}) };
      }
    }
    return { ok: false, status: 404, text: async () => "not found", json: async () => ({ message: "not found" }) };
  };
}

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n# body\n`;

test("repo scan: two standalone skills — frontmatter name wins in one, dir name in the other", async () => {
  const fetchFn = fakeRepoFetch(
    [
      { path: "README.md", type: "blob", size: 10 },
      { path: "skills/alpha/SKILL.md", type: "blob", size: 100 },
      { path: "skills/alpha/notes.md", type: "blob", size: 50 },
      { path: "skills/beta/SKILL.md", type: "blob", size: 100 },
    ],
    {
      "skills/alpha/SKILL.md": skillMd("alpha-pro", "Alpha skill does alpha things."),
      "skills/alpha/notes.md": "alpha notes",
      "skills/beta/SKILL.md": skillMd("Beta Skill", "Beta skill does beta things."),
    },
  );
  const s = await scanGithubRepoSkills("acme/widgets", { registryKey: testKey(), fetchFn });
  assert.equal(s.total, 2);
  assert.equal(s.ok, 2);
  assert.equal(s.deadLetter, 0);
  const byId = new Map(s.records.map((r) => [r.id, r]));
  // Frontmatter name "alpha-pro" (clean slug) wins over the directory name.
  const alpha = byId.get("acme/alpha-pro");
  assert.ok(alpha);
  assert.equal(alpha.owner, "acme");
  assert.equal(alpha.kind, "skill");
  assert.equal(alpha.sourceType, "github");
  assert.equal(alpha.sourceRepo, "acme/widgets");
  assert.equal(alpha.sourcePath, "skills/alpha");
  assert.equal(alpha.source, "skills/alpha");
  assert.equal(alpha.sourceMarketplace, "direct-repo-scan:acme/widgets");
  assert.equal(alpha.pointerOnly, false);
  assert.equal(alpha.ref, "main");
  assert.ok(alpha.filesHashed.includes("skills/alpha/SKILL.md"));
  assert.ok(alpha.filesHashed.includes("skills/alpha/notes.md")); // sibling hashed too
  assert.ok(alpha.attestation);
  // Frontmatter name "Beta Skill" is not a clean slug → directory name is used.
  const beta = byId.get("acme/beta");
  assert.ok(beta);
  assert.equal(beta.name, "beta");
  assert.equal(beta.sourcePath, "skills/beta");
});

test("repo scan: SKILL.md without frontmatter dead-letters, the other skill still ingests", async () => {
  const fetchFn = fakeRepoFetch(
    [
      { path: "skills/bad/SKILL.md", type: "blob", size: 20 },
      { path: "skills/good/SKILL.md", type: "blob", size: 100 },
    ],
    {
      "skills/bad/SKILL.md": "# Just a heading, no frontmatter\n",
      "skills/good/SKILL.md": skillMd("good", "Good skill."),
    },
  );
  const s = await scanGithubRepoSkills("acme/widgets", { registryKey: testKey(), fetchFn });
  assert.equal(s.ok, 1);
  assert.equal(s.deadLetter, 1);
  assert.equal(s.records[0].id, "acme/good");
  assert.equal(s.deadLetters[0].entryName, "bad");
  assert.match(s.deadLetters[0].reason, /frontmatter/);
});

test("repo scan: duplicate resolved names — first kept, second dead-lettered", async () => {
  const fetchFn = fakeRepoFetch(
    [
      { path: "skills/one/SKILL.md", type: "blob", size: 100 },
      { path: "skills/two/SKILL.md", type: "blob", size: 100 },
    ],
    {
      "skills/one/SKILL.md": skillMd("dup", "First dup."),
      "skills/two/SKILL.md": skillMd("dup", "Second dup."),
    },
  );
  const s = await scanGithubRepoSkills("acme/widgets", { registryKey: testKey(), fetchFn });
  assert.equal(s.ok, 1);
  assert.equal(s.deadLetter, 1);
  assert.equal(s.records[0].sourcePath, "skills/one");
  assert.equal(s.deadLetters[0].entryName, "dup");
  assert.match(s.deadLetters[0].reason, /duplicate skill name in repo scan/);
});

test("repo scan: root SKILL.md falls back to the repo name when the frontmatter name is not a clean slug", async () => {
  const fetchFn = fakeRepoFetch(
    [
      { path: "LICENSE", type: "blob", size: 20 },
      { path: "SKILL.md", type: "blob", size: 100 },
    ],
    {
      "SKILL.md": skillMd("Widgets Root", "Root skill for the widgets repo."),
      "LICENSE": "MIT",
    },
  );
  const s = await scanGithubRepoSkills("acme/widgets", { registryKey: testKey(), fetchFn });
  assert.equal(s.ok, 1);
  const r = s.records[0];
  assert.equal(r.id, "acme/widgets");
  assert.equal(r.source, "./");
  assert.equal(r.sourcePath, "");
  assert.ok(r.filesHashed.includes("SKILL.md"));
  assert.ok(r.filesHashed.includes("LICENSE")); // root sibling hashed
});

test("ingest fallback trigger: missing marketplace.json yields total=0 with the note the CLI keys on", async () => {
  const fetchFn: FetchFn = async () => ({
    ok: false, status: 404,
    text: async () => "not found",
    json: async () => ({ message: "not found" }),
  });
  const s = await ingestGithubRepo("acme/widgets", { registryKey: testKey(), fetchFn });
  assert.equal(s.total, 0);
  assert.ok(s.note?.startsWith("marketplace.json not found"));
});
