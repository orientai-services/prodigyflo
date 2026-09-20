import 'server-only'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'
import { loadCaseFile } from '@/lib/daily-desk-case'
import { loadDeskBoard } from '@/lib/daily-desk-data'
import { classifyDeskKind, tileState } from '@/lib/daily-desk-docs'
import { asRecord, str } from '@/lib/packet/schema'
import { DOCUMENT_MODULES, mergeQuestionnaire, prefillQuestionnaire, prefillFromDocuments, profileCells } from './mapping'
import { QUESTIONNAIRE_NAME, QUESTIONNAIRE_VERSION, answerCount } from './questions'
import type { FinalClient, FinalDeskPayload, DeskView } from './types'

export function finalDeskEnabled(): boolean { return process.env.PRODIGYFLO_FINAL_DESK === 'true' }

export async function loadFinalQuestionnaire(user: SessionUser, clientId: string) {
  const client = await db.client.findFirst({
    where: { AND: [clientScope(user), { id: clientId }] },
    select: { firstName: true, lastName: true, phone: true, email: true,
      addresses: { where: { isPrimary: true }, take: 1 },
      documents: { where: { status: { notIn: ['REJECTED', 'EXPIRED'] }, storageKey: { not: null } }, orderBy: { receivedAt: 'desc' }, select: { extractions: { where: { status: 'COMPLETED' }, orderBy: { createdAt: 'desc' }, select: { detectedTypeKey: true, status: true, fields: { select: { key: true, value: true, correctedValue: true, verification: true, sourcePage: true } } } } } },
      surveyResponses: { orderBy: { updatedAt: 'desc' }, include: { survey: { select: { name: true, version: true } } } } },
  })
  if (!client) return null
  const intake = client.surveyResponses.find(r => r.survey.name !== QUESTIONNAIRE_NAME)
  const saved = client.surveyResponses.find(r => r.survey.name === QUESTIONNAIRE_NAME && r.survey.version === QUESTIONNAIRE_VERSION)
  const address = client.addresses[0]
  const prefill = prefillQuestionnaire({ name: `${client.firstName} ${client.lastName}`.trim(), phone: client.phone, email: client.email,
    address: address ? [address.line1, address.line2, address.city, address.state, address.postalCode].filter(Boolean).join(', ') : '', intake: asRecord(intake?.answers) })
  const answers = mergeQuestionnaire(prefillFromDocuments(prefill, client.documents), asRecord(saved?.answers))
  return { answers, page: saved?.currentStep ?? 0, done: saved?.status === 'COMPLETED' && answerCount(answers) === 42,
    revision: Number(asRecord(saved?.answers)._revision ?? 0), responseId: saved?.id ?? null }
}

