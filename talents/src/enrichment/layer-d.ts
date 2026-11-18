// Layer D — GENERATED EDITORIAL (ENRICHMENT.md §D), class:
// generated. An Anthropic model writes a summary, taxonomy
// categories, free tags, goal-phrased use cases and an audience
// hint for a record, grounded ONLY in the record's own source
// artefacts (source description, README, the Layer B parse). No
// outside knowledge, no web, no facts about the publisher beyond
// what the artefacts state.
//
// Custody + execution site (deliberate): the model call needs the
// ANTHROPIC_API_KEY, which lives ONLY in the Worker — so Layer D
// runs through the Worker's POST /admin/enrich route, which injects
// `generate` (cf/src/enrichment.ts). This module is the pure core:
// material assessment (the withholding rule), prompt construction,
// output validation, and the run orchestration over an injected
// generator — unit-testable with a mock, exactly like Layer C's
// probe over an injected fetch.
//
// Labelling contract: the payload lives only in d_json and is only
// ever surfaced under a `generated` key / "Generated" label. It
// NEVER overwrites or merges into the record's source description.
//
// Cost discipline (spec §D + pipeline mechanics): generation is
// keyed by source hash (pipeline layerDue), only for records with
// sufficient source material, and every attempt's real token usage
// is recorded in the payload so gates report actual spend.

import type { SkillRecord } from "../types.js";
import type { EnrichmentRow, LayerD, LayerDWithheld } from "./types.js";

// ---------------------------------------------------------------------------
// Taxonomy + audiences (fixed — the model assigns FROM this list)
// ---------------------------------------------------------------------------

export const TAXONOMY = [
  "development", "devops", "data", "documents", "communication",
  "security", "agents", "games", "media", "productivity",
  "finance", "health", "education", "science", "business",
  "testing", "design", "other",
] as const;
export type TaxonomyCategory = (typeof TAXONOMY)[number];

export const AUDIENCES = ["developer", "ops", "data", "creative", "general", "mixed"] as const;
export type Audience = (typeof AUDIENCES)[number];

// ---------------------------------------------------------------------------
// Generator interface (injected; the Worker binds the real model)
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  system: string;
  user: string;
}

