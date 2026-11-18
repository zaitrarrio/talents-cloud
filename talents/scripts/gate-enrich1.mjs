// Gate — Enrichment Tranche 1 (layers A–C). Run via the credential
// launcher (needs CLOUDFLARE_API_TOKEN for D1/R2 reads):
//   python3 cf/scripts/backfill_remote.py gate-enrich1.mjs
//
// Everything here is verified INDEPENDENTLY of the enrichment code:
//   - coverage + states read straight from production D1;
//   - 10 sampled records hand-checked against live sources (stars
//     re-fetched via the ghapi helper; README excerpts checked as
//     normalized substrings of the freshly fetched README);
//   - ONE introspected server's tool list compared against a manual
//     MCP client session written inline below (no imports from
//     src/enrichment — a genuinely separate client);
//   - R2 object count via the REST list API + sample asset fetches
//     through the live /assets/* routes;
//   - search spot-checks (a tool name and a sub-inventory name must
//     find their parent record) + the standard live smoke suite.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/home/hatch/workspace/skills-marketplace/talents";
const DIST = join(ROOT, "dist");
const imp = (rel) => import(pathToFileURL(join(DIST, rel)).href);
const ACCOUNT = "0cd06fd37ee4e07de370821cb3852a8a";
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) { console.error("run via cf/scripts/backfill_remote.py"); process.exit(2); }

const { WranglerD1 } = await imp("src/discovery/wrangler-d1.js");
const { remoteEndpointOf } = await imp("src/enrichment/layer-c.js");
const d1 = new WranglerD1({ cwd: join(ROOT, "cf"), config: "wrangler.deploy.jsonc", database: "talents", remote: true });
const q = (sql) => d1.query(sql);

const GHAPI = join(homedir(), "workspace/custom-connectors/custom.github-api/bin/ghapi");
const ghapi = (path) => new Promise((resolve, reject) => {
  execFile(GHAPI, ["api-get", path], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr?.toString().trim() || err.message));
    else resolve(JSON.parse(stdout));
  });
});

