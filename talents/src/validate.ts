// Validation pipeline mirroring the basics of `claude plugin validate`.
// Per-entry results: one bad entry never fails the whole ingest — it lands
// in the dead-letter list with a publisher-notice payload.

import type { ValidationIssue, ValidationResult, DeadLetter, SkillRecord } from "./types.js";
import { isValidSkillName } from "./namespace.js";
import type { PluginJson, SkillFrontmatter } from "./declaration.js";

export interface MarketplaceJson {
  name?: string;
  description?: string;
  owner?: { name?: string; email?: string };
  plugins?: MarketplaceEntry[];
  [k: string]: unknown;
}

export interface MarketplaceEntry {
  name?: string;
  description?: string;
  source?: unknown;
  strict?: boolean;
  // Publishers write these as a bare string OR an array (the plugin
  // spec allows both) — consumers must normalize via stringArray.
  skills?: string | string[];
  commands?: string | string[];
  agents?: string | string[];
  category?: string;
  author?: unknown;
  [k: string]: unknown;
}

export function validateMarketplace(mj: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!mj || typeof mj !== "object") {
    return [{ severity: "error", code: "marketplace-not-object", message: "marketplace.json is not a JSON object" }];
  }
  const m = mj as MarketplaceJson;
  if (!m.name) issues.push({ severity: "error", code: "marketplace-name", message: "marketplace.json has no name" });
  if (!Array.isArray(m.plugins)) {
    issues.push({ severity: "error", code: "marketplace-plugins", message: "marketplace.json has no plugins array" });
  }
  return issues;
}

export function validateEntry(entry: MarketplaceEntry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!entry.name) {
    issues.push({ severity: "error", code: "entry-name", message: "plugin entry has no name" });
  } else if (!isValidSkillName(entry.name)) {
    issues.push({ severity: "warning", code: "entry-name-slug", message: `plugin name "${entry.name}" is not a clean lowercase slug` });
  }
  if (entry.source === undefined || entry.source === null || entry.source === "") {
    issues.push({ severity: "error", code: "entry-source", message: "plugin entry has no source" });
  }
  if (!entry.description) {
    issues.push({ severity: "error", code: "entry-description", message: "plugin entry has no description" });
  }
  return issues;
}

export function validatePluginJson(pj: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!pj || typeof pj !== "object") {
    return [{ severity: "error", code: "pluginjson-not-object", message: "plugin.json is not a JSON object" }];
  }
  const p = pj as PluginJson;
  if (!p.name) issues.push({ severity: "error", code: "pluginjson-name", message: "plugin.json has no name" });
  // Policy (user decision 2026-11-10): a missing version is a WARNING, never a
  // dead-letter — requiring it would force publishers to change their repos,
  // which breaks the zero-change availability principle. Versionless entries
  // stay listed and are pinned by commit SHA (the record's ref) instead of a
  // version tag; the warning surfaces in the record's validation + health score.
  if (!p.version) issues.push({ severity: "warning", code: "pluginjson-version", message: "plugin.json has no version — entry is pinned by commit SHA instead of a version tag" });
  if (!p.description) issues.push({ severity: "error", code: "pluginjson-description", message: "plugin.json has no description" });
  return issues;
}

/** Minimal YAML-frontmatter parser for SKILL.md (flat scalar keys only — enough for name/description/license).
 *  Plain scalars, quoted scalars, folded continuations and block scalars
 *  (`|` literal / `>` folded, with chomping/indent indicators) are handled.
 *  Block scalars matter: a large share of published SKILL.md files write
 *  their description as a block scalar, and the pre-2026-11-11 parser
 *  stored the indicator itself as the value's first token ("| Routes any
 *  game-development request…" — 1,585 listed records carried the debris). */
