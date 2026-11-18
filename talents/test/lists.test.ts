// List-source tests (ARCHITECTURE-v2 §7): link extraction +
// normalization, section attribution, the ≥10-repo bar, per-list
// corroboration channels, classification (records win / tree wins /
// bar), mining (nominations only — never records), refresh
// semantics (removals ignored, graduation when skills appear), the
// never-ingest guard, and the runner's claim resolution + rejection
// rescue. All network is faked; all stores are in-memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { FetchFn, SkillRecord } from "../src/types.js";
import type { RegistryKey } from "../src/attest.js";
import { InMemoryDiscoveryStore, mergeNomination, type SourceRow } from "../src/discovery/store.js";
import { Pacer } from "../src/discovery/sweep.js";
import {
  classifyAsList, countRepoLocators, extractListLinks, mineListSource,
  nominateListLinks, passesListBar, refreshListSource, selectMarkdownPaths,
  LIST_MIN_REPO_LINKS,
} from "../src/discovery/lists.js";
import { ingestSource } from "../src/discovery/pipeline.js";
import { runScoutNominations } from "../src/discovery/scouts/runner.js";
import type { ScoutResult } from "../src/discovery/scouts/types.js";

function testKey(): RegistryKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
const key = testKey();
const fastPacer = () => new Pacer(0, async () => {}, () => 0);
const resp = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});
const AT = "2026-11-11T10:00:00.000Z";
const now = () => new Date(AT);

// ---------------------------------------------------------------------------
// Fake GitHub world: repos with trees + raw files
// ---------------------------------------------------------------------------

interface FakeRepo { tree: string[]; files: Record<string, string>; branch?: string }

function worldFake(repos: Map<string, FakeRepo>): FetchFn {
  return async (url) => {
    let m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\/[^?]+/);
    if (m) {
      const r = repos.get(m[1]);
      if (!r) return resp(404, { message: "nf" });
      return resp(200, { tree: r.tree.map((path) => ({ path, type: "blob" })), truncated: false });
    }
    m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/);
    if (m) {
      const r = repos.get(m[1]);
      if (!r) return resp(404, { message: "nf" });
      return resp(200, { default_branch: r.branch ?? "main" });
    }
    m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/[^/]+\/(.+)$/);
    if (m) {
      const text = repos.get(m[1])?.files[m[2]];
      if (text === undefined) return resp(404, "nf");
      return resp(200, text);
    }
    return resp(404, { message: "nf" });
  };
}

