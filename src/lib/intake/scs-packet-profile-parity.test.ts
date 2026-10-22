/**
 * Hector's rule: every contract field SCS sends in a confirmed packet must
 * land on the ProdigyFlo profile. The field list is generated from the SCS
 * Records contract vocabulary (records-analyzer FIELD_MAP values = the SCS
 * packet field keys), not a hand list, so a new SCS field fails here until
 * ProdigyFlo maps it. Failures are real gaps; do not skip them.
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/db', () => ({ db: {} }))
import { FIELD_MAP } from '@/lib/records-analyzer/map'
import { DOC_TYPE_SPECS } from '@/lib/extraction/spec'
import { analysisDocument } from './analysis-contract'
import { analysisFields } from './scs-analysis'

const SCS_PACKET_FIELDS = [...new Set(Object.values(FIELD_MAP))].sort()
const PROFILE_KEYS = new Set(DOC_TYPE_SPECS.flatMap(spec => spec.fields.map(f => f.key)))
const slots = [
  { name: 'agreement', classification: ['solar_contract'], hint: { sourceDocumentType: 'agreement' } },
  { name: 'loan_or_til', classification: ['loan_or_til'], hint: { sourceDocumentType: 'loan_or_til' } },
  { name: 'utility_bill', classification: ['utility_bill'], hint: { sourceDocumentType: 'utility_bill' } },
]
function confirmedDoc(field: string, classification: string[]) {
  const evidence = { value: 'PARITY-VALUE', confidence: 'high', page: 1, quote: 'PARITY-VALUE', document_id: 'doc_1', source: 'packet.pdf', run_id: 'run_1', provider: 'records', model: 'model', staff_review_required: true }
  return analysisDocument.parse({
    documentId: 'doc_1', sha256: 'a'.repeat(64), fields: { [field]: evidence }, classification,
    readableAgreement: true, clientMatch: 'matched', coverage: { complete: true, totalPages: 1, processedPages: 1 }, runs: ['run_1'],
    reviewDecisions: { [field]: { action: 'accepted', accepted: 'PARITY-VALUE', source_evidence: evidence } },
  })
}

describe('SCS confirmed packet → ProdigyFlo profile parity (contract fields)', () => {
  it('has a generated field list', () => expect(SCS_PACKET_FIELDS.length).toBeGreaterThan(20))
  it.each(SCS_PACKET_FIELDS)('SCS field %s lands on the profile', field => {
    const landed = slots.flatMap(slot => analysisFields(confirmedDoc(field, slot.classification) as never, slot.hint))
      .filter(f => f.value === 'PARITY-VALUE')
    expect(landed.length, `${field} is dropped on import (no profile key)`).toBeGreaterThan(0)
    expect(landed.some(f => PROFILE_KEYS.has(f.key)), `${field} maps to ${landed.map(f => f.key).join(',')} which no profile tile shows`).toBe(true)
  })
})
