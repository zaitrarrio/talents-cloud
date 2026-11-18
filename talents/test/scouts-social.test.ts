// Scouts Phase 2 (social/web channels) — skills.sh, web-search, x.
// All parsing/extraction logic is tested as pure functions against
// hand-written fixtures matching the live payload shapes (skills.sh
// RSC flight data verified live 2026-11-10); run()-level tests use
// injected fake FetchFns. No live network.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { FetchFn } from "../src/types.js";
import { Pacer } from "../src/discovery/sweep.js";
import type { ScoutContext } from "../src/discovery/scouts/types.js";
import {
  skillsShScout, extractSkillsShListings, parseSkillsShApi,
} from "../src/discovery/scouts/skills-sh.js";
import {
  webSearchScout, parseDuckDuckGoHtml, parseBingHtml, extractWebCandidates,
  WEB_SCOUT_QUERIES,
} from "../src/discovery/scouts/web.js";
import {
  xScout, extractXCandidates, X_SCOUT_QUERIES, type XPost,
} from "../src/discovery/scouts/x.js";

const resp = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});

function ctx(fetchFn: FetchFn): ScoutContext {
  return {
    fetchFn,
    pacer: new Pacer(0, async () => {}, () => 0),
    now: () => new Date("2026-11-10T00:00:00.000Z"),
    getSyncState: async () => null,
    setSyncState: async () => {},
  };
}

const noFetch: FetchFn = async () => { throw new Error("no network in this test"); };

// ---------------------------------------------------------------------------
// skills.sh — pure parsing
// ---------------------------------------------------------------------------

test("scouts: parseSkillsShApi reads unknown shapes, dedups by locator keeping max installs", () => {
  const listings = parseSkillsShApi({
    skills: [
      { source: "Acme/Skills", installs: 1200 },
      { source: "acme/skills", installs: 3400 }, // same repo, bigger listing wins
      { repo: "beta/tools", totalInstalls: 55 },
      { github: "https://github.com/gamma/widgets", installCount: 7 },
      { owner: "delta", repo: "delta-hub", installs: 3 },
      { name: "no-locator-here", installs: 999 },
    ],
  });
  const byLocator = new Map(listings.map((l) => [l.locator, l.installs]));
  assert.equal(byLocator.get("acme/skills"), 3400);
  assert.equal(byLocator.get("beta/tools"), 55);
  assert.equal(byLocator.get("gamma/widgets"), 7);
  assert.equal(byLocator.get("delta/delta-hub"), 3);
  assert.equal(listings.length, 4);
  assert.deepEqual(parseSkillsShApi({ error: "authentication_required" }), []);
  assert.deepEqual(parseSkillsShApi(null), []);
});

// Live shape (2026-11-10): RSC flight payload, backslash-escaped JSON
// with "initialSkills":[{source, skillId, name, installs, weeklyInstalls}].
const SKILLS_SH_FLIGHT = String.raw`<script>self.__next_f.push([1,"53:[\"$\",\"$L61\",null,{\"initialSkills\":[{\"source\":\"acme/skills\",\"skillId\":\"pdf\",\"name\":\"pdf\",\"installs\":1200,\"weeklyInstalls\":[10,20]},{\"source\":\"acme/skills\",\"skillId\":\"docx\",\"name\":\"docx\",\"installs\":3400,\"weeklyInstalls\":[5,6]},{\"source\":\"beta/tools\",\"skillId\":\"forge\",\"name\":\"forge\",\"installs\":42}]}]"])</script>`;

// Live shape on /official: {"owner":…, "repos":[{repo, totalInstalls, skills:[…]}]}.
const SKILLS_SH_OFFICIAL = String.raw`<script>self.__next_f.push([1,"{\"owners\":[{\"owner\":\"aave\",\"repos\":[{\"repo\":\"aave/skills\",\"totalInstalls\":10,\"skills\":[{\"name\":\"deleverage\",\"installs\":2}]}]}]"])</script>`;

