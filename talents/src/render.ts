// Page rendering (P1, extracted in P2) — ARCHITECTURE-v2 §9 P1: SSR
// skill/profile pages with JSON-LD, in the CC-B "Grove" v2 design
// language (warm paper, amber accent, Newsreader serif names,
// JetBrains Mono ids/URLs).
//
// Pure string functions, no platform imports: the SAME templates are
// rendered by the P1 node:http server (src/web.ts) and by the P2
// Cloudflare Worker (cf/src). Do not fork the design tokens — edit
// them here only.
//
// ALL record-derived text is escaped (esc): descriptions, declarations
// and file paths come from third-party repos and are untrusted input.

import type { SkillRecord, DeclarationLine, ValidationIssue } from "./types.js";
import type { SearchQueryInput } from "./search.js";
import { warningCount } from "./search.js";
import { normalizeComponents } from "./validate.js";
import type { EnrichmentView } from "./enrichment/display.js";
import { FLAG_CLASS_LABEL } from "./enrichment/layer-e.js";
import type { LayerState, SubInventoryEntry, McpToolInfo, TrustFlag } from "./enrichment/types.js";

// ---------------------------------------------------------------------------
// Escaping — every record-derived string goes through esc() before HTML.
// ---------------------------------------------------------------------------

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON-LD payloads: JSON.stringify, then neutralise `<` so a hostile
 *  description can never break out of the <script> element. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Stored-JSON guard: a stored record (or enrichment row) may carry a
 *  non-array where the type promises an array — legacy ingest shapes
 *  (e.g. components.commands stored as the bare string "./commands/",
 *  which 500'd a skill page with `c.commands.map is not a function`).
 *  Render paths coerce through arr()/normalizeComponents and omit or
 *  degrade the section — a page must NEVER throw on stored shape. */
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

// ---------------------------------------------------------------------------
// P1 trending ranking (documented): P1 has NO behavioral data yet —
// installs / 30-day retention / review velocity arrive with the gateway
// (P2) and discovery depth (P5). Until then trending ranks by:
//   attestation present → catalog substance (hashed source files +
//   declared components) − validation warnings; ties break by id.
// ---------------------------------------------------------------------------

export function trendingScore(r: SkillRecord): number {
  const c = normalizeComponents(r.components);
  const components =
    c.skills.length + c.commands.length +
    c.agents.length + c.mcpServers.length +
    (c.hooks ? 1 : 0);
  return (r.attestation ? 100 : 0) + arr(r.filesHashed).length * 5 + components * 3 - warningCount(r) * 4;
}

export function trending(records: SkillRecord[], n = 8): SkillRecord[] {
  return [...records]
    .filter((r) => r.status === "listed")
    .sort((a, b) => trendingScore(b) - trendingScore(a) || a.id.localeCompare(b.id))
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Shared chrome + styles (CC-B Grove v2 tokens, inline, no external assets)
// ---------------------------------------------------------------------------

const STYLE = `
:root{--bg:#EDEAE4;--warm:#F5F1EA;--card:#FCFBF9;--ink:#1A1714;--soft:#4A443D;--mut:#837A72;--bd:rgba(26,23,20,.12);--acc:#B4762A;--deep:#8A5A1F;--asoft:rgba(180,118,42,.1);--good:#2F7D4F;--bad:#B3402A;--code:#241E16}
*{box-sizing:border-box;margin:0}
body{font-family:"Instrument Sans",Inter,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.45}
.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;font-size:12.5px}
a{color:var(--deep);text-decoration:none}
a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:18px;padding:12px 28px;background:#1A1714;color:#EDEAE4;position:sticky;top:0;z-index:5}
.logo{font-family:Newsreader,Georgia,serif;font-size:22px;color:#fff}.logo b{color:#E8BE7E;font-weight:600}
header form{flex:0 1 380px;display:flex}
header input{flex:1;padding:8px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#fff;font-size:14px}
header nav{display:flex;gap:16px;margin-left:auto}
header nav a{color:#EDEAE4;font-size:14px}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
.av{width:32px;height:32px;border-radius:8px;background:var(--acc);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex:none}
.bigav{width:84px;height:84px;border-radius:18px;background:linear-gradient(135deg,#B4762A,#8A5A1F);color:#fff;display:flex;align-items:center;justify-content:center;font-family:Newsreader,Georgia,serif;font-size:34px;flex:none}
.hero{text-align:center;padding:26px 0 4px}
.hero h1{font-family:Newsreader,Georgia,serif;font-size:42px;font-weight:500;line-height:1.15}
.hero p{color:var(--soft);margin-top:10px;font-size:16.5px}
.goal{display:flex;gap:10px;max-width:640px;margin:24px auto 0}
.goal input{flex:1;padding:14px 18px;border:1px solid var(--bd);border-radius:999px;background:var(--card);font-size:15.5px}
.btn{background:var(--acc);color:#fff;border:0;border-radius:999px;padding:11px 22px;font-weight:600;cursor:pointer;font-size:14.5px}
.chips{display:flex;gap:8px;justify-content:center;margin:16px 0 8px;flex-wrap:wrap}
.gchip{padding:7px 15px;border-radius:999px;background:var(--card);border:1px solid var(--bd);font-size:13.5px;color:var(--ink)}
h2{font-family:Newsreader,Georgia,serif;font-size:25px;font-weight:600;margin:30px 0 6px}
.sub{color:var(--mut);font-size:13.5px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:18px;display:flex;flex-direction:column}
.cardtop{display:flex;gap:10px;align-items:flex-start}
.name{font-size:16.5px;font-weight:650}
.name span{color:var(--mut);font-weight:400}
.url{font-size:12px;color:var(--mut);font-family:"JetBrains Mono",ui-monospace,monospace;word-break:break-all}
.desc{color:var(--soft);margin-top:10px;font-size:14px}
.perm{margin-top:10px;padding:8px 11px;background:var(--warm);border-radius:9px;font-size:12.5px;color:var(--soft)}
.meta{display:flex;gap:14px;color:var(--mut);font-size:12.5px;margin-top:10px;flex-wrap:wrap}
.chip{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2.5px 8px;border-radius:999px;background:var(--asoft);color:var(--deep);vertical-align:2px}
.badge{font-size:11.5px;font-weight:700;color:var(--good);margin-left:auto;flex:none}
.panel{border:1px solid var(--bd);border-radius:12px;background:var(--card);padding:18px;margin-bottom:16px}
.panel h3{font-family:Newsreader,Georgia,serif;font-size:19px;margin-bottom:10px}
.panel h4{font-size:12.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin-bottom:10px}
.kv{display:flex;justify-content:space-between;gap:12px;font-size:13.5px;padding:5px 0;border-bottom:1px dashed var(--bd)}
.kv span:first-child{color:var(--mut)}
.code{background:var(--code);color:#EDEAE4;border-radius:10px;padding:12px 14px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12.5px;margin-top:8px;overflow-x:auto;white-space:nowrap}
.cols{display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start}
@media (max-width:820px){.cols{grid-template-columns:1fr}}
.files{border:1px solid var(--bd);border-radius:12px;overflow:hidden}
.files div{padding:9px 14px;background:var(--card);border-bottom:1px solid var(--bd);font-size:13px}
.issue{font-size:13.5px;padding:7px 0;border-bottom:1px dashed var(--bd)}
.issue .sev-warn{color:var(--acc);font-weight:700}
.issue .sev-err{color:var(--bad);font-weight:700}
.ok{color:var(--good);font-weight:600}
.decl li{margin:7px 0 7px 18px;color:var(--soft);font-size:14px}
.note{font-size:12.5px;color:var(--mut)}
.src{border:1px solid var(--bd);border-radius:12px;background:var(--warm);padding:13px 16px;font-size:13.5px;margin:14px 0 18px}
footer{color:var(--mut);font-size:12.5px;text-align:center;padding:26px 16px 40px}
.searchbar{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
.searchbar input[type=text]{flex:1;min-width:220px;padding:12px 16px;border:1px solid var(--bd);border-radius:999px;background:var(--card);font-size:15px}
.searchbar select,.searchbar input[type=search]{padding:12px 14px;border:1px solid var(--bd);border-radius:999px;background:var(--card);font-size:14px}
.facetrow{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
`;

/** Shared page shell (header/footer/Grove chrome). Exported for the
 *  Creator Experience pages (cf/src/render-creator.ts) so dashboard
 *  screens use the identical chrome — one design contract. */
export function renderPageShell(title: string, body: string, headExtra = ""): string {
  return page(title, body, headExtra);
}

function page(title: string, body: string, headExtra = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · talents.sh</title>
<style>${STYLE}</style>
${headExtra}
</head>
<body>
<header>
  <a class="logo" href="/">talents<b>.sh</b></a>
  <form method="get" action="/search" role="search"><input type="text" name="q" placeholder="Search skills, owners, MCP servers…" aria-label="Search"></form>
  <nav><a href="/">Home</a><a href="/search">Search</a></nav>
</header>
<main class="wrap">
${body}
</main>
<footer>Talents is a meta-registry: it stores metadata, pointers and attestations — never a copy of a skill. Installs resolve from the original source, pinned.</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Cards + fragments
// ---------------------------------------------------------------------------

function firstDeclarationLine(r: SkillRecord): string {
  return arr<string>(r.declaration?.summary)[0] ?? arr<DeclarationLine>(r.declaration?.lines)[0]?.text ?? "No permissions derived yet.";
}

export function skillCard(r: SkillRecord): string {
  const initial = esc((r.owner[0] ?? "?").toUpperCase());
  return `<article class="card">
  <div class="cardtop">
    <span class="av">${initial}</span>
    <div>
      <div class="name"><a href="/skills/${esc(r.owner)}/${esc(r.name)}">${esc(r.owner)} <span>/ ${esc(r.name)}</span></a> <span class="chip">${esc(r.kind)}</span></div>
      <div class="url">talents.sh/skills/${esc(r.owner)}/${esc(r.name)}</div>
    </div>
    ${r.attestation ? `<span class="badge">✓ Attested</span>` : ``}
  </div>
  <p class="desc">${esc(r.description)}</p>
  <div class="perm">🔒 ${esc(firstDeclarationLine(r))}</div>
  <div class="meta">
    ${r.sourceRepo ? `<span class="mono">${esc(r.sourceRepo)} @ ${esc(r.ref)}</span>` : `<span>source: ${esc(r.sourceType)}</span>`}
    <span>${arr(r.filesHashed).length} file(s) hashed</span>
    ${warningCount(r) ? `<span>${warningCount(r)} warning(s)</span>` : ``}
  </div>
</article>`;
}

function codeBlock(text: string): string {
  return `<div class="code">${esc(text)}</div>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface RenderHomeOptions {
  /** P5: pre-ranked trending records (gateway-call velocity). When
   *  absent, the static P1 ranking above is used — the P1/P2 page
   *  output is unchanged. */
  trending?: SkillRecord[];
  /** Sub-line under the Trending heading (P5 states which ranking
   *  produced the section, honestly). */
  trendingNote?: string;
  /** Catalog totals, supplied by the Worker so the page need not
   *  load the whole catalog to print its own header line (the
   *  50 MB D1 response limit made that a 500 — gate-d1size). When
   *  absent, the counts are derived from the records passed in
   *  (P1/CLI, which hold their own record sets). */
  counts?: { total: number; owners: number };
}

export function renderHome(records: SkillRecord[], opts: RenderHomeOptions = {}): string {
  const top = opts.trending ?? trending(records, 8);
  const total = opts.counts?.total ?? records.length;
  const owners = opts.counts?.owners ?? new Set(records.map((r) => r.owner)).size;
  const body = `<section class="hero">
  <h1>What should your agent<br>do for you?</h1>
  <p>Skills, plugins and MCP servers — indexed where they live, vouched for by attestation.<br>No import, no export: if it exists on GitHub, it can be listed here.</p>
  <form class="goal" method="get" action="/search">
    <input type="text" name="q" placeholder="Try &quot;pdf&quot;, &quot;security&quot;, &quot;document&quot;…">
    <button class="btn" type="submit">Search</button>
  </form>
  <div class="chips">
    <a class="gchip" href="/search?q=pdf">Work with PDFs</a>
    <a class="gchip" href="/search?q=security">Audit API security</a>
    <a class="gchip" href="/search?q=document">Process documents</a>
    <a class="gchip" href="/search?kind=mcp">MCP servers</a>
    <a class="gchip" href="/search?kind=skill">Standalone skills</a>
  </div>
</section>
<h2>Trending in the catalog</h2>
<p class="sub">${total} records from ${owners} publishers · ${opts.trendingNote ?? "P1 ranking: attestation → catalog substance → fewest warnings (behavioral ranking lands in P5)"}</p>
<div class="grid">
${top.map(skillCard).join("\n")}
</div>`;
  return page("Skills, indexed where they live", body);
}

export function skillJsonLd(r: SkillRecord): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `${r.owner}/${r.name}`,
    url: r.url,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Claude Code",
    description: r.description,
    author: { "@type": "Organization", name: r.owner, url: r.profileUrl },
    isAccessibleForFree: true,
  };
  // Records carry no pricing in P0/P1 data — `offers` is added by P4
  // (Stripe Connect pricing metadata) when a record is priced.
  return ld;
}

function componentsList(r: SkillRecord): string {
  // Defensive: a legacy stored record may carry a bare string (or an
  // object) for a collection — normalizeComponents coerces a string to
  // a one-element display and drops unusable shapes, never throws.
  const c = normalizeComponents(r.components);
  const rows: string[] = [];
  if (c.skills.length) rows.push(`<li><strong>Skills</strong> — ${c.skills.map(esc).join(", ")}</li>`);
  if (c.commands.length) rows.push(`<li><strong>Commands</strong> — ${c.commands.map(esc).join(", ")}</li>`);
  if (c.agents.length) rows.push(`<li><strong>Agents</strong> — ${c.agents.map(esc).join(", ")}</li>`);
  if (c.mcpServers.length) rows.push(`<li><strong>MCP servers</strong> — ${c.mcpServers.map(esc).join(", ")}</li>`);
  if (c.hooks) rows.push(`<li><strong>Hooks</strong> — yes</li>`);
  return rows.length ? `<ul class="decl">${rows.join("\n")}</ul>` : `<p class="note">No components declared.</p>`;
}

export interface RenderSkillPageOptions {
  /** P5: related skills rail (vector neighbours + structural blend,
   *  from /api/suggest). Absent/empty → page renders exactly as P1/P2. */
  related?: SkillRecord[];
  /** P4: the owner's namespace is claimed — show the Verified
   *  publisher badge. */
  verifiedPublisher?: boolean;
  /** P4: the displayed description is the publisher's override, not
   *  the attested source text — labelled as such (trust honesty:
   *  the attestation covers the SOURCE description). */
  publisherDescription?: boolean;
  /** P4: commercial state for the "Use this skill" panel. Absent →
   *  the panel renders exactly as P1/P2 (free listing). */
  purchase?: {
    priceFormatted: string;
    exclusive: boolean;
    /** Stripe is configured on this deployment. When false the Buy
     *  control renders DISABLED with an honest note — never a dead
     *  button that silently does nothing. */
    paymentsEnabled: boolean;
    /** The signed-in viewer owns an entitlement for this skill. */
    buyerEntitled: boolean;
    /** The signed-in viewer is the claiming publisher. */
    isOwner?: boolean;
  };
  /** Enrichment (layers A–E): source facts, README excerpt,
   *  sub-inventory, MCP package facts, live-introspected tools,
   *  the labelled GENERATED summary panel (D), trust flags in the
   *  Declaration (E), and the factual layer-state line. Absent →
   *  the page renders exactly as before. Classes stay labelled:
   *  source facts say "source", introspection carries its probe
   *  date, generated content carries its permanent label, and the
   *  rest is derived and says so. */
  enrichment?: EnrichmentView;
}

const fmtNum = (n: number): string => n.toLocaleString("en-US");
const fmtDate = (iso: string): string => iso.slice(0, 10);

/** Mark for one layer in the factual registry line:
 *  done ✓ · partial ◐ · stale ↻ · pending · · none —. */
export const layerMark = (state: LayerState): string =>
  state === "done" ? "✓" : state === "partial" ? "◐" : state === "stale" ? "↻" : state === "pending" ? "·" : "—";

/** The enrichment panels for a skill page (A–E). Split by column:
 *  `left` goes under About/Components, `right` under the Record
 *  panel; `toolsBlock` (introspected tools) and `trustBlock`
 *  (Layer E flags) are appended INSIDE the Declaration panel —
 *  tools because the inventory upgrades the declaration, flags
 *  because they are declaration-grade facts about the source. */
function enrichmentPanels(e: EnrichmentView): { left: string; right: string; toolsBlock: string; trustBlock: string } {
  let left = "";
  let right = "";
  let toolsBlock = "";
  let trustBlock = "";

  if (e.generated) {
    const g = e.generated;
    left += `<div class="panel"><h3>Generated summary</h3>
      <p style="font-size:15.5px"><strong>${esc(g.oneLine)}</strong></p>
      <p style="color:var(--soft);margin-top:6px">${esc(g.paragraph)}</p>
      ${arr<string>(g.useCases).length ? `<h4 style="margin:12px 0 6px">Use cases</h4><ul class="decl">${arr<string>(g.useCases).map((u) => `<li>${esc(u)}</li>`).join("\n")}</ul>` : ""}
      <div style="margin-top:10px">${[...arr<string>(g.categories), ...arr<string>(g.tags)].map((t) => `<span class="chip">${esc(t)}</span>`).join(" ")}</div>
      <p class="note" style="margin-top:10px">Generated by the registry from the source — not the publisher's words. Model: ${esc(g.model)} · ${esc(fmtDate(g.generatedAt))}.</p></div>`;
  }

  if (e.readmeExcerpt) {
    left += `<div class="panel"><h3>From the README</h3><p style="color:var(--soft)">${esc(e.readmeExcerpt)}</p><p class="note" style="margin-top:8px">Excerpt of the source README, stored by the registry — the full text lives at the origin.</p></div>`;
  }

  const inside: string[] = [];
  const subInventory = arr<SubInventoryEntry>(e.subInventory);
  if (subInventory.length) {
    inside.push(`<h4 style="margin-bottom:6px">Contents — ${subInventory.length} item${subInventory.length === 1 ? "" : "s"}${e.subInventoryTruncated ? " (partial — source tree or fetch caps reached)" : ""}</h4>`
      + subInventory.map((s) => `<div class="issue"><span class="chip">${esc(s.kind)}</span> <strong>${esc(s.name)}</strong>${s.description ? ` — <span style="color:var(--soft)">${esc(s.description)}</span>` : ""}</div>`).join("\n"));
  }
  if (e.skillFacts) {
    const f = e.skillFacts;
    const allowedTools = arr<string>(f.allowedTools);
    const externalUrls = arr(f.externalUrls);
    inside.push(`<h4 style="margin:12px 0 6px">Instructions — <span class="mono">${esc(f.path)}</span></h4>
      <div class="kv"><span>Instruction size</span><span>${fmtNum(f.instructionLines)} lines · ~${fmtNum(f.tokenEstimate)} tokens (estimate)</span></div>
      ${allowedTools.length ? `<div class="kv"><span>Allowed tools</span><span class="mono">${allowedTools.map(esc).join(", ")}</span></div>` : ""}
      ${f.model ? `<div class="kv"><span>Model hint</span><span class="mono">${esc(f.model)}</span></div>` : ""}
      ${f.license ? `<div class="kv"><span>License (frontmatter)</span><span>${esc(f.license)}</span></div>` : ""}
      <div class="kv"><span>Referenced local files</span><span>${f.referencedFiles}</span></div>
      ${externalUrls.length ? `<div class="kv"><span>External URLs referenced</span><span>${externalUrls.length}</span></div>` : ""}`);
  }
  if (e.mcpPackage) {
    const m = e.mcpPackage;
    const envVars = arr<string>(m.envVars);
    inside.push(`<h4 style="margin:12px 0 6px">MCP package</h4>
      ${m.packageName ? `<div class="kv"><span>Package</span><span class="mono">${esc(m.packageName)}${m.version ? `@${esc(m.version)}` : ""}${m.registry ? ` (${esc(m.registry)})` : ""}</span></div>` : ""}
      <div class="kv"><span>Transport</span><span class="mono">${esc(m.transport)}</span></div>
      ${envVars.length ? `<div class="kv"><span>Requires env vars</span><span class="mono">${envVars.map(esc).join(", ")}</span></div>
      <p class="note" style="margin-top:6px">Variable names only — the registry never records values.</p>` : `<div class="kv"><span>Requires env vars</span><span>none declared</span></div>`}`);
  }
  if (e.pluginMeta) {
    const p = e.pluginMeta;
    const keywords = arr<string>(p.keywords);
    const bits = [
      p.author ? `Author: ${esc(p.author)}` : "",
      p.homepage ? `Homepage: <a href="${esc(p.homepage)}">${esc(p.homepage)}</a>` : "",
      keywords.length ? `Keywords: ${keywords.map(esc).join(", ")}` : "",
    ].filter(Boolean);
    if (bits.length) inside.push(`<p class="note" style="margin-top:10px">${bits.join(" · ")}</p>`);
  }
  if (inside.length) {
    left += `<div class="panel"><h3>Inside this package <span class="note">(derived by the registry from the source files)</span></h3>${inside.join("\n")}</div>`;
  }

  if (e.tools) {
    const t = e.tools;
    toolsBlock = `<h4 style="margin-top:14px">Tools (live, introspected ${esc(fmtDate(t.probedAt))})</h4>
      <ul class="decl">${arr<McpToolInfo>(t.tools).map((tool) => `<li><span class="mono">${esc(tool.name)}</span>${tool.description ? ` — ${esc(tool.description)}` : ""}</li>`).join("\n")}</ul>
      <p class="note" style="margin-top:8px">Read-only probe of ${esc(t.endpointHost)}${t.serverName ? ` (server: ${esc(t.serverName)})` : ""} on ${esc(fmtDate(t.probedAt))} — the registry connected, listed, and never invoked a tool. Point-in-time: the live server may differ today.${t.resourceCount !== undefined || t.promptCount !== undefined ? ` Also offered: ${t.resourceCount ?? 0} resource(s), ${t.promptCount ?? 0} prompt(s).` : ""}</p>`;
  }

  if (e.trustFlags) {
    const t = e.trustFlags;
    const lines: string[] = [];
    const flags = arr<TrustFlag>(t.flags);
    if (flags.length) {
      for (const f of flags) {
        lines.push(`<li>Source references: ${esc(FLAG_CLASS_LABEL[f.class])} <span class="mono">(${esc(f.file)})</span><br><span class="note mono">${esc(f.evidence)}</span></li>`);
      }
    } else {
      lines.push(`<li>No v1 risky patterns found in the pinned source.</li>`);
    }
    if (t.drift === "changed") {
      lines.push(`<li>The source has changed since this record was pinned — re-verification is queued.</li>`);
    }
    trustBlock = `<h4 style="margin-top:14px">Source pattern scan <span class="note">(derived — static scan of the pinned source, ${esc(fmtDate(t.scannedAt))}; facts, not a verdict)</span></h4>
      <ul class="decl">${lines.join("\n")}</ul>`;
  }

  if (e.sourceFacts) {
    const s = e.sourceFacts;
    const rows: string[] = [];
    if (s.stars !== undefined) rows.push(`<div class="kv"><span>Stars</span><span>★ ${fmtNum(s.stars)}</span></div>`);
    if (s.forks !== undefined) rows.push(`<div class="kv"><span>Forks</span><span>${fmtNum(s.forks)}</span></div>`);
    if (s.contributorsLabel) rows.push(`<div class="kv"><span>Contributors</span><span>${esc(s.contributorsLabel)}</span></div>`);
    if (s.licenseSpdx) rows.push(`<div class="kv"><span>License</span><span>${esc(s.licenseSpdx)}</span></div>`);
    if (s.language) rows.push(`<div class="kv"><span>Primary language</span><span>${esc(s.language)}</span></div>`);
    if (s.pushedAt) rows.push(`<div class="kv"><span>Last push</span><span>${esc(fmtDate(s.pushedAt))}</span></div>`);
    if (s.latestReleaseTag) rows.push(`<div class="kv"><span>Latest release</span><span class="mono">${esc(s.latestReleaseTag)}</span></div>`);
    if (s.archived) rows.push(`<div class="kv"><span>Repository</span><span style="color:var(--bad);font-weight:600">archived</span></div>`);
    if (s.npmWeeklyDownloads !== undefined && s.npmWeeklyDownloads !== null) rows.push(`<div class="kv"><span>npm downloads / week</span><span>${fmtNum(s.npmWeeklyDownloads)}</span></div>`);
    if (s.npmMonthlyDownloads !== undefined && s.npmMonthlyDownloads !== null) rows.push(`<div class="kv"><span>npm downloads / month</span><span>${fmtNum(s.npmMonthlyDownloads)}</span></div>`);
    if (s.npmLatestVersion) rows.push(`<div class="kv"><span>Latest npm version</span><span class="mono">${esc(s.npmLatestVersion)}</span></div>`);
    if (s.npmDeprecated) rows.push(`<div class="kv"><span>npm package</span><span style="color:var(--bad);font-weight:600">deprecated</span></div>`);
    if (rows.length) {
      right = `<div class="panel"><h4>Source facts</h4>${rows.join("\n")}<p class="note" style="margin-top:8px">Fetched from the origin (GitHub / npm) · as of ${esc(fmtDate(s.asOf))}. Facts, refreshed on a weekly cadence — not a rating.</p></div>`;
    }
  }

  return { left, right, toolsBlock, trustBlock };
}

export function renderSkillPage(r: SkillRecord, opts: RenderSkillPageOptions = {}): string {
  const enr = opts.enrichment ? enrichmentPanels(opts.enrichment) : { left: "", right: "", toolsBlock: "", trustBlock: "" };
  const ld = skillJsonLd(r);
  if (opts.purchase) {
    // P4: a priced listing is not free; say so in structured data too.
    ld.isAccessibleForFree = false;
  }
  const headExtra = `<script type="application/ld+json">${jsonForScript(ld)}</script>`;
  const declLines = arr<DeclarationLine>(r.declaration?.lines)
    .map((l) => `<li><span class="chip">${esc(l.kind)}</span> ${esc(l.text)}</li>`)
    .join("\n");
  const undeclaredList = arr<string>(r.declaration?.undeclared);
  const undeclared = undeclaredList.length
    ? `<h4 style="margin-top:14px">Undeclared — sandbox / Playground only until the publisher confirms</h4><ul class="decl">${undeclaredList.map((u) => `<li>${esc(u)}</li>`).join("\n")}</ul>`
    : "";
  const issueList = arr<ValidationIssue>(r.validation?.issues);
  const issues = issueList.length
    ? issueList.map((i) =>
        `<div class="issue"><span class="${i.severity === "warning" ? "sev-warn" : "sev-err"}">${i.severity === "warning" ? "⚠ warning" : "✗ error"}</span> <span class="mono">${esc(i.code)}</span> — ${esc(i.message)}</div>`,
      ).join("\n")
    : `<p class="ok">✓ No validation issues</p>`;
  const filesHashed = arr<string>(r.filesHashed);
  const att = r.attestation
    ? `<div class="kv"><span>Algorithm</span><span class="mono">${esc(r.attestation.algorithm)}</span></div>
       <div class="kv"><span>Content hash</span><span class="mono" style="word-break:break-all">${esc(r.attestation.contentHash)}</span></div>
       <div class="kv"><span>Signed</span><span>${esc(r.attestation.signedAt)}</span></div>
       <div class="kv"><span>Signature</span><span class="mono" style="word-break:break-all">${esc(r.attestation.signature.slice(0, 44))}…</span></div>
       <p class="note" style="margin-top:8px">The registry signs the hash of the source at the pinned ref. If the source changes after pinning, the hash fails and integrating hosts refuse it.</p>`
    : `<p class="note">No attestation — pointer-only record.</p>`;
  const body = `<div class="cardtop" style="align-items:center">
    ${opts.enrichment?.iconUrl
      ? `<img class="av" style="width:44px;height:44px;object-fit:cover;background:var(--card)" src="${esc(opts.enrichment.iconUrl)}" alt="" loading="lazy">`
      : `<span class="av" style="width:44px;height:44px;font-size:17px">${esc((r.owner[0] ?? "?").toUpperCase())}</span>`}
    <div>
      <div class="name" style="font-size:24px;font-family:Newsreader,Georgia,serif"><a href="/${esc(r.owner)}">${esc(r.owner)}</a> <span>/ ${esc(r.name)}</span> <span class="chip">${esc(r.kind)}</span></div>
      <div class="url" style="font-size:13px">talents.sh/skills/${esc(r.owner)}/${esc(r.name)}</div>
    </div>
    ${r.attestation ? `<span class="badge">✓ Registry attested</span>` : ``}
    ${opts.verifiedPublisher ? `<span class="badge" style="color:var(--deep)">✓ Verified publisher</span>` : ``}
  </div>
  <div class="src">
    ${r.sourceRepo ? `Source: <span class="mono">github.com/${esc(r.sourceRepo)}${r.sourcePath ? `/${esc(r.sourcePath)}` : ""} @ ${esc(r.ref)}</span> · found via ${esc(r.sourceMarketplace)}<br>` : `Source: ${esc(r.sourceType)} · found via ${esc(r.sourceMarketplace)}<br>`}
    <span class="note">Indexed in place — Talents stores metadata + attestation, never a copy. Installs resolve from this source, pinned to the ref above.</span>
  </div>
  <div class="cols">
    <div>
      <div class="panel"><h3>About</h3><p style="color:var(--soft)">${esc(r.description)}</p>${opts.publisherDescription ? `<p class="note" style="margin-top:8px"><span class="chip">Publisher description</span> Written by the publisher in Creator Studio. The registry attestation covers the source record; this text is the publisher's own words.</p>` : ``}</div>
      <div class="panel"><h3>Components</h3>${componentsList(r)}</div>
      ${enr.left}
      <div class="panel"><h3>Declaration <span class="note">(derived by the registry from the source — the publisher wrote no manifest)</span></h3>
        <ul class="decl">${declLines}</ul>${undeclared}
        ${enr.toolsBlock}
        ${enr.trustBlock}
        <p class="note" style="margin-top:10px">Derived from: ${arr<string>(r.declaration?.derivedFrom).map(esc).join(" · ")}</p>
      </div>
      <div class="panel"><h3>Validation</h3>${issues}</div>
      <div class="panel"><h3>Files hashed</h3>
        <div class="files">${filesHashed.length ? filesHashed.map((f) => `<div class="mono">${esc(f)}</div>`).join("\n") : `<div class="note">Marketplace entry only (pointer-only)</div>`}</div>
      </div>
    </div>
    <div>
      ${opts.purchase ? `<div class="panel"><h4>Buy this skill</h4>
        <p style="font-size:20px;font-family:Newsreader,Georgia,serif">${esc(opts.purchase.priceFormatted)}${opts.purchase.exclusive ? ` <span class="chip">Talents exclusive</span>` : ``}</p>
        ${opts.purchase.buyerEntitled
          ? `<p class="ok" style="margin-top:8px">✓ You own this listing — install is unlocked for you below, and via the MCP gateway with your account.</p>`
          : opts.purchase.isOwner
            ? `<p class="note" style="margin-top:8px">This is your listing, priced in Creator Studio. The split is ${opts.purchase.exclusive ? "88% to you / 12% platform" : "85% to you / 15% platform"}.</p>`
            : opts.purchase.paymentsEnabled
              ? `<form method="post" action="/api/checkout/${esc(r.owner)}/${esc(r.name)}" style="margin-top:10px"><button class="btn" type="submit">Buy — ${esc(opts.purchase.priceFormatted)}</button></form>
                 <p class="note" style="margin-top:8px">Checkout is handled by Stripe; the publisher is paid via Stripe Connect (${opts.purchase.exclusive ? "88%" : "85%"} of the price). After checkout you'll receive a one-time install token for the MCP gateway.</p>`
              : `<button class="btn" type="button" disabled aria-disabled="true" style="margin-top:10px;opacity:.55;cursor:not-allowed">Buy — ${esc(opts.purchase.priceFormatted)}</button>
                 <p class="note" style="margin-top:8px">Payments are not yet enabled on talents.sh for this listing — the publisher has set a price, but checkout opens once the platform's Stripe account is connected. The listing's source remains installable from its origin in the meantime.</p>`}
      </div>` : ``}
      <div class="panel"><h4>Use this skill — no import, no export</h4>
        <p style="font-size:13.5px;color:var(--soft)">In Claude Code, once:</p>
        ${codeBlock("/plugin marketplace add talents")}
        <p style="font-size:13.5px;color:var(--soft);margin-top:12px">Then install by name:</p>
        ${codeBlock(`/plugin install ${r.owner}/${r.name}`)}
        <p style="font-size:13.5px;color:var(--soft);margin-top:12px">Or ask any connected agent:</p>
        ${codeBlock(`Use ${r.owner}/${r.name}@${r.ref}`)}
      </div>
      <div class="panel"><h4>Attestation</h4>${att}</div>
      <div class="panel"><h4>Record</h4>
        <div class="kv"><span>Kind</span><span>${esc(r.kind)}</span></div>
        <div class="kv"><span>Source type</span><span>${esc(r.sourceType)}</span></div>
        <div class="kv"><span>Status</span><span>${esc(r.status)}</span></div>
        <div class="kv"><span>Publisher</span><span><a href="/${esc(r.owner)}">talents.sh/${esc(r.owner)}</a></span></div>
        <div class="kv"><span>Indexed</span><span>${esc(r.ingestedAt)}</span></div>
        ${opts.enrichment?.layers ? `<div class="kv"><span>Registry enrichment</span><span>A ${layerMark(opts.enrichment.layers.a)} · B ${layerMark(opts.enrichment.layers.b)} · C ${layerMark(opts.enrichment.layers.c)} · D ${layerMark(opts.enrichment.layers.d)} · E ${layerMark(opts.enrichment.layers.e)}</span></div>` : ``}
      </div>
      ${enr.right}
    </div>
  </div>${opts.related && opts.related.length ? `
  <h2>Related skills</h2>
  <div class="grid">
${opts.related.map(skillCard).join("\n")}
  </div>` : ``}`;
  return page(`${r.owner}/${r.name}`, body, headExtra);
}

export interface RenderProfileOptions {
  /** P4: namespace claimed via GitHub proof — Verified publisher. */
  verified?: boolean;
  /** P4: honest state line for namespaces that cannot be claimed
   *  via GitHub sign-in (e.g. MCP-Registry label owners). */
  claimNote?: string;
}

export function renderProfile(owner: string, records: SkillRecord[], opts: RenderProfileOptions = {}): string {
  const byKind = new Map<string, number>();
  for (const r of records) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  const sources = [...new Set(records.map((r) => r.sourceRepo ?? r.sourceMarketplace))];
  const kindStats = [...byKind.entries()].map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(" · ");
  const body = `<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
    <div class="bigav">${esc((owner[0] ?? "?").toUpperCase())}</div>
    <div>
      <h2 style="margin:0;font-size:30px">${esc(owner)}${opts.verified ? ` <span class="badge" style="color:var(--deep);font-size:13px">✓ Verified publisher</span>` : ``}</h2>
      <div class="url" style="font-size:14px">talents.sh/${esc(owner)}</div>
      ${opts.claimNote ? `<p class="note" style="margin-top:4px">${esc(opts.claimNote)}</p>` : ``}
      <p style="color:var(--soft);margin-top:6px">${records.length} record${records.length === 1 ? "" : "s"} in the catalog · ${esc(kindStats)}<br>
      <span class="note">Sources: ${sources.map(esc).join(" · ")}</span></p>
    </div>
  </div>
  <h2>Skills &amp; plugins</h2>
  <div class="grid">
  ${records.map(skillCard).join("\n")}
  </div>`;
  return page(owner, body);
}

const KIND_FACETS = ["skill", "plugin", "mcp", "agent"];

export function renderSearchPage(input: SearchQueryInput, results: SkillRecord[], note?: string | null): string {
  const q = input.q ?? "";
  const facetLinks = [
    `<a class="gchip" href="/search?q=${encodeURIComponent(q)}">all kinds</a>`,
    ...KIND_FACETS.map((k) =>
      `<a class="gchip" href="/search?q=${encodeURIComponent(q)}&amp;kind=${k}"${input.kind === k ? ` style="border-color:var(--acc);background:var(--asoft)"` : ""}>${k}</a>`),
  ].join("\n");
  const body = `<h2 style="margin-top:6px">Search the catalog</h2>
  <form class="searchbar" method="get" action="/search">
    <input type="text" name="q" value="${esc(q)}" placeholder="Search skills, plugins, MCP servers…">
    <select name="kind" aria-label="Kind">
      <option value="">all kinds</option>
      ${KIND_FACETS.map((k) => `<option value="${k}"${input.kind === k ? " selected" : ""}>${k}</option>`).join("\n")}
    </select>
    <input type="search" name="owner" value="${esc(input.owner ?? "")}" placeholder="owner (optional)" aria-label="Owner">
    <button class="btn" type="submit">Search</button>
  </form>
  <div class="facetrow">${facetLinks}</div>
  <p class="sub">${results.length} result${results.length === 1 ? "" : "s"}${q ? ` for &quot;${esc(q)}&quot;` : ""}${input.kind ? ` · kind: ${esc(input.kind)}` : ""}${input.owner ? ` · owner: ${esc(input.owner)}` : ""}</p>
  ${note ? `<div class="panel" role="note" style="border-color:var(--acc);background:var(--asoft)"><p style="margin:0"><strong>Partial match.</strong> ${esc(note)}</p></div>` : ""}
  ${results.length
    ? `<div class="grid">\n${results.map(skillCard).join("\n")}\n</div>`
    : `<div class="panel"><p style="color:var(--soft)">Nothing in the catalog matches yet. Skills are indexed in place from GitHub — if it exists as a SKILL.md, plugin or marketplace, it can be listed with zero changes by its author.</p></div>`}`;
  return page(q ? `Search: ${q}` : "Search", body);
}

export function render404(what: string): string {
  const body = `<section class="hero">
  <h1>404 — not in the catalog</h1>
  <p>${esc(what)} isn't listed. It may not be indexed yet — Talents indexes skills in place from their original sources.</p>
  <form class="goal" method="get" action="/search">
    <input type="text" name="q" placeholder="Search the catalog…">
    <button class="btn" type="submit">Search</button>
  </form>
</section>`;
  return page("Not found", body);
}