async function loadFinalClients(user: SessionUser): Promise<FinalClient[]> {
  const rows = await db.client.findMany({ where: clientScope(user), orderBy: [{ lastActivityAt: 'desc' }, { id: 'asc' }],
    select: { id: true, firstName: true, lastName: true, owner: { select: { name: true } }, currentStage: { select: { name: true } },
      addresses: { where: { isPrimary: true }, take: 1, select: { state: true, postalCode: true } },
      appointments: { where: { status: { in: ['SCHEDULED', 'CONFIRMED'] }, startsAt: { gte: new Date() } }, orderBy: { startsAt: 'asc' }, take: 1, select: { startsAt: true, timezone: true } },
      surveyResponses: { orderBy: { updatedAt: 'desc' }, select: { answers: true, survey: { select: { name: true } } } },
      documents: { where: { storageKey: { not: null }, status: { notIn: ['REJECTED', 'EXPIRED'] } },
        select: { id: true, label: true, fileName: true, requirement: { select: { key: true } },
          extractions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, detectedTypeKey: true, fields: { select: { verification: true } } } } } } } })
  return rows.map(c => {
    const source = asRecord(c.surveyResponses.find(r => r.survey.name !== QUESTIONNAIRE_NAME)?.answers)
    const saved = asRecord(c.surveyResponses.find(r => r.survey.name === QUESTIONNAIRE_NAME)?.answers)
    const docs = c.documents.map(d => {
      const e = d.extractions[0], kind = classifyDeskKind({ requirementKey: d.requirement?.key, detectedType: e?.detectedTypeKey, label: d.label, fileName: d.fileName })
      return { id: d.id, key: kind?.key ?? 'other', label: d.fileName || d.label || 'Document', state: tileState({ hasFile: true, extractionStatus: e?.status ?? null, fieldCount: e?.fields.length ?? 0, verifiedCount: e?.fields.filter(f => ['VERIFIED', 'CORRECTED'].includes(f.verification)).length ?? 0 }) }
    })
    const agreement = docs.filter(d => ['finance_agreement', 'signed_contract'].includes(d.key))
    const appt = c.appointments[0]
    return { id: c.id, name: str(saved.legal_name) || `${c.firstName} ${c.lastName}`, state: c.addresses[0]?.state ?? '', zip: c.addresses[0]?.postalCode ?? '',
      stage: c.currentStage.name, owner: c.owner?.name ?? null,
      appointment: appt ? appt.startsAt.toLocaleString('en-US', { timeZone: appt.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : null,
      docs, extraction: !agreement.length ? 'none' : agreement.every(d => d.state === 'verified') ? 'verified' : 'unverified',
      credit: /^\d{3}$/.test(str(source.credit_score)) ? str(source.credit_score) : null }
  })
}

export async function loadFinalDesk(user: SessionUser, view: DeskView, clientId?: string, month?: string): Promise<FinalDeskPayload> {
  if ((view === 'engine' || view === 'users') && user.role !== 'SUPER_ADMIN') throw Error('Forbidden')
  const clients = await loadFinalClients(user)
  const queueCount = clients.filter(c => c.extraction === 'unverified' || (c.extraction === 'none' && c.appointment)).length
  const payload: FinalDeskPayload = { user: { id: user.id, name: user.name, role: user.role as 'SUPER_ADMIN' | 'CLOSER' }, queueCount }
  if (view === 'board') payload.board = await loadDeskBoard(user, month)
  if (['clients', 'queue', 'engine', 'documents', 'submissions'].includes(view)) payload.clients = clients
  if ((view === 'profile' || view === 'questionnaire') && clientId) {
    const [file, questionnaire] = await Promise.all([loadCaseFile(user, clientId), loadFinalQuestionnaire(user, clientId)])
    if (!file || !questionnaire) throw Error('Not found')
    const cells = profileCells(file)
    const docs = DOCUMENT_MODULES.map(([key, label]) => ({ ...file.docs.find(d => d.key === key)!, key, label }))
    payload.file = { ...file, ...cells, docs, docsPresent: docs.filter(d => d.state !== 'missing').length }
    payload.questionnaire = questionnaire
  }
  if (view === 'engine') {
    const decisions = await db.auditEvent.findMany({ where: { organizationId: user.organizationId, action: { in: ['desk.suggestion.accepted', 'desk.suggestion.dismissed'] } }, orderBy: { createdAt: 'desc' }, select: { entityId: true, action: true } })
    payload.suggestions = clients.filter(c => c.extraction === 'unverified' || (c.extraction === 'none' && c.appointment)).map(c => {
      const id = `${c.id}:${c.extraction}:${c.docs.map(d => d.id + d.state).sort().join(',')}`
      const decision = decisions.find(d => d.entityId === id)
      return { id, clientId: c.id, name: c.name, title: c.extraction === 'none' ? 'Booked with empty file' : `${c.owner ? '' : 'Unassigned + '}unverified extraction`,
        body: c.extraction === 'none' ? 'No agreement on file. Request the original document.' : 'Review the document evidence in the Records console before relying on extracted financial values.',
        state: decision?.action.endsWith('accepted') ? 'accepted' : decision ? 'dismissed' : 'open' }
    })
  }
  if (view === 'users') {
    const [staff, invites] = await Promise.all([
      db.user.findMany({ where: { organizationId: user.organizationId, deletedAt: null, role: { key: { in: ['SUPER_ADMIN', 'CLOSER'] } } }, include: { role: true }, orderBy: { name: 'asc' } }),
      db.invite.findMany({ where: { organizationId: user.organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, role: { key: { in: ['SUPER_ADMIN', 'CLOSER'] } } }, include: { role: true } }),
    ])
    payload.staff = [...staff.map(s => ({ id: s.id, name: s.name, email: s.email, role: s.role.key === 'SUPER_ADMIN' ? 'Super Admin' : 'Closer', status: s.isActive ? 'Active' : 'Disabled' })),
      ...invites.map(i => ({ id: i.id, inviteId: i.id, name: i.email ?? 'Single-use invitation', email: i.email ?? '', role: i.role.key === 'SUPER_ADMIN' ? 'Super Admin' : 'Closer', status: 'Invited' }))]
  }
  return payload
}
