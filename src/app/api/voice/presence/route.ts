import { can, getSessionUser } from '@/lib/rbac'
import { appOrigin } from '@/lib/telephony'
import { touchPresence } from '@/lib/telephony/presence'
import { voiceBrowserEnabled } from '@/lib/telephony/voice-config'

/**
 * Browser heartbeat (P0b): "this tab can take a call right now". A plain POST,
 * not a server action — server actions queue one at a time per client and the
 * page's pagehide would abort them, while navigator.sendBeacon (text/plain)
 * still delivers the final 'offline'. Session-checked, and the Origin must be
 * this app's own. 404 while browser calling is switched off.
 */
export async function POST(request: Request) {
  if (!voiceBrowserEnabled()) return new Response(null, { status: 404 })
  const user = await getSessionUser()
  if (!user) return new Response(null, { status: 401 })
  if (!can(user, 'communications:send')) return new Response(null, { status: 403 })

  let origin = ''
  try {
    origin = new URL(appOrigin()).origin
  } catch {
    origin = ''
  }
  if (!origin || request.headers.get('origin') !== origin) return new Response(null, { status: 403 })

  let state: unknown = null
  try {
    const raw = await request.text()
    state = (JSON.parse(raw) as { state?: unknown }).state
  } catch {
    return new Response(null, { status: 400 })
  }
  if (state !== 'ready' && state !== 'offline') return new Response(null, { status: 400 })

  await touchPresence(user, user.organizationId, state)
  return new Response(null, { status: 204 })
}