test("scouts: extractSkillsShListings reads flight initialSkills + installs, deduped", () => {
  const listings = extractSkillsShListings(SKILLS_SH_FLIGHT);
  const byLocator = new Map(listings.map((l) => [l.locator, l.installs]));
  assert.equal(listings.length, 2);
  assert.equal(byLocator.get("acme/skills"), 3400); // max across the repo's skills
  assert.equal(byLocator.get("beta/tools"), 42);
});

test("scouts: extractSkillsShListings reads the /official owner/repos shape and row hrefs", () => {
  const official = extractSkillsShListings(SKILLS_SH_OFFICIAL);
  assert.deepEqual(official, [{ locator: "aave/skills", installs: 10 }]);

  const rows = extractSkillsShListings(
    `<a class="group" href="/gamma/widgets/some-skill"><h3>some-skill</h3><p>gamma/widgets</p></a>`,
  );
  assert.deepEqual(rows, [{ locator: "gamma/widgets" }]);

  const asJson = extractSkillsShListings(JSON.stringify({ data: [{ source: "zeta/repo", installs: 9 }] }));
  assert.deepEqual(asJson, [{ locator: "zeta/repo", installs: 9 }]);
});

// ---------------------------------------------------------------------------
// skills.sh — run()
// ---------------------------------------------------------------------------

test("scouts: skills.sh run falls back to listing pages when the API returns 401", async () => {
  const fetchFn: FetchFn = async (url) => {
    if (url === "https://skills.sh/api/v1/skills") {
      return resp(401, { error: "authentication_required", message: "This endpoint requires authentication." });
    }
    if (url.startsWith("https://www.skills.sh/")) return resp(200, SKILLS_SH_FLIGHT);
    return resp(404, "not found");
  };
  const { nominations, stats } = await skillsShScout.run(ctx(fetchFn), {});
  assert.equal(stats.blocked, undefined);
  assert.equal(stats.nominated, 2);
  assert.ok(stats.calls >= 2, "API call + at least one fallback page");
  const acme = nominations.find((n) => n.locator === "acme/skills");
  assert.ok(acme);
  assert.equal(acme.kind, "skill-repo");
  assert.equal(acme.url, "https://github.com/acme/skills");
  assert.equal(acme.provenance.via, "skills.sh");
  assert.equal(acme.provenance.signals?.installs, 3400);
  assert.equal(acme.signalScore, 3400);
  assert.equal(acme.provenance.at, "2026-11-10T00:00:00.000Z");
});

test("scouts: skills.sh run uses the API when it answers 200, and blocks honestly when nothing works", async () => {
  const apiFetch: FetchFn = async () => resp(200, { skills: [{ source: "acme/skills", installs: 12 }] });
  const ok = await skillsShScout.run(ctx(apiFetch), {});
  assert.equal(ok.stats.calls, 1);
  assert.equal(ok.nominations[0].locator, "acme/skills");
  assert.equal(ok.nominations[0].signalScore, 12);

  const deadFetch: FetchFn = async (url) =>
    url.includes("/api/") ? resp(401, { error: "authentication_required" }) : resp(404, "nope");
  const dead = await skillsShScout.run(ctx(deadFetch), {});
  assert.equal(dead.nominations.length, 0);
  assert.ok(dead.stats.blocked?.includes("authentication_required"));
});

// ---------------------------------------------------------------------------
// web-search — pure parsing
// ---------------------------------------------------------------------------

const DDG_HTML = `
<div class="result results_links">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Facme%2Fskills&amp;rut=deadbeef">Acme Skills &amp; Tools</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">A <b>skill</b> repo for agents</a>
</div>
<div class="result results_links">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fblog.example.com%2Fskills-roundup&amp;rut=cafe">Skills roundup</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=y">Weekly roundup post</a>
</div>`;

