import { chatKey } from '@/lib/chat-bridge/config'
import { buildCaseFeed } from '@/lib/chat-bridge/cases'
import { verifyChatRequest } from '@/lib/chat-bridge/sign'

/**
 * GET /api/bridge/chat/cases?since=<cursor>: the PF case feed the chat Worker
 * pulls (docs/CYS_BRIDGE.md §B4). No session: the PF_CHAT_KEY signature is the
 * authentication. Last four digits only, never a full number.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const v = verifyChatRequest(chatKey(), { method: 'GET', url: request.url, headers: request.headers, body: '' })
  if (v !== 'ok') return Response.json({ ok: false, error: v === 'not_configured' ? 'not_configured' : 'unauthorized' }, { status: v === 'not_configured' ? 503 : 401 })
  const since = new URL(request.url).searchParams.get('since')
  return Response.json(await buildCaseFeed(since), { headers: { 'cache-control': 'no-store' } })
}
