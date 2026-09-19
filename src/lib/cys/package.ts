import type { CysValueStatus } from '@prisma/client'
import type { CysDefinitionInput } from '@/lib/cys/resolve'
import type { CompletionSummary, ChecklistItem } from '@/lib/cys/readiness'

/**
 * Pure package assembly. There is no CYS API — the output of buildPackageDocument
 * is a versioned JSON handover document that staff download and deliver manually.
 */

export const CYS_PACKAGE_VERSION = '1.0'

export class PackageNotAllowedError extends Error {
  constructor(message = 'A CYS package can only be generated after the client is approved as CYS ready.') {
    super(message)
    this.name = 'PackageNotAllowedError'
  }
}

/** Throws unless the readiness record carries a real approval. */
export function assertPackageAllowed(readiness: { approvedAt: Date | null } | null | undefined): void {
  if (!readiness?.approvedAt) throw new PackageNotAllowedError()
}

export type PackageFieldInput = {
  fieldKey: string
  value: string | null
  status: CysValueStatus
  confidence: number | null
  sourceLabel: string | null
  sourceDocumentId: string | null
  sourcePage: number | null
  verifiedByName: string | null
  verifiedAt: Date | null
  note?: string | null
}

export type PackageManifestDocument = {
  id: string
  name: string
  type: string
  mimeType: string | null
  sizeBytes: number | null
  checksum: string | null
  version: number
  status: string
}

export type CysPackageDocument = ReturnType<typeof buildPackageDocument>

export function buildPackageDocument(args: {
  client: { id: string; firstName: string; lastName: string; email: string }
  generatedBy: { id: string; name: string }
  generatedAt: Date
  appVersion: string
  approval: { approvedByName: string | null; approvedAt: Date | null; note: string | null }
  completion: CompletionSummary
  checklist: ChecklistItem[]
  definitions: CysDefinitionInput[]
  values: PackageFieldInput[]
  documents: PackageManifestDocument[]
}) {
  assertPackageAllowed({ approvedAt: args.approval.approvedAt })

  const byKey = new Map(args.values.map((v) => [v.fieldKey, v]))

  return {
    packageVersion: CYS_PACKAGE_VERSION,
    metadata: {
      generatedAt: args.generatedAt.toISOString(),
      generatedBy: args.generatedBy,
      appVersion: args.appVersion,
      clientId: args.client.id,
      clientName: `${args.client.firstName} ${args.client.lastName}`.trim(),
      clientEmail: args.client.email,
      approval: {
        approvedBy: args.approval.approvedByName,
        approvedAt: args.approval.approvedAt?.toISOString() ?? null,
        note: args.approval.note,
      },
      completion: args.completion,
      checklist: args.checklist,
    },
    fields: args.definitions.map((def) => {
      const v = byKey.get(def.key)
      return {
        key: def.key,
        label: def.label,
        group: def.groupName,
        dataType: def.dataType,
        required: def.isRequired,
        value: v?.value ?? null,
        status: v?.status ?? 'MISSING',
        provenance: {
          sourceType: def.sourceType,
          source: v?.sourceLabel ?? null,
          documentId: v?.sourceDocumentId ?? null,
          page: v?.sourcePage ?? null,
          confidence: v?.confidence ?? null,
          verifiedBy: v?.verifiedByName ?? null,
          verifiedAt: v?.verifiedAt?.toISOString() ?? null,
          note: v?.note ?? null,
        },
      }
    }),
    documents: args.documents,
  }
}
