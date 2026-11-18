// Creator Experience gate (P4) — LIVE half, run after
// scripts/gate-creator.mjs (local) and the production deploy:
//   * public smoke on https://talents.sh (home, search, "build
//     games", advisor, MCP gateway on mcp.talents.sh) — the creator
//     build must not regress any of it;
//   * auth state as deployed: no Clerk keys yet → /dashboard
//     redirects, /sign-in shows the honest setup state, /api/claims
//     401, /webhooks/stripe 503 (unconfigured, never unverified);
//   * the unlist fixture cycle on PRODUCTION D1: insert a synthetic
//     gate record (talents-gate/fixture-skill — created for this
//     gate, low-value by construction), prove it is visible, insert
//     an unlisted_skills row, prove page/search/aggregate exclusion,
//     then RESTORE fully (delete the unlist row AND the fixture
//     record + its FTS row) and prove the catalog is back to its
//     prior state.
// Appends its results into data/gate-creator.json + .txt.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const CF = resolve(ROOT, "cf");
const BASE = "https://talents.sh";
const MCP = "https://mcp.talents.sh/mcp";
const FIXTURE_ID = "talents-gate/fixture-skill";

const prior = JSON.parse(readFileSync(resolve(ROOT, "data/gate-creator.json"), "utf8"));
// Start from the LOCAL evidence only: strip any previous live
// section from the txt, and recompute the incoming pass from the
// local checks — a stale combined failure must not poison this run.
const priorTxt = readFileSync(resolve(ROOT, "data/gate-creator.txt"), "utf8");
const localTxt = priorTxt.split("== live (https://talents.sh) ==")[0].trimEnd();
const localPass = Object.values(prior.local ?? {}).every((c) => c.pass);
const lines = [localTxt, "", "== live (https://talents.sh) =="];
const results = { local: prior.local, live: {}, pass: localPass };
function check(label, ok, detail = "") {
  results.pass = results.pass && ok;
  results.live[label] = { pass: ok, detail };
  lines.push(`${ok ? "PASS" : "FAIL"}  live: ${label}${detail ? ` — ${detail}` : ""}`);
  console.log(lines[lines.length - 1]);
}
const log = (s) => { lines.push(s); console.log(s) };

function d1(file) {
  execSync(`python3 scripts/d1_remote.py --file ${file}`, { cwd: CF, stdio: "pipe" });
}
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

// --- public smoke -------------------------------------------------------------
const home = await fetch(`${BASE}/`);
check("home → 200", home.status === 200, `status ${home.status}`);
const games = await (await fetch(`${BASE}/api/search?q=${encodeURIComponent("build games")}`)).json();
const topGame = games.results[0];
check('"build games" top hit is a game skill',
  Boolean(topGame) && /game|unreal|defold|ebitengine|roblox|godot|unity/i.test(`${topGame.id} ${topGame.description}`),
  topGame ? topGame.id : "no results");
const localazy = await (await fetch(`${BASE}/api/search?q=localazy`)).json();
check("scout record still searchable (usefulapi/localazy first)",
  localazy.results[0]?.id === "usefulapi/localazy", localazy.results[0]?.id ?? "none");
const profile = await (await fetch(`${BASE}/usefulapi`)).text();
check("registry-label profile shows the honest claim note",
  profile.includes("claim is not available via GitHub sign-in"));

const advisor = await fetch(`${BASE}/advisor`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ goal: "work with PDF files" }),
});
const advisorJson = await advisor.json().catch(() => ({}));
check("advisor still answers (pdf goal → anthropics/pdf match)",
  advisor.status === 200 && (advisorJson.matches ?? []).some((m) => (m.id ?? m) === "anthropics/pdf" || JSON.stringify(m).includes("anthropics/pdf")),
  `status ${advisor.status}`);

async function mcp(url, method, params) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}
const init = await mcp(MCP, "initialize", { protocolVersion: "2025-03-26" });
check("MCP gateway handshake on mcp.talents.sh", init.result?.serverInfo?.name === "talents-gateway");
const mcpSearch = await mcp(MCP, "tools/call", { name: "search_skill", arguments: { query: "pdf" } });
const mcpSearchText = mcpSearch.result?.content?.[0]?.text ?? "";
check("MCP search_skill returns anthropics/pdf", mcpSearchText.includes("anthropics/pdf"));

// --- deployed auth state (awaiting Clerk keys — the honest state) -------------
const dashAnon = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
check("/dashboard unauthenticated → 303 /sign-in",
  dashAnon.status === 303 && dashAnon.headers.get("location") === "/sign-in",
  `status ${dashAnon.status}`);
const signIn = await (await fetch(`${BASE}/sign-in`)).text();
check("/sign-in renders the awaiting-Clerk-keys setup state",
  signIn.includes("Setup remaining") && signIn.includes("GitHub"));
const claimsAnon = await fetch(`${BASE}/api/claims`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: "anthropics" }),
});
check("POST /api/claims unauthenticated → 401", claimsAnon.status === 401, `status ${claimsAnon.status}`);
const whOff = await fetch(`${BASE}/webhooks/stripe`, { method: "POST", body: "{}" });
check("POST /webhooks/stripe unconfigured → 503", whOff.status === 503, `status ${whOff.status}`);
const checkoutOff = await fetch(`${BASE}/api/checkout/anthropics/pdf`, { method: "POST", redirect: "manual" });
check("POST /api/checkout on a free listing → 400 (no fake checkout)",
  checkoutOff.status === 400, `status ${checkoutOff.status}`);

