import 'server-only'
import { db } from '@/lib/db'
import { getFileStorage } from '@/lib/storage'
import { assemblePacket } from '@/lib/packet/data'
import { callPacket, type CallAudience } from '@/lib/packet/call-pdf-model'
import { renderCallPacket } from '@/lib/packet/call-pdf-render'
import { bridgeKey } from './client'
import type { ManifestEntry } from './payload'
import { BRIDGE_IDEMPOTENCY_HEADER, BRIDGE_SIG_HEADER, BRIDGE_TS_HEADER, verifyBridgeRequest } from './sign'
import { bridgeAudit } from './status'

/**
 * Inbound side of the SunOff bridge: signature checks and the signed-GET file
 * pulls (docs/CYS_BRIDGE.md §B3.2). No session is involved; the signature,
 * the hand-off row and its manifest are the whole authorization. A file is
 * served only when it is listed in the manifest of a hand-off SunOff
 * accepted, and only from that hand-off's Client.
 */

export function bridgeJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

const REFUSALS: Record<string, [number, string]> = {
  not_configured: [503, 'The bridge is not configured.'],
  missing: [401, 'Signed request required.'],
  skew: [401, 'Request timestamp outside the allowed window.'],
  bad_signature: [401, 'Bad signature.'],
}

/** Null when the request is signed correctly, else the refusal to return. */
export function checkSignedRequest(request: Request, body: string): Response | null {
  const path = new URL(request.url).pathname
  const verdict = verifyBridgeRequest({
    key: bridgeKey(),
    method: request.method,
    path,
    body,
    ts: request.headers.get(BRIDGE_TS_HEADER),
    sig: request.headers.get(BRIDGE_SIG_HEADER),
  })
  if (verdict.ok) return null
  const [status, message] = REFUSALS[verdict.reason]
  // The SunOff side alerts on repeated failures; here a bad signature is only logged (never the headers).
  if (verdict.reason !== 'not_configured') console.warn(`[sunoff-bridge] refused ${request.method} ${path}: ${verdict.reason}`)
  return bridgeJson(status, { ok: false, error: verdict.reason, message })
}

export function idempotencyKeyOf(request: Request): string {
  return (request.headers.get(BRIDGE_IDEMPOTENCY_HEADER) ?? '').trim()
}

const SERVABLE = new Set(['STANDBY', 'STARTED', 'SUBMITTED'])

async function servableHandoff(handoffId: string, entry: ManifestEntry) {
  const row = await db.sunoffHandoff.findUnique({ where: { id: handoffId } })
  if (!row || !SERVABLE.has(row.status)) return null
  const manifest = Array.isArray(row.manifest) ? (row.manifest as ManifestEntry[]) : []
  if (!manifest.some((m) => m && m.id === entry.id && m.kind === entry.kind)) return 'unlisted' as const
  return row
}

const notFound = () => bridgeJson(404, { ok: false, error: 'not_found', message: 'Not found.' })
const unlisted = () => bridgeJson(403, { ok: false, error: 'not_in_manifest', message: 'This file is not part of the hand-off.' })

function safeName(name: string): string {
  return name.replace(/[^\w.() -]/g, '_').slice(0, 120) || 'document'
}

/** GET /api/bridge/sunoff/files/[handoffId]/[documentId] */
export async function serveHandoffDocument(request: Request, handoffId: string, documentId: string): Promise<Response> {
  const refused = checkSignedRequest(request, '')
  if (refused) return refused
  const row = await servableHandoff(handoffId, { id: documentId, kind: 'document' })
  if (!row) return notFound()
  if (row === 'unlisted') return unlisted()
  const doc = await db.clientDocument.findFirst({
    where: { id: documentId, clientId: row.clientId, client: { organizationId: row.organizationId }, storageKey: { not: null } },
    select: { id: true, storageKey: true, mimeType: true, fileName: true, checksum: true },
  })
  if (!doc?.storageKey) return notFound()
  const buf = await getFileStorage().get(doc.storageKey).catch(() => null)
  if (!buf) return bridgeJson(404, { ok: false, error: 'file_missing', message: 'The file is missing from storage.' })
  await bridgeAudit(db, row.organizationId, {
    action: 'sunoff.file_served',
    entityId: row.id,
    summary: `Document served to SunOff (${buf.length} bytes)`,
    after: { documentId: doc.id, bytes: buf.length },
  })
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'Content-Length': String(buf.length),
      'Content-Disposition': `attachment; filename="${safeName(doc.fileName ?? 'document')}"`,
      ...(doc.checksum ? { 'X-PF-Sha256': doc.checksum } : {}),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}

/** GET /api/bridge/sunoff/files/[handoffId]/packet-review | packet-pitch: rendered like /api/clients/{id}/closer-packet. */
export async function serveHandoffPacket(request: Request, handoffId: string, kind: 'packet-review' | 'packet-pitch'): Promise<Response> {
  const refused = checkSignedRequest(request, '')
  if (refused) return refused
  const row = await servableHandoff(handoffId, { id: kind, kind })
  if (!row) return notFound()
  if (row === 'unlisted') return unlisted()
  const client = await db.client.findFirst({ where: { id: row.clientId, organizationId: row.organizationId, deletedAt: null }, select: { id: true } })
  if (!client) return notFound()
  const built = await assemblePacket(client.id, { persist: false })
  if (!built?.closerInput) return notFound()
  const audience: CallAudience = kind === 'packet-review' ? 'review' : 'pitch'
  const model = callPacket(built.closerInput, audience)
  const bytes = Buffer.from(await renderCallPacket(model))
  await bridgeAudit(db, row.organizationId, {
    action: 'sunoff.file_served',
    entityId: row.id,
    summary: `${kind} served to SunOff (${bytes.length} bytes)`,
    after: { documentId: kind, bytes: bytes.length },
  })
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="${safeName(model.filename)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}