const BING_HTML = `
<ol id="b_results">
<li class="b_algo"><h2><a href="https://github.com/beta/tools" target="_blank">Beta Tools</a></h2>
<div class="b_caption"><p>Beta <strong>tools</strong> for Claude</p></div></li>
<li class="b_algo"><h2><a href="https://www.npmjs.com/package/@scope/pkg" target="_blank">@scope/pkg</a></h2>
<div class="b_caption"><p>An npm package</p></div></li>
</ol>`;

test("scouts: parseDuckDuckGoHtml decodes uddg redirects and pairs snippets", () => {
  const results = parseDuckDuckGoHtml(DDG_HTML);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://github.com/acme/skills");
  assert.equal(results[0].title, "Acme Skills & Tools");
  assert.equal(results[0].snippet, "A skill repo for agents");
  assert.equal(results[1].url, "https://blog.example.com/skills-roundup");
});

test("scouts: parseBingHtml reads b_algo blocks", () => {
  const results = parseBingHtml(BING_HTML);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://github.com/beta/tools");
  assert.equal(results[0].title, "Beta Tools");
  assert.equal(results[0].snippet, "Beta tools for Claude");
  assert.equal(results[1].url, "https://www.npmjs.com/package/@scope/pkg");
});

test("scouts: extractWebCandidates classifies repo / scoped npm / lead and dedups", () => {
  const noms = extractWebCandidates([
    { title: "a", url: "https://github.com/Acme/Skills/blob/main/SKILL.md", snippet: "", query: "q1", rank: 0 },
    { title: "a2", url: "https://github.com/acme/skills", snippet: "", query: "q1", rank: 1 }, // dup
    { title: "b", url: "https://www.npmjs.com/package/@scope/pkg", snippet: "", query: "q1", rank: 2 },
    { title: "c", url: "https://blog.example.com/post", snippet: "", query: "q1", rank: 3 },
    { title: "d", url: "https://github.com/topics/claude-skills", snippet: "", query: "q1", rank: 4 },
  ], "2026-11-10T00:00:00.000Z");
  assert.equal(noms.length, 4);
  const repo = noms.find((n) => n.kind === "skill-repo");
  assert.equal(repo?.locator, "acme/skills");
  assert.equal(repo?.url, "https://github.com/acme/skills");
  assert.equal(repo?.signalScore, 10);
  assert.equal(repo?.provenance.signals?.query, "q1");
  const npm = noms.find((n) => n.kind === "npm-package");
  assert.equal(npm?.locator, "@scope/pkg");
  const leads = noms.filter((n) => n.kind === "lead");
  assert.equal(leads.length, 2); // the blog post AND the github.com/topics page
  assert.ok(leads.every((n) => n.provenance.note === "unresolved lead — not a repo/package"));
  assert.ok(WEB_SCOUT_QUERIES.length >= 5);
});

// ---------------------------------------------------------------------------
// web-search — run()
// ---------------------------------------------------------------------------

test("scouts: web run falls back to Bing when DuckDuckGo throws", async () => {
  const fetchFn: FetchFn = async (url) => {
    if (url.includes("duckduckgo.com")) throw new Error("network down");
    if (url.includes("bing.com")) return resp(200, BING_HTML);
    return resp(404, "not found");
  };
  const { nominations, stats } = await webSearchScout.run(ctx(fetchFn), { queries: ["agent skills"] });
  assert.equal(stats.blocked, undefined);
  assert.equal(stats.calls, 2); // DDG attempt + Bing attempt
  assert.equal(stats.examined, 2);
  assert.ok(nominations.some((n) => n.kind === "skill-repo" && n.locator === "beta/tools"));
  assert.ok(nominations.some((n) => n.kind === "npm-package" && n.locator === "@scope/pkg"));
  const repo = nominations.find((n) => n.locator === "beta/tools");
  assert.equal(repo?.provenance.via, "web-search");
  assert.equal(repo?.provenance.signals?.query, "agent skills");
});

test("scouts: web run reports blocked when every provider fails", async () => {
  const { nominations, stats } = await webSearchScout.run(ctx(noFetch), { queries: ["x"] });
  assert.equal(nominations.length, 0);
  assert.ok(stats.blocked?.includes("all web search providers failed"));
});

