export const SCHEMA_VERSION = 'schema_42.v1'

export type Closeability = 'A' | 'B' | 'C'
export type PacketStatus =
  | 'NOT_STARTED'
  | 'PAYLOAD_READY'
  | 'STRAWBERRY_QUEUED'
  | 'SUBMITTED'
  | 'CLOSED'

/** Strawberry may type only after floor READY + human closer YES. */
export type StrawberryStatus =
  | 'DO NOT RUN'
  | 'HELD FOR CLOSER'
  | 'STRAWBERRY QUEUED'
  | 'SUBMITTED'
  | 'CLOSED'
export type Path = 'scs_closer' | 'tradebloc_dc_capital' | 'collection' | 'recovery'
export type Trench = '0_39' | '40_59' | '60_plus' | 'unknown'

export type Stage1Answers = Record<string, string | number | boolean | null | undefined>

export type DocumentRef = {
  id?: string
  doc_type?: string | null
  original_filename?: string | null
  storage_path?: string
  mime?: string | null
  size_bytes?: number | null
  signed_get_url?: string
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v).trim()
}
