// skills.sh FULL ENUMERATION harvest (backfill: harvest only —
// nomination happens in backfill-nominate.mjs from the checkpoint
// this writes).
//
// The public API 401s (Vercel OIDC), so enumeration runs over the
// published sitemap tree: /sitemap.xml → sitemap-skills-*.xml carry
// every listing as /{owner}/{repo}/{skill}. Install counts are not
// in the sitemap; they come from the public listing pages' embedded
// payloads via the scout's own extractor (/, /trending, /hot,
// /official) — the only installs surface the site exposes without
// the API. Fetches are paced politely.
//
// Usage: backfill_remote.py backfill-skillssh.mjs [--state F]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIST, sleep, nowIso } from "./backfill-lib.mjs";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const statePath = args.includes("--state") ? args[args.indexOf("--state") + 1] : "/tmp/backfill-skillssh-harvest.json";

const { extractSkillsShListings } = await import(pathToFileURL(join(DIST, "src/discovery/scouts/skills-sh.js")).href);

const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const REPO_RE = /^[a-z0-9._-]+$/;
const RESERVED = new Set(["agent", "agents", "api", "about", "audits", "contact", "docs", "hot", "official", "packs", "privacy", "search", "site", "terms", "topic", "topics", "trending", "_next"]);
function normalizeLocator(ownerRaw, repoRaw) {
  const owner = ownerRaw.trim().toLowerCase();
  const repo = repoRaw.trim().toLowerCase().replace(/\.git$/, "");
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  if (RESERVED.has(owner)) return null;
  if (repo === "." || repo === "..") return null;
  return `${owner}/${repo}`;
}

async function getText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "talents-backfill", accept: "application/xml, text/html" } });
      return { status: res.status, text: res.ok ? await res.text() : "" };
    } catch (e) {
      if (i === tries - 1) { console.log(`fetch failed ${url}: ${e.message}`); return { status: 0, text: "" }; }
      await sleep(3000 * (i + 1));
    }
  }
  return { status: 0, text: "" };
}

const state = { startedAt: nowIso(), sitemaps: [], listings: 0, repos: {}, installsKnown: 0 };

// 1) Sitemap index → sub-sitemaps → listing URLs.
const index = await getText("https://www.skills.sh/sitemap.xml");
const subSitemaps = [...index.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
console.log(`sitemap index: ${subSitemaps.length} sub-sitemaps`);
for (const sm of subSitemaps) {
  await sleep(1200);
  const r = await getText(sm);
  const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  let skillUrls = 0;
  for (const loc of locs) {
    const parts = new URL(loc).pathname.split("/").filter(Boolean);
    if (parts.length !== 3) continue; // only /{owner}/{repo}/{skill} are listings
    const locator = normalizeLocator(parts[0], parts[1]);
    if (!locator) continue;
    skillUrls++;
    state.listings++;
    const agg = state.repos[locator] ?? { listings: 0 };
    agg.listings++;
    state.repos[locator] = agg;
  }
  state.sitemaps.push({ url: sm, status: r.status, locs: locs.length, skillUrls });
  console.log(`${sm}: ${locs.length} urls, ${skillUrls} listings, unique repos so far ${Object.keys(state.repos).length}`);
}

// 2) Install counts from the public listing pages (scout extractor).
for (const page of ["https://www.skills.sh/", "https://www.skills.sh/trending", "https://www.skills.sh/hot", "https://www.skills.sh/official"]) {
  await sleep(1200);
  try {
    const r = await getText(page);
    if (!r.text) { console.log(`${page}: HTTP ${r.status}, no body`); continue; }
    const listings = extractSkillsShListings(r.text);
    let attached = 0;
    for (const l of listings) {
      const agg = state.repos[l.locator];
      if (agg && l.installs !== undefined && (agg.installs === undefined || l.installs > agg.installs)) {
        agg.installs = l.installs;
        attached++;
      } else if (!agg && l.installs !== undefined) {
        state.repos[l.locator] = { listings: 0, installs: l.installs };
        attached++;
      }
    }
    console.log(`${page}: ${listings.length} listings parsed, ${attached} install figures merged`);
  } catch (e) {
    console.log(`${page}: fetch failed (${e.message})`);
  }
}
state.installsKnown = Object.values(state.repos).filter((r) => r.installs !== undefined).length;
state.finishedAt = nowIso();
writeFileSync(statePath, JSON.stringify(state));
console.log(JSON.stringify({
  sitemaps: state.sitemaps.length,
  listings: state.listings,
  uniqueRepos: Object.keys(state.repos).length,
  installsKnown: state.installsKnown,
}, null, 2));
