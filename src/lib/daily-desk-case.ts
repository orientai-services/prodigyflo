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
import { extracted, extractedFact, normalizeProduct, termMonthsFromYears, type ExtractedFact } from '@/lib/desk-extract'
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

  const confirmed = (key: string) => cys?.values.find((value) => value.fieldKey === key && value.status === 'VERIFIED')?.value || ''
  const timezone = client.organization.timezone || DESK_TIMEZONE
  const answers = asRecord(client.surveyResponses[0]?.answers)
  const addr = client.addresses[0]
  const docs = client.documents.filter((doc) => !['REJECTED', 'EXPIRED'].includes(doc.status))
  const fact = (type: string, key: string, cysKey?: string, answerKey?: string): ExtractedFact | null => {
    const reviewed = cysKey ? cys?.values.find(value => value.fieldKey === cysKey && value.status === 'VERIFIED') : null
    if (reviewed?.value) return { value: reviewed.value, verified: true, note: [reviewed.sourceLabel || 'Reviewed CYS value', reviewed.note].filter(Boolean).join(' · ') }
    const read = extractedFact(docs, type, key)
    const answer = answerKey ? str(answers[answerKey]) : ''
    return read ?? (answer ? { value: answer, verified: false, note: 'Intake value · not document verified' } : null)
  }
  const productFact = fact('solar_contract', 'product_type', 'product_confirmed', 'product_confirmed')
    ?? fact('finance_agreement', 'product_type')
  const product = normalizeProduct(productFact?.value || str(client.contracts[0]?.productType) || str(answers.product_type_guess))
  const isPpaOrLease = product === 'ppa' || product === 'lease'
  const type = isPpaOrLease ? 'solar_contract' : 'finance_agreement'
  const amountFact = fact('finance_agreement', 'amount_financed', 'contract_value', 'amount_financed')
  const aprFact = fact('finance_agreement', 'apr', isPpaOrLease ? undefined : 'apr_or_escalator', 'apr')
  const firstPayFact = fact(type, isPpaOrLease ? 'in_service_date' : 'first_payment_date', 'first_payment_or_install')
  const dealerFact = fact('finance_agreement', 'dealer_fee', 'dealer_fee', 'dealer_fee')
  const termFact = fact(type, 'term_months', 'term_months', 'term_months')
  const yearsFact = fact(type, 'term_years')
  const term = termFact?.value || termMonthsFromYears(yearsFact?.value || '')
  const termSource = termFact ?? (term && yearsFact ? { ...yearsFact, value: term, note: `${yearsFact.note} · Derived months = stated years × 12` } : null)
  const paymentFact = fact(type, 'monthly_payment', undefined, isPpaOrLease ? undefined : 'monthly_payment')
  const firstYearFact = fact('solar_contract', 'first_year_monthly_payment')
  const basisFact = fact('solar_contract', 'payment_basis')
  const startFact = fact('solar_contract', 'term_start_basis')
  const escalationFact = fact('solar_contract', 'escalator_pct', isPpaOrLease ? 'apr_or_escalator' : undefined)
  const installerFact = fact('solar_contract', 'installer_name', undefined, 'installer_guess')
  const providerFact = fact(type, 'lender_name', 'lender_confirmed', 'lender_confirmed') ?? (isPpaOrLease ? installerFact : null)
  const kwFact = fact('solar_contract', 'system_size_kw') ?? fact('production_report', 'system_size_kw', undefined, 'system_size_kw')
  const kw = kwFact?.value || ''
  const creditBand =
    str(answers.credit_band) ||
    nestedStr(answers, 'screening', 'credit_band') ||
    nestedStr(answers, 'stage1_answers', 'credit_band') ||
    nestedStr(answers, 'solar', 'credit_band')
  const creditRaw =
    creditBand || str(answers.credit_score) || str(answers.creditScore) || str(answers.credit)
  const bankruptcy =
    str(answers.active_bankruptcy) || nestedStr(answers, 'screening', 'active_bankruptcy')
  const sourcedCell = (label: string, source: ExtractedFact | null, kind: 'money' | 'percent' | 'text' = 'text', hint?: string): CaseCell => ({
    label,
    cell: kind === 'money' ? sourceMoney(source?.value) : kind === 'percent' ? sourcePercent(source?.value) : sourceText(source?.value),
    hint: [hint, source?.note].filter(Boolean).join(' · ') || undefined,
    unverified: source ? !source.verified : undefined,
  })
  const termNum = Number(String(term).replace(/[^0-9.]/g, ''))
  const termYears = Number.isFinite(termNum) && termNum > 0 ? { kind: 'value' as const, display: (termNum / 12).toFixed(termNum % 12 === 0 ? 0 : 1) } : { kind: 'missing' as const }
  // Loan amortization is never a PPA balance, and suggestions cannot generate a
  // financial estimate before the reviewer has checked the source inputs.
  const reviewedLoan = product === 'loan' && [firstPayFact, termSource, aprFact, paymentFact].every(source => source?.verified)
  const amort = amortize({ firstPayDate: reviewedLoan ? firstPayFact?.value : '', termMonths: term, aprPercent: aprFact?.value, monthlyPayment: paymentFact?.value })
  const amortHint = reviewedLoan ? 'Estimate from reviewed loan terms; not a payoff quote' : 'Requires reviewed loan terms and an actual first payment date'
  const finance: CaseCell[] = isPpaOrLease ? [
    sourcedCell('Contract counterparty', providerFact),
    sourcedCell('First-year monthly payment', firstYearFact, 'money', 'Contract starting amount; not today’s bill'),
    sourcedCell('Contract-stated monthly payment', paymentFact, 'money', 'Current payment requires a current statement or explicit dated evidence'),
    sourcedCell('Payment basis', basisFact),
    sourcedCell('Annual payment escalation', escalationFact, 'percent', 'Annual increase; not loan APR'),
    { label: 'Term years', cell: termYears, hint: termSource?.note, unverified: termSource ? !termSource.verified : undefined },
    sourcedCell('Term months', termSource),
    sourcedCell('Term starts', startFact),
    sourcedCell('Actual in-service date', firstPayFact),
    { label: 'Time remaining', cell: { kind: 'cannot_compute', missing: ['actual in-service date and reviewed term'] }, hint: 'No start date inferred from contract signing' },
    sourcedCell('Contract effective date', fact('solar_contract', 'contract_date')),
    sourcedCell('Customer signature date', fact('solar_contract', 'customer_signed_date')),
  ] : [
    sourcedCell('Total / amount financed', amountFact, 'money'),
    { label: 'Estimated remaining balance', cell: amort.remaining, hint: amortHint },
    sourcedCell('Interest rate', aprFact, 'percent'),
    { label: 'Estimated interest paid', cell: amort.interestPaid, hint: amortHint },
    { label: 'Term years', cell: termYears, hint: termSource?.note, unverified: termSource ? !termSource.verified : undefined },
    sourcedCell('Term months', termSource),
    { label: 'Years remaining', cell: amort.yearsRemaining, hint: amortHint },
    { label: 'Months remaining', cell: amort.monthsRemaining, hint: amortHint },
    sourcedCell('Monthly payment', paymentFact, 'money'),
    sourcedCell('Dealer fee', dealerFact, 'money'),
    sourcedCell('Lender', providerFact),
    sourcedCell('First payment date', firstPayFact),
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
    sourcedCell('Agreement type', productFact ? { ...productFact, value: product } : product ? { value: product, verified: false, note: 'Intake / contract record · not document verified' } : null),
    sourcedCell('Installer / contract counterparty', installerFact),
    {
      label: creditBand ? 'Credit range' : 'Credit score',
      cell: creditRaw ? { kind: 'value', display: creditRaw } : { kind: 'missing' },
      hint: 'From the solar form · not a bureau pull',
    },
    {
      label: 'Bankruptcy',
      cell: bankruptcy ? { kind: 'value', display: bankruptcy } : { kind: 'missing' },
    },
    { label: 'System size', cell: kw ? { kind: 'value', display: /kw/i.test(kw) ? kw : `${kw} kW` } : { kind: 'missing' }, hint: kwFact?.note, unverified: kwFact ? !kwFact.verified : undefined },
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
