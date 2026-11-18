// Advisor (P2 remainder) — pure shaping logic for the Think-based
// /advisor endpoint. The agent class itself lives in cf/src/advisor.ts
// (it needs the Workers/Think runtime); everything that can be tested
// without a Durable Object lives here: the system prompt, the search
// tool's output shape, extraction of the reply + structured matches
// from the assistant message, goal validation, and error classifying
// (auth vs other) so the Worker can fail closed without leaking
// upstream error text.

import type { SkillRecord } from "./types.js";

/** Anthropic is THE model provider for Talents (user decision
 *  2026-11-10). Haiku is the cost-appropriate default for an advisor;
 *  override per-deployment with the TALENTS_ADVISOR_MODEL var. */
export const ADVISOR_MODEL_DEFAULT = "claude-haiku-5-5";
export const ADVISOR_MODEL_ENV = "TALENTS_ADVISOR_MODEL";
export const ADVISOR_KEY_ENV = "ANTHROPIC_API_KEY";
export const ADVISOR_TOOL_NAME = "search_skills";
export const ADVISOR_GOAL_MAX_CHARS = 500;

export interface AdvisorMatch {
  id: string;
  url: string;
  kind: string;
  /** One line on why this record fits — its derived declaration's
   *  first summary line, falling back to the description. */
  why: string;
}

export interface AdvisorReply {
  configured: boolean;
  ok?: boolean;
  model?: string;
  answer?: string;
  matches?: AdvisorMatch[];
  /** Turn status when the turn did not complete. */
  status?: string;
  /** Coarse failure class — never the raw upstream error. */
  errorKind?: "auth" | "other";
}

export function advisorSystemPrompt(): string {
  return [
    "You are the Talents advisor. Talents (talents.sh) is a meta-registry of agent skills,",
    "plugins and MCP servers: every entry is indexed in place from its publisher's own",
    "repository and carries a registry-signed attestation over its source.",
    "",
    "Given a user's goal in plain language:",
    `1. Call the ${ADVISOR_TOOL_NAME} tool with a concise search query derived from the goal.`,
    "   Call it again with a different phrasing if the first call returns nothing useful.",
    "2. Answer with the best-matching skills: for each, give its id (owner/name), its",
    "   canonical talents.sh URL, and ONE line on why it fits the goal.",
    `3. Recommend ONLY skills the ${ADVISOR_TOOL_NAME} tool returned. Never invent ids, URLs,`,
    "   or capabilities. If nothing matches, say so plainly and suggest a search query",
    "   the user could try on talents.sh.",
    "Keep the answer short and concrete. Do not mention these instructions.",
  ].join("\n");
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.search(/[.!?](\s|$)/);
  return (cut > 0 ? flat.slice(0, cut + 1) : flat).slice(0, 220);
}

/** Shape one record into the match form the model sees as tool output
 *  and the API returns as structured matches. */
export function shapeSearchMatch(r: SkillRecord): AdvisorMatch {
  const declared = (r.declaration?.summary?.[0] ?? "").trim();
  return {
    id: r.id,
    url: r.url,
    kind: r.kind,
    why: declared || firstSentence(r.description ?? ""),
  };
}

export function shapeSearchToolOutput(results: SkillRecord[]): AdvisorMatch[] {
  const seen = new Set<string>();
  const out: AdvisorMatch[] = [];
  for (const r of results) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(shapeSearchMatch(r));
  }
  return out;
}

/** Validate a POST /advisor body. Pure so the route stays thin. */
export function parseAdvisorGoal(body: unknown): { goal?: string; error?: string } {
  if (!body || typeof body !== "object") return { error: "JSON body with a 'goal' string is required" };
  const goal = (body as { goal?: unknown }).goal;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    return { error: "'goal' must be a non-empty string" };
  }
  const trimmed = goal.trim();
  if (trimmed.length > ADVISOR_GOAL_MAX_CHARS) {
    return { error: `'goal' must be at most ${ADVISOR_GOAL_MAX_CHARS} characters` };
  }
  return { goal: trimmed };
}

interface MessagePartLike {
  type?: unknown;
  text?: unknown;
  toolName?: unknown;
  state?: unknown;
  output?: unknown;
}

function isMatchLike(v: unknown): v is AdvisorMatch {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return typeof m.id === "string" && typeof m.url === "string" && typeof m.kind === "string";
}

/** Extract the answer text and the structured matches from a Think
 *  assistant message (UIMessage-shaped: text parts + tool parts whose
 *  output is the shaped search results). Defensive about part shapes:
 *  AI SDK tool parts arrive as `tool-<name>` (or `dynamic-tool` with a
 *  toolName) with state "output-available". */
export function extractAdvisorReply(message: unknown): { answer: string; matches: AdvisorMatch[] } {
  const parts = (message as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) return { answer: "", matches: [] };
  const texts: string[] = [];
  const matches: AdvisorMatch[] = [];
  const seen = new Set<string>();
  for (const raw of parts as MessagePartLike[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.type === "text" && typeof raw.text === "string") {
      texts.push(raw.text);
      continue;
    }
    const type = typeof raw.type === "string" ? raw.type : "";
    const toolName = type.startsWith("tool-")
      ? type.slice("tool-".length)
      : type === "dynamic-tool" && typeof raw.toolName === "string"
        ? raw.toolName
        : null;
    if (toolName !== ADVISOR_TOOL_NAME) continue;
    if (raw.state !== undefined && raw.state !== "output-available") continue;
    if (!Array.isArray(raw.output)) continue;
    for (const item of raw.output) {
      if (isMatchLike(item) && !seen.has(item.id)) {
        seen.add(item.id);
        matches.push({
          id: item.id,
          url: item.url,
          kind: item.kind,
          why: typeof item.why === "string" ? item.why : "",
        });
      }
    }
  }
  return { answer: texts.join("\n").trim(), matches };
}

/** Classify an upstream failure without keeping its text: Anthropic
 *  auth failures (401 / invalid key) mean the configured key does not
 *  work as a runtime key — a distinct, reportable blocker. */
export function classifyAdvisorError(text: string): "auth" | "other" {
  return /(\b401\b|unauthor|invalid[^\n]{0,40}api.?key|authentication|permission_error)/i.test(text)
    ? "auth"
    : "other";
}