// ---------------------------------------------------------------------------
// x — pure extraction
// ---------------------------------------------------------------------------

test("scouts: extractXCandidates resolves repo + npm links, linkless posts go to the watchlist", () => {
  const posts: XPost[] = [
    { url: "https://x.com/alice/status/1", author: "alice", text: "shipped my skill repo https://github.com/Acme/Skills — try it", likes: 10, reposts: 3 },
    { url: "https://x.com/bob/status/2", author: "bob", text: "now on npm: https://www.npmjs.com/package/@scope/pkg", likes: 4, reposts: 0 },
    { url: "https://x.com/carol/status/3", author: "carol", text: "big announcement, no links here", likes: 7, reposts: 1 },
    { url: "https://x.com/dan/status/4", author: "dan", text: "shortened only https://t.co/abc123", likes: 1, reposts: 0 },
  ];
  const noms = extractXCandidates(posts, "2026-11-10T00:00:00.000Z");
  assert.equal(noms.length, 4);
  const repo = noms.find((n) => n.kind === "skill-repo");
  assert.equal(repo?.locator, "acme/skills");
  assert.equal(repo?.signalScore, 10 + 2 * 3);
  assert.equal(repo?.provenance.ref, "https://x.com/alice/status/1");
  assert.equal(repo?.provenance.signals?.author, "alice");
  const npm = noms.find((n) => n.kind === "npm-package");
  assert.equal(npm?.locator, "@scope/pkg");
  const watchlist = noms.filter((n) => n.kind === "x-post");
  assert.equal(watchlist.length, 2); // linkless post AND the t.co-only post
  assert.ok(watchlist.every((n) => n.provenance.note?.includes("watchlist only, never ingestable")));
  assert.ok(X_SCOUT_QUERIES.includes("SKILL.md"));
});

test("scouts: extractXCandidates merges a repo across posts, summing engagement, ref = hottest post", () => {
  const posts: XPost[] = [
    { url: "https://x.com/alice/status/1", author: "alice", text: "https://github.com/acme/skills", likes: 10, reposts: 1 }, // eng 12
    { url: "https://x.com/bob/status/2", author: "bob", text: "also https://github.com/acme/skills !", likes: 5, reposts: 5 }, // eng 15
  ];
  const noms = extractXCandidates(posts, "2026-11-10T00:00:00.000Z");
  assert.equal(noms.length, 1);
  assert.equal(noms[0].provenance.signals?.likes, 15);
  assert.equal(noms[0].provenance.signals?.reposts, 6);
  assert.equal(noms[0].signalScore, 15 + 2 * 6);
  assert.equal(noms[0].provenance.ref, "https://x.com/bob/status/2");
  assert.equal(noms[0].provenance.signals?.author, "bob");
});

// ---------------------------------------------------------------------------
// x — run()
// ---------------------------------------------------------------------------

test("scouts: x run blocks without a provider, nominates with posts / postsProvider", async () => {
  const blockedRun = await xScout.run(ctx(noFetch), {});
  assert.equal(blockedRun.nominations.length, 0);
  assert.equal(
    blockedRun.stats.blocked,
    "no X posts provider configured (production: X API or social-search capture, fed in as posts)",
  );
  assert.equal(blockedRun.stats.calls, 0);

  const posts: XPost[] = [
    { url: "https://x.com/alice/status/1", author: "alice", text: "https://github.com/acme/skills", likes: 2, reposts: 0 },
  ];
  const withPosts = await xScout.run(ctx(noFetch), { posts });
  assert.equal(withPosts.stats.blocked, undefined);
  assert.equal(withPosts.stats.examined, 1);
  assert.equal(withPosts.nominations[0].locator, "acme/skills");

  const withProvider = await xScout.run(ctx(noFetch), { postsProvider: async () => posts });
  assert.equal(withProvider.nominations.length, 1);
});
