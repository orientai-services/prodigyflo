import { DocumentCategory } from '@prisma/client'
import { db } from '@/lib/db'

/** The SCS upload area is authoritative for where a copied file is displayed. */
export const SCS_DOCUMENT_REQUIREMENTS = [
  { sourceType: 'agreement', key: 'solar_contract', name: 'Solar contract or install agreement', category: DocumentCategory.CONTRACT },
  { sourceType: 'loan_or_til', key: 'finance_agreement', name: 'Finance or lender agreement', category: DocumentCategory.CONTRACT },
  { sourceType: 'lien_filing', key: 'lien_filing', name: 'UCC-1 fixture lien filing', category: DocumentCategory.OTHER },
  { sourceType: 'ownership', key: 'property_ownership', name: 'Home ownership documents', category: DocumentCategory.OTHER },
  { sourceType: 'utility_bill', key: 'utility_bill', name: 'Electric bills', category: DocumentCategory.OTHER },
  { sourceType: 'production', key: 'production_report', name: 'Solar production reports', category: DocumentCategory.OTHER },
  { sourceType: 'pto_letter', key: 'pto_letter', name: 'Utility interconnection agreement (PTO letter)', category: DocumentCategory.OTHER },
  { sourceType: 'permits', key: 'permit_records', name: 'County permitting records', category: DocumentCategory.OTHER },
] as const

const MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp']

export function scsRequirementFor(sourceType: string | null | undefined) {
  return SCS_DOCUMENT_REQUIREMENTS.find((requirement) => requirement.sourceType === sourceType) ?? null
}

/**
 * Adds optional SCS upload areas to the tenant's normal package on demand.
 * They organize case files only; they never change document-completion gates.
 */
export async function scsRequirementId(organizationId: string, sourceType: string | null | undefined): Promise<string | null> {
  const requirement = scsRequirementFor(sourceType)
  if (!requirement) return null

  const existing = await db.documentRequirement.findFirst({
    where: { key: requirement.key, package: { organizationId, isDefault: true } },
    select: { id: true },
  })
  if (existing) return existing.id

  const pkg = await db.documentPackage.findFirst({
    where: { organizationId, isDefault: true },
    select: { id: true },
  })
  if (!pkg) return null

  const position = 100 + SCS_DOCUMENT_REQUIREMENTS.findIndex((item) => item.key === requirement.key)
  const created = await db.documentRequirement.upsert({
    where: { packageId_key: { packageId: pkg.id, key: requirement.key } },
    update: {},
    create: {
      packageId: pkg.id,
      key: requirement.key,
      name: requirement.name,
      category: requirement.category,
      isRequired: false,
      isAttorneyRequired: false,
      position,
      allowedMimeTypes: MIME_TYPES,
      maxSizeMb: 25,
    },
    select: { id: true },
  })
  return created.id
}
