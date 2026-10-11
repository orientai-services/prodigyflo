import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/cys/data', () => ({ refreshCysMirror: vi.fn() }))
vi.mock('./scs-analysis', () => ({ queueAnalysisPacket: vi.fn(), materializeScsAnalysis: vi.fn() }))
vi.mock('./scs-document-import', () => ({ queueScsDocumentImports: vi.fn() }))
import { flattenSurveyAnswers } from '@/lib/cys/resolve'
import { intakeAnswersFromPacket } from './scs-packet'

const typed = (value: unknown, source = 'homeowner') => ({ value, field_key: 'k', source, source_ref: null, captured_at: null })
const packet = (data: Record<string, unknown>) => ({ lead_id: 'lead_1', data: { schema_version: 'schema_42.v1', stage1_answers: { first_name: 'Test' }, ...data } })

describe('SCS typed_field_provenance import', () => {
  // Same 3 assertions as #90's answer-parity test.
  it.each(['interest_rate', 'remaining_balance', 'monthly_solar_payment'])('typed answer %s lands on the profile', key => {
    const out = flattenSurveyAnswers(intakeAnswersFromPacket(packet({ typed_field_provenance: { [key]: `ANSWER-${key}` } })))
    expect(out[key]).toBe(`ANSWER-${key}`)
  })
  it('reads the real SCS object shape and keeps it labeled as client-typed', () => {
    const answers = intakeAnswersFromPacket(packet({ typed_field_provenance: { interest_rate: typed(3.99), remaining_balance: typed(41000), monthly_solar_payment: typed(212.5) } }))
    expect(answers).toMatchObject({ interest_rate: 3.99, remaining_balance: 41000, monthly_solar_payment: 212.5 })
    expect((answers._scs_answer_provenance as Record<string, { source: string }>).interest_rate.source).toBe('homeowner')
  })
  it('does not overwrite a Stage 1 answer and skips document-derived values', () => {
    const answers = intakeAnswersFromPacket({ lead_id: 'lead_1', data: {
      stage1_answers: { monthly_utility_bill: '180' },
      typed_field_provenance: { monthly_utility_bill: typed(999), interest_rate: typed(2.99, 'document_review'), remaining_balance: typed(5, 'document_extraction'), monthly_solar_payment: typed('') },
    } })
    expect(answers.monthly_utility_bill).toBe('180')
    expect(answers).not.toHaveProperty('interest_rate')
    expect(answers).not.toHaveProperty('remaining_balance')
    expect(answers).not.toHaveProperty('monthly_solar_payment')
  })
})
