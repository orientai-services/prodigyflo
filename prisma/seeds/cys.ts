import type { PrismaClient } from '@prisma/client'

type SeedContext = {
  organizationId: string
  users: { id: string; email: string; role: string }[]
  clientIds: string[]
}

type FieldSeed = {
  key: string
  label: string
  groupName: string
  position: number
  isRequired: boolean
  dataType: string
  sourceType: 'CLIENT_FIELD' | 'ADDRESS_FIELD' | 'DOCUMENT_FIELD' | 'SURVEY_FIELD' | 'MANUAL'
  sourcePath: string | null
  helpText: string | null
  isActive?: boolean
}

/**
 * SCHEMA_42 field map. Labels bind to CYS_42_field_schema_map.csv only.
 * Utility account and payoff are NOT required for READY.
 * Lender (27) is extracted from the finance agreement, not staff-typed MANUAL.
 * Legacy 16-field keys stay upserted as inactive aliases so old rows still resolve.
 */
export const SCHEMA_42_FIELDS: FieldSeed[] = [
  { key: 'first_name', label: 'First name', groupName: 'Stage 1', position: 1, isRequired: true, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.firstName', helpText: 'Required to start' },
  { key: 'last_name', label: 'Last name', groupName: 'Stage 1', position: 2, isRequired: true, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.lastName', helpText: null },
  { key: 'phone', label: 'Phone', groupName: 'Stage 1', position: 3, isRequired: true, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.phone', helpText: null },
  { key: 'email', label: 'Email', groupName: 'Stage 1', position: 4, isRequired: true, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.email', helpText: null },
  { key: 'property_street', label: 'Property street', groupName: 'Stage 1', position: 5, isRequired: true, dataType: 'string', sourceType: 'ADDRESS_FIELD', sourcePath: 'address.line1', helpText: null },
  { key: 'city', label: 'City', groupName: 'Stage 1', position: 6, isRequired: true, dataType: 'string', sourceType: 'ADDRESS_FIELD', sourcePath: 'address.city', helpText: null },
  { key: 'state', label: 'State', groupName: 'Stage 1', position: 7, isRequired: true, dataType: 'string', sourceType: 'ADDRESS_FIELD', sourcePath: 'address.state', helpText: null },
  { key: 'zip', label: 'ZIP', groupName: 'Stage 1', position: 8, isRequired: true, dataType: 'string', sourceType: 'ADDRESS_FIELD', sourcePath: 'address.postalCode', helpText: null },
  { key: 'mailing_same_as_property', label: 'Mailing same as property', groupName: 'Stage 1', position: 9, isRequired: false, dataType: 'boolean', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.mailing_same_as_property', helpText: 'Default Yes' },
  { key: 'owner_of_record', label: 'Owner of record', groupName: 'Stage 1', position: 10, isRequired: false, dataType: 'string', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.owner_of_record', helpText: 'owner / spouse / other' },
  { key: 'sale_or_refi', label: 'Sale or refinance in play', groupName: 'Stage 1', position: 11, isRequired: false, dataType: 'string', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.sale_or_refi', helpText: null },
  { key: 'pain_type', label: 'Pain type', groupName: 'Stage 1', position: 12, isRequired: false, dataType: 'string', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.pain_type', helpText: null },
  { key: 'pain_narrative', label: 'Pain in their words', groupName: 'Stage 1', position: 13, isRequired: false, dataType: 'string', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.pain_narrative', helpText: null },
  { key: 'product_type_guess', label: 'Product type if they know', groupName: 'Stage 1', position: 14, isRequired: false, dataType: 'string', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.product_type_guess', helpText: 'GX field 26 overwrites' },
  { key: 'lender_guess', label: 'Lender if they know', groupName: 'Stage 1', position: 15, isRequired: false, dataType: 'string', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.lender_guess', helpText: 'GX field 27 overwrites' },
  { key: 'monthly_guess', label: 'Monthly payment if they know', groupName: 'Stage 1', position: 16, isRequired: false, dataType: 'currency', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.monthly_guess', helpText: 'READY needs this or an extracted monthly' },
  { key: 'installer_guess', label: 'Installer if they know', groupName: 'Stage 1', position: 17, isRequired: false, dataType: 'string', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.installer_guess', helpText: null },
  { key: 'how_signed', label: 'How they signed', groupName: 'Stage 1', position: 18, isRequired: false, dataType: 'string', sourceType: 'SURVEY_FIELD', sourcePath: 'survey.how_signed', helpText: 'tablet | paper | not_sure' },

  { key: 'doc_contract', label: 'Signed install / purchase agreement', groupName: 'Stage 2', position: 19, isRequired: false, dataType: 'boolean', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.installer_name', helpText: 'READY needs 19 or 20. Partial file is valid.' },
  { key: 'doc_finance', label: 'Financing agreement + disclosures', groupName: 'Stage 2', position: 20, isRequired: false, dataType: 'boolean', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.finance_agreement.lender_name', helpText: 'One signed agreement is enough to start extract' },
  { key: 'doc_proposal', label: 'Proposal / savings estimate', groupName: 'Stage 2', position: 21, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.proposal.promised_monthly', helpText: null },
  { key: 'doc_statement', label: 'Current lender statement', groupName: 'Stage 2', position: 22, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.lender_statement.monthly_payment', helpText: null },
  { key: 'doc_payoff', label: 'Payoff quote', groupName: 'Stage 2', position: 23, isRequired: false, dataType: 'currency', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.payoff_letter.payoff_amount', helpText: 'NOT required for READY' },
  { key: 'doc_utility_bill', label: 'Latest utility bill', groupName: 'Stage 2', position: 24, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.utility_bill.utility_name', helpText: 'NOT required for READY' },
  { key: 'doc_photo_id', label: 'Photo ID', groupName: 'Stage 2', position: 25, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.government_id.full_name', helpText: 'NOT required for READY' },

  { key: 'product_confirmed', label: 'Product type confirmed', groupName: 'GX', position: 26, isRequired: true, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.product_type', helpText: 'Ops extraction, not a client form' },
  { key: 'lender_confirmed', label: 'Lender confirmed', groupName: 'GX', position: 27, isRequired: true, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.finance_agreement.lender_name', helpText: 'Extract from finance docs. Not MANUAL.' },
  { key: 'account_number', label: 'Account / loan number', groupName: 'GX', position: 28, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.finance_agreement.account_number', helpText: 'MISSING if the page does not show it. Never invent.' },
  { key: 'contract_value', label: 'Original contract value', groupName: 'GX', position: 29, isRequired: false, dataType: 'currency', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.finance_agreement.amount_financed', helpText: null },
  { key: 'dealer_fee', label: 'Dealer fee', groupName: 'GX', position: 30, isRequired: false, dataType: 'currency', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.finance_agreement.dealer_fee', helpText: 'MISSING if not on page' },
  { key: 'apr_or_escalator', label: 'APR / escalator', groupName: 'GX', position: 31, isRequired: false, dataType: 'percent', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.finance_agreement.apr', helpText: 'Never invent APR' },
  { key: 'term_months', label: 'Term months', groupName: 'GX', position: 32, isRequired: false, dataType: 'number', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.finance_agreement.term_months', helpText: null },
  { key: 'first_payment_or_install', label: 'First payment / install date', groupName: 'GX', position: 33, isRequired: false, dataType: 'date', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.finance_agreement.first_payment_date', helpText: null },
  { key: 'current_payoff', label: 'Current payoff', groupName: 'GX', position: 34, isRequired: false, dataType: 'currency', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.payoff_letter.payoff_amount', helpText: 'NOT required for READY. Never invent.' },
  { key: 'utility_company_and_bill', label: 'Utility company + bill amount', groupName: 'GX', position: 35, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.utility_bill.utility_name', helpText: 'Utility account is NOT required for READY' },

  { key: 'told_vs_signed', label: 'Told vs signed conflict', groupName: 'OPS', position: 36, isRequired: false, dataType: 'string', sourceType: 'MANUAL', sourcePath: null, helpText: 'Closer hook. Never render to homeowner.' },
  { key: 'legal_hook_flags', label: 'Legal hook flags', groupName: 'OPS', position: 37, isRequired: false, dataType: 'string', sourceType: 'MANUAL', sourcePath: null, helpText: 'Possible only; not advice' },
  { key: 'path', label: 'Path', groupName: 'AUTO', position: 38, isRequired: false, dataType: 'string', sourceType: 'MANUAL', sourcePath: null, helpText: 'SCS closer | Tradebloc/DC Capital | Collection | Recovery' },
  { key: 'fee_trench', label: 'Fee trench', groupName: 'AUTO', position: 39, isRequired: false, dataType: 'string', sourceType: 'MANUAL', sourcePath: null, helpText: '$0–39k | $40–59k | $60k+' },
  { key: 'closeability', label: 'Closeability A/B/C', groupName: 'AUTO', position: 40, isRequired: false, dataType: 'string', sourceType: 'MANUAL', sourcePath: null, helpText: 'A=READY B=callable C=do not Dashboard' },
  { key: 'docs_missing', label: 'Docs missing list', groupName: 'AUTO', position: 41, isRequired: false, dataType: 'string', sourceType: 'MANUAL', sourcePath: null, helpText: null },
  { key: 'dashboard_status', label: 'Dashboard / Strawberry status', groupName: 'OPS', position: 42, isRequired: false, dataType: 'string', sourceType: 'MANUAL', sourcePath: null, helpText: 'NOT STARTED | PAYLOAD READY | STRAWBERRY QUEUED | SUBMITTED | CLOSED' },
]

/** Old 16-field starter map — kept inactive so existing values still have a definition. */
export const LEGACY_FIELDS: FieldSeed[] = [
  { key: 'homeowner_name', label: 'Homeowner name (legacy)', groupName: 'Legacy', position: 0, isRequired: false, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.fullName', helpText: 'Aliased by first_name + last_name', isActive: false },
  { key: 'homeowner_email', label: 'Email address (legacy)', groupName: 'Legacy', position: 1, isRequired: false, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.email', helpText: null, isActive: false },
  { key: 'homeowner_phone', label: 'Phone number (legacy)', groupName: 'Legacy', position: 2, isRequired: false, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.phone', helpText: null, isActive: false },
  { key: 'preferred_language', label: 'Preferred language (legacy)', groupName: 'Legacy', position: 3, isRequired: false, dataType: 'string', sourceType: 'CLIENT_FIELD', sourcePath: 'client.preferredLanguage', helpText: null, isActive: false },
  { key: 'service_address', label: 'Service address (legacy)', groupName: 'Legacy', position: 4, isRequired: false, dataType: 'string', sourceType: 'ADDRESS_FIELD', sourcePath: 'address.full', helpText: null, isActive: false },
  { key: 'utility_account_number', label: 'Utility account number (legacy)', groupName: 'Legacy', position: 5, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.utility_bill.account_number', helpText: 'NOT required for READY', isActive: false },
  { key: 'utility_provider', label: 'Utility provider (legacy)', groupName: 'Legacy', position: 6, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.utility_bill.utility_name', helpText: null, isActive: false },
  { key: 'installer_name', label: 'Installer / seller (legacy)', groupName: 'Legacy', position: 7, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.installer_name', helpText: null, isActive: false },
  { key: 'contract_date', label: 'Contract date (legacy)', groupName: 'Legacy', position: 8, isRequired: false, dataType: 'date', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.contract_date', helpText: null, isActive: false },
  { key: 'system_size_kw', label: 'System size (kW) (legacy)', groupName: 'Legacy', position: 9, isRequired: false, dataType: 'number', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.system_size_kw', helpText: null, isActive: false },
  { key: 'monthly_payment', label: 'Monthly payment (legacy)', groupName: 'Legacy', position: 10, isRequired: false, dataType: 'currency', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.monthly_payment', helpText: null, isActive: false },
  { key: 'term_months_legacy', label: 'Term (months) (legacy)', groupName: 'Legacy', position: 11, isRequired: false, dataType: 'number', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.term_months', helpText: null, isActive: false },
  { key: 'escalator_pct', label: 'Escalator (%) (legacy)', groupName: 'Legacy', position: 12, isRequired: false, dataType: 'number', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.solar_contract.escalator_pct', helpText: null, isActive: false },
  { key: 'financing_lender', label: 'Financing lender (legacy)', groupName: 'Legacy', position: 13, isRequired: false, dataType: 'string', sourceType: 'DOCUMENT_FIELD', sourcePath: 'document.finance_agreement.lender_name', helpText: 'Was MANUAL. Now extracted.', isActive: false },
  { key: 'signed_contract_on_file', label: 'Signed contract on file (legacy)', groupName: 'Legacy', position: 14, isRequired: false, dataType: 'boolean', sourceType: 'MANUAL', sourcePath: null, helpText: null, isActive: false },
  { key: 'communication_evidence_on_file', label: 'Communication evidence on file (legacy)', groupName: 'Legacy', position: 15, isRequired: false, dataType: 'boolean', sourceType: 'MANUAL', sourcePath: null, helpText: null, isActive: false },
]

export const STARTER_FIELDS = SCHEMA_42_FIELDS

export async function seedCys(db: PrismaClient, ctx: SeedContext): Promise<void> {
  for (const field of [...SCHEMA_42_FIELDS, ...LEGACY_FIELDS]) {
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
        isActive: field.isActive ?? true,
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
        isActive: field.isActive ?? true,
      },
    })
  }
}