export interface GenerateResult {
  text: string;
  /** The model id that actually served the request. */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type GenerateFn = (req: GenerateRequest) => Promise<GenerateResult>;

// ---------------------------------------------------------------------------
// Material assessment — the withholding rule (pure)
// ---------------------------------------------------------------------------

/** Source description shorter than this, with no README and no
 *  sub-inventory, is too thin to summarize honestly. */
export const MIN_DESCRIPTION_CHARS = 120;

/** The record's usable source description: the known "---" ingest
 *  artifact is not material (Layer B's parsed frontmatter
 *  description, when present, is). */
export function effectiveDescription(record: SkillRecord, row: EnrichmentRow | null): string {
  if (record.description.trim() !== "---") return record.description.trim();
  return row?.b?.skillParse?.parsedDescription?.trim() ?? "";
}

export interface MaterialAssessment {
  thin: boolean;
  reason?: string;
  hasReadme: boolean;
  descriptionChars: number;
  subInventoryCount: number;
}

/**
 * Withholding rule (spec §D: "empty/thin sources get NO generated
 * layer rather than a padded one"): thin ⇔ no README material AND
 * effective description < MIN_DESCRIPTION_CHARS AND no sub-inventory.
 * A record whose stored description is the "---" artifact counts as
 * description-less unless its README or sub-inventory carries it.
 */
export function assessMaterial(
  record: SkillRecord,
  row: EnrichmentRow | null,
  readmeText: string | null,
): MaterialAssessment {
  const description = effectiveDescription(record, row);
  const hasReadme = Boolean(readmeText?.trim()) || Boolean(row?.a?.readme?.excerpt?.trim());
  const subInventoryCount = row?.b?.subInventory?.length ?? 0;
  const thin = !hasReadme && description.length < MIN_DESCRIPTION_CHARS && subInventoryCount === 0;
  return {
    thin,
    ...(thin
      ? {
          reason:
            `insufficient source material: no README, description ${description.length} chars ` +
            `(< ${MIN_DESCRIPTION_CHARS})${record.description.trim() === "---" ? " (stored description is the '---' artifact)" : ""}, no sub-inventory`,
        }
      : {}),
    hasReadme,
    descriptionChars: description.length,
    subInventoryCount,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction (pure)
// ---------------------------------------------------------------------------

export interface GenerationMaterial {
  id: string;
  kind: string;
  description: string;
  readme: string | null;
  skillDescription?: string;
  subInventory: { name: string; description: string }[];
  declarationSummary: string[];
  components: string[];
}

const README_PROMPT_CAP = 12_000;
const INVENTORY_PROMPT_CAP = 40;

export function collectMaterial(
  record: SkillRecord,
  row: EnrichmentRow | null,
  readmeText: string | null,
): GenerationMaterial {
  const c = record.components;
  return {
    id: record.id,
    kind: record.kind,
    description: effectiveDescription(record, row),
    readme: readmeText ? readmeText.slice(0, README_PROMPT_CAP) : null,
    ...(row?.b?.skillParse?.frontmatter.description
      ? { skillDescription: String(row.b.skillParse.frontmatter.description) }
      : {}),
    subInventory: (row?.b?.subInventory ?? [])
      .slice(0, INVENTORY_PROMPT_CAP)
      .map((e) => ({ name: e.name, description: e.description })),
    declarationSummary: record.declaration.summary,
    components: [
      ...c.skills.map((s) => `skill: ${s}`),
      ...c.commands.map((s) => `command: ${s}`),
      ...c.agents.map((s) => `agent: ${s}`),
      ...c.mcpServers.map((s) => `mcp server: ${s}`),
    ],
  };
}

export const GENERATION_SYSTEM = [
  "You write registry catalogue copy for a skills registry. You are given ONLY the source artefacts of one listed skill/plugin/MCP server (its source description, README, file inventory and permission declaration).",
  "Rules — absolute:",
  "1. Use ONLY facts present in the artefacts. Never use outside knowledge, never guess at features, vendors, versions or popularity that the artefacts do not state.",
  "2. If the artefacts are vague, stay vague — do not pad or invent specifics.",
  "3. Write in plain, neutral catalogue English. No marketing superlatives (\"powerful\", \"seamless\", \"cutting-edge\").",
  "4. Reply with ONLY a JSON object, no prose, no code fences.",
].join("\n");

export function buildPrompt(material: GenerationMaterial, repairNote?: string): { system: string; user: string } {
  const parts: string[] = [
    `Record: ${material.id} (kind: ${material.kind})`,
    `Source description: ${material.description || "(none)"}`,
  ];
  if (material.skillDescription && material.skillDescription !== material.description) {
    parts.push(`SKILL.md frontmatter description: ${material.skillDescription}`);
  }
  if (material.components.length) parts.push(`Components: ${material.components.join("; ")}`);
  if (material.declarationSummary.length) {
    parts.push(`Registry declaration (what it does/permissions): ${material.declarationSummary.join(" ")}`);
  }
  if (material.subInventory.length) {
    parts.push(
      `Contained items (name — description):\n${material.subInventory.map((e) => `- ${e.name}${e.description ? ` — ${e.description}` : ""}`).join("\n")}`,
    );
  }
  if (material.readme) parts.push(`README (source, may be truncated):\n${material.readme}`);
  parts.push(
    [
      "Produce a JSON object with EXACTLY these keys:",
      `- "oneLine": one sentence, ≤ 140 chars, what this is and what it does.`,
      `- "paragraph": 2–3 sentences expanding the one-liner, still only from the artefacts. Keep it under 500 chars.`,
      `- "categories": 1–3 items chosen ONLY from this fixed list: ${TAXONOMY.join(", ")}.`,
      `- "tags": up to 6 short free-form tags (≤ 40 chars each) naming concrete technologies, formats or tasks from the artefacts.`,
      `- "useCases": 2–4 concrete jobs phrased as user goals, e.g. "Convert a spreadsheet of invoices into PDFs" — each ≤ 120 chars, each supported by the artefacts.`,
      `Keep the whole reply compact — it must be one complete JSON object.`,
      `- "audience": exactly one of: ${AUDIENCES.join(", ")}.`,
    ].join("\n"),
  );
  if (repairNote) parts.push(`IMPORTANT: a previous reply was invalid (${repairNote}). Reply with ONLY the corrected JSON object.`);
  return { system: GENERATION_SYSTEM, user: parts.join("\n\n") };
}

// ---------------------------------------------------------------------------
// Output validation (pure)
// ---------------------------------------------------------------------------

export interface ParsedGeneration {
  oneLine: string;
  paragraph: string;
  categories: string[];
  tags: string[];
  useCases: string[];
  audience: Audience;
}

/** Escape raw control characters (newline/tab/CR) that occur
 *  INSIDE JSON string values — a common model emission defect.
 *  Characters outside strings and existing escape sequences are
 *  passed through untouched. */
export function sanitizeJsonControlChars(s: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (const ch of s) {
    if (inStr) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

export function parseGeneration(text: string): { ok: true; value: ParsedGeneration } | { ok: false; error: string } {
  let raw = text.trim();
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) raw = fence[1].trim();
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    j = undefined;
  }
  if (typeof j === "string") {
    // The reply was a JSON string literal containing the object.
    try { j = JSON.parse(j); } catch { j = undefined; }
  }
  if (!j || typeof j !== "object") {
    // Models sometimes wrap the object in a sentence despite the
    // JSON-only instruction: fall back to the outermost {...} span.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { j = JSON.parse(raw.slice(start, end + 1)); } catch { j = undefined; }
    }
  }
  if (!j || typeof j !== "object") {
    // The reply's JSON arrived backslash-escaped ({\"oneLine\": …})
    // — seen in production from the Haiku-class model on
    // artefact-heavy prompts. Unescape, then take the span.
    if (raw.includes('\\"')) {
      const unescaped = raw.replace(/\\"/g, '"').replace(/\\n/g, "\n");
      const start = unescaped.indexOf("{");
      const end = unescaped.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { j = JSON.parse(unescaped.slice(start, end + 1)); } catch { j = undefined; }
      }
    }
  }
  if (!j || typeof j !== "object") {
    // Final leniency: models emit literal newlines/tabs inside
    // string values (invalid strict JSON, unambiguous intent).
    // Escape control characters that occur inside strings, retry.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { j = JSON.parse(sanitizeJsonControlChars(raw.slice(start, end + 1))); } catch { j = undefined; }
    }
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    return { ok: false, error: "reply is not valid JSON" };
  }
  const o = j as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  const oneLine = str(o.oneLine);
  if (!oneLine) return { ok: false, error: "oneLine missing" };
  // The prompt asks ≤140; the validator tolerates modest overshoot
  // (production replies landed at ~165) rather than discarding an
  // otherwise-valid payload for 5 characters.
  if (oneLine.length > 180) return { ok: false, error: `oneLine too long (${oneLine.length} > 180)` };
  const paragraph = str(o.paragraph);
  if (!paragraph) return { ok: false, error: "paragraph missing" };
  if (paragraph.length < 40) return { ok: false, error: `paragraph too short (${paragraph.length} < 40)` };
  if (paragraph.length > 1200) return { ok: false, error: `paragraph too long (${paragraph.length} > 1200)` };

  if (!Array.isArray(o.categories) || o.categories.length < 1 || o.categories.length > 3) {
    return { ok: false, error: "categories must be an array of 1–3" };
  }
  // Taxonomy normalization (documented): out-of-taxonomy values are
  // DROPPED when at least one valid category remains (production
  // replies mixed the audience word "creative" into categories);
  // a reply with NO valid category still fails.
  const categories: string[] = [];
  const unknown: string[] = [];
  for (const c of o.categories) {
    if (typeof c === "string" && (TAXONOMY as readonly string[]).includes(c)) {
      if (!categories.includes(c)) categories.push(c);
    } else {
      unknown.push(String(c));
    }
  }
  if (!categories.length) {
    return { ok: false, error: `category not in taxonomy: ${unknown.join(", ")}` };
  }

  if (!Array.isArray(o.tags)) return { ok: false, error: "tags must be an array" };
  const tags: string[] = [];
  for (const t of o.tags) {
    if (typeof t !== "string") return { ok: false, error: "tag is not a string" };
    const tag = t.trim().slice(0, 40);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= 6) break;
  }

