// Discovery Phase 2 — the scout contract.
//
// ONE FUNNEL: a scout's ONLY job is to nominate candidates. It never
// writes records, never marks anything verified, and its signals
// (stars, install counts, download counts, engagement) influence
// nothing but queue priority. The runner (runner.ts) persists
// nominations through store.nominate() — which dedups by canonical
// locator and merges corroboration — and the pipeline's existing
// verification (git-tree / content checks, registry quality bar)
// alone decides what ingests. Channels nominate; verification
// decides. That rule is the whole design.

import type { FetchFn } from "../../types.js";
import type { Pacer } from "../sweep.js";
import type { SourceKind } from "../sweep.js";
import type { ProvenanceEntry } from "../store.js";

export type ScoutName =
  | "github-code-search"
  | "mcp-registry"
  | "npm"
  | "skills.sh"
  | "web-search"
  | "x";

/** The `discovered_via` value each scout stamps on its nominations. */
export const SCOUT_VIA: Record<ScoutName, string> = {
  "github-code-search": "github-code-search",
  "mcp-registry": "mcp-registry",
  npm: "npm",
  "skills.sh": "skills.sh",
  "web-search": "web-search",
  x: "x",
};

/** Base verification-queue weight per channel. Corroboration adds
 *  CORROBORATION_BONUS (store.ts) per additional channel; signals
 *  add a capped log-scale bump in the runner. */
export const CHANNEL_WEIGHT: Record<ScoutName, number> = {
  "github-code-search": 3,
  "mcp-registry": 3,
  npm: 2,
  "skills.sh": 3,
  "web-search": 1,
  x: 1,
};

export interface ScoutNomination {
  /** Provisional kind claimed by the channel. For GitHub repos this
   *  is a guess — git-tree verification assigns the real repo kind.
   *  "lead" and "x-post" are watchlist-only, never ingestable. */
  kind: SourceKind;
  /** Canonical locator: owner/repo · npm package name · MCP registry
   *  name · URL (leads) · post URL (x-post). Dedup key. */
  locator: string;
  url?: string | null;
  /** This channel's provenance entry (via/at/ref/signals/note). */
  provenance: ProvenanceEntry;
  /** Log-scale priority inputs (stars, installs, weekly downloads,
   *  likes+reposts…). The runner converts the largest signal into a
   *  capped bump; raw values also live in provenance.signals. */
  signalScore?: number;
}

export interface ScoutRunStats {
  /** Raw items the channel examined this run. */
  examined: number;
  /** Nominations emitted (after in-run dedup). */
  nominated: number;
  /** Items examined but deliberately not nominated (quality bar,
   *  already-latest filtering, no resolvable link…). */
  skipped: number;
  /** HTTP/API calls made. */
  calls: number;
  rateLimitHits: number;
  /** Set when the run could not really happen (missing credential,
   *  no provider configured) — the honest blocker, never faked. */
  blocked?: string;
  note?: string;
}

export interface ScoutResult {
  nominations: ScoutNomination[];
  stats: ScoutRunStats;
}

export interface ScoutContext {
  fetchFn: FetchFn;
  pacer: Pacer;
  now: () => Date;
  /** Incremental-sync state (watermarks), backed by sync_state. */
  getSyncState: (key: string) => Promise<string | null>;
  setSyncState: (key: string, value: string) => Promise<void>;
  /** GitHub token when the host provides one (Worker secret /
   *  CLI env). Never logged, never an argument. The code-search
   *  scout also accepts a ghapi-backed fetchFn, in which case no
   *  token exists in-process at all. */
  githubToken?: string;
}

export interface Scout {
  name: ScoutName;
  run(ctx: ScoutContext, opts: Record<string, unknown>): Promise<ScoutResult>;
}
