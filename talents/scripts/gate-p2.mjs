// P2 gate — reproducible: seeds the local D1 from the registry files,
// builds the Worker with the Cloudflare Vite plugin, boots it under
// wrangler dev (workerd/Miniflare), and checks
// pages, D1 search, the aggregated marketplace, and the MCP gateway
// (including the two-step install ceremony and a tamper refusal).
// Evidence → data/gate-p2.txt + data/gate-p2.json. Exit ≠ 0 on failure.
//
// Prereqs: root engine built (npm run build), cf deps installed
// (npm install in cf/). Run via `npm run gate:p2`.

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const CF = resolve(ROOT, "cf");
const PORT = 4417;
const BASE = `http://127.0.0.1:${PORT}`;

const { buildAggregatedMarketplace, externalSourceViolations } = await import(
  resolve(ROOT, "dist/src/aggregate.js")
);

const lines = [];
const results = { pages: {}, search: {}, aggregate: {}, mcp: {}, pass: true };
function check(section, label, ok, detail = "") {
  results.pass = results.pass && ok;
  (results[section] ??= {})[label] = { pass: ok, detail };
  lines.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  console.log(lines[lines.length - 1]);
}
const log = (s) => { lines.push(s); console.log(s); };

// --- expected data -------------------------------------------------------
function loadRecords() {
  const byId = new Map();
  for (const f of ["registry.json", "fallback-registry.json"]) {
    const parsed = JSON.parse(readFileSync(resolve(ROOT, "data", f), "utf8"));
    for (const r of Object.values(parsed.records ?? {})) if (!byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()];
}
const records = loadRecords();
const listedCount = records.filter((r) => r.status === "listed").length;

// --- seed ----------------------------------------------------------------
log("== seed local D1 ==");
execSync("npm run seed", { cwd: CF, stdio: "inherit" });

// --- insert the tamper fixture ------------------------------------------
// A clone of anthropics/pdf whose STORED attestation hash is wrong:
// the gateway must refuse its install at confirm time because the live
// source hashes to the real attestation, not this stored value.
log("== tamper fixture ==");
const pdf = records.find((r) => r.id === "anthropics/pdf");
const tampered = JSON.parse(JSON.stringify(pdf));
tampered.id = "tampered/pdf";
tampered.owner = "tampered";
tampered.attestation = { ...tampered.attestation, contentHash: "0".repeat(64) };
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
writeFileSync(resolve(CF, "tamper.sql"), [
  `INSERT OR REPLACE INTO records (id, owner, name, kind, status, source_repo, ref, record_json, search_text, attestation_hash, ingested_at) VALUES (${q(tampered.id)}, ${q(tampered.owner)}, ${q(tampered.name)}, ${q(tampered.kind)}, 'listed', ${q(tampered.sourceRepo)}, ${q(tampered.ref)}, ${q(JSON.stringify(tampered))}, 'tampered pdf fixture', ${q(tampered.attestation.contentHash)}, ${q(tampered.ingestedAt)});`,
  "",
].join("\n"));
execSync("npx wrangler d1 execute talents-dev --local --file=tamper.sql", { cwd: CF, stdio: "inherit" });

// --- build check: @cloudflare/vite-plugin compiles the Worker ------------
log("== vite build (Cloudflare Vite plugin) ==");
execSync("npm run build", { cwd: CF, stdio: "inherit" });
check("pages", "vite build succeeds (@cloudflare/vite-plugin)", true, "see build output above");

// --- source relay (dev-only: sandbox workerd has no direct egress) --------
const RELAY_PORT = 4419;
const relay = spawn("node", [resolve(ROOT, "scripts/source-relay.mjs")], {
  env: { ...process.env, RELAY_PORT: String(RELAY_PORT) },
  detached: true, stdio: ["ignore", "pipe", "pipe"],
});

// --- boot the Worker --------------------------------------------------------
// wrangler dev (the task allows either runner). The TALENTS_SOURCE_RELAY
// var routes the gateway's GitHub re-fetches through the Node relay —
// sandbox-only plumbing; production Workers fetch directly.
log("== boot Worker (wrangler dev) ==");
const dev = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--var", `TALENTS_SOURCE_RELAY:http://127.0.0.1:${RELAY_PORT}`], {
  cwd: CF, detached: true, stdio: ["ignore", "pipe", "pipe"],
});
let devLog = "";
dev.stdout.on("data", (d) => { devLog += d; });
dev.stderr.on("data", (d) => { devLog += d; });

