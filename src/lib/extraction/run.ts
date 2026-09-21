import 'server-only'
import { isSyntheticClient } from '@/lib/intake/synthetic'
import type { DocumentStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { getFileStorage } from '@/lib/storage'
import { getFieldExtractor } from '@/lib/ai/extraction-provider'
import { getTextExtractor } from './text'
import { visionImageFor, visionPdfFor } from './vision'
import {
  computeConflictNotes,
  computeMissingFieldKeys,
  detectDocumentType,
  documentStatusAfterExtraction,
  specForType,
  type ClientSnapshot,
} from './spec'

/**
 * The extraction pipeline for one uploaded document version.
 *
 * PENDING -> RUNNING -> COMPLETED | FAILED, with the document sitting at
 * PROCESSING while the run is in flight. Extraction rows are append-only: a
 * re-run creates a new DocumentExtraction, never mutates a completed one.
 *
 * No database transaction is held across the model call — the row states are
 * the checkpoint, not a transaction.
 */

const MAX_RAW_TEXT = 400_000

export type ExtractionRunResult = {
  extractionId: string
  status: 'COMPLETED' | 'FAILED' | 'PENDING'
  documentStatus: DocumentStatus
  missingFieldKeys: string[]
  error?: string
}

export async function runExtraction(documentId: string): Promise<ExtractionRunResult> {
  if(process.env.DOCUMENT_ANALYZER==='records') {
    const {enqueueStaffAnalysis}=await import('@/lib/records-analyzer/staff-jobs')
    return enqueueStaffAnalysis(documentId)
  }
  const doc = await db.clientDocument.findUnique({
    where: { id: documentId },
    include: {
      requirement: { select: { key: true, category: true } },
      externalImport: { select: { sourceDocumentType: true } },
      client: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          addresses: { where: { isPrimary: true }, take: 1, select: { line1: true, city: true, state: true } },
        },
      },
    },
  })
  if (!doc) throw new Error('Document not found.')
  if (await isSyntheticClient(doc.clientId)) throw new Error('Synthetic case: paid extraction blocked')
  if (!doc.storageKey || !doc.mimeType) throw new Error('Document has no stored file to extract from.')

  const provider = getFieldExtractor()
  const extraction = await db.documentExtraction.create({
    data: { documentId: doc.id, status: 'PENDING', provider: provider.name, model: provider.model },
  })
  const statusBefore = doc.status

  try {
    if (doc.externalImport?.sourceDocumentType === 'public_record_summary') {
      throw new Error('This file is a generated public-record search reference, not an official record. Fact extraction is disabled; open the reference or upload the actual source document for review.')
    }
    await db.clientDocument.update({ where: { id: doc.id }, data: { status: 'PROCESSING' } })
    await db.documentExtraction.update({
      where: { id: extraction.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    })

    const buf = await getFileStorage().get(doc.storageKey)
    const textExtractor = getTextExtractor(doc.mimeType)
    if (!textExtractor) throw new Error(`No text extractor supports "${doc.mimeType}".`)

    const text = await textExtractor.extract(buf)
    const joined = text.pages.join('\n\n')

    // Vision path: a model-readable image travels to the field extractor as a
    // base64 content block (the mock still refuses to read it). Unsupported or
    // oversized images keep the honest no-OCR behavior with a reason attached.
    const vision = visionImageFor(buf, doc.mimeType)
    // Scans and signed-form overlays need the original PDF so filled values
    // remain associated with their labels instead of detached text-layer order.
    const pdf = text.needsVision || !joined.trim() ? visionPdfFor(buf, doc.mimeType) : null
    const visionUsed = (vision.image !== null || pdf !== null) && provider.name !== 'mock'

    const detection = detectDocumentType({
      text: joined,
      fileName: doc.fileName,
      requirementKey: doc.requirement?.key ?? doc.label ?? null,
    })
    const spec = detection.spec

    // Keep source diagnostics even when provider configuration or OCR fails.
    await db.documentExtraction.update({
      where: { id: extraction.id },
      data: {
        detectedTypeKey: spec.key, detectedTypeLabel: spec.label, typeConfidence: detection.confidence,
        pageCount: text.pageCount, rawText: joined.slice(0, MAX_RAW_TEXT) || null, warnings: text.warnings,
      },
    })
    if ((pdf || vision.image) && provider.name === 'mock') throw new Error('This document requires vision OCR, but only the mock processor is configured. Enable a live document provider and retry; the original file is preserved.')
    if (!joined.trim() && !pdf && !vision.image) throw new Error(vision.reason ?? 'No readable document content was found. Upload a readable original and retry.')

    const result = await provider.extractFields({
      docType: spec,
      pages: text.pages,
      fileName: doc.fileName,
      image: vision.image,
      pdf,
    })

    const primary = doc.client.addresses[0]
    const snapshot: ClientSnapshot = {
      firstName: doc.client.firstName,
      lastName: doc.client.lastName,
      email: doc.client.email,
      phone: doc.client.phone,
      address: primary ? `${primary.line1}, ${primary.city} ${primary.state}` : null,
    }
    const conflicts = computeConflictNotes(result.fields, snapshot)
    const missing = computeMissingFieldKeys(spec, result.fields)
    const noValues = !result.fields.some((field) => field.value?.trim())
    const nextStatus = noValues ? 'MISSING_INFORMATION' : documentStatusAfterExtraction(missing)
    const emptyError = 'The processor returned no supported fields. Review the document type and provider response, then retry; the original file and extraction evidence are preserved.'

    // The no-OCR warning is accurate only when nothing actually read the
    // image; once the vision model has, replace it with a verification nudge.
    const warnings = visionUsed
      ? text.warnings.filter((w) => !w.includes('OCR is not available'))
      : [...text.warnings]
    if (visionUsed) {
      warnings.push('Field values were read by the vision model — verify each value against the file.')
    }
    if (vision.reason && provider.name !== 'mock') warnings.push(vision.reason)
    warnings.push(...(result.warnings ?? []))
    if (noValues) warnings.push(emptyError)
    if (spec.key === 'other') {
      warnings.push('Document type could not be determined; generic metadata fields were requested for review.')
    }
    for (const [key, note] of Object.entries(conflicts)) {
      const label = spec.fields.find((f) => f.key === key)?.label ?? key
      warnings.push(`Possible conflict on ${label}: ${note}`)
    }

    await db.$transaction([
      db.extractedField.createMany({
        data: result.fields.map((f) => ({
          extractionId: extraction.id,
          key: f.key,
          label: f.label,
          value: f.value,
          confidence: f.confidence,
          sourcePage: f.sourcePage,
          sourceSnippet: f.sourceSnippet,
          conflictNote: conflicts[f.key] ?? null,
        })),
      }),
      db.documentExtraction.update({
        where: { id: extraction.id },
        data: {
          status: noValues ? 'FAILED' : 'COMPLETED',
          error: noValues ? emptyError : null,
          provider: result.provider,
          model: result.model,
          detectedTypeKey: spec.key,
          detectedTypeLabel: spec.label,
          typeConfidence: detection.confidence,
          pageCount: text.pageCount,
          rawText: joined.slice(0, MAX_RAW_TEXT) || null,
          summary: result.summary,
          warnings,
          missingFieldKeys: missing,
          promptTokens: result.promptTokens ?? null,
          completionTokens: result.completionTokens ?? null,
          completedAt: new Date(),
        },
      }),
      db.clientDocument.update({ where: { id: doc.id }, data: { status: nextStatus } }),
    ])

    return { extractionId: extraction.id, status: noValues ? 'FAILED' : 'COMPLETED', documentStatus: nextStatus, missingFieldKeys: missing, ...(noValues ? { error: emptyError } : {}) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Extraction failed.'
    const fallback: DocumentStatus = statusBefore === 'PROCESSING' ? 'RECEIVED' : statusBefore
    await db.$transaction([
      db.documentExtraction.update({
        where: { id: extraction.id },
        data: { status: 'FAILED', error: message.slice(0, 1000), completedAt: new Date() },
      }),
      db.clientDocument.update({ where: { id: doc.id }, data: { status: fallback } }),
    ])
    return {
      extractionId: extraction.id,
      status: 'FAILED',
      documentStatus: fallback,
      missingFieldKeys: [],
      error: message,
    }
  }
}

export { specForType }
