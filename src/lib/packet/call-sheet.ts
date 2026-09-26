/**
 * Master call sheet + redline poster.
 *
 * Both are built from the packet in front of the closer. A missing fact stays
 * MISSING. Another client's bills, lease numbers, and state statute never leak in.
 * The poster is state and federal consumer rights only.
 */

import type { CloserWinInput } from './closer-win'
import { federalLevers, leverFor, stateLeversForFile, STATE_LEVERS } from './state-levers'

export function lienStatusCopy(state: string | undefined, disclosed: string | undefined): string {
  const code = str(state).trim().toUpperCase()
  const name = code.length === 2 && STATE_LEVERS[code] ? leverFor(code).name : 'this state'
  const quote = str(disclosed)
  if (quote) return `The contract discloses this lien language: ${quote}. A filing number is not added here. Counsel confirms it on the county record and the ${name} UCC registry.`
  return `The contracts on this file do not disclose a UCC lien. That does not mean no filing exists. The county record and the ${name} UCC registry would have to be pulled for this property.`
}
import { partyStatus, PARTY_STATUS_AS_OF } from './party-status'
import { str } from './schema'
import { normalizeProduct } from '@/lib/desk-extract'
import { dealerFeeFromAmount } from '@/lib/daily-desk-finance'

export type CallSheetFact = { label: string; value: string }
export type CallSheetSection = { title: string; say: string; facts: CallSheetFact[] }
export type CallSheetDoc = { item: string; note: string }

export type MasterCallSheet = {
  opening: string
  sections: CallSheetSection[]
  ask: string
  documents: CallSheetDoc[]
  disclaimer: string
}

export type ConsumerRightsPoster = { state: string[]; federal: string[] }

function shown(value: string | undefined): string {
  const s = str(value)
  return s && s.toUpperCase() !== 'MISSING' ? s : 'MISSING'
}

