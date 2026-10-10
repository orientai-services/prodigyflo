import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { flattenSurveyAnswers, resolveField } from '@/lib/cys/resolve'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  queue: vi.fn(),
  records: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    survey: { findFirst: vi.fn().mockResolvedValue(null) },
    clientAddress: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    externalDocumentImport: { updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/cys/data', () => ({ refreshCysMirror: mocks.refresh }))
vi.mock('./scs-document-import', () => ({ queueScsDocumentImports: mocks.queue }))
vi.mock('@/lib/property-records/jobs', () => ({ queuePropertyRecords: mocks.records }))

import { ingestScsPacket, scsLeadId, intakeAnswersFromPacket } from './scs-packet'

const documentRef = {
  id: 'scs_doc_1',
  doc_type: 'agreement',
  original_filename: 'solar-agreement.pdf',
  storage_path: 'lead_1/source.pdf',
  mime: 'application/pdf',
  size_bytes: 12,
  signed_get_url: 'https://storage.example.test/signed',
}

describe('ingestScsPacket document import queue', () => {
  it('clears a prior automatic mailing answer when the customer explicitly leaves it unknown', async () => {
    const update = vi.fn()
    const store = {
      survey: { findFirst: vi.fn().mockResolvedValue({ id: 'survey_1' }) },
      surveyResponse: {
        findFirst: vi.fn().mockResolvedValue({ id: 'response_1', answers: { mailing_same_as_property: true }, completedAt: null }),
        update,
      },
      externalDocumentImport: { updateMany: vi.fn() },
    } as unknown as Prisma.TransactionClient
    await ingestScsPacket({ organizationId: 'org_1', clientId: 'client_1', intakeSubmissionId: 'submission_1', rawPayload: {
      lead_id: 'lead_1', data: { stage1_answers: { mailing_same_as_property: null }, stage1_provenance: { mailing_same_as_property: { source: 'homeowner' } } },
    } }, store)
    const answers = update.mock.calls[0][0].data.answers
    expect(answers.mailing_same_as_property).toBeNull()
    expect(resolveField({ key: 'mailing_same_as_property', label: 'Mailing same as property', groupName: 'Contact', position: 1, isRequired: false, dataType: 'boolean', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.mailing_same_as_property' }, {
      client: {}, address: null, documentFields: [], survey: flattenSurveyAnswers(answers),
    })).toMatchObject({ value: null, status: 'MISSING' })
    // Intake updates source answers only. The separate staff CYS review is not written here.
    expect(Object.keys(store)).toEqual(['survey', 'surveyResponse', 'externalDocumentImport'])
  })
  it('preserves homeowner and reviewed answers without presenting extraction as a survey answer', () => {
    const answers = intakeAnswersFromPacket({ data: {
      stage1_answers: { first_name: 'Example', product_confirmed: 'ppa', term_months: '240', monthly_guess: '120' },
      stage1_provenance: {
        first_name: { source: 'homeowner' },
        product_confirmed: { source: 'document_review' },
        term_months: { source: 'document_extraction' },
        monthly_guess: { source: 'homeowner' },
      },
      finance: { amount_financed: 9000, term_months: 240 },
    } })
    expect(answers).toMatchObject({ first_name: 'Example', product_confirmed: 'ppa', monthly_guess: '120' })
    expect(answers.term_months).toBeUndefined()
    expect(answers.amount_financed).toBeUndefined()
    expect(answers._scs_answer_provenance).toMatchObject({ product_confirmed: { source: 'document_review' } })
  })
  it('carries typed utility bill and credit from intake money/screening onto the profile', () => {
    const answers = intakeAnswersFromPacket({ data: {
      stage1_answers: { first_name: 'Example' },
      stage1_provenance: { first_name: { source: 'homeowner' } },
      money: { monthly_utility_bill: 187.44, payment_status: 'current', paying_both: true },
      screening: { credit_band: '740_plus' },
    } })
    expect(answers).toMatchObject({ first_name: 'Example', monthly_utility_bill: 187.44, credit_band: '740_plus', payment_status: 'current', paying_both: true })
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.queue.mockResolvedValue(undefined)
  })

  it('queues stable SCS document identities and never retains an expiring URL', async () => {
    await ingestScsPacket({
      organizationId: 'org_1',
      clientId: 'client_1',
      intakeSubmissionId: 'submission_1',
      rawPayload: { data: { schema_version: 'schema_42.v1', documents: { files: [documentRef] } } },
    })

    expect(mocks.queue).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org_1', clientId: 'client_1', intakeSubmissionId: 'submission_1',
      documents: [documentRef],
    }), expect.anything())
  })

  it('accepts metadata without a signed URL because the worker obtains fresh authenticated bytes', async () => {
    await ingestScsPacket({
      organizationId: 'org_1',
      clientId: 'client_1',
      intakeSubmissionId: 'submission_1',
      rawPayload: {
        data: {
          schema_version: 'schema_42.v1',
          documents: { files: [{ ...documentRef, signed_get_url: undefined }] },
        },
      },
    })
    expect(mocks.queue).toHaveBeenCalledTimes(1)
  })

  it('queues one property-records lookup from the Contact step 1 packet (lead.received)', async () => {
    const create = vi.fn()
    const store = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      survey: { findFirst: vi.fn().mockResolvedValue(null) },
      clientAddress: { findFirst: vi.fn().mockResolvedValue(null), create, update: vi.fn() },
      externalDocumentImport: { updateMany: vi.fn() },
    } as unknown as Prisma.TransactionClient
    await ingestScsPacket({ organizationId: 'org_1', clientId: 'client_1', intakeSubmissionId: 'submission_1', rawPayload: {
      lead_id: 'lead_1', event: 'lead.received',
      data: { schema_version: 'schema_42.v1', stage1_answers: {
        first_name: 'Example', last_name: 'Owner', email: 'owner@example.test', phone: '5555550100',
        property_street: '909 Bartona St', city: 'Las Vegas', state: 'NV', zip: '89107',
      } },
    } }, store)
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ clientId: 'client_1', line1: '909 Bartona St', city: 'Las Vegas', state: 'NV', postalCode: '89107', isPrimary: true }) })
    expect(mocks.records).toHaveBeenCalledTimes(1)
    expect(mocks.records).toHaveBeenCalledWith({ organizationId: 'org_1', clientId: 'client_1', sourceLeadId: 'lead_1',
      address: { line1: '909 Bartona St', city: 'Las Vegas', state: 'NV', postal_code: '89107' } }, store)
    // The address is saved before the lookup is queued, so the job matches the live primary address.
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(mocks.records.mock.invocationCallOrder[0])
  })

  it('keeps a corrected street when a later packet repeats the intake typo', async () => {
    const update = vi.fn()
    const retire = vi.fn()
    const store = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      survey: { findFirst: vi.fn().mockResolvedValue(null) },
      clientAddress: {
        findFirst: vi.fn().mockResolvedValue({ id: 'addr', line1: '9796 Almenia St', city: 'Las Vegas', state: 'NV', postalCode: '89178' }),
        create: vi.fn(),
        update,
      },
      documentExtraction: { updateMany: retire },
      externalDocumentImport: { updateMany: vi.fn() },
    } as unknown as Prisma.TransactionClient
    await ingestScsPacket({ organizationId: 'org_1', clientId: 'client_1', intakeSubmissionId: 'submission_1', rawPayload: {
      lead_id: 'lead_1',
      data: { schema_version: 'schema_42.v1', stage1_answers: { property_street: '9796 Alemnia St', city: 'Las Vegas', state: 'NV', zip: '89178' } },
    } }, store)
    expect(update).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
    expect(mocks.records).toHaveBeenCalledWith(expect.objectContaining({
      address: { line1: '9796 Almenia St', city: 'Las Vegas', state: 'NV', postal_code: '89178' },
    }), store)
  })

  it('retires the contract reading when a later packet names a different house', async () => {
    const update = vi.fn()
    const retire = vi.fn()
    const store = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      survey: { findFirst: vi.fn().mockResolvedValue(null) },
      clientAddress: {
        findFirst: vi.fn().mockResolvedValue({ id: 'addr', line1: '9796 Almenia St', city: 'Las Vegas', state: 'NV', postalCode: '89178' }),
        create: vi.fn(),
        update,
      },
      documentExtraction: { updateMany: retire },
      externalDocumentImport: { updateMany: vi.fn() },
    } as unknown as Prisma.TransactionClient
    await ingestScsPacket({ organizationId: 'org_1', clientId: 'client_1', intakeSubmissionId: 'submission_1', rawPayload: {
      lead_id: 'lead_1',
      data: { schema_version: 'schema_42.v1', stage1_answers: { property_street: '9797 Almenia St', city: 'Las Vegas', state: 'NV', zip: '89178' } },
    } }, store)
    expect(update).toHaveBeenCalledWith({ data: expect.objectContaining({ line1: '9797 Almenia St', postalCode: '89178' }), where: { id: 'addr' } })
    expect(retire).toHaveBeenCalledWith({ where: { provider: 'records', document: { clientId: 'client_1' } }, data: { sourceActive: false } })
  })

  it('does not queue a lookup until Contact has the full property address', async () => {
    const store = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      survey: { findFirst: vi.fn().mockResolvedValue(null) },
      clientAddress: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
      externalDocumentImport: { updateMany: vi.fn() },
    } as unknown as Prisma.TransactionClient
    await ingestScsPacket({ organizationId: 'org_1', clientId: 'client_1', intakeSubmissionId: 'submission_1', rawPayload: {
      lead_id: 'lead_1', data: { schema_version: 'schema_42.v1', stage1_answers: { first_name: 'Example', property_street: '909 Bartona St', city: 'Las Vegas' } },
    } }, store)
    expect(mocks.records).not.toHaveBeenCalled()
  })

  it('uses the durable SCS case id, never a delivery-attempt id', () => {
    expect(scsLeadId({ lead_id: '9be21a01-668b-4cdf-8634-a36bbd94d099', id: 'delivery-row:4' }))
      .toBe('9be21a01-668b-4cdf-8634-a36bbd94d099')
    expect(scsLeadId({ id: 'delivery-row:4' })).toBeNull()
  })
})
