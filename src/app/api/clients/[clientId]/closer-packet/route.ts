import type { NextRequest } from 'next/server'
import { getSessionUser, findClientInScope } from '@/lib/rbac'
import { assemblePacket } from '@/lib/packet/data'
import { callPacket, type CallAudience } from '@/lib/packet/call-pdf-model'
import { renderCallPacket } from '@/lib/packet/call-pdf-render'
import { closerPacketKey } from '@/lib/packet/stored-packet'
import { getFileStorage } from '@/lib/storage'

export async function GET(req: NextRequest, ctx: RouteContext<'/api/clients/[clientId]/closer-packet'>) {
  const { clientId } = await ctx.params
  const kind = req.nextUrl.searchParams.get('kind')
  if (kind !== 'review' && kind !== 'pitch') return new Response('Unknown packet', { status: 400 })

  const user = await getSessionUser()
  if (!user) return new Response('Unauthorized', { status: 401 })
  if (user.portalClientId) return new Response('Forbidden', { status: 403 })
  const client = await findClientInScope(user, clientId)
  if (!client) return new Response('Not found', { status: 404 })

  const stored = await readStoredPacket(clientId, kind)
  if (stored) {
    const filename = kind === 'review' ? `${client.lastName}-case-review.pdf` : `${client.lastName}-closer-pitch.pdf`
    return pdfResponse(Buffer.from(stored), filename)
  }

  const built = await assemblePacket(clientId, { persist: false })
  if (!built?.closerInput) return new Response('No file', { status: 404 })

  const model = callPacket(built.closerInput, kind as CallAudience)
  const bytes = await renderCallPacket(model)
  return pdfResponse(Buffer.from(bytes), model.filename)
}

async function readStoredPacket(clientId: string, kind: 'review' | 'pitch'): Promise<Buffer | null> {
  let key: string
  try {
    key = closerPacketKey(clientId, kind)
  } catch {
    return null
  }
  const storage = getFileStorage()
  const stat = await storage.stat(key)
  if (!stat) return null
  return storage.get(key)
}

function pdfResponse(bytes: Buffer, filename: string) {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '')
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safe}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
