import 'server-only'
import { db } from '@/lib/db'
import { evaluateReady } from './ready'
import { buildDashboardPayload } from './dashboard'
import { buildStrawberrySkill } from './skill'
import { buildPacketBrief } from './brief'
import { feeTrench, pathLabel, routePath, trenchLabel } from './route'
import { asRecord, str } from './schema'

export async function assemblePacket(clientId: string) {
  const client = await db.client.findUnique({
    where: { id: clientId },
    include: {
      addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1 },
      surveyResponses: { orderBy: { updatedAt: 'desc' }, take: 1 },
      documents: { where: { status: { notIn: ['REJECTED', 'EXPIRED'] } }, include: { requirement: true } },
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
    str(answers.product_type_guess) ||
    str(client.contracts[0]?.productType) ||
    ''
  const lender = str(answers.lender_guess)
  const monthly = str(answers.monthly_guess)

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
  const trench = feeTrench(answers.monthly_guess)

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
    Installer: str(answers.installer_guess),
    Lender: lender,
    Product: product,
    'Monthly payment': monthly,
    'Pain type': str(answers.pain_type),
    'Complaint summary': str(answers.pain_narrative),
    'Fee trench': trenchLabel(trench),
    'Assigned path': pathLabel(path),
    'Docs attach order': docs.map((d) => d.fileName || d.label || d.id).join(', '),
  }
  const payload = buildDashboardPayload(dashFields)
  const fileId = `${client.lastName}_${client.firstName}_${dashFields.ZIP || 'UNKNOWN'}`
  const skill = ready.ready ? buildStrawberrySkill(fileId, payload) : 'STRAWBERRY: DO NOT RUN'
  const brief = buildPacketBrief({
    line1: `${client.firstName} ${client.lastName} · ${dashFields.City} · ${lender || 'lender MISSING'} · ${monthly || 'monthly MISSING'} · ${product || 'product MISSING'}`,
    line2: `Raised hand: ${str(answers.pain_type) || 'unspecified'}`,
    line3: `Paperwork: ${hasContract || hasFinance ? 'signed instrument on file or inbound' : 'NO signed instrument'}`,
    line4: `Missing: ${ready.missing.join(', ') || 'none'}`,
    line5: `Path: ${pathLabel(path)}`,
    line6: `Trench ${trenchLabel(trench)} · ${ready.closeability} file`,
    line7: 'Likely objection: need to think about it — anchor one next document or the ask.',
    line8: ready.ready ? 'Ask: walk the packet and book Submit.' : 'Ask: collect the missing items. Do not Dashboard.',
  })

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
    strawberry: ready.ready ? 'RUN' : 'DO NOT RUN',
  }
}
