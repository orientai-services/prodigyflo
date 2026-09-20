import 'server-only'
import { isSyntheticClient } from '@/lib/intake/synthetic'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { can, clientScope, findClientInScope, ForbiddenError, type SessionUser } from '@/lib/rbac'
import { normaliseEmail, normalisePhone } from '@/lib/dedupe'
import { getAIProvider } from './index'
import type {
  AIComplianceFlag,
  AIFact,
  AIReason,
  AssistChannel,
  AssistContext,
  AssistFieldConflict,
  DiscrepancyFinding,
  NextActionSuggestion,
  QualificationSignal,
} from './provider'

/**
 * Client assists: summaries, next actions, cross-source discrepancy checks and
 * qualification signals. Every run persists an AIRecommendation in
 * PENDING_REVIEW; nothing touches client data until a named human accepts it,
 * and even then the only side effects are Tasks and internal Notes.
 */

export type AssistKind = 'summary' | 'next_actions' | 'discrepancies' | 'qualification'

const ASSIST_TYPE: Record<AssistKind, 'ONBOARDING_ANALYSIS' | 'NEXT_BEST_ACTION' | 'QUALIFICATION'> = {
  summary: 'ONBOARDING_ANALYSIS',
  next_actions: 'NEXT_BEST_ACTION',
  discrepancies: 'ONBOARDING_ANALYSIS',
  qualification: 'QUALIFICATION',
}

export const ASSIST_LABEL: Record<AssistKind, string> = {
  summary: 'Lead summary',
  next_actions: 'Suggested next actions',
  discrepancies: 'Discrepancy check',
  qualification: 'Qualification signals',
}

// ─── Serialized view (safe to hand to client components as `import type`) ────

export type AssistView = {
  id: string
  kind: AssistKind
  label: string
  status: 'PENDING_REVIEW' | 'ACCEPTED' | 'OVERRIDDEN' | 'DISMISSED'
  provider: string
  model: string | null
  summary: string | null
  confidence: number | null
  facts: AIFact[]
  reasons: AIReason[]
  complianceFlags: AIComplianceFlag[]
  actions: NextActionSuggestion[]
  discrepancies: DiscrepancyFinding[]
  signals: QualificationSignal[]
  caveat: string | null
  createdAt: string
  reviewedByName: string | null
  reviewedAt: string | null
}

type RecRow = Prisma.AIRecommendationGetPayload<{ include: { reviewer: { select: { name: true } } } }>

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** Maps a stored row to the view, or null when the row is not an assist run. */
export function toAssistView(row: RecRow): AssistView | null {
  const rec = (row.recommendation ?? {}) as Record<string, unknown>
  const kind = rec.kind as AssistKind | undefined
  if (!kind || !(kind in ASSIST_TYPE)) return null
  return {
    id: row.id,
    kind,
    label: ASSIST_LABEL[kind],
    status: row.status,
    provider: row.provider,
    model: row.model,
    summary: row.summary,
    confidence: row.confidence,
    facts: asArray<AIFact>(row.facts),
    reasons: asArray<AIReason>(row.reasons),
    complianceFlags: asArray<AIComplianceFlag>(row.complianceFlags),
    actions: asArray<NextActionSuggestion>(rec.actions),
    discrepancies: asArray<DiscrepancyFinding>(rec.discrepancies),
    signals: asArray<QualificationSignal>(rec.signals),
    caveat: typeof rec.caveat === 'string' ? rec.caveat : null,
    createdAt: row.createdAt.toISOString(),
    reviewedByName: row.reviewer?.name ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  }
}

