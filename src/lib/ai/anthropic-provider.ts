import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import type {
  AIAnalysis,
  AIProvider,
  AssignmentInput,
  AssistChannel,
  AssistContext,
  CloseScoreResult,
  CloserBriefContent,
  DiscrepanciesResult,
  DocumentSummaryResult,
  LeadSummaryResult,
  MessageDraftResult,
  NextActionsResult,
  OnboardingInput,
  QualificationInput,
  QualificationSignalsResult,
} from './provider'
import { scoreCandidates } from './scoring'

const MODEL = process.env.AI_MODEL || 'claude-opus-5'

/**
 * The shape every analysis comes back in. `facts` are constrained by the system
 * prompt to values present in the supplied record; anything the model derives
 * belongs in `inferences`, so a reviewer can always tell the two apart.
 */
const analysisSchema = z.object({
  summary: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.string(), source: z.string() })),
  inferences: z.array(z.object({ label: z.string(), value: z.string() })),
  confidence: z.number().min(0).max(100),
  reasons: z.array(z.object({ factor: z.string(), detail: z.string() })),
  missingInformation: z.array(z.object({ key: z.string(), label: z.string() })),
  complianceFlags: z.array(
    z.object({ level: z.enum(['info', 'review', 'blocker']), text: z.string() }),
  ),
})

const onboardingSchema = analysisSchema.extend({
  nextBestAction: z.string(),
  prepBrief: z.string(),
})

const qualificationSchema = analysisSchema.extend({
  recommendedOutcome: z.enum(['QUALIFIED', 'NOT_QUALIFIED', 'NEEDS_MORE_INFO']),
})

const assignmentSchema = analysisSchema.extend({
  chosenCloserId: z.string(),
  rationale: z.string(),
})

const followUpSchema = analysisSchema.extend({ draft: z.string() })

// ── Client-assist schemas (P2) ────────────────────────────────────────────────

const leadSummarySchema = z.object({
  summary: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.string(), source: z.string() })),
  confidence: z.number().min(0).max(100),
})

const documentSummarySchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()).max(8),
})

const nextActionsSchema = z.object({
  actions: z.array(
    z.object({
      title: z.string(),
      reason: z.string(),
      dueInDays: z.number().int().min(0).max(30),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
    }),
  ),
})

const messageDraftSchema = z.object({
  subject: z.string().nullable(),
  body: z.string(),
})

const discrepanciesSchema = z.object({
  discrepancies: z.array(
    z.object({
      field: z.string(),
      a: z.string(),
      b: z.string(),
      severity: z.enum(['low', 'medium', 'high']),
      note: z.string(),
    }),
  ),
})

const closeScoreSchema = z.object({
  probability: z.number().min(0).max(100),
  reasons: z.array(z.string()).min(1).max(10),
  confidence: z.enum(['low', 'medium', 'high']),
})

const closerBriefSchema = z.object({
  situation: z.string(),
  highlights: z.array(z.string()).max(8),
  objections: z.array(z.object({ objection: z.string(), response: z.string() })).max(5),
  talkingPoints: z.array(z.string()).max(6),
  recommendedNextStep: z.string(),
})

const qualificationSignalsSchema = z.object({
  signals: z.array(
    z.object({
      label: z.string(),
      direction: z.enum(['positive', 'negative', 'neutral']),
      note: z.string(),
    }),
  ),
  caveat: z.string(),
})

const SYSTEM = `You assist a regulated sales-operations team.

Hard rules, in priority order:
1. Never invent information. Every entry in "facts" must restate a value present
   in the supplied record, and its "source" must name the field it came from.
   Anything you derive, estimate, or judge goes in "inferences" instead.
2. You never make the final decision on credit, financing, qualification, or any
   legal matter. You produce a recommendation for a named human to accept or
   override. Say so in complianceFlags when the topic is one of those.
3. If evidence is missing, add it to missingInformation rather than guessing.
4. Flag anything a compliance reviewer should see: missing consent, a language
   mismatch between the sale and the paperwork, or contradictions between two
   sources in the record.
5. Be concise and specific. No filler, no hedging boilerplate.`

export class AnthropicAIProvider implements AIProvider {
  readonly name = 'anthropic'
  readonly model = MODEL

  private client = new Anthropic()

