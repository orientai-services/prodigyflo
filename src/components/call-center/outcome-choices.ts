import { OUTCOMES, OUTCOME_GROUPS, type LeadOutcome } from '@/lib/call-center/model'
import type { ChoiceGroup } from './choice-select'

export const OUTCOME_PLACEHOLDER = 'Choose an outcome…'

/**
 * The lead result dropdown's groups, built from OUTCOMES so the labels and the
 * saved values never drift from the model. `keys` adds the 1–9 shortcut that
 * picks each one; `suggest` marks the result the call itself points to.
 */
export function outcomeGroups({ keys = false, suggest = null }: { keys?: boolean; suggest?: LeadOutcome | null } = {}): ChoiceGroup<LeadOutcome>[] {
  return OUTCOME_GROUPS.map((group) => ({
    label: group.label,
    options: group.ids.map((id) => {
      const index = OUTCOMES.findIndex((item) => item.id === id)
      const item = OUTCOMES[index]
      let label = item.label
      if (keys) label += ` (${index + 1})`
      if (suggest === id) label += ' · suggested'
      return { value: id, label }
    }),
  }))
}
