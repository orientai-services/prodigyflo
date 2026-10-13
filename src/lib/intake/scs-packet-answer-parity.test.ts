/**
 * Typed-answer parity: every answer key SCS lists in
 * docs/contract/scs-answer-keys.json (copied from scs-intake #121, commit
 * 80c06dab8c5c7cfbcaf56f43d4bc6bee527567f4) must land on the ProdigyFlo
 * profile when it arrives in a confirmed packet. The packet runs through the
 * real import mapping (intakeAnswersFromPacket) and the profile reader
 * (flattenSurveyAnswers). Failures are real gaps; do not skip them.
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/cys/data', () => ({ refreshCysMirror: vi.fn() }))
vi.mock('./scs-analysis', () => ({ queueAnalysisPacket: vi.fn(), materializeScsAnalysis: vi.fn() }))
vi.mock('./scs-document-import', () => ({ queueScsDocumentImports: vi.fn() }))
import contract from '../../../docs/contract/scs-answer-keys.json'
import { flattenSurveyAnswers } from '@/lib/cys/resolve'
import { intakeAnswersFromPacket } from './scs-packet'

type Entry = { key: string; packet_path: string }
const entries = (contract.keys as Entry[]).filter((e, i, all) => all.findIndex(o => o.packet_path === e.packet_path) === i)
const KEYS = [...new Set(entries.map(e => e.key))].sort()
const valueFor = (key: string) => `ANSWER-${key}`

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>
  node[parts.at(-1)!] = value
}
function confirmedPacket(extraStage1: Record<string, string> = {}) {
  const raw: Record<string, unknown> = { lead_id: 'lead_1', data: { schema_version: 'schema_42.v1' } }
  // Each key is only placed at the paths SCS lists for it.
  for (const e of entries) setPath(raw, e.packet_path, valueFor(e.key))
  for (const [k, v] of Object.entries(extraStage1)) setPath(raw, `data.stage1_answers.${k}`, v)
  return raw
}
const profile = (raw: Record<string, unknown>) => flattenSurveyAnswers(intakeAnswersFromPacket(raw))

describe('SCS confirmed packet → ProdigyFlo profile parity (typed answers)', () => {
  it('reads a deduped key list from the SCS contract', () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(26)
    expect(new Set(KEYS).size).toBe(KEYS.length)
  })
  it.each(KEYS)('typed answer %s lands on the profile', key => {
    expect(profile(confirmedPacket())[key], `${key} (sent at ${entries.filter(e => e.key === key).map(e => e.packet_path).join(' + ')}) is missing on the profile`).toBe(valueFor(key))
  })
  it('keeps profile_questionnaire.* answers (dynamic pattern, sampled)', () => {
    expect(contract.dynamic.some(d => d.source.includes('profile_questionnaire'))).toBe(true)
    const sample = { roof_age_years: '12', hoa_present: 'yes', sample_questionnaire_note: 'free text' }
    const out = profile(confirmedPacket(sample))
    for (const [k, v] of Object.entries(sample)) expect(out[k], `questionnaire answer ${k}`).toBe(v)
  })
})