// --- unlist fixture cycle on production D1 ------------------------------------
log("== fixture cycle: talents-gate/fixture-skill (created for this gate, removed after) ==");
const fixtureRecord = {
  id: FIXTURE_ID, owner: "talents-gate", name: "fixture-skill",
  url: `https://talents.sh/skills/${FIXTURE_ID}`, profileUrl: "https://talents.sh/talents-gate",
  kind: "skill", description: "Gate fixture record for the creator-experience unlist test. Safe to delete.",
  sourceType: "github", source: { source: "github", repo: "anthropics/skills" },
  sourceRepo: "anthropics/skills", sourcePath: "", sourceMarketplace: "gate-fixture",
  ref: "main", pointerOnly: true,
  components: { skills: ["fixture-skill"], commands: [], agents: [], hooks: false, mcpServers: [] },
  declaration: { lines: [], summary: ["Gate fixture — declares nothing"], undeclared: [], derivedFrom: [] },
  validation: { entryName: "fixture-skill", ok: true, issues: [] },
  attestation: null, filesHashed: [], status: "listed", ingestedAt: new Date().toISOString(),
};
const insertSql = resolve(CF, "gate-fixture-insert.sql");
writeFileSync(insertSql, [
  `INSERT OR REPLACE INTO records (id, owner, name, kind, status, source_repo, ref, record_json, search_text, attestation_hash, ingested_at) VALUES (${q(FIXTURE_ID)}, 'talents-gate', 'fixture-skill', 'skill', 'listed', 'anthropics/skills', 'main', ${q(JSON.stringify(fixtureRecord))}, 'fixture-skill gate fixture record', NULL, ${q(fixtureRecord.ingestedAt)});`,
  `DELETE FROM skills_fts WHERE id = ${q(FIXTURE_ID)};`,
  `INSERT INTO skills_fts (id, name, description, components, declaration_text) VALUES (${q(FIXTURE_ID)}, 'fixture-skill', 'Gate fixture record for the creator-experience unlist test', 'fixture-skill', 'Gate fixture');`,
  "",
].join("\n"));
// Identity-based aggregate assertions: the parallel backfill is
// ingesting concurrently, so absolute entry counts drift minute to
// minute — what this gate must prove is that THIS fixture's entry
// (unique plugin name "fixture-skill") appears and disappears.
const aggHasFixture = async () =>
  (await (await fetch(`${BASE}/.claude-plugin/marketplace.json`)).json()).plugins
    .some((p) => p.name === "fixture-skill");
const aggCount = async () => (await (await fetch(`${BASE}/.claude-plugin/marketplace.json`)).json()).plugins.length;
try {
  const baseCount = await aggCount();
  d1("gate-fixture-insert.sql");
  const pageBefore = await fetch(`${BASE}/skills/${FIXTURE_ID}`);
  check("fixture record is live (page 200)", pageBefore.status === 200, `status ${pageBefore.status}`);
  const searchBefore = await (await fetch(`${BASE}/api/search?q=fixture-skill`)).json();
  check("fixture record is searchable", searchBefore.results.some((r) => r.id === FIXTURE_ID));
  check("fixture record is in the aggregate", await aggHasFixture(), `aggregate entries ≈ ${baseCount}+`);

  const unlistSql = resolve(CF, "gate-fixture-unlist.sql");
  writeFileSync(unlistSql, `INSERT OR REPLACE INTO unlisted_skills (skill_id, unlisted_by, unlisted_at) VALUES (${q(FIXTURE_ID)}, 'gate-creator', ${q(new Date().toISOString())});\n`);
  d1("gate-fixture-unlist.sql");
  const pageAfter = await fetch(`${BASE}/skills/${FIXTURE_ID}`);
  check("unlisted fixture page → 404", pageAfter.status === 404, `status ${pageAfter.status}`);
  const searchAfter = await (await fetch(`${BASE}/api/search?q=fixture-skill`)).json();
  check("unlisted fixture absent from search", !searchAfter.results.some((r) => r.id === FIXTURE_ID));
  check("unlisted fixture excluded from aggregate", !(await aggHasFixture()));
} finally {
  // RESTORE, unconditionally: remove the unlist row AND the fixture
  // record + FTS row — production returns to its prior state.
  const restoreSql = resolve(CF, "gate-fixture-restore.sql");
  writeFileSync(restoreSql, [
    `DELETE FROM unlisted_skills WHERE skill_id = ${q(FIXTURE_ID)};`,
    `DELETE FROM records WHERE id = ${q(FIXTURE_ID)};`,
    `DELETE FROM skills_fts WHERE id = ${q(FIXTURE_ID)};`,
    "",
  ].join("\n"));
  d1("gate-fixture-restore.sql");
}
const pageRestored = await fetch(`${BASE}/skills/${FIXTURE_ID}`);
check("restore verified: fixture record gone (page 404)", pageRestored.status === 404, `status ${pageRestored.status}`);
const finalCount = await aggCount();
log(`aggregate count after restore: ${finalCount} (baseline drift from the parallel backfill is expected; the fixture itself is gone)`);

lines.push("", results.pass ? "GATE CREATOR (local + live): PASS" : "GATE CREATOR (local + live): FAIL");
results.liveAggregateCountAfterRestore = finalCount;
writeFileSync(resolve(ROOT, "data/gate-creator.json"), JSON.stringify(results, null, 2));
writeFileSync(resolve(ROOT, "data/gate-creator.txt"), lines.join("\n") + "\n");
console.log(results.pass ? "GATE CREATOR LIVE: PASS" : "GATE CREATOR LIVE: FAIL");
process.exit(results.pass ? 0 : 1);
