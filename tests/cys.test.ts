import { describe, expect, it } from 'vitest'
import {
  resolveField,
  type CysDefinitionInput,
  type DocumentFieldInput,
  type SourceRecord,
} from '@/lib/cys/resolve'
import { approvalBlockers, computeCompletion } from '@/lib/cys/readiness'
import {
  assertPackageAllowed,
  buildPackageDocument,
  PackageNotAllowedError,
} from '@/lib/cys/package'

const def = (overrides: Partial<CysDefinitionInput> = {}): CysDefinitionInput => ({
  key: 'installer_name',
  label: 'Installer / seller',
  groupName: 'Solar agreement',
  position: 0,
  isRequired: true,
  dataType: 'string',
  sourceType: 'DOCUMENT_FIELD',
  sourcePath: 'document.solar_contract.installer_name',
  ...overrides,
})

const docField = (overrides: Partial<DocumentFieldInput> = {}): DocumentFieldInput => ({
  key: 'installer_name',
  documentTypeKey: 'solar_contract',
  value: 'Sunrun Inc',
  correctedValue: null,
  verification: 'UNVERIFIED',
  confidence: 80,
  documentId: 'doc_1',
  extractedFieldId: 'ef_1',
  documentLabel: 'Solar agreement.pdf',
  sourcePage: 3,
  ...overrides,
})

const sources = (overrides: Partial<SourceRecord> = {}): SourceRecord => ({
  client: {},
  address: null,
  survey: {},
  documentFields: [],
  ...overrides,
})

describe('CYS field resolution', () => {
  it('resolves a non-empty CRM client field to VERIFIED', () => {
    const d = def({ sourceType: 'CLIENT_FIELD', sourcePath: 'client.email', key: 'homeowner_email' })
    const r = resolveField(d, sources({ client: { email: 'ana@example.com' } }))
    expect(r.status).toBe('VERIFIED')
    expect(r.value).toBe('ana@example.com')
    expect(r.sourceLabel).toBe('CRM')
  })

  it('resolves an empty CRM field to MISSING', () => {
    const d = def({ sourceType: 'CLIENT_FIELD', sourcePath: 'client.email', key: 'homeowner_email' })
    const r = resolveField(d, sources({ client: { email: '  ' } }))
    expect(r.status).toBe('MISSING')
    expect(r.value).toBeNull()
  })

  it('never resolves an UNVERIFIED extracted field to VERIFIED — only SUGGESTED', () => {
    const r = resolveField(def(), sources({ documentFields: [docField({ confidence: 97 })] }))
    expect(r.status).toBe('SUGGESTED')
    expect(r.value).toBe('Sunrun Inc')
    expect(r.confidence).toBe(97)
    expect(r.sourceDocumentId).toBe('doc_1')
    expect(r.sourceExtractedFieldId).toBe('ef_1')
  })

  it('resolves a CORRECTED field to VERIFIED using the corrected value', () => {
    const r = resolveField(
      def(),
      sources({
        documentFields: [
          docField({ verification: 'CORRECTED', value: 'Sunrun', correctedValue: 'Sunrun Inc.' }),
        ],
      }),
    )
    expect(r.status).toBe('VERIFIED')
    expect(r.value).toBe('Sunrun Inc.')
  })

  it('prefers a human-verified reading over a disagreeing unverified suggestion', () => {
    const r = resolveField(
      def(),
      sources({
        documentFields: [
          docField({ verification: 'UNVERIFIED', value: 'SunPower', confidence: 99, extractedFieldId: 'ef_2', documentId: 'doc_2' }),
          docField({ verification: 'VERIFIED', value: 'Sunrun Inc' }),
        ],
      }),
    )
    expect(r.status).toBe('VERIFIED')
    expect(r.value).toBe('Sunrun Inc')
    expect(r.sourceExtractedFieldId).toBe('ef_1')
  })

  it('ignores REJECTED fields entirely', () => {
    const r = resolveField(
      def(),
      sources({ documentFields: [docField({ verification: 'REJECTED' })] }),
    )
    expect(r.status).toBe('MISSING')
  })

  it('flags two disagreeing verified sources as CONFLICT with the competing value', () => {
    const r = resolveField(
      def(),
      sources({
        documentFields: [
          docField({ verification: 'VERIFIED', value: 'Sunrun Inc' }),
          docField({
            verification: 'VERIFIED',
            value: 'SunPower LLC',
            documentId: 'doc_2',
            extractedFieldId: 'ef_2',
            documentLabel: 'Utility bill.pdf',
          }),
        ],
      }),
    )
    expect(r.status).toBe('CONFLICT')
    expect(r.value).toBe('Sunrun Inc')
    expect(r.conflictValue).toBe('SunPower LLC')
  })

  it('flags two disagreeing suggestions as CONFLICT, highest confidence first', () => {
    const r = resolveField(
      def(),
      sources({
        documentFields: [
          docField({ value: 'SunPower LLC', confidence: 60, extractedFieldId: 'ef_2', documentId: 'doc_2' }),
          docField({ value: 'Sunrun Inc', confidence: 90 }),
        ],
      }),
    )
    expect(r.status).toBe('CONFLICT')
    expect(r.value).toBe('Sunrun Inc')
    expect(r.conflictValue).toBe('SunPower LLC')
  })

  it('does not conflict on case or whitespace differences', () => {
    const r = resolveField(
      def(),
      sources({
        documentFields: [
          docField({ verification: 'VERIFIED', value: 'Sunrun  Inc' }),
          docField({ verification: 'VERIFIED', value: 'sunrun inc', extractedFieldId: 'ef_2', documentId: 'doc_2' }),
        ],
      }),
    )
    expect(r.status).toBe('VERIFIED')
  })

  it('MANUAL fields resolve to MISSING until staff enter them', () => {
    const d = def({ sourceType: 'MANUAL', sourcePath: null, key: 'signed_contract_on_file' })
    const r = resolveField(d, sources())
    expect(r.status).toBe('MISSING')
  })
})

