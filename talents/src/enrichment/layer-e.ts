// Layer E — TRUST SIGNALS (ENRICHMENT.md §E), class: derived.
// A static risky-pattern scan (v1) over the record's pinned source
// text, plus freshness: when the source was last verified, and
// whether the live source has drifted since the pin.
//
// A flag is a NEUTRAL FACT — "the pinned source, at this path,
// contains this pattern" — never a verdict, never a score, never a
// block. Plenty of legitimate skills download their own installer
// or read SSH keys on the user's behalf; the registry's job is to
// make the pattern visible at install time, in the Declaration's
// own terms.
//
// Scan scope (the precision choice, documented): SKILL.md bodies
// and bundled script files — the text an agent will actually
// execute or follow. READMEs and docs prose are NOT scanned: a
// README *mentioning* `curl | bash` is documentation, while the
// same line in a SKILL.md instruction block or a script is an
// instruction. Within scanned text, the executable-pattern classes
// (remote-code-execution, persistence, obfuscation, network-exfil)
// only fire in code context — a fenced code block, an inline code
// span, or a script file (all code) — and a match is suppressed
// when a negation ("never", "don't", "do not", "avoid", "warn")
// precedes it on the same line (a warning ABOUT the pattern is not
// the pattern). credential-access fires on any mention in scanned
// text: referencing ~/.ssh is a fact worth surfacing even in prose
// instructions. Environment-variable reads are deliberately NOT
// flagged: env is the normal, declared configuration channel for
// skills and MCP servers (their NAMES are surfaced by Layer B);
// credential FILES are the different, sharper fact.

import type { FetchFn, SkillRecord } from "../types.js";
import { fetchText, rawUrl } from "../ingest.js";
import type { DriftStatus, LayerE, TrustFlag, TrustFlagClass } from "./types.js";

// ---------------------------------------------------------------------------
// Pattern scanner (pure)
// ---------------------------------------------------------------------------

interface PatternDef {
  class: TrustFlagClass;
  /** Executable classes require code context; credential-access
   *  fires anywhere in scanned text. */
  codeOnly: boolean;
  re: RegExp;
}

