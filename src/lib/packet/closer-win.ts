/**
 * Closer-win brief.
 *
 * Example shape (internal, staff only): grok-chat (3).json — Eric Strange /
 * Powur / Sunlight. Every file is case-by-case. Facts restated from the packet
 * only. MISSING stays MISSING. Never invent APR, payoff, or account numbers.
 * Never promise a legal result. Best-case is a target, not a guarantee.
 */

import { pathLabel, trenchLabel } from './route'
import { str, type Path, type Trench } from './schema'
import { federalLevers, leverFor, stateLeversForFile } from './state-levers'
import { normalizeProduct } from '@/lib/desk-extract'

export type CloserWinInput = {
  firstName: string
  lastName: string
  city: string
  state: string
  product: string
  lender: string
  installer: string
  monthly: string
  termMonths: string
  apr: string
  contractValue: string
  payoff: string
  signedDate: string
  effectiveDate?: string
  firstYearMonthly?: string
  escalation?: string
  paymentBasis?: string
  termNote?: string
  painType: string
  painNarrative: string
  saleOrRefi: string
  flags: string[]
  hasContract: boolean
  hasFinance: boolean
  hasStatement: boolean
  hasPayoff: boolean
  hasUtility: boolean
  hasProposal: boolean
  closeability: 'A' | 'B' | 'C'
  path: Path
  trench: Trench
  ready: boolean
  missing: string[]
}

export type CloserWinBrief = {
  situation: string
  fileFacts: string[]
  redline: string[]
  cancelPath: string[]
  whyThisFile: string[]
  outcomeCeiling: string
  closeTalk: string
  highlights: string[]
  objections: { objection: string; response: string }[]
  talkingPoints: string[]
  recommendedNextStep: string
  missingForCeiling: string[]
}

const DEAD_LENDER = /sunlight|mosaic/i
const PAIN: Record<string, string> = {
  'bills-didnt-drop': 'savings never showed up',
  'two-bills': 'paying solar and a full utility bill',
  'signed-on-a-tablet': 'signed on a tablet and never got a copy',
  'installer-gone': 'installer gone or unresponsive',
  'selling-or-refinancing': 'sale or refinance blocked by solar',
  'never-switched-on': 'installed but never switched on',
}

function present(v: string): boolean {
  const s = str(v)
  return Boolean(s) && s.toUpperCase() !== 'MISSING' && s.toLowerCase() !== 'unknown'
}