const gate = { at: new Date().toISOString(), checks: [], coverage: {}, samples: [], smoke: {} };
const check = (name, ok, detail) => { gate.checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`); };

// --- Catalog + slice definitions (same rules as the runs) ------------------
const [{ n: listedTotal }] = await q("SELECT COUNT(*) AS n FROM records WHERE status = 'listed'");
const mcpRows = await q("SELECT id, record_json FROM records WHERE status = 'listed' AND kind = 'mcp' ORDER BY id");
const remoteMcpIds = mcpRows.filter((r) => remoteEndpointOf(JSON.parse(r.record_json))).map((r) => r.id);
const trafficRows = await q(
  `SELECT r.id AS id FROM records r LEFT JOIN record_stats rs ON rs.skill_id = r.id
   WHERE r.status = 'listed'
   ORDER BY COALESCE(rs.behavior_score, 0) DESC, COALESCE(rs.calls_30d, 0) DESC, r.id ASC LIMIT 500`,
);
const trafficIds = trafficRows.map((r) => r.id);
const sliceIds = [...new Set([...remoteMcpIds, ...trafficIds])];
gate.coverage = { listedTotal, remoteMcpCount: remoteMcpIds.length, trafficSlice: trafficIds.length, sliceUnique: sliceIds.length };

// --- Per-layer coverage over the slice + the full catalog ------------------
async function layerCoverage(ids) {
  if (!ids.length) return {};
  const inList = ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(",");
  const rows = await q(
    `SELECT a_state, b_state, c_state, COUNT(*) AS n FROM enrichment WHERE skill_id IN (${inList}) GROUP BY a_state, b_state, c_state`,
  );
  const tally = { a: {}, b: {}, c: {}, enriched: 0 };
  for (const r of rows) {
    tally.a[r.a_state] = (tally.a[r.a_state] ?? 0) + r.n;
    tally.b[r.b_state] = (tally.b[r.b_state] ?? 0) + r.n;
    tally.c[r.c_state] = (tally.c[r.c_state] ?? 0) + r.n;
    tally.enriched += r.n;
  }
  tally.unenriched = ids.length - tally.enriched;
  return tally;
}
gate.coverage.slice = await layerCoverage(sliceIds);
gate.coverage.remoteMcp = await layerCoverage(remoteMcpIds);
gate.coverage.traffic = await layerCoverage(trafficIds);
const [{ n: enrichedTotal }] = await q("SELECT COUNT(*) AS n FROM enrichment");
gate.coverage.enrichedRowsTotal = enrichedTotal;
gate.coverage.catalogPct = `${((enrichedTotal / listedTotal) * 100).toFixed(1)}% of listed records have an enrichment row`;

// Top partial/none reasons per layer (from payloads).
async function topReasons(layer) {
  const col = `${layer}_json`;
  const rows = await q(
    `SELECT ${col} AS j FROM enrichment WHERE ${layer}_state IN ('partial','none') AND ${col} IS NOT NULL LIMIT 4000`,
  );
  const counts = {};
  for (const r of rows) {
    try {
      const j = JSON.parse(r.j);
      const reasons = [...(j.errors ?? []), ...(j.reason ? [j.reason] : [])];
      for (const reason of reasons) {
        const key = String(reason).split(":")[0].slice(0, 60);
        counts[key] = (counts[key] ?? 0) + 1;
      }
    } catch { /* unparseable payload — counted nowhere, states still tally */ }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([reason, n]) => ({ reason, n }));
}
gate.coverage.reasons = { a: await topReasons("a"), b: await topReasons("b"), c: await topReasons("c") };

// --- The "---" description artifact ----------------------------------------
const [{ n: dashRecords }] = await q("SELECT COUNT(*) AS n FROM records WHERE status = 'listed' AND TRIM(COALESCE(json_extract(record_json, '$.description'), '')) = '---'");
const [{ n: dashCandidates }] = await q(
  "SELECT COUNT(*) AS n FROM enrichment WHERE b_json IS NOT NULL AND b_json LIKE '%\"parsedDescription\"%'",
);
gate.dashArtifact = { recordsWithDashDescription: dashRecords, parsedDescriptionCandidates: dashCandidates };

// --- Enriched sample set for hand-checks ------------------------------------
const sampleRows = await q(
  `SELECT e.skill_id AS id, e.a_json AS a, e.b_json AS b, e.c_json AS c, r.record_json AS record_json
   FROM enrichment e JOIN records r ON r.id = e.skill_id
   WHERE e.a_state IN ('done','partial') OR e.c_state = 'done'
   ORDER BY e.skill_id LIMIT 4000`,
);
const samples = sampleRows.map((r) => ({
  id: r.id,
  a: r.a ? JSON.parse(r.a) : null,
  b: r.b ? JSON.parse(r.b) : null,
  c: r.c ? JSON.parse(r.c) : null,
  record: JSON.parse(r.record_json),
}));

// Hand-check 1..6: GitHub stars vs a fresh ghapi fetch — one
// record per DISTINCT repo (records sharing a repo share its
// stats). Stars are a living counter: the stored value was
// correct at fetch time, so the check tolerates small upward
// drift since the fetch (≤ max(10, 1%)) and any downward move
// beyond noise fails, as does any large gap (wrong repo / stale
// import / corruption).
const ghSamples = [];
{
  const seenRepos = new Set();
  for (const s of samples) {
    if (!s.a?.github || !s.record.sourceRepo || seenRepos.has(s.record.sourceRepo)) continue;
    seenRepos.add(s.record.sourceRepo);
    ghSamples.push(s);
    if (ghSamples.length >= 6) break;
  }
}
for (const s of ghSamples) {
  try {
    const live = await ghapi(`/repos/${s.record.sourceRepo}`);
    const drift = live.stargazers_count - s.a.github.stars;
    const tolerance = Math.max(10, Math.ceil(live.stargazers_count * 0.01));
    const ok = drift >= -2 && drift <= tolerance;
    gate.samples.push({ id: s.id, check: "github stars", stored: s.a.github.stars, live: live.stargazers_count, drift, tolerance, ok });
    check(`stars ${s.id}`, ok, `stored ${s.a.github.stars} vs live ${live.stargazers_count} (drift ${drift >= 0 ? "+" : ""}${drift}, tolerance ±${tolerance}; ${s.record.sourceRepo})`);
  } catch (e) {
    gate.samples.push({ id: s.id, check: "github stars", ok: false, error: e.message });
    check(`stars ${s.id}`, false, `ghapi error: ${e.message}`);
  }
}

// Hand-check 7..8: README excerpt fidelity — excerpt must be a
// normalized substring of the freshly fetched README.
const norm = (t) => t.replace(/<[^>]+>/g, " ").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_>`|#]/g, "").replace(/\s+/g, " ").trim();
const readmeSamples = samples.filter((s) => s.a?.readme?.excerpt && s.a?.readme?.sourceUrl).slice(0, 2);
for (const s of readmeSamples) {
  try {
    const res = await fetch(s.a.readme.sourceUrl, { headers: { "user-agent": "talents-gate" } });
    const fresh = norm(await res.text());
    const probe = norm(s.a.readme.excerpt).replace(/…$/, "").slice(0, 80);
    const ok = probe.length >= 20 && fresh.includes(probe);
    gate.samples.push({ id: s.id, check: "readme excerpt fidelity", ok, probe: probe.slice(0, 60) });
    check(`readme ${s.id}`, ok, ok ? "excerpt is a faithful substring of the live README" : "excerpt NOT found in live README");
  } catch (e) {
    check(`readme ${s.id}`, false, `fetch error: ${e.message}`);
  }
}

// Hand-check 9: sub-inventory spot — a contained skill name must
// exist as a SKILL.md in the live repo tree (via ghapi).
const invSample = samples.find((s) => s.b?.subInventory?.length && s.record.sourceRepo);
if (invSample) {
  const entry = invSample.b.subInventory.find((e) => e.kind === "skill") ?? invSample.b.subInventory[0];
  try {
    const tree = await ghapi(`/repos/${invSample.record.sourceRepo}/git/trees/${invSample.record.ref}?recursive=1`);
    const paths = new Set((tree.tree ?? []).map((t) => t.path));
    const ok = paths.has(entry.path) || [...paths].some((p) => p.startsWith(entry.path));
    gate.samples.push({ id: invSample.id, check: "sub-inventory path exists in live tree", entry: entry.path, ok });
    check(`inventory ${invSample.id}`, ok, `${entry.kind} "${entry.name}" at ${entry.path} ${ok ? "present" : "MISSING"} in live tree`);
  } catch (e) {
    check(`inventory ${invSample.id}`, false, `ghapi error: ${e.message}`);
  }
}

// Hand-check 10: independent MCP client session vs stored c_json.
const cSample = samples.find((s) => s.c?.tools?.length);
if (cSample) {
  const endpoint = cSample.c.endpoint;
  const rpc = async (method, params, sessionId) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    const sid = res.headers.get("mcp-session-id");
    const text = await res.text();
    let result = null;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) { try { result = JSON.parse(line.slice(5)).result ?? result; } catch { /* next */ } }
      }
    } else {
      try { result = JSON.parse(text).result; } catch { /* leave null */ }
    }
    return { result, sid };
  };
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gate-manual", version: "0" } }, null);
    const toolsRes = await rpc("tools/list", {}, init.sid);
    const liveNames = (toolsRes.result?.tools ?? []).map((t) => t.name).sort();
    const storedNames = cSample.c.tools.map((t) => t.name).sort();
    const ok = JSON.stringify(liveNames) === JSON.stringify(storedNames);
    gate.samples.push({ id: cSample.id, check: "introspection vs manual MCP session", endpoint, live: liveNames, stored: storedNames, ok });
    check(`introspection ${cSample.id}`, ok, ok ? `${liveNames.length} tools match the manual session` : `live [${liveNames}] vs stored [${storedNames}]`);
  } catch (e) {
    check(`introspection ${cSample.id}`, false, `manual session error: ${e.message}`);
  }
} else {
  check("introspection sample", false, "no record with a completed introspection was found in the enriched set");
}

