import 'server-only'
import { db } from '@/lib/db'
import { evaluateReady } from './ready'
import { buildDashboardPayload } from './dashboard'
import { buildStrawberrySkill } from './skill'
import { composeCloserWinBrief, formatCloserWinBrief } from './closer-win'
import { evaluateFloorAudit } from './floor-audit'
import { feeTrench, pathLabel, routePath, trenchLabel } from './route'
import { asRecord, str } from './schema'

function extracted(docs: {
  label: string | null
  fileName: string | null
  requirement: { key: string } | null
  extractions: {
    detectedTypeKey: string | null
    fields: { key: string; value: string | null; correctedValue: string | null }[]
  }[]
}[], typeKey: string, fieldKey: string): string {
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
            take: 1,
            include: { fields: true },
          },
        },
      },
      contracts: { take: 1 },
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

  const product =
    str(answers.product_confirmed) ||
    str(client.contracts[0]?.productType) ||
    str(answers.product_type_guess) ||
    ''
  // Field 27: finance doc first, then statement, then the homeowner guess.
  const lender =
    extracted(docs, 'finance_agreement', 'lender_name') ||
    extracted(docs, 'lender_statement', 'lender_name') ||
    str(answers.lender_confirmed) ||
    str(answers.lender_guess)
  const monthly =
    extracted(docs, 'finance_agreement', 'monthly_payment') ||
    extracted(docs, 'solar_contract', 'monthly_payment') ||
    extracted(docs, 'lender_statement', 'monthly_payment') ||
    str(answers.monthly_guess)

  const ready = evaluateReady({
    first_name: client.firstName,
    last_name: client.lastName,
    phone: client.phone,
    email: client.email,
    property_street: str(answers.property_street) || addr?.line1 || '',
    city: str(answers.city) || addr?.city || '',
    state: str(answers.state) || addr?.state || '',
    zip: str(answers.zip) || addr?.postalCode || '',
    product_confirmed: product,
    lender_confirmed: lender,
    monthly,
    has_contract: hasContract,
    has_finance: hasFinance,
  })

  const path = routePath({
    lender,
    sale_or_refi: str(answers.sale_or_refi),
    has_contract: hasContract || hasFinance,
  })
  const trench = feeTrench(
    extracted(docs, 'finance_agreement', 'amount_financed') || answers.contract_value || answers.monthly_guess,
  )

  const dashFields = {
    'First name': client.firstName,
    'Last name': client.lastName,
    Phone: client.phone,
    Email: client.email,
    'Property street': str(answers.property_street) || addr?.line1 || '',
    City: str(answers.city) || addr?.city || '',
    State: str(answers.state) || addr?.state || '',
    ZIP: str(answers.zip) || addr?.postalCode || '',
    'Mailing same as property': str(answers.mailing_same_as_property) || 'Yes',
    Installer: extracted(docs, 'solar_contract', 'installer_name') || str(answers.installer_guess),
    Lender: lender,
    Product: product,
    'Account or loan #': extracted(docs, 'finance_agreement', 'account_number') || 'MISSING',
    'Original contract value': extracted(docs, 'finance_agreement', 'amount_financed'),
    'Current payoff': extracted(docs, 'payoff_letter', 'payoff_amount') || 'MISSING',
    'Monthly payment': monthly,
    APR: extracted(docs, 'finance_agreement', 'apr') || 'MISSING',
    'Term months': extracted(docs, 'finance_agreement', 'term_months'),
    'Pain type': str(answers.pain_type),
    'Complaint summary': str(answers.pain_narrative),
    'Fee trench': trenchLabel(trench),
    'Assigned path': pathLabel(path),
    'Docs attach order': docs.map((d) => d.fileName || d.label || d.id).join(', '),
  }

  // C files (no instrument / no identity) never hit the CYS Dashboard.
  const payload = ready.closeability === 'C' ? 'BLOCKED: do not Dashboard this file.' : buildDashboardPayload(dashFields)
  const fileId = `${client.lastName}_${client.firstName}_${dashFields.ZIP || 'UNKNOWN'}`
  const win = composeCloserWinBrief({
    firstName: client.firstName,
    lastName: client.lastName,
    city: str(answers.city) || addr?.city || '',
    state: str(answers.state) || addr?.state || '',
    product,
    lender,
    installer: extracted(docs, 'solar_contract', 'installer_name') || str(answers.installer_guess),
    monthly,
    termMonths: extracted(docs, 'finance_agreement', 'term_months') || extracted(docs, 'solar_contract', 'term_months'),
    apr: extracted(docs, 'finance_agreement', 'apr'),
    contractValue: extracted(docs, 'finance_agreement', 'amount_financed'),
    payoff: extracted(docs, 'payoff_letter', 'payoff_amount'),
    signedDate: extracted(docs, 'solar_contract', 'contract_date') || str(client.contracts[0]?.signedAt),
    painType: str(answers.pain_type),
    painNarrative: str(answers.pain_narrative),
    saleOrRefi: str(answers.sale_or_refi),
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

  await db.cysFieldValue.upsert({
    where: { clientId_fieldKey: { clientId, fieldKey: 'closeability' } },
    create: { clientId, fieldKey: 'closeability', value: ready.closeability, status: 'SUGGESTED', sourceLabel: 'packet OS' },
    update: { value: ready.closeability, sourceLabel: 'packet OS' },
  }).catch(() => undefined)

  await db.cysFieldValue.upsert({
    where: { clientId_fieldKey: { clientId, fieldKey: 'dashboard_status' } },
    create: { clientId, fieldKey: 'dashboard_status', value: strawberryStatus, status: 'SUGGESTED', sourceLabel: 'packet OS' },
    update: { value: strawberryStatus, sourceLabel: 'packet OS' },
  }).catch(() => undefined)

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
    solarPacket: Boolean(product || lender || hasContract || hasFinance || str(answers.pain_type)),
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
    create: { clientId, packageJson: json },
    update: { packageJson: json as object },
  })
  await assemblePacket(clientId)
  return { ok: true }
}