describe('completion maths', () => {
  const defs = [
    def({ key: 'a', isRequired: true }),
    def({ key: 'b', isRequired: true }),
    def({ key: 'c', isRequired: true }),
    def({ key: 'd', isRequired: false }),
  ]

  it('counts only required fields and rounds the percentage', () => {
    const c = computeCompletion(defs, [
      { fieldKey: 'a', status: 'VERIFIED' },
      { fieldKey: 'b', status: 'VERIFIED' },
      { fieldKey: 'c', status: 'SUGGESTED' },
      { fieldKey: 'd', status: 'MISSING' },
    ])
    expect(c.requiredTotal).toBe(3)
    expect(c.requiredVerified).toBe(2)
    expect(c.completionPct).toBe(67)
  })

  it('is 100% with no required fields and 0% with none verified', () => {
    expect(computeCompletion([def({ key: 'x', isRequired: false })], []).completionPct).toBe(100)
    expect(computeCompletion(defs, []).completionPct).toBe(0)
  })
})

describe('approval gate', () => {
  const defs = [def({ key: 'a', label: 'A' }), def({ key: 'b', label: 'B' })]

  it('blocks while a required field is MISSING, SUGGESTED, or CONFLICT', () => {
    for (const status of ['MISSING', 'SUGGESTED', 'CONFLICT'] as const) {
      const blockers = approvalBlockers(defs, [
        { fieldKey: 'a', status: 'VERIFIED' },
        { fieldKey: 'b', status },
      ])
      expect(blockers).toHaveLength(1)
      expect(blockers[0]).toContain('"B"')
    }
  })

  it('allows approval only when every required field is VERIFIED', () => {
    const blockers = approvalBlockers(defs, [
      { fieldKey: 'a', status: 'VERIFIED' },
      { fieldKey: 'b', status: 'VERIFIED' },
    ])
    expect(blockers).toHaveLength(0)
  })

  it('ignores optional fields', () => {
    const blockers = approvalBlockers(
      [def({ key: 'a', label: 'A' }), def({ key: 'opt', label: 'Opt', isRequired: false })],
      [
        { fieldKey: 'a', status: 'VERIFIED' },
        { fieldKey: 'opt', status: 'MISSING' },
      ],
    )
    expect(blockers).toHaveLength(0) // a missing optional field never blocks approval
  })
})

describe('package generation', () => {
  const baseArgs = {
    client: { id: 'client_1', firstName: 'Ana', lastName: 'Reyes', email: 'ana@example.com' },
    generatedBy: { id: 'user_1', name: 'Staff Member' },
    generatedAt: new Date('2026-08-23T12:00:00Z'),
    appVersion: 'test',
    completion: { requiredTotal: 1, requiredVerified: 1, completionPct: 100 },
    checklist: [],
    definitions: [def()],
    values: [
      {
        fieldKey: 'installer_name',
        value: 'Sunrun Inc',
        status: 'VERIFIED' as const,
        confidence: 92,
        sourceLabel: 'Solar agreement.pdf (p. 3)',
        sourceDocumentId: 'doc_1',
        sourcePage: 3,
        verifiedByName: 'Staff Member',
        verifiedAt: new Date('2026-08-22T09:00:00Z'),
      },
    ],
    documents: [
      {
        id: 'doc_1',
        name: 'Solar agreement.pdf',
        type: 'CONTRACT',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        checksum: 'abc123',
        version: 2,
        status: 'APPROVED',
      },
    ],
  }

  it('refuses to build before approval', () => {
    expect(() => assertPackageAllowed(null)).toThrow(PackageNotAllowedError)
    expect(() => assertPackageAllowed({ approvedAt: null })).toThrow(PackageNotAllowedError)
    expect(() =>
      buildPackageDocument({
        ...baseArgs,
        approval: { approvedByName: null, approvedAt: null, note: null },
      }),
    ).toThrow(PackageNotAllowedError)
  })

  it('builds a versioned document with per-field provenance and a manifest', () => {
    const pkg = buildPackageDocument({
      ...baseArgs,
      approval: {
        approvedByName: 'Admin',
        approvedAt: new Date('2026-08-23T10:00:00Z'),
        note: 'ok',
      },
    })
    expect(pkg.packageVersion).toBe('1.0')
    expect(pkg.metadata.clientId).toBe('client_1')
    expect(pkg.metadata.approval.approvedBy).toBe('Admin')
    expect(pkg.fields).toHaveLength(1)
    expect(pkg.fields[0]).toMatchObject({
      key: 'installer_name',
      value: 'Sunrun Inc',
      status: 'VERIFIED',
      provenance: {
        source: 'Solar agreement.pdf (p. 3)',
        documentId: 'doc_1',
        page: 3,
        confidence: 92,
        verifiedBy: 'Staff Member',
      },
    })
    expect(pkg.documents).toHaveLength(1)
    expect(pkg.documents[0].checksum).toBe('abc123')
  })
})
