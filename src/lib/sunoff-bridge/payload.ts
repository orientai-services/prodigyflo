import 'server-only'
import { db } from '@/lib/db'
import { resolveCaseFacts } from '@/lib/case-facts'
import { verbatimIntake } from '@/lib/daily-desk-case'
import type { CaseCell } from '@/lib/daily-desk-case-types'
import { classifyDeskKind } from '@/lib/daily-desk-docs'
import { extracted, type ExtractableDoc } from '@/lib/desk-extract'
import { assemblePacket } from '@/lib/packet/data'
import { asRecord, str } from '@/lib/packet/schema'
import { applyQuestionnaireDispositions, mergeQuestionnaire, prefillFromDocuments, prefillQuestionnaire } from '@/lib/final-desk/mapping'
import { QUESTIONNAIRE_NAME, QUESTIONNAIRE_VERSION, type QuestionnaireAnswers } from '@/lib/final-desk/questions'
import { sha256Hex } from './sign'

/**
 * The `pf-handoff/v1` body ProdigyFlo sends to SunOff (docs/CYS_BRIDGE.md
 * §B3.4). Read-only: it loads one Client and one desk lead in an org and
 * shapes them; it never writes. Files never travel inline, only a manifest of
 * signed-GET URLs that the file routes check again.
 *
 * Every FACTS path in FACT_KEYS is always present, as `{ v: null, src: null }`
 * when ProdigyFlo has nothing for it, so SunOff can tell "unknown" from
 * "forgot to send".
 */

export const PAYLOAD_VERSION = 'pf-handoff/v1'
/** SunOff refuses bodies over 512 KB; we stay under it. */
export const PAYLOAD_MAX_BYTES = 512 * 1024
/** SunOff's portal limit: larger files are listed with a skip reason, never offered. */
export const DOC_MAX_BYTES = 25 * 1024 * 1024

export type FactSource = 'pf' | 'pf_verified'
export type FactEntry = { v: unknown; src: FactSource | null }

/** Every FACTS path this payload speaks for (§B3.4 contact, facts and questionnaire tables). */
export const FACT_KEYS = [
  'client.first', 'client.last', 'client.email', 'client.phone', 'client.address', 'client.city', 'client.state', 'client.zip',
  'client.language', 'client.mailing_address', 'client.sole_owner', 'client.contract_names', 'client.property_type',
  'client.age_band', 'client.language_barrier',
  'system.sales_company', 'system.installer', 'system.installer_status', 'system.size_kw', 'system.install_year',
  'system.permit_no', 'system.producing',
  'finance.contract_type', 'finance.finance_company', 'finance.balance', 'finance.apr', 'finance.escalator_pct',
  'finance.term_years', 'finance.monthly', 'finance.payments_made', 'finance.ucc_filed',
  'sale.signed_year', 'sale.signed_where', 'sale.three_day_notice', 'sale.got_copies', 'sale.first_contact',
  'sale.first_contact_other', 'sale.presentation_where', 'sale.presentation_length', 'sale.tactics', 'sale.credit_check',
  'issue.promises', 'issue.promised', 'issue.promised_other', 'issue.misled', 'issue.bill_change', 'issue.told_bill_lower',
  'issue.performance', 'issue.install_problems', 'issue.service_problems', 'issue.complaints_filed', 'issue.selling_home',
  'issue.sale_blocked', 'issue.hardship', 'issue.outcome_wanted', 'issue.main_issue', 'issue.reasons',
  'utility.name', 'utility.account',
] as const
export type FactKey = (typeof FACT_KEYS)[number]

// ─── Questionnaire v14 → FACTS enums ────────────────────────────────────────
// Codes are SunOff's FACTS enums (FACTS_SCHEMA.md addendum 2026-10-07, the
// codes intake_guide.QMAP turns back into CYS q_fields.json options). A label
// missing here is never guessed: it is listed under `questionnaire.unmapped`
// (and, where SunOff has an "other" text, sent there). `null` means "this
// answer sets no FACTS value"; the raw answer still travels in `answers`.

type OneSpec = { kind: 'one'; path: FactKey; codes: Record<string, string | boolean | number | null>; other?: FactKey }
type MultiSpec = { kind: 'multi'; path: FactKey; codes: Record<string, string[]>; first?: boolean; other?: FactKey }
type TextSpec = { kind: 'text'; path: FactKey }
type NumberSpec = { kind: 'number'; path: FactKey; parse: (raw: string) => number | null }
type ContactSpec = { kind: 'contact' }
type PromisesSpec = { kind: 'promises'; path: FactKey }
export type QuestionSpec = OneSpec | MultiSpec | TextSpec | NumberSpec | ContactSpec | PromisesSpec

