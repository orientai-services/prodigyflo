import type { PrismaClient } from '@prisma/client'

type SeedContext = {
  organizationId: string
  users: { id: string; email: string; role: string }[]
  clientIds: string[]
}

/**
 * Starter CYS field map for a solar-cancellation handover. Deterministic:
 * upserts on (organizationId, key), so re-running the seed is safe.
 *
 * Source paths follow the resolver conventions in src/lib/cys/resolve.ts:
 *   client.<field>, address.<field>, survey.<answerKey>,
 *   document.<detectedTypeKey>.<extractedFieldKey> (or document.<fieldKey> for any type).
 */
export const STARTER_FIELDS = [
  // Homeowner — straight from the CRM record a human entered.
  { key: 'homeowner_name', label: 'Homeowner name', groupName: 'Homeowner', position: 0, isRequired: true, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.fullName', helpText: 'Full legal name as it appears on the solar agreement.' },
  { key: 'homeowner_email', label: 'Email address', groupName: 'Homeowner', position: 1, isRequired: true, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.email', helpText: null },
  { key: 'homeowner_phone', label: 'Phone number', groupName: 'Homeowner', position: 2, isRequired: true, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.phone', helpText: null },
  { key: 'preferred_language', label: 'Preferred language', groupName: 'Homeowner', position: 3, isRequired: false, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.preferredLanguage', helpText: 'So CYS assigns a rep who speaks it.' },

  // Property.
  { key: 'service_address', label: 'Service address', groupName: 'Property', position: 0, isRequired: true, dataType: 'string', sourceType: 'ADDRESS_FIELD', sourcePath: 'address.full', helpText: 'The address where the system is installed.' },
  { key: 'utility_account_number', label: 'Utility account number', groupName: 'Property', position: 1, isRequired: true, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.utility_bill.account_number', helpText: 'From the most recent utility bill.' },
  { key: 'utility_provider', label: 'Utility provider', groupName: 'Property', position: 2, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.utility_bill.utility_name', helpText: null },

  // Solar agreement — extracted from the signed contract, then human-verified.
  { key: 'installer_name', label: 'Installer / seller', groupName: 'Solar agreement', position: 0, isRequired: true, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.installer_name', helpText: 'The company named on the solar agreement.' },
  { key: 'contract_date', label: 'Contract date', groupName: 'Solar agreement', position: 1, isRequired: true, dataType: 'date', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.contract_date', helpText: 'The date the agreement was signed.' },
  { key: 'system_size_kw', label: 'System size (kW)', groupName: 'Solar agreement', position: 2, isRequired: false, dataType: 'number', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.system_size_kw', helpText: null },
  { key: 'monthly_payment', label: 'Monthly payment', groupName: 'Solar agreement', position: 3, isRequired: true, dataType: 'currency', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.monthly_payment', helpText: 'The current monthly solar payment.' },
  { key: 'term_months', label: 'Term (months)', groupName: 'Solar agreement', position: 4, isRequired: true, dataType: 'number', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.term_months', helpText: 'Length of the agreement. The extractor normalises "25 years" to 300 months.' },
  { key: 'escalator_pct', label: 'Escalator (%)', groupName: 'Solar agreement', position: 5, isRequired: false, dataType: 'number', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.escalator_pct', helpText: 'Annual payment increase, when present.' },
  { key: 'financing_lender', label: 'Financing lender', groupName: 'Solar agreement', position: 6, isRequired: false, dataType: 'string', sourceType: 'MANUAL', sourcePath: null, helpText: 'The lender when the system is loan-financed. No document type extracts this yet, so staff enter it.' },

  // Evidence — confirmed by staff, not extracted.
  { key: 'signed_contract_on_file', label: 'Signed contract on file', groupName: 'Evidence', position: 0, isRequired: true, dataType: 'boolean', sourceType: 'MANUAL', sourcePath: null, helpText: 'Staff confirm the fully signed agreement is uploaded and approved.' },
  { key: 'communication_evidence_on_file', label: 'Communication evidence on file', groupName: 'Evidence', position: 1, isRequired: true, dataType: 'boolean', sourceType: 'MANUAL', sourcePath: null, helpText: 'Staff confirm the sales-communication evidence set is uploaded and approved.' },
] as const

export async function seedCys(db: PrismaClient, ctx: SeedContext): Promise<void> {
  for (const field of STARTER_FIELDS) {
    await db.cysFieldDefinition.upsert({
      where: { organizationId_key: { organizationId: ctx.organizationId, key: field.key } },
      create: {
        organizationId: ctx.organizationId,
        key: field.key,
        label: field.label,
        groupName: field.groupName,
        position: field.position,
        isRequired: field.isRequired,
        dataType: field.dataType,
        sourceType: field.sourceType,
        sourcePath: field.sourcePath,
        helpText: field.helpText,
        isActive: true,
      },
      update: {
        label: field.label,
        groupName: field.groupName,
        position: field.position,
        isRequired: field.isRequired,
        dataType: field.dataType,
        sourceType: field.sourceType,
        sourcePath: field.sourcePath,
        helpText: field.helpText,
      },
    })
  }
}
