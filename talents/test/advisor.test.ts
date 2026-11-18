// Advisor tests — the pure shaping logic behind the Think /advisor
// endpoint (src/advisor.ts): tool-output shaping, reply extraction from
// a Think assistant message, goal validation, error classification.
// The agent class + live model call are gated separately
// (scripts/gate-advisor.mjs → data/gate-advisor.json) because they need
// the deployed Worker and the ANTHROPIC_API_KEY secret.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { SkillRecord, RegistryFile } from "../src/types.js";
import {
  ADVISOR_MODEL_DEFAULT,
  advisorSystemPrompt,
  classifyAdvisorError,
  extractAdvisorReply,
  parseAdvisorGoal,
  shapeSearchMatch,
  shapeSearchToolOutput,
} from "../src/advisor.js";

const DATA = resolve(dirname(new URL(import.meta.url).pathname), "../../data");

function loadRecord(id: string): SkillRecord {
  const parsed = JSON.parse(readFileSync(resolve(DATA, "registry.json"), "utf8")) as RegistryFile;
  const rec = parsed.records[id];
  assert.ok(rec, `fixture record ${id} exists in registry.json`);
  return rec;
}

test("advisor defaults: Anthropic haiku model, prompt names the search tool", () => {
  assert.equal(ADVISOR_MODEL_DEFAULT, "claude-haiku-5-5");
  const prompt = advisorSystemPrompt();
  assert.match(prompt, /search_skills/);
  assert.match(prompt, /talents\.sh/);
  assert.match(prompt, /Never invent ids/);
});

test("shapeSearchMatch: why comes from the derived declaration's first line", () => {
  const rec = loadRecord("anthropics/pdf");
  const m = shapeSearchMatch(rec);
  assert.equal(m.id, "anthropics/pdf");
  assert.equal(m.url, "https://talents.sh/skills/anthropics/pdf");
  assert.equal(m.kind, rec.kind);
  assert.ok(m.why.length > 0);
  assert.equal(m.why, rec.declaration.summary[0]);
});

test("shapeSearchToolOutput dedupes by id and preserves order", () => {
  const a = loadRecord("anthropics/pdf");
  const b = loadRecord("anthropics/xlsx");
  const out = shapeSearchToolOutput([a, b, a]);
  assert.deepEqual(out.map((m) => m.id), ["anthropics/pdf", "anthropics/xlsx"]);
});

test("extractAdvisorReply pulls text + structured matches from tool parts", () => {
  const matches = shapeSearchToolOutput([loadRecord("anthropics/pdf")]);
  const message = {
    role: "assistant",
    parts: [
      { type: "step-start" },
      {
        type: "tool-search_skills",
        toolCallId: "t1",
        state: "output-available",
        input: { query: "pdf files" },
        output: matches,
      },
      { type: "text", text: "For PDF work, use anthropics/pdf." },
    ],
  };
  const reply = extractAdvisorReply(message);
  assert.equal(reply.answer, "For PDF work, use anthropics/pdf.");
  assert.deepEqual(reply.matches.map((m) => m.id), ["anthropics/pdf"]);
});

test("extractAdvisorReply handles dynamic-tool parts and ignores unfinished calls", () => {
  const matches = shapeSearchToolOutput([loadRecord("anthropics/xlsx")]);
  const message = {
    parts: [
      { type: "dynamic-tool", toolName: "search_skills", state: "input-available", output: matches },
      { type: "dynamic-tool", toolName: "search_skills", state: "output-available", output: matches },
      { type: "tool-other", state: "output-available", output: matches },
      { type: "text", text: "answer" },
    ],
  };
  const reply = extractAdvisorReply(message);
  assert.deepEqual(reply.matches.map((m) => m.id), ["anthropics/xlsx"]);
});

test("extractAdvisorReply tolerates junk input", () => {
  assert.deepEqual(extractAdvisorReply(null), { answer: "", matches: [] });
  assert.deepEqual(extractAdvisorReply({ parts: "nope" }), { answer: "", matches: [] });
  assert.deepEqual(extractAdvisorReply({ parts: [null, 42, { type: "text" }] }), { answer: "", matches: [] });
});

test("parseAdvisorGoal validates the POST body", () => {
  assert.deepEqual(parseAdvisorGoal({ goal: "  work with PDFs  " }), { goal: "work with PDFs" });
  assert.ok(parseAdvisorGoal(null).error);
  assert.ok(parseAdvisorGoal({}).error);
  assert.ok(parseAdvisorGoal({ goal: "   " }).error);
  assert.ok(parseAdvisorGoal({ goal: 42 }).error);
  assert.ok(parseAdvisorGoal({ goal: "x".repeat(501) }).error);
});

test("classifyAdvisorError separates auth failures from other errors", () => {
  assert.equal(classifyAdvisorError("401 Unauthorized"), "auth");
  assert.equal(classifyAdvisorError('{"type":"authentication_error","message":"invalid x-api-key"}'), "auth");
  assert.equal(classifyAdvisorError("500 Internal Server Error"), "other");
  assert.equal(classifyAdvisorError(""), "other");
});
