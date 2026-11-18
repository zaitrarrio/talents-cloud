// GitHub Code Search FULL-COVEREGE harvest (backfill phase 1:
// harvest only — nomination happens in backfill-nominate.mjs from
// the checkpoint file this writes).
//
// For each base query (filename:SKILL.md, filename:marketplace.json,
// path:.claude-plugin filename:plugin.json): paginate per_page=100
// to the API's 1,000-hit window, reading total_count. Then shard —
// path-segment, size-range, language, fork/archived splits — each
// shard with its own 1,000-hit window, so the union reaches well
// past the base window. Hits dedupe to unique repos across ALL
// queries and shards. Auth is the established ghapi-backed fetch
// (no token in this process). Pacing: ~5s between calls (≤12/min,
// under the ~30/min code-search ceiling); on 403/429 the shard is
// parked after exponential backoff and the run moves on — parked
// shards are listed in the checkpoint for a resume pass.
//
// Usage: backfill_remote.py backfill-github.mjs [--state F] [--only base|shards|all]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { makeDeps, sleep, nowIso } from "./backfill-lib.mjs";

const args = process.argv.slice(2);
const statePath = args.includes("--state") ? args[args.indexOf("--state") + 1] : "/tmp/backfill-github-harvest.json";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : "all";

const BASE_QUERIES = [
  { q: "filename:SKILL.md", tag: "skill" },
  { q: "filename:marketplace.json", tag: "marketplace" },
  { q: "path:.claude-plugin filename:plugin.json", tag: "plugin" },
];

const PATH_SHARDS = [
  "skills", "skill", ".claude", ".claude-plugin", "plugins", "plugin",
  "agents", "agent", "commands", "hooks", "docs", "examples",
  "templates", "src", "tools", "prompts", "marketplace", "catalog",
];
const SIZE_SHARDS = ["size:<2000", "size:2000..6000", "size:6000..15000", "size:>15000"];
const LANG_SHARDS = ["language:Markdown", "language:TypeScript", "language:JavaScript", "language:Python", "language:Go", "language:Rust", "language:Shell"];
const FLAG_SHARDS = ["fork:true", "archived:true"];

function shardQueries() {
  const out = [];
  for (const { q, tag } of BASE_QUERIES) {
    for (const p of PATH_SHARDS) out.push({ q: `${q} path:${p}`, tag, shard: `path:${p}` });
    for (const s of SIZE_SHARDS) out.push({ q: `${q} ${s}`, tag, shard: s });
    for (const l of LANG_SHARDS) out.push({ q: `${q} ${l}`, tag, shard: l });
    for (const f of FLAG_SHARDS) out.push({ q: `${q} ${f}`, tag, shard: f });
  }
  return out;
}

const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { startedAt: nowIso(), queries: {}, repos: {}, parked: [], rateLimitEvents: [], calls: 0 };
const save = () => writeFileSync(statePath, JSON.stringify(state));

const { fetchFn } = await makeDeps({ pacerMs: 300 });

async function fetchPage(query, page) {
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
  let attempt = 0;
  for (;;) {
    state.calls++;
    let res;
    try {
      res = await fetchFn(url, { headers: { "user-agent": "talents-backfill", accept: "application/vnd.github+json" } });
    } catch {
      res = { ok: false, status: 0, json: async () => ({}) };
    }
    if (res.ok) {
      const j = await res.json();
      return { status: 200, total: j.total_count ?? null, items: Array.isArray(j.items) ? j.items : [] };
    }
    const status = res.status ?? 0;
    if ((status === 403 || status === 429) && attempt < 3) {
      const backoff = Math.min(480_000, 60_000 * 2 ** attempt);
      state.rateLimitEvents.push({ at: nowIso(), query, page, status, backoffMs: backoff });
      save();
      console.log(`  rate-limited (${status}) on "${query}" p${page} — backing off ${backoff / 1000}s`);
      await sleep(backoff);
      attempt++;
      continue;
    }
    return { status, total: null, items: [] };
  }
}

async function runWindow({ q, tag, shard = "base" }) {
  const key = `${tag}::${shard}`;
  if (state.queries[key]?.done) { console.log(`skip (done) ${key}`); return; }
  await sleep(5000);
  const rec = state.queries[key] ?? { query: q, tag, shard, total: null, retrieved: 0, pages: 0, done: false };
  state.queries[key] = rec;
  for (let page = 1; page <= 10; page++) {
    const r = await fetchPage(q, page);
    if (r.status !== 200) {
      if (r.status === 403 || r.status === 429) {
        state.parked.push({ key, query: q, tag, shard, atPage: page, status: r.status });
        console.log(`  PARKED ${key} at page ${page} (HTTP ${r.status})`);
      } else {
        rec.error = r.status;
        rec.done = true;
        console.log(`  ${key}: HTTP ${r.status} — window closed`);
      }
      save();
      return;
    }
    if (r.total !== null) rec.total = r.total;
    rec.pages = page;
    rec.retrieved += r.items.length;
    for (const it of r.items) {
      const full = (it.repository?.full_name ?? "").toLowerCase();
      if (!full.includes("/")) continue;
      const agg = state.repos[full] ?? { url: it.repository?.html_url ?? `https://github.com/${full}`, skill: 0, marketplace: 0, plugin: 0, shards: [] };
      agg[tag]++;
      if (!agg.shards.includes(key)) agg.shards.push(key);
      state.repos[full] = agg;
    }
    save();
    if (r.items.length < 100) break;
    await sleep(5000);
  }
  rec.done = true;
  save();
  console.log(`${key}: total=${rec.total} retrieved=${rec.retrieved} uniqueReposSoFar=${Object.keys(state.repos).length}`);
}

if (only === "base" || only === "all") {
  for (const b of BASE_QUERIES) await runWindow(b);
}
if (only === "shards" || only === "all") {
  for (const s of shardQueries()) await runWindow(s);
}
state.finishedAt = nowIso();
save();
console.log(JSON.stringify({
  calls: state.calls,
  windows: Object.keys(state.queries).length,
  parked: state.parked.length,
  rateLimitEvents: state.rateLimitEvents.length,
  uniqueRepos: Object.keys(state.repos).length,
  perTag: Object.fromEntries(BASE_QUERIES.map(({ tag }) => [tag, state.queries[`${tag}::base`] ?? null])),
}, null, 2));
