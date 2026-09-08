import 'server-only'

/**
 * AI provider boundary.
 *
 * Everything the application asks of a model goes through this interface, so the
 * rest of the codebase never imports a vendor SDK. With no API key configured the
 * deterministic mock provider runs instead, which keeps the whole app testable.
 *
 * Two rules hold for every implementation:
 *   1. `facts` may only restate values that were passed in. Nothing is invented.
 *   2. The model never returns a final decision — only a recommendation that a
 *      named human accepts or overrides.
 */

export type AIFact = { label: string; value: string; source: string }
export type AIInference = { label: string; value: string }
export type AIReason = { factor: string; detail: string }
export type AIMissing = { key: string; label: string }
export type AIComplianceFlag = { level: 'info' | 'review' | 'blocker'; text: string }

export type AIAnalysis = {
  summary: string
  facts: AIFact[]
  inferences: AIInference[]
  recommendation: Record<string, unknown>
  confidence: number
  reasons: AIReason[]
  missingInformation: AIMissing[]
  complianceFlags: AIComplianceFlag[]
  provider: string
  model: string | null
  promptTokens?: number
  completionTokens?: number
}

export type OnboardingInput = {
  client: {
    firstName: string
    lastName: string
    preferredLanguage: string
    preferredContact: string
    city: string | null
    state: string | null
    stageName: string
  }
  survey: Record<string, unknown> | null
  surveyComplete: boolean
  contracts: {
    counterparty: string
    productType: string | null
    monthlyAmount: number | null
    termMonths: number | null
    escalatorPct: number | null
    signedAt: string | null
  }[]
  documents: { name: string; status: string; required: boolean }[]
  creditSummary: {
    status: string
    scoreBand: string | null
    monthlyObligations: number | null
    derogatoryMarks: number | null
  } | null
  consents: { type: string; granted: boolean }[]
  communicationsCount: number
}

export type QualificationInput = OnboardingInput & {
  rules: { key: string; label: string; passed: boolean | null; detail: string }[]
  householdIncome: number | null
  monthlyObligations: number | null
}

export type CloserCandidate = {
  id: string
  name: string
  regionName: string | null
  teamName: string | null
  languages: string[]
  licensedIn: string[]
  specialties: string[]
  activeClients: number
  capacity: number
  closeRatePct: number | null
  sampleSize: number
  lastAssignedAt: string | null
}

export type AssignmentInput = {
  client: {
    firstName: string
    lastName: string
    preferredLanguage: string
    regionName: string | null
    state: string | null
    leadSourceName: string | null
    estimatedValue: number | null
  }
  candidates: CloserCandidate[]
}

export interface AIProvider {
  readonly name: string
  readonly model: string | null
  analyzeOnboarding(input: OnboardingInput): Promise<AIAnalysis>
  recommendQualification(input: QualificationInput): Promise<AIAnalysis>
  recommendCloser(input: AssignmentInput): Promise<AIAnalysis>
  draftFollowUp(input: { clientName: string; language: string; context: string }): Promise<AIAnalysis>

  // Client assists (P2). Types are declared at the bottom of this file.
  summarizeLead(context: AssistContext): Promise<LeadSummaryResult>
  summarizeDocument(text: string, type: string): Promise<DocumentSummaryResult>
  suggestNextActions(context: AssistContext): Promise<NextActionsResult>
  draftMessage(context: AssistContext, channel: AssistChannel, intent: string): Promise<MessageDraftResult>
  findDiscrepancies(context: AssistContext): Promise<DiscrepanciesResult>
  assessQualification(context: AssistContext): Promise<QualificationSignalsResult>

  // Close-rate operations (Phase 1-3 model). Types at the bottom of this file.
  /** Probability-to-close as a PRIORITIZATION signal (0-100). Humans decide. */
  scoreCloseProbability(context: AssistContext): Promise<CloseScoreResult>
  /** Pre-call Closer Brief: situation, highlights, objections, talking points. */
  generateCloserBrief(context: AssistContext): Promise<CloserBriefContent>

  // Insight engine (Prodigy Engine). Types at the bottom of this file.
  /**
   * Org-level insight proposals from KPIs + retrieved evidence, conditioned on
   * prior human feedback (what was accepted vs dismissed, and why). Every
   * proposal persists as a PENDING_REVIEW Insight a named human reviews —
   * nothing acts on its own. Evidence may only cite the supplied snippets.
   */
  generateInsights(input: GenerateInsightsInput): Promise<GenerateInsightsResult>
}

export function isAIConfigured(): boolean {
  return process.env.AI_PROVIDER === 'anthropic' && Boolean(process.env.ANTHROPIC_API_KEY)
}

// ─────────────────────────────────────────────────────────────
// Client assists (P2). One shared read-only context feeds every
// assist so each provider sees the same evidence.
// ─────────────────────────────────────────────────────────────

/** Two sourced values for the same field that do not agree. Computed by
 *  rule-based diffing in `assists.ts`; providers may only report or annotate
 *  these — never invent a conflict that is not in the list. */