function moneyish(v: string): string {
  const s = str(v).replace(/[^0-9.]/g, '')
  if (!s) return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return str(v)
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function threeDayStatus(signedDate: string): 'open' | 'gone' | 'unknown' {
  if (!present(signedDate)) return 'unknown'
  const d = new Date(signedDate)
  if (Number.isNaN(+d)) return 'unknown'
  const elapsed = Date.now() - d.getTime()
  return elapsed > 5 * 24 * 60 * 60 * 1000 ? 'gone' : elapsed < 0 ? 'unknown' : 'open'
}

function pullList(input: CloserWinInput): string[] {
  const need: string[] = []
  if (!input.hasFinance) need.push('financing agreement + TILA / loan disclosures')
  if (!input.hasStatement && !input.hasPayoff) need.push('current lender statement or payoff (do not guess remaining principal)')
  if (!input.hasUtility) need.push('latest utility bill (pre/post if they have both)')
  if (!input.hasProposal) need.push('sales proposal / kWh estimate, if they still have it')
  need.push('texts, emails, recordings with the salesperson')
  if (/selling|refi/i.test(input.saleOrRefi) || input.painType === 'selling-or-refinancing') {
    need.push('confirm any UCC-1 / fixture filing — search, do not invent a filing number')
  }
  return need
}

export function composeCloserWinBrief(input: CloserWinInput): CloserWinBrief {
  // PPA / lease economics and an unknown product cannot inherit a loan exit
  // narrative or a cancellation deadline inferred from an effective date.
  if (normalizeProduct(input.product) !== 'loan') return composeContractReviewBrief(input)
  const name = `${str(input.firstName)} ${str(input.lastName)}`.trim() || 'this client'
  const product = str(input.product) || 'MISSING'
  const lender = str(input.lender) || 'MISSING'
  const installer = str(input.installer) || 'MISSING'
  const monthly = present(input.monthly) ? moneyish(input.monthly) : 'MISSING'
  const term = present(input.termMonths) ? `${str(input.termMonths)} months` : 'MISSING'
  const apr = present(input.apr) ? `${str(input.apr)}%` : 'MISSING'
  const value = present(input.contractValue) ? moneyish(input.contractValue) : 'MISSING'
  const payoff = present(input.payoff) ? moneyish(input.payoff) : 'MISSING'
  const signed = present(input.signedDate) ? str(input.signedDate) : 'MISSING'
  const cooling = threeDayStatus(input.signedDate)
  const pain = PAIN[input.painType] || str(input.painNarrative) || 'unspecified'
  const deadLender = DEAD_LENDER.test(lender)
  const st = leverFor(input.state)
  const instrument = input.hasContract || input.hasFinance
  const inHomeOrTablet =
    input.painType === 'signed-on-a-tablet' ||
    input.flags.includes('in_home_sale') ||
    input.flags.includes('no_cancel_notice')
  const saleOrRefi =
    input.painType === 'selling-or-refinancing' ||
    /yes/i.test(input.saleOrRefi) ||
    input.flags.includes('lien')

  const fileFacts = [
    `${name} · ${str(input.city) || 'city MISSING'}, ${str(input.state) || 'ST'}`,
    `Product: ${product}. Lender: ${lender}. Installer: ${installer}.`,
    `Signed: ${signed}. Monthly: ${monthly}. Term: ${term}. APR: ${apr}.`,
    `Original contract / amount financed: ${value}. Current payoff: ${payoff}.`,
    `${st.name} cooling-off (${st.coolingOffBusinessDays} business days if sold in the home / away from the seller’s place of business): ${cooling === 'gone' ? 'expired on this signed date' : cooling === 'open' ? 'may still be open — confirm the notice and sale location' : 'UNKNOWN (no signed date on the packet)'}.`,
    `Raised hand: ${pain}.`,
    `Paperwork: ${instrument ? 'signed instrument on file or inbound' : 'NO signed instrument'}. Path: ${pathLabel(input.path)}. Trench: ${trenchLabel(input.trench)}. Closeability: ${input.closeability}.`,
  ]

  const situation = fileFacts.slice(0, 5).join(' ')

  const redline: string[] = []
  if (!instrument) {
    redline.push('No signed install or finance instrument. This is a C file. Do not Dashboard. Do not run Strawberry. Collect the agreement first.')
  }
  if (cooling === 'gone') {
    redline.push(
      `${st.name} / FTC cooling-off (${st.coolingOffBusinessDays} business days) is gone on this signed date. Do not open the call as if they can still unwind under the notice. The live path is a documented breach / TILA / Holder / lender-side exit — not a cooling-off.`,
    )
  } else if (cooling === 'unknown') {
    redline.push(
      `Cannot say whether the ${st.coolingOffBusinessDays}-day ${st.name} / FTC cooling-off is open — signed date is MISSING. Pull the contract date and sale location before using cooling-off language.`,
    )
  } else {
    redline.push(
      `${st.name} / FTC cooling-off may still be open (${st.coolingOffBusinessDays} business days) IF this was sold in the home or at a temporary location. Confirm sale location and whether the cancellation notice is attached.`,
    )
  }
  if (input.painType === 'bills-didnt-drop' || input.flags.includes('promised_offset')) {
    redline.push('Savings / offset claim vs what the paper actually warrants. Line production and bills against whatever the proposal promised. Do not invent a kWh number.')
  }
  if (input.painType === 'two-bills' || input.flags.includes('paying_both_asserted')) {
    redline.push('They are paying solar and a utility bill. That is the live pain. Confirm with the latest bill — do not guess the amount.')
  }
  if (inHomeOrTablet) {
    redline.push(
      `Tablet / in-home sale / missing cancellation notice: stack FTC Cooling-Off + ${st.name} home-solicitation (${st.coolingOffBusinessDays} business days) + copy-of-contract. Only use what the packet shows.`,
    )
  }
  if (input.painType === 'installer-gone' || input.flags.includes('installer_gone')) {
    redline.push('Installer gone or unresponsive. Warranty and service failure sit on the installer side and can still pressure the holder of the loan.')
  }
  if (input.painType === 'never-switched-on' || input.flags.includes('underperform')) {
    redline.push('System never on or underproducing. Need PTO / production data. Do not invent a production shortfall percentage.')
  }
  if (input.painType === 'selling-or-refinancing' || /yes/i.test(input.saleOrRefi) || input.flags.includes('lien')) {
    redline.push('Sale or refinance in play. A UCC-1 / fixture filing is common on financed systems and is leverage only after it is confirmed — never invent a filing number.')
  }
  if (input.flags.includes('hidden_fee') || input.flags.includes('tax_credit_drop')) {
    redline.push('Dealer-fee or tax-credit representation. Only quote APR / dealer fee / ITC language that is on a finance page. Otherwise MISSING.')
  }
  if (deadLender) {
    redline.push(`${lender} is a distressed / post-bankruptcy solar lender pattern. Settlement and UCC-release files exist in that book. That is pattern, not a promise on this file.`)
  }

  redline.push(...federalLevers({
    product,
    hasFinance: input.hasFinance,
    inHomeOrTablet,
    coolingOffExpired: cooling === 'gone' ? true : cooling === 'open' ? false : null,
    saleOrRefi,
  }))
  redline.push(...stateLeversForFile(input.state))

  if (!str(input.state) || str(input.state).length !== 2) {
    redline.push('State is MISSING on the packet. Do not pick a board. Confirm the property state before citing a state statute.')
  }

  const pulls = pullList(input)
  const cancelPath: string[] = []
  if (input.closeability === 'C') {
    cancelPath.push('Blocked. Collect identity (1–8) and a signed agreement (19 or 20). Then re-run READY.')
  } else if (input.path === 'tradebloc_dc_capital') {
    cancelPath.push(`Best-probability path is ${pathLabel(input.path)} because of the lender — not because cooling-off is open.`)
    cancelPath.push('Same week: loan agreement + TILA box + current statement/payoff + UCC search + production/sales trail.')
    cancelPath.push('Pressure both installer and lender. Holder Rule only if the Holder Notice is on THIS note. TILA rescission only if the note is dwelling-secured.')
    cancelPath.push(`Parallel ${st.name} desk: ${st.contractorBoard}${st.recoveryFund ? ` + ${st.recoveryFund}` : ''}. Then ${st.ag}.`)
  } else if (input.path === 'collection') {
    cancelPath.push('No instrument. Collection / recovery only until a signed agreement lands.')
  } else {
    cancelPath.push(`Best-probability path is ${pathLabel(input.path)} on this ${st.name} packet.`)
    cancelPath.push(`Sequence: (1) TILA box + Holder Notice on the finance paper, (2) ${st.name} home-solicitation / ${st.contractorBoard}, (3) ${st.udap} / ${st.ag}, (4) lender demand. Demand letter only after the missing pages are in.`)
    cancelPath.push(`${st.contractorBoard} is parallel pressure, not the first sentence of the call.`)
  }
  cancelPath.push(`Still needed to raise the ceiling: ${pulls.join('; ')}.`)

  const whyThisFile: string[] = []
  if (deadLender) whyThisFile.push(`${lender} has a public settlement / cancellation pattern after distress. Use it as path, not as a guaranteed recovery.`)
  if (instrument) whyThisFile.push('A signed instrument is on file — this is not a no-paper C file.')
  if (present(input.contractValue) || present(input.monthly)) {
    whyThisFile.push(`Economics on the packet: ${value !== 'MISSING' ? value : ''} ${monthly !== 'MISSING' ? `${monthly}/mo` : ''} ${term !== 'MISSING' ? term : ''}`.trim())
  }
  if (pain !== 'unspecified') whyThisFile.push(`They already named the pain: ${pain}.`)
  if (input.ready) whyThisFile.push('Packet is READY. Strawberry may type Dashboard. Human Submit.')
  else whyThisFile.push(`Not READY (${input.missing.join(', ') || 'gaps'}). Do not Dashboard.`)
  if (whyThisFile.length === 0) whyThisFile.push('Insufficient facts for a specialist call. Collect the instrument and identity.')

  const outcomeCeiling = input.closeability === 'C'
    ? 'No outcome talk. Collect the contract first.'
    : [
        'Best-case target (not a promise): full or near-full debt exit + lien/UCC off if one exists + credit repair of what this loan put on the file.',
        'Strong documented file: cancellation or deep principal reduction plus the filing released.',
        'Thin file (no sales/performance paper): discounted payoff only.',
        'Do not quote remaining principal, cash-in-pocket, or “six figures” unless a statement or payoff letter is on the packet.',
      ].join(' ')

  const missingForCeiling = [
    !input.hasFinance ? 'loan agreement / TILA' : '',
    !input.hasPayoff && !input.hasStatement ? 'current payoff or statement' : '',
    payoff === 'MISSING' ? 'payoff (never invent)' : '',
    apr === 'MISSING' ? 'APR (never invent)' : '',
    signed === 'MISSING' ? 'contract date' : '',
  ].filter(Boolean)

  const closeTalk = input.closeability === 'C'
    ? `${str(input.firstName) || 'They'} — we cannot advise a cancel path until the signed agreement is in the file. That is the whole call. Send the contract, then we read it.`
    : [
        `${str(input.firstName) || name}, here is the clean version.`,
        product === 'loan' || /loan/i.test(product)
          ? `This reads as a financed purchase, not a lease/PPA${installer !== 'MISSING' ? ` through ${installer}` : ''}${lender !== 'MISSING' ? `, financed by ${lender}` : ''}.`
          : `Product on the packet is ${product}.`,
        cooling === 'gone'
          ? `The ${st.coolingOffBusinessDays}-day ${st.name} / FTC cooling-off is gone. We do not pretend it is open.`
          : '',
        monthly !== 'MISSING' ? `Stated payment ${monthly}${term !== 'MISSING' ? ` on a ${term} term` : ''}${apr !== 'MISSING' ? ` at ${apr}` : ''}.` : '',
        value !== 'MISSING' ? `Amount on paper ${value}. Payoff ${payoff}.` : `Payoff ${payoff}.`,
        `The redline that matters: ${redline[0] ?? 'the numbers on this packet'}.`,
        `Best-probability path is not hoping the installer is nice. It is documenting this ${st.name} file under TILA / Holder (if on the note) / ${st.udap} and putting ${lender !== 'MISSING' ? lender : 'the lender'} in a position where keeping the debt costs more than releasing it.`,
        `If you want that shot, we collect ${pulls.slice(0, 3).join(', ')} this week and we go after the debt, not the panels.`,
      ]
        .filter(Boolean)
        .join(' ')

  const highlights = [
    `Closeability ${input.closeability} · ${pathLabel(input.path)} · ${trenchLabel(input.trench)}`,
    `Lender ${lender}`,
    `Monthly ${monthly}`,
    cooling === 'gone'
      ? `${st.code} ${st.coolingOffBusinessDays}-day expired`
      : cooling === 'open'
        ? `${st.code} ${st.coolingOffBusinessDays}-day maybe open`
        : `${st.code} cooling-off unknown`,
    `${st.code} · ${st.contractorBoard}`,
    pain !== 'unspecified' ? `Pain: ${pain}` : '',
  ].filter(Boolean)

  const objections: CloserWinBrief['objections'] = []
  if (cooling === 'gone') {
    objections.push({
      objection: '“Can’t I just cancel? It’s only been a few years.”',
      response: `The ${st.name} / FTC cooling-off is gone. The live path is TILA + Holder (if on the note) + ${st.udap} + ${st.contractorBoard} against installer and lender. Walk the redline, not the notice date.`,
    })
  }
  objections.push({
    objection: '“What’s the probability you get me out?”',
    response: 'Do not quote a percentage. Restate the ceiling: best-case target vs strong documented vs thin file. Their facts decide which bucket. Human Submit, human close.',
  })
  if (payoff === 'MISSING') {
    objections.push({
      objection: '“How much do I still owe?”',
      response: 'Payoff is MISSING. Do not invent remaining principal. Get the statement or payoff letter on this call or the same day.',
    })
  }

  const talkingPoints = [
    `Open from their packet, not a generic pitch: ${lender} / ${monthly}/mo / ${product}.`,
    closeTalk,
    input.ready
      ? 'READY. After the call, paste Dashboard payload. Strawberry types. You Submit.'
      : `Not READY (${input.missing.join(', ') || 'gaps'}). Collect missing items. Do not Dashboard.`,
  ]

  const recommendedNextStep = input.closeability === 'C'
    ? 'Get the signed agreement uploaded before any cancel talk.'
    : pulls[0]
      ? `This week: ${pulls[0]}. Then the rest of the pull list. Then the demand — not before.`
      : 'Packet is documented. Walk the redline and book the next human step.'

  return {
    situation,
    fileFacts,
    redline,
    cancelPath,
    whyThisFile,
    outcomeCeiling,
    closeTalk,
    highlights,
    objections,
    talkingPoints,
    recommendedNextStep,
    missingForCeiling,
  }
}

function composeContractReviewBrief(input: CloserWinInput): CloserWinBrief {
  const name = `${str(input.firstName)} ${str(input.lastName)}`.trim() || 'Client'
  const product = normalizeProduct(input.product)
  const show = (value: string | undefined) => str(value) || 'MISSING'
  const dollars = (value: string | undefined) => value && present(value) ? moneyish(value) : 'MISSING'
  const facts = [
    `${name} · ${show(input.city)}, ${show(input.state)}.`,
    `Reviewed product: ${product || 'MISSING — review the document classification'}. Contract counterparty: ${show(input.lender)}.`,
    `Customer signature: ${show(input.signedDate)}. Contract effective date: ${show(input.effectiveDate)}.`,
    `First-year monthly payment: ${dollars(input.firstYearMonthly)}. Contract / intake monthly payment: ${dollars(input.monthly)}. Payment basis: ${show(input.paymentBasis)}.`,
    `Term: ${show(input.termMonths)} months. Annual payment escalation: ${show(input.escalation).replace(/%$/, '')}${input.escalation ? '%' : ''}. ${input.termNote || ''}`.trim(),
    `Payoff / buyout quote: ${dollars(input.payoff)}. Reported concern: ${show(input.painNarrative || input.painType)}.`,
  ]
  const missing = [...input.missing]
  const next = input.ready ? 'Review the completed packet with the client; require staff approval before any submission.' : `Review the original document and complete: ${missing.join(', ') || 'missing or unverified facts'}.`
  const redline = [
    'Document extraction must be reviewed before it is presented as confirmed client data.',
    'A first-year payment does not establish today’s payment. The actual in-service date and current statement must be checked.',
    'Annual payment escalation is not loan APR. No loan principal, dealer fee, amortization, or cancellation entitlement is inferred.',
    'Review the agreement’s cancellation and transfer clauses. Do not infer a deadline from the signature or effective date alone.',
  ]
  return {
    situation: facts.join(' '), fileFacts: facts, redline,
    cancelPath: ['Review the PPA / lease agreement and its current account records before selecting a resolution path.'],
    whyThisFile: [input.hasContract ? 'Agreement received for review.' : 'Agreement still needed.'],
    outcomeCeiling: 'No resolution or financial outcome is established by document extraction alone.',
    closeTalk: `Confirm the client’s concern and review the agreement facts together. ${next}`,
    highlights: facts.slice(1, 5), objections: [], talkingPoints: [next],
    recommendedNextStep: next,
    missingForCeiling: ['Current dated statement', 'Actual in-service date', ...missing],
  }
}

export function formatCloserWinBrief(b: CloserWinBrief): string {
  return [
    'FILE',
    ...b.fileFacts.map((l) => `· ${l}`),
    '',
    'REDLINE (internal — not a homeowner lecture)',
    ...b.redline.map((l) => `· ${l}`),
    '',
    'BEST-PROBABILITY PATH',
    ...b.cancelPath.map((l) => `· ${l}`),
    '',
    'WHY THIS FILE',
    ...b.whyThisFile.map((l) => `· ${l}`),
    '',
    'OUTCOME CEILING (target, not a promise)',
    b.outcomeCeiling,
    b.missingForCeiling.length ? `Still MISSING for a ceiling: ${b.missingForCeiling.join(', ')}.` : '',
    '',
    'CLOSE TALK',
    b.closeTalk,
    '',
    `Next: ${b.recommendedNextStep}`,
  ]
    .filter((l) => l !== '')
    .join('\n')
}

export function closerWinToBriefContent(b: CloserWinBrief) {
  return {
    situation: b.situation,
    highlights: b.highlights,
    objections: b.objections,
    talkingPoints: b.talkingPoints,
    recommendedNextStep: b.recommendedNextStep,
    redline: b.redline,
    cancelPath: b.cancelPath,
    closeTalk: b.closeTalk,
    outcomeCeiling: b.outcomeCeiling,
  }
}