// --- R2 assets ---------------------------------------------------------------
let r2Count = 0;
let cursor;
do {
  const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/talents-assets/objects`);
  url.searchParams.set("per_page", "1000");
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const j = await res.json();
  r2Count += (j.result ?? []).length;
  cursor = j.result_info?.is_truncated ? j.result_info?.cursor : undefined;
} while (cursor);
gate.r2 = { bucket: "talents-assets", objects: r2Count };
check("r2 objects", r2Count > 0, `${r2Count} objects in talents-assets`);

const iconSample = samples.find((s) => s.a?.icon);
if (iconSample) {
  const res = await fetch(`https://talents.sh/assets/icon/${iconSample.id}`);
  const ok = res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("image/");
  gate.r2.sampleIcon = { id: iconSample.id, status: res.status, contentType: res.headers.get("content-type") };
  check("r2 sample icon via /assets", ok, `${iconSample.id} → HTTP ${res.status} ${res.headers.get("content-type")}`);
}
const readmeAsset = samples.find((s) => s.a?.readme?.storedKey);
if (readmeAsset) {
  const res = await fetch(`https://talents.sh/assets/readme/${readmeAsset.id}`);
  gate.r2.sampleReadme = { id: readmeAsset.id, status: res.status };
  check("r2 sample readme via /assets", res.status === 200, `${readmeAsset.id} → HTTP ${res.status}`);
}

