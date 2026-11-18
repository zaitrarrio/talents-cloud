// P1 tests — SSR pages (escaping, JSON-LD, routes) + search (document
// shape, re-rank, local engine typo tolerance) + a Typesense integration
// test that only runs when TALENTS_TYPESENSE_LIVE=1 (the gate sets it
// against the real dev server; everywhere else it skips cleanly).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { SkillRecord } from "../src/types.js";
import {
  esc, renderHome, renderSkillPage, renderProfile, skillJsonLd,
  createWebServer, depsFromRecords, trending,
} from "../src/web.js";
import {
  LocalSearchEngine, TypesenseSearchEngine, rerank, toSearchDocument,
  typesenseConfigFromEnv, type SearchQueryInput,
} from "../src/search.js";

function record(partial: Partial<SkillRecord> & { id: string }): SkillRecord {
  const { id, ...rest } = partial;
  const [owner, name] = id.split("/");
  return {
    id,
    owner,
    name,
    url: `https://talents.sh/skills/${partial.id}`,
    profileUrl: `https://talents.sh/${owner}`,
    kind: "skill",
    description: "",
    sourceType: "github",
    source: `./skills/${name}`,
    sourceRepo: `${owner}/repo`,
    sourcePath: `skills/${name}`,
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
    filesHashed: [`skills/${name}/SKILL.md`],
    status: "listed",
    ingestedAt: "2026-11-10T00:00:00.000Z",
    ...rest,
  };
}

const pdfSkill = () => record({
  id: "anthropics/pdf",
  description: "Use this skill whenever the user wants to do anything with PDF files. Reading, extracting text and tables, merging PDFs.",
});
const docSkills = () => record({
  id: "anthropics/document-skills",
  kind: "plugin",
  description: "Collection of document processing suite including Excel, Word, PowerPoint, and PDF capabilities",
  components: { skills: ["xlsx", "docx", "pptx", "pdf"], commands: [], agents: [], hooks: false, mcpServers: [] },
});
const securityPlugin = () => record({
  id: "42crunch-ai/42crunch-api-security-testing",
  kind: "plugin",
  name: "42crunch-api-security-testing",
  description: "Automate API security directly in Claude Code — audit OpenAPI specs, detect vulnerabilities.",
});
const fixtures = () => [pdfSkill(), docSkills(), securityPlugin()];

// --- escaping ---------------------------------------------------------------

test("esc escapes all HTML-significant characters", () => {
  assert.equal(esc(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(esc(null), "");
  assert.equal(esc(42), "42");
});

test("skill page escapes a malicious description (no raw markup, no script breakout)", () => {
  const evil = record({
    id: "evil/xss",
    description: `<script>alert(1)</script><img src=x onerror="alert(2)">`,
    declaration: {
      lines: [{ kind: "tool", text: `run <b>rm</b> "now"` }],
      summary: [`<svg onload=alert(3)>`],
      undeclared: [`</script><script>alert(4)</script>`],
      derivedFrom: ["fixture"],
    },
  });
  const html = renderSkillPage(evil);
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag leaked");
  assert.ok(!html.includes("<img src=x"), "raw img tag leaked");
  assert.ok(!html.includes("<svg onload"), "raw svg leaked");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "escaped form present");
  // The only <script> in the page is the JSON-LD block, and its payload parses.
  const scripts = html.match(/<script/g) ?? [];
  assert.equal(scripts.length, 1);
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, "JSON-LD block present");
  const ld = JSON.parse(m![1]);
  assert.equal(ld["@type"], "SoftwareApplication");
  assert.equal(ld.name, "evil/xss");
});

// --- JSON-LD ------------------------------------------------------------------

test("skillJsonLd is valid and carries name/url/category", () => {
  const ld = skillJsonLd(pdfSkill());
  assert.equal(ld["@context"], "https://schema.org");
  assert.equal(ld["@type"], "SoftwareApplication");
  assert.equal(ld.name, "anthropics/pdf");
  assert.equal(ld.url, "https://talents.sh/skills/anthropics/pdf");
  assert.equal(ld.applicationCategory, "DeveloperApplication");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(ld)));
});

test("rendered skill page contains JSON-LD, declaration, attestation and use-panel", () => {
  const html = renderSkillPage(pdfSkill());
  assert.ok(html.includes("application/ld+json"));
  assert.ok(html.includes("Provides 1 skill(s): pdf"));
  assert.ok(html.includes("a".repeat(64)), "attestation content hash rendered");
  assert.ok(html.includes("/plugin marketplace add talents"));
  assert.ok(html.includes("/plugin install anthropics/pdf"));
  assert.ok(html.includes("Use anthropics/pdf@main"));
  assert.ok(html.includes("Indexed in place"));
});

// --- pages --------------------------------------------------------------------

test("home renders trending cards with canonical URLs and attestation badge", () => {
  const html = renderHome(fixtures());
  assert.ok(html.includes("anthropics") && html.includes("pdf"));
  assert.ok(html.includes("talents.sh/skills/anthropics/pdf"));
  assert.ok(html.includes("✓ Attested"));
  assert.ok(html.includes('action="/search"'));
});

test("profile renders only that owner's records + namespace stats", () => {
  const html = renderProfile("anthropics", [pdfSkill(), docSkills()]);
  assert.ok(html.includes("talents.sh/anthropics"));
  assert.ok(html.includes("2 records"));
  assert.ok(!html.includes("42crunch"));
});

test("trending prefers substance and penalises warnings", () => {
  const rich = record({ id: "a/rich", filesHashed: ["1", "2", "3"] });
  const warned = record({
    id: "a/warned",
    filesHashed: ["1", "2", "3"],
    validation: { entryName: "warned", ok: true, issues: [{ severity: "warning", code: "w", message: "w" }] },
  });
  const top = trending([warned, rich], 2);
  assert.equal(top[0].id, "a/rich");
});

