/** Derived SCS readiness. Not a pipeline stage. */

export type ScsReadiness = 'incomplete_intake' | 'assignable'

const INSTRUMENT_TYPES = new Set(['agreement', 'loan_or_til'])
const SKIP_STATUS = new Set(['ARCHIVED', 'FAILED'])

export function scsReadiness(args: {
  hasScsIntake: boolean
  imports: { sourceDocumentType: string | null; status: string }[]
}): ScsReadiness | null {
  if (!args.hasScsIntake) return null
  const instrument = args.imports.some(
    (row) =>
      !SKIP_STATUS.has(row.status)
      && row.sourceDocumentType
      && INSTRUMENT_TYPES.has(row.sourceDocumentType),
  )
  return instrument ? 'assignable' : 'incomplete_intake'
}

export function scsReadinessLabel(value: ScsReadiness): string {
  return value === 'assignable' ? 'Assignable' : 'Incomplete intake'
}
