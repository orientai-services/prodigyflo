import { asRecord, str } from '@/lib/packet/schema'
import { DESK_TIMEZONE } from '@/lib/daily-desk'
import { amortize, dealerFeeFromAmount, ppaPaymentSchedule, sourceMoney, sourcePercent, sourceText } from '@/lib/daily-desk-finance'
import { extracted, extractedFact, normalizeProduct, termMonthsFromYears, type ExtractedFact, type ExtractableDoc } from '@/lib/desk-extract'
import type { CaseCell } from '@/lib/daily-desk-case-types'
type Reviewed = { fieldKey: string; value: string | null; status: string; sourceLabel?: string | null; note?: string | null }
export type CaseFactSource = {
  organization: { timezone: string }; surveyResponses: { answers: unknown }[];
  addresses: { line1: string; city: string; state: string; postalCode: string }[];
  documents: ExtractableDoc[]; contracts: { productType: string | null }[];
}
function nestedStr(answers: Record<string, unknown>, group: string, key: string): string { return str(asRecord(answers[group])[key]) }
const CREDIT_BAND_LABEL: Record<string, string> = {
  lt580: 'Below 580',
  '580_669': '580–669',
  '670_739': '670–739',
  '740_plus': '740+',
  unsure: 'Not sure',
}
function creditLabel(raw: string): string {
  if (!raw) return ''
  return CREDIT_BAND_LABEL[raw] ?? CREDIT_BAND_LABEL[raw.replace(/-/g, '_')] ?? raw
}
/** Shared, read-only profile facts. Filters do not reimplement precedence or finance. */
export function resolveCaseFacts(client: CaseFactSource, cys: { values: Reviewed[] } | null, opts?: { now?: Date }) {
  const confirmed = (key: string) => cys?.values.find((value) => value.fieldKey === key && value.status === 'VERIFIED')?.value || ''
  const timezone = client.organization.timezone || DESK_TIMEZONE
  const answers = asRecord(client.surveyResponses[0]?.answers)
  const addr = client.addresses[0]
  const docs = client.documents
  const fact = (type: string, key: string, cysKey?: string, answerKey?: string): ExtractedFact | null => {
    const reviewed = cysKey ? cys?.values.find(value => value.fieldKey === cysKey && value.status === 'VERIFIED') : null
    if (reviewed?.value) return { value: reviewed.value, verified: true, note: [reviewed.sourceLabel || 'Reviewed CYS value', reviewed.note].filter(Boolean).join(' · ') }
    const read = extractedFact(docs, type, key)
    const answer = answerKey ? str(answers[answerKey]) : ''
    return read ?? (answer ? { value: answer, verified: false, note: 'Intake value · not document verified' } : null)
  }
  const typed = (keys: string[]): ExtractedFact | null => {
    for (const key of keys) {
      const value = str(answers[key])
      if (value) return { value, verified: false, note: 'Typed on SCS intake · not document verified' }
    }
    return null
  }
  const productFact = fact('solar_contract', 'product_type', 'product_confirmed', 'product_confirmed')
    ?? fact('finance_agreement', 'product_type')
  const product = normalizeProduct(productFact?productFact.value:str(client.contracts[0]?.productType)||str(answers.product_type_guess))
  const isPpaOrLease = product === 'ppa' || product === 'lease'
  const type = isPpaOrLease ? 'solar_contract' : 'finance_agreement'
  const amountFact = isPpaOrLease
    ? fact('solar_contract', 'cash_price') ?? fact('solar_contract', 'amount_financed') ?? fact('finance_agreement', 'amount_financed')
    : fact('finance_agreement', 'amount_financed', 'contract_value', 'amount_financed')
      ?? fact('solar_contract', 'amount_financed')
  const aprFact = isPpaOrLease ? null : (
    fact('finance_agreement', 'apr', 'apr', 'apr')
    ?? fact('solar_contract', 'apr')
    ?? typed(['interest_rate', 'apr'])
  )
  const inServiceFact = fact('solar_contract', 'in_service_date', 'first_payment_or_install')
  const firstPayFact = isPpaOrLease
    ? inServiceFact
      ?? fact('solar_contract', 'first_payment_date')
      ?? fact('finance_agreement', 'first_payment_date')
      ?? fact('solar_contract', 'customer_signed_date')
      ?? fact('finance_agreement', 'customer_signed_date')
    : fact('completion_cert', 'first_payment_date')
      ?? fact('finance_agreement', 'first_payment_date', 'first_payment_or_install')
      ?? fact('solar_contract', 'first_payment_date')
      ?? fact('finance_agreement', 'customer_signed_date')
      ?? fact('solar_contract', 'customer_signed_date')
  const statementRemaining = fact('lender_statement', 'remaining_balance')
  const remainingFact = statementRemaining ?? fact('finance_agreement', 'remaining_balance') ?? fact('solar_contract', 'remaining_balance')
  const statementInterest = fact('lender_statement', 'interest_paid_to_date')
  const statementMonths = fact('lender_statement', 'months_remaining')
  const statementYears = fact('lender_statement', 'years_remaining')
  const useStatement = Boolean(statementRemaining?.value)
  const termFact = fact(type, 'term_months', 'term_months', 'term_months')
    ?? (isPpaOrLease ? fact('finance_agreement', 'term_months') : fact('solar_contract', 'term_months'))
  const yearsFact = fact(type, 'term_years')
    ?? fact(isPpaOrLease ? 'finance_agreement' : 'solar_contract', 'term_years')
  const term = termFact?.value || termMonthsFromYears(yearsFact?.value || '')
  const termSource = termFact ?? (term && yearsFact ? { ...yearsFact, value: term, note: `${yearsFact.note} · Derived months = stated years × 12` } : null)
  const paymentFact = fact(type, 'monthly_payment', undefined, isPpaOrLease ? undefined : 'monthly_payment')
    ?? (!isPpaOrLease ? fact('finance_agreement', 'first_year_monthly_payment') : null)
    ?? fact('solar_contract', 'monthly_payment')
    ?? fact('solar_contract', 'first_year_monthly_payment')
    ?? typed(['monthly_payment', 'monthly_guess', 'monthly_solar_payment'])
  const firstYearFact = fact('solar_contract', 'first_year_monthly_payment') ?? fact('finance_agreement', 'first_year_monthly_payment')
  const basisFact = fact('solar_contract', 'payment_basis')
  const startFact = fact('solar_contract', 'term_start_basis')
  const escalationFact = fact('solar_contract', 'escalator_pct', isPpaOrLease ? 'apr_or_escalator' : undefined)
    ?? (isPpaOrLease ? fact('finance_agreement', 'escalator_pct') : null)
  const installerFact = fact('solar_contract', 'installer_name') ?? fact('finance_agreement', 'installer_name',undefined,'installer_guess')
  const providerFact = isPpaOrLease
    ? fact('solar_contract', 'contract_counterparty', 'lender_confirmed')
      ?? fact('finance_agreement', 'lender_name')
      ?? fact('finance_agreement', 'contract_counterparty')
    : fact(type, 'lender_name', 'lender_confirmed', 'lender_confirmed')
  const kwFact = fact('proposal', 'system_size_kw') ?? fact('solar_contract', 'system_size_kw') ?? fact('finance_agreement', 'system_size_kw') ?? fact('production_report', 'system_size_kw', undefined, 'system_size_kw')
  const kw = kwFact?.value || ''
  const creditBand =
    str(answers.credit_band) ||
    nestedStr(answers, 'screening', 'credit_band') ||
    nestedStr(answers, 'stage1_answers', 'credit_band') ||
    nestedStr(answers, 'solar', 'credit_band')
  const creditRaw = creditLabel(
    str(answers.credit_score) || str(answers.creditScore) || str(answers.credit) || creditBand,
  )
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
  const start = firstPayFact?.value ? new Date(firstPayFact.value) : null
  const clock = opts?.now ?? new Date()
  const elapsed = start && !Number.isNaN(start.getTime()) ? Math.max(0, (clock.getUTCFullYear() - start.getUTCFullYear()) * 12 + (clock.getUTCMonth() - start.getUTCMonth())) : null
  const monthsLeft = elapsed != null && termNum > 0 ? Math.max(0, termNum - elapsed) : null
  // Loan amortization is never a PPA balance. Client-reviewed SCS values are
  // enough to compute; staff CYS verification is a tag, not a gate.
  const hasLoanInputs = product === 'loan' && Boolean(firstPayFact?.value && term && aprFact?.value && paymentFact?.value)
  const introFact = fact('finance_agreement', 'first_year_monthly_payment')
  const introCountFact = fact('finance_agreement', 'intro_payment_count')
  const amort = amortize({
    firstPayDate: hasLoanInputs ? firstPayFact?.value : '',
    termMonths: term,
    aprPercent: aprFact?.value,
    monthlyPayment: paymentFact?.value,
    principal: amountFact?.value,
    introPayment: introFact?.value,
    introCount: introCountFact?.value,
    now: opts?.now,
  })
  const yearOnePay = Number(String(firstYearFact?.value || paymentFact?.value || '').replace(/[^0-9.]/g, ''))
  const escPct = Number(String(escalationFact?.value || '0').replace(/[^0-9.]/g, ''))
  const ppaSched = isPpaOrLease && yearOnePay > 0 && termNum > 0
    ? ppaPaymentSchedule({ yearOneMonthly: yearOnePay, escalatorPct: Number.isFinite(escPct) ? escPct : 0, termMonths: termNum, monthsElapsed: elapsed ?? 0 })
    : null
  const dealerCell = dealerFeeFromAmount(amountFact?.value || ppaSched?.total || null)
  const dealerHint = dealerCell.kind === 'value'
    ? 'Computed 30% of amount · unverified · staff CYS-verify required'
    : 'Needs total / amount financed'
  const amortHint = hasLoanInputs
    ? (firstPayFact?.note?.toLowerCase().includes('signed') || firstPayFact?.note?.toLowerCase().includes('unverified')
      ? 'Estimate from signing date and contract terms; not a payoff quote'
      : 'Estimate from reviewed loan terms; not a payoff quote')
    : 'Requires reviewed loan terms and a first payment date'
  const finance: CaseCell[] = isPpaOrLease ? [
    amountFact?.value
      ? sourcedCell('Total / amount financed', amountFact, 'money', 'PPA/lease contract value; not a loan principal')
      : { label: 'Total / amount financed', cell: sourceMoney(ppaSched?.total ?? null), hint: 'Sum of scheduled PPA payments; not a loan principal' },
    remainingFact?.value
      ? sourcedCell('Remaining balance', remainingFact, 'money', 'From the contract; not a loan payoff')
      : { label: 'Estimated remaining balance', cell: sourceMoney(ppaSched?.remaining ?? null), hint: 'Remaining scheduled PPA payments with the yearly increase; not loan interest' },
    { label: 'Interest rate', cell: { kind: 'value' as const, display: 'No APR' }, hint: 'PPA/lease has no APR. The yearly increase is Annual Escalator Rate %.' },
    { label: 'Interest paid to date', cell: { kind: 'value' as const, display: '$0.00', amount: 0 }, hint: 'PPA/lease has no loan interest.' },
    sourcedCell('Annual payment escalation', escalationFact, 'percent', 'Annual increase; not loan APR'),
    { label: 'Term years', cell: termYears, hint: termSource?.note, unverified: termSource ? !termSource.verified : undefined },
    sourcedCell('Term months', termSource),
    { label: 'Years remaining', cell: monthsLeft != null ? { kind: 'value' as const, display: (monthsLeft / 12).toFixed(monthsLeft % 12 === 0 ? 0 : 1) } : { kind: 'cannot_compute' as const, missing: ['first payment date and term'] } },
    { label: 'Months remaining', cell: monthsLeft != null ? { kind: 'value' as const, display: String(monthsLeft) } : { kind: 'cannot_compute' as const, missing: ['first payment date and term'] }, hint: 'From confirmed start date and term' },
    sourcedCell('Contract-stated monthly payment', paymentFact, 'money', 'Current payment requires a current statement or explicit dated evidence'),
    sourcedCell('First-year monthly payment', firstYearFact, 'money', 'Contract starting amount; not today’s bill'),
    { label: '30% Dealer Fee', cell: dealerCell, hint: dealerHint, unverified: dealerCell.kind === 'value' },
    sourcedCell('Lender', providerFact),
    sourcedCell('Contract counterparty', providerFact),
    sourcedCell('First payment date', firstPayFact),
    sourcedCell('Payment basis', basisFact),
    sourcedCell('Term starts', startFact),
    sourcedCell('Actual in-service date', inServiceFact),
    sourcedCell('Contract effective date', fact('solar_contract', 'contract_date')),
    sourcedCell('Customer signature date', fact('solar_contract', 'customer_signed_date')),
  ] : [
    sourcedCell('Total / amount financed', amountFact, 'money'),
    remainingFact?.value?sourcedCell('Remaining balance',remainingFact,'money',useStatement?'Documented balance as of its source statement; not an inferred current payoff':'Documented balance; not an inferred current payoff'):{ label: 'Estimated remaining balance', cell: amort.remaining, hint: amortHint },
    sourcedCell('Interest rate', aprFact, 'percent'),
    useStatement && statementInterest?.value
      ? sourcedCell('Interest paid to date', statementInterest, 'money', 'From lender statement; not an amortized estimate')
      : { label: 'Estimated interest paid', cell: amort.interestPaid, hint: amortHint },
    { label: 'Term years', cell: termYears, hint: termSource?.note, unverified: termSource ? !termSource.verified : undefined },
    sourcedCell('Term months', termSource),
    useStatement && (statementYears?.value || statementMonths?.value)
      ? sourcedCell('Years remaining', statementYears ?? (statementMonths ? { ...statementMonths, value: String(Number(statementMonths.value) / 12) } : null), 'text', 'From lender statement')
      : { label: 'Years remaining', cell: amort.yearsRemaining, hint: amortHint },
    useStatement && statementMonths?.value
      ? sourcedCell('Months remaining', statementMonths, 'text', 'From lender statement')
      : { label: 'Months remaining', cell: amort.monthsRemaining, hint: amortHint },
    sourcedCell('Monthly payment', paymentFact, 'money'),
    { label: '30% Dealer Fee', cell: dealerCell, hint: dealerHint, unverified: dealerCell.kind === 'value' },
    sourcedCell('Lender', providerFact),
    sourcedCell('First payment date', firstPayFact),
  ]

  const utility =
    extracted(docs, 'utility_bill', 'utility_name') || str(answers.utility) || str(answers.utility_name)
  const usage =
    extracted(docs, 'production_report', 'production_kwh') ||
    extracted(docs, 'utility_bill', 'annual_usage_kwh') ||
    extracted(docs, 'utility_bill', 'monthly_usage_kwh') ||
    extracted(docs, 'utility_bill', 'kwh') ||
    str(answers.usage_kwh) ||
    str(answers.annual_usage) ||
    str(answers.annual_usage_kwh) ||
    str(answers.monthly_usage_kwh)
  const utilityBill =
    extracted(docs, 'utility_bill', 'amount_due') ||
    str(answers.monthly_utility_bill)
  const roofHome = [str(answers.yearsAtAddress) && `${answers.yearsAtAddress} years at address`, str(answers.line1) || addr?.line1]
    .filter(Boolean)
    .join(' · ')

  const solar: CaseCell[] = [
    sourcedCell('Agreement type', productFact ? { ...productFact, value: product } : product ? { value: product, verified: false, note: 'Intake / contract record · not document verified' } : null),
    sourcedCell('Actual installer', installerFact),
    {
      label: 'Credit score',
      cell: creditRaw ? { kind: 'value', display: creditRaw } : { kind: 'missing' },
      hint: 'SCS intake only · not a bureau pull',
    },
    {
      label: 'Bankruptcy',
      cell: bankruptcy ? { kind: 'value', display: bankruptcy } : { kind: 'missing' },
    },
    { label: 'System size', cell: kw ? { kind: 'value', display: /kw/i.test(kw) ? kw : `${kw} kW` } : { kind: 'missing' }, hint: kwFact?.note, unverified: kwFact ? !kwFact.verified : undefined },
    { label: 'Utility', cell: sourceText(utility && utilityBill ? `${utility} · ${utilityBill}` : utility || utilityBill) },
    { label: 'Usage', cell: usage ? { kind: 'value', display: /kwh/i.test(usage) ? usage : `${usage} kWh` } : { kind: 'missing' } },
    { label: 'Roof / home', cell: sourceText(roofHome) },
  ]

  return { confirmed, timezone, answers, addr, creditRaw, creditBand, finance, solar }
}
