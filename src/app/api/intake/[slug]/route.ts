import { readRestorationPolicy, validAdmission } from '@/lib/intake/restoration-policy'
import { readCohort } from '@/lib/intake/cohort'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { SIGNATURE_HEADER, TOKEN_HEADER, verifySignature, verifyToken } from '@/lib/intake/hmac'
import { deriveExternalId } from '@/lib/intake/external-id'
import { processInbound } from '@/lib/intake/apply'
import { recordInboundEvent } from '@/lib/inbound/record'
import { defForIntakeKind } from '@/lib/connectors/catalog'
import { isSchema42Payload, scsLeadId } from '@/lib/intake/scs-packet'

const MAX_BODY_BYTES = 256 * 1024
// Persist receipt, case binding and document references before acknowledgment.
// Document bytes and AI are handled by background workers.
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
  const matches = candidates.filter((s) =>
    s.authMode === 'TOKEN'
      ? verifyToken(s.secretHash, tokenHeader)
      : verifySignature(s.secretHash, raw, sigHeader),
  )
  if (matches.length > 1) {
    return Response.json({ error: 'Ambiguous intake credential; reconcile receiver configuration.' }, { status: 409 })
  }
  const source = matches[0]
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
  // SCS republishes the same case as documents and extraction results arrive.
  // Its top-level `id` is a delivery-attempt key, not a case key; using it here
  // created a new intake submission (and a duplicate document import row) on
  // every refresh. Schema-42 packets carry the stable source case id instead.
  const stableScsLeadId = source.slug === 'scs-website' && isSchema42Payload(payload)
    ? scsLeadId(payload)
    : null
  if (source.slug === 'scs-website') {
    try {
      const p = readRestorationPolicy();
      if (p && (source.organizationId !== p.organizationId || source.id !== p.sourceId || !stableScsLeadId ||
          !validAdmission(p,(payload as Record<string, unknown>).restoration_admission,stableScsLeadId))) {
        return Response.json({error:'Restoration hold: case is not admitted.'},{status:409})
      }
      if (p && stableScsLeadId) {
        const prior = await db.intakeSubmission.findUnique({where:{sourceId_externalId:{sourceId:source.id,externalId:'scs:'+stableScsLeadId}},select:{rawPayload:true}})
        const admission = (prior?.rawPayload as Record<string,unknown> | undefined)?.restoration_admission
        if (admission && !validAdmission(p,admission,stableScsLeadId)) return Response.json({error:'Restoration hold: existing admission differs.'},{status:409})
      }
    } catch { return Response.json({error:'Restoration policy unavailable; source must retain work.'},{status:503}) }
  }
  delete (payload as Record<string, unknown>).stage0_synthetic
  let control: ReturnType<typeof readCohort>
  try { control=readCohort(process.env.SCS_IMPORT_EXECUTION_COHORT) } catch { /* expired execution never blocks durable receipt */ }
  if (control?.mode === 'synthetic' && control.organizationId === source.organizationId && control.sourceId === source.id && control.cases.some(x=>x.leadId===stableScsLeadId)) (payload as Record<string, unknown>).stage0_synthetic=true
  const externalId = stableScsLeadId ? `scs:${stableScsLeadId}` : deriveExternalId(payload, preferredKey)
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
  }, { status: submission.status === 'FAILED' ? 503 : submission.status === 'NEEDS_MAPPING' ? 422 : 200 })
}