  if (!Array.isArray(o.useCases) || o.useCases.length < 2 || o.useCases.length > 4) {
    return { ok: false, error: "useCases must be an array of 2–4" };
  }
  const useCases: string[] = [];
  for (const u of o.useCases) {
    const s = str(u);
    if (!s) return { ok: false, error: "useCase is empty" };
    if (s.length > 160) return { ok: false, error: `useCase too long (${s.length} > 160)` };
    useCases.push(s);
  }

  if (typeof o.audience !== "string" || !(AUDIENCES as readonly string[]).includes(o.audience)) {
    return { ok: false, error: `audience not in enum: ${String(o.audience)}` };
  }
  return { ok: true, value: { oneLine, paragraph, categories, tags, useCases, audience: o.audience as Audience } };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface LayerDDeps {
  generate: GenerateFn;
  /** The record's stored README text (R2 copy), when one exists. */
  readmeText: string | null;
}

/**
 * Run Layer D for one record against its CURRENT enrichment row
 * (Layer B's parse feeds the prompt). Returns:
 *   done    — validated generation, payload LayerD.
 *   none    — withheld by the material rule; payload records the
 *             verdict (this is what makes the verdict sticky until
 *             the source hash changes — see pipeline layerDue).
 *   partial — generation attempted but invalid/failed; usage spent
 *             is still recorded.
 */
export async function runLayerD(
  record: SkillRecord,
  row: EnrichmentRow | null,
  sourceHash: string,
  deps: LayerDDeps,
  now: Date,
): Promise<{ state: "done" | "partial" | "none"; payload: LayerD | LayerDWithheld }> {
  const at = now.toISOString();
  const assessment = assessMaterial(record, row, deps.readmeText);
  if (assessment.thin) {
    return {
      state: "none",
      payload: { generatedAt: at, sourceHash, reason: assessment.reason! },
    };
  }

  const material = collectMaterial(record, row, deps.readmeText);
  let inputTokens = 0;
  let outputTokens = 0;
  let model = "";
  let lastError = "no attempt made";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildPrompt(material, attempt > 0 ? lastError : undefined);
    let res: GenerateResult;
    try {
      res = await deps.generate(prompt);
    } catch (e) {
      lastError = `generation call failed: ${(e as Error).message}`;
      continue;
    }
    model = res.model;
    inputTokens += res.inputTokens || 0;
    outputTokens += res.outputTokens || 0;
    const parsed = parseGeneration(res.text);
    if (parsed.ok) {
      return {
        state: "done",
        payload: {
          generatedAt: at,
          model,
          sourceHash,
          ...parsed.value,
          usage: { inputTokens, outputTokens },
        },
      };
    }
    // Keep a short sample of the offending reply with the error —
    // the difference between "wrapped in prose", "truncated" and
    // "malformed JSON" is only visible in the text itself.
    lastError = `${parsed.error} | reply sample: ${res.text.slice(0, 160).replace(/\s+/g, " ")}`;
  }
  return {
    state: "partial",
    payload: {
      generatedAt: at,
      sourceHash,
      reason: "generation did not produce a valid payload",
      errors: [lastError],
      usage: { inputTokens, outputTokens },
    },
  };
}
