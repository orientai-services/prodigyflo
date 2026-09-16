import 'server-only'
import { db } from '@/lib/db'
import { can, clientScope, type SessionUser } from '@/lib/rbac'
import { signedDocumentFileUrl } from '@/lib/storage'
import { assemblePacket } from '@/lib/packet/data'
import { asRecord, str } from '@/lib/packet/schema'
import { resolveForClient } from '@/lib/cys/data'
import { listBriefViews } from '@/lib/ai/closeops-ai'
import { DESK_TIMEZONE, timeLabel } from '@/lib/daily-desk'
import { CASE_DOC_KINDS, matchDocKind, tileState } from '@/lib/daily-desk-docs'
import { amortize, sourceMoney, sourcePercent, sourceText } from '@/lib/daily-desk-finance'
import type { CaseCell, CaseDocTile, CaseFileData } from '@/lib/daily-desk-case-types'

export type { CaseCell, CaseDocTile, CaseFileData } from '@/lib/daily-desk-case-types'

function extracted(
  docs: {
    requirement: { key: string } | null
    extractions: {
      detectedTypeKey: string | null
      fields: { key: string; value: string | null; correctedValue: string | null }[]
    }[]
  }[],
  typeKey: string,
  fieldKey: string,
): string {
  for (const d of docs) {
    for (const ex of d.extractions) {
      if (str(ex.detectedTypeKey) !== typeKey) continue
      const f = ex.fields.find((x) => x.key === fieldKey)
      const v = str(f?.correctedValue) || str(f?.value)
      if (v) return v
    }
  }
  return ''
}

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
      currentStage: { select: { name: true } },
      owner: { select: { name: true } },
      leadSource: { select: { name: true } },
      addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1 },
      surveyResponses: {
        orderBy: { updatedAt: 'desc' },
        take: 1,
        include: { survey: { select: { schema: true } } },
      },
      appointments: {
        where: { status: { in: ['SCHEDULED', 'CONFIRMED'] } },
        orderBy: { startsAt: 'asc' },
        take: 1,
      },
      documents: {
        where: { status: { notIn: ['REJECTED', 'EXPIRED'] } },
        include: {
          requirement: { select: { id: true, key: true, name: true } },
          extractions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: {
              fields: {
                select: {
                  key: true,
                  label: true,
                  value: true,
                  correctedValue: true,
                  verification: true,
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
    db.user.findMany({
      where: { organizationId: user.organizationId, role: { key: 'CLOSER' }, deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    assemblePacket(clientId),
    resolveForClient(user, clientId).catch(() => null),
    can(user, 'ai:run') || can(user, 'ai:review') ? listBriefViews(user, clientId, 1) : Promise.resolve([]),
  ])

  const answers = asRecord(client.surveyResponses[0]?.answers)
  const addr = client.addresses[0]
  const docs = client.documents
  const amt = extracted(docs, 'finance_agreement', 'amount_financed')
  const apr = extracted(docs, 'finance_agreement', 'apr')
  const term =
    extracted(docs, 'finance_agreement', 'term_months') ||
    extracted(docs, 'solar_contract', 'term_months') ||
    str(answers.termMonths)
  const pay =
    extracted(docs, 'finance_agreement', 'monthly_payment') ||
    extracted(docs, 'solar_contract', 'monthly_payment') ||
    str(answers.monthlyAmount) ||
    str(answers.monthly_guess)
  const firstPay = extracted(docs, 'finance_agreement', 'first_payment_date')
  const dealerFee = extracted(docs, 'finance_agreement', 'dealer_fee')
  const lender = extracted(docs, 'finance_agreement', 'lender_name') || str(answers.lender_confirmed) || str(answers.lender_guess)
  const product =
    str(answers.product_confirmed) || str(client.contracts[0]?.productType) || str(answers.product_type_guess)
  const installer = extracted(docs, 'solar_contract', 'installer_name') || str(answers.installer_guess) || str(answers.counterparty)
  const kw = extracted(docs, 'solar_contract', 'system_size_kw') || extracted(docs, 'production_report', 'system_size_kw')
  const creditRaw = str(answers.credit_score) || str(answers.creditScore) || str(answers.credit)
  const amort = amortize({ firstPayDate: firstPay, termMonths: term, aprPercent: apr, monthlyPayment: pay })
  const termNum = Number(String(term).replace(/[^0-9.]/g, ''))
  const termYears = Number.isFinite(termNum) && termNum > 0 ? { kind: 'value' as const, display: (termNum / 12).toFixed(termNum % 12 === 0 ? 0 : 1) } : { kind: 'missing' as const }

  const finance: CaseCell[] = [
    { label: 'Total / amount financed', cell: sourceMoney(amt) },
    { label: 'Remaining balance', cell: amort.remaining, hint: amort.remaining.kind === 'cannot_compute' ? `Needs ${amort.missing.join(', ')}` : 'Amortization from first-pay date' },
    { label: 'Interest rate', cell: sourcePercent(apr, apr ? '' : '') },
    { label: 'Interest paid to date', cell: amort.interestPaid, hint: amort.interestPaid.kind === 'cannot_compute' ? `Needs ${amort.missing.join(', ')}` : undefined },
    { label: 'Term years', cell: termYears },
    { label: 'Term months', cell: sourceText(term) },
    { label: 'Years remaining', cell: amort.yearsRemaining, hint: amort.yearsRemaining.kind === 'cannot_compute' ? `Needs ${amort.missing.join(', ')}` : undefined },
    { label: 'Months remaining', cell: amort.monthsRemaining, hint: amort.monthsRemaining.kind === 'cannot_compute' ? `Needs ${amort.missing.join(', ')}` : undefined },
    { label: 'Monthly payment', cell: sourceMoney(pay) },
    { label: 'Dealer fee', cell: sourceMoney(dealerFee), hint: dealerFee ? 'Embedded in principal' : undefined },
    { label: 'Lender', cell: sourceText(lender) },
    { label: 'First payment date', cell: sourceText(firstPay) },
  ]

  const solar: CaseCell[] = [
    { label: 'Agreement type', cell: sourceText(product) },
    { label: 'Installer', cell: sourceText(installer) },
    {
      label: 'Credit score',
      cell: creditRaw ? { kind: 'value', display: creditRaw } : { kind: 'missing' },
      hint: 'SCS intake only · not a bureau pull',
    },
    { label: 'System size', cell: kw ? { kind: 'value', display: `${kw} kW` } : { kind: 'missing' } },
  ]

  const reqByKind = new Map<string, { id: string; key: string }>()
  for (const r of requirements) {
    const kind = matchDocKind(r.key)
    if (kind && !reqByKind.has(kind.key)) reqByKind.set(kind.key, r)
  }

  const docsByKind = new Map<string, (typeof docs)[number]>()
  for (const d of docs) {
    const kind =
      matchDocKind(d.requirement?.key) ||
      matchDocKind(d.extractions[0]?.detectedTypeKey) ||
      matchDocKind(d.label)
    if (!kind) continue
    const prev = docsByKind.get(kind.key)
    if (!prev || (d.storageKey && !prev.storageKey)) docsByKind.set(kind.key, d)
  }

  const tiles: CaseDocTile[] = []
  for (const kind of CASE_DOC_KINDS) {
    const doc = docsByKind.get(kind.key)
    const req = reqByKind.get(kind.key)
    const extraction = doc?.extractions[0]
    const fields = extraction?.fields ?? []
    const verified = fields.filter((f) => f.verification === 'VERIFIED' || f.verification === 'CORRECTED').length
    const hasFile = Boolean(doc?.storageKey)
    const state = tileState({
      hasFile,
      extractionStatus: extraction?.status ?? null,
      fieldCount: fields.length,
      verifiedCount: verified,
    })
    const fileUrl = doc ? await signedDocumentFileUrl(doc) : null
    const extractFields = fields
      .map((f) => ({ label: f.label || f.key, value: str(f.correctedValue) || str(f.value) }))
      .filter((f) => f.value)
    tiles.push({
      key: kind.key,
      label: kind.label,
      state,
      requirementId: req?.id ?? doc?.requirement?.id ?? null,
      documentId: doc?.id ?? null,
      fileUrl,
      mimeType: doc?.mimeType ?? null,
      extract:
        extractFields.length > 0
          ? {
              kicker: extraction?.detectedTypeKey ?? kind.label,
              title: kind.label,
              fields: extractFields,
              note: verified === fields.length && fields.length > 0 ? 'Verified extract.' : 'Unverified extract.',
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
    ? `${appt.startsAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${timeLabel(appt.startsAt, appt.timezone || DESK_TIMEZONE)}`
    : null

  const win = packet?.closerWin
  const redline = {
    facts: win?.fileFacts.join(' ') || 'No packet facts on file yet.',
    vs: win?.redline.find((l) => /vs|promised|quoted|intake/i.test(l)) || win?.redline[0] || 'Intake vs page is not on file yet.',
    state: win?.redline.filter((l) => /state|cooling-off|home-solicitation/i.test(l)).slice(0, 4) || [],
    federal: win?.redline.filter((l) => /TILA|FTC|Holder|E-SIGN|federal/i.test(l)).slice(0, 4) || [],
    blockers: packet?.ready.missing ?? [],
    flag: packet?.closeability === 'C' ? 'Insufficient file' : packet?.ready.ready ? 'Review only' : 'Review only · insufficient file',
  }

  return {
    id: client.id,
    firstName: client.firstName,
    lastName: client.lastName,
    city: str(answers.city) || addr?.city || '',
    state: str(answers.state) || addr?.state || '',
    zip: str(answers.zip) || addr?.postalCode || '',
    source: client.leadSource?.name ?? 'Unknown source',
    stage: client.currentStage.name,
    ownerName: client.owner?.name ?? null,
    appointmentLabel,
    docsPresent,
    extractionLabel,
    creditLabel: creditRaw || 'Credit not on file',
    creditOnFile: Boolean(creditRaw),
    packetReady: Boolean(packet?.ready.ready),
    packetMissing: packet?.ready.missing ?? [],
    cysApproved: Boolean(cys?.readiness.approvedAt),
    cysApprovable: (cys?.blockers.length ?? 1) === 0,
    cysBlockers: cys?.blockers ?? [],
    finance,
    solar,
    docs: tiles,
    intake,
    redline,
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
    canRequest: can(user, 'documents:request'),
    canBrief: can(user, 'ai:run') || can(user, 'ai:review'),
    bookDate: appt ? appt.startsAt.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    bookTime: appt ? timeLabel(appt.startsAt, appt.timezone || DESK_TIMEZONE) : '10:00',
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
      rows.push({ question: field.label || field.key, answer })
    }
  }
  for (const [key, value] of Object.entries(answers)) {
    if (seen.has(key)) continue
    if (key.startsWith('consent')) continue
    const answer = stringifyAnswer(value)
    if (!answer) continue
    rows.push({ question: key.replace(/_/g, ' '), answer })
  }
  return rows
}
