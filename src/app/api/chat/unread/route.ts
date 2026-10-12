import { getSessionUser } from '@/lib/rbac'
import { staffRouteAllowed } from '@/lib/staff-routes'
import { countUnreadMessages } from '@/lib/call-center/messages'
import { teamChatCounts } from '@/lib/chat-bridge/remote'

/**
 * GET /api/chat/unread: the Messages badge between server renders
 * (docs/TEAM_CHAT_PARITY.md A2). The shell polls it every 45 s while the tab
 * is visible and the Team chat isn't live on screen. `team` comes from the
 * chat Worker (signed, best-effort, 0 when unlinked or unreachable), `sms` is
 * the unread lead texts. Counts only, never a name or a message.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'cache-control': 'no-store' }

export async function GET() {
  const user = await getSessionUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: NO_STORE })
  if (!staffRouteAllowed(user.role, '/api/chat/unread')) return Response.json({ ok: false, error: 'forbidden' }, { status: 403, headers: NO_STORE })
  const [team, sms] = await Promise.all([
    teamChatCounts(user).catch(() => ({ total: 0, mentions: 0 })),
    countUnreadMessages(user).catch(() => 0),
  ])
  return Response.json({ ok: true, team: team.total, mentions: team.mentions, sms }, { headers: NO_STORE })
}
