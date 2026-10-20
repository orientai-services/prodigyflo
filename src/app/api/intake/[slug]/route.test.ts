import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ processInbound: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {
  intakeSource: { findMany: vi.fn(async () => [{ id: 'src_1', organizationId: 'org_1', slug: 'scs-website', kind: 'WEBHOOK', connectorDefId: null, authMode: 'TOKEN', secretHash: 'h', isEnabled: true }]) },
  intakeSubmission: { findUnique: vi.fn(async () => null) },
  auditEvent: { create: vi.fn() },
} }))
vi.mock('@/lib/intake/hmac', () => ({ SIGNATURE_HEADER: 'x-intake-signature', TOKEN_HEADER: 'x-connector-token', verifySignature: () => false, verifyToken: () => true }))
vi.mock('@/lib/intake/apply', () => ({ processInbound: mocks.processInbound }))
vi.mock('@/lib/intake/cohort', () => ({ readCohort: () => undefined }))
vi.mock('@/lib/inbound/record', () => ({ recordInboundEvent: vi.fn() }))
vi.mock('@/lib/connectors/catalog', () => ({ defForIntakeKind: () => null }))
vi.mock('@/lib/intake/scs-packet', () => ({ isSchema42Payload: () => true, scsLeadId: () => 'lead_1' }))
vi.mock('@/lib/intake/appointment', () => ({ parseIntakeBooking: () => null, upsertIntakeAppointment: vi.fn() }))

import { BoundClientUnavailableError, IntakeBindingConflictError } from '@/lib/intake/errors'
import { POST } from './route'

const call = () => POST(new Request('https://pf.test/api/intake/scs-website', {
  method: 'POST', headers: { 'x-connector-token': 't' }, body: JSON.stringify({ lead_id: 'lead_1', data: {} }),
}) as never, { params: Promise.resolve({ slug: 'scs-website' }) })

describe('POST /api/intake/[slug] bound client unavailable', () => {
  beforeEach(() => vi.clearAllMocks())
  it('answers 409 with a stable code and the same message', async () => {
    mocks.processInbound.mockRejectedValue(new BoundClientUnavailableError())
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'bound_client_unavailable', message: 'Bound SCS client is unavailable; reconciliation required.' })
  })
  it('still throws (500) for other errors', async () => {
    mocks.processInbound.mockRejectedValue(new Error('boom'))
    await expect(call()).rejects.toThrow('boom')
  })
  it('answers 409 when the source case and signed referral disagree', async () => {
    mocks.processInbound.mockRejectedValue(new IntakeBindingConflictError())
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'intake_binding_conflict' })
  })
})
