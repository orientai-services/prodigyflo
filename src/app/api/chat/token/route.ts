import { getSessionUser } from '@/lib/rbac'
import { staffRouteAllowed } from '@/lib/staff-routes'
import { recordAudit } from '@/lib/audit'
import { chatBase, chatKey } from '@/lib/chat-bridge/config'
import { CHAT_TOKEN_TTL_SECONDS, mintChatToken } from '@/lib/chat-bridge/jwt'
import { linkedSunoffId } from '@/lib/chat-bridge/link'
import { db } from '@/lib/db'
import { profileName } from '@/lib/people/profile-name'

/**
 * GET /api/chat/token: the signed-in user's chat SSO token (docs/CYS_BRIDGE.md
 * §B4). The Team chat screen trades it at the chat Worker for a bearer
 * session. Unlinked users get `not_linked` and see the "Link your SunOff
 * account" card instead.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'cache-control': 'no-store' }

export async function GET(request: Request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: NO_STORE })
  if (!staffRouteAllowed(user.role, '/api/chat/token')) return Response.json({ ok: false, error: 'forbidden' }, { status: 403, headers: NO_STORE })
  const key = chatKey()
  if (!key) return Response.json({ ok: false, error: 'not_configured' }, { status: 503, headers: NO_STORE })
  const sunoffUserId = await linkedSunoffId(user)
  if (!sunoffUserId) return Response.json({ ok: false, error: 'not_linked' }, { status: 200, headers: NO_STORE })
  const lang = new URL(request.url).searchParams.get('lang') === 'es' ? 'es' : 'en'
  const now = Date.now()
  const nickname = (await db.user.findUnique({ where: { id: user.id }, select: { nickname: true } }))?.nickname
  const name = profileName({ name: user.name, nickname, email: user.email }) ?? 'ProdigyFlo'
  const token = mintChatToken(key, { sunoffUserId, pfUserId: user.id, name, lang }, now)
  await recordAudit(user, {
    action: 'chat.token_issued',
    entityType: 'User',
    entityId: user.id,
    summary: 'Opened the team chat',
    after: { sunoffUser: `u${sunoffUserId}`, ttlSeconds: CHAT_TOKEN_TTL_SECONDS },
  }).catch(() => undefined)
  return Response.json(
    { ok: true, token, base: chatBase(), uid: `u${sunoffUserId}`, expiresAt: now + CHAT_TOKEN_TTL_SECONDS * 1000 },
    { headers: NO_STORE },
  )
}
