import type { InboundCategory } from '@prisma/client'
import { getPath } from '@/lib/intake/mapping'

/**
 * Classify a connector payload into what actually happened, so the Inbound
 * receiver can organize it (a new contact vs a document-status change vs a
 * pipeline move) instead of treating every delivery as a lead. Pure and
 * side-effect free — the ingest layer records the result, the UI reads it.
 *
 * Classification is intentionally forgiving: connectors send wildly different
 * shapes, so we look at an explicit `event_type`/`type` first, then fall back
 * to which fields are present (a document_status key ⇒ a document event).
 */

export type ClassifiedDocument = {
  externalId: string
  name: string
  status: string
  note: string | null
  url: string | null
}

export type Classified = {
  category: InboundCategory
  eventType: string
  summary: string
  document: ClassifiedDocument | null
}

function str(payload: unknown, ...paths: string[]): string | null {
  for (const p of paths) {
    const v = getPath(payload, p)
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

/** Normalize a free-form event_type/type string to a dotted slug. */
function normalizeType(raw: string): string {
  const t = raw.trim().toLowerCase().replace(/[\s_]+/g, '.').replace(/[^a-z0-9.]/g, '')
  return t || 'event'
}

const DOC_STATUS_KEYS = ['document_status', 'doc_status', 'documentStatus', 'file_status']
const DOC_NAME_KEYS = ['document_name', 'doc_name', 'documentName', 'file_name', 'fileName', 'document']
const CONTACT_ID_KEYS = ['contact_id', 'contactId', 'contact.id']
const STAGE_KEYS = ['stage', 'pipeline_stage', 'opportunity.pipeline_stage', 'pipelineStage']

/** Map a declared event_type/type onto our category, if it names one. */
function categoryFromType(t: string): InboundCategory | null {
  if (/(^|\.)doc|document|file/.test(t)) return 'DOCUMENT'
  if (/(^|\.)opportunit|pipeline|stage|deal/.test(t)) return 'OPPORTUNITY'
  if (/(^|\.)note|comment/.test(t)) return 'NOTE'
  if (/(^|\.)appoint|calendar|booking/.test(t)) return 'APPOINTMENT'
  if (/(^|\.)contact|lead|form|subscriber|person/.test(t)) return 'CONTACT'
  return null
}

export function classifyInbound(payload: unknown): Classified {
  const declared = str(payload, 'event_type', 'type', 'eventType', 'event')
  const declaredType = declared ? normalizeType(declared) : null

  const docStatus = str(payload, ...DOC_STATUS_KEYS)
  const docName = str(payload, ...DOC_NAME_KEYS)
  const stage = str(payload, ...STAGE_KEYS)
  const contactName =
    str(payload, 'full_name', 'name') ??
    ([str(payload, 'first_name', 'firstName', 'contact.first_name'), str(payload, 'last_name', 'lastName', 'contact.last_name')]
      .filter(Boolean)
      .join(' ')
      .trim() ||
      null)

  // Category: an explicit type wins; otherwise infer from present fields.
  let category: InboundCategory = categoryFromType(declaredType ?? '') ?? 'CONTACT'
  if (!declaredType || categoryFromType(declaredType) === null) {
    if (docStatus || (docName && /status|state/i.test(JSON.stringify(payload)))) category = 'DOCUMENT'
    else if (stage) category = 'OPPORTUNITY'
    else category = 'CONTACT'
  }

  // A document payload is a document event even if it declared something else.
  if (docStatus || (docName && docStatus)) category = 'DOCUMENT'

  const eventType =
    declaredType ??
    (category === 'DOCUMENT'
      ? 'document.status'
      : category === 'OPPORTUNITY'
        ? 'opportunity.stage_changed'
        : 'contact.received')

  let document: ClassifiedDocument | null = null
  if (category === 'DOCUMENT') {
    const name = docName ?? 'Document'
    const externalId =
      str(payload, 'document_id', 'doc_id', 'documentId', 'file_id') ?? `${str(payload, ...CONTACT_ID_KEYS) ?? 'doc'}:${name}`
    document = {
      externalId,
      name,
      status: docStatus ?? 'received',
      note: str(payload, 'document_note', 'note', 'comment'),
      url: str(payload, 'document_url', 'file_url', 'url'),
    }
  }

  const summary = buildSummary(category, { contactName, docName, docStatus, stage, eventType })
  return { category, eventType, summary, document }
}

function buildSummary(
  category: InboundCategory,
  parts: { contactName: string | null; docName: string | null; docStatus: string | null; stage: string | null; eventType: string },
): string {
  const who = parts.contactName ? ` for ${parts.contactName}` : ''
  switch (category) {
    case 'DOCUMENT':
      return `Document ${parts.docName ?? ''}${parts.docStatus ? ` → ${parts.docStatus}` : ''}${who}`.replace(/\s+/g, ' ').trim()
    case 'OPPORTUNITY':
      return `Pipeline stage${parts.stage ? ` → ${parts.stage}` : ' changed'}${who}`
    case 'NOTE':
      return `Note added${who}`
    case 'APPOINTMENT':
      return `Appointment update${who}`
    case 'CONTACT':
      return parts.contactName ? `Contact: ${parts.contactName}` : 'New contact received'
    default:
      return parts.eventType
  }
}
