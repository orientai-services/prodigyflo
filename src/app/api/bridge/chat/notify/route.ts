import { chatKey } from '@/lib/chat-bridge/config'
import { parseChatNotice, sendChatNotice } from '@/lib/chat-bridge/notify'
import { verifyChatRequest } from '@/lib/chat-bridge/sign'

/**
 * POST /api/bridge/chat/notify: the team chat's fallback notice for a
 * ProdigyFlo-only person (docs/TEAM_CHAT_PARITY.md F4). Signed by the chat
 * Worker with PF_CHAT_KEY (no session; src/proxy.ts lets /api/bridge/chat/
 * through); ProdigyFlo re-checks the link and emails at most one summary per
 * person per 3 hours. Answers {ok:true, sent}.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const raw = await request.text()
  if (raw.length > 8 * 1024) return Response.json({ ok: false, error: 'too_large' }, { status: 413 })
  const v = verifyChatRequest(chatKey(), { method: 'POST', url: request.url, headers: request.headers, body: raw })
  if (v !== 'ok') return Response.json({ ok: false, error: v === 'not_configured' ? 'not_configured' : 'unauthorized' }, { status: v === 'not_configured' ? 503 : 401 })
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  const input = parseChatNotice(parsed)
  if (!input) return Response.json({ ok: false, error: 'bad_request', message: 'The request is invalid.' }, { status: 400 })
  const out = await sendChatNotice(input, request.headers.get('x-pf-chat-sig') ?? '')
  return Response.json(out.body, { status: out.status, headers: { 'cache-control': 'no-store' } })
}