// --- Search spot-checks -------------------------------------------------------
async function search(qstr) {
  const res = await fetch(`https://talents.sh/api/search?q=${encodeURIComponent(qstr)}&limit=10`);
  return res.json();
}
if (cSample?.c?.tools?.length) {
  const toolName = cSample.c.tools[0].name;
  const out = await search(toolName);
  const hit = (out.results ?? []).some((r) => r.id === cSample.id);
  check("search by tool name", hit, `q="${toolName}" → parent ${cSample.id} ${hit ? "found" : "NOT in top 10"}`);
}
if (invSample?.b?.subInventory?.length) {
  const entry = invSample.b.subInventory.find((e) => e.kind === "skill") ?? invSample.b.subInventory[0];
  const out = await search(entry.name);
  const hit = (out.results ?? []).some((r) => r.id === invSample.id);
  check("search by sub-inventory name", hit, `q="${entry.name}" → parent ${invSample.id} ${hit ? "found" : "NOT in top 10"}`);
}

// --- Standard live smoke -------------------------------------------------------
const home = await fetch("https://talents.sh/");
gate.smoke.home = home.status;
check("smoke home", home.status === 200, `HTTP ${home.status}`);
const games = await search("build games");
const topGame = games.results?.[0];
gate.smoke.buildGamesTop = topGame?.id;
check("smoke build games", Boolean(topGame && /game/i.test(`${topGame.id} ${topGame.description ?? ""}`)), `top: ${topGame?.id}`);
const advisor = await fetch("https://talents.sh/advisor", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ goal: "work with PDF files" }),
});
const advisorJson = await advisor.json().catch(() => ({}));
gate.smoke.advisor = { status: advisor.status, first: advisorJson.matches?.[0]?.id };
check("smoke advisor", advisor.status === 200 && advisorJson.matches?.length > 0, `HTTP ${advisor.status}, first match ${advisorJson.matches?.[0]?.id}`);
const mcpInit = await fetch("https://mcp.talents.sh/mcp", {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gate", version: "0" } } }),
});
gate.smoke.mcpHandshake = mcpInit.status;
check("smoke mcp handshake", mcpInit.status === 200, `HTTP ${mcpInit.status}`);
const dash = await fetch("https://talents.sh/dashboard", { redirect: "manual" });
gate.smoke.dashboard = dash.status;
check("smoke dashboard auth redirect", dash.status >= 300 && dash.status < 400, `HTTP ${dash.status} → ${dash.headers.get("location")}`);

// Enriched skill page renders the new panels.
if (cSample) {
  const page = await fetch(`https://talents.sh/skills/${cSample.id}`);
  const html = await page.text();
  const ok = html.includes("Tools (live, introspected");
  gate.smoke.enrichedPage = { id: cSample.id, toolsPanel: ok };
  check("enriched page tools panel", ok, `${cSample.id} ${ok ? "renders" : "MISSING"} the introspected tools panel`);
}
const factsSample = samples.find((s) => s.a?.github);
if (factsSample) {
  const page = await fetch(`https://talents.sh/skills/${factsSample.id}`);
  const html = await page.text();
  const ok = html.includes("Source facts");
  gate.smoke.factsPage = { id: factsSample.id, sourceFactsPanel: ok };
  check("enriched page source facts", ok, `${factsSample.id} ${ok ? "renders" : "MISSING"} the source facts panel`);
}

gate.pass = gate.checks.every((c) => c.ok);
writeFileSync(join(ROOT, "data/gate-enrich1.json"), JSON.stringify(gate, null, 2));
console.log(`\nGATE ${gate.pass ? "PASS" : "FAIL"} — ${gate.checks.filter((c) => c.ok).length}/${gate.checks.length} checks`);
process.exit(gate.pass ? 0 : 1);
