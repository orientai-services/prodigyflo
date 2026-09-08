import type { AssignmentInput, CloserCandidate } from './provider'

/**
 * Closer designation is deterministic, weighted business logic — not a model
 * guess. The AI layer explains the result and can be swapped out; this scoring
 * stays auditable and reproducible either way.
 *
 * Weights are the configurable factors from the spec. An organization can
 * override them in Organization.settings.assignmentWeights.
 */
export const DEFAULT_WEIGHTS = {
  region: 25,
  licensing: 20,
  language: 15,
  workload: 15,
  closeRate: 15,
  specialty: 5,
  rotation: 5,
} as const

export type AssignmentWeights = typeof DEFAULT_WEIGHTS

export type ScoredCandidate = {
  candidate: CloserCandidate
  score: number
  /** Per-factor contribution, always shown so a recommendation is explainable. */
  factors: { factor: string; detail: string; points: number; max: number }[]
  /** Hard blocks — a candidate that cannot legally take the client. */
  disqualifiers: string[]
}

export function scoreCandidates(
  input: AssignmentInput,
  weights: AssignmentWeights = DEFAULT_WEIGHTS,
): ScoredCandidate[] {
  const { client, candidates } = input

  // Fair rotation: the longest-idle closer earns the full rotation weight.
  const lastAssigned = candidates.map((c) => (c.lastAssignedAt ? Date.parse(c.lastAssignedAt) : 0))
  const oldest = Math.min(...lastAssigned, Date.now())
  const newest = Math.max(...lastAssigned, oldest + 1)

  // Close rate is only credited once the sample is big enough to mean anything.
  const MIN_SAMPLE = 10

  return candidates
    .map((c) => {
      const factors: ScoredCandidate['factors'] = []
      const disqualifiers: string[] = []

      const regionMatch = Boolean(client.regionName && c.regionName === client.regionName)
      factors.push({
        factor: 'Region',
        detail: regionMatch ? `Serves ${c.regionName}` : `Outside ${client.regionName ?? 'the client region'}`,
        points: regionMatch ? weights.region : 0,
        max: weights.region,
      })

      const licensed = !client.state || c.licensedIn.length === 0 || c.licensedIn.includes(client.state)
      if (client.state && c.licensedIn.length > 0 && !c.licensedIn.includes(client.state)) {
        disqualifiers.push(`Not licensed in ${client.state}`)
      }
      factors.push({
        factor: 'Licensing',
        detail: licensed ? `Cleared for ${client.state ?? 'this territory'}` : `Not licensed in ${client.state}`,
        points: licensed ? weights.licensing : 0,
        max: weights.licensing,
      })

      const speaksLanguage = c.languages.includes(client.preferredLanguage)
      factors.push({
        factor: 'Language',
        detail: speaksLanguage
          ? `Speaks the client's preferred language (${client.preferredLanguage})`
          : `Does not speak ${client.preferredLanguage}`,
        points: speaksLanguage ? weights.language : 0,
        max: weights.language,
      })

      const utilization = c.capacity > 0 ? c.activeClients / c.capacity : 1
      if (utilization >= 1) disqualifiers.push('At or over workload capacity')
      const workloadPoints = Math.round(weights.workload * Math.max(0, 1 - utilization))
      factors.push({
        factor: 'Workload',
        detail: `${c.activeClients} of ${c.capacity} active (${Math.round(utilization * 100)}% used)`,
        points: workloadPoints,
        max: weights.workload,
      })

      const hasSample = c.sampleSize >= MIN_SAMPLE && c.closeRatePct !== null
      const closeRatePoints = hasSample ? Math.round(weights.closeRate * Math.min(1, c.closeRatePct! / 50)) : 0
      factors.push({
        factor: 'Close rate',
        detail: hasSample
          ? `${c.closeRatePct!.toFixed(0)}% over ${c.sampleSize} decided clients`
          : `Sample too small to score (${c.sampleSize} decided)`,
        points: closeRatePoints,
        max: weights.closeRate,
      })

      const specialtyMatch = c.specialties.length > 0
      factors.push({
        factor: 'Specialty',
        detail: specialtyMatch ? c.specialties.join(', ') : 'No recorded specialty',
        points: specialtyMatch ? weights.specialty : 0,
        max: weights.specialty,
      })

      const last = c.lastAssignedAt ? Date.parse(c.lastAssignedAt) : oldest
      const idleShare = newest === oldest ? 1 : 1 - (last - oldest) / (newest - oldest)
      const rotationPoints = Math.round(weights.rotation * idleShare)
      factors.push({
        factor: 'Rotation',
        detail: c.lastAssignedAt ? `Last assigned ${new Date(last).toISOString().slice(0, 10)}` : 'No prior assignment',
        points: rotationPoints,
        max: weights.rotation,
      })

      return {
        candidate: c,
        score: factors.reduce((sum, f) => sum + f.points, 0),
        factors,
        disqualifiers,
      }
    })
    .sort((a, b) => {
      if (a.disqualifiers.length !== b.disqualifiers.length) return a.disqualifiers.length - b.disqualifiers.length
      return b.score - a.score
    })
}

/**
 * Confidence is the winner's margin over the runner-up, not the raw score.
 * A field of equally-good closers should read as low confidence, because it is.
 */
export function assignmentConfidence(scored: ScoredCandidate[]): number {
  if (scored.length === 0) return 0
  if (scored.length === 1) return 70
  const [first, second] = scored
  const margin = first.score - second.score
  return Math.max(35, Math.min(95, Math.round(50 + margin * 2.5)))
}
