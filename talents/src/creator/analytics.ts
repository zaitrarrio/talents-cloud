// Creator analytics aggregation (Creator Experience, P4) — pure
// functions over record_stats-shaped rows.
//
// Sources of truth (all already collected before P4 existed):
//   record_stats      calls_7d / calls_prev_7d / calls_30d,
//                     installs_total / installs_30d, behavior_score,
//                     external_installs (+ external_source label)
//   gateway_calls     the raw log record_stats is derived from
//                     (used for the per-listing "recent calls" view)
// Honesty rules: a namespace with no traffic shows ZEROS, not
// errors; external installs (skills.sh) are labelled as external
// wherever they appear and never summed into our own install counts.

export interface ListingStatsRow {
  skillId: string;
  calls7d: number;
  callsPrev7d: number;
  calls30d: number;
  installsTotal: number;
  installs30d: number;
  behaviorScore: number;
  externalInstalls: number;
  externalSource: string | null;
}

export type TrendDirection = "up" | "down" | "flat";

export interface ListingAnalytics extends ListingStatsRow {
  trend: TrendDirection;
  /** calls_7d − calls_prev_7d (signed). */
  trendDelta: number;
}

export interface OwnerAnalytics {
  listings: ListingAnalytics[];
  totals: {
    listings: number;
    calls7d: number;
    callsPrev7d: number;
    calls30d: number;
    installsTotal: number;
    installs30d: number;
    externalInstalls: number;
    trend: TrendDirection;
    trendDelta: number;
  };
}

export function trendOf(calls7d: number, callsPrev7d: number): { trend: TrendDirection; delta: number } {
  const delta = calls7d - callsPrev7d;
  return { trend: delta > 0 ? "up" : delta < 0 ? "down" : "flat", delta };
}

const EMPTY: ListingStatsRow = {
  skillId: "", calls7d: 0, callsPrev7d: 0, calls30d: 0,
  installsTotal: 0, installs30d: 0, behaviorScore: 0,
  externalInstalls: 0, externalSource: null,
};

/**
 * Aggregate one owner's analytics. `skillIds` is the owner's full
 * listing set (from records); `stats` may omit ids with no stats row
 * yet — those aggregate as zeros (a listing nobody has called is a
 * fact, not an error).
 */
export function aggregateOwnerAnalytics(
  skillIds: string[],
  stats: Map<string, ListingStatsRow>,
): OwnerAnalytics {
  const listings: ListingAnalytics[] = skillIds.map((id) => {
    const row = stats.get(id) ?? { ...EMPTY, skillId: id };
    const { trend, delta } = trendOf(row.calls7d, row.callsPrev7d);
    return { ...row, trend, trendDelta: delta };
  });
  // Most-called first; ties by id for stable rendering.
  listings.sort((a, b) => b.calls30d - a.calls30d || b.installsTotal - a.installsTotal || a.skillId.localeCompare(b.skillId));
  const totals = {
    listings: listings.length,
    calls7d: listings.reduce((s, l) => s + l.calls7d, 0),
    callsPrev7d: listings.reduce((s, l) => s + l.callsPrev7d, 0),
    calls30d: listings.reduce((s, l) => s + l.calls30d, 0),
    installsTotal: listings.reduce((s, l) => s + l.installsTotal, 0),
    installs30d: listings.reduce((s, l) => s + l.installs30d, 0),
    externalInstalls: listings.reduce((s, l) => s + l.externalInstalls, 0),
    trend: "flat" as TrendDirection,
    trendDelta: 0,
  };
  const t = trendOf(totals.calls7d, totals.callsPrev7d);
  totals.trend = t.trend;
  totals.trendDelta = t.delta;
  return { listings, totals };
}
