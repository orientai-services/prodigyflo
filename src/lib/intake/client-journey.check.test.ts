import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

describe('canonical client journey', () => {
  it('ships the process next to the production map', () => {
    expect(existsSync(join(root, 'docs/CLIENT-JOURNEY.md'))).toBe(true)
    expect(existsSync(join(root, 'docs/CANONICAL.md'))).toBe(true)
    expect(read('docs/CANONICAL.md')).toMatch(/CLIENT-JOURNEY\.md/)
  })

  it('maps packet agreement to solar_contract and loan_or_til to finance_agreement', () => {
    const req = read('src/lib/intake/scs-document-requirements.ts')
    expect(req).toMatch(/sourceType: 'agreement', key: 'solar_contract'/)
    expect(req).toMatch(/sourceType: 'loan_or_til', key: 'finance_agreement'/)
    expect(req).toMatch(/sourceType: 'utility_bill', key: 'utility_bill'/)
    expect(read('src/lib/intake/scs-analysis.test.ts')).toMatch(/federal leasing disclosure page is classified til/)
  })

  it('does not treat deal type loan as a lender PDF', () => {
    const typeFor = read('src/lib/intake/scs-analysis.ts')
    expect(typeFor).toMatch(/source==='loan_or_til'/)
    expect(typeFor).toMatch(/source==='agreement'/)
    expect(typeFor).not.toMatch(/\/\\bloan\\b\|\\btil\\b\|\\bric\\b\|installment\/\.test\(product\)/)
    expect(typeFor).toMatch(/Deal type "loan" is how the system is paid/)
  })

  it('slots agreement/install/ppa/lease before leftover LOAN_KINDS', () => {
    const src = read('src/lib/intake/scs-analysis.ts')
    const financeHint = src.indexOf("source==='loan_or_til'")
    const financeName = src.indexOf('FINANCE_NAME.test(file)')
    const solar = src.indexOf("source==='agreement'")
    const leftoverKinds = src.lastIndexOf('kinds.some(k=>LOAN_KINDS.has(k))')
    expect(financeHint).toBeGreaterThan(-1)
    expect(financeName).toBeGreaterThan(financeHint)
    expect(solar).toBeGreaterThan(financeName)
    expect(leftoverKinds).toBeGreaterThan(solar)
  })

  it('desk still reads a lease extract parked on finance_agreement', () => {
    const facts = read('src/lib/case-facts.ts')
    expect(facts).toMatch(/fact\('finance_agreement', 'term_months'\)/)
    expect(facts).toMatch(/fact\('finance_agreement', 'escalator_pct'\)/)
    expect(facts).toMatch(/fact\('finance_agreement', 'lender_name'\)/)
    expect(facts).toMatch(/fact\('finance_agreement', 'first_payment_date'\)/)
  })

  it('locks JPEG, Spanish TILA, lease+til, and year-one monthly in CLIENT-JOURNEY', () => {
    const doc = read('docs/CLIENT-JOURNEY.md')
    expect(doc).toMatch(/Every page gets a JPEG/)
    expect(doc).toMatch(/TASA PORCENTUAL ANUAL/)
    expect(doc).toMatch(/`lease`\+`til` stays lease/)
    expect(doc).toMatch(/Copy onto `monthly_solar_payment`/)
    expect(doc).toMatch(/upsertIntakeAppointment/)
    expect(doc).toMatch(/Never move a slotted record file to Other/)
    expect(doc).not.toMatch(/\b(William|Jose|Marc|Eric|Edwin|Lloyd)\b/)
  })

  it('paints install filenames on the solar tile before detected finance type', () => {
    const desk = read('src/lib/daily-desk-docs.ts')
    expect(desk).toMatch(/const nameHay = \[input\.fileName, input\.label\]/)
    expect(desk.indexOf('FINANCE_NAME.test(nameHay)')).toBeLessThan(desk.indexOf('matchDocKind(input.detectedType)'))
    expect(desk.indexOf('INSTALL_NAME.test(nameHay)')).toBeLessThan(desk.indexOf('matchDocKind(input.detectedType)'))
    expect(desk).toMatch(/SLOTTED_RECORD_KEYS/)
    const slotTest = read('src/lib/daily-desk-docs.test.ts')
    expect(slotTest).toMatch(/requirementKey: 'permit_records'/)
    expect(slotTest).toMatch(/detectedType: 'other'/)
    expect(slotTest).toMatch(/toBe\('county_permit'\)/)
  })

  it('copies this client’s files after ingest, never inside the lock', () => {
    const apply = read('src/lib/intake/apply.ts')
    expect(apply).toMatch(/runPendingScsDocumentImports\(5, undefined, clientId\)/)
    expect(apply).toMatch(/runPendingScsDocumentExtractions\(5, clientId\)/)
    expect(apply).toMatch(/upsertIntakeAppointment/)
    expect(apply).toMatch(/after\(async\(\)=>\{/)
    expect(apply).toMatch(/No network, document copy or AI runs while the lock is held/)
    const locked = apply.slice(apply.indexOf('async function processInboundLocked'), apply.indexOf('export async function reapplySubmission'))
    expect(locked).not.toMatch(/runPendingScsDocumentImports/)
  })

  it('computes dealer fee as 0.30 of amount financed', () => {
    const fee = read('src/lib/daily-desk-finance.ts')
    expect(fee).toMatch(/export const DEALER_FEE_RATE = 0\.30/)
    expect(fee).toMatch(/Math\.round\(n \* DEALER_FEE_RATE \* 100\) \/ 100/)
  })

  it('does not Anthropic-retry an SCS original', () => {
    const imports = read('src/lib/intake/scs-document-import.ts')
    expect(imports).toMatch(/sourceLeadId:null, sourceAnalysis:\{equals:Prisma\.DbNull\}/)
  })
})