  private async run<T extends z.ZodType>(
    schema: T,
    prompt: string,
  ): Promise<{ parsed: z.infer<T>; promptTokens: number; completionTokens: number }> {
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: zodOutputFormat(schema as unknown as z.ZodObject<z.ZodRawShape>),
      },
      messages: [{ role: 'user', content: prompt }],
    })

    if (response.stop_reason === 'refusal') {
      throw new Error(`Model declined the request (${response.stop_details?.category ?? 'unspecified'}).`)
    }
    if (!response.parsed_output) {
      throw new Error('Model response did not match the expected schema.')
    }

    return {
      parsed: response.parsed_output as z.infer<T>,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    }
  }

  private toAnalysis(
    parsed: z.infer<typeof analysisSchema>,
    recommendation: Record<string, unknown>,
    tokens: { promptTokens: number; completionTokens: number },
  ): AIAnalysis {
    return {
      summary: parsed.summary,
      facts: parsed.facts,
      inferences: parsed.inferences,
      recommendation,
      confidence: Math.round(parsed.confidence),
      reasons: parsed.reasons,
      missingInformation: parsed.missingInformation,
      complianceFlags: parsed.complianceFlags,
      provider: this.name,
      model: this.model,
      promptTokens: tokens.promptTokens,
      completionTokens: tokens.completionTokens,
    }
  }

  async analyzeOnboarding(input: OnboardingInput): Promise<AIAnalysis> {
    const { parsed, ...tokens } = await this.run(
      onboardingSchema,
      `Review this client file and prepare the closer.\n\n${JSON.stringify(input, null, 2)}`,
    )
    return this.toAnalysis(parsed, { nextBestAction: parsed.nextBestAction, prepBrief: parsed.prepBrief }, tokens)
  }

  async recommendQualification(input: QualificationInput): Promise<AIAnalysis> {
    const { parsed, ...tokens } = await this.run(
      qualificationSchema,
      `Evaluate this client against the configured qualification rules. Recommend an outcome; a human reviewer decides.\n\n${JSON.stringify(input, null, 2)}`,
    )
    return this.toAnalysis(parsed, { outcome: parsed.recommendedOutcome }, tokens)
  }

  async recommendCloser(input: AssignmentInput): Promise<AIAnalysis> {
    // Scoring stays deterministic and auditable; the model explains the result
    // and may flag a consideration the weights do not capture.
    const scored = scoreCandidates(input)
    const eligible = scored.filter((s) => s.disqualifiers.length === 0)
    const ranked = (eligible.length ? eligible : scored).slice(0, 5)

    if (ranked.length === 0) {
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

    const { parsed, ...tokens } = await this.run(
      assignmentSchema,
      `Deterministic scoring has already ranked these closers. Explain the top choice, or argue for a different one from the same list if the scoring missed something. Never propose a closer outside the list.\n\n${JSON.stringify(
        { client: input.client, ranked: ranked.map((r) => ({ ...r.candidate, score: r.score, factors: r.factors })) },
        null,
        2,
      )}`,
    )

    // The model may only pick from the ranked list; anything else falls back
    // to the deterministic winner.
    const chosen = ranked.find((r) => r.candidate.id === parsed.chosenCloserId) ?? ranked[0]

    return this.toAnalysis(
      parsed,
      {
        closerId: chosen.candidate.id,
        closerName: chosen.candidate.name,
        score: chosen.score,
        rationale: parsed.rationale,
        ranking: ranked.map((r) => ({
          id: r.candidate.id,
          name: r.candidate.name,
          score: r.score,
          disqualifiers: r.disqualifiers,
        })),
      },
      tokens,
    )
  }

  async draftFollowUp(input: { clientName: string; language: string; context: string }): Promise<AIAnalysis> {
    const { parsed, ...tokens } = await this.run(
      followUpSchema,
      `Draft a short follow-up message to ${input.clientName} in language "${input.language}". Context: ${input.context}. One clear ask, no pressure tactics, no promises about outcomes.`,
    )
    return this.toAnalysis(parsed, { draft: parsed.draft }, tokens)
  }

  // ── Client assists (P2) ────────────────────────────────────────────────────

  async summarizeLead(context: AssistContext): Promise<LeadSummaryResult> {
    const { parsed } = await this.run(
      leadSummarySchema,
      `Summarize this client file in a short paragraph for the staff member who owns it. Facts must restate supplied values with their source field.\n\n${JSON.stringify(context, null, 2)}`,
    )
    return { summary: parsed.summary, facts: parsed.facts, confidence: Math.round(parsed.confidence) }
  }

  async summarizeDocument(text: string, type: string): Promise<DocumentSummaryResult> {
    const { parsed } = await this.run(
      documentSummarySchema,
      `Summarize this ${type || 'uploaded'} document for a case reviewer and list its key points (amounts, dates, parties, obligations). Only state what the text contains.\n\n---\n${text.slice(0, 24_000)}`,
    )
    return { summary: parsed.summary, keyPoints: parsed.keyPoints }
  }

  async suggestNextActions(context: AssistContext): Promise<NextActionsResult> {
    const { parsed } = await this.run(
      nextActionsSchema,
      `Suggest up to 4 concrete next actions for the staff member working this client file. Each needs a title, the evidence-based reason, a dueInDays (0-30) and a priority. Suggestions only — a human reviews and accepts them before any task is created.\n\n${JSON.stringify(context, null, 2)}`,
    )
    return { actions: parsed.actions.slice(0, 4) }
  }

  async draftMessage(context: AssistContext, channel: AssistChannel, intent: string): Promise<MessageDraftResult> {
    const { parsed } = await this.run(
      messageDraftSchema,
      `Draft a short outbound ${channel} message to the client (intent: "${intent}"), written in their preferred language ("${context.client.preferredLanguage}"). One clear ask, no pressure tactics, no promises about outcomes, no legal or financial advice. ${
        channel === 'SMS' ? 'Keep it under 320 characters and omit the subject (null).' : 'Include a concise subject.'
      } The draft is reviewed by a human before sending.\n\n${JSON.stringify(context, null, 2)}`,
    )
    return channel === 'EMAIL' ? { subject: parsed.subject ?? undefined, body: parsed.body } : { body: parsed.body }
  }

  async findDiscrepancies(context: AssistContext): Promise<DiscrepanciesResult> {
    // Rule-based diffing already found the raw conflicts; the model grades and
    // annotates them. It may not invent a conflict absent from fieldConflicts.
    if (context.fieldConflicts.length === 0) return { discrepancies: [] }
    const { parsed } = await this.run(
      discrepanciesSchema,
      `These cross-source field conflicts were found by deterministic comparison of the client record, human-verified document extractions and intake submissions. For each, restate the two sourced values, grade the severity and note what the reviewer should confirm. Report ONLY conflicts from the supplied list — never add new ones.\n\n${JSON.stringify(
        { client: context.client, fieldConflicts: context.fieldConflicts },
        null,
        2,
      )}`,
    )
    return { discrepancies: parsed.discrepancies.slice(0, context.fieldConflicts.length) }
  }

  async assessQualification(context: AssistContext): Promise<QualificationSignalsResult> {
    const { parsed } = await this.run(
      qualificationSignalsSchema,
      `List qualification-relevant signals grounded in this client file: consents present, required-document approval progress, credit review status, engagement recency, survey completion. Each signal is evidence with a direction, never a verdict. You are informing a human review — do not compute a score, threshold, or pass/fail outcome, and say so in the caveat.\n\n${JSON.stringify(context, null, 2)}`,
    )
    return { signals: parsed.signals, caveat: parsed.caveat }
  }

  // ── Close-rate operations (Phase 1-3) ──────────────────────────────────────

  async scoreCloseProbability(context: AssistContext): Promise<CloseScoreResult> {
    const { parsed } = await this.run(
      closeScoreSchema,
      `Estimate the probability (0-100) that this client file closes, as a PRIORITIZATION signal for the call queue — it is never a qualification, eligibility, or close decision; a human makes those. Weigh: funnel stage depth, required-document completeness, survey completion, consents granted, credit review status and band, engagement volume and reply recency, unresolved cross-source field conflicts, and whether a contract is on file. Ground every reason in a supplied value (strongest influence first). Avoid 0 and 100 — a score is not a verdict. Set confidence by how much of the file is actually populated.\n\n${JSON.stringify(context, null, 2)}`,
    )
    return {
      probability: Math.min(97, Math.max(2, Math.round(parsed.probability))),
      reasons: parsed.reasons,
      confidence: parsed.confidence,
    }
  }

  async generateCloserBrief(context: AssistContext): Promise<CloserBriefContent> {
    const { parsed } = await this.run(
      closerBriefSchema,
      `Write a pre-call Closer Brief for the staff member about to call this client. Sections: "situation" (one short paragraph of where the file stands, grounded in supplied values only); "highlights" (the concrete numbers and facts to have at hand — payment, escalator, term, credit band, location, data mismatches to verify); "objections" (likely objections with a grounded response for each — reference their actual contract terms, never invent figures); "talkingPoints" (how to run the call, including language preference and any survey/consent/document items to close live); "recommendedNextStep" (the single most important thing to accomplish on or right after the call). No pressure tactics, no promises about outcomes, no legal or financial advice. The brief informs the human closer — it decides nothing.\n\n${JSON.stringify(context, null, 2)}`,
    )
    return {
      situation: parsed.situation,
      highlights: parsed.highlights,
      objections: parsed.objections,
      talkingPoints: parsed.talkingPoints,
      recommendedNextStep: parsed.recommendedNextStep,
    }
  }

}
