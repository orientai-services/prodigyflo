import 'server-only'
import { db } from '@/lib/db'
import { can, clientScope, type SessionUser } from '@/lib/rbac'
import { signedDocumentFileUrl } from '@/lib/storage'
import { assemblePacket } from '@/lib/packet/data'
import { asRecord, str } from '@/lib/packet/schema'
import { resolveForClient } from '@/lib/cys/data'
import { listBriefViews } from '@/lib/ai/closeops-ai'
import { DESK_TIMEZONE, civilDate, timeLabel } from '@/lib/daily-desk'
import { CASE_DOC_KINDS, classifyDeskKind, tileState } from '@/lib/daily-desk-docs'
import { amortize, sourceMoney, sourcePercent, sourceText } from '@/lib/daily-desk-finance'
import { extracted } from '@/lib/desk-extract'
import type { CaseCell, CaseDocTile, CaseFileData } from '@/lib/daily-desk-case-types'

export type { CaseCell, CaseDocTile, CaseFileData } from '@/lib/daily-desk-case-types'

function stringifyAnswer(value: unknown): string {
  if (value == null || value === '') return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((v) => stringifyAnswer(v)).filter(Boolean).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function nestedStr(answers: Record<string, unknown>, group: string, key: string): string {
  return str(asRecord(answers[group])[key])
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
      surveyResponses: {
        orderBy: { updatedAt: 'desc' },
        take: 1,
        include: { survey: { select: { schema: true } } },
      },
      appointments: {
        where: { status: { in: ['SCHEDULED', 'CONFIRMED'] }, startsAt: { gte: new Date() } },
        orderBy: { startsAt: 'asc' },
        take: 1,
      },
      documents: {
        where: can(user, 'documents:read') ? {} : { id: '__none__' },
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
    user.role === 'SUPER_ADMIN' ? db.user.findMany({
      where: { organizationId: user.organizationId, role: { key: 'CLOSER' }, deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }) : Promise.resolve([]),
    assemblePacket(clientId),
    resolveForClient(user, clientId).catch(() => null),
    can(user, 'ai:run') || can(user, 'ai:review') ? listBriefViews(user, clientId, 1) : Promise.resolve([]),
  ])

  const confirmed = (key: string) => cys?.values.find((value) => value.fieldKey === key && value.status === 'VERIFIED')?.value || ''
  const timezone = client.organization.timezone || DESK_TIMEZONE
  const answers = asRecord(client.surveyResponses[0]?.answers)
  const addr = client.addresses[0]
  const docs = client.documents.filter((doc) => !['REJECTED', 'EXPIRED'].includes(doc.status))
  const amt = extracted(docs, 'finance_agreement', 'amount_financed') || str(answers.amount_financed)
  const apr =
    extracted(docs, 'finance_agreement', 'apr') ||
    extracted(docs, 'finance_agreement', 'interest_rate') ||
    str(answers.interest_rate) ||
    str(answers.apr)
  const term = extracted(docs, 'finance_agreement', 'term_months') || str(answers.term_months)
  const pay = extracted(docs, 'finance_agreement', 'monthly_payment') || str(answers.monthly_payment)
  const firstPay = extracted(docs, 'finance_agreement', 'first_payment_date') || str(answers.first_payment_date)
  const dealerFee = extracted(docs, 'finance_agreement', 'dealer_fee') || str(answers.dealer_fee)
  const lender =
    extracted(docs, 'finance_agreement', 'lender_name') || str(answers.lender_confirmed) || str(answers.lender_guess)
  const product =
    str(answers.product_confirmed) || str(client.contracts[0]?.productType) || str(answers.product_type_guess)
  const installer = extracted(docs, 'solar_contract', 'installer_name') || str(answers.installer_guess) || str(answers.counterparty)
  const kw =
    extracted(docs, 'solar_contract', 'system_size_kw') ||
    extracted(docs, 'production_report', 'system_size_kw') ||
    str(answers.system_size_kw)
  const creditBand =
    str(answers.credit_band) ||
    nestedStr(answers, 'screening', 'credit_band') ||
    nestedStr(answers, 'stage1_answers', 'credit_band') ||
    nestedStr(answers, 'solar', 'credit_band')
  const creditRaw =
    creditBand || str(answers.credit_score) || str(answers.creditScore) || str(answers.credit)
  const bankruptcy =
    str(answers.active_bankruptcy) || nestedStr(answers, 'screening', 'active_bankruptcy')
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

  const utility =
    extracted(docs, 'utility_bill', 'utility_name') || str(answers.utility) || str(answers.utility_name)
  const usage =
    extracted(docs, 'production_report', 'production_kwh') ||
    extracted(docs, 'utility_bill', 'kwh') ||
    str(answers.usage_kwh) ||
    str(answers.annual_usage)
  const roofHome = [str(answers.yearsAtAddress) && `${answers.yearsAtAddress} years at address`, str(answers.line1) || addr?.line1]
    .filter(Boolean)
    .join(' · ')

  const solar: CaseCell[] = [
    { label: 'Agreement type', cell: sourceText(product) },
    { label: 'Installer', cell: sourceText(installer) },
    {
      label: creditBand ? 'Credit range' : 'Credit score',
      cell: creditRaw ? { kind: 'value', display: creditRaw } : { kind: 'missing' },
      hint: 'From the solar form · not a bureau pull',
    },
    {
      label: 'Bankruptcy',
      cell: bankruptcy ? { kind: 'value', display: bankruptcy } : { kind: 'missing' },
    },
    { label: 'System size', cell: kw ? { kind: 'value', display: `${kw} kW` } : { kind: 'missing' } },
    { label: 'Utility', cell: sourceText(utility) },
    { label: 'Usage', cell: usage ? { kind: 'value', display: /kwh/i.test(usage) ? usage : `${usage} kWh` } : { kind: 'missing' } },
    { label: 'Roof / home', cell: sourceText(roofHome) },
  ]

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
    const extractFields = fields.filter((field) => field.verification !== 'REJECTED')
      .map((f) => ({ label: f.label || f.key, value: str(f.correctedValue) || str(f.value) }))
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
    facts: win?.fileFacts.join(' ') || 'No packet facts on file yet.',
    vs: win?.redline.find((l) => /vs|promised|quoted|intake/i.test(l)) || win?.redline[0] || 'Intake vs page is not on file yet.',
    state: win?.redline.filter((l) => /state|cooling-off|home-solicitation/i.test(l)).slice(0, 4) || [],
    federal: win?.redline.filter((l) => /TILA|FTC|Holder|E-SIGN|federal/i.test(l)).slice(0, 4) || [],
    blockers: packet?.ready.missing ?? [],
    flag: packet?.closeability === 'C' ? 'Insufficient file' : packet?.ready.ready ? 'Review only' : 'Review only · insufficient file',
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
    appointmentId: appt?.id ?? null,
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
