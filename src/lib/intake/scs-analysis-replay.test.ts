import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
vi.mock('@/lib/db', () => ({ db: {} }))
import { queueAnalysisPacket } from './scs-analysis'
import { hash, identityFromAnswers } from './analysis-contract'

const raw = { data: { stage1_answers: { first_name: 'Example', last_name: 'Person', property_street: '1 Test St', city: 'Las Vegas', state: 'NV', zip: '89101' } } }
const identity = identityFromAnswers(raw)
const evidence = { value: '10', confidence: 'high', page: 1, quote: '$10', document_id: 'doc', source: 'test.pdf', run_id: 'run', provider: 'records', model: 'model', staff_review_required: true }
const analysis = { version: 'records.v1', manifestId: '85f579ea-4d96-4c82-8ebc-3f10b56d401f', status: 'results_available', sourceLeadId: 'lead', manifest_version: 2, evidence_revision: 5, analysis_version: 'v2', source_identity: identity, identity_fingerprint: hash(identity), documents: [{ documentId: 'doc', sha256: 'a'.repeat(64), fields: { total_financed: evidence }, classification: ['loan', 'til'], readableAgreement: true, clientMatch: 'matched', coverage: { complete: true, totalPages: 9, processedPages: 9 }, runs: ['run'], reviewDecisions: { total_financed: { action: 'accepted', accepted: '10', source_evidence: evidence } } }] }
function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, child]) => [key, reordered(child)]))
  return value
}
async function fixture() {
  const receipt: { id: string; sourceAnalysis: unknown; analysisIdentity: string | null } = { id: 'receipt', sourceAnalysis: null, analysisIdentity: null }
  const update = vi.fn().mockImplementation(async ({ data }) => Object.assign(receipt, { ...data, sourceAnalysis: reordered(data.sourceAnalysis) }))
  const store = { documentExtraction: { updateMany: vi.fn() }, externalDocumentImport: { updateMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(receipt), update } } as unknown as Prisma.TransactionClient
  const submit = (payload: unknown) => queueAnalysisPacket({ organizationId: 'org', clientId: 'client', sourceLeadId: 'lead', rawPayload: raw, analysis: payload }, store)
  await submit(analysis)
  return { receipt, update, submit }
}
describe('same-revision evidence replay across JSONB ordering', () => {
  it('accepts reordered objects without requeuing or changing identity fingerprints', async () => {
    const f = await fixture()
    expect(f.receipt.sourceAnalysis.identity_fingerprint).toBe(analysis.identity_fingerprint)
    await expect(f.submit(analysis)).resolves.toBeUndefined()
    expect(f.update).toHaveBeenCalledTimes(1)
  })
  it.each(['quote', 'review', 'array'])('rejects changed %s under the same revision', async kind => {
    const f = await fixture(), changed = structuredClone(analysis)
    if (kind === 'quote') changed.documents[0].fields.total_financed.quote = '$11'
    if (kind === 'review') changed.documents[0].reviewDecisions.total_financed.accepted = '11'
    if (kind === 'array') changed.documents[0].classification.reverse()
    await expect(f.submit(changed)).rejects.toThrow('Same analysis revision has different evidence')
    expect(f.update).toHaveBeenCalledTimes(1)
  })
})
