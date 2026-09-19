import 'server-only'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { evaluateReady } from './ready'
import { buildDashboardPayload } from './dashboard'
import { buildStrawberrySkill } from './skill'
import { composeCloserWinBrief, formatCloserWinBrief } from './closer-win'
import { evaluateFloorAudit } from './floor-audit'
import { feeTrench, pathLabel, routePath, trenchLabel } from './route'
import { asRecord, str } from './schema'
import { extractedFact, normalizeProduct, termMonthsFromYears, type ExtractableDoc } from '@/lib/desk-extract'

/** Final packets use only reviewed document facts, never raw AI suggestions. */
function extracted(docs: ExtractableDoc[], typeKey: string, fieldKey: string): string {
  const fact = extractedFact(docs, typeKey, fieldKey)
  return fact?.verified ? fact.value : ''
}

export async function assemblePacket(clientId: string) {
  const client = await db.client.findUnique({
    where: { id: clientId },
    include: {
      addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1 },
      surveyResponses: { orderBy: { updatedAt: 'desc' }, take: 1 },
      documents: {
        where: { status: { notIn: ['REJECTED', 'EXPIRED'] } },
        include: {
          requirement: true,
          extractions: {
            where: { status: 'COMPLETED' },
            orderBy: { createdAt: 'desc' },
            include: { fields: true },
          },
        },
      },
      contracts: { take: 1 },
      cysFieldValues: { where: { status: 'VERIFIED', verifiedById: { not: null } } },
    },
  })
  if (!client) return null

  const answers = asRecord(client.surveyResponses[0]?.answers)
  const addr = client.addresses[0]
  const docs = client.documents
  const hasContract = docs.some((d) =>
    /contract|agreement|solar/i.test(`${d.requirement?.key ?? ''} ${d.label ?? ''} ${d.fileName ?? ''}`),
  )
  const hasFinance = docs.some((d) =>
    /finance|loan|til/i.test(`${d.requirement?.key ?? ''} ${d.label ?? ''} ${d.fileName ?? ''}`),
  )

  const confirmed = (key: string) => client.cysFieldValues.find(field => field.fieldKey === key)?.value || ''
  const product = normalizeProduct(confirmed('product_confirmed') || extracted(docs, 'solar_contract', 'product_type') || extracted(docs, 'finance_agreement', 'product_type'))
  const isPpaOrLease = product === 'ppa' || product === 'lease'
  const type = isPpaOrLease ? 'solar_contract' : 'finance_agreement'
  const installer = extracted(docs, 'solar_contract', 'installer_name')
  const lender = confirmed('lender_confirmed') || extracted(docs, type, 'lender_name') || (isPpaOrLease ? installer : extracted(docs, 'lender_statement', 'lender_name'))
  const monthly = extracted(docs, 'lender_statement', 'monthly_payment') || extracted(docs, type, 'monthly_payment') || confirmed('monthly_guess') || str(answers.monthly_guess)
  const firstYearMonthly = isPpaOrLease ? extracted(docs, 'solar_contract', 'first_year_monthly_payment') : ''
  const statedYears = extracted(docs, type, 'term_years')
  const directTerm = confirmed('term_months') || extracted(docs, type, 'term_months')
  const term = directTerm || termMonthsFromYears(statedYears)
  const apr = isPpaOrLease ? '' : confirmed('apr_or_escalator') || extracted(docs, 'finance_agreement', 'apr')
  const escalation = isPpaOrLease ? confirmed('apr_or_escalator') || extracted(docs, 'solar_contract', 'escalator_pct') : ''
  const effectiveDate = extracted(docs, 'solar_contract', 'contract_date')
  const signatureDate = extracted(docs, 'solar_contract', 'customer_signed_date') || str(client.contracts[0]?.signedAt)
  const termNote = !directTerm && term ? `Term months derived from stated years × 12 (${statedYears}).` : ''

  const ready = evaluateReady({
    first_name: confirmed('first_name') || client.firstName,
    last_name: confirmed('last_name') || client.lastName,
    phone: confirmed('phone') || client.phone,
    email: confirmed('email') || client.email,
    property_street: (confirmed('property_street') || str(answers.property_street)) || addr?.line1 || '',
    city: (confirmed('city') || str(answers.city)) || addr?.city || '',
    state: (confirmed('state') || str(answers.state)) || addr?.state || '',
    zip: (confirmed('zip') || str(answers.zip)) || addr?.postalCode || '',
    product_confirmed: product,
    lender_confirmed: lender,
    monthly: monthly || firstYearMonthly,
    has_contract: hasContract,
    has_finance: hasFinance,
  })

  const path = routePath({
    lender,
    sale_or_refi: (confirmed('sale_or_refi') || str(answers.sale_or_refi)),
    has_contract: hasContract || hasFinance,
  })
  const trench = feeTrench(isPpaOrLease ? '' : confirmed('contract_value') || extracted(docs, 'finance_agreement', 'amount_financed'))

  const dashFields = {
    'First name': confirmed('first_name') || client.firstName,
    'Last name': confirmed('last_name') || client.lastName,
    Phone: confirmed('phone') || client.phone,
    Email: confirmed('email') || client.email,
    'Property street': (confirmed('property_street') || str(answers.property_street)) || addr?.line1 || '',
    City: (confirmed('city') || str(answers.city)) || addr?.city || '',
    State: (confirmed('state') || str(answers.state)) || addr?.state || '',
    ZIP: (confirmed('zip') || str(answers.zip)) || addr?.postalCode || '',
    'Mailing same as property': confirmed('mailing_same_as_property') || str(answers.mailing_same_as_property),
    Installer: installer,
    Lender: lender,
    Product: product,
    'Account or loan #': isPpaOrLease ? 'Not a loan' : confirmed('account_number') || extracted(docs, 'finance_agreement', 'account_number') || 'MISSING',
    'Original contract value': isPpaOrLease ? '' : confirmed('contract_value') || extracted(docs, 'finance_agreement', 'amount_financed'),
    'Current payoff': confirmed('current_payoff') || extracted(docs, 'payoff_letter', 'payoff_amount') || 'MISSING',
    'Monthly payment': monthly,
    APR: isPpaOrLease ? 'Not applicable to PPA / lease' : apr || 'MISSING',
    'First-year monthly payment': firstYearMonthly,
    'Payment basis': extracted(docs, type, 'payment_basis'),
    'Annual payment escalation': escalation,
    'Contract effective date': effectiveDate,
    'Customer signature date': signatureDate,
    'Actual in-service date': extracted(docs, type, 'in_service_date'),
    'Term starts': extracted(docs, type, 'term_start_basis'),
    'Term months': term,
    'Notes for closer': [termNote, isPpaOrLease ? 'First-year payment is not today’s bill. No loan principal or APR inferred.' : '', 'Only reviewed document facts are included.'].filter(Boolean).join(' '),
    'Pain type': (confirmed('pain_type') || str(answers.pain_type)),
    'Complaint summary': (confirmed('pain_narrative') || str(answers.pain_narrative)),
    'Fee trench': trenchLabel(trench),
    'Assigned path': pathLabel(path),
    'Docs attach order': docs.map((d) => d.fileName || d.label || d.id).join(', '),
  }

  // C files (no instrument / no identity) never hit the CYS Dashboard.
  const payload = ready.closeability === 'C' ? 'BLOCKED: do not Dashboard this file.' : buildDashboardPayload(dashFields)
  const fileId = `${dashFields['Last name']}_${dashFields['First name']}_${dashFields.ZIP || 'UNKNOWN'}`
  const win = composeCloserWinBrief({
    firstName: dashFields['First name'],
    lastName: dashFields['Last name'],
    city: (confirmed('city') || str(answers.city)) || addr?.city || '',
    state: (confirmed('state') || str(answers.state)) || addr?.state || '',
    product,
    lender,
    installer,
    monthly,
    termMonths: term,
    firstYearMonthly,
    escalation,
    paymentBasis: extracted(docs, type, 'payment_basis'),
    termNote,
    effectiveDate,
    apr,
    contractValue: isPpaOrLease ? '' : confirmed('contract_value') || extracted(docs, 'finance_agreement', 'amount_financed'),
    payoff: confirmed('current_payoff') || extracted(docs, 'payoff_letter', 'payoff_amount'),
    signedDate: signatureDate,
    painType: (confirmed('pain_type') || str(answers.pain_type)),
    painNarrative: (confirmed('pain_narrative') || str(answers.pain_narrative)),
    saleOrRefi: (confirmed('sale_or_refi') || str(answers.sale_or_refi)),
    flags: Array.isArray(answers.experience_flags)
      ? (answers.experience_flags as unknown[]).map((f) => String(f))
      : [],
    hasContract,
    hasFinance,
    hasStatement: docs.some((d) => /statement/i.test(`${d.requirement?.key ?? ''} ${d.label ?? ''} ${d.fileName ?? ''}`)),
    hasPayoff: docs.some((d) => /payoff/i.test(`${d.requirement?.key ?? ''} ${d.label ?? ''} ${d.fileName ?? ''}`)),
    hasUtility: docs.some((d) => /utility|bill/i.test(`${d.requirement?.key ?? ''} ${d.label ?? ''} ${d.fileName ?? ''}`)),
    hasProposal: docs.some((d) => /proposal/i.test(`${d.requirement?.key ?? ''} ${d.label ?? ''} ${d.fileName ?? ''}`)),
    closeability: ready.closeability,
    path,
    trench,
    ready: ready.ready,
    missing: ready.missing,
  })
  const brief = formatCloserWinBrief(win)

  const prior = await db.cysReadiness.findUnique({ where: { clientId }, select: { packageJson: true } })
  const priorJson = asRecord(prior?.packageJson)
  const closerApproved = Boolean(priorJson.closer_approved_at)
  const floor = evaluateFloorAudit({
    dataReady: ready.ready,
    closeability: ready.closeability,
    brief,
    closerApproved,
  })

  const skill = floor.strawberryMayRun
    ? buildStrawberrySkill(fileId, payload)
    : `STRAWBERRY: DO NOT RUN. ${floor.holdReason}`

  const packetStatus = floor.packet_status
  const strawberryStatus = floor.strawberry_status

  const packetJson = {
    ...priorJson,
    packet_status: packetStatus,
    closeability: ready.closeability,
    strawberry_status: strawberryStatus,
    ready: floor.floorStampedReady,
    data_ready: ready.ready,
    missing: ready.missing,
    floor_hold: floor.holdReason,
    closer_approved_at: priorJson.closer_approved_at ?? null,
    closer_approved_by: priorJson.closer_approved_by ?? null,
    closer_win_brief: brief,
    audited_at: new Date().toISOString(),
    auditor: 'grok-floor-manager',
  }

  await db.cysReadiness.upsert({
    where: { clientId },
    create: { clientId, packageJson: packetJson },
    update: { packageJson: packetJson },
  })

  // Automatic packet projections must not replace a concurrent staff decision.
  const projectionRows = [['closeability', ready.closeability], ['dashboard_status', strawberryStatus]]
    .map(([key, value]) => Prisma.sql`(${randomUUID()}, ${clientId}, ${key}, ${value}, 'SUGGESTED'::"CysValueStatus", 'packet OS', NOW(), NOW())`)
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "CysFieldValue" (id,"clientId","fieldKey",value,status,"sourceLabel","createdAt","updatedAt") VALUES ${Prisma.join(projectionRows)}
    ON CONFLICT ("clientId","fieldKey") DO UPDATE SET value=EXCLUDED.value,status=EXCLUDED.status,"sourceLabel"=EXCLUDED."sourceLabel","updatedAt"=NOW()
    WHERE NOT ("CysFieldValue".status='VERIFIED' AND "CysFieldValue"."verifiedById" IS NOT NULL)
  `)

  return {
    fileId,
    ready,
    path,
    pathLabel: pathLabel(path),
    trench,
    trenchLabel: trenchLabel(trench),
    payload,
    skill,
    brief,
    packet_status: packetStatus,
    closeability: ready.closeability,
    strawberry_status: strawberryStatus,
    strawberry: floor.strawberryMayRun ? 'RUN' : 'DO NOT RUN',
    floor,
    closerApproved,
    closerWin: win,
    solarPacket: Boolean(product || lender || hasContract || hasFinance || (confirmed('pain_type') || str(answers.pain_type))),
  }
}

/** Human closer YES — the only way Strawberry receives the payload. */
export async function recordCloserYes(
  clientId: string,
  actor: { id: string; name: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const packet = await assemblePacket(clientId)
  if (!packet) return { ok: false, error: 'Client not found.' }
  if (!packet.floor.floorStampedReady) {
    return { ok: false, error: packet.floor.holdReason }
  }
  const prior = await db.cysReadiness.findUnique({ where: { clientId }, select: { packageJson: true } })
  const json = asRecord(prior?.packageJson)
  json.closer_approved_at = new Date().toISOString()
  json.closer_approved_by = actor.id
  json.closer_approved_by_name = actor.name
  await db.cysReadiness.upsert({
    where: { clientId },
    create: { clientId, packageJson: json as object },
    update: { packageJson: json as object },
  })
  await assemblePacket(clientId)
  return { ok: true }
}
