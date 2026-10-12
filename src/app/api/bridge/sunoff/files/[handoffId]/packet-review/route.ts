import { serveHandoffPacket } from '@/lib/sunoff-bridge/files'

/** SunOff's signed pull of the closer review PDF (rep-only in SunOff, never sent to CYS). */
export async function GET(request: Request, ctx: RouteContext<'/api/bridge/sunoff/files/[handoffId]/packet-review'>) {
  const { handoffId } = await ctx.params
  return serveHandoffPacket(request, handoffId, 'packet-review')
}
