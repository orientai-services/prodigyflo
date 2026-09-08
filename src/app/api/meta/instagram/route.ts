import { createHmac, timingSafeEqual } from 'node:crypto'
import { metaVerifyToken } from '@/lib/meta'
import { resolveSigningContext } from '@/lib/meta/webhook-context'
import { ingestInstagramEvent, parseInstagramEvents, type InstagramWebhookBody } from '@/lib/meta/instagram'

/**
 * Instagram engagement webhook — DMs, comments, and story replies → CRM leads.
 *
 * Same Meta app, app secret, and verify token as the Lead Ads webhook (see
 * src/lib/meta/webhook-context.ts for the shared, cached signing context); a
 * separate route because the payload shape and the ingestion (handle-keyed leads
 * with no email/phone) differ. See src/lib/meta/instagram.ts.
 *
 * GET  — subscription handshake (echo hub.challenge when the verify token matches).
 * POST — signed events, authenticated by X-Hub-Signature-256 with the org's App
 *        Secret (vault-first). Not fully configured → 503 (retryable); leads are
 *        created synchronously and are idempotent on the event id.
 */

export async function GET(req: Request) {
  const url = new URL(req.url)
  if (
    url.searchParams.get('hub.mode') === 'subscribe' &&
    url.searchParams.get('hub.verify_token') === metaVerifyToken()
  ) {
    return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 })
  }
  return new Response('Verification failed', { status: 403 })
}

function validSignature(raw: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith('sha256=') || !secret) return false
  const expected = createHmac('sha256', secret).update(raw).digest('hex')
  const got = header.slice(7)
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}

export async function POST(req: Request) {
  const raw = await req.text()
  const sig = req.headers.get('x-hub-signature-256')
  // Cheap reject before any DB/vault work.
  if (!sig?.startsWith('sha256=')) {
    return Response.json({ error: 'Invalid signature.' }, { status: 401 })
  }

  const ctx = await resolveSigningContext()
  if (!ctx) return Response.json({ error: 'No organization.' }, { status: 500 })
  if (!ctx.live) return Response.json({ error: 'Instagram not configured.' }, { status: 503 })
  if (!validSignature(raw, sig, ctx.secret)) {
    return Response.json({ error: 'Invalid signature.' }, { status: 401 })
  }

  let body: InstagramWebhookBody
  try {
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const events = parseInstagramEvents(body)
  const results: { eventId: string; kind: string; duplicate: boolean; created: boolean; clientId: string | null }[] = []
  let recoverableFailure = false

  for (const ev of events) {
    try {
      const r = await ingestInstagramEvent(ctx.orgId, ev)
      results.push({ eventId: ev.eventId, kind: ev.kind, ...r })
    } catch (err) {
      console.error('[ig] event ingest failed for', ev.eventId, err)
      results.push({ eventId: ev.eventId, kind: ev.kind, duplicate: false, created: false, clientId: null })
      recoverableFailure = true
    }
  }

  if (recoverableFailure) {
    return Response.json({ received: results.length, results, retry: true }, { status: 503 })
  }
  return Response.json({ received: results.length, results })
}
