import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/rbac'
import { homeFor } from '@/lib/permissions'
import { installedAppLanding } from '@/lib/staff-routes'

/**
 * `/app`: the installed app's start_url (src/app/manifest/[slug]/route.ts).
 *
 * A redirect from a route handler is a bare 307 with no HTML, so launching
 * from the home screen paints the startup image and then the Call Center:
 * there is no page in between to flash. Signed out, src/proxy.ts has already
 * sent the request to /login?next=/app, and signing in comes back here.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const user = await getSessionUser()
  const target = user ? installedAppLanding(user.role, homeFor(user)) : '/login?next=%2Fapp'
  const response = NextResponse.redirect(new URL(target, request.url), 307)
  response.headers.set('cache-control', 'no-store')
  return response
}
