#!/usr/bin/env node
// P1 gate — reproducible evidence for ARCHITECTURE-v2 §9 P1.
// Prereqs: Typesense dev server up (scripts/dev-typesense.sh start) and a
// built dist/ (npm run build). This script:
//   1. records the Typesense health response,
//   2. runs `talents index` over the real P0 records,
//   3. boots `talents serve` on a test port and curls every route,
//   4. runs the five required search queries through the running server,
//   5. writes data/gate-p1-pages.txt + data/gate-p1-search.json.
// Exit code 0 only if every check passes.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const TS = process.env.TALENTS_TYPESENSE_URL ?? "http://127.0.0.1:8108";

const lines = [];
const log = (s = "") => { lines.push(s); console.log(s); };
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// merged record lookup (same merge rule as the CLI: registry wins)
const byId = new Map();
for (const f of ["data/fallback-registry.json", "data/registry.json"]) {
  try {
    const data = JSON.parse(readFileSync(resolve(ROOT, f), "utf8"));
    for (const [id, r] of Object.entries(data.records)) byId.set(id, r);
  } catch { /* file may not exist */ }
}

// 1. Typesense health
log("== Typesense health ==");
let tsHealth = null;
try {
  tsHealth = await (await fetch(`${TS}/health`)).json();
} catch (e) {
  log(`health fetch failed: ${e.message}`);
}
log(`GET ${TS}/health → ${JSON.stringify(tsHealth)}`);
check("real Typesense server healthy", tsHealth?.ok === true);

// 2. talents index
log("\n== talents index ==");
const indexOut = execFileSync("node", ["dist/src/cli.js", "index"], { cwd: ROOT, encoding: "utf8" });
log(indexOut.trim());
check("index used the Typesense engine", indexOut.includes("search engine: typesense"));

// 3. serve + page checks
log("\n== SSR pages (talents serve --port " + PORT + ") ==");
const server = spawn("node", ["dist/src/cli.js", "serve", "--port", String(PORT)], { cwd: ROOT });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { up = (await fetch(`${BASE}/`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!up) throw new Error("server did not come up:\n" + serverLog);
  log(serverLog.trim());

  const get = async (path, opts) => {
    const res = await fetch(`${BASE}${path}`, opts);
    return { status: res.status, headers: res.headers, body: await res.text() };
  };

  const home = await get("/");
  check("GET / → 200", home.status === 200);
  // At 49 records this asserted one of four named anthropic skills in
  // the trending cards. The static trending score is catalog-size
  // sensitive — at 600+ records, richer attested bundles legitimately
  // outscore them — so the durable invariant is: the home renders
  // ≥4 trending cards and every card links to a real LISTED record.
  const homeIds = [...new Set([...home.body.matchAll(/talents\.sh\/skills\/([a-z0-9._-]+\/[a-z0-9._-]+)/gi)].map((m) => m[1]))];
  const homeListed = homeIds.filter((id) => byId.get(id)?.status === "listed");
  check("GET / renders trending record cards", homeIds.length >= 4 && homeListed.length === homeIds.length,
    homeIds.slice(0, 8).join(", "));
  log(`  snippet: ${home.body.match(/<h2>Trending[^<]*<\/h2>/)?.[0] ?? ""}`);

  const xlsx = byId.get("anthropics/xlsx");
  const skill = await get("/skills/anthropics/xlsx");
  check("GET /skills/anthropics/xlsx → 200", skill.status === 200);
  check("skill page has JSON-LD block", skill.body.includes('type="application/ld+json"'));
  const ldMatch = skill.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  let ldOk = false;
  try { ldOk = JSON.parse(ldMatch?.[1] ?? "").name === "anthropics/xlsx"; } catch { ldOk = false; }
  check("JSON-LD parses and names the record", ldOk);
  check("skill page shows the derived declaration", skill.body.includes("Declaration") && skill.body.includes("Provides 1 skill(s)"));
  check("skill page shows the attestation hash", !!xlsx?.attestation && skill.body.includes(xlsx.attestation.contentHash),
    xlsx?.attestation?.contentHash ?? "no attestation on record");
  check("skill page shows the use panel", skill.body.includes("/plugin marketplace add talents") && skill.body.includes("/plugin install anthropics/xlsx"));
  log(`  snippet: ${skill.body.match(/Indexed in place[^<]*/)?.[0] ?? ""}`);

  const profile = await get("/anthropics");
  check("GET /anthropics → 200 with records", profile.status === 200 && profile.body.includes("document-skills"));

  const short = await get("/s/anthropics/xlsx", { redirect: "manual" });
  check("GET /s/anthropics/xlsx → 301", short.status === 301, `status ${short.status}`);
  check("redirect target is the canonical skill URL", short.headers.get("location") === "/skills/anthropics/xlsx",
    `location: ${short.headers.get("location")}`);

  const missing = await get("/skills/nope/nothere");
  check("GET /skills/nope/nothere → 404", missing.status === 404);
} finally {
  server.kill("SIGTERM");
}

// 4. search gate through the running server's /search route
log("\n== Search gate (via serve, backed by Typesense) ==");
// restart a server instance for search (the one above was stopped)
const server2 = spawn("node", ["dist/src/cli.js", "serve", "--port", String(PORT)], { cwd: ROOT });
server2.stdout.on("data", () => {});
server2.stderr.on("data", () => {});
const searchResults = { engine: "typesense", base: TS, queries: [] };
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { up = (await fetch(`${BASE}/`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!up) throw new Error("server (search pass) did not come up");
  const idsOf = (html) => [...html.matchAll(/href="\/skills\/([^"]+)"/g)].map((m) => m[1]);
  const runQuery = async (label, path, expect, extra) => {
    const res = await fetch(`${BASE}${path}`);
    const ids = idsOf(await res.text());
    const ok = expect(ids) && (extra ? extra(ids) : true);
    if (!ok) failures++;
    searchResults.queries.push({ label, path, results: ids, pass: ok });
    log(`${ok ? "PASS" : "FAIL"}  ${label} → [${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ", …" : ""}] (${ids.length} results)`);
  };
  await runQuery('q=pdf finds anthropics/pdf first', "/search?q=pdf",
    (ids) => ids[0] === "anthropics/pdf");
  await runQuery('q=document finds anthropics/document-skills', "/search?q=document",
    (ids) => ids.includes("anthropics/document-skills"));
  await runQuery('q=pdff (typo) still finds anthropics/pdf', "/search?q=pdff",
    (ids) => ids.includes("anthropics/pdf"));
  await runQuery('q=pdf&kind=skill returns only skills', "/search?q=pdf&kind=skill",
    (ids) => ids.length > 0 && ids.every((id) => byId.get(id)?.kind === "skill"));
  await runQuery('q=security finds 42crunch-ai/42crunch-api-security-testing', "/search?q=security",
    (ids) => ids.includes("42crunch-ai/42crunch-api-security-testing"));
} finally {
  server2.kill("SIGTERM");
}

writeFileSync(resolve(ROOT, "data/gate-p1-pages.txt"), lines.join("\n") + "\n");
writeFileSync(resolve(ROOT, "data/gate-p1-search.json"), JSON.stringify(searchResults, null, 2) + "\n");
log(`\nevidence: data/gate-p1-pages.txt · data/gate-p1-search.json`);
log(failures === 0 ? "P1 GATE: ALL CHECKS PASSED" : `P1 GATE: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
