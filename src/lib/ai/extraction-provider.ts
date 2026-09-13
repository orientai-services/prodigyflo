import 'server-only'
import { isAIConfigured } from './provider'
import type { DocTypeSpec } from '@/lib/extraction/spec'
import type { VisionImageInput, VisionPdfInput } from '@/lib/extraction/vision'
import { extractFieldsFromText, type ParsedField } from '@/lib/extraction/parse'

/**
 * Structured-field extraction provider. Same contract as the rest of
 * `src/lib/ai`: with no API key the deterministic mock runs, and either way
 * the output is a RECOMMENDATION — every value lands as an UNVERIFIED
 * ExtractedField that a human must verify, correct, or reject.
 *
 * Image documents follow the same provenance contract as text: the Anthropic
 * path sends the image itself as a content block and may only report values
 * literally visible in it; the mock refuses to read images entirely rather
 * than invent text.
 */

export type FieldExtractionInput = {
  docType: DocTypeSpec
  pages: string[]
  fileName: string | null
  /** Present when the document is a model-readable image (see extraction/vision.ts). */
  image?: VisionImageInput | null
  /** Present for an image-only PDF that needs the model's document vision. */
  pdf?: VisionPdfInput | null
}

export type FieldExtractionResult = {
  fields: ParsedField[]
  summary: string
  provider: string
  model: string | null
  promptTokens?: number
  completionTokens?: number
}

export interface DocumentFieldExtractor {
  readonly name: string
  readonly model: string | null
  extractFields(input: FieldExtractionInput): Promise<FieldExtractionResult>
}

class MockFieldExtractor implements DocumentFieldExtractor {
  readonly name = 'mock'
  readonly model = null

  async extractFields({ docType, pages, image, pdf }: FieldExtractionInput): Promise<FieldExtractionResult> {
    // The mock has no OCR and refuses to pretend otherwise: an image yields
    // one empty field per spec key, and the summary says why.
    if (image || pdf) {
      return {
        fields: extractFieldsFromText(docType, []),
        summary:
          'This document needs vision OCR, which is not available in mock mode — nothing was read. A reviewer must enter the field values using the Correct action.',
        provider: this.name,
        model: this.model,
      }
    }

    const fields = extractFieldsFromText(docType, pages)
    const found = fields.filter((f) => f.value !== null).length
    return {
      fields,
      summary:
        docType.fields.length === 0
          ? `No field specification exists for "${docType.label}" — nothing was extracted.`
          : `Deterministic (mock) extraction read ${found} of ${docType.fields.length} ${docType.label.toLowerCase()} fields from the document text.`,
      provider: this.name,
      model: this.model,
    }
  }
}

class AnthropicFieldExtractor implements DocumentFieldExtractor {
  readonly name = 'anthropic'
  readonly model = process.env.AI_MODEL || 'claude-opus-5'

  async extractFields(input: FieldExtractionInput): Promise<FieldExtractionResult> {
    const { docType, pages, image, pdf } = input
    if (pages.length === 0 && !image && !pdf) {
      return new MockFieldExtractor().extractFields(input)
    }

    // Imported lazily so the SDK never loads in mock-only deployments.
    const { default: Anthropic } = (await import('@anthropic-ai/sdk')) as typeof import('@anthropic-ai/sdk')
    const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod')
    const { z } = await import('zod')

    const schema = z.object({
      summary: z.string(),
      fields: z.array(
        z.object({
          key: z.string(),
          value: z.string().nullable(),
          confidence: z.number().min(0).max(100),
          sourcePage: z.number().nullable(),
          sourceSnippet: z.string().nullable(),
        }),
      ),
    })

    // A document run must never hold a client file in PROCESSING indefinitely.
    // The bounded worker retries a recorded failure on a later cycle.
    const client = new Anthropic({ timeout: 90_000, maxRetries: 1 })
    const numbered = pages.map((p, i) => `--- page ${i + 1} ---\n${p}`).join('\n\n').slice(0, 60_000)
    const requestText = `Document type: ${docType.label}\nRequested fields:\n${docType.fields
      .map((f) => `- ${f.key}: ${f.label} (${f.kind})`)
      .join('\n')}\n\n${
      image || pdf
        ? 'The document is attached. Read only text that is literally visible in it; sourcePage is the page containing the value and sourceSnippet is the exact visible text the value came from.'
        : `Document text:\n${numbered}`
    }`
    // For images the document itself travels as a base64 content block ahead
    // of the instructions; the provenance rules are identical either way.
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } }
      | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
    > = image
      ? [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: requestText },
        ]
      : pdf
        ? [
            { type: 'document', source: { type: 'base64', media_type: pdf.mediaType, data: pdf.base64 } },
            { type: 'text', text: requestText },
          ]
      : [{ type: 'text', text: requestText }]

    const response = await client.messages.parse({
      model: this.model,
      max_tokens: 8000,
      system: `You extract structured fields from a document for a regulated sales-operations team.
Hard rules:
1. A "value" must be text literally present in the document (or literally visible in the document image). Never infer, normalize into new facts, or guess. Absent means value: null with confidence 0.
2. "sourceSnippet" is the exact line the value came from; "sourcePage" its page number (1 for a single image).
3. Confidence reflects how unambiguous the reading is, 0-100.
4. Return one entry per requested key, in order. You are producing a recommendation for a human reviewer, never final data.`,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: zodOutputFormat(schema),
      },
      messages: [{ role: 'user', content }],
    })

    if (response.stop_reason === 'refusal') {
      throw new Error(`Model declined the request (${response.stop_details?.category ?? 'unspecified'}).`)
    }
    if (!response.parsed_output) throw new Error('Model response did not match the expected schema.')

    const parsed = response.parsed_output as import('zod').infer<typeof schema>
    const byKey = new Map(parsed.fields.map((f) => [f.key, f]))
    // Only spec keys survive; anything else the model volunteered is dropped.
    const fields: ParsedField[] = docType.fields.map((specField) => {
      const got = byKey.get(specField.key)
      const value = got?.value?.trim() || null
      return {
        key: specField.key,
        label: specField.label,
        value: value?.slice(0, 200) ?? null,
        confidence: value ? Math.round(Math.min(100, Math.max(0, got?.confidence ?? 0))) : 0,
        sourcePage: got?.sourcePage ?? null,
        sourceSnippet: got?.sourceSnippet?.slice(0, 160) ?? null,
      }
    })

    return {
      fields,
      summary: parsed.summary,
      provider: this.name,
      model: this.model,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    }
  }
}

let cached: DocumentFieldExtractor | null = null

export function getFieldExtractor(): DocumentFieldExtractor {
  if (cached) return cached
  cached = isAIConfigured() ? new AnthropicFieldExtractor() : new MockFieldExtractor()
  return cached
}
