import 'server-only'
import type {
  AIAnalysis,
  AIComplianceFlag,
  AIFact,
  AIMissing,
  AIProvider,
  AssignmentInput,
  AssistChannel,
  AssistContext,
  CloseScoreResult,
  CloserBriefContent,
  DiscrepanciesResult,
  DocumentSummaryResult,
  GenerateInsightsInput,
  GenerateInsightsResult,
  InsightCitation,
  InsightProposal,
  LeadSummaryResult,
  MessageDraftResult,
  NextActionSuggestion,
  NextActionsResult,
  OnboardingInput,
  QualificationInput,
  QualificationSignal,
  QualificationSignalsResult,
} from './provider'
import { assignmentConfidence, scoreCandidates } from './scoring'
import { composeCloserBrief, computeCloseScore } from './close-scoring'
import { insightDedupeKey } from '@/lib/engine/insight-rules'

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? null : `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

/**
 * Deterministic stand-in for a language model.
 *
 * It reads the same structured input a real provider would and produces the same
 * shape of output, so every screen, test, and workflow behaves identically with
 * or without an API key. It states only what the input contains — where a real
 * model might speculate, this returns a "missing information" entry instead.
 */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock'
  readonly model = null

  async analyzeOnboarding(input: OnboardingInput): Promise<AIAnalysis> {
    const { client, contracts, creditSummary, documents, survey } = input

    const facts: AIFact[] = []
    const missing: AIMissing[] = []
    const flags: AIComplianceFlag[] = []

    const contract = contracts[0]
    if (contract) {
      facts.push({ label: 'Counterparty', value: contract.counterparty, source: 'contract.counterparty' })
      if (contract.monthlyAmount !== null) {
        facts.push({
          label: 'Monthly payment',
          value: money(contract.monthlyAmount)!,
          source: 'contract.monthlyAmount',
        })
      }
      if (contract.termMonths) {
        facts.push({ label: 'Term', value: `${contract.termMonths} months`, source: 'contract.termMonths' })
      }
      if (contract.escalatorPct) {
        facts.push({
          label: 'Annual escalator',
          value: `${contract.escalatorPct}%`,
          source: 'contract.escalatorPct',
        })
      }
    } else {
      missing.push({ key: 'contract', label: 'No contract on file to review' })
    }

    if (creditSummary?.scoreBand) {
      facts.push({ label: 'Credit score band', value: creditSummary.scoreBand, source: 'creditPull.scoreBand' })
    } else {
      missing.push({ key: 'credit', label: 'Soft credit summary not yet available' })
    }

    if (!input.surveyComplete) missing.push({ key: 'survey', label: 'Survey is not finished' })

    for (const doc of documents.filter((d) => d.required && d.status !== 'APPROVED')) {
      missing.push({ key: `doc:${doc.name}`, label: `${doc.name} — ${doc.status.toLowerCase()}` })
    }

    const ungranted = input.consents.filter((c) => !c.granted)
    if (ungranted.length) {
      flags.push({
        level: 'blocker',
        text: `Consent not recorded for: ${ungranted.map((c) => c.type.toLowerCase().replace(/_/g, ' ')).join(', ')}.`,
      })
    }

    // A language mismatch between the sale and the paperwork is worth a human look.
    if (client.preferredLanguage !== 'en') {
      flags.push({
        level: 'review',
        text: `Client's preferred language is "${client.preferredLanguage}". Confirm the documents they sign are in that language.`,
      })
    }

    // Contradiction check across two independent sources.
    const surveyMonthly = Number((survey as Record<string, unknown> | null)?.monthlyAmount ?? NaN)
    if (contract?.monthlyAmount && Number.isFinite(surveyMonthly)) {
      const drift = Math.abs(surveyMonthly - contract.monthlyAmount) / contract.monthlyAmount
      if (drift > 0.15) {
        flags.push({
          level: 'review',
          text: `The client reported ${money(surveyMonthly)} per month but the contract on file says ${money(contract.monthlyAmount)}. Confirm which is current.`,
        })
      }
    }

    const nextBestAction = !input.surveyComplete
      ? 'Get the survey finished — everything downstream is blocked on it.'
      : ungranted.length
        ? 'Capture the outstanding consent before any credit inquiry.'
        : !creditSummary?.scoreBand
          ? 'Run the soft credit pull now that consent is on file.'
          : missing.length
            ? `Chase the outstanding items (${missing.length}) before the presentation.`
            : 'File looks complete — book the presentation.'

    return {
      summary: [
        `${client.firstName} ${client.lastName} is at "${client.stageName}"`,
        contract ? ` with a ${contract.productType ?? 'agreement'} through ${contract.counterparty}` : ' with no contract on file yet',
        contract?.monthlyAmount ? ` at ${money(contract.monthlyAmount)} per month` : '',
        `. ${input.communicationsCount} recorded interaction${input.communicationsCount === 1 ? '' : 's'} so far.`,
      ].join(''),
      facts,
      inferences: [
        {
          label: 'File readiness',
          value: missing.length === 0 ? 'Complete' : `${missing.length} item${missing.length === 1 ? '' : 's'} outstanding`,
        },
        {
          label: 'Engagement',
          value:
            input.communicationsCount >= 5 ? 'Responsive' : input.communicationsCount >= 2 ? 'Moderate' : 'Low so far',
        },
      ],
      recommendation: { nextBestAction },
      confidence: Math.max(40, 95 - missing.length * 8 - flags.length * 5),
      reasons: [
        { factor: 'Evidence', detail: `${facts.length} sourced fact${facts.length === 1 ? '' : 's'} from the record` },
        { factor: 'Gaps', detail: missing.length ? missing.map((m) => m.label).join('; ') : 'None found' },
      ],
      missingInformation: missing,
      complianceFlags: flags,
      provider: this.name,
      model: this.model,
    }
  }

  async recommendQualification(input: QualificationInput): Promise<AIAnalysis> {
    const failed = input.rules.filter((r) => r.passed === false)
    const unknown = input.rules.filter((r) => r.passed === null)
    const missing: AIMissing[] = unknown.map((r) => ({ key: r.key, label: `${r.label} — cannot be evaluated yet` }))

    const outcome = failed.length > 0 ? 'NOT_QUALIFIED' : unknown.length > 0 ? 'NEEDS_MORE_INFO' : 'QUALIFIED'

    const facts: AIFact[] = []
    if (input.householdIncome !== null) {
      facts.push({ label: 'Household income', value: money(input.householdIncome)!, source: 'survey.householdIncome' })
    }
    if (input.monthlyObligations !== null) {
      facts.push({
        label: 'Monthly obligations',
        value: money(input.monthlyObligations)!,
        source: 'survey.monthlyObligations',
      })
    }
    if (input.creditSummary?.scoreBand) {
      facts.push({ label: 'Score band', value: input.creditSummary.scoreBand, source: 'creditPull.scoreBand' })
    }

    return {
      summary:
        outcome === 'QUALIFIED'
          ? 'Every configured rule passes on the evidence currently on file.'
          : outcome === 'NOT_QUALIFIED'
            ? `${failed.length} rule${failed.length === 1 ? '' : 's'} fail on the evidence currently on file.`
            : `${unknown.length} rule${unknown.length === 1 ? '' : 's'} cannot be evaluated until more evidence arrives.`,
      facts,
      inferences: [{ label: 'Suggested outcome', value: outcome.replace(/_/g, ' ').toLowerCase() }],
      recommendation: { outcome },
      confidence: outcome === 'NEEDS_MORE_INFO' ? 45 : Math.max(55, 92 - unknown.length * 10),
      reasons: input.rules.map((r) => ({
        factor: r.label,
        detail: r.passed === null ? `Not evaluable — ${r.detail}` : r.passed ? `Pass — ${r.detail}` : `Fail — ${r.detail}`,
      })),
      missingInformation: missing,
      complianceFlags: [
        {
          level: 'info',
          text: 'This is a recommendation only. A named reviewer must record the qualification decision.',
        },
      ],
      provider: this.name,
      model: this.model,
    }
  }

  async recommendCloser(input: AssignmentInput): Promise<AIAnalysis> {
    const scored = scoreCandidates(input)
    const eligible = scored.filter((s) => s.disqualifiers.length === 0)
    const winner = eligible[0] ?? scored[0]

    if (!winner) {
      return {
        summary: 'No closer is available for this client.',
        facts: [],
        inferences: [],
        recommendation: {},
        confidence: 0,
        reasons: [],
        missingInformation: [{ key: 'candidates', label: 'No candidate closers matched the filters' }],
        complianceFlags: [],
        provider: this.name,
        model: this.model,
      }
    }

    return {
      summary: `${winner.candidate.name} scores highest for this client (${winner.score} of 100).`,
      facts: [
        { label: 'Client region', value: input.client.regionName ?? '—', source: 'client.region' },
        { label: 'Preferred language', value: input.client.preferredLanguage, source: 'client.preferredLanguage' },
        { label: 'Candidates considered', value: String(scored.length), source: 'assignment.candidates' },
      ],
      inferences: [
        { label: 'Runner-up', value: eligible[1]?.candidate.name ?? '—' },
        { label: 'Eligible closers', value: `${eligible.length} of ${scored.length}` },
      ],
      recommendation: {
        closerId: winner.candidate.id,
        closerName: winner.candidate.name,
        score: winner.score,
        ranking: scored.slice(0, 5).map((s) => ({
          id: s.candidate.id,
          name: s.candidate.name,
          score: s.score,
          disqualifiers: s.disqualifiers,
        })),
      },
      confidence: assignmentConfidence(eligible.length ? eligible : scored),
      reasons: winner.factors.map((f) => ({
        factor: f.factor,
        detail: `${f.detail} (${f.points}/${f.max})`,
      })),
      missingInformation: [],
      complianceFlags: winner.disqualifiers.length
        ? [{ level: 'review', text: `Best available candidate has blockers: ${winner.disqualifiers.join('; ')}` }]
        : [],
      provider: this.name,
      model: this.model,
    }
  }

  async draftFollowUp(input: { clientName: string; language: string; context: string }): Promise<AIAnalysis> {
    const first = input.clientName.split(' ')[0]
    const body =
      input.language === 'es'
        ? `Hola ${first}, le escribo para dar seguimiento. ${input.context} ¿Cuándo le queda bien que hablemos?`
        : `Hi ${first}, following up on your file. ${input.context} When is a good time to talk?`

    return {
      summary: 'Draft follow-up message prepared for review.',
      facts: [{ label: 'Language', value: input.language, source: 'client.preferredLanguage' }],
      inferences: [],
      recommendation: { draft: body },
      confidence: 70,
      reasons: [{ factor: 'Tone', detail: 'Short, direct, one clear ask' }],
      missingInformation: [],
      complianceFlags: [
        { level: 'info', text: 'Review before sending. Drafts are never delivered automatically.' },
      ],
      provider: this.name,
      model: this.model,
    }
  }
  // ── Client assists (P2) ────────────────────────────────────────────────────
  // All deterministic: same context in, same output out — no clock, no RNG.

  async summarizeLead(context: AssistContext): Promise<LeadSummaryResult> {
    const { client, contracts, creditSummary, engagement } = context
    const facts: AIFact[] = [
      { label: 'Stage', value: client.stageName, source: 'client.currentStage' },
      { label: 'Preferred contact', value: client.preferredContact, source: 'client.preferredContact' },
    ]
    const contract = contracts[0]
    if (contract) {
      facts.push({ label: 'Counterparty', value: contract.counterparty, source: 'contract.counterparty' })
      if (contract.monthlyAmount !== null) {
        facts.push({ label: 'Monthly payment', value: money(contract.monthlyAmount)!, source: 'contract.monthlyAmount' })
      }
      if (contract.termMonths) {
        facts.push({ label: 'Term', value: `${contract.termMonths} months`, source: 'contract.termMonths' })
      }
    }
    if (creditSummary?.scoreBand) {
      facts.push({ label: 'Credit score band', value: creditSummary.scoreBand, source: 'creditPull.scoreBand' })
    }
    if (client.city && client.state) {
      facts.push({ label: 'Location', value: `${client.city}, ${client.state}`, source: 'client.address' })
    }

    const requiredDocs = context.documents.filter((d) => d.required)
    const approvedDocs = requiredDocs.filter((d) => d.status === 'APPROVED')
    const openers = [
      'Here is where this file stands.',
      'Current state of the record, in brief.',
      'Snapshot of the file as it stands today.',
    ]
    const summary = [
      openers[hashOf(context) % openers.length],
      ` ${client.firstName} ${client.lastName} is at "${client.stageName}"`,
      contract
        ? ` with a ${contract.productType ?? 'agreement'} through ${contract.counterparty}${
            contract.monthlyAmount !== null ? ` at ${money(contract.monthlyAmount)} per month` : ''
          }.`
        : ' with no contract on file yet.',
      requiredDocs.length ? ` Documents: ${approvedDocs.length} of ${requiredDocs.length} required approved.` : '',
      context.surveyComplete ? ' Survey is complete.' : ' Survey is not finished.',
      ` ${engagement.communicationsCount} recorded interaction${engagement.communicationsCount === 1 ? '' : 's'}`,
      engagement.lastInboundAt ? `, last reply ${engagement.lastInboundAt.slice(0, 10)}.` : ', no reply yet.',
      context.fieldConflicts.length
        ? ` ${context.fieldConflicts.length} cross-source mismatch${context.fieldConflicts.length === 1 ? '' : 'es'} worth a look.`
        : '',
    ].join('')

    return {
      summary,
      facts,
      confidence: Math.max(40, Math.min(95, 55 + facts.length * 6 - context.fieldConflicts.length * 5)),
    }
  }

  async summarizeDocument(text: string, type: string): Promise<DocumentSummaryResult> {
    const clean = text.replace(/\s+/g, ' ').trim()
    const sentences = clean.split(/(?<=[.!?])\s+/).filter((s) => s.length > 12)
    const keyPoints = sentences
      .filter((s, i) => i === 0 || /\d/.test(s))
      .slice(0, 5)
      .map((s) => (s.length > 160 ? `${s.slice(0, 157)}…` : s))
    const words = clean ? clean.split(' ').length : 0
    return {
      summary: clean
        ? `${type ? `${type} document` : 'Document'} of roughly ${words} words. ${
            sentences[0] ? (sentences[0].length > 200 ? `${sentences[0].slice(0, 197)}…` : sentences[0]) : ''
          }`.trim()
        : 'The document contains no readable text.',
      keyPoints,
    }
  }

  async suggestNextActions(context: AssistContext): Promise<NextActionsResult> {
    const actions: NextActionSuggestion[] = []
    const ungranted = context.consents.filter((c) => !c.granted)
    const requiredPending = context.documents.filter((d) => d.required && d.status !== 'APPROVED')
    const lastInbound = context.engagement.lastInboundAt ? Date.parse(context.engagement.lastInboundAt) : null
    const daysSinceReply =
      lastInbound === null ? null : Math.floor((Date.parse(context.client.lastActivityAt) - lastInbound) / 86_400_000)

    if (context.fieldConflicts.length) {
      actions.push({
        title: `Resolve ${context.fieldConflicts.length} data mismatch${context.fieldConflicts.length === 1 ? '' : 'es'}`,
        reason: 'The record, verified documents and intake answers disagree on at least one field.',
        dueInDays: 1,
        priority: 'HIGH',
      })
    }
    if (ungranted.length) {
      actions.push({
        title: `Capture consent: ${ungranted.map((c) => c.type.toLowerCase().replace(/_/g, ' ')).join(', ')}`,
        reason: 'Consent is missing, which blocks outreach or the credit review downstream.',
        dueInDays: 1,
        priority: 'HIGH',
      })
    }
    if (!context.surveyComplete) {
      actions.push({
        title: 'Finish the intake survey',
        reason: 'The survey is incomplete and everything downstream depends on it.',
        dueInDays: 2,
        priority: 'HIGH',
      })
    }
    if (
      context.creditSummary &&
      context.creditSummary.status !== 'COMPLETED' &&
      context.consents.some((c) => c.type === 'SOFT_CREDIT_PULL' && c.granted)
    ) {
      actions.push({
        title: 'Run the soft credit pull',
        reason: 'Consent is on file but no completed credit summary exists yet.',
        dueInDays: 2,
        priority: 'NORMAL',
      })
    }
    if (requiredPending.length) {
      actions.push({
        title: `Chase ${requiredPending.length} outstanding document${requiredPending.length === 1 ? '' : 's'}`,
        reason: `Still not approved: ${requiredPending.slice(0, 3).map((d) => d.name).join(', ')}${
          requiredPending.length > 3 ? '…' : ''
        }.`,
        dueInDays: 3,
        priority: 'NORMAL',
      })
    }
    if (daysSinceReply === null || daysSinceReply > 7) {
      actions.push({
        title: daysSinceReply === null ? 'Make first contact' : `Re-engage — no reply in ${daysSinceReply} days`,
        reason:
          daysSinceReply === null
            ? 'No inbound reply has ever been recorded for this client.'
            : 'The conversation has gone quiet; a short check-in keeps the file moving.',
        dueInDays: 2,
        priority: 'NORMAL',
      })
    }
    if (actions.length === 0) {
      actions.push({
        title: 'Book the presentation',
        reason: 'Nothing is outstanding on this file — it is ready for the next stage.',
        dueInDays: 3,
        priority: 'NORMAL',
      })
    }
    return { actions: actions.slice(0, 4) }
  }

  async draftMessage(context: AssistContext, channel: AssistChannel, intent: string): Promise<MessageDraftResult> {
    const first = context.client.firstName
    const es = context.client.preferredLanguage === 'es'
    const signoff = context.client.ownerName ? `\n\n${es ? 'Saludos' : 'Best'},\n${context.client.ownerName}` : ''
    const pendingDocs = context.documents.filter((d) => d.required && d.status !== 'APPROVED')

    let subject: string | undefined
    let body: string
    switch (intent) {
      case 'documents':
        subject = es ? 'Documentos pendientes de su expediente' : 'A few documents still needed'
        body = es
          ? `Hola ${first}, para avanzar con su expediente todavía necesitamos ${pendingDocs.length || 'algunos'} documento(s). ¿Puede enviarlos cuando tenga oportunidad?`
          : `Hi ${first}, to keep your file moving we still need ${pendingDocs.length || 'a few'} document${pendingDocs.length === 1 ? '' : 's'}. Could you send ${pendingDocs.length === 1 ? 'it' : 'them'} over when you get a chance?`
        break
      case 're_engage':
        subject = es ? 'Seguimos aquí para ayudarle' : 'Checking in on your file'
        body = es
          ? `Hola ${first}, hace tiempo que no hablamos y su expediente sigue abierto. ¿Le queda bien una llamada breve esta semana?`
          : `Hi ${first}, it has been a little while and your file is still open on our side. Would a quick call this week work for you?`
        break
      case 'appointment':
        subject = es ? 'Confirmemos su cita' : 'Confirming your appointment'
        body = es
          ? `Hola ${first}, le escribo para confirmar nuestra próxima cita. Si el horario ya no le funciona, dígame y lo movemos.`
          : `Hi ${first}, just confirming our upcoming appointment. If the time no longer works, let me know and we will move it.`
        break
      default:
        subject = es ? 'Seguimiento de su expediente' : 'Following up on your file'
        body = es
          ? `Hola ${first}, le escribo para dar seguimiento a su expediente (etapa: ${context.client.stageName}). ¿Cuándo le queda bien que hablemos?`
          : `Hi ${first}, following up on your file (currently at "${context.client.stageName}"). When is a good time to talk?`
    }
    body += channel === 'SMS' ? '' : signoff
    return channel === 'EMAIL' ? { subject, body } : { body }
  }

  async findDiscrepancies(context: AssistContext): Promise<DiscrepanciesResult> {
    const HIGH = new Set(['email', 'phone', 'monthly payment', 'monthly amount'])
    const MEDIUM = new Set(['first name', 'last name', 'name', 'address', 'city', 'state', 'postal code', 'term'])
    return {
      discrepancies: context.fieldConflicts.map((c) => {
        const key = c.field.toLowerCase()
        const severity = HIGH.has(key) ? ('high' as const) : MEDIUM.has(key) ? ('medium' as const) : ('low' as const)
        return {
          field: c.field,
          a: `${c.a.source}: ${c.a.value}`,
          b: `${c.b.source}: ${c.b.value}`,
          severity,
          note:
            severity === 'high'
              ? `The ${c.field} differs between ${c.a.source} and ${c.b.source}. Confirm which is current before any send or submission uses it.`
              : `The ${c.field} on ${c.a.source} does not match ${c.b.source}. Worth confirming with the client.`,
        }
      }),
    }
  }

  async assessQualification(context: AssistContext): Promise<QualificationSignalsResult> {
    const signals: QualificationSignal[] = []
    const creditConsent = context.consents.some((c) => c.type === 'SOFT_CREDIT_PULL' && c.granted)
    const anyUngranted = context.consents.filter((c) => !c.granted)
    signals.push(
      creditConsent
        ? { label: 'Credit-pull consent', direction: 'positive', note: 'Soft-pull consent is on file.' }
        : {
            label: 'Credit-pull consent',
            direction: 'negative',
            note: 'No soft-pull consent recorded — the credit review cannot proceed yet.',
          },
    )
    if (anyUngranted.length) {
      signals.push({
        label: 'Other consents',
        direction: 'negative',
        note: `Not granted: ${anyUngranted.map((c) => c.type.toLowerCase().replace(/_/g, ' ')).join(', ')}.`,
      })
    }

    const required = context.documents.filter((d) => d.required)
    const approved = required.filter((d) => d.status === 'APPROVED')
    signals.push(
      required.length === 0
        ? { label: 'Documents', direction: 'neutral', note: 'No required documents configured yet.' }
        : approved.length === required.length
          ? { label: 'Documents', direction: 'positive', note: `All ${required.length} required documents approved.` }
          : {
              label: 'Documents',
              direction: approved.length === 0 ? 'negative' : 'neutral',
              note: `${approved.length} of ${required.length} required documents approved.`,
            },
    )

    signals.push(
      context.creditSummary?.status === 'COMPLETED'
        ? {
            label: 'Credit review',
            direction: 'neutral',
            note: `Completed${context.creditSummary.scoreBand ? ` — score band ${context.creditSummary.scoreBand} on file for the reviewer` : ''}.`,
          }
        : {
            label: 'Credit review',
            direction: 'negative',
            note: `Status: ${(context.creditSummary?.status ?? 'NOT_REQUESTED').toLowerCase().replace(/_/g, ' ')}.`,
          },
    )

    const lastInbound = context.engagement.lastInboundAt ? Date.parse(context.engagement.lastInboundAt) : null
    const ref = Date.parse(context.client.lastActivityAt)
    const days = lastInbound === null ? null : Math.floor((ref - lastInbound) / 86_400_000)
    signals.push(
      days !== null && days <= 7
        ? { label: 'Engagement', direction: 'positive', note: `Client replied within the last ${Math.max(days, 1)} day(s).` }
        : days === null
          ? { label: 'Engagement', direction: 'negative', note: 'No inbound reply recorded yet.' }
          : {
              label: 'Engagement',
              direction: days > 21 ? 'negative' : 'neutral',
              note: `Last reply ${days} days before the latest activity.`,
            },
    )

    signals.push(
      context.surveyComplete
        ? { label: 'Intake survey', direction: 'positive', note: 'Survey completed.' }
        : { label: 'Intake survey', direction: 'negative', note: 'Survey not finished.' },
    )

    return {
      signals,
      caveat:
        'These signals summarize evidence already on file to inform your review. They are not a qualification decision and set no threshold — only a named reviewer can make that call.',
    }
  }

  // ── Close-rate operations (Phase 1-3) ──────────────────────────────────────
  // Both delegate to the pure engine in close-scoring.ts: fully deterministic
  // and explainable — the same file always produces the same score and brief.

  async scoreCloseProbability(context: AssistContext): Promise<CloseScoreResult> {
    const { probability, reasons, confidence } = computeCloseScore(context)
    return { probability, reasons, confidence }
  }

  async generateCloserBrief(context: AssistContext): Promise<CloserBriefContent> {
    return composeCloserBrief(context)
  }

  // ── Insight engine (Prodigy Engine) ────────────────────────────────────────

  /**
   * Deterministic insight proposals: fixed thresholds over the supplied KPIs
   * and snippets — no clock, no RNG, so the same input always yields the same
   * insights. The learning loop is honored the same way the real model is
   * asked to: anything the org previously DISMISSED (same kind + title) is
   * never proposed again.
   */
  async generateInsights(input: GenerateInsightsInput): Promise<GenerateInsightsResult> {
    const { kpis, snippets, priorFeedback } = input

    /** Finite number at `key`, looked up flat then under kpis.core / kpis.marketing. */
    const metric = (key: string): number | null => {
      for (const scope of [kpis, kpis.core, kpis.marketing]) {
        if (scope && typeof scope === 'object') {
          const v = (scope as Record<string, unknown>)[key]
          if (typeof v === 'number' && Number.isFinite(v)) return v
        }
      }
      return null
    }
    /** Up to two citations from the named sources, falling back to any snippet. */
    const cite = (...sources: string[]): InsightCitation[] => {
      const hits = snippets.filter((s) => sources.includes(s.source)).slice(0, 2)
      return hits.length > 0 ? hits : snippets.slice(0, 1)
    }
    const clampScore = (n: number) => Math.max(5, Math.min(95, Math.round(n)))

    const proposals: InsightProposal[] = []

    const closeRate = metric('closeRate')
    const won = metric('won')
    const lost = metric('lost')
    if (closeRate !== null && closeRate < 25) {
      proposals.push({
        kind: 'pipeline',
        title: 'Close rate is below 25%',
        body: `The close rate is ${closeRate}%${won !== null && lost !== null ? ` (${won} won vs ${lost} lost)` : ''}. Review the loss reasons on file and the stages where files stall to find the biggest recoverable segment.`,
        evidence: cite('clients', 'pastInsights'),
        score: clampScore(80 - closeRate),
      })
    }

    const speed = metric('medianSpeedToContactHours')
    if (speed !== null && speed > 24) {
      proposals.push({
        kind: 'engagement',
        title: 'Speed-to-contact exceeds 24 hours',
        body: `Median time from lead creation to first contact is ${Math.round(speed)} hours. Leads contacted within a day convert measurably better — tighten first-touch assignment and follow-up tasks.`,
        evidence: cite('clients', 'communications'),
        score: clampScore(40 + Math.min(40, speed / 4)),
      })
    }

    if (won !== null && lost !== null && lost > won && lost > 0) {
      proposals.push({
        kind: 'pipeline',
        title: 'Losses are outpacing wins',
        body: `${lost} files closed lost against ${won} won in this snapshot. The recorded loss reasons point at where intervention pays off first.`,
        evidence: cite('clients'),
        score: clampScore(50 + (lost - won) * 5),
      })
    }

    const costPerLead = metric('costPerLead')
    if (costPerLead !== null && costPerLead > 100) {
      proposals.push({
        kind: 'marketing',
        title: 'Cost per lead is above $100',
        body: `Paid campaigns are averaging $${costPerLead.toFixed(2)} per lead over the last 30 days. Compare per-campaign cost efficiency and shift budget toward the campaigns producing qualified files, not just clicks.`,
        evidence: cite('metrics'),
        score: clampScore(40 + Math.min(45, costPerLead / 10)),
      })
    }

    const atRisk = snippets.filter((s) => s.source === 'clients' && s.ref.startsWith('client:'))
    if (atRisk.length > 0) {
      proposals.push({
        kind: 'risk',
        title: `${atRisk.length} file${atRisk.length === 1 ? ' is' : 's are'} over stage SLA`,
        body: `${atRisk.length} active file${atRisk.length === 1 ? '' : 's'} sit${atRisk.length === 1 ? 's' : ''} past the configured stage SLA. Each cited file names the stage, the overage, and the owner to nudge.`,
        evidence: atRisk.slice(0, 3),
        score: clampScore(45 + atRisk.length * 8),
      })
    }

    if (proposals.length === 0 && snippets.length > 0) {
      proposals.push({
        kind: 'operations',
        title: 'No KPI anomalies in this scan',
        body: 'Every monitored KPI is inside its threshold in this snapshot. The cited evidence summarizes the current pipeline state for reference.',
        evidence: snippets.slice(0, 2),
        score: 10,
      })
    }

    // The learning loop, deterministically: a previously dismissed (kind, title)
    // is never proposed again.
    const dismissed = new Set(
      priorFeedback
        .filter((f) => f.status === 'DISMISSED')
        .map((f) => insightDedupeKey(f.kind, f.title)),
    )
    return {
      insights: proposals
        .filter((p) => !dismissed.has(insightDedupeKey(p.kind, p.title)))
        .slice(0, 8),
    }
  }
}

/** Small deterministic hash so mock phrasing varies by input but never by run. */
function hashOf(input: unknown): number {
  const s = JSON.stringify(input)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
