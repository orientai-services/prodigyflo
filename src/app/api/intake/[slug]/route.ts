import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { SIGNATURE_HEADER, TOKEN_HEADER, verifySignature, verifyToken } from '@/lib/intake/hmac'
import { deriveExternalId } from '@/lib/intake/external-id'
import { processInbound } from '@/lib/intake/apply'
import { recordInboundEvent } from '@/lib/inbound/record'
import { defForIntakeKind } from '@/lib/connectors/catalog'

const MAX_BODY_BYTES = 256 * 1024
// A packet may carry several document references. The handler copies each one
// into ProdigyFlo's private storage before acknowledging SCS.
export const maxDuration = 300

/**
 * Public webhook receiver. No session — authentication is the HMAC signature.
 * Slugs are unique per organization but not globally, so every enabled source
 * with this slug is a candidate and the one whose secret verifies the
 * signature wins; a signature therefore also disambiguates the tenant.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return Response.json({ error: 'Payload too large.' }, { status: 413 })
  }

  const candidates = await db.intakeSource.findMany({ where: { slug, isEnabled: true } })
  if (candidates.length === 0) {
    return Response.json({ error: 'Unknown intake source.' }, { status: 404 })
  }

  // Each source authenticates in its configured mode: HMAC senders sign the
  // body (X-Intake-Signature); TOKEN senders (GoHighLevel and other webhooks
  // that can only attach a static header) present X-Connector-Token. The
  // credential that verifies also disambiguates the tenant behind the slug.
  const sigHeader = request.headers.get(SIGNATURE_HEADER)
  const tokenHeader = request.headers.get(TOKEN_HEADER)
  const source = candidates.find((s) =>
    s.authMode === 'TOKEN'
      ? verifyToken(s.secretHash, tokenHeader)
      : verifySignature(s.secretHash, raw, sigHeader),
  )
  if (!source) {
    // Log the rejection where staff can see it (against the first candidate's
    // org — with a bad credential the true tenant is unknowable by design).
    const presented = sigHeader ? 'signature mismatch' : tokenHeader ? 'token mismatch' : 'missing auth header'
    await db.auditEvent.create({
      data: {
        organizationId: candidates[0].organizationId,
        actorLabel: 'Intake webhook',
        action: 'intake.webhook_rejected',
        entityType: 'IntakeSource',
        entityId: candidates[0].id,
        summary: `Webhook for "${slug}" rejected: ${presented}`,
      },
    })
    return Response.json({ error: 'Invalid credentials.' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'Body must be valid JSON.' }, { status: 400 })
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return Response.json({ error: 'Body must be a JSON object.' }, { status: 400 })
  }

  const preferredKey = defForIntakeKind(source.kind, source.connectorDefId)?.externalIdKey ?? null
  const externalId = deriveExternalId(payload, preferredKey)
  const { duplicate, submission } = await processInbound(source, externalId, payload)

  // Non-destructive recording layer: file this delivery as an InboundEvent (and
  // upsert its document, if any) for the Inbound workspace. Its internal
  // try/catch guarantees it can never break the response computed below.
  await recordInboundEvent({ source, submission, payload, externalId })

  if (duplicate) {
    return Response.json({ duplicate: true, clientId: submission.clientId, status: submission.status })
  }
  return Response.json({
    duplicate: false,
    status: submission.status,
    clientId: submission.clientId,
    submissionId: submission.id,
    ...(submission.error ? { error: submission.error } : {}),
  })
}