export type AssistFieldConflict = {
  field: string
  a: { source: string; value: string }
  b: { source: string; value: string }
}

export type AssistContext = {
  client: {
    id: string
    firstName: string
    lastName: string
    email: string
    phone: string
    preferredLanguage: string
    preferredContact: string
    stageName: string
    city: string | null
    state: string | null
    estimatedValue: number | null
    ownerName: string | null
    createdAt: string
    lastActivityAt: string
  }
  contracts: {
    counterparty: string
    productType: string | null
    monthlyAmount: number | null
    termMonths: number | null
    escalatorPct: number | null
    signedAt: string | null
  }[]
  documents: { name: string; status: string; required: boolean; isAttorneyRequired: boolean }[]
  creditSummary: {
    status: string
    scoreBand: string | null
    monthlyObligations: number | null
    derogatoryMarks: number | null
  } | null
  consents: { type: string; granted: boolean }[]
  surveyComplete: boolean
  survey: Record<string, unknown> | null
  engagement: {
    communicationsCount: number
    lastInboundAt: string | null
    lastOutboundAt: string | null
    openTasks: number
    notes: number
  }
  /** Human-verified or corrected document extractions only. */
  verifiedFields: { key: string; label: string; value: string; verification: string; documentName: string }[]
  /** Values the client (or an integration) submitted at intake. */
  intakeValues: { source: string; key: string; value: string }[]
  /** Rule-based cross-source diffs, precomputed from the record. */
  fieldConflicts: AssistFieldConflict[]
}

export type LeadSummaryResult = { summary: string; facts: AIFact[]; confidence: number }
export type DocumentSummaryResult = { summary: string; keyPoints: string[] }
export type NextActionSuggestion = {
  title: string
  reason: string
  dueInDays: number
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
}
export type NextActionsResult = { actions: NextActionSuggestion[] }
export type MessageDraftResult = { subject?: string; body: string }
export type DiscrepancyFinding = {
  field: string
  a: string
  b: string
  severity: 'low' | 'medium' | 'high'
  note: string
}
export type DiscrepanciesResult = { discrepancies: DiscrepancyFinding[] }
export type QualificationSignal = {
  label: string
  direction: 'positive' | 'negative' | 'neutral'
  note: string
}
export type QualificationSignalsResult = { signals: QualificationSignal[]; caveat: string }

export type AssistChannel = 'EMAIL' | 'SMS'

// ─────────────────────────────────────────────────────────────
// Close-rate operations (Phase 1-3 model)
// ─────────────────────────────────────────────────────────────

/**
 * Probability-to-close. Explicitly a prioritization signal: it orders the call
 * queue and feeds dashboards; it never decides qualification, eligibility, or
 * the close — a human does.
 */
export type CloseScoreResult = {
  /** 0-100. Providers should avoid the extremes — a score is not a verdict. */
  probability: number
  /** Human-readable factors behind the number, strongest first. */
  reasons: string[]
  confidence: 'low' | 'medium' | 'high'
}

export type CloserBriefObjection = { objection: string; response: string }

// ─────────────────────────────────────────────────────────────
// Insight engine (Prodigy Engine)
// ─────────────────────────────────────────────────────────────

export const INSIGHT_KINDS = [
  'pipeline',
  'marketing',
  'engagement',
  'documents',
  'operations',
  'risk',
] as const
export type InsightKind = (typeof INSIGHT_KINDS)[number]

/** One retrieval citation. Same shape as RetrievalSnippet — it persists on the
 *  Insight row as evidence, so a reviewer can trace every claim to a source. */
export type InsightCitation = { source: string; ref: string; text: string }

export type InsightProposal = {
  kind: InsightKind
  title: string
  body: string
  /** Citations copied from the supplied snippets — never invented. */
  evidence: InsightCitation[]
  /** 0-100 relative importance for review ordering. Not a decision. */
  score: number
}

/** A previously reviewed insight with the human's verdict — the learning loop. */
export type PriorInsightFeedback = {
  kind: string
  title: string
  status: 'ACCEPTED' | 'DISMISSED'
  reviewNote: string | null
  /** Measured after-effects, when the accepted insight has had time to land. */
  outcome: unknown
}

export type GenerateInsightsInput = {
  /** Org KPI snapshot (core pipeline metrics + marketing summary). */
  kpis: Record<string, unknown>
  /** Retrieved, cited evidence — the only material insights may cite. */
  snippets: InsightCitation[]
  /** What the org accepted vs dismissed before, with notes and outcomes. */
  priorFeedback: PriorInsightFeedback[]
}

export type GenerateInsightsResult = { insights: InsightProposal[] }

/** The pre-call brief a closer reads before dialing. */
export type CloserBriefContent = {
  situation: string
  highlights: string[]
  objections: CloserBriefObjection[]
  talkingPoints: string[]
  recommendedNextStep: string
}
