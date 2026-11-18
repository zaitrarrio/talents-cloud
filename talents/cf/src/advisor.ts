// TalentAdvisor — the Think-based /advisor agent (P2 remainder).
//
// A @cloudflare/think Durable Object: getModel() returns a fully
// constructed AI SDK LanguageModel from @ai-sdk/anthropic — Anthropic
// is THE model provider for Talents (user decision 2026-11-10); the key
// arrives as the ANTHROPIC_API_KEY Worker secret, the model id from the
// TALENTS_ADVISOR_MODEL var (default claude-haiku-5-5, see
// src/advisor.ts). The agent's one usable tool is search_skills over
// the same D1 FTS5-trigram engine as /api/search (beforeTurn restricts
// activeTools to it, muting Think's built-in workspace tools — an
// advisor has no business reading or writing files).
//
// The HTTP surface is POST /advisor in index.ts, which calls the
// @callable advise() below on a fresh instance per request (clean
// session per goal) and renders the result as JSON. Think's native
// WebSocket chat transport also works at
// /agents/talent-advisor/{name} via routeAgentRequest.

import { Think } from "@cloudflare/think";
import { callable } from "agents";
import { createAnthropic } from "@ai-sdk/anthropic";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { D1SearchEngine } from "../../src/search-d1.js";
import {
  ADVISOR_MODEL_DEFAULT,
  ADVISOR_TOOL_NAME,
  advisorSystemPrompt,
  classifyAdvisorError,
  extractAdvisorReply,
  shapeSearchToolOutput,
  type AdvisorReply,
} from "../../src/advisor.js";
import { unlistedSkillIds, type Env } from "./db.js";

export class TalentAdvisor extends Think<Env> {
  getModel() {
    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY ?? "" });
    return anthropic(this.env.TALENTS_ADVISOR_MODEL ?? ADVISOR_MODEL_DEFAULT);
  }

  getSystemPrompt() {
    return advisorSystemPrompt();
  }

  getTools(): ToolSet {
    return {
      [ADVISOR_TOOL_NAME]: tool({
        description:
          "Search the Talents registry (talents.sh) for skills, plugins and MCP servers matching a query. Returns matching records with id (owner/name), canonical URL, kind, and a one-line summary of what each does and declares.",
        inputSchema: z.object({
          query: z.string().describe("Concise search query derived from the user's goal, e.g. 'pdf forms' or 'api security audit'"),
          kind: z
            .enum(["skill", "plugin", "mcp", "agent"])
            .optional()
            .describe("Optional record-kind filter"),
        }),
        execute: async ({ query, kind }) => {
          const engine = new D1SearchEngine(this.env.DB);
          const hits = await engine.search({ q: query, kind, limit: 6 });
          // Owner opt-out (P4) is absolute: unlisted skills never
          // surface through the advisor either.
          const unlisted = await unlistedSkillIds(this.env.DB);
          const visible = unlisted.size ? hits.filter((h) => !unlisted.has(h.id)) : hits;
          return shapeSearchToolOutput(visible);
        },
      }),
    };
  }

  /** The advisor answers from registry search only — hide Think's
   *  built-in workspace/context tools for every turn. */
  beforeTurn() {
    return { activeTools: [ADVISOR_TOOL_NAME] };
  }

  /** Run one advisor turn for a plain-language goal and return the
   *  answer plus the structured matches (taken from the turn's
   *  search_skills tool output, not parsed out of prose). Fails closed:
   *  no key → { configured: false }; a failed turn → a coarse
   *  errorKind, never the upstream error text. */
  @callable()
  async advise(goal: string): Promise<AdvisorReply> {
    const model = this.env.TALENTS_ADVISOR_MODEL ?? ADVISOR_MODEL_DEFAULT;
    if (!this.env.ANTHROPIC_API_KEY) return { configured: false, model };
    let result;
    try {
      result = await this.runTurn({ input: goal, mode: "wait" });
    } catch (e) {
      return {
        configured: true,
        ok: false,
        model,
        errorKind: classifyAdvisorError(String((e as Error)?.message ?? e)),
      };
    }
    if (result.status !== "completed") {
      return {
        configured: true,
        ok: false,
        model,
        status: result.status,
        errorKind: classifyAdvisorError(result.error ?? ""),
      };
    }
    const message =
      result.message ??
      [...(await this.getMessages())].reverse().find((m) => m.role === "assistant");
    const { answer, matches } = extractAdvisorReply(message);
    return { configured: true, ok: true, model, answer, matches };
  }
}