export function parseSkillFrontmatter(md: string): { frontmatter: SkillFrontmatter | null; issue?: ValidationIssue } {
  if (!md.startsWith("---")) {
    return { frontmatter: null, issue: { severity: "error", code: "skill-frontmatter", message: "SKILL.md has no YAML frontmatter" } };
  }
  const end = md.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: null, issue: { severity: "error", code: "skill-frontmatter", message: "SKILL.md frontmatter is not terminated" } };
  }
  const block = md.slice(3, end);
  const fm: Record<string, unknown> = {};
  const lines = block.split("\n").map((l) => l.replace(/\r$/, ""));
  let currentKey: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      let v = m[2].trim();
      const blockHeader = v.match(/^[|>]([+-]?)([0-9])?\s*$/) ?? v.match(/^[|>]([0-9])([+-])?\s*$/);
      if (blockHeader) {
        // YAML block scalar: the following lines that are blank or
        // indented belong to the scalar; it ends at the first non-blank
        // line back at column 0 (the next key or the closing delimiter).
        const folded = v.startsWith(">");
        const chomp = blockHeader[1] === "+" || blockHeader[1] === "-" ? blockHeader[1] : blockHeader[2] === "+" || blockHeader[2] === "-" ? blockHeader[2] : "";
        const digit = [blockHeader[1], blockHeader[2]].find((g) => g && /^[0-9]$/.test(g));
        const raw: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const cl = lines[j];
          if (cl.trim() === "" || /^[ \t]/.test(cl)) raw.push(cl);
          else break;
        }
        i = j - 1;
        const firstContent = raw.find((l) => l.trim() !== "");
        const indent = digit
          ? parseInt(digit, 10)
          : firstContent
            ? (firstContent.match(/^[ \t]*/) as RegExpMatchArray)[0].length
            : 0;
        const stripped = raw.map((l) => {
          if (l.trim() === "") return "";
          const own = (l.match(/^[ \t]*/) as RegExpMatchArray)[0].length;
          return l.slice(Math.min(indent, own));
        });
        if (folded) {
          // Folded: line breaks inside a paragraph become spaces; blank
          // lines separate paragraphs and survive as newlines.
          const paragraphs: string[] = [];
          let para: string[] = [];
          for (const l of stripped) {
            if (l === "") {
              if (para.length) { paragraphs.push(para.join(" ")); para = []; }
            } else para.push(l);
          }
          if (para.length) paragraphs.push(para.join(" "));
          v = paragraphs.join("\n");
        } else {
          v = stripped.join("\n");
        }
        // Chomping: "+" keeps trailing newlines; clip (default) keeps at
        // most one; "-" strips them all. A stored scalar never needs the
        // trailing blanks, so clip and strip converge on trimEnd here.
        v = chomp === "+" ? v.replace(/\n+$/, "\n") : v.replace(/\n+$/, "");
        fm[currentKey] = v;
      } else {
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        fm[currentKey] = v;
      }
    } else if (currentKey && line.trim()) {
      // continuation of a folded scalar
      fm[currentKey] = `${fm[currentKey]} ${line.trim()}`;
    }
  }
  if (!fm.name) return { frontmatter: fm, issue: { severity: "error", code: "skill-name", message: "SKILL.md frontmatter has no name" } };
  if (!fm.description) return { frontmatter: fm, issue: { severity: "error", code: "skill-description", message: "SKILL.md frontmatter has no description" } };
  return { frontmatter: fm as SkillFrontmatter };
}

/**
 * A candidate record description is usable only when it carries real
 * content: at least one letter or digit (Unicode-aware — CJK and other
 * scripts count as content). Empty strings, delimiter-only values
 * ("---", "***", "…") and structural debris (a banner line like
 * "/====/", a lone block-scalar "|") are NOT usable descriptions.
 * Sources in the wild do write `description: ---` literally in their
 * frontmatter (dnyoussef/context-cascade did, twice); before this guard
 * existed the value was stored verbatim as the record's description.
 * Every ingest path picks its description through usableDescription so
 * debris falls through to the next source instead of being listed.
 */
export function isUsableDescription(s: unknown): s is string {
  return typeof s === "string" && /[\p{L}\p{N}]/u.test(s);
}

