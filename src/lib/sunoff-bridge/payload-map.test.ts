import { describe, expect, it } from 'vitest'
import { QUESTIONS } from '@/lib/final-desk/questions'
import qFields from './__fixtures__/q_fields.json'
import qmapFixture from './__fixtures__/sunoff_qmap.json'
import { FACT_KEYS, FLAG_REASONS, QUESTIONNAIRE_MAP, canonicalJson, cysSlotFor, mapQuestionnaire } from './payload'

/**
 * docs/CYS_BRIDGE.md §B3.4: the ProdigyFlo Final Questionnaire v14 → SunOff
 * FACTS enum table, tested against SunOff's own files (read-only copies in
 * __fixtures__): the CYS questionnaire options (q_fields.json) and the
 * FACTS → question map SunOff prefills from (intake_guide.QMAP).
 */

type QField = { id: string; type: string; options: string[] | null }
type QSpec = { kind: string; fact: string; codes?: Record<string, number> }
const CYS = new Map((qFields as QField[]).map((q) => [q.id, q]))
const QMAP = (qmapFixture as { qmap: Record<string, QSpec> }).qmap

/** PF v14 follows the CYS questionnaire order 1:1. */
const PF_TO_CYS: Record<string, string> = {
  legal_name: 'q1', prop_addr: 'q2', mail_same: 'q3', phone: 'q4_phone', email: 'q4_email', sole_owner: 'q5', on_contract: 'q6',
  prop_type: 'q7', sales_co: 'q8', install_co: 'q9', lender: 'q10', agree_type: 'q11', year_signed: 'q12', sign_where: 'q13',
  notice_3day: 'q14', got_copies: 'q15', first_contact: 'q16', pres_where: 'q17', pres_len: 'q18', pressure: 'q19', promises: 'q20',
  misled: 'q21', untrue: 'q22', mo_pay: 'q23', term_yrs: 'q24', escalator: 'q25', combo_bill: 'q26', told_lower: 'q27', working: 'q28',
  perf: 'q29', install: 'q30', service: 'q31', oob: 'q32', complaints: 'q33', selling: 'q34', sale_issue: 'q35', ucc: 'q36', age: 'q37',
  le: 'q38', credit_ck: 'q39', hardship: 'q40', goal: 'q41',
}

