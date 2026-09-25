import type { NextRequest } from 'next/server'
import { getSessionUser, findClientInScope } from '@/lib/rbac'
import { assemblePacket } from '@/lib/packet/data'
import { callPacket, type CallAudience } from '@/lib/packet/call-pdf-model'
import { renderCallPacket } from '@/lib/packet/call-pdf-render'

export async function GET(req: NextRequest, ctx: RouteContext<'/api/clients/[clientId]/closer-packet'>) {
  const { clientId } = await ctx.params
  const kind = req.nextUrl.searchParams.get('kind')
  if (kind !== 'review' && kind !== 'pitch') return new Response('Unknown packet', { status: 400 })

  const user = await getSessionUser()
  if (!user) return new Response('Unauthorized', { status: 401 })
  if (user.portalClientId) return new Response('Forbidden', { status: 403 })
  const client = await findClientInScope(user, clientId)
  if (!client) return new Response('Not found', { status: 404 })

  const built = await assemblePacket(clientId, { persist: false })
  if (!built?.closerInput) return new Response('No file', { status: 404 })

  const model = callPacket(built.closerInput, kind as CallAudience)
  const bytes = await renderCallPacket(model)
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${model.filename}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