/** Assist runs for one client, newest first, scope-checked. */
export async function listAssistViews(user: SessionUser, clientId: string, take = 30): Promise<AssistView[]> {
  const rows = await db.aIRecommendation.findMany({
    where: { clientId, client: clientScope(user) },
    include: { reviewer: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take,
  })
  return rows.map(toAssistView).filter((v): v is AssistView => v !== null)
}

// ─── Cross-source field diffing (pure, rule-based) ───────────────────────────

export type SourcedValue = { field: string; source: string; value: string }

function normalizeFieldValue(field: string, value: string): string {
  const f = field.toLowerCase()
  if (f.includes('email')) return normaliseEmail(value)
  if (f.includes('phone')) return normalisePhone(value)
  if (f.includes('payment') || f.includes('amount') || f.includes('term') || f.includes('escalator')) {
    const n = Number(String(value).replace(/[^0-9.-]/g, ''))
    return Number.isFinite(n) ? String(n) : String(value).trim().toLowerCase()
  }
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Groups sourced values by field, normalizes them per field type, and emits one
 * conflict per disagreeing source pair. Formatting-only differences (phone
 * punctuation, email case, "$185.00" vs "185") are not conflicts.
 */
export function computeFieldConflicts(values: SourcedValue[]): AssistFieldConflict[] {
  const byField = new Map<string, SourcedValue[]>()
  for (const v of values) {
    if (!v.value || !v.value.trim()) continue
    const list = byField.get(v.field) ?? []
    list.push(v)
    byField.set(v.field, list)
  }

  const conflicts: AssistFieldConflict[] = []
  for (const [field, list] of byField) {
    const groups = new Map<string, SourcedValue>()
    for (const v of list) {
      const norm = normalizeFieldValue(field, v.value)
      if (!norm) continue
      if (!groups.has(norm)) groups.set(norm, v)
    }
    const distinct = [...groups.values()]
    if (distinct.length < 2) continue
    const [first, ...rest] = distinct
    for (const other of rest) {
      conflicts.push({
        field,
        a: { source: first.source, value: first.value },
        b: { source: other.source, value: other.value },
      })
    }
  }
  return conflicts
}

// ─── Context builder (read-only) ─────────────────────────────────────────────

const num = (d: Prisma.Decimal | number | null | undefined): number | null =>
  d === null || d === undefined ? null : Number(d)

/** Builds the shared read-only evidence bundle every assist runs against. */
export async function buildAssistContext(user: SessionUser, clientId: string): Promise<AssistContext | null> {
  const inScope = await findClientInScope(user, clientId)
  if (!inScope || await isSyntheticClient(clientId)) return null

  const client = await db.client.findUniqueOrThrow({
    where: { id: clientId },
    include: {
    addresses: { orderBy: { isPrimary: 'desc' as const } },
    consents: { orderBy: { grantedAt: 'desc' as const } },
    owner: { select: { name: true } },
    currentStage: { select: { name: true } },
    contracts: { orderBy: { createdAt: 'desc' as const } },
    creditPulls: { orderBy: { createdAt: 'desc' as const }, take: 1 },
    surveyResponses: { where: { survey: { name: { not: 'ProdigyFlo Final Questionnaire' } } }, orderBy: { updatedAt: 'desc' as const }, take: 1 },
    intakeSubmissions: {
      orderBy: { createdAt: 'desc' as const },
      take: 5,
      include: { source: { select: { name: true } } },
    },
      documents: {
        include: {
          requirement: { select: { name: true, isRequired: true, isAttorneyRequired: true } },
          extractions: {
            where: { status: 'COMPLETED' as const },
            orderBy: { createdAt: 'desc' as const },
            take: 1,
            include: { fields: true },
          },
        },
      },
    },
  })

  const [communicationsCount, lastInbound, lastOutbound, openTasks, notesCount] = await Promise.all([
    db.communication.count({ where: { clientId: client.id } }),
    db.communication.findFirst({
      where: { clientId: client.id, direction: 'INBOUND' },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    }),
    db.communication.findFirst({
      where: { clientId: client.id, direction: 'OUTBOUND' },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    }),
    db.task.count({ where: { clientId: client.id, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
    db.note.count({ where: { clientId: client.id } }),
  ])

  // Latest consent row per type decides its state (same convention as messaging).
  const consentByType = new Map<string, boolean>()
  for (const c of client.consents) {
    if (!consentByType.has(c.type)) consentByType.set(c.type, c.granted && !c.revokedAt)
  }

  const primary = client.addresses.find((a) => a.isPrimary) ?? client.addresses[0]
  const survey = client.surveyResponses[0] ?? null
  const credit = client.creditPulls[0] ?? null
  const contract = client.contracts[0] ?? null

  const verifiedFields: AssistContext['verifiedFields'] = []
  for (const doc of client.documents) {
    const extraction = doc.extractions[0]
    if (!extraction) continue
    const docName = doc.requirement?.name ?? doc.label ?? doc.fileName ?? 'document'
    for (const f of extraction.fields) {
      if (f.verification !== 'VERIFIED' && f.verification !== 'CORRECTED') continue
      const value = (f.verification === 'CORRECTED' ? f.correctedValue : null) ?? f.normalizedValue ?? f.value
      if (!value) continue
      verifiedFields.push({ key: f.key, label: f.label, value, verification: f.verification, documentName: docName })
    }
  }

  const intakeValues: AssistContext['intakeValues'] = []
  for (const sub of client.intakeSubmissions) {
    const mapped = (sub.mappedPayload ?? {}) as Record<string, unknown>
    const source = `intake (${sub.source?.name ?? 'submission'})`
    for (const key of ['firstName', 'lastName', 'email', 'phone'] as const) {
      const value = mapped[key]
      if (typeof value === 'string' && value.trim()) intakeValues.push({ source, key, value })
    }
  }

  // Cross-source comparison rows. Sources: the client record, human-verified
  // document extractions, and what came in at intake.
  const sourced: SourcedValue[] = [
    { field: 'first name', source: 'client record', value: client.firstName },
    { field: 'last name', source: 'client record', value: client.lastName },
    { field: 'name', source: 'client record', value: `${client.firstName} ${client.lastName}` },
    { field: 'email', source: 'client record', value: client.email },
    { field: 'phone', source: 'client record', value: client.phone },
  ]
  if (primary) sourced.push({ field: 'address', source: 'client record', value: primary.line1 })
  if (contract?.monthlyAmount != null) {
    sourced.push({ field: 'monthly payment', source: 'contract on file', value: String(num(contract.monthlyAmount)) })
  }
  if (contract?.termMonths != null) {
    sourced.push({ field: 'term', source: 'contract on file', value: String(contract.termMonths) })
  }

  const EXTRACT_FIELD: Record<string, string> = {
    full_name: 'name',
    monthly_payment: 'monthly payment',
    term_months: 'term',
    service_address: 'address',
  }
  for (const f of verifiedFields) {
    const field = EXTRACT_FIELD[f.key]
    if (field) sourced.push({ field, source: `verified document (${f.documentName})`, value: f.value })
  }

  const INTAKE_FIELD: Record<string, string> = {
    firstName: 'first name',
    lastName: 'last name',
    email: 'email',
    phone: 'phone',
  }
  for (const v of intakeValues) {
    const field = INTAKE_FIELD[v.key]
    if (field) sourced.push({ field, source: v.source, value: v.value })
  }

  // Survey answers can also carry a self-reported monthly amount.
  const answers = (survey?.answers ?? {}) as Record<string, unknown>
  const surveyMonthly = Number(answers.monthlyAmount ?? answers.monthly_payment ?? NaN)
  if (Number.isFinite(surveyMonthly)) {
    sourced.push({ field: 'monthly payment', source: 'intake survey', value: String(surveyMonthly) })
  }

  return {
    client: {
      id: client.id,
      firstName: client.firstName,
      lastName: client.lastName,
      email: client.email,
      phone: client.phone,
      preferredLanguage: client.preferredLanguage,
      preferredContact: client.preferredContact,
      stageName: client.currentStage.name,
      city: primary?.city ?? null,
      state: primary?.state ?? null,
      estimatedValue: num(client.estimatedValue),
      ownerName: client.owner?.name ?? null,
      createdAt: client.createdAt.toISOString(),
      lastActivityAt: client.lastActivityAt.toISOString(),
    },
    contracts: client.contracts.map((c) => ({
      counterparty: c.counterparty,
      productType: c.productType,
      monthlyAmount: num(c.monthlyAmount),
      termMonths: c.termMonths,
      escalatorPct: num(c.escalatorPct),
      signedAt: c.signedAt?.toISOString() ?? null,
    })),
    documents: client.documents.map((d) => ({
      name: d.requirement?.name ?? d.label ?? d.fileName ?? 'Document',
      status: d.status,
      required: d.requirement?.isRequired ?? false,
      isAttorneyRequired: d.requirement?.isAttorneyRequired ?? false,
    })),
    creditSummary: credit
      ? {
          status: credit.status,
          scoreBand: credit.scoreBand,
          monthlyObligations: num(credit.monthlyObligations),
          derogatoryMarks: credit.derogatoryMarks,
        }
      : null,
    consents: [...consentByType.entries()].map(([type, granted]) => ({ type, granted })),
    surveyComplete: survey?.status === 'COMPLETED',
    survey: survey ? (survey.answers as Record<string, unknown>) : null,
    engagement: {
      communicationsCount,
      lastInboundAt: lastInbound?.occurredAt.toISOString() ?? null,
      lastOutboundAt: lastOutbound?.occurredAt.toISOString() ?? null,
      openTasks,
      notes: notesCount,
    },
    verifiedFields,
    intakeValues,
    fieldConflicts: computeFieldConflicts(sourced),
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

export type RunAssistResult =
  | { ok: true; item: AssistView }
  | { ok: false; error: string }

export async function runAssist(user: SessionUser, input: { clientId: string; kind: AssistKind }): Promise<RunAssistResult> {
  if (!can(user, 'ai:run')) throw new ForbiddenError('You do not have permission to run AI analysis.')

  const context = await buildAssistContext(user, input.clientId)
  if (!context) return { ok: false, error: 'Client not found or out of your scope.' }

  const provider = getAIProvider()
  let data: {
    summary: string
    confidence: number | null
    facts: AIFact[]
    reasons: AIReason[]
    complianceFlags: AIComplianceFlag[]
    recommendation: Record<string, unknown>
  }

  switch (input.kind) {
    case 'summary': {
      const r = await provider.summarizeLead(context)
      data = {
        summary: r.summary,
        confidence: Math.round(r.confidence),
        facts: r.facts,
        reasons: [
          { factor: 'Evidence', detail: `${r.facts.length} sourced fact${r.facts.length === 1 ? '' : 's'} from the record` },
        ],
        complianceFlags: [],
        recommendation: { kind: 'summary' },
      }
      break
    }
    case 'next_actions': {
      const r = await provider.suggestNextActions(context)
      data = {
        summary: `${r.actions.length} suggested action${r.actions.length === 1 ? '' : 's'} awaiting your review.`,
        confidence: null,
        facts: [],
        reasons: r.actions.map((a) => ({ factor: a.title, detail: a.reason })),
        complianceFlags: [
          { level: 'info', text: 'Accepting creates tasks for a person to work. Nothing runs automatically.' },
        ],
        recommendation: { kind: 'next_actions', actions: r.actions },
      }
      break
    }
    case 'discrepancies': {
      const r = await provider.findDiscrepancies(context)
      const n = r.discrepancies.length
      data = {
        summary:
          n === 0
            ? 'No cross-source discrepancies found. The record, verified documents and intake answers agree.'
            : `${n} discrepanc${n === 1 ? 'y' : 'ies'} found between the record, verified documents and intake answers.`,
        confidence: null,
        facts: [],
        reasons: r.discrepancies.map((d) => ({ factor: d.field, detail: d.note })),
        complianceFlags: r.discrepancies.some((d) => d.severity === 'high')
          ? [{ level: 'review', text: 'At least one high-severity mismatch involves contact or payment data.' }]
          : [],
        recommendation: { kind: 'discrepancies', discrepancies: r.discrepancies },
      }
      break
    }
    case 'qualification': {
      const r = await provider.assessQualification(context)
      data = {
        summary: 'Qualification signals compiled from the evidence on file — these inform your review, not replace it.',
        confidence: null,
        facts: [],
        reasons: r.signals.map((s) => ({ factor: s.label, detail: s.note })),
        complianceFlags: [{ level: 'info', text: r.caveat }],
        recommendation: { kind: 'qualification', signals: r.signals, caveat: r.caveat },
      }
      break
    }
  }

  const row = await db.aIRecommendation.create({
    data: {
      clientId: input.clientId,
      type: ASSIST_TYPE[input.kind],
      status: 'PENDING_REVIEW',
      provider: provider.name,
      model: provider.model,
      summary: data.summary,
      confidence: data.confidence,
      facts: data.facts as unknown as Prisma.InputJsonValue,
      reasons: data.reasons as unknown as Prisma.InputJsonValue,
      complianceFlags: data.complianceFlags as unknown as Prisma.InputJsonValue,
      recommendation: data.recommendation as Prisma.InputJsonValue,
    },
    include: { reviewer: { select: { name: true } } },
  })

  await recordAudit(user, {
    action: 'ai.assist.run',
    entityType: 'AIRecommendation',
    entityId: row.id,
    summary: `Ran ${ASSIST_LABEL[input.kind]} (${provider.name}) for client ${context.client.firstName} ${context.client.lastName}`,
  })

  const view = toAssistView(row)
  if (!view) return { ok: false, error: 'The analysis could not be stored.' }
  return { ok: true, item: view }
}

// ─── Review (accept / dismiss) ───────────────────────────────────────────────

export type ReviewAssistResult =
  | { ok: true; effect: 'tasks_created' | 'note_pinned' | 'recorded'; count: number }
  | { ok: false; error: string }

export async function reviewAssist(
  user: SessionUser,
  input: { recommendationId: string; decision: 'accept' | 'dismiss' },
): Promise<ReviewAssistResult> {
  if (!can(user, 'ai:review')) throw new ForbiddenError('You do not have permission to review AI recommendations.')

  const rec = await db.aIRecommendation.findFirst({
    where: { id: input.recommendationId, client: clientScope(user) },
    include: {
      client: { select: { id: true, ownerId: true, firstName: true, lastName: true } },
      reviewer: { select: { name: true } },
    },
  })
  if (!rec) return { ok: false, error: 'Recommendation not found or out of your scope.' }

  const view = toAssistView(rec)
  if (!view && (rec.recommendation as Record<string, unknown> | null)?.kind !== 'draft') {
    return { ok: false, error: 'This recommendation is not reviewable here.' }
  }

  // Claim the row atomically so side effects run exactly once, even under
  // concurrent clicks: only the request that flips PENDING_REVIEW wins.
  const claimed = await db.aIRecommendation.updateMany({
    where: { id: rec.id, status: 'PENDING_REVIEW' },
    data: {
      status: input.decision === 'accept' ? 'ACCEPTED' : 'DISMISSED',
      reviewedById: user.id,
      reviewedAt: new Date(),
    },
  })
  if (claimed.count === 0) return { ok: false, error: 'This recommendation was already reviewed.' }

  const clientName = `${rec.client.firstName} ${rec.client.lastName}`

  if (input.decision === 'dismiss') {
    await recordAudit(user, {
      action: 'ai.assist.dismissed',
      entityType: 'AIRecommendation',
      entityId: rec.id,
      summary: `Dismissed ${view?.label ?? 'AI draft'} for client ${clientName}`,
    })
    return { ok: true, effect: 'recorded', count: 0 }
  }

  // Accept side effects — human-gated by definition of reaching this line.
  let effect: 'tasks_created' | 'note_pinned' | 'recorded' = 'recorded'
  let count = 0
  const provenance = `Created from an AI suggestion accepted by ${user.name}.`

  if (view?.kind === 'next_actions' && view.actions.length > 0) {
    const created = await db.task.createMany({
      data: view.actions.map((a) => ({
        clientId: rec.client.id,
        assigneeId: rec.client.ownerId ?? user.id,
        createdById: user.id,
        title: a.title,
        description: `${a.reason}\n\n${provenance}`,
        priority: a.priority,
        dueAt: new Date(Date.now() + Math.max(0, a.dueInDays) * 86_400_000),
      })),
    })
    effect = 'tasks_created'
    count = created.count
  } else if (view?.kind === 'summary') {
    const factLines = view.facts.length
      ? `\n\nKey facts:\n${view.facts.map((f) => `• ${f.label}: ${f.value}`).join('\n')}`
      : ''
    await db.note.create({
      data: {
        clientId: rec.client.id,
        authorId: user.id,
        body: `AI summary (accepted by ${user.name}):\n${view.summary ?? ''}${factLines}`,
        isInternal: true,
        pinned: true,
      },
    })
    effect = 'note_pinned'
    count = 1
  } else if (view?.kind === 'discrepancies' && view.discrepancies.length > 0) {
    const lines = view.discrepancies
      .map((d) => `• ${d.field} [${d.severity}] — ${d.a} vs ${d.b}. ${d.note}`)
      .join('\n')
    await db.task.create({
      data: {
        clientId: rec.client.id,
        assigneeId: rec.client.ownerId ?? user.id,
        createdById: user.id,
        title: `Resolve ${view.discrepancies.length} data discrepanc${view.discrepancies.length === 1 ? 'y' : 'ies'}`,
        description: `${lines}\n\n${provenance}`,
        priority: 'HIGH',
        dueAt: new Date(Date.now() + 86_400_000),
      },
    })
    effect = 'tasks_created'
    count = 1
  }
  // 'qualification' and drafts record the review only — no side effects.

  await recordAudit(user, {
    action: 'ai.assist.accepted',
    entityType: 'AIRecommendation',
    entityId: rec.id,
    summary: `Accepted ${view?.label ?? 'AI draft'} for client ${clientName}${
      effect === 'tasks_created' ? ` — created ${count} task${count === 1 ? '' : 's'}` : effect === 'note_pinned' ? ' — pinned summary note' : ''
    }`,
  })

  return { ok: true, effect, count }
}

// ─── Message drafting ────────────────────────────────────────────────────────

export type DraftAssistResult =
  | { ok: true; draft: { subject: string | null; body: string }; recommendationId: string; mock: boolean }
  | { ok: false; error: string }

export async function runDraftAssist(
  user: SessionUser,
  input: { clientId: string; channel: AssistChannel; intent: string },
): Promise<DraftAssistResult> {
  if (!can(user, 'ai:run')) throw new ForbiddenError('You do not have permission to run AI analysis.')

  const context = await buildAssistContext(user, input.clientId)
  if (!context) return { ok: false, error: 'Client not found or out of your scope.' }

  const provider = getAIProvider()
  const draft = await provider.draftMessage(context, input.channel, input.intent)

  const row = await db.aIRecommendation.create({
    data: {
      clientId: input.clientId,
      type: 'FOLLOW_UP_DRAFT',
      status: 'PENDING_REVIEW',
      provider: provider.name,
      model: provider.model,
      summary: `Draft ${input.channel === 'EMAIL' ? 'email' : 'SMS'} (${input.intent.replace(/_/g, ' ')}) prepared for review.`,
      confidence: null,
      recommendation: {
        kind: 'draft',
        channel: input.channel,
        intent: input.intent,
        subject: draft.subject ?? null,
        body: draft.body,
      } as Prisma.InputJsonValue,
      complianceFlags: [
        { level: 'info', text: 'A person reviews and sends this draft. It is never delivered automatically.' },
      ] as unknown as Prisma.InputJsonValue,
    },
  })

  await recordAudit(user, {
    action: 'ai.assist.draft',
    entityType: 'AIRecommendation',
    entityId: row.id,
    summary: `Drafted ${input.channel} (${input.intent}) via ${provider.name} for client ${context.client.firstName} ${context.client.lastName}`,
  })

  return {
    ok: true,
    draft: { subject: draft.subject ?? null, body: draft.body },
    recommendationId: row.id,
    mock: provider.name === 'mock',
  }
}
