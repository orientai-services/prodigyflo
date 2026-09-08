/**
 * Pure column-set logic for the Performance scoreboard. The table shows a
 * trimmed "core" set by default; the URL param `cols=all` reveals the deeper
 * coaching/QA diagnostics. Kept pure so the choice is unit-testable.
 */

export type ScoreboardColumnKey =
  | 'rank'
  | 'closer'
  | 'points'
  | 'pipeline'
  | 'closeRate'
  | 'revenue'
  | 'avgAiOnWins'
  | 'aiRead'
  | 'calls'
  | 'adherence'
  | 'qa'
  | 'coaching'
  | 'leaks'

export type ScoreboardColumnMode = 'core' | 'all'

/** Every column the scoreboard can render, in display order. */
export const SCOREBOARD_COLUMN_ORDER: readonly ScoreboardColumnKey[] = [
  'rank',
  'closer',
  'points',
  'pipeline',
  'closeRate',
  'revenue',
  'avgAiOnWins',
  'aiRead',
  'calls',
  'adherence',
  'qa',
  'coaching',
  'leaks',
]

/** The 8 columns that answer "who is winning and where is the risk". */
export const CORE_SCOREBOARD_COLUMNS: readonly ScoreboardColumnKey[] = [
  'rank',
  'closer',
  'points',
  'pipeline',
  'closeRate',
  'revenue',
  'calls',
  'leaks',
]

/** Parses the `cols` search param — anything but the literal 'all' is core. */
export function scoreboardColumnMode(param: string | undefined): ScoreboardColumnMode {
  return param === 'all' ? 'all' : 'core'
}

/** Ordered visible columns for a mode. */
export function scoreboardColumns(mode: ScoreboardColumnMode): ScoreboardColumnKey[] {
  if (mode === 'all') return [...SCOREBOARD_COLUMN_ORDER]
  const core = new Set(CORE_SCOREBOARD_COLUMNS)
  return SCOREBOARD_COLUMN_ORDER.filter((key) => core.has(key))
}

/** Count of the extra columns the "More" toggle reveals. */
export function hiddenColumnCount(mode: ScoreboardColumnMode): number {
  return SCOREBOARD_COLUMN_ORDER.length - scoreboardColumns(mode).length
}
