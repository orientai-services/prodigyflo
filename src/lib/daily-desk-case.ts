import {currentExtractionFields} from '@/lib/desk-extract'
import 'server-only'
import { db } from '@/lib/db'
import { can, clientScope, type SessionUser } from '@/lib/rbac'
import { signedDocumentFileUrl } from '@/lib/storage'
import { assemblePacket } from '@/lib/packet/data'
import { asRecord, str } from '@/lib/packet/schema'
import { resolveForClient } from '@/lib/cys/data'
import { listBriefViews } from '@/lib/ai/closeops-ai'
import { civilDate, timeLabel } from '@/lib/daily-desk'
import { CASE_DOC_KINDS, classifyDeskKind, tileState } from '@/lib/daily-desk-docs'
import { resolveCaseFacts } from '@/lib/case-facts'
import type { CaseDocTile, CaseFileData } from '@/lib/daily-desk-case-types'

export type { CaseCell, CaseDocTile, CaseFileData } from '@/lib/daily-desk-case-types'

function stringifyAnswer(value: unknown): string {
  if (value == null || value === '') return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((v) => stringifyAnswer(v)).filter(Boolean).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export async function loadCaseFile(user: SessionUser, clientId: string): Promise<CaseFileData | null> {
  const client = await db.client.findFirst({
    where: { AND: [clientScope(user), { id: clientId }] },
    include: {
      organization: { select: { timezone: true } },
      currentStage: { select: { name: true } },
      owner: { select: { name: true } },
      leadSource: { select: { name: true } },
      addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1 },
      surveyResponses: { where: { survey: { name: { not: 'ProdigyFlo Final Questionnaire' } } },
        orderBy: { updatedAt: 'desc' },
        take: 1,
        include: { survey: { select: { schema: true } } },
      },
      appointments: {
        where: { status: { in: ['SCHEDULED', 'CONFIRMED'] }, endsAt: { gt: new Date() } },
        orderBy: { startsAt: 'asc' },
        take: 1,
      },
      documents: {
        where: can(user, 'documents:read') ? {} : { id: '__none__' },
        include: {
          requirement: { select: { id: true, key: true, name: true } },
          extractions: {
            orderBy: { createdAt: 'desc' },
            include: {
              fields: {
                select: {
                  key: true,
                  label: true,
                  value: true,
                  correctedValue: true,
                  verification: true,
                  sourcePage: true,
                },
              },
            },
          },
        },
      },
      contracts: { take: 1, select: { productType: true } },
    },
  })
  if (!client) return null

  const [requirements, closers, packet, cys, briefs] = await Promise.all([
    db.documentRequirement.findMany({
      where: { package: { organizationId: user.organizationId } },
      select: { id: true, key: true, name: true },
    }),
    user.role === 'SUPER_ADMIN' ? db.user.findMany({
      where: { organizationId: user.organizationId, role: { key: 'CLOSER' }, deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }) : Promise.resolve([]),
    assemblePacket(clientId),
    resolveForClient(user, clientId).catch(() => null),
    can(user, 'ai:run') || can(user, 'ai:review') ? listBriefViews(user, clientId, 1) : Promise.resolve([]),
  ])

  const { confirmed, timezone, answers, addr, creditRaw, finance, solar } = resolveCaseFacts({ ...client, documents: client.documents.filter(doc => !['REJECTED', 'EXPIRED'].includes(doc.status)) }, cys)
  const docs = client.documents.filter(doc => !['REJECTED', 'EXPIRED'].includes(doc.status))

  const reqByKind = new Map<string, { id: string; key: string }>()
  for (const r of requirements) {
    const kind = classifyDeskKind({ requirementKey: r.key })
    if (kind && !reqByKind.has(kind.key)) reqByKind.set(kind.key, r)
  }

  const orderedDocs = [...docs].sort((a, b) => {
    const ta = a.receivedAt?.getTime() ?? 0
    const tb = b.receivedAt?.getTime() ?? 0
    return tb - ta
  })
  const docsByKind = new Map<string, (typeof docs)[number]>()
  const extrasByKind = new Map<string, string[]>()
  for (const d of orderedDocs) {
    const kind = classifyDeskKind({
      requirementKey: d.requirement?.key,
      detectedType: d.extractions[0]?.detectedTypeKey,
      label: d.label,
      fileName: d.fileName,
    })
    if (!kind) continue
    const prev = docsByKind.get(kind.key)
    if (!prev) {
      docsByKind.set(kind.key, d)
      continue
    }
    if (d.storageKey && !prev.storageKey) {
      extrasByKind.set(kind.key, [...(extrasByKind.get(kind.key) ?? []), prev.fileName || prev.label || 'Document'])
      docsByKind.set(kind.key, d)
      continue
    }
    extrasByKind.set(kind.key, [...(extrasByKind.get(kind.key) ?? []), d.fileName || d.label || 'Document'])
  }

  const tiles: CaseDocTile[] = []
  for (const kind of CASE_DOC_KINDS) {
    const doc = docsByKind.get(kind.key)
    const extras = extrasByKind.get(kind.key) ?? []
    const req = reqByKind.get(kind.key)
    const extraction = doc?.extractions[0]
    const fields = doc?currentExtractionFields(doc.extractions).map(({field})=>field):[]
    const verified = fields.filter((f) => f.verification === 'VERIFIED' || f.verification === 'CORRECTED').length
    const hasFile = Boolean(doc?.storageKey)
    const state = tileState({
      hasFile,
      extractionStatus: extraction?.status ?? null,
      fieldCount: fields.length,
      verifiedCount: verified,
    })
    const fileUrl = doc ? await signedDocumentFileUrl(doc) : null
    const extractFields = fields.filter((field) => field.verification !== 'REJECTED')
      .map((f) => ({ label: f.label || f.key, value: str(f.correctedValue ?? f.value) }))
      .filter((f) => f.value)
    const extraNote = extras.length > 0 ? `Also on file: ${extras.join(', ')}.` : ''
    const verifyNote = verified === fields.length && fields.length > 0 ? 'Verified extract.' : extractFields.length > 0 ? 'Unverified extract.' : ''
    tiles.push({
      key: kind.key,
      files: await Promise.all(client.documents.filter((file) => Boolean(file.storageKey) && classifyDeskKind({ requirementKey: file.requirement?.key, detectedType: file.extractions[0]?.detectedTypeKey, label: file.label, fileName: file.fileName })?.key === kind.key)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(async (file) => ({ id: file.id, label: file.fileName || file.label || kind.label, version: file.version, status: file.status, fileUrl: await signedDocumentFileUrl(file), mimeType: file.mimeType }))),
      label: kind.label,
      state,
      requirementId: req?.id ?? doc?.requirement?.id ?? null,
      documentId: doc?.id ?? null,
      fileUrl,
      mimeType: doc?.mimeType ?? null,
      extract:
        extractFields.length > 0 || extraNote
          ? {
              kicker: extraction?.detectedTypeKey ?? kind.label,
              title: kind.label,
              fields: extractFields,
              note: [verifyNote, extraNote].filter(Boolean).join(' '),
            }
          : null,
    })
  }

  const docsPresent = tiles.filter((t) => t.state !== 'missing').length
  const verifiedTiles = tiles.filter((t) => t.state === 'verified').length
  const extractedTiles = tiles.filter((t) => t.state === 'extracted' || t.state === 'unverified').length
  const extractionLabel =
    verifiedTiles > 0 && extractedTiles === 0 ? 'verified' : extractedTiles > 0 ? 'unverified' : 'none'

  const intake = verbatimIntake(client.surveyResponses[0]?.survey?.schema, answers)
  const latestBrief = briefs[0] ?? null
  const briefApproved = Boolean((latestBrief?.content as { approved?: boolean } | undefined)?.approved)

  const appt = client.appointments[0]
  const appointmentLabel = appt
    ? `${appt.startsAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: timezone })} · ${timeLabel(appt.startsAt, timezone)}`
    : null

  const win = packet?.closerWin
  const redline = {
    state: win?.rights.state ?? [],
    federal: win?.rights.federal ?? [],
  }

  return {
    id: client.id,
    firstName: confirmed('first_name') || client.firstName,
    lastName: confirmed('last_name') || client.lastName,
    city: confirmed('city') || str(answers.city) || addr?.city || '',
    state: confirmed('state') || str(answers.state) || addr?.state || '',
    zip: confirmed('zip') || str(answers.zip) || addr?.postalCode || '',
    source: client.leadSource?.name ?? 'Unknown source',
    stage: client.currentStage.name,
    ownerName: client.owner?.name ?? null,
    appointmentLabel,
    docsPresent,
    extractionLabel,
    creditLabel: creditRaw || 'Credit not on file',
    creditOnFile: Boolean(creditRaw),
    packetReady: Boolean(packet?.floor.floorStampedReady),
    packetMissing: packet?.ready.missing ?? [],
    cysApproved: Boolean(cys?.readiness.approvedAt),
    cysApprovable: (cys?.blockers.length ?? 1) === 0,
    cysBlockers: cys?.blockers ?? [],
    finance,
    solar,
    docs: tiles,
    intake,
    redline,
    callSheet: win?.callSheet ?? null,
    brief: latestBrief
      ? {
          id: latestBrief.id,
          body: latestBrief.content.situation || latestBrief.content.closeTalk || '',
          sur: latestBrief.content.highlights,
          ask: latestBrief.content.recommendedNextStep,
          open: latestBrief.content.closeTalk || latestBrief.content.talkingPoints[0] || '',
          approved: briefApproved,
        }
      : null,
    closers,
    canAssign: can(user, 'clients:reassign'),
    canBook: can(user, 'appointments:manage'),
    canUpload: can(user, 'documents:upload'),
    appointmentUpdatedAt: appt?.updatedAt.toISOString() ?? null, appointmentId: appt?.id ?? null,
    timezone: client.organization.timezone,
    canRequest: can(user, 'documents:request'),
    canBrief: can(user, 'ai:run') || can(user, 'ai:review'),
    bookDate: civilDate(appt?.startsAt ?? new Date(), timezone),
    bookTime: appt ? timeLabel(appt.startsAt, timezone) : '10:00',
  }
}

function verbatimIntake(schema: unknown, answers: Record<string, unknown>): { question: string; answer: string }[] {
  const rows: { question: string; answer: string }[] = []
  const seen = new Set<string>()
  const sections = Array.isArray(schema) ? schema : []
  for (const section of sections) {
    const fields = Array.isArray((section as { fields?: unknown }).fields)
      ? ((section as { fields: { key?: string; label?: string; type?: string }[] }).fields)
      : []
    for (const field of fields) {
      if (!field?.key || field.type === 'consent') continue
      const answer = stringifyAnswer(answers[field.key])
      if (!answer) continue
      seen.add(field.key)
      const reviewed = str(asRecord(asRecord(answers._scs_answer_provenance)[field.key]).source) === 'document_review'
      rows.push({ question: `${field.label || field.key}${reviewed ? ' (confirmed in document review)' : ''}`, answer })
    }
  }
  for (const [key, value] of Object.entries(answers)) {
    if (seen.has(key)) continue
    if (key.startsWith('_')) continue
    if (key.startsWith('consent')) continue
    const answer = stringifyAnswer(value)
    if (!answer) continue
    const reviewed = str(asRecord(asRecord(answers._scs_answer_provenance)[key]).source) === 'document_review'
    rows.push({ question: `${key.replace(/_/g, ' ')}${reviewed ? ' (confirmed in document review)' : ''}`, answer })
  }
  return rows
}
