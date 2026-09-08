import type { AssistContext, CloseScoreResult, CloserBriefContent } from './provider'

/**
 * Deterministic probability-to-close scoring and Closer Brief composition.
 *
 * This is the mock provider's engine and the reference for what the real model
 * is asked to weigh. Pure functions: same context in, same output out — no
 * clock, no RNG — so scores are stable, explainable, and testable.
 *
 * The number produced is a PRIORITIZATION signal. It orders the call queue and
 * feeds the phase dashboards; humans make every qualification, eligibility,
 * and close decision.
 */

export type CloseSignal = { label: string; delta: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

/** Funnel depth inferred from the stage name. Keyword-based so it works across
 *  differently named pipelines while staying fully deterministic. */
function stageDepth(stageName: string): { delta: number; note: string } {
  const s = stageName.toLowerCase()
  if (/(won|closed.?won)/.test(s)) return { delta: 40, note: 'already at a won stage' }
  if (/(clos|contract|commit|sign)/.test(s)) return { delta: 30, note: 'at the closing step of the funnel' }
  if (/(negotiat|present|proposal|offer)/.test(s)) return { delta: 22, note: 'deep in the funnel (presentation/negotiation)' }
  if (/qualif/.test(s)) return { delta: 15, note: 'qualified and moving' }
  if (/(nurtur|follow|working|contact)/.test(s)) return { delta: 8, note: 'in active nurture' }
  if (/(new|intake|lead|prospect)/.test(s)) return { delta: 2, note: 'early in the funnel' }
  return { delta: 8, note: 'mid-funnel' }
}

/** Whole-day gap between two ISO timestamps, or null when either is missing. */
function daysBetween(earlierIso: string | null, laterIso: string | null): number | null {
  if (!earlierIso || !laterIso) return null
  const a = Date.parse(earlierIso)
  const b = Date.parse(laterIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.floor((b - a) / 86_400_000)
}

/**
 * Scores one client file from the evidence in its assist context.
 * Every point moved is named in `signals`; `reasons` is the human-readable
 * top-N of those, strongest influence first.
 */
export function computeCloseScore(context: AssistContext): CloseScoreResult & { signals: CloseSignal[] } {
  const signals: CloseSignal[] = []
  const add = (label: string, delta: number) => {
    if (delta !== 0) signals.push({ label, delta })
  }

  const base = 20

  // Funnel depth is the strongest single signal.
  const depth = stageDepth(context.client.stageName)
  add(`Stage "${context.client.stageName}" — ${depth.note}`, depth.delta)

  // Required-document completeness (up to +12).
  const required = context.documents.filter((d) => d.required)
  if (required.length > 0) {
    const approved = required.filter((d) => d.status === 'APPROVED').length
    const delta = Math.round((approved / required.length) * 12)
    add(`Documents: ${approved} of ${required.length} required approved`, delta)
    if (approved < required.length) {
      add(`${required.length - approved} required document${required.length - approved === 1 ? '' : 's'} still outstanding`, -3)
    }
  }

  // Intake survey.
  add(context.surveyComplete ? 'Intake survey completed' : 'Intake survey not finished', context.surveyComplete ? 8 : -4)

  // Consents.
  const ungranted = context.consents.filter((c) => !c.granted)
  if (context.consents.length > 0 && ungranted.length === 0) {
    add('All recorded consents granted', 6)
  } else if (ungranted.length > 0) {
    add(
      `Consent missing: ${ungranted.map((c) => c.type.toLowerCase().replace(/_/g, ' ')).join(', ')}`,
      clamp(-3 * ungranted.length, -9, 0),
    )
  }

  // Credit review.
  if (context.creditSummary?.status === 'COMPLETED') {
    add('Credit review completed', 6)
    const band = (context.creditSummary.scoreBand ?? '').toUpperCase()
    if (band === 'EXCELLENT' || band === 'GOOD') add(`Credit score band ${band.toLowerCase()}`, 4)
    else if (band === 'POOR') add('Credit score band poor', -6)
  }

  // A contract on file means there is something concrete to work.
  if (context.contracts.length > 0) add('Contract on file to work from', 4)

  // Engagement volume.
  const comms = context.engagement.communicationsCount
  if (comms >= 5) add(`${comms} recorded interactions — responsive`, 6)
  else if (comms >= 2) add(`${comms} recorded interactions`, 3)
  else add('Little to no recorded contact yet', -4)

  // Reply recency, measured against the file's own last activity (no clock).
  const daysSinceReply = daysBetween(context.engagement.lastInboundAt, context.client.lastActivityAt)
  if (daysSinceReply === null) add('No inbound reply ever recorded', -6)
  else if (daysSinceReply <= 7) add('Client replied within the last week of activity', 8)
  else if (daysSinceReply <= 21) add(`Last reply ${daysSinceReply} days before latest activity`, 3)
  else add(`Conversation quiet — last reply ${daysSinceReply} days back`, -5)

  // Cross-source conflicts erode trust in the file.
  if (context.fieldConflicts.length > 0) {
    add(
      `${context.fieldConflicts.length} unresolved cross-source mismatch${context.fieldConflicts.length === 1 ? '' : 'es'}`,
      clamp(-4 * context.fieldConflicts.length, -12, 0),
    )
  }

  if (context.client.estimatedValue !== null) add('Deal value estimated', 2)

  const raw = base + signals.reduce((sum, s) => sum + s.delta, 0)
  // Never 0 or 100 — the score is a signal, not a verdict.
  const probability = clamp(Math.round(raw), 2, 97)

  // Confidence reflects how much of the file is actually populated.
  const evidence = [
    context.contracts.length > 0,
    context.creditSummary !== null,
    required.length > 0,
    context.survey !== null,
    comms > 0,
    context.consents.length > 0,
  ].filter(Boolean).length
  const confidence: CloseScoreResult['confidence'] = evidence >= 5 ? 'high' : evidence >= 3 ? 'medium' : 'low'

  const reasons = [...signals]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 8)
    .map((s) => `${s.label} (${s.delta > 0 ? '+' : ''}${s.delta})`)

  return { probability, reasons, confidence, signals }
}

/**
 * Composes a deterministic pre-call Closer Brief from the same evidence.
 * Objections are anticipated from concrete facts (escalator, payment, missing
 * docs, language, silence) — never invented beyond what the file shows.
 */
export function composeCloserBrief(context: AssistContext): CloserBriefContent {
  const { client, contracts, creditSummary, engagement } = context
  const contract = contracts[0]
  const required = context.documents.filter((d) => d.required)
  const approved = required.filter((d) => d.status === 'APPROVED')
  const pendingDocs = required.filter((d) => d.status !== 'APPROVED')
  const ungranted = context.consents.filter((c) => !c.granted)
  const es = client.preferredLanguage === 'es'

  const situation = [
    `${client.firstName} ${client.lastName} is at "${client.stageName}"`,
    contract
      ? ` with a ${contract.productType ?? 'agreement'} through ${contract.counterparty}${
          contract.monthlyAmount !== null ? ` at ${money(contract.monthlyAmount)} per month` : ''
        }${contract.termMonths ? ` over ${contract.termMonths} months` : ''}.`
      : ' with no contract on file yet.',
    required.length ? ` Documents: ${approved.length} of ${required.length} required approved.` : '',
    context.surveyComplete ? ' Survey complete.' : ' Survey not finished.',
    ` ${engagement.communicationsCount} recorded interaction${engagement.communicationsCount === 1 ? '' : 's'}`,
    engagement.lastInboundAt ? `, last reply ${engagement.lastInboundAt.slice(0, 10)}.` : ', no reply on record yet.',
  ].join('')

  const highlights: string[] = []
  if (contract?.monthlyAmount !== null && contract?.monthlyAmount !== undefined) {
    highlights.push(`Current payment: ${money(contract.monthlyAmount)}/mo to ${contract.counterparty}`)
  }
  if (contract?.escalatorPct) highlights.push(`Contract escalates ${contract.escalatorPct}% per year`)
  if (contract?.termMonths) highlights.push(`${contract.termMonths}-month term on file`)
  if (creditSummary?.scoreBand) highlights.push(`Credit band ${creditSummary.scoreBand} (soft pull complete)`)
  if (client.estimatedValue !== null) highlights.push(`Estimated deal value ${money(client.estimatedValue)}`)
  if (client.city && client.state) highlights.push(`Located in ${client.city}, ${client.state}`)
  if (es) highlights.push('Spanish-preferred — run the call and paperwork in Spanish')
  if (context.fieldConflicts.length > 0) {
    highlights.push(`${context.fieldConflicts.length} cross-source data mismatch${context.fieldConflicts.length === 1 ? '' : 'es'} to confirm live`)
  }

  const objections: CloserBriefContent['objections'] = []
  if (contract?.escalatorPct) {
    objections.push({
      objection: '“My payment keeps going up — how is this different?”',
      response: `Their contract escalates ${contract.escalatorPct}% every year, so the number on file (${
        contract.monthlyAmount !== null ? money(contract.monthlyAmount) : 'their payment'
      }) only grows. Walk the escalator math on their own agreement before comparing anything.`,
    })
  }
  objections.push({
    objection: '“I need to think about it / talk to my spouse.”',
    response: `Agree, and anchor a concrete next step over their preferred channel (${client.preferredContact}). Offer to include the other decision-maker on a short follow-up rather than leaving it open-ended.`,
  })
  if (pendingDocs.length > 0) {
    objections.push({
      objection: '“I’ll send the documents later.”',
      response: `Only ${pendingDocs.length} item${pendingDocs.length === 1 ? '' : 's'} left (${pendingDocs
        .slice(0, 3)
        .map((d) => d.name)
        .join(', ')}). Offer to capture ${pendingDocs.length === 1 ? 'it' : 'them'} on the call — the file is otherwise ready.`,
    })
  }
  if (ungranted.length > 0) {
    objections.push({
      objection: '“Why do you need my consent for that?”',
      response: `Explain plainly what ${ungranted
        .map((c) => c.type.toLowerCase().replace(/_/g, ' '))
        .join(' and ')} unlocks for their file, and that nothing runs without it. Capture it while you have them.`,
    })
  }
  const daysSinceReply = daysBetween(engagement.lastInboundAt, client.lastActivityAt)
  if (daysSinceReply !== null && daysSinceReply > 14) {
    objections.push({
      objection: '“Why are you calling me again after all this time?”',
      response: 'Acknowledge the gap, restate where their file stands in one sentence, and ask one question about what changed on their side. Do not restart the pitch from zero.',
    })
  }

  const talkingPoints: string[] = []
  talkingPoints.push(
    contract
      ? `Open from their own numbers: ${contract.counterparty}${
          contract.monthlyAmount !== null ? ` at ${money(contract.monthlyAmount)}/mo` : ''
        } — not a generic pitch.`
      : 'No contract is on file yet — the first job is getting their agreement uploaded so the numbers are real.',
  )
  if (es) talkingPoints.push('Conduct the entire conversation in Spanish; confirm the documents they sign match.')
  if (!context.surveyComplete) talkingPoints.push('Close the remaining survey questions conversationally during the call.')
  if (creditSummary?.status === 'COMPLETED') {
    talkingPoints.push(`Credit review is done${creditSummary.scoreBand ? ` (band ${creditSummary.scoreBand})` : ''} — no waiting on that step.`)
  }
  if (context.fieldConflicts.length > 0) {
    talkingPoints.push(`Verify the mismatched field${context.fieldConflicts.length === 1 ? '' : 's'} (${[...new Set(context.fieldConflicts.map((c) => c.field))].join(', ')}) before anything is sent or signed.`)
  }
  talkingPoints.push(`Confirm the next step on their preferred channel (${client.preferredContact}) before hanging up.`)

  const recommendedNextStep = !context.surveyComplete
    ? 'Finish the intake survey on this call — everything downstream is blocked on it.'
    : ungranted.length > 0
      ? 'Capture the outstanding consent live, then move straight to scheduling the presentation.'
      : pendingDocs.length > 0
        ? `Collect the ${pendingDocs.length} outstanding document${pendingDocs.length === 1 ? '' : 's'} on or immediately after the call.`
        : 'The file is complete — ask for the close and book the signing.'

  return {
    situation,
    highlights: highlights.slice(0, 8),
    objections: objections.slice(0, 5),
    talkingPoints: talkingPoints.slice(0, 6),
    recommendedNextStep,
  }
}
