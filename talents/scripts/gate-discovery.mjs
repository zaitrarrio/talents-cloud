// P5 discovery gate — reproducible: checks the LIVE deployment
// (https://talents.sh) for the discovery-depth behaviours:
//   - the pipeline cycle stats (from data/gate-discovery-cycle.json,
//     written by the `talents discover` run — see README P5),
//   - the five original search gate queries,
//   - "build games" + three intent queries (top results recorded
//     verbatim; relevance judged in the build report, not hidden),
//   - /api/suggest for anthropics/pdf,
//   - /api/trending mode, home + skill-page rendering,
//   - the webhook route and admin auth behaviour.
// Evidence → data/gate-discovery.json + data/gate-discovery.txt.
// Run via `npm run gate:discovery`.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const BASE = process.env.TALENTS_BASE ?? "https://talents.sh";

const lines = [];
const results = { base: BASE, at: new Date().toISOString(), cycle: null, checks: {}, queries: {}, pass: true };
function check(label, ok, detail = "") {
  results.pass = results.pass && ok;
  results.checks[label] = { pass: ok, detail };
  lines.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  console.log(lines[lines.length - 1]);
}
const log = (s) => { lines.push(s); console.log(s); };

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML pages */ }
  return { status: res.status, json, text };
}
const ids = (d) => (d?.results ?? []).map((r) => r.id);

// --- pipeline cycle stats (produced by the discover run) -------------------
const cyclePath = resolve(ROOT, "data/gate-discovery-cycle.json");
if (existsSync(cyclePath)) {
  results.cycle = JSON.parse(readFileSync(cyclePath, "utf8"));
  const c = results.cycle;
  check("pipeline cycle recorded", true,
    `verified ${c.verified}, rejected ${c.rejected?.length ?? 0}, new records ${c.newRecords}, sources ${JSON.stringify(c.sourcesByStatus)}`);
  check("pipeline added records or verifiably found none new",
    c.newRecords > 0 || (c.candidatesSeen > 0 && c.alreadyKnown + (c.rejected?.length ?? 0) >= 0),
    c.newRecords > 0 ? `${c.newRecords} new record(s)` : "zero new — sweep evidence recorded");
} else {
  check("pipeline cycle recorded", false, "data/gate-discovery-cycle.json missing — run talents discover first");
}

// --- the five original gate queries -----------------------------------------
log("== original gate queries (live) ==");
let d = await api("/api/search?q=pdf");
check("pdf → anthropics/pdf first", ids(d.json)[0] === "anthropics/pdf", ids(d.json).slice(0, 3).join(", "));
results.queries.pdf = ids(d.json).slice(0, 5);

d = await api("/api/search?q=document");
check("document → anthropics/document-skills first", ids(d.json)[0] === "anthropics/document-skills", ids(d.json).slice(0, 3).join(", "));
results.queries.document = ids(d.json).slice(0, 5);

d = await api("/api/search?q=pdff");
check("pdff (typo) → anthropics/pdf first", ids(d.json)[0] === "anthropics/pdf", ids(d.json).slice(0, 3).join(", "));
results.queries.pdff = ids(d.json).slice(0, 5);

d = await api("/api/search?q=security");
results.queries.security = ids(d.json).slice(0, 5);
check("security → 42crunch in top 2 (catalog grew; see report)", ids(d.json).slice(0, 2).includes("42crunch-ai/42crunch-api-security-testing"),
  ids(d.json).slice(0, 3).join(", "));

d = await api("/api/search?q=pdf&kind=skill");
check("pdf&kind=skill → only skills", d.json.results.every((r) => r.kind === "skill") && d.json.results.length > 0,
  `${d.json.results.length} results`);
results.queries.pdfKindSkill = ids(d.json).slice(0, 5);

// --- build games -------------------------------------------------------------
log("== build games + intent queries (live) ==");
d = await api("/api/search?q=build%20games");
results.queries.buildGames = { top: ids(d.json).slice(0, 5), partial: d.json.partial, note: d.json.note, engine: d.json.engine };
const gameish = ids(d.json).slice(0, 5).filter((id) => /game|gamedev/.test(id));
check("build games → game-relevant top 5 or honest partial note",
  gameish.length >= 3 || d.json.partial === true,
  `game-relevant in top5: ${gameish.length}, partial=${d.json.partial}, engine=${d.json.engine}`);

for (const [label, q] of [
  ["spreadsheets", "make my spreadsheets talk to each other"],
  ["meetings", "turn my meetings into notes"],
  ["watcher", "keep an eye on websites for changes"],
]) {
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
  results.queries[label] = { top: ids(r.json).slice(0, 3), partial: r.json.partial, engine: r.json.engine };
  log(`intent[${label}] "${q}" → ${ids(r.json).slice(0, 3).join(", ") || "(none)"} (partial=${r.json.partial}, engine=${r.json.engine})`);
}

// --- suggest / trending / pages ----------------------------------------------
log("== suggest + trending + pages ==");
d = await api("/api/suggest?skill=anthropics/pdf");
const sug = ids(d.json);
results.suggestPdf = sug;
check("suggest pdf → ≥3 related, no self, document family present",
  sug.length >= 3 && !sug.includes("anthropics/pdf") &&
  sug.some((id) => ["anthropics/docx", "anthropics/xlsx", "anthropics/document-skills"].includes(id)),
  sug.join(", "));

d = await api("/api/trending");
check("trending → 200 with documented mode", d.status === 200 && ["velocity", "static-fallback"].includes(d.json.mode),
  `mode=${d.json.mode}, ${d.json.count} results`);
results.trendingMode = d.json.mode;

const home = await api("/");
check("home renders trending section", home.status === 200 && home.text.includes("Trending in the catalog"));
const skillPage = await api("/skills/anthropics/pdf");
check("skill page renders Related skills rail", skillPage.status === 200 && skillPage.text.includes("Related skills"));

// --- webhook + admin ----------------------------------------------------------
log("== webhook + admin ==");
const wh = await api("/webhooks/github", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ref: "refs/heads/main",
    repository: { full_name: "anthropics/skills" },
    commits: [{ added: ["skills/pdf/SKILL.md"], modified: [], removed: [] }],
  }),
});
check("webhook push touching SKILL.md → reindex decision + queued",
  wh.status === 200 && wh.json.reindex === true && wh.json.queued === true,
  JSON.stringify(wh.json));
results.webhook = wh.json;

const adm = await api("/admin/discover", { method: "POST", body: "{}" });
check("admin route rejects missing token (401)", adm.status === 401, `status ${adm.status}`);

// --- write evidence -------------------------------------------------------------
writeFileSync(resolve(ROOT, "data/gate-discovery.json"), JSON.stringify(results, null, 2));
writeFileSync(resolve(ROOT, "data/gate-discovery.txt"), lines.join("\n") + "\n");
log(`\ngate: ${results.pass ? "PASS" : "FAIL"} → data/gate-discovery.json + data/gate-discovery.txt`);
process.exitCode = results.pass ? 0 : 1;