const clean = (s: string) => s.replace(/["“”]/g, '').replace(/[–—]/g, '-').trim().toLowerCase()

/** What SunOff's intake_guide.answer() would put in CYS for one FACTS value (the subset this table produces). */
function cysAnswer(qid: string, value: unknown): string | string[] | null {
  const spec = QMAP[qid]
  const options = CYS.get(qid)?.options ?? []
  if (spec.kind === 'bool' || qid === 'q5') return value === true ? 'Yes' : value === false ? 'No' : null
  if (spec.kind === 'yn3') return value === 'yes' ? 'Yes' : value === 'no' ? 'No' : value === 'unsure' ? options[2] : null
  if (spec.kind === 'enum') return typeof value === 'string' && spec.codes?.[value] != null ? options[spec.codes[value]] : null
  if (spec.kind === 'multi') {
    const vals = Array.isArray(value) ? value : [value]
    const out = vals.map((c) => (spec.codes?.[String(c)] != null ? options[spec.codes[String(c)]] : null))
    return out.includes(null) ? null : (out as string[])
  }
  if (qid === 'q32') return value === 'closed' || value === 'bankrupt' ? 'Yes' : value === 'active' ? 'No' : null
  if (qid === 'q37') return ({ under_40: options[0], '40_64': options[1], '65_plus': options[2] } as Record<string, string>)[String(value)] ?? null
  if (qid === 'q25') return typeof value === 'number' ? (value > 0 ? 'Yes' : 'No') : null
  return null
}

describe('PF questionnaire v14 → SunOff FACTS enums', () => {
  it('has a spec for every v14 question and every PF id lines up with a CYS question', () => {
    expect(QUESTIONS).toHaveLength(42)
    for (const q of QUESTIONS) {
      expect(QUESTIONNAIRE_MAP[q.id], q.id).toBeDefined()
      expect(CYS.has(PF_TO_CYS[q.id]), q.id).toBe(true)
    }
  })

  it('writes each question to the FACTS path SunOff reads for that CYS question', () => {
    for (const q of QUESTIONS) {
      const spec = QUESTIONNAIRE_MAP[q.id]
      if (spec.kind === 'contact' || q.id === 'mail_same') continue
      expect(spec.path, q.id).toBe(QMAP[PF_TO_CYS[q.id]].fact)
      expect(FACT_KEYS as readonly string[]).toContain(spec.path)
    }
  })

  it('maps every option of every choice question, and the CYS answer matches the PF label', () => {
    for (const q of QUESTIONS.filter((x) => x.o)) {
      const spec = QUESTIONNAIRE_MAP[q.id]
      const qid = PF_TO_CYS[q.id]
      const cysOptions = CYS.get(qid)?.options ?? []
      expect(spec.kind === 'one' || spec.kind === 'multi', q.id).toBe(true)
      if (spec.kind !== 'one' && spec.kind !== 'multi') continue
      for (const label of q.o!) {
        expect(Object.keys(spec.codes), `${q.id}: "${label}"`).toContain(label)
        const mapped = mapQuestionnaire({ [q.id]: q.ty === 'multi' ? [label] : label })
        expect(mapped.unmapped, `${q.id}: "${label}"`).toEqual([])
        const value = spec.kind === 'one' ? spec.codes[label] : spec.codes[label]
        if (value === null) continue // documented: no FACTS value (mail_same, escalator Yes / Not sure)
        if (q.id === 'mail_same') continue
        const sent = mapped.facts[spec.path]
        const answer = cysAnswer(qid, sent)
        if (Array.isArray(value) && value.length === 0) {
          // "None" for tactics / promises: CYS has no None option, so nothing is claimed.
          expect(sent, `${q.id}: "${label}"`).toEqual([])
          continue
        }
        expect(answer, `${q.id}: "${label}" → ${JSON.stringify(sent)}`).not.toBeNull()
        const same = cysOptions.find((o) => clean(o) === clean(label))
        if (same) expect(([] as string[]).concat(answer as string | string[]), `${q.id}: "${label}"`).toEqual([same])
      }
    }
  })

  it('splits PF "No cost / Free solar" into both CYS promises and keeps agreement type as the first choice', () => {
    expect(mapQuestionnaire({ promises: ['"No cost solar" / "Free solar"', 'Other'] }).facts['issue.promised']).toEqual(['no_cost', 'free', 'other'])
    expect(cysAnswer('q20', ['no_cost', 'free'])).toEqual(['No cost solar', 'Free solar'])
    expect(mapQuestionnaire({ agree_type: ['PPA (Power Purchase Agreement)', 'Loan'] }).facts['finance.contract_type']).toBe('ppa')
  })

  it('never guesses: an unknown label is reported, and goes to the "other" text where SunOff has one', () => {
    const m = mapQuestionnaire({ first_contact: 'Instagram ad', prop_type: 'Houseboat', perf: ['Inverter beeps', 'None - no issues'] })
    expect(m.unmapped).toEqual([
      { id: 'prop_type', label: 'Houseboat' },
      { id: 'first_contact', label: 'Instagram ad' },
      { id: 'perf', label: 'Inverter beeps' },
    ])
    expect(m.facts['sale.first_contact_other']).toBe('Instagram ad')
    expect(m.facts['sale.first_contact']).toBeUndefined()
    expect(m.facts['client.property_type']).toBeUndefined()
    expect(m.facts['issue.performance']).toEqual(['none'])
  })

  it('parses money, term and year text the way the CYS questions read them', () => {
    const m = mapQuestionnaire({ mo_pay: '$212.50 / mo', term_yrs: '300 months', year_signed: 'signed in 2021', untrue: 'Said the panels pay for themselves', escalator: 'No' })
    expect(m.facts['finance.monthly']).toBe(212.5)
    expect(m.facts['finance.term_years']).toBe(25)
    expect(m.facts['sale.signed_year']).toBe(2021)
    expect(m.facts['issue.promises']).toEqual([{ what: 'Said the panels pay for themselves' }])
    expect(m.facts['finance.escalator_pct']).toBe(0)
    expect(cysAnswer('q25', 0)).toBe('No')
    expect(mapQuestionnaire({ mo_pay: 'not sure' }).unmapped).toEqual([{ id: 'mo_pay', label: 'not sure' }])
    expect(mapQuestionnaire({ term_yrs: '25 years (300 months)' }).facts['finance.term_years']).toBe(25)
    expect(mapQuestionnaire({ term_yrs: '20' }).facts['finance.term_years']).toBe(20)
  })

  it('maps only SCS flags with a clear SunOff reason code', () => {
    const known = new Set(['zero_bill_promise', 'tax_credit_misrep', 'dealer_fee_concealment', 'ucc_lien_sale_block', 'installer_unreachable', 'warranty_void',
      'high_pressure_tactics', 'no_cooling_off_notice', 'language_mismatch_docs', 'elderly_targeting', 'buyout_misrep'])
    for (const code of Object.values(FLAG_REASONS)) expect(known.has(code), code).toBe(true)
  })

  it('puts documents in CYS checklist slots, internal never in one', () => {
    expect(cysSlotFor({ kind: 'signed_contract', text: 'agreement.pdf' })).toBe('solar_contract')
    expect(cysSlotFor({ kind: 'lender_statement', text: '' })).toBe('finance_agreement')
    expect(cysSlotFor({ kind: 'utility_bill', text: 'NV Energy PTO letter' })).toBe('utility_interconnection')
    expect(cysSlotFor({ kind: 'gov_id', text: 'license.jpg' })).toBe('other')
    expect(cysSlotFor({ kind: null, text: '' })).toBe('other')
  })

  it('hashes the same data the same way whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: null }], c: undefined } })).toBe('{"a":{"d":[2,{"x":null,"y":1}]},"b":1}')
  })
})