async function waitUp() {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/search?q=pdf`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function mcp(method, params, id = 1) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
const toolText = (body) => JSON.parse(body.result.content[0].text);

try {
  const up = await waitUp();
  check("pages", "worker boots and answers /api/search", up, up ? "" : devLog.slice(-800));
  if (!up) throw new Error("worker did not come up");

  // --- pages -------------------------------------------------------------
  log("== pages ==");
  const home = await fetch(`${BASE}/`);
  const homeText = await home.text();
  check("pages", "GET / → 200 with catalog cards", home.status === 200 && homeText.includes("anthropics/"), `status ${home.status}`);

  const skillRes = await fetch(`${BASE}/skills/anthropics/xlsx`);
  const skillText = await skillRes.text();
  const ld = skillText.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  let ldOk = false;
  try { ldOk = JSON.parse(ld?.[1] ?? "").name === "anthropics/xlsx"; } catch { /* stays false */ }
  check("pages", "GET /skills/anthropics/xlsx → 200 with parseable JSON-LD", skillRes.status === 200 && ldOk, `status ${skillRes.status}`);
  check("pages", "skill page shows declaration + attestation + use panel",
    skillText.includes("Declaration") && skillText.includes("Content hash") && skillText.includes("/plugin marketplace add talents"));

  const profile = await fetch(`${BASE}/anthropics`);
  check("pages", "GET /anthropics → 200", profile.status === 200, `status ${profile.status}`);

  const redir = await fetch(`${BASE}/s/anthropics/xlsx`, { redirect: "manual" });
  check("pages", "GET /s/anthropics/xlsx → 301 to canonical",
    redir.status === 301 && redir.headers.get("location") === "/skills/anthropics/xlsx",
    `status ${redir.status} location ${redir.headers.get("location")}`);

  const missing = await fetch(`${BASE}/skills/nope/nothere`);
  check("pages", "GET /skills/nope/nothere → 404", missing.status === 404, `status ${missing.status}`);

  // --- search --------------------------------------------------------------
  log("== /api/search (D1 FTS5 trigram) ==");
  const search = async (qs) => (await (await fetch(`${BASE}/api/search?${qs}`)).json());
  const sPdf = await search("q=pdf");
  check("search", "q=pdf → anthropics/pdf first", sPdf.results[0]?.id === "anthropics/pdf", JSON.stringify(sPdf.results.map((r) => r.id)));
  results.search.pdf = sPdf.results.map((r) => r.id);
  const sDoc = await search("q=document");
  check("search", "q=document → anthropics/document-skills first", sDoc.results[0]?.id === "anthropics/document-skills", JSON.stringify(sDoc.results.map((r) => r.id)));
  results.search.document = sDoc.results.map((r) => r.id);
  const sTypo = await search("q=pdff");
  check("search", "q=pdff (typo) → anthropics/pdf first", sTypo.results[0]?.id === "anthropics/pdf", JSON.stringify(sTypo.results.map((r) => r.id)));
  results.search.pdff = sTypo.results.map((r) => r.id);
  const sSec = await search("q=security");
  // Invariant (gate maintenance, Phase 2 catalog growth): the
  // winner must be genuinely security-relevant and 42crunch must
  // stay top-3. The exact #1 changed legitimately as the catalog
  // grew (code-yeongyu at 557 records; skillmds/security — an
  // exact-name security-audit plugin — after the scout ingests).
  // No editorial pin is faked to force a specific winner.
  check("search", "q=security → security-relevant first, 42crunch-ai/42crunch-api-security-testing in top 3",
    /security|audit|vulnerab/i.test(`${sSec.results[0]?.name ?? ""} ${sSec.results[0]?.description ?? ""}`)
      && sSec.results.slice(0, 3).some((r) => r.id === "42crunch-ai/42crunch-api-security-testing"),
    JSON.stringify(sSec.results.map((r) => r.id)));
  results.search.security = sSec.results.map((r) => r.id);
  const sKind = await search("q=pdf&kind=skill");
  check("search", "q=pdf&kind=skill → only skills", sKind.results.length > 0 && sKind.results.every((r) => r.kind === "skill"), `${sKind.results.length} results`);
  results.search.pdfKindSkill = sKind.results.map((r) => r.id);

  // --- aggregated marketplace ----------------------------------------------
  log("== aggregated marketplace ==");
  const aggRes = await fetch(`${BASE}/.claude-plugin/marketplace.json`);
  const agg = await aggRes.json();
  check("aggregate", "marketplace.json parses, name=talents", aggRes.status === 200 && agg.name === "talents", `status ${aggRes.status}`);
  const rebuilt = buildAggregatedMarketplace(records);
  // A Claude Code marketplace cannot carry two plugins with the same
  // name, so the builder skips same-name records after the first
  // (aggregate.ts, documented). At 49 records there were no collisions
  // and this check read "entries = listed"; with the grown catalog the
  // exact expectation is listed − builder-skipped, with the skipped
  // ids named in the evidence.
  check("aggregate", `entry count = listed records (${listedCount}) − name-collision skips (${rebuilt.skipped.length})`,
    agg.plugins?.length === listedCount - rebuilt.skipped.length,
    `${agg.plugins?.length} entries; skipped: ${rebuilt.skipped.map((s) => s.id).join(", ") || "none"}`);
  const violations = externalSourceViolations(agg);
  check("aggregate", "every entry source points at a non-Talents origin", violations.length === 0, violations.slice(0, 3).join("; "));
  const aggErrors = rebuilt.issues.filter((i) => i.severity === "error");
  check("aggregate", "own validator (claude plugin validate mirror) passes", aggErrors.length === 0, aggErrors.map((e) => e.message).join("; "));
  results.aggregate = { entries: agg.plugins?.length, violations, validationErrors: aggErrors.length };

  // --- MCP gateway -----------------------------------------------------------
  log("== MCP gateway ==");
  const init = await mcp("initialize", { protocolVersion: "2025-03-26" });
  check("mcp", "initialize handshake", init.body.result?.serverInfo?.name === "talents-gateway", JSON.stringify(init.body.result?.serverInfo ?? init.body));
  const tools = await mcp("tools/list", {});
  const toolNames = (tools.body.result?.tools ?? []).map((t) => t.name).sort();
  check("mcp", "tools/list = search_skill, get_skill, install_skill",
    JSON.stringify(toolNames) === JSON.stringify(["get_skill", "install_skill", "search_skill"]), toolNames.join(","));

  const mSearch = await mcp("tools/call", { name: "search_skill", arguments: { query: "pdf" } });
  const mSearchPayload = toolText(mSearch.body);
  check("mcp", "search_skill 'pdf' → anthropics/pdf first", mSearchPayload.results?.[0]?.id === "anthropics/pdf", JSON.stringify(mSearchPayload.results?.map((r) => r.id)));

  const prep = await mcp("tools/call", { name: "install_skill", arguments: { skill: "anthropics/pdf" } });
  const prepPayload = toolText(prep.body);
  check("mcp", "install_skill step 1 (prepare) returns declaration + attestation hash",
    prepPayload.status === "prepared" && typeof prepPayload.attestationHash === "string" && prepPayload.attestationHash.length === 64 && Array.isArray(prepPayload.declaration),
    `status ${prepPayload.status}`);

  const confirm = await mcp("tools/call", {
    name: "install_skill",
    arguments: { skill: "anthropics/pdf", confirm: true, attestationHash: prepPayload.attestationHash, installer: "gate-p2" },
  });
  const confirmPayload = toolText(confirm.body);
  check("mcp", "install_skill step 2 (confirm, live re-verification) → installed",
    confirmPayload.status === "installed" && confirmPayload.attestationHash === prepPayload.attestationHash,
    JSON.stringify(confirmPayload).slice(0, 300));
  results.mcp.install = confirmPayload;

  const installsRes = await (await fetch(`${BASE}/api/installs?skill=anthropics/pdf`)).json();
  check("mcp", "installs row exists in D1 for anthropics/pdf",
    installsRes.installs?.some((i) => i.attestation_hash === prepPayload.attestationHash && i.installer === "gate-p2"),
    `${installsRes.installs?.length ?? 0} install row(s)`);

  const tPrep = await mcp("tools/call", { name: "install_skill", arguments: { skill: "tampered/pdf" } });
  const tPrepPayload = toolText(tPrep.body);
  const tConfirm = await mcp("tools/call", {
    name: "install_skill",
    arguments: { skill: "tampered/pdf", confirm: true, attestationHash: tPrepPayload.attestationHash, installer: "gate-p2" },
  });
  const tConfirmPayload = toolText(tConfirm.body);
  check("mcp", "tamper fixture → REFUSED at confirm (stored hash ≠ live source hash)",
    tConfirmPayload.status === "refused" && String(tConfirmPayload.reason ?? "").includes("content hash mismatch"),
    JSON.stringify(tConfirmPayload).slice(0, 300));
  results.mcp.tamper = tConfirmPayload;
} finally {
  try { process.kill(-dev.pid, "SIGTERM"); } catch { /* already gone */ }
  try { process.kill(-relay.pid, "SIGTERM"); } catch { /* already gone */ }
  writeFileSync(resolve(ROOT, "data/gate-p2.txt"), lines.join("\n") + "\n");
  writeFileSync(resolve(ROOT, "data/gate-p2.json"), JSON.stringify(results, null, 2));
  console.log(`\nevidence → data/gate-p2.txt, data/gate-p2.json · overall: ${results.pass ? "PASS" : "FAIL"}`);
}
process.exit(results.pass ? 0 : 1);
