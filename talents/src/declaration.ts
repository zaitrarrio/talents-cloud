// Derived declaration: plain-language permission lines generated from the
// artifacts that ALREADY exist (plugin.json components, MCP server configs,
// hooks, SKILL.md frontmatter). No developer-authored manifest is required.
// Anything that cannot be derived is labelled "undeclared" — never guessed.

import type { Declaration, DeclarationLine } from "./types.js";
import { isUsableDescription, stringArray } from "./validate.js";

export interface PluginJson {
  name?: string;
  version?: string;
  description?: string;
  author?: unknown;
  skills?: string | string[];
  commands?: string | string[];
  agents?: string | string[];
  hooks?: unknown;
  mcpServers?: Record<string, McpServerConfig> | string;
  [k: string]: unknown;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  [k: string]: unknown;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  [k: string]: unknown;
}

function asArray(v: string | string[] | undefined): string[] {
  return stringArray(v);
}

export function deriveDeclaration(input: {
  pluginJson: PluginJson | null;
  entryComponents?: { skills?: string | string[]; commands?: string | string[]; agents?: string | string[] };
  skillFrontmatters?: SkillFrontmatter[];
  pluginJsonSource: string;
}): Declaration {
  const lines: DeclarationLine[] = [];
  const summary: string[] = [];
  const undeclared: string[] = [];
  const derivedFrom: string[] = [input.pluginJsonSource];
  const pj = input.pluginJson ?? {};

  // entryComponents come straight from a publisher's marketplace entry,
  // where a collection may be a bare string — normalize through
  // stringArray, never spread the raw value (a string would spread
  // into per-character "components").
  const skills = new Set<string>([
    ...asArray(pj.skills),
    ...stringArray(input.entryComponents?.skills),
  ]);
  const commands = new Set<string>([...asArray(pj.commands), ...stringArray(input.entryComponents?.commands)]);
  const agents = new Set<string>([...asArray(pj.agents), ...stringArray(input.entryComponents?.agents)]);

  if (skills.size) {
    lines.push({ kind: "component", text: `Provides ${skills.size} skill(s): ${[...skills].map((s) => s.replace(/^\.\//, "")).join(", ")}` });
    summary.push(`Runs ${skills.size} skill(s) in your agent, following their SKILL.md instructions`);
  }
  if (commands.size) {
    lines.push({ kind: "component", text: `Provides ${commands.size} slash command(s): ${[...commands].join(", ")}` });
    summary.push(`Adds ${commands.size} slash command(s) you invoke explicitly`);
  }
  if (agents.size) {
    lines.push({ kind: "component", text: `Provides ${agents.size} sub-agent(s): ${[...agents].join(", ")}` });
    summary.push(`Adds ${agents.size} sub-agent(s) your agent can delegate to`);
  }

  // MCP servers — the highest-signal permission source that already exists.
  let mcp: Record<string, McpServerConfig> = {};
  if (pj.mcpServers && typeof pj.mcpServers === "object") mcp = pj.mcpServers;
  for (const [name, cfg] of Object.entries(mcp)) {
    if (cfg.url) {
      lines.push({ kind: "network", text: `Connects to remote MCP server "${name}" at ${cfg.url}` });
      summary.push(`Talks to an external service: ${name} (${cfg.url})`);
    } else if (cfg.command) {
      const cmdline = [cfg.command, ...(cfg.args ?? [])].join(" ");
      lines.push({ kind: "tool", text: `Runs a local MCP server process "${name}": ${cmdline}` });
      summary.push(`Starts a local process: ${cmdline}`);
      if (cfg.env && Object.keys(cfg.env).length) {
        lines.push({ kind: "tool", text: `MCP server "${name}" receives environment variables: ${Object.keys(cfg.env).join(", ")}` });
        summary.push(`Passes environment variables to ${name}: ${Object.keys(cfg.env).join(", ")}`);
      }
    } else {
      undeclared.push(`MCP server "${name}" has neither command nor url in its config — its access cannot be derived`);
    }
  }

  // Hooks run code automatically on agent events — always surfaced.
  if (pj.hooks) {
    const hookEvents = typeof pj.hooks === "object" ? Object.keys(pj.hooks as object) : [];
    lines.push({
      kind: "hook",
      text: `Registers hooks${hookEvents.length ? ` on: ${hookEvents.join(", ")}` : ""} — code that runs automatically on agent events`,
    });
    summary.push("Runs code automatically via hooks — review before installing");
  }

  // SKILL.md frontmatter: a skill's own words about when it triggers.
  for (const fm of input.skillFrontmatters ?? []) {
    if (fm.name && isUsableDescription(fm.description)) {
      lines.push({ kind: "component", text: `Skill "${fm.name}": ${String(fm.description).slice(0, 240)}` });
      derivedFrom.push(`SKILL.md frontmatter (${fm.name})`);
    }
  }

  if (!skills.size && !commands.size && !agents.size && !Object.keys(mcp).length && !pj.hooks) {
    undeclared.push(
      "No components could be derived from plugin.json — what this plugin can do is undeclared; it runs only in sandbox/Playground until the publisher confirms a declaration",
    );
  }
  if (input.pluginJson === null) {
    undeclared.push(
      "No plugin.json was reachable at the source — declaration derived from the marketplace entry alone; tool access is undeclared",
    );
  }
  for (const u of undeclared) lines.push({ kind: "undeclared", text: `Undeclared: ${u}` });
  if (!summary.length) summary.push("No derived permissions — see undeclared items");

  return { lines, summary, undeclared, derivedFrom };
}