const PATTERNS: PatternDef[] = [
  // -- remote-code-execution --------------------------------------
  { class: "remote-code-execution", codeOnly: true, re: /\bcurl\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/ },
  { class: "remote-code-execution", codeOnly: true, re: /\bwget\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/ },
  { class: "remote-code-execution", codeOnly: true, re: /\bcurl\b[^|\n]*\|\s*(sudo\s+)?(python3?|node|perl|ruby)\b/ },
  { class: "remote-code-execution", codeOnly: true, re: /(ba|z)?sh\s+<\(\s*(curl|wget)\b/ },
  { class: "remote-code-execution", codeOnly: true, re: /\b(irm|Invoke-RestMethod)\b[^|\n]*\|\s*(iex|Invoke-Expression)\b/ },
  { class: "remote-code-execution", codeOnly: true, re: /\b(iex|Invoke-Expression)\b[^\n]*DownloadString/ },
  { class: "remote-code-execution", codeOnly: true, re: /\beval\s*\([^)]*(\bfetch\s*\(|https?:\/\/)/ },
  // -- credential-access (any context in scanned text) ------------
  { class: "credential-access", codeOnly: false, re: /(~|\$HOME)\/\.ssh\b|\.ssh\/id_(rsa|ed25519|ecdsa|dsa)\b/ },
  { class: "credential-access", codeOnly: false, re: /(~|\$HOME)\/\.aws\b|\.aws\/credentials\b/ },
  { class: "credential-access", codeOnly: false, re: /(~|\$HOME)\/\.gnupg\b/ },
  { class: "credential-access", codeOnly: false, re: /(~|\$HOME)\/\.kube\/config\b/ },
  { class: "credential-access", codeOnly: false, re: /(~|\$HOME)\/\.docker\/config\.json\b/ },
  { class: "credential-access", codeOnly: false, re: /(~|\$HOME)\/\.git-credentials\b|(~|\$HOME)\/\.netrc\b/ },
  { class: "credential-access", codeOnly: false, re: /\bsecurity\s+find-generic-password\b/ },
  { class: "credential-access", codeOnly: false, re: /\/etc\/shadow\b/ },
  // -- persistence -------------------------------------------------
  { class: "persistence", codeOnly: true, re: /\bcrontab\b/ },
  { class: "persistence", codeOnly: true, re: /\/etc\/cron(\.d|\.daily)?\b|Library\/Launch(Agents|Daemons)\b|launchctl\s+(load|bootstrap)\b/ },
  { class: "persistence", codeOnly: true, re: /(~|\$HOME)\/\.config\/systemd\b|systemctl\s+(--user\s+)?enable\b/ },
  { class: "persistence", codeOnly: true, re: /(>>|tee\s+-a\s+)[^\n]*\.(bashrc|zshrc|bash_profile|zprofile|profile)\b/ },
  // -- obfuscation --------------------------------------------------
  { class: "obfuscation", codeOnly: true, re: /\bbase64\s+(--decode|-d|-D)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/ },
  { class: "obfuscation", codeOnly: true, re: /\becho\s+[A-Za-z0-9+/]{20,}={0,2}\s*\|\s*base64\s+(--decode|-d|-D)\b/ },
  { class: "obfuscation", codeOnly: true, re: /\beval\s*\(\s*atob\s*\(/ },
  { class: "obfuscation", codeOnly: true, re: /\bxxd\s+-r\s+-p\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/ },
  // -- network-exfil ------------------------------------------------
  { class: "network-exfil", codeOnly: true, re: /\bcurl\b[^\n]*\s(-F|--form)\s+\S+=@/ },
  { class: "network-exfil", codeOnly: true, re: /\bcurl\b[^\n]*\s(-T|--upload-file)\s+\S/ },
  { class: "network-exfil", codeOnly: true, re: /\bcurl\b[^\n]*\s(--data-binary|--data-raw|-d)\s+@/ },
  { class: "network-exfil", codeOnly: true, re: /\bwget\b[^\n]*--post-file[=\s]/ },
  { class: "network-exfil", codeOnly: true, re: /\bscp\s+\S+\s+\S+@[\w.-]+:/ },
];

const NEGATION = /\b(never|don't|do not|avoid|warn(ing)?)\b/i;
export const EVIDENCE_CAP = 120;

/** Evidence excerpt: the matched line, whitespace-collapsed, sliced
 *  around the match so the pattern itself is visible within the cap. */
function evidenceOf(line: string, matchIndex: number, matchLen: number): string {
  const flat = line.replace(/\s+/g, " ").trim();
  if (flat.length <= EVIDENCE_CAP) return flat;
  // Re-locate in the flattened line approximately: keep a window
  // centred on the match.
  const approx = Math.max(0, Math.min(matchIndex, flat.length - 1));
  const start = Math.max(0, Math.min(approx - 30, flat.length - EVIDENCE_CAP));
  const slice = flat.slice(start, start + EVIDENCE_CAP);
  return `${start > 0 ? "…" : ""}${slice}${start + EVIDENCE_CAP < flat.length ? "…" : ""}`.slice(0, EVIDENCE_CAP + 2);
}

/**
 * Scan one source file's text. `isCodeFile` (scripts) makes every
 * line code context; for markdown (SKILL.md), fenced blocks and
 * inline code spans are code context. Returns deduped flags.
 */
export function scanText(text: string, file: string, opts: { isCodeFile?: boolean } = {}): TrustFlag[] {
  const flags: TrustFlag[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    const codeContext = Boolean(opts.isCodeFile) || inFence || /`[^`]+`/.test(line);
    for (const def of PATTERNS) {
      if (def.codeOnly && !codeContext) continue;
      const m = def.re.exec(line);
      if (!m) continue;
      // Negation guard (executable classes only): a warning about
      // the pattern on the same line is not the pattern.
      if (def.codeOnly && NEGATION.test(line.slice(0, m.index))) continue;
      const evidence = evidenceOf(line, m.index, m[0].length);
      const key = `${def.class}:${file}:${evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push({ class: def.class, evidence, file });
    }
  }
  return flags;
}

/** Neutral catalogue sentence per flag class — the display layer's
 *  wording (facts, not verdicts). */
export const FLAG_CLASS_LABEL: Record<TrustFlagClass, string> = {
  "remote-code-execution": "downloads and executes a remote script",
  "credential-access": "references credential locations",
  "persistence": "installs a persistence mechanism",
  "obfuscation": "decodes and executes obfuscated content",
  "network-exfil": "uploads local files to an external endpoint",
};

// ---------------------------------------------------------------------------
// Drift (cheap head check against the record's pinned ref)
// ---------------------------------------------------------------------------

export interface DriftResult {
  status: DriftStatus;
  headSha?: string;
  reason?: string;
}

/**
 * Compare the live source head with the record's pinned ref, using
 * ONE GitHub API call (default-branch head commit). Only meaningful
 * when the ref IS a commit sha: equal → "current", different →
 * "changed". A branch/tag ref, a non-GitHub source, or a failed
 * call yields an honest "unknown" with the reason — drift is never
 * fabricated.
 */
export async function driftFor(record: SkillRecord, fetchFn: FetchFn): Promise<DriftResult> {
  const repo = record.sourceRepo;
  if (!repo || record.pointerOnly) {
    return { status: "unknown", reason: "no GitHub source repo to check" };
  }
  if (!/^[0-9a-f]{40}$/i.test(record.ref)) {
    return { status: "unknown", reason: `pinned ref "${record.ref}" is a branch/tag name, not a commit sha — head comparison not meaningful` };
  }
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/commits?per_page=1`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { status: "unknown", reason: `head check failed: HTTP ${res.status}` };
    const j = (await res.json()) as { sha?: string }[] | { sha?: string };
    const head = Array.isArray(j) ? j[0]?.sha : j.sha;
    if (!head) return { status: "unknown", reason: "head check returned no commit" };
    return head.toLowerCase() === record.ref.toLowerCase()
      ? { status: "current", headSha: head }
      : { status: "changed", headSha: head };
  } catch (e) {
    return { status: "unknown", reason: `head check failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export const SCRIPT_EXTENSIONS = [".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".ps1", ".bat", ".rb", ".pl"];
export const MAX_SCRIPT_FILES = 8;
export const MAX_SCAN_BYTES = 128 * 1024;

const isServerJsonSource = (record: SkillRecord): boolean =>
  record.filesHashed.includes("server.json")
  || (record.source !== null && typeof record.source === "object" && "packages" in (record.source as object) && "name" in (record.source as object));

export interface LayerEDeps {
  fetchFn: FetchFn;
}

/**
 * Run Layer E for one record: gather the pinned source text
 * (primary SKILL.md + up to MAX_SCRIPT_FILES bundled scripts, or
 * the server.json descriptor for registry records), scan it, and
 * attach freshness (lastVerifiedAt from the attestation/ingest,
 * plus the drift head-check).
 *   done    — at least one file scanned (flags may be empty — a
 *             clean scan IS a result).
 *   partial — some fetches failed; what was scanned is recorded.
 *   none    — nothing scannable (pointer-only / no source text).
 */
export async function runLayerE(
  record: SkillRecord,
  deps: LayerEDeps,
  now: Date,
): Promise<{ state: "done" | "partial" | "none"; payload: LayerE }> {
  const at = now.toISOString();
  const errors: string[] = [];
  const texts: { path: string; text: string; isCodeFile: boolean }[] = [];

  if (isServerJsonSource(record)) {
    texts.push({ path: "server.json", text: JSON.stringify(record.source ?? {}), isCodeFile: true });
  }

  const repo = record.sourceRepo;
  if (repo && !record.pointerOnly) {
    const base = record.sourcePath ?? "";
    const skillCandidates: string[] = [];
    skillCandidates.push(base ? `${base}/SKILL.md` : "SKILL.md");
    for (const f of record.filesHashed) {
      if (f.endsWith("SKILL.md") && !skillCandidates.includes(f)) skillCandidates.push(f);
    }
    for (const path of skillCandidates.slice(0, 3)) {
      const text = await fetchText(deps.fetchFn, rawUrl(repo, record.ref, path));
      if (text !== null) {
        texts.push({ path, text: text.slice(0, MAX_SCAN_BYTES), isCodeFile: false });
        break;
      }
    }
    const scripts = record.filesHashed
      .filter((f) => SCRIPT_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)))
      .slice(0, MAX_SCRIPT_FILES);
    for (const path of scripts) {
      const text = await fetchText(deps.fetchFn, rawUrl(repo, record.ref, path));
      if (text === null) { errors.push(`fetch failed: ${path}`); continue; }
      texts.push({ path, text: text.slice(0, MAX_SCAN_BYTES), isCodeFile: true });
    }
  }

  const flags: TrustFlag[] = [];
  const seenFlags = new Set<string>();
  for (const t of texts) {
    for (const flag of scanText(t.text, t.path, { isCodeFile: t.isCodeFile })) {
      const key = `${flag.class}:${flag.file}:${flag.evidence}`;
      if (seenFlags.has(key)) continue;
      seenFlags.add(key);
      flags.push(flag);
    }
  }

  const drift = await driftFor(record, deps.fetchFn);
  const payload: LayerE = {
    scannedAt: at,
    files: texts.map((t) => t.path),
    flags,
    lastVerifiedAt: record.attestation?.signedAt ?? record.ingestedAt,
    drift: {
      status: drift.status,
      ...(drift.headSha ? { headSha: drift.headSha } : {}),
      checkedAt: at,
      ...(drift.reason ? { reason: drift.reason } : {}),
    },
    ...(errors.length ? { errors } : {}),
  };

  if (!texts.length) {
    if (errors.length) return { state: "partial", payload: { ...payload, reason: "source files could not be fetched" } };
    return {
      state: "none",
      payload: { ...payload, reason: record.pointerOnly ? "pointer-only record — no source text to scan" : "no scannable source text (no SKILL.md / scripts / server.json)" },
    };
  }
  return { state: errors.length ? "partial" : "done", payload };
}