const repoLinks = (n: number, prefix = "acme/tool"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

function listReadme(repos: string[], heading = "Tools"): string {
  return [
    "# Awesome Things",
    "",
    `## ${heading}`,
    ...repos.map((r) => `- [${r}](https://github.com/${r}) — a thing`),
    "",
  ].join("\n");
}

function listRepoWorld(locator: string, repos: string[], extra: Partial<FakeRepo> = {}): Map<string, FakeRepo> {
  return new Map([[locator, {
    tree: ["README.md", "LICENSE"],
    files: { "README.md": listReadme(repos) },
    ...extra,
  }]]);
}

function rejectedRow(locator: string): SourceRow {
  return {
    kind: "skill-repo", locator, url: `https://github.com/${locator}`,
    discoveredVia: "web-search", status: "rejected",
    reason: "no marketplace.json, SKILL.md, or plugin.json in tree",
    firstSeen: AT, lastSeen: AT, lastIngested: null, recordCount: 0,
    provenance: [{ via: "web-search", at: AT }], priority: 0,
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test("lists: extraction normalizes GitHub URLs (anchors, suffixes, .git, punctuation)", () => {
  const md = [
    "# L",
    "## S",
    "- [a](https://github.com/Acme/Widgets#readme)",
    "- bare https://github.com/acme/gadgets.",
    "- [t](https://github.com/acme/deep/tree/main/skills/x)",
    "- [b](https://github.com/acme/blobby/blob/main/SKILL.md)",
    "- [g](https://github.com/acme/gitty.git)",
    "- dup [a2](https://github.com/acme/widgets)",
  ].join("\n");
  const links = extractListLinks([{ path: "README.md", text: md }], "me/list");
  assert.deepEqual(links.map((l) => l.locator), [
    "acme/widgets", "acme/gadgets", "acme/deep", "acme/blobby", "acme/gitty",
  ]);
  assert.ok(links.every((l) => l.kind === "skill-repo" && l.section === "S"));
});

test("lists: extraction excludes self, site pages, profiles, and reserved owners", () => {
  const md = [
    "# L",
    "- [self](https://github.com/me/list)",
    "- [topics](https://github.com/topics/claude)",
    "- [mkt](https://github.com/marketplace/actions)",
    "- [profile](https://github.com/someuser)",
    "- [feat](https://github.com/features/actions)",
    "- [real](https://github.com/real/repo)",
  ].join("\n");
  const links = extractListLinks([{ path: "README.md", text: md }], "me/list");
  assert.deepEqual(links.map((l) => l.locator), ["real/repo"]);
});

test("lists: marketplace.json links classify + upgrade; npm links parse (scoped too)", () => {
  const md = [
    "# L",
    "- [plain](https://github.com/acme/market)",
    "- [file](https://github.com/acme/market/blob/main/.claude-plugin/marketplace.json)",
    "- [raw](https://raw.githubusercontent.com/acme/rawmkt/main/.claude-plugin/marketplace.json)",
    "- [pkg](https://www.npmjs.com/package/some-pkg)",
    "- [scoped](https://www.npmjs.com/package/@acme/scoped-pkg)",
  ].join("\n");
  const links = extractListLinks([{ path: "README.md", text: md }], "me/list");
  const byLoc = new Map(links.map((l) => [l.locator, l.kind]));
  assert.equal(byLoc.get("acme/market"), "marketplace"); // upgraded by the later file link
  assert.equal(byLoc.get("acme/rawmkt"), "marketplace");
  assert.equal(byLoc.get("some-pkg"), "npm-package");
  assert.equal(byLoc.get("@acme/scoped-pkg"), "npm-package");
});

test("lists: section attribution — nearest preceding heading, cleaned; none before first heading", () => {
  const md = [
    "Preamble link https://github.com/first/nohead",
    "# Top",
    "## **Databases** and [stores](https://example.com)",
    "- [a](https://github.com/acme/db1)",
    "### Sub area",
    "- [b](https://github.com/acme/db2)",
    "## Games",
    "- [c](https://github.com/acme/game1)",
  ].join("\n");
  const links = extractListLinks([{ path: "README.md", text: md }], "me/list");
  const sectionOf = new Map(links.map((l) => [l.locator, l.section]));
  assert.equal(sectionOf.get("first/nohead"), "");
  assert.equal(sectionOf.get("acme/db1"), "Databases and stores");
  assert.equal(sectionOf.get("acme/db2"), "Sub area");
  assert.equal(sectionOf.get("acme/game1"), "Games");
});

test("lists: the bar counts distinct repos only — duplicates and npm links do not inflate it", () => {
  const nine = repoLinks(LIST_MIN_REPO_LINKS - 1);
  const mdNine = listReadme([...nine, nine[0], nine[1]]) +
    Array.from({ length: 12 }, (_, i) => `- [p](https://www.npmjs.com/package/pkg${i})`).join("\n");
  const linksNine = extractListLinks([{ path: "README.md", text: mdNine }], "me/list");
  assert.equal(countRepoLocators(linksNine), LIST_MIN_REPO_LINKS - 1);
  assert.equal(passesListBar(linksNine), false);
  const linksTen = extractListLinks(
    [{ path: "README.md", text: listReadme(repoLinks(LIST_MIN_REPO_LINKS)) }],
    "me/list",
  );
  assert.equal(passesListBar(linksTen), true);
});

test("lists: selectMarkdownPaths takes root + docs markdown, README first, capped", () => {
  const picked = selectMarkdownPaths([
    "src/index.ts", "docs/guide.md", "README.md", "CHANGELOG.md",
    "docs/deep/more.md", "packages/x/README.md", "notes.txt",
  ]);
  assert.deepEqual(picked, ["README.md", "CHANGELOG.md", "docs/deep/more.md", "docs/guide.md"]);
});

// ---------------------------------------------------------------------------
// Corroboration: each list is its own channel
// ---------------------------------------------------------------------------

test("lists: two different lists corroborate; the same list twice does not", async () => {
  const store = new InMemoryDiscoveryStore();
  const at = AT;
  const input = (list: string) => ({
    kind: "skill-repo" as const,
    locator: "acme/widgets",
    url: "https://github.com/acme/widgets",
    discoveredVia: "list",
    provenance: { via: "list", at, list, section: "Tools" },
    priorityDelta: 2,
  });
  const r1 = mergeNomination(null, input("alice/awesome-a"), at);
  assert.equal(r1.created, true);
  const r2 = mergeNomination(r1.row, input("alice/awesome-a"), at);
  assert.equal(r2.corroborated, false); // same list again: no new channel
  const r3 = mergeNomination(r2.row, input("bob/awesome-b"), at);
  assert.equal(r3.corroborated, true); // a second list IS corroboration
  assert.equal(r3.row.provenance.length, 3);
  void store;
});

// ---------------------------------------------------------------------------
// Classification + mining end-to-end (in-memory store, fake GitHub)
// ---------------------------------------------------------------------------

test("lists: a link-dense no-skill repo classifies, converts, and mines — and writes NO records", async () => {
  const store = new InMemoryDiscoveryStore();
  const targets = repoLinks(12);
  const fetchFn = worldFake(listRepoWorld("travisvn/awesome-claude-skills", targets));
  const deps = { store, fetchFn, pacer: fastPacer(), now };
  const outcome = await classifyAsList(deps, rejectedRow("travisvn/awesome-claude-skills"));
  assert.equal(outcome.isList, true);
  assert.equal(outcome.mine?.created, 12);
  assert.equal(outcome.mine?.repoLocators, 12);

  // The old rejected row is gone; the canonical list row is mined.
  assert.equal(await store.getSource("skill-repo", "travisvn/awesome-claude-skills"), null);
  const listRow = await store.getSource("list", "travisvn/awesome-claude-skills");
  assert.equal(listRow?.status, "mined");
  assert.equal(listRow?.recordCount, 0);

  // Candidates carry {via:list, list, section} provenance.
  const cand = await store.getSource("skill-repo", "acme/tool1");
  assert.equal(cand?.status, "candidate");
  const prov = cand?.provenance.find((p) => p.via === "list");
  assert.equal(prov?.list, "travisvn/awesome-claude-skills");
  assert.equal(prov?.section, "Tools");

  // HARD RULE: no records, ever.
  assert.equal((await store.existingRecordIds()).size, 0);
});

test("lists: a repo whose tree has skill files is NOT a list (records win at classification)", async () => {
  const store = new InMemoryDiscoveryStore();
  const world = listRepoWorld("acme/skillful", repoLinks(12), {
    tree: ["README.md", "skills/x/SKILL.md"],
  });
  const outcome = await classifyAsList(
    { store, fetchFn: worldFake(world), pacer: fastPacer(), now },
    rejectedRow("acme/skillful"),
  );
  assert.equal(outcome.isList, false);
  assert.equal(outcome.graduatedKind, "skill-repo");
  assert.equal(await store.getSource("list", "acme/skillful"), null);
});

test("lists: a repo that already has records is never reclassified", async () => {
  const store = new InMemoryDiscoveryStore();
  await store.upsertRecord({ id: "acme/hasrecords-x", sourceRepo: "acme/hasrecords" } as unknown as SkillRecord);
  const world = listRepoWorld("acme/hasrecords", repoLinks(12));
  const outcome = await classifyAsList(
    { store, fetchFn: worldFake(world), pacer: fastPacer(), now },
    rejectedRow("acme/hasrecords"),
  );
  assert.equal(outcome.isList, false);
  assert.match(outcome.reason, /records win/);
});

test("lists: below the bar stays a plain rejection (row untouched, no candidates)", async () => {
  const store = new InMemoryDiscoveryStore();
  const world = listRepoWorld("acme/thin", repoLinks(4));
  const row = rejectedRow("acme/thin");
  const outcome = await classifyAsList(
    { store, fetchFn: worldFake(world), pacer: fastPacer(), now },
    row,
  );
  assert.equal(outcome.isList, false);
  assert.equal(await store.getSource("list", "acme/thin"), null);
  assert.equal((await store.listSources("candidate")).length, 0);
});

// ---------------------------------------------------------------------------
// Refresh semantics
// ---------------------------------------------------------------------------

test("lists: re-mining ignores removals — a dropped link's candidate is untouched", async () => {
  const store = new InMemoryDiscoveryStore();
  const world = listRepoWorld("me/awesome", repoLinks(11));
  const deps = { store, fetchFn: worldFake(world), pacer: fastPacer(), now };
  const outcome = await classifyAsList(deps, rejectedRow("me/awesome"));
  assert.equal(outcome.isList, true);
  const before = await store.getSource("skill-repo", "acme/tool1");
  assert.equal(before?.status, "candidate");

  // The list drops tool1 and adds a new tool12.
  const repo = world.get("me/awesome")!;
  repo.files["README.md"] = listReadme([...repoLinks(10, "acme/tool").slice(1), "acme/tool99"]);
  const listRow = (await store.getSource("list", "me/awesome"))!;
  const refresh = await refreshListSource(deps, listRow);
  assert.equal(refresh.graduated, false);

  const after = await store.getSource("skill-repo", "acme/tool1");
  assert.equal(after?.status, "candidate"); // NOT unlisted, NOT demoted
  assert.equal(after?.provenance.some((p) => p.via === "list" && p.list === "me/awesome"), true);
  const added = await store.getSource("skill-repo", "acme/tool99");
  assert.equal(added?.status, "candidate"); // the new link entered the funnel
});

test("lists: refresh graduates a list that grew skill files (records win)", async () => {
  const store = new InMemoryDiscoveryStore();
  const world = listRepoWorld("me/awesome", repoLinks(11));
  const deps = { store, fetchFn: worldFake(world), pacer: fastPacer(), now };
  await classifyAsList(deps, rejectedRow("me/awesome"));
  world.get("me/awesome")!.tree = ["README.md", "skills/new/SKILL.md"];
  const listRow = (await store.getSource("list", "me/awesome"))!;
  const refresh = await refreshListSource(deps, listRow);
  assert.equal(refresh.graduated, true);
  assert.equal(refresh.kind, "skill-repo");
  assert.equal(await store.getSource("list", "me/awesome"), null);
  const graduated = await store.getSource("skill-repo", "me/awesome");
  assert.equal(graduated?.status, "verified");
});

// ---------------------------------------------------------------------------
// The never-ingest guard + mining idempotence
// ---------------------------------------------------------------------------

test("lists: ingestSource refuses a list source, loudly", async () => {
  const store = new InMemoryDiscoveryStore();
  const listRow: SourceRow = { ...rejectedRow("me/awesome"), kind: "list", status: "mined" };
  await assert.rejects(
    () => ingestSource({ store, registryKey: key, fetchFn: worldFake(new Map()), pacer: fastPacer() }, listRow),
    /must never be ingested/,
  );
  assert.equal((await store.existingRecordIds()).size, 0);
});

test("lists: mining is idempotent — a second mine creates nothing new", async () => {
  const store = new InMemoryDiscoveryStore();
  const world = listRepoWorld("me/awesome", repoLinks(11));
  const deps = { store, fetchFn: worldFake(world), pacer: fastPacer(), now };
  await classifyAsList(deps, rejectedRow("me/awesome"));
  const listRow = (await store.getSource("list", "me/awesome"))!;
  const again = await mineListSource(deps, listRow);
  assert.equal(again.created, 0);
  assert.equal(again.corroborated, 0); // same list = same channel
  assert.equal(again.alreadyKnown, 11);
  const counts = await nominateListLinks(deps, listRow, [], AT);
  assert.equal(counts.nominated, 0);
});

// ---------------------------------------------------------------------------
// Runner integration: claims resolve, rejections get rescued
// ---------------------------------------------------------------------------

const scoutResult = (nominations: ScoutResult["nominations"]): ScoutResult => ({
  nominations,
  stats: { examined: nominations.length, nominated: nominations.length, skipped: 0, calls: 0, rateLimitHits: 0 },
});

test("lists: runner resolves a list claim by mining it (no verify, no ingest)", async () => {
  const store = new InMemoryDiscoveryStore();
  const world = listRepoWorld("me/awesome", repoLinks(11));
  const deps = {
    store, registryKey: key, fetchFn: worldFake(world),
    pacer: fastPacer(), now,
  };
  const stats = await runScoutNominations(deps, "web-search", scoutResult([{
    kind: "list", locator: "me/awesome", url: "https://github.com/me/awesome",
    provenance: { via: "web-search", at: AT },
  }]), { maxIngest: 5 });
  assert.equal(stats.listsClassified.length, 1);
  assert.equal(stats.rejected.length, 0);
  assert.equal(stats.newRecords, 0);
  assert.equal((await store.getSource("list", "me/awesome"))?.status, "mined");
  assert.equal((await store.listSources("candidate")).length, 11);
});

test("lists: runner discards a list claim when the repo carries skills (verified instead)", async () => {
  const store = new InMemoryDiscoveryStore();
  const world = listRepoWorld("acme/skillful", repoLinks(3), {
    tree: ["README.md", "skills/x/SKILL.md"],
  });
  const deps = {
    store, registryKey: key, fetchFn: worldFake(world),
    pacer: fastPacer(), now,
  };
  const stats = await runScoutNominations(deps, "web-search", scoutResult([{
    kind: "list", locator: "acme/skillful", url: "https://github.com/acme/skillful",
    provenance: { via: "web-search", at: AT },
  }]), { maxIngest: 0 });
  assert.equal(stats.listsClassified.length, 0);
  assert.equal(stats.verified, 1);
  const row = await store.getSource("skill-repo", "acme/skillful");
  assert.equal(row?.status, "verified");
  assert.equal(await store.getSource("list", "acme/skillful"), null);
});

test("lists: runner rescues a no-skill-files rejection into a mined list", async () => {
  const store = new InMemoryDiscoveryStore();
  const world = listRepoWorld("me/awesome", repoLinks(11));
  const deps = {
    store, registryKey: key, fetchFn: worldFake(world),
    pacer: fastPacer(), now,
  };
  const stats = await runScoutNominations(deps, "github-code-search", scoutResult([{
    kind: "skill-repo", locator: "me/awesome", url: "https://github.com/me/awesome",
    provenance: { via: "github-code-search", at: AT },
  }]), { maxIngest: 0 });
  assert.equal(stats.rejected.length, 0);
  assert.equal(stats.listsClassified.length, 1);
  assert.equal((await store.getSource("list", "me/awesome"))?.status, "mined");
});
