// Intent enrichment (P5, ARCHITECTURE-v2 §7): a small CURATED
// synonyms/expansions table. Keyword search alone fails on intent
// queries whose words never appear in skill descriptions ("build
// games", "make my spreadsheets talk to each other"). Expansions are
// applied two ways, both LOW weight so they can never outrank a direct
// match:
//   - FTS: expansion terms run as a second, demoted search pass whose
//     results merge behind the raw query's results.
//   - Embeddings: expansion terms are appended to the query text
//     before embedding, pulling the vector toward the intent's
//     neighbourhood.
// The table is deliberately small and hand-kept — every entry is a
// judgement call a human reviewed, not a generated thesaurus. Keys are
// normalized (lowercase, singularized by normalizeToken where useful);
// a query token triggers an entry when it equals the key or the key's
// singular form.

/** trigger → expansion terms (as they should be searched/embedded). */
export const EXPANSIONS: Record<string, string[]> = {
  game: ["game development", "three.js", "phaser", "godot", "unity", "webgl", "sprites", "2d game", "3d game"],
  gaming: ["game development", "three.js", "phaser", "godot", "unity"],
  spreadsheet: ["excel", "xlsx", "csv", "google sheets", "sheets"],
  excel: ["spreadsheet", "xlsx", "csv", "sheets"],
  sheets: ["spreadsheet", "xlsx", "google sheets", "excel"],
  csv: ["spreadsheet", "xlsx", "data"],
  pdf: ["document", "documents", "forms", "ocr"],
  document: ["pdf", "docx", "word", "documents"],
  word: ["docx", "document", "documents"],
  slide: ["pptx", "powerpoint", "presentation", "deck"],
  presentation: ["pptx", "powerpoint", "slides", "deck"],
  powerpoint: ["pptx", "presentation", "slides"],
  meeting: ["notes", "transcription", "summary", "minutes", "recording"],
  transcribe: ["audio", "speech to text", "whisper", "transcription", "captions"],
  transcription: ["audio", "whisper", "captions", "subtitles"],
  watch: ["monitoring", "changes", "diff", "alerts", "snapshot"],
  monitor: ["watcher", "changes", "monitoring", "alerts"],
  website: ["web", "url", "page", "site"],
  security: ["audit", "vulnerability", "owasp", "scanning", "pentest"],
  audit: ["security", "vulnerability", "compliance", "review"],
  invoice: ["billing", "receipt", "accounting", "reconcile", "payments"],
  billing: ["invoice", "payments", "stripe", "accounting"],
  email: ["inbox", "gmail", "mail", "triage", "messages"],
  inbox: ["email", "gmail", "triage"],
  image: ["photo", "png", "design", "art", "picture"],
  art: ["design", "generative", "canvas", "p5.js", "illustration"],
  design: ["ui", "art", "frontend", "visual", "figma"],
  code: ["developer", "sdk", "api", "programming"],
  api: ["openapi", "rest", "sdk", "endpoint", "integration"],
  data: ["sql", "database", "analytics", "csv", "query"],
  database: ["sql", "postgres", "data", "query"],
  chat: ["messages", "slack", "conversation"],
  slack: ["chat", "messages", "workspace"],
  video: ["mp4", "animation", "media", "render"],
  search: ["find", "lookup", "browser", "web"],
};

/** Singularize a token the same way the search engine does, so
 *  "games" triggers the "game" entry. Local copy of the rule from
 *  search.ts normalizeToken (kept dependency-free for this module). */
function singular(t: string): string {
  if (t.length >= 4 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** Expansion terms triggered by a query, in first-trigger order,
 *  deduped, with the query's own tokens removed. */
export function expansionTermsFor(query: string): string[] {
  const rawTokens = query.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  const own = new Set(rawTokens.map(singular));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTokens) {
    for (const key of [raw, singular(raw)]) {
      const terms = EXPANSIONS[key];
      if (!terms) continue;
      for (const term of terms) {
        const norm = term.toLowerCase();
        if (seen.has(norm)) continue;
        seen.add(norm);
        // Skip terms that are just the query's own words.
        const termTokens = norm.split(/[^a-z0-9.]+/).filter(Boolean);
        if (termTokens.every((t) => own.has(singular(t)))) continue;
        out.push(term);
      }
    }
  }
  return out;
}

/** The query as an FTS string for the demoted expansion pass: the
 *  expansion terms, space-joined (the D1 engine tokenizes it). Null
 *  when the query triggers no expansions. */
export function expandedQueryString(query: string): string | null {
  const terms = expansionTermsFor(query);
  return terms.length ? terms.join(" ") : null;
}

/** Query text augmented for embedding: original query + expansion
 *  terms appended once, so the vector leans toward the intent. */
export function augmentedEmbeddingText(query: string): string {
  const terms = expansionTermsFor(query);
  return terms.length ? `${query} — related: ${terms.join(", ")}` : query;
}
