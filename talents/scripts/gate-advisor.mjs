// Advisor gate — POSTs two plain-language goals to a deployed
// /advisor and checks the structured matches name the expected
// records. Evidence → data/gate-advisor.json.
//   node scripts/gate-advisor.mjs [baseUrl]
// Default base: the workers.dev preview. A 503 means the secret is
// absent; a 502 with errorKind "auth" means the key was rejected by
// Anthropic (the surrogate-as-runtime-key blocker) — both are recorded
// as gate outcomes, not silently passed over.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const base = (process.argv[2] ?? "https://talents.maximalize.workers.dev").replace(/\/$/, "");

const CASES = [
  { goal: "I need to work with PDF files", expectId: "anthropics/pdf" },
  { goal: "audit my API for security issues", expectId: "42crunch-ai/42crunch-api-security-testing" },
];

async function advise(goal) {
  const res = await fetch(`${base}/advisor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, json, raw: json ? undefined : text.slice(0, 300) };
}

const results = [];
for (const c of CASES) {
  const r = await advise(c.goal);
  const ids = (r.json?.matches ?? []).map((m) => m.id);
  results.push({
    goal: c.goal,
    expectId: c.expectId,
    httpStatus: r.status,
    pass: r.status === 200 && ids.includes(c.expectId),
    model: r.json?.model ?? null,
    matchIds: ids,
    answerExcerpt: typeof r.json?.answer === "string" ? r.json.answer.slice(0, 400) : null,
    error: r.json?.error ?? null,
    errorKind: r.json?.errorKind ?? null,
    raw: r.raw ?? null,
  });
}

const out = {
  gate: "advisor",
  base,
  at: new Date().toISOString(),
  pass: results.every((r) => r.pass),
  results,
};
writeFileSync(resolve(ROOT, "data/gate-advisor.json"), JSON.stringify(out, null, 2) + "\n");
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  "${r.goal}" → HTTP ${r.httpStatus} · matches: [${r.matchIds.join(", ")}]${r.error ? ` · error: ${r.error}${r.errorKind ? ` (${r.errorKind})` : ""}` : ""}`);
}
console.log(`advisor gate: ${out.pass ? "PASS" : "FAIL"} → data/gate-advisor.json`);
process.exitCode = out.pass ? 0 : 1;
