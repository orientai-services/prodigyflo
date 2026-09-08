import type { NextRequest } from 'next/server'
import { z } from 'zod'
import {
  INBOUND_SIGNATURE_HEADER,
  processInboundMessage,
  verifyInboundSignature,
} from '@/lib/messaging/inbound'

const MAX_BODY_BYTES = 256 * 1024

const payloadSchema = z.object({
  from: z.string().min(1).max(320),
  to: z.string().max(320).nullish(),
  subject: z.string().max(500).nullish(),
  body: z.string().min(1).max(50_000),
  external_id: z.string().min(1).max(200),
})

/**
 * Public inbound-message webhook. No session — authentication is the
 * HMAC-SHA256 signature over the raw body, keyed with JOBS_TOKEN:
 * `X-Inbound-Signature: sha256=<hex(HMAC_SHA256(JOBS_TOKEN, rawBody))>`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ channel: string }> }) {
  const { channel: channelParam } = await params
  const channel = channelParam.toLowerCase() === 'email' ? 'EMAIL' : channelParam.toLowerCase() === 'sms' ? 'SMS' : null
  if (!channel) {
    return Response.json({ error: 'Unknown channel — use /api/inbound/email or /api/inbound/sms.' }, { status: 404 })
  }

  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return Response.json({ error: 'Payload too large.' }, { status: 413 })
  }

  if (!verifyInboundSignature(raw, request.headers.get(INBOUND_SIGNATURE_HEADER))) {
    return Response.json({ error: 'Invalid signature.' }, { status: 401 })
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'Body must be valid JSON.' }, { status: 400 })
  }
  const parsed = payloadSchema.safeParse(json)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return Response.json(
      { error: `Invalid payload: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown error'}` },
      { status: 400 },
    )
  }

  const result = await processInboundMessage(channel, parsed.data)
  if (!result.matched) {
    return Response.json({ matched: false, duplicate: result.duplicate })
  }
  return Response.json({
    matched: true,
    duplicate: result.duplicate,
    communicationId: result.communicationId,
    ...(result.optOut ? { optOut: true } : {}),
  })
}