/**
 * Coerce an unknown component-collection value to a string array.
 * Publisher artifacts (marketplace entries, plugin.json) routinely
 * carry a BARE STRING where the registry model wants an array — the
 * Claude Code plugin spec itself allows `commands: "./commands/"` —
 * and a bare string stored verbatim crashes array consumers
 * (`c.commands.map is not a function`, the aaron-marketing page 500).
 * Shape rule: non-empty string → one-element array; array → its
 * non-empty string elements, order preserved; anything else → [].
 * Every ingest path builds component collections through here (and
 * render/search normalize defensively through normalizeComponents),
 * so the stored shape is always the typed shape.
 */
export function stringArray(v: unknown): string[] {
  if (typeof v === "string") return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return [];
}

/** Normalize a components object of unknown provenance to the typed
 *  shape: the four collections are always string arrays, hooks is a
 *  boolean. Idempotent — a well-shaped components object passes
 *  through value-equal. */
export function normalizeComponents(c: unknown): SkillRecord["components"] {
  const o = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
  return {
    skills: stringArray(o.skills),
    commands: stringArray(o.commands),
    agents: stringArray(o.agents),
    hooks: Boolean(o.hooks),
    mcpServers: stringArray(o.mcpServers),
  };
}

/** First usable candidate, trimmed; "" when none is usable. */
export function usableDescription(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    if (isUsableDescription(c)) return c.trim();
  }
  return "";
}

/**
 * Fallback description from a SKILL.md body (the markdown after the
 * frontmatter): the first ATX heading, or the first paragraph carrying
 * usable content. Thematic breaks, HTML comments and debris-only lines
 * (banner rules wrapped in C-style comment markers) are skipped.
 * Returns null when the body offers nothing usable — the caller then
 * honestly stores no fallback.
 */
export function bodyDescription(md: string): string | null {
  let body = md;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) {
      const nl = body.indexOf("\n", end + 1);
      body = nl === -1 ? "" : body.slice(nl + 1);
    }
  }
  let paragraph: string[] = [];
  const flush = (): string | null => {
    if (!paragraph.length) return null;
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    return isUsableDescription(text) ? text : null;
  };
  let inComment = false;
  for (const rawLine of body.split("\n")) {
    let line = rawLine.trim();
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const p = flush();
      if (p) return p;
      if (isUsableDescription(heading[1])) return heading[1].trim();
      continue;
    }
    if (line === "") {
      const p = flush();
      if (p) return p;
      continue;
    }
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line)) continue; // thematic break
    // Strip C-style comment wrappers from banner lines.
    line = line.replace(/^\/\*+/, "").replace(/\*+\/$/, "").trim();
    if (!isUsableDescription(line)) continue;
    paragraph.push(line);
  }
  return flush();
}

export function validateSkillMd(md: string): { frontmatter: SkillFrontmatter | null; issues: ValidationIssue[] } {
  const { frontmatter, issue } = parseSkillFrontmatter(md);
  return { frontmatter, issues: issue ? [issue] : [] };
}

export function resultFor(name: string, issues: ValidationIssue[]): ValidationResult {
  return { entryName: name, ok: !issues.some((i) => i.severity === "error"), issues };
}

export function toDeadLetter(
  marketplace: string,
  entryName: string,
  issues: ValidationIssue[],
  publisherEmail: string | null,
): DeadLetter {
  const errors = issues.filter((i) => i.severity === "error");
  const reason = errors.map((e) => e.message).join("; ") || "validation failed";
  return {
    marketplace,
    entryName,
    reason,
    issues,
    notice: {
      to: publisherEmail,
      subject: `[talents.sh] Listing problem: ${entryName} in ${marketplace}`,
      body:
        `Your plugin "${entryName}" (via marketplace ${marketplace}) could not be listed on talents.sh.\n` +
        `Problems found by the validation pipeline:\n${issues.map((i) => `- [${i.severity}] ${i.message}`).join("\n")}\n` +
        `Fix the source in place and push — the registry re-indexes automatically on push. No re-submission is needed.`,
    },
    at: new Date().toISOString(),
  };
}
