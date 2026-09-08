/**
 * The 5-step funnel — the sales process every logged call is scored against
 * (Phase 1: "strict adherence to the 5-step funnel process"; Phase 2:
 * process-adherence tracking feeds the scoreboard).
 *
 * Pure module: no server imports, so the checklist renders client-side and the
 * math is unit-testable. Adherence is a PROCESS measure recorded by the closer
 * at call-log time — it never decides anything about a client.
 */

export type FunnelStepKey =
  | 'brief_reviewed'
  | 'discovery'
  | 'present'
  | 'objections'
  | 'commitment'

export type FunnelStep = {
  key: FunnelStepKey
  label: string
  /** One line of coaching shown under the checkbox. */
  hint: string
}

export const FUNNEL_STEPS: readonly FunnelStep[] = [
  {
    key: 'brief_reviewed',
    label: 'Reviewed the AI Closer Brief',
    hint: 'Walked in knowing the story — objections, drivers, and the numbers.',
  },
  {
    key: 'discovery',
    label: 'Confirmed situation and needs',
    hint: 'Verified what changed since intake instead of assuming the file is current.',
  },
  {
    key: 'present',
    label: 'Presented the numbers and options',
    hint: 'Showed the actual figures and the paths available — no vague promises.',
  },
  {
    key: 'objections',
    label: 'Handled objections',
    hint: 'Surfaced and answered the real hesitation, not just the first one voiced.',
  },
  {
    key: 'commitment',
    label: 'Locked the next step or close',
    hint: 'Left with a concrete commitment: a close, a signed doc, or a booked follow-up.',
  },
] as const

const STEP_KEYS = new Set<string>(FUNNEL_STEPS.map((s) => s.key))

export type AdherenceEntry = { step: FunnelStepKey; done: boolean }

/**
 * Percent of the 5 canonical steps marked done, 0-100 rounded to an integer.
 * Returns null when there is nothing to score (no recorded entries) so calls
 * logged before adherence existed — or logged without a checklist — are
 * excluded from averages instead of counting as 0%.
 */
export function adherencePct(steps: readonly AdherenceEntry[]): number | null {
  const seen = new Set<FunnelStepKey>()
  const done = new Set<FunnelStepKey>()
  for (const s of steps) {
    if (!STEP_KEYS.has(s.step)) continue
    seen.add(s.step)
    // Last entry for a step wins, matching parseAdherence.
    if (s.done) done.add(s.step)
    else done.delete(s.step)
  }
  if (seen.size === 0) return null
  return Math.round((done.size / FUNNEL_STEPS.length) * 100)
}

/**
 * Parses a `Call.adherence` JSON payload from the database (or a client
 * submission) into clean entries. Tolerant by design: anything that is not an
 * array of `{ step, done }` objects with known step keys is dropped, and a
 * duplicated step keeps its last value. Never throws.
 */
export function parseAdherence(json: unknown): AdherenceEntry[] {
  if (!Array.isArray(json)) return []
  const byStep = new Map<FunnelStepKey, boolean>()
  for (const item of json) {
    if (typeof item !== 'object' || item === null) continue
    const { step, done } = item as { step?: unknown; done?: unknown }
    if (typeof step !== 'string' || !STEP_KEYS.has(step)) continue
    byStep.set(step as FunnelStepKey, done === true)
  }
  // Canonical order, so stored payloads and UI renders always line up.
  return FUNNEL_STEPS.filter((s) => byStep.has(s.key)).map((s) => ({
    step: s.key,
    done: byStep.get(s.key)!,
  }))
}