// --- HTTP routes (real server, injected store) --------------------------------

async function withServer(records: SkillRecord[], fn: (base: string) => Promise<void>): Promise<void> {
  const engine = new LocalSearchEngine();
  await engine.indexAll(records);
  const deps = depsFromRecords(records, (input: SearchQueryInput) => engine.search(input));
  const server = createWebServer(deps);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
}

test("routes: home 200, skill 200, profile 200, short URL 301, unknown 404", async () => {
  await withServer(fixtures(), async (base) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.ok((await home.text()).includes("pdf"));

    const skill = await fetch(`${base}/skills/anthropics/xlsx`.replace("xlsx", "pdf"));
    assert.equal(skill.status, 200);
    const skillHtml = await skill.text();
    assert.ok(skillHtml.includes("application/ld+json"));
    assert.ok(skillHtml.includes("a".repeat(64)));

    const profile = await fetch(`${base}/anthropics`);
    assert.equal(profile.status, 200);
    assert.ok((await profile.text()).includes("document-skills"));

    const short = await fetch(`${base}/s/anthropics/pdf`, { redirect: "manual" });
    assert.equal(short.status, 301);
    assert.equal(short.headers.get("location"), "/skills/anthropics/pdf");

    const missing = await fetch(`${base}/skills/nope/nothere`);
    assert.equal(missing.status, 404);
    const missingOwner = await fetch(`${base}/ghostowner`);
    assert.equal(missingOwner.status, 404);

    const search = await fetch(`${base}/search?q=pdf`);
    assert.equal(search.status, 200);
    assert.ok((await search.text()).includes("anthropics"));
  });
});

// --- search: document shape + rerank + local engine ----------------------------

test("toSearchDocument flattens components and carries facet fields", () => {
  const doc = toSearchDocument(record({
    id: "acme/tool",
    kind: "mcp",
    components: { skills: [], commands: ["run"], agents: [], hooks: true, mcpServers: ["srv-a"] },
  }));
  assert.equal(doc.owner, "acme");
  assert.equal(doc.kind, "mcp");
  assert.equal(doc.status, "listed");
  assert.ok(doc.components.includes("srv-a"));
  assert.ok(doc.components.includes("run"));
  assert.ok(doc.components.includes("hooks"));
  assert.ok(doc.declarationText.includes("Runs 1 skill(s)"));
});

test("rerank: exact name beats attested non-exact; attested beats unattested; fewer warnings wins ties", () => {
  const exact = record({ id: "z/pdf", attestation: null });
  const attested = record({ id: "a/pdf-tools" });
  // exact name match wins even without an attestation
  assert.equal(rerank([attested, exact], "pdf")[0].id, "z/pdf");
  // attestation beats no attestation when names tie on relevance
  const plain = record({ id: "a/pdfx", attestation: null });
  const signed = record({ id: "b/pdfx" });
  assert.equal(rerank([plain, signed], "pdfx")[0].id, "b/pdfx");
  // fewer warnings wins
  const warned = record({
    id: "a/pdfy",
    validation: { entryName: "pdfy", ok: true, issues: [{ severity: "warning", code: "w", message: "w" }] },
  });
  const clean = record({ id: "b/pdfy" });
  assert.equal(rerank([warned, clean], "pdfy")[0].id, "b/pdfy");
});

test("local engine: typo tolerance, facet filter, and the gate queries", async () => {
  const engine = new LocalSearchEngine();
  await engine.indexAll(fixtures());
  const pdf = await engine.search({ q: "pdf" });
  assert.ok(pdf.some((r) => r.id === "anthropics/pdf"));
  const typo = await engine.search({ q: "pdff" });
  assert.ok(typo.some((r) => r.id === "anthropics/pdf"), "typo 'pdff' still finds anthropics/pdf");
  const doc = await engine.search({ q: "document" });
  assert.ok(doc.some((r) => r.id === "anthropics/document-skills"));
  const sec = await engine.search({ q: "security" });
  assert.ok(sec.some((r) => r.id === "42crunch-ai/42crunch-api-security-testing"));
  const onlySkills = await engine.search({ q: "pdf", kind: "skill" });
  assert.ok(onlySkills.length > 0 && onlySkills.every((r) => r.kind === "skill"));
});

// --- Typesense integration (env-gated: runs in the P1 gate) --------------------

const LIVE = process.env.TALENTS_TYPESENSE_LIVE === "1";

test("typesense integration: real server answers the five gate queries", { skip: !LIVE }, async () => {
  const engine = new TypesenseSearchEngine(typesenseConfigFromEnv(), fixtures());
  assert.equal(await engine.healthy(), true);
  const n = await engine.indexAll(fixtures());
  assert.equal(n, 3);
  assert.equal(await engine.count(), 3);

  const pdf = await engine.search({ q: "pdf" });
  assert.equal(pdf[0]?.id, "anthropics/pdf");
  const doc = await engine.search({ q: "document" });
  assert.ok(doc.some((r) => r.id === "anthropics/document-skills"));
  const typo = await engine.search({ q: "pdff" });
  assert.ok(typo.some((r) => r.id === "anthropics/pdf"), "typesense typo tolerance: 'pdff' finds anthropics/pdf");
  const skillsOnly = await engine.search({ q: "pdf", kind: "skill" });
  assert.ok(skillsOnly.length > 0 && skillsOnly.every((r) => r.kind === "skill"));
  const sec = await engine.search({ q: "security" });
  assert.ok(sec.some((r) => r.id === "42crunch-ai/42crunch-api-security-testing"));
});
