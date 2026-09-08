import type { CysValueStatus } from '@prisma/client'
import type { CysDefinitionInput } from '@/lib/cys/resolve'

/** Pure readiness maths — shared by the workspace, the approval gate, and tests. */

export type FieldStatusRow = { fieldKey: string; status: CysValueStatus }

export type CompletionSummary = {
  requiredTotal: number
  requiredVerified: number
  completionPct: number
}

export type ChecklistItem = { key: string; label: string; done: boolean }

function statusOf(values: FieldStatusRow[], fieldKey: string): CysValueStatus {
  return values.find((v) => v.fieldKey === fieldKey)?.status ?? 'MISSING'
}

export function computeCompletion(
  defs: CysDefinitionInput[],
  values: FieldStatusRow[],
): CompletionSummary {
  const required = defs.filter((d) => d.isRequired)
  const requiredVerified = required.filter((d) => statusOf(values, d.key) === 'VERIFIED').length
  const requiredTotal = required.length
  return {
    requiredTotal,
    requiredVerified,
    completionPct: requiredTotal === 0 ? 100 : Math.round((requiredVerified / requiredTotal) * 100),
  }
}

/**
 * Why "Approve as CYS ready" must be refused right now. Empty array = approvable.
 * SUGGESTED counts as a blocker on purpose: an AI reading nobody confirmed is
 * not client data yet.
 */
export function approvalBlockers(defs: CysDefinitionInput[], values: FieldStatusRow[]): string[] {
  const blockers: string[] = []
  for (const def of defs) {
    if (!def.isRequired) continue
    const status = statusOf(values, def.key)
    if (status === 'MISSING') blockers.push(`"${def.label}" is missing.`)
    else if (status === 'CONFLICT') blockers.push(`"${def.label}" has conflicting values to resolve.`)
    else if (status === 'SUGGESTED') blockers.push(`"${def.label}" is an unverified AI suggestion — verify or correct it.`)
  }
  return blockers
}

export function buildChecklist(
  defs: CysDefinitionInput[],
  values: FieldStatusRow[],
): ChecklistItem[] {
  const { requiredTotal, requiredVerified } = computeCompletion(defs, values)
  const activeKeys = new Set(defs.map((d) => d.key))
  const scoped = values.filter((v) => activeKeys.has(v.fieldKey))
  const conflicts = scoped.filter((v) => v.status === 'CONFLICT').length
  const requiredSuggested = defs.filter(
    (d) => d.isRequired && statusOf(values, d.key) === 'SUGGESTED',
  ).length

  return [
    {
      key: 'required_verified',
      label: `All required fields verified (${requiredVerified}/${requiredTotal})`,
      done: requiredTotal > 0 && requiredVerified === requiredTotal,
    },
    {
      key: 'no_conflicts',
      label: conflicts === 0 ? 'No conflicting values' : `${conflicts} conflicting value${conflicts === 1 ? '' : 's'} to resolve`,
      done: conflicts === 0,
    },
    {
      key: 'no_pending_suggestions',
      label:
        requiredSuggested === 0
          ? 'No unreviewed AI suggestions on required fields'
          : `${requiredSuggested} required field${requiredSuggested === 1 ? '' : 's'} still an unreviewed AI suggestion`,
      done: requiredSuggested === 0,
    },
  ]
}