function money(value: string | undefined): string {
  const raw = shown(value)
  if (raw === 'MISSING') return raw
  const n = Number(raw.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(n) || n === 0 && !/\d/.test(raw)) return raw
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function cooling(signedDate: string): 'open' | 'gone' | 'unknown' {
  if (shown(signedDate) === 'MISSING') return 'unknown'
  const d = new Date(signedDate)
  if (Number.isNaN(+d)) return 'unknown'
  const elapsed = Date.now() - d.getTime()
  return elapsed > 5 * 24 * 60 * 60 * 1000 ? 'gone' : elapsed < 0 ? 'unknown' : 'open'
}

function knownState(state: string): boolean {
  const code = state.trim().toUpperCase()
  return code.length === 2 && Boolean(STATE_LEVERS[code])
}

export function consumerRightsPoster(input: CloserWinInput): ConsumerRightsPoster {
  const code = str(input.state).trim().toUpperCase()
  const inHome =
    input.painType === 'signed-on-a-tablet' ||
    input.flags.includes('in_home_sale') ||
    input.flags.includes('no_cancel_notice')
  const saleOrRefi =
    input.painType === 'selling-or-refinancing' || /yes/i.test(input.saleOrRefi) || input.flags.includes('lien')
  const window = cooling(input.signedDate)
  const federal = federalLevers({
    product: input.product,
    hasFinance: input.hasFinance,
    inHomeOrTablet: inHome,
    coolingOffExpired: window === 'gone' ? true : window === 'open' ? false : null,
    saleOrRefi,
  })
  if (!knownState(code)) {
    return {
      state: ['Property state is missing. Do not cite a state consumer statute until the property state is confirmed on this file.'],
      federal,
    }
  }
  const lever = leverFor(code)
  const state = [...stateLeversForFile(code)]
  if (input.flags.includes('tax_credit_drop') || input.flags.includes('hidden_fee')) {
    state.unshift(
      `${lever.udap}: a tax-credit, dealer-fee, or incentive promise that this contract assigns away from the customer, or lists at zero, is a sales-practice fact. Quote only the disclosure on this file. Do not invent a credit amount.`,
    )
  }
  if (input.flags.includes('promised_offset') || input.painType === 'bills-didnt-drop') {
    state.unshift(
      `${lever.udap}: savings or offset claims are measured against this contract and the bills on file. Do not invent a utility rate, a bill amount, or a production number.`,
    )
  }
  return { state, federal }
}

function moneyOnFile(raw: string | undefined): string {
  const shownValue = shown(raw)
  if (shownValue === 'MISSING') return ''
  return money(shownValue)
}

function beforeBill(input: CloserWinInput): string {
  const amount = moneyOnFile(input.utilityMonthly)
  if (!amount) return 'Not on file'
  return input.utilityFromDocument ? `Utility bill on file: ${amount}` : `Electric bill entered in intake: ${amount}`
}

function afterBill(input: CloserWinInput, monthly: string): string {
  const solar = monthly === 'MISSING' ? '' : monthly
  const electric = moneyOnFile(input.utilityMonthly)
  const lines = [
    solar ? `Solar payment: ${solar}` : 'Solar payment is not on this file.',
    input.payingBoth && electric ? `Still paying the electric bill: ${electric}` : '',
  ].filter(Boolean)
  return lines.join(' ')
}

function billSay(input: CloserWinInput, monthly: string): string {
  const before = beforeBill(input)
  const after = afterBill(input, monthly)
  if (before === 'Not on file' && (!monthly || monthly === 'MISSING')) {
    return 'Before and after are not on this file. Do not invent a bill amount or a savings number.'
  }
  return `Before: ${before}. After: ${after}. Do not add a savings number that is not on the bill or in what the client entered.`
}

function statusFact(label: string, name: string): CallSheetFact {
  const found = partyStatus(name)
  return { label, value: found ? `${found.label}: ${found.chip}` : 'Not confirmed' }
}

function changedSay(input: CloserWinInput, installer: string, counterparty: string): string {
  const installerRecord = partyStatus(installer)
  const lenderRecord = partyStatus(counterparty)
  const financierRecord = partyStatus(input.financierOnInstall)
  const named = [installerRecord, lenderRecord, financierRecord && financierRecord !== lenderRecord ? financierRecord : null].filter((item): item is NonNullable<typeof item> => Boolean(item))
  const clientSaidGone = input.flags.includes('installer_gone') || input.painType === 'installer-gone'
  if (!named.length && !clientSaidGone) {
    return 'No servicer change or warrantor failure is confirmed on this file. Do not invent a bankruptcy, a successor, or a warranty gap.'
  }
  const lines = [
    `Company status is from the court registry checked ${PARTY_STATUS_AS_OF}. It is not a line copied from this client's PDF.`,
    clientSaidGone ? 'The client also said the installer is gone or unresponsive.' : '',
    ...named.map(item => item.record),
  ]
  return lines.filter(Boolean).join(' ')
}

function changedFacts(input: CloserWinInput, installer: string, counterparty: string): CallSheetFact[] {
  const facts = [
    { label: 'Installer', value: installer },
    statusFact('Installer status', installer),
    { label: 'Counterparty', value: counterparty },
    statusFact('Counterparty status', counterparty),
  ]
  const financier = str(input.financierOnInstall)
  if (financier && financier.toLowerCase() !== counterparty.toLowerCase()) {
    facts.push({ label: 'Financier on the install agreement', value: financier })
    facts.push(statusFact('Financier status', financier))
  }
  return facts
}

export function composeMasterCallSheet(input: CloserWinInput): MasterCallSheet {
  const first = shown(input.firstName) === 'MISSING' ? 'there' : str(input.firstName)
  const product = normalizeProduct(input.product) || 'MISSING'
  const lease = product === 'lease' || product === 'ppa'
  const counterparty = shown(input.lender)
  const installer = shown(input.installer)
  const monthly = money(input.firstYearMonthly || input.monthly)
  const escalation = shown(input.escalation)
  const term = shown(input.termMonths)
  const signed = shown(input.signedDate)
  const payoff = money(input.payoff)
  const financed = shown(input.contractValue) === 'MISSING' ? '' : money(input.contractValue)
  const apr = shown(input.apr) === 'MISSING' ? '' : `${shown(input.apr)}%`
  const interestPaid = shown(input.interestPaid) === 'MISSING' ? '' : money(input.interestPaid)
  const firstPay = shown(input.firstPayDate) === 'MISSING' ? '' : shown(input.firstPayDate)
  const loanLine = [financed && `Amount financed ${financed}.`, apr && `APR ${apr}.`, interestPaid && `Interest paid to date ${interestPaid}.`, firstPay && `First payment ${firstPay}.`].filter(Boolean).join(' ')
  const feeCell = dealerFeeFromAmount(input.payoff)
  const fee = feeCell.kind === 'value' ? feeCell.display : ''
  const estimateNote = !input.payoffEstimated ? ''
    : input.product === 'ppa' || input.product === 'lease'
      ? 'That remaining balance is the scheduled payments still left, with the yearly increase. It is not a payoff quote.'
      : 'That remaining balance is amortization from the first payment date. It is not a payoff quote.'
  const workingSay = payoff === 'MISSING'
    ? 'The working figure is the remaining balance. It is not on this file, so the 30% processing fee is not on this file.'
    : `The working figure is the remaining balance, ${payoff}. The agreed processing fee is 30% of that figure${fee ? `: ${fee}` : ''}. ${estimateNote}`
  const state = knownState(input.state) ? leverFor(input.state) : null
  const place = [shown(input.city), shown(input.state)].filter((v) => v !== 'MISSING').join(', ') || 'MISSING'

  const opening = `${first}, thanks for the time. This is a case review, not a sales pitch. I’m going to show you exactly what is on your file, and the two options in front of you. Then I’ll ask for a yes or a no.`

  const signedSay = lease
    ? `This is a ${product}, not a purchase. ${counterparty === 'MISSING' ? 'The counterparty is MISSING on this file.' : `${counterparty} is the counterparty on the paper.`} Read the payment, the escalator, and who owns the incentives from this contract. If a salesperson promised a credit or a savings number that is not in the contract, say that the promise is not in the contract. Do not invent the number.`
    : `Walk the instrument that is actually on file: ${product}. Counterparty: ${counterparty}. Payment: ${monthly}. Do not describe a lease as a loan, or a loan as a lease.`

  const sections: CallSheetSection[] = [
    {
      title: 'What you signed',
      say: signedSay,
      facts: [
        { label: 'Product', value: product },
        { label: 'Counterparty', value: counterparty },
        { label: 'Installer', value: installer },
        { label: 'Where', value: place },
        { label: 'Signed', value: signed },
        { label: 'Payment on file', value: monthly },
        { label: 'Escalator', value: escalation === 'MISSING' ? 'MISSING' : `${escalation.replace(/%$/, '')}%` },
        { label: 'Term (months)', value: term },
      ],
    },
    {
      title: 'What changed',
      say: changedSay(input, installer, counterparty),
      facts: changedFacts(input, installer, counterparty),
    },
    {
      title: 'The money',
      say: `${workingSay} ${input.payoffEstimated ? 'That remaining balance is amortization from the first payment date. It is not a payoff quote.' : ''} ${loanLine}`.trim(),
      facts: [
        { label: 'Payment on file', value: monthly },
        ...(financed ? [{ label: 'Amount financed', value: financed }] : []),
        ...(apr ? [{ label: 'APR', value: apr }] : []),
        ...(interestPaid ? [{ label: input.payoffEstimated ? 'Estimated interest paid' : 'Interest paid to date', value: interestPaid }] : []),
        ...(firstPay ? [{ label: 'First payment date', value: firstPay }] : []),
        { label: input.payoffEstimated ? 'Estimated remaining balance' : 'Payoff / buyout', value: payoff },
        { label: 'Working figure', value: payoff === 'MISSING' ? 'MISSING' : payoff },
        { label: 'Agreed processing fee', value: fee || 'MISSING' },
      ],
    },
    {
      title: 'Reality check',
      say: billSay(input, monthly),
      facts: [
        { label: 'Before', value: beforeBill(input) },
        { label: 'After', value: afterBill(input, monthly) },
      ],
    },
    {
      title: 'Two options',
      say: `If you stay, you keep the contract on this file.${payoff === 'MISSING' ? '' : ` The working figure is ${payoff}.`} If you open the file with counsel, the agreed processing fee is 30% of that working figure${fee ? `, ${fee}` : ''}. Counsel evaluates independently. Do not promise cancellation, a reduced buyout, or a dollar of exposure avoided.`,
      facts: [
        { label: 'Stay', value: payoff === 'MISSING' ? 'Keep the contract that is on file. The remaining balance is not on this file.' : `Keep the contract. Working figure ${payoff}.` },
        { label: 'File', value: fee ? `Open the file with counsel. Agreed processing fee ${fee}, which is 30% of the working figure.` : 'The 30% fee prints when the remaining balance is on this file.' },
        { label: 'Lien', value: lienStatusCopy(input.state, input.lienQuote) },
      ],
    },
  ]

  const ask = `${first} — do I have your authorization to open the legal file, engage counsel under the agreed processing fee${fee ? ` of ${fee}, 30% of the working figure` : ''}, and send the document checklist? Then stop talking.`

  const documents: CallSheetDoc[] = [
    { item: 'Executed agreement', note: input.hasContract || input.hasFinance ? 'On file' : 'Still needed' },
    { item: 'Proposals, texts, and emails from the seller', note: input.hasProposal ? 'On file' : 'Priority if a promise is not in the contract' },
    { item: 'Name of the person who made a promise that is not in the contract', note: 'Confirm. Do not invent a name.' },
    { item: 'Recent servicer statements', note: input.hasStatement ? 'On file' : 'Still needed' },
    { item: 'Service tickets or ignored repair requests', note: 'Warranty non-performance, only if they exist' },
    { item: 'Latest utility bill against production', note: input.hasUtility ? 'Bill on file — production only if the report is on file' : 'Still needed' },
    { item: 'Any UCC or county filing notice', note: 'Confirm. Do not invent a filing number.' },
    { item: 'Whether a tax credit was claimed', note: state ? `Counsel needs this. ${state.udap} does not supply the answer.` : 'Counsel needs this. Do not guess.' },
  ]

  return {
    opening,
    sections,
    ask,
    documents,
    disclaimer: 'Not legal advice. Counsel evaluates independently.',
  }
}
