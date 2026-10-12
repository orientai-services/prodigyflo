import { chatKey } from '@/lib/chat-bridge/config'
import { verifyChatRequest } from '@/lib/chat-bridge/sign'
import { parseCaseSms, sendCaseSms } from '@/lib/chat-bridge/sms'

/**
 * POST /api/bridge/chat/case-sms: a text to a ProdigyFlo lead from the team
 * chat's Client-SMS mode (docs/CYS_BRIDGE.md §B4). Signed by the chat Worker;
 * ProdigyFlo runs its own consent / DNC / quiet-hours / provider checks and
 * sends from its own numbers.
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
  const input = parseCaseSms(parsed)
  if (!input) return Response.json({ ok: false, error: 'bad_request', message: 'The request is invalid.' }, { status: 400 })
  const out = await sendCaseSms(input)
  return Response.json(out.body, { status: out.status })
}
