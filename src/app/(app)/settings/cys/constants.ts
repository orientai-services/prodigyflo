export const CYS_DATA_TYPES = ['string', 'number', 'currency', 'date', 'boolean'] as const
export const CYS_SOURCE_TYPES = [
  'CLIENT_FIELD',
  'ADDRESS_FIELD',
  'DOCUMENT_FIELD',
  'SURVEY_FIELD',
  'MANUAL',
] as const

export const SOURCE_TYPE_LABELS: Record<(typeof CYS_SOURCE_TYPES)[number], string> = {
  CLIENT_FIELD: 'Client record',
  ADDRESS_FIELD: 'Service address',
  DOCUMENT_FIELD: 'Document extraction',
  SURVEY_FIELD: 'Survey answer',
  MANUAL: 'Manual entry',
}

export const SOURCE_PATH_HINTS: Record<(typeof CYS_SOURCE_TYPES)[number], string> = {
  CLIENT_FIELD: 'e.g. client.email, client.fullName, client.phone',
  ADDRESS_FIELD: 'e.g. address.full, address.line1, address.postalCode',
  DOCUMENT_FIELD: 'e.g. document.solar_contract.installer_name or document.account_number',
  SURVEY_FIELD: 'e.g. survey.utility_provider',
  MANUAL: 'Not used — staff enter the value in the workspace.',
}
