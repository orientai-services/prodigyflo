import { serveHandoffDocument } from '@/lib/sunoff-bridge/files'

/** SunOff's signed pull of one hand-off document (docs/CYS_BRIDGE.md §B3.2). No session: the signature + manifest are the gate. */
export async function GET(request: Request, ctx: RouteContext<'/api/bridge/sunoff/files/[handoffId]/[documentId]'>) {
  const { handoffId, documentId } = await ctx.params
  return serveHandoffDocument(request, handoffId, documentId)
}
