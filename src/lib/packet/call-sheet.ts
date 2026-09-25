/**
 * Master call sheet + redline poster.
 *
 * Both are built from the packet in front of the closer. A missing fact stays
 * MISSING. Another client's bills, lease numbers, and state statute never leak in.
 * The poster is state and federal consumer rights only.
 */

import type { CloserWinInput } from './closer-win'
import { federalLevers, leverFor, stateLeversForFile, STATE_LEVERS } from './state-levers'
import { str } from './schema'
import { normalizeProduct } from '@/lib/desk-extract'

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
      say: input.flags.includes('installer_gone') || input.painType === 'installer-gone'
        ? 'The file says the installer is gone or unresponsive. Billing and the warranty are not the same party unless this contract says so. Do not name a bankruptcy or a successor that is not on this file.'
        : 'No servicer change or warrantor failure is confirmed on this file. Do not invent a bankruptcy, a successor, or a warranty gap.',
      facts: [
        { label: 'Installer', value: installer },
        { label: 'Counterparty', value: counterparty },
      ],
    },
    {
      title: 'The money',
      say: payoff === 'MISSING'
        ? 'A remaining payoff or buyout is MISSING. Do not use a face total of payments as a payoff, and do not quote a processing fee until the engagement states it.'
        : `The working figure on file is ${payoff}. Use that figure. Do not substitute a face total of payments.`,
      facts: [
        { label: 'Payment on file', value: monthly },
        { label: 'Payoff / buyout', value: payoff },
      ],
    },
    {
      title: 'Reality check',
      say: input.hasUtility
        ? 'A utility bill is on file. Compare it to what the contract estimated. Do not invent a before-and-after average that is not on the bill.'
        : 'Utility before/after and production are MISSING. Do not quote a savings amount or a kilowatt-hour shortfall.',
      facts: [{ label: 'Utility bill on file', value: input.hasUtility ? 'Yes' : 'MISSING' }],
    },
    {
      title: 'Two options',
      say: 'Option A is the status quo on this contract. Option B is putting the file in front of counsel. Do not promise cancellation, a reduced buyout, or a dollar of exposure avoided.',
      facts: [
        { label: 'Stay', value: 'Keep the contract that is on file. Do not invent the remaining rent.' },
        { label: 'File', value: 'Counsel evaluates independently. Fee is only the fee written on the engagement.' },
      ],
    },
  ]

  const ask = `${first} — do I have your authorization to open the legal file, engage counsel under the processing fee written on the engagement, and send the document checklist? Then stop talking.`

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