const YES_NO = { Yes: true, No: false }
const YES_NO_UNSURE = { Yes: 'yes', No: 'no', 'Not sure': 'unsure', Unsure: 'unsure' }

function moneyNumber(raw: string): number | null {
  const n = Number(raw.replace(/[^0-9.]/g, ''))
  return raw.replace(/[^0-9]/g, '') && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}
/** "25 years", "25 years (300 months)", "300 months", "25" → years. */
function termYears(raw: string): number | null {
  const years = raw.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|años?)/i)
  const months = raw.match(/(\d+(?:\.\d+)?)\s*(?:months?|mos?|meses)/i)
  const bare = raw.match(/^\s*(\d+(?:\.\d+)?)\s*$/)
  const n = years ? Number(years[1]) : months ? Math.round((Number(months[1]) / 12) * 10) / 10 : bare ? Number(bare[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}
function year(raw: string): number | null {
  const m = raw.match(/\b(19[89]\d|20[0-4]\d)\b/)
  return m ? Number(m[1]) : null
}

export const QUESTIONNAIRE_MAP: Record<string, QuestionSpec> = {
  legal_name: { kind: 'contact' },
  prop_addr: { kind: 'contact' },
  mail_same: { kind: 'one', path: 'client.mailing_address', codes: { Yes: null, No: null } },
  phone: { kind: 'contact' },
  email: { kind: 'contact' },
  sole_owner: { kind: 'one', path: 'client.sole_owner', codes: YES_NO },
  on_contract: { kind: 'text', path: 'client.contract_names' },
  prop_type: { kind: 'one', path: 'client.property_type', codes: {
    'Single-family home': 'single_family', 'Condo / Townhome': 'condo_townhome', 'Manufactured home': 'manufactured', 'Commercial property': 'commercial',
  } },
  sales_co: { kind: 'text', path: 'system.sales_company' },
  install_co: { kind: 'text', path: 'system.installer' },
  lender: { kind: 'text', path: 'finance.finance_company' },
  agree_type: { kind: 'multi', path: 'finance.contract_type', first: true, codes: {
    Loan: ['loan'], Lease: ['lease'], 'Purchase Agreement': ['purchase'], 'PPA (Power Purchase Agreement)': ['ppa'], 'Cash purchase': ['cash'], 'Warranty Contract': ['warranty'],
  } },
  year_signed: { kind: 'number', path: 'sale.signed_year', parse: year },
  sign_where: { kind: 'one', path: 'sale.signed_where', codes: { "At client's home (door-to-door)": 'home', 'In a business/office': 'office' } },
  notice_3day: { kind: 'one', path: 'sale.three_day_notice', codes: YES_NO_UNSURE },
  got_copies: { kind: 'one', path: 'sale.got_copies', codes: YES_NO },
  first_contact: { kind: 'one', path: 'sale.first_contact', other: 'sale.first_contact_other', codes: {
    'Door-to-door salesperson': 'door', 'Phone call (cold call)': 'cold_call', 'I responded to a mailer or advertisement': 'mailer',
    'Online inquiry I submitted': 'online', 'Referral from friend/family': 'referral', 'Event or home show': 'event', Other: 'other',
  } },
  pres_where: { kind: 'one', path: 'sale.presentation_where', codes: {
    'At my home': 'home', 'At their office/sales center': 'office', 'Online/virtual meeting': 'online', Other: 'other',
  } },
  pres_len: { kind: 'text', path: 'sale.presentation_length' },
  // CYS q19 has no "None": an explicit None sends an empty list (no tactic claimed).
  pressure: { kind: 'multi', path: 'sale.tactics', codes: {
    'Limited-time offer': ['limited_time'], 'Told I had to sign immediately': ['sign_now'],
    "Wouldn't allow me to review contract before signing": ['no_review'], 'Long sales visit / repeated visits or calls': ['long_visit'],
    'Said they were affiliated with utility/city/government': ['utility_affiliation'], None: [],
  } },
  // PF asks "No cost" and "Free" as one option; CYS q20 has both, so both are claimed.
  promises: { kind: 'multi', path: 'issue.promised', other: 'issue.promised_other', codes: {
    '"No cost solar" / "Free solar"': ['no_cost', 'free'], 'Bill will drop significantly': ['bill_drop'],
    '"You won\'t pay the utility again"': ['no_utility_bill'], 'Guaranteed tax credit': ['tax_credit'], 'No lien or UCC filing': ['no_lien'],
    'Buyout available anytime': ['buyout_anytime'], 'Zero maintenance required': ['zero_maintenance'], Other: ['other'], None: [],
  } },
  misled: { kind: 'one', path: 'issue.misled', codes: YES_NO_UNSURE },
  untrue: { kind: 'promises', path: 'issue.promises' },
  mo_pay: { kind: 'number', path: 'finance.monthly', parse: moneyNumber },
  term_yrs: { kind: 'number', path: 'finance.term_years', parse: termYears },
  // FACTS keeps a percentage; "Yes" without a number cannot become one. No = 0 % (CYS q25 "No").
  escalator: { kind: 'one', path: 'finance.escalator_pct', codes: { Yes: null, No: 0, 'Not sure': null } },
  combo_bill: { kind: 'one', path: 'issue.bill_change', codes: {
    'Yes, significantly': 'up_a_lot', 'Yes, slightly': 'up_a_little', 'No, about the same': 'same', 'No, it decreased': 'down',
  } },
  told_lower: { kind: 'one', path: 'issue.told_bill_lower', codes: YES_NO },
  working: { kind: 'one', path: 'system.producing', codes: { Yes: 'yes', No: 'no', 'Never turned on': 'never' } },
  perf: { kind: 'multi', path: 'issue.performance', codes: {
    'System shuts off / inconsistent performance': ['shutoffs'], 'Not meeting performance projections': ['under_projection'],
    'Battery not working (if applicable)': ['battery'], 'None - no issues': ['none'],
  } },
  install: { kind: 'multi', path: 'issue.install_problems', codes: {
    'Roof leaks': ['roof_leak'], 'Structural damage': ['structural'], 'Shading issues': ['shading'], 'Design issues': ['design'],
    'Improper roof penetrations': ['roof_penetrations'], 'Poor electrical work': ['electrical'], 'Failed inspections': ['failed_inspection'],
    'Installation delays': ['delays'], 'None - no issues': ['none'],
  } },
  service: { kind: 'multi', path: 'issue.service_problems', codes: {
    'No response / delayed response': ['no_response'], 'Delayed repairs': ['repair_delay'], 'Billing errors': ['billing_errors'],
    'Broken promises': ['broken_promises'], 'None - no issues': ['none'],
  } },
  // SunOff's q32 reads closed|bankrupt as "Yes" and active as "No"; "out of business" is closed.
  oob: { kind: 'one', path: 'system.installer_status', codes: { Yes: 'closed', No: 'active' } },
  complaints: { kind: 'multi', path: 'issue.complaints_filed', codes: {
    BBB: ['bbb'], 'Attorney General': ['attorney_general'], Utility: ['utility'], 'Finance company': ['finance_company'],
    'FTC Complaint': ['ftc'], None: ['none'],
  } },
  selling: { kind: 'one', path: 'issue.selling_home', codes: YES_NO },
  sale_issue: { kind: 'one', path: 'issue.sale_blocked', codes: YES_NO },
  ucc: { kind: 'one', path: 'finance.ucc_filed', codes: YES_NO_UNSURE },
  age: { kind: 'one', path: 'client.age_band', codes: { 'Under 40': 'under_40', '40-64': '40_64', '65+': '65_plus' } },
  le: { kind: 'one', path: 'client.language_barrier', codes: YES_NO },
  credit_ck: { kind: 'one', path: 'sale.credit_check', codes: YES_NO_UNSURE },
  hardship: { kind: 'multi', path: 'issue.hardship', codes: {
    'Behind on payments': ['behind_payments'], 'Damaged credit': ['credit_damage'], 'No hardship': ['none'],
  } },
  goal: { kind: 'multi', path: 'issue.outcome_wanted', codes: {
    'Cancel the contract entirely': ['cancel'], 'Remove lien': ['remove_lien'], 'Fix the system': ['fix_system'], 'Lower payments': ['lower_payments'],
  } },
}

export type MappedQuestionnaire = {
  facts: Partial<Record<FactKey, unknown>>
  unmapped: { id: string; label: string }[]
}

/** PF v14 answers → FACTS values. Contact questions are left to the contact block. */
export function mapQuestionnaire(answers: Record<string, unknown>): MappedQuestionnaire {
  const facts: Partial<Record<FactKey, unknown>> = {}
  const unmapped: { id: string; label: string }[] = []
  for (const [id, spec] of Object.entries(QUESTIONNAIRE_MAP)) {
    const raw = answers[id]
    if (spec.kind === 'contact') continue
    if (spec.kind === 'text') {
      const v = str(raw).trim()
      if (v) facts[spec.path] = v.slice(0, 500)
    } else if (spec.kind === 'number') {
      const v = str(raw).trim()
      const n = v ? spec.parse(v) : null
      if (n != null) facts[spec.path] = n
      else if (v) unmapped.push({ id, label: v })
    } else if (spec.kind === 'promises') {
      const v = str(raw).trim()
      if (v) facts[spec.path] = [{ what: v.slice(0, 1500) }]
    } else if (spec.kind === 'one') {
      const v = str(raw).trim()
      if (!v) continue
      if (!(v in spec.codes)) {
        unmapped.push({ id, label: v })
        if (spec.other) facts[spec.other] = v.slice(0, 300)
        continue
      }
      const code = spec.codes[v]
      if (code !== null) facts[spec.path] = code
    } else {
      const labels = Array.isArray(raw) ? raw.map((x) => str(x)).filter(Boolean) : []
      if (!labels.length) continue
      const codes: string[] = []
      let answered = false
      for (const label of labels) {
        const hit = spec.codes[label]
        if (!hit) {
          unmapped.push({ id, label })
          if (spec.other) facts[spec.other] = label.slice(0, 300)
          continue
        }
        answered = true
        for (const c of hit) if (!codes.includes(c)) codes.push(c)
      }
      if (!answered) continue
      facts[spec.path] = spec.first ? (codes[0] ?? null) : codes
    }
  }
  return { facts, unmapped }
}

// ─── SCS experience flags → SunOff reason codes ─────────────────────────────
// Only flags with a clear SunOff taxonomy code (case_intel REASONS). The rest
// travel as-is under issue `flags` for SunOff to read, never as reasons.
export const FLAG_REASONS: Record<string, string> = {
  promised_offset: 'zero_bill_promise',
  tax_credit_drop: 'tax_credit_misrep',
  hidden_fee: 'dealer_fee_concealment',
  lien: 'ucc_lien_sale_block',
  installer_gone: 'installer_unreachable',
  warranty: 'warranty_void',
  in_home_sale: 'high_pressure_tactics',
  no_cancel_notice: 'no_cooling_off_notice',
  language_mismatch: 'language_mismatch_docs',
  signer_65_plus: 'elderly_targeting',
  fmv: 'buyout_misrep',
}

// ─── Documents → CYS checklist slots ────────────────────────────────────────
export type CysSlot =
  | 'solar_contract' | 'finance_agreement' | 'ucc_filing' | 'home_ownership' | 'electric_bills'
  | 'solar_production_reports' | 'utility_interconnection' | 'county_permitting' | 'pf_internal' | 'other'

const KIND_SLOT: Record<string, CysSlot> = {
  signed_contract: 'solar_contract',
  finance_agreement: 'finance_agreement',
  lender_statement: 'finance_agreement',
  ucc_lien: 'ucc_filing',
  home_deed: 'home_ownership',
  utility_bill: 'electric_bills',
  production_report: 'solar_production_reports',
  county_permit: 'county_permitting',
}
const INTERCONNECTION = /interconnect|permission[ _-]to[ _-]operate|\bpto\b/i

export function cysSlotFor(input: { kind: string | null; text: string }): CysSlot {
  if (INTERCONNECTION.test(input.text)) return 'utility_interconnection'
  return (input.kind && KIND_SLOT[input.kind]) || 'other'
}

// ─── Builder ────────────────────────────────────────────────────────────────

export type ManifestEntry = { id: string; kind: 'document' | 'packet-review' | 'packet-pitch' }

export type PayloadDocument = {
  id: string
  file_name: string
  mime: string | null
  size: number | null
  sha256: string | null
  category: CysSlot
  cys_slot: CysSlot | null
  url: string | null
  skipped: string | null
}

export type SunoffPayload = {
  version: typeof PAYLOAD_VERSION
  pf_lead_id: string
  pf_client_id: string
  revision: string
  purpose: 'handoff' | 'open'
  rep: { pf_user_id: string; name: string; email: string }
  contact: {
    first: string; last: string; email: string | null; phone: string | null
    address: { line1: string; line2: string | null; city: string; state: string; zip: string } | null
    language: 'en' | 'es'
  }
  facts: Record<FactKey, FactEntry>
  intake_verbatim: { q: string; a: string }[]
  questionnaire: {
    version: number
    status: 'none' | 'in_progress' | 'completed'
    current_step: number
    answers: QuestionnaireAnswers
    unmapped: { id: string; label: string }[]
  }
  story: { transcript: string | null; transcript_lang: 'en' | 'es'; testimonial: null }
  issue: { main_issue: string | null; reasons: string[]; flags: string[]; theories: string[]; urgency: string | null }
  dates: {
    contract_signed_at: string | null; first_payment: string | null; in_service: string | null
    intake_received_at: string | null; lead_created_at: string | null; consent_at: string | null
  }
  appointment: { starts_at: string; ends_at: string; type: string; timezone: string } | null
  documents: PayloadDocument[]
  internal: {
    brief: { content: unknown; approved: boolean; generated_at: string } | null
    rights: { state: string[]; federal: string[] }
    documents: string[]
  }
  consent: { consent_at: string | null; source: string | null; text_version: string | null; revoked_at: string | null; do_not_call_at: string | null }
  attribution: unknown
}

export function pfLeadId(organizationId: string, leadId: string): string {
  return `pf:${organizationId}:${leadId}`
}

/** JSON with keys sorted at every depth: the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** sha256 of everything except `revision` and `purpose` (an "open" re-send is the same revision). */
export function payloadRevision(payload: Omit<SunoffPayload, 'revision' | 'purpose'> & Partial<Pick<SunoffPayload, 'revision' | 'purpose'>>): string {
  const { revision: _r, purpose: _p, ...rest } = payload
  void _r
  void _p
  return sha256Hex(canonicalJson(rest))
}

export function handoffFileUrl(handoffId: string, entry: ManifestEntry): string {
  return `/api/bridge/sunoff/files/${handoffId}/${entry.kind === 'document' ? entry.id : entry.kind}`
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

function cellOf(cells: CaseCell[], ...labels: string[]): CaseCell | undefined {
  return labels.map((l) => cells.find((c) => c.label === l)).find((c) => c && c.cell.kind === 'value')
}
function cellAmount(cell: CaseCell | undefined): number | null {
  return cell?.cell.kind === 'value' && typeof cell.cell.amount === 'number' ? cell.cell.amount : null
}
function cellNumber(cell: CaseCell | undefined): number | null {
  if (cell?.cell.kind !== 'value') return null
  const n = Number(cell.cell.display.replace(/[^0-9.]/g, ''))
  return cell.cell.display.replace(/[^0-9]/g, '') && Number.isFinite(n) ? n : null
}
function cellText(cell: CaseCell | undefined): string | null {
  return cell?.cell.kind === 'value' ? cell.cell.display : null
}
function srcOf(cell: CaseCell | undefined): FactSource {
  return cell && cell.unverified === false ? 'pf_verified' : 'pf'
}

const PRODUCT_CODE: Record<string, string> = { loan: 'loan', lease: 'lease', ppa: 'ppa', cash: 'cash' }

/**
 * Facts ProdigyFlo resolved from documents and reviewed CYS values. Precedence
 * when the questionnaire also answers: a document-verified fact wins, then the
 * questionnaire, then an unverified document reading.
 */
function documentFacts(finance: CaseCell[], solar: CaseCell[], docs: ExtractableDoc[]): Partial<Record<FactKey, FactEntry>> {
  const out: Partial<Record<FactKey, FactEntry>> = {}
  const put = (key: FactKey, v: unknown, cell?: CaseCell, src?: FactSource) => {
    if (v === null || v === undefined || v === '') return
    out[key] = { v, src: src ?? srcOf(cell) }
  }
  const agreement = cellOf(solar, 'Agreement type')
  put('finance.contract_type', PRODUCT_CODE[cellText(agreement)?.toLowerCase() ?? ''] ?? null, agreement)
  const lender = cellOf(finance, 'Lender')
  put('finance.finance_company', cellText(lender), lender)
  const installer = cellOf(solar, 'Actual installer')
  put('system.installer', cellText(installer), installer)
  const balance = cellOf(finance, 'Remaining balance', 'Estimated remaining balance', 'Total / amount financed')
  put('finance.balance', cellAmount(balance), balance)
  const apr = cellOf(finance, 'Interest rate')
  put('finance.apr', cellAmount(apr), apr)
  const esc = cellOf(finance, 'Annual payment escalation')
  put('finance.escalator_pct', cellAmount(esc), esc)
  const term = cellOf(finance, 'Term years')
  put('finance.term_years', cellNumber(term), term)
  const monthly = cellOf(finance, 'Monthly payment', 'Contract-stated monthly payment')
  put('finance.monthly', cellAmount(monthly), monthly)
  const kw = cellOf(solar, 'System size')
  put('system.size_kw', cellNumber(kw), kw)
  const started = cellOf(finance, 'Actual in-service date', 'First payment date')
  const startYear = cellText(started)?.match(/\b(19[89]\d|20[0-4]\d)\b/)?.[1]
  put('system.install_year', startYear ? Number(startYear) : null, started)
  const months = cellNumber(cellOf(finance, 'Term months'))
  const left = cellNumber(cellOf(finance, 'Months remaining'))
  if (months != null && left != null && months >= left) put('finance.payments_made', months - left, undefined, 'pf')
  put('system.permit_no', extracted(docs, 'county_permit', 'permit_number') || null, undefined, 'pf')
  put('utility.name', extracted(docs, 'utility_bill', 'utility_name') || null, undefined, 'pf')
  put('utility.account', extracted(docs, 'utility_bill', 'account_number') || null, undefined, 'pf')
  return out
}

export type BuildInput = {
  organizationId: string
  clientId: string
  leadId: string
  handoffId: string
  rep: { id: string; name: string; email: string }
  purpose?: 'handoff' | 'open'
}

export type BuiltPayload = {
  payload: SunoffPayload
  revision: string
  manifest: ManifestEntry[]
  bytes: number
}

/** Loads one desk lead + its linked Client inside the org and shapes the hand-off. Null when either is missing. */
export async function buildSunoffPayload(input: BuildInput): Promise<BuiltPayload | null> {
  const [lead, client] = await Promise.all([
    db.callCenterLead.findFirst({
      where: { id: input.leadId, organizationId: input.organizationId },
      select: {
        id: true, createdAt: true, leadAttribution: true, consentAt: true, consentSource: true, consentTextVersion: true,
        consentRevokedAt: true, doNotCallAt: true,
      },
    }),
    db.client.findFirst({
      where: { id: input.clientId, organizationId: input.organizationId, deletedAt: null },
      include: {
        organization: { select: { timezone: true } },
        addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1 },
        surveyResponses: { orderBy: { updatedAt: 'desc' }, include: { survey: { select: { name: true, version: true, schema: true } } } },
        documents: {
          where: { status: { notIn: ['REJECTED', 'EXPIRED'] } },
          orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }],
          include: {
            requirement: { select: { key: true } },
            extractions: {
              orderBy: { createdAt: 'desc' },
              include: { fields: { select: { key: true, value: true, correctedValue: true, verification: true, sourcePage: true } } },
            },
          },
        },
        contracts: { orderBy: { createdAt: 'desc' }, take: 1, select: { productType: true, signedAt: true } },
        appointments: {
          where: { status: { in: ['SCHEDULED', 'CONFIRMED'] }, endsAt: { gt: new Date() } },
          orderBy: { startsAt: 'asc' },
          take: 1,
        },
        cysFieldValues: { where: { status: 'VERIFIED' }, select: { fieldKey: true, value: true, status: true, sourceLabel: true, note: true } },
        intakeSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { rawPayload: true, createdAt: true } },
        closerBriefs: { orderBy: { generatedAt: 'desc' }, take: 1, select: { content: true, generatedAt: true } },
      },
    }),
  ])
  if (!lead || !client) return null

  const intakeResponse = client.surveyResponses.find((r) => r.survey.name !== QUESTIONNAIRE_NAME)
  const saved = client.surveyResponses.find((r) => r.survey.name === QUESTIONNAIRE_NAME && r.survey.version === QUESTIONNAIRE_VERSION)
  const intakeAnswers = asRecord(intakeResponse?.answers)
  const addr = client.addresses[0]
  const fileDocs = client.documents.filter((d) => Boolean(d.storageKey))

  // The same facts the profile shows (case-facts precedence, documents with a file or not).
  const { finance, solar } = resolveCaseFacts(
    { organization: client.organization, surveyResponses: intakeResponse ? [intakeResponse] : [], addresses: client.addresses, documents: client.documents, contracts: client.contracts },
    { values: client.cysFieldValues },
  )

  // The Final Questionnaire as the profile computes it (prefill → documents → dispositions → saved manual answers).
  const answers = mergeQuestionnaire(
    applyQuestionnaireDispositions(
      prefillFromDocuments(
        prefillQuestionnaire({
          name: `${client.firstName} ${client.lastName}`.trim(),
          phone: client.phone,
          email: client.email,
          address: addr ? [addr.line1, addr.line2, addr.city, addr.state, addr.postalCode].filter(Boolean).join(', ') : '',
          intake: intakeAnswers,
        }),
        client.documents.filter((d) => d.storageKey).map((d) => ({ extractions: d.extractions.filter((e) => e.status === 'COMPLETED') })),
      ),
      asRecord(intakeAnswers._scs_questionnaire_dispositions),
    ),
    asRecord(saved?.answers),
  )
  const mapped = mapQuestionnaire(answers)

  // Contact: the Client record (full phone crosses only here, CYS create_lead needs it).
  const legal = str(answers.legal_name).trim()
  const [legalFirst, ...legalRest] = legal.split(/\s+/)
  const first = (legal && legalRest.length ? legalFirst : '') || client.firstName
  const last = (legal && legalRest.length ? legalRest.join(' ') : '') || client.lastName
  const language: 'en' | 'es' = /^es/i.test(client.preferredLanguage) ? 'es' : 'en'
  const contact: SunoffPayload['contact'] = {
    first,
    last,
    email: client.email || null,
    phone: client.phone || null,
    address: addr ? { line1: addr.line1, line2: addr.line2 ?? null, city: addr.city, state: addr.state, zip: addr.postalCode } : null,
    language,
  }

  // FACTS: every key present; document-verified > questionnaire > unverified document.
  const docFacts = documentFacts(finance, solar, client.documents)
  const facts = Object.fromEntries(FACT_KEYS.map((k) => [k, { v: null, src: null }])) as Record<FactKey, FactEntry>
  const contactFacts: Partial<Record<FactKey, unknown>> = {
    'client.first': contact.first, 'client.last': contact.last, 'client.email': contact.email, 'client.phone': contact.phone,
    'client.address': contact.address ? [contact.address.line1, contact.address.line2].filter(Boolean).join(' ') : str(answers.prop_addr) || null,
    'client.city': contact.address?.city ?? null, 'client.state': contact.address?.state ?? null, 'client.zip': contact.address?.zip ?? null,
    'client.language': language,
  }
  for (const [k, v] of Object.entries(contactFacts)) if (v != null && v !== '') facts[k as FactKey] = { v, src: 'pf' }
  for (const [k, entry] of Object.entries(docFacts)) if (entry && entry.src === 'pf') facts[k as FactKey] = entry
  for (const [k, v] of Object.entries(mapped.facts)) if (v !== undefined) facts[k as FactKey] = { v, src: 'pf' }
  for (const [k, entry] of Object.entries(docFacts)) if (entry && entry.src === 'pf_verified') facts[k as FactKey] = entry
  // A UCC filing on file is a public record: it answers q36 when the homeowner didn't.
  if (facts['finance.ucc_filed'].v == null && fileDocs.some((d) => classifyDeskKind({ requirementKey: d.requirement?.key, detectedType: d.extractions[0]?.detectedTypeKey, label: d.label, fileName: d.fileName, note: d.internalComment })?.key === 'ucc_lien')) {
    facts['finance.ucc_filed'] = { v: 'yes', src: 'pf' }
  }

  // Issue / story from the SCS packet (homeowner's own words) and the closer input.
  const raw = asRecord(asRecord(client.intakeSubmissions[0]?.rawPayload).data)
  const experience = asRecord(raw.experience)
  const flags = [
    ...(Array.isArray(experience.flags) ? experience.flags : []),
    ...(Array.isArray(intakeAnswers.experience_flags) ? intakeAnswers.experience_flags : []),
  ].map((f) => str(f)).filter((f, i, all) => f && all.indexOf(f) === i)
  const reasons = flags.map((f) => FLAG_REASONS[f]).filter((r, i, all): r is string => Boolean(r) && all.indexOf(r) === i)
  const mainIssue = str(intakeAnswers.pain_type) || null
  facts['issue.reasons'] = reasons.length ? { v: reasons, src: 'pf' } : facts['issue.reasons']
  if (mainIssue) facts['issue.main_issue'] = { v: mainIssue, src: 'pf' }
  const transcript = [str(experience.narrative), str(intakeAnswers.narrative), str(intakeAnswers.pain_narrative)]
    .map((t) => t.trim())
    .filter((t, i, all) => t && all.indexOf(t) === i)
    .join('\n\n')

  // Documents: latest file per document (superseded versions drop out), with a CYS slot.
  const superseded = new Set(client.documents.map((d) => d.supersedesId).filter(Boolean))
  const manifest: ManifestEntry[] = []
  const documents: PayloadDocument[] = []
  for (const d of fileDocs) {
    if (superseded.has(d.id)) continue
    const kind = classifyDeskKind({ requirementKey: d.requirement?.key, detectedType: d.extractions[0]?.detectedTypeKey, label: d.label, fileName: d.fileName, note: d.internalComment })
    const slot = cysSlotFor({ kind: kind?.key ?? null, text: [d.requirement?.key, d.label, d.fileName, d.extractions[0]?.detectedTypeKey].filter(Boolean).join(' ') })
    const tooBig = (d.sizeBytes ?? 0) > DOC_MAX_BYTES
    const entry: ManifestEntry = { id: d.id, kind: 'document' }
    if (!tooBig) manifest.push(entry)
    documents.push({
      id: d.id,
      file_name: d.fileName || d.label || 'document',
      mime: d.mimeType,
      size: d.sizeBytes,
      sha256: d.checksum,
      category: slot,
      cys_slot: slot === 'other' ? null : slot,
      url: tooBig ? null : handoffFileUrl(input.handoffId, entry),
      skipped: tooBig ? 'over_25mb' : null,
    })
  }

  // Internal (rep-only in SunOff): brief, rights posture, and the two closer PDFs.
  const packet = await assemblePacket(client.id, { persist: false })
  const internalDocs: string[] = []
  if (packet?.closerInput) {
    for (const kind of ['packet-review', 'packet-pitch'] as const) {
      const entry: ManifestEntry = { id: kind, kind }
      manifest.push(entry)
      internalDocs.push(kind)
      documents.push({
        id: kind,
        file_name: kind === 'packet-review' ? 'Case review.pdf' : 'Closer pitch.pdf',
        mime: 'application/pdf',
        size: null,
        sha256: null,
        category: 'pf_internal',
        cys_slot: null,
        url: handoffFileUrl(input.handoffId, entry),
        skipped: null,
      })
    }
  }
  const brief = client.closerBriefs[0]
  const appt = client.appointments[0]
  const signedYear = client.contracts[0]?.signedAt?.getUTCFullYear()
  if (facts['sale.signed_year'].v == null && signedYear) facts['sale.signed_year'] = { v: signedYear, src: 'pf' }

  const body: Omit<SunoffPayload, 'revision' | 'purpose'> = {
    version: PAYLOAD_VERSION,
    pf_lead_id: pfLeadId(input.organizationId, lead.id),
    pf_client_id: client.id,
    rep: { pf_user_id: input.rep.id, name: input.rep.name, email: input.rep.email },
    contact,
    facts,
    intake_verbatim: verbatimIntake(intakeResponse?.survey.schema, intakeAnswers).map((row) => ({ q: row.question, a: row.answer })),
    questionnaire: {
      version: QUESTIONNAIRE_VERSION,
      status: !saved ? 'none' : saved.status === 'COMPLETED' ? 'completed' : 'in_progress',
      current_step: saved?.currentStep ?? 0,
      answers,
      unmapped: mapped.unmapped,
    },
    story: { transcript: transcript || null, transcript_lang: language, testimonial: null },
    issue: {
      main_issue: mainIssue,
      reasons,
      flags,
      theories: (Array.isArray(experience.theories) ? experience.theories : []).map((t) => str(t)).filter(Boolean),
      urgency: str(experience.urgency) || null,
    },
    dates: {
      contract_signed_at: iso(client.contracts[0]?.signedAt),
      first_payment: cellText(cellOf(finance, 'First payment date')),
      in_service: cellText(cellOf(finance, 'Actual in-service date')),
      intake_received_at: iso(client.intakeSubmissions[0]?.createdAt),
      lead_created_at: iso(lead.createdAt),
      consent_at: iso(lead.consentAt),
    },
    appointment: appt ? { starts_at: appt.startsAt.toISOString(), ends_at: appt.endsAt.toISOString(), type: appt.type, timezone: appt.timezone } : null,
    documents,
    internal: {
      brief: brief ? { content: brief.content, approved: Boolean(asRecord(brief.content).approved), generated_at: brief.generatedAt.toISOString() } : null,
      rights: { state: packet?.closerWin.rights.state ?? [], federal: packet?.closerWin.rights.federal ?? [] },
      documents: internalDocs,
    },
    consent: {
      consent_at: iso(lead.consentAt),
      source: lead.consentSource,
      text_version: lead.consentTextVersion,
      revoked_at: iso(lead.consentRevokedAt),
      do_not_call_at: iso(lead.doNotCallAt),
    },
    attribution: lead.leadAttribution ?? client.leadAttribution ?? null,
  }
  const revision = payloadRevision(body)
  const payload: SunoffPayload = { ...body, revision, purpose: input.purpose ?? 'handoff' }
  return { payload, revision, manifest, bytes: Buffer.byteLength(JSON.stringify(payload)) }
}
